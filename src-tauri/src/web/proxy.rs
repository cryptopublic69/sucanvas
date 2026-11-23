use super::WebState;
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Once};
use tokio::sync::Notify;

use super::ws_handover::{log, RelayTicket};

static RUSTLS_PROVIDER_INIT: Once = Once::new();

/// Ensures `rustls` has a process-wide crypto provider before any `wss://` upstream handshake.
pub(super) fn ensure_rustls_provider() {
    RUSTLS_PROVIDER_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn upstream(state: &WebState, colab: bool, suffix: &str) -> Result<String, StatusCode> {
    let base = if colab {
        &state.config.colab_comfy_url
    } else {
        &state.config.comfy_url
    };
    if base.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    Ok(format!("{}{}", base.trim_end_matches('/'), suffix))
}

fn resolve_local_view_path(
    data_dir: &std::path::Path,
    input_dir: &str,
    output_dir: &str,
    query: &reqwest::Url,
    suffix: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    if query
        .query_pairs()
        .any(|(key, value)| matches!(key.as_ref(), "preview" | "channel") && !value.is_empty())
    {
        return Ok(None);
    }
    let direct_key = format!("/api/comfy{suffix}");
    let mut mapped = super::posters::migration_replacement(data_dir, &direct_key)?;
    if mapped.is_none()
        && query
            .query_pairs()
            .any(|(key, _)| key == "infinite_canvas_prompt")
    {
        let mut normalized = query.clone();
        normalized.query_pairs_mut().clear().extend_pairs(
            query.query_pairs().filter(|(key, _)| {
                !matches!(
                    key.as_ref(),
                    "download" | "downloadName" | "infinite_canvas_prompt"
                )
            }),
        );
        if let Some(clean_query) = normalized.query().filter(|value| !value.is_empty()) {
            let clean_key = format!("/api/comfy/view?{clean_query}");
            mapped = super::posters::migration_replacement(data_dir, &clean_key)?;
        }
    }
    if let Some(replacement) = mapped {
        if replacement.starts_with("/api/comfy/view?") {
            if let Ok(mapped_url) = reqwest::Url::parse(&format!("http://localhost{replacement}")) {
                return super::posters::resolve_view_query_path(
                    &mapped_url,
                    input_dir,
                    output_dir,
                );
            }
        }
    }
    super::posters::resolve_view_query_path(query, input_dir, output_dir)
}

async fn serve_local_view(
    path: &std::path::Path,
    request: Request<Body>,
    download: bool,
    filename: &str,
) -> Response {
    let mut response = super::files::serve(path, request).await;
    if download && response.status().is_success() {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            super::files::download_disposition(std::path::Path::new(filename)),
        );
    }
    response
}

async fn http_for(
    state: WebState,
    request: Request<Body>,
    prefix: &str,
    colab: bool,
) -> Response {
    let state = state.connection_snapshot();
    let tail = request.uri().path().strip_prefix(prefix).unwrap_or("");
    // Only read endpoints used by the canvas are available through the proxy.
    if request.method() != "GET"
        || !matches!(
            tail,
            "/view" | "/queue" | "/history" | "/object_info" | "/system_stats"
        ) && !tail.starts_with("/history/")
            && !tail.starts_with("/object_info/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let query = reqwest::Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
    let download = tail == "/view"
        && query
            .query_pairs()
            .any(|(key, value)| key == "download" && value == "true");
    let filename = query
        .query_pairs()
        .find(|(key, value)| key == "downloadName" && !value.trim().is_empty())
        .or_else(|| query.query_pairs().find(|(key, _)| key == "filename"))
        .map(|(_, value)| {
            value
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("download")
                .to_owned()
        })
        .unwrap_or_else(|| "download".into());
    let mut upstream_query = query.clone();
    upstream_query.query_pairs_mut().clear().extend_pairs(
        query
            .query_pairs()
            .filter(|(key, _)| key != "downloadName" && key != "download"),
    );
    let suffix = format!(
        "{tail}{}",
        upstream_query
            .query()
            .filter(|query| !query.is_empty())
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    if !colab && tail == "/view" {
        let data_dir = state.core.data_dir.clone();
        let input_dir = state.config.comfy_input_directory.clone();
        let output_dir = state.config.comfy_output_directory.clone();
        let query_for_local = query.clone();
        let suffix_for_local = suffix.clone();
        match tokio::task::spawn_blocking(move || {
            resolve_local_view_path(
                &data_dir,
                &input_dir,
                &output_dir,
                &query_for_local,
                &suffix_for_local,
            )
        })
        .await
        {
            Ok(Ok(Some(path))) => {
                return serve_local_view(&path, request, download, &filename).await;
            }
            Ok(Err(_)) => return StatusCode::BAD_REQUEST.into_response(),
            Ok(Ok(None)) | Err(_) => {}
        }
    }
    let url = match upstream(&state, colab, &suffix) {
        Ok(url) => url,
        Err(status) => return status.into_response(),
    };
    let mut builder = state.client.get(url);
    for name in [
        header::RANGE,
        header::IF_RANGE,
        header::IF_NONE_MATCH,
        header::IF_MODIFIED_SINCE,
    ] {
        if let Some(value) = request.headers().get(&name) {
            builder = builder.header(name, value);
        }
    }
    match builder.send().await {
        Ok(result) => {
            let status = result.status();
            let headers = result.headers().clone();
            let mut response = Response::new(Body::from_stream(result.bytes_stream()));
            *response.status_mut() = status;
            for name in [
                header::CONTENT_TYPE,
                header::CONTENT_LENGTH,
                header::CONTENT_RANGE,
                header::ACCEPT_RANGES,
                header::ETAG,
                header::LAST_MODIFIED,
            ] {
                if let Some(value) = headers.get(&name) {
                    response.headers_mut().insert(name, value.clone());
                }
            }
            if download && status.is_success() {
                response.headers_mut().insert(
                    header::CONTENT_DISPOSITION,
                    super::files::download_disposition(std::path::Path::new(&filename)),
                );
            }
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                "private, max-age=60".parse().unwrap(),
            );
            response
        }
        Err(_) => (StatusCode::BAD_GATEWAY, "无法连接服务器配置的 ComfyUI").into_response(),
    }
}

pub async fn http(State(state): State<WebState>, request: Request<Body>) -> Response {
    http_for(state, request, "/api/comfy", false).await
}

#[cfg(feature = "colab-channel")]
pub(crate) async fn http_colab(State(state): State<WebState>, request: Request<Body>) -> Response {
    http_for(state, request, "/api/comfy-colab", true).await
}
const UPSTREAM_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);
const UPSTREAM_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(35);
const HEARTBEAT_MESSAGE: &str = r#"{"type":"sucanvas.websocket.heartbeat"}"#;
type ComfyWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_comfy(
    url: &str,
    deadline: std::time::Duration,
    client_id: &str,
) -> Result<ComfyWebSocket, StatusCode> {
    ensure_rustls_provider();
    match tokio::time::timeout(deadline, tokio_tungstenite::connect_async(url)).await {
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(error)) => {
            log(client_id, format!("upstream handshake failed: {error}"));
            Err(StatusCode::BAD_GATEWAY)
        }
        Err(_) => {
            log(client_id, "upstream handshake timed out");
            Err(StatusCode::GATEWAY_TIMEOUT)
        }
    }
}

fn client_id(uri: &axum::http::Uri) -> String {
    uri.query()
        .and_then(|query| reqwest::Url::parse(&format!("http://localhost/?{query}")).ok())
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "clientId")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_default()
}

/// Closes the upstream socket and reads it until TCP EOF. aiohttp only closes the
/// transport via `call_soon` after the handler's `finally` has already run, so EOF
/// proves that ComfyUI has released the clientId.
async fn close_upstream(comfy: &mut ComfyWebSocket) -> bool {
    tokio::time::timeout(IO_TIMEOUT, async {
        let _ = comfy.close(None).await;
        while let Some(Ok(_)) = comfy.next().await {}
    })
    .await
    .is_ok()
}

/// An accepted upstream whose browser upgrade has not started yet. If the upgrade
/// never runs, the upstream is still retired in order before the ticket is released.
struct PendingRelay {
    client_id: String,
    comfy: Option<ComfyWebSocket>,
    ticket: Option<RelayTicket>,
}

impl Drop for PendingRelay {
    fn drop(&mut self) {
        let (Some(mut comfy), Ok(runtime)) =
            (self.comfy.take(), tokio::runtime::Handle::try_current())
        else {
            return;
        };
        let ticket = self.ticket.take();
        let client_id = std::mem::take(&mut self.client_id);
        runtime.spawn(async move {
            if !close_upstream(&mut comfy).await {
                log(
                    &client_id,
                    "upstream did not reach EOF after an abandoned upgrade",
                );
            }
            drop(ticket);
        });
    }
}

async fn websocket_for(
    state: WebState,
    request: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
    uri: axum::http::Uri,
    colab: bool,
) -> Response {
    let state = state.connection_snapshot();
    let url = match upstream(
        &state,
        colab,
        &format!(
            "/ws{}",
            uri.query().map(|q| format!("?{q}")).unwrap_or_default()
        ),
    ) {
        Ok(url) => url.replacen("http", "ws", 1),
        Err(status) => return status.into_response(),
    };
    let client_id = client_id(&uri);
    let relay_key = if colab && !client_id.is_empty() {
        format!("colab:{client_id}")
    } else {
        client_id.clone()
    };
    // Only an authenticated request may retire the relay that owns a clientId.
    if !state.auth.authenticated(&request) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Do not report an open browser socket until ComfyUI has accepted it.
    let connected = if relay_key.is_empty() {
        connect_comfy(&url, UPSTREAM_CONNECT_TIMEOUT, &client_id)
            .await
            .map(|comfy| (comfy, None))
    } else {
        state
            .comfy_relays
            .handover(&relay_key, || {
                connect_comfy(&url, UPSTREAM_CONNECT_TIMEOUT, &client_id)
            })
            .await
            .map(|(comfy, ticket)| (comfy, Some(ticket)))
    };
    let (comfy, ticket) = match connected {
        Ok(connected) => connected,
        Err(status) => return status.into_response(),
    };
    let mut pending = PendingRelay {
        client_id,
        comfy: Some(comfy),
        ticket,
    };
    if !state.auth.authenticated(&request) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| async move {
        let client_id = std::mem::take(&mut pending.client_id);
        let ticket = pending.ticket.take();
        let Some(comfy) = pending.comfy.take() else {
            return;
        };
        relay(state, request, socket, comfy, client_id, ticket).await
    })
}

pub async fn websocket(
    State(state): State<WebState>,
    request: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
    uri: axum::http::Uri,
) -> Response {
    websocket_for(state, request, ws, uri, false).await
}

#[cfg(feature = "colab-channel")]
pub(crate) async fn websocket_colab(
    State(state): State<WebState>,
    request: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
    uri: axum::http::Uri,
) -> Response {
    websocket_for(state, request, ws, uri, true).await
}

async fn send_browser(browser: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(IO_TIMEOUT, browser.send(message)).await,
        Ok(Ok(()))
    )
}

async fn send_comfy(
    comfy: &mut ComfyWebSocket,
    message: tokio_tungstenite::tungstenite::Message,
) -> bool {
    matches!(
        tokio::time::timeout(IO_TIMEOUT, comfy.send(message)).await,
        Ok(Ok(()))
    )
}

async fn superseded(stop: &Option<Arc<Notify>>) {
    match stop {
        Some(stop) => stop.notified().await,
        None => std::future::pending().await,
    }
}

async fn relay(
    state: WebState,
    headers: axum::http::HeaderMap,
    mut browser: WebSocket,
    mut comfy: ComfyWebSocket,
    client_id: String,
    ticket: Option<RelayTicket>,
) {
    use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
    let stop = ticket.as_ref().map(RelayTicket::stop_signal);
    let generation = ticket.as_ref().map_or(0, RelayTicket::generation);
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut upstream_seen = tokio::time::Instant::now();
    let reason = loop {
        if !state.auth.authenticated(&headers) {
            break "session expired";
        }
        tokio::select! {
            _ = superseded(&stop) => break "superseded",
            _ = heartbeat.tick() => {
                if upstream_seen.elapsed() >= UPSTREAM_STALE_AFTER {
                    break "upstream heartbeat timeout";
                }
                if !send_comfy(&mut comfy, UpstreamMessage::Ping(Vec::new().into())).await {
                    break "upstream heartbeat send failed or timed out";
                }
                // A JS-visible heartbeat detects a silently dead browser connection.
                if !send_browser(&mut browser, Message::Text(HEARTBEAT_MESSAGE.into())).await {
                    break "browser heartbeat send failed or timed out";
                }
            },
            message = browser.recv() => {
                if !state.auth.authenticated(&headers) { break "session expired"; }
                let message = match message {
                    Some(Ok(Message::Text(value))) => UpstreamMessage::Text(value.to_string().into()),
                    Some(Ok(Message::Binary(value))) => UpstreamMessage::Binary(value),
                    // Each WebSocket transport handles its own ping/pong frames.
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    Some(Err(error)) => {
                        log(&client_id, format!("browser read failed: {error}"));
                        break "browser read failed";
                    }
                    _ => break "browser closed",
                };
                if !send_comfy(&mut comfy, message).await { break "upstream send failed or timed out"; }
            },
            message = comfy.next() => {
                if !state.auth.authenticated(&headers) { break "session expired"; }
                let message = match message {
                    Some(Ok(UpstreamMessage::Text(value))) => Message::Text(value.to_string().into()),
                    Some(Ok(UpstreamMessage::Binary(value))) => Message::Binary(value),
                    Some(Ok(UpstreamMessage::Ping(_) | UpstreamMessage::Pong(_))) => {
                        upstream_seen = tokio::time::Instant::now();
                        continue;
                    }
                    Some(Err(error)) => {
                        log(&client_id, format!("upstream read failed: {error}"));
                        break "upstream read failed";
                    }
                    _ => break "upstream closed",
                };
                upstream_seen = tokio::time::Instant::now();
                if !send_browser(&mut browser, message).await { break "browser send failed or timed out"; }
            }
        }
    };
    if reason != "browser closed" {
        log(&client_id, format!("relay #{generation} stopped: {reason}"));
    }
    // Retire the upstream first. A browser that vanished silently can block for the
    // full send timeout plus the close timeout below; doing that before releasing the
    // clientId would push a waiting handover past RETIRE_TIMEOUT and reopen the race.
    if !close_upstream(&mut comfy).await {
        log(
            &client_id,
            format!("relay #{generation} upstream did not reach EOF within {IO_TIMEOUT:?}"),
        );
    }
    // Released as soon as the upstream reached EOF; the browser close may still block.
    drop(ticket);
    let _ = tokio::time::timeout(IO_TIMEOUT, browser.close()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn upstream_handshake_timeout_is_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let result = connect_comfy(&url, std::time::Duration::from_millis(30), "").await;
        assert_eq!(result.unwrap_err(), StatusCode::GATEWAY_TIMEOUT);
        server.abort();
    }

    #[tokio::test]
    async fn rejected_upstream_handshake_returns_bad_gateway() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let result = connect_comfy(&url, std::time::Duration::from_secs(2), "").await;
        assert_eq!(result.unwrap_err(), StatusCode::BAD_GATEWAY);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn accepted_upstream_preserves_monitor_messages() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    r#"{"type":"crystools.monitor","data":{"gpus":[]}}"#.into(),
                ))
                .await
                .unwrap();
        });
        let mut socket = connect_comfy(&url, std::time::Duration::from_secs(2), "")
            .await
            .unwrap();
        let message = socket.next().await.unwrap().unwrap();
        assert!(message.to_text().unwrap().contains("crystools.monitor"));
        server.await.unwrap();
    }

    type Sockets = Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>,
        >,
    >;

    /// Mimics ComfyUI 0.37 `websocket_handler`: a reused clientId replaces the old
    /// entry without closing it, `finally` pops the clientId unconditionally, and the
    /// TCP connection closes only after that pop.
    async fn fake_comfy(
        finally_delay: std::time::Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("ws://{}/ws", listener.local_addr().unwrap());
        let sockets: Sockets = Default::default();
        let broadcast = sockets.clone();
        let server = tokio::spawn(async move {
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    let targets: Vec<_> = broadcast.lock().unwrap().values().cloned().collect();
                    for target in targets {
                        let _ = target.send(r#"{"type":"crystools.monitor","data":{}}"#.to_owned());
                    }
                }
            });
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let sockets = sockets.clone();
                tokio::spawn(async move {
                    // Read the clientId from the request line without consuming it.
                    let mut head = [0; 512];
                    let read = stream.peek(&mut head).await.unwrap();
                    let head = String::from_utf8_lossy(&head[..read]);
                    let sid = head
                        .split_once("clientId=")
                        .and_then(|(_, rest)| rest.split([' ', '&']).next())
                        .unwrap_or_default()
                        .to_owned();
                    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                    sockets.lock().unwrap().insert(sid.clone(), sender);
                    loop {
                        tokio::select! {
                            Some(text) = receiver.recv() => {
                                if ws.send(tokio_tungstenite::tungstenite::Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            }
                            message = ws.next() => match message {
                                Some(Ok(_)) => continue,
                                _ => break,
                            },
                        }
                    }
                    tokio::time::sleep(finally_delay).await;
                    sockets.lock().unwrap().remove(&sid);
                    drop(ws);
                });
            }
        });
        (base, server)
    }

    async fn count_for(comfy: &mut ComfyWebSocket, window: std::time::Duration) -> usize {
        let mut count = 0;
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, comfy.next()).await {
            if message
                .to_text()
                .is_ok_and(|text| text.contains("crystools.monitor"))
            {
                count += 1;
            }
        }
        count
    }

    /// The relay loop reduced to its upstream half: forward until superseded, then
    /// retire the upstream exactly like `relay` does.
    async fn upstream_only_relay(mut comfy: ComfyWebSocket, ticket: RelayTicket) -> &'static str {
        let stop = Some(ticket.stop_signal());
        let reason = loop {
            tokio::select! {
                _ = superseded(&stop) => break "superseded",
                message = comfy.next() => if !matches!(message, Some(Ok(_))) { break "upstream closed" },
            }
        };
        assert!(close_upstream(&mut comfy).await);
        drop(ticket);
        reason
    }

    #[tokio::test]
    async fn fake_upstream_reproduces_the_detached_client() {
        let (base, server) = fake_comfy(std::time::Duration::from_millis(200)).await;
        let url = format!("{base}?clientId=same");
        let mut old = connect_comfy(&url, std::time::Duration::from_secs(2), "same")
            .await
            .unwrap();
        let mut new = connect_comfy(&url, std::time::Duration::from_secs(2), "same")
            .await
            .unwrap();
        assert!(count_for(&mut new, std::time::Duration::from_millis(200)).await > 0);
        // Without a handover the old connection finishes after the new one registered.
        assert!(close_upstream(&mut old).await);
        // Discard broadcasts that were already queued before the old `finally` ran.
        count_for(&mut new, std::time::Duration::from_millis(100)).await;
        assert_eq!(
            count_for(&mut new, std::time::Duration::from_millis(500)).await,
            0
        );
        server.abort();
    }

    #[tokio::test]
    async fn handover_keeps_the_new_relay_subscribed() {
        let (base, server) = fake_comfy(std::time::Duration::from_millis(200)).await;
        let url = format!("{base}?clientId=same");
        let registry = Arc::new(super::super::ws_handover::Registry::default());
        let (old, old_ticket) = registry
            .handover("same", || {
                connect_comfy(&url, std::time::Duration::from_secs(2), "same")
            })
            .await
            .unwrap();
        // Browser A vanished without a close frame, so its relay is still running.
        let old_relay = tokio::spawn(upstream_only_relay(old, old_ticket));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let (mut new, _new_ticket) = registry
            .handover("same", || {
                connect_comfy(&url, std::time::Duration::from_secs(2), "same")
            })
            .await
            .unwrap();
        assert_eq!(old_relay.await.unwrap(), "superseded");
        for _ in 0..3 {
            assert!(count_for(&mut new, std::time::Duration::from_millis(300)).await > 0);
        }
        server.abort();
    }

    #[test]
    fn client_id_is_read_from_the_query() {
        let uri: axum::http::Uri = "/api/comfy/ws?foo=1&clientId=abc%2Ddef".parse().unwrap();
        assert_eq!(client_id(&uri), "abc-def");
        let uri: axum::http::Uri = "/api/comfy/ws".parse().unwrap();
        assert_eq!(client_id(&uri), "");
    }

    #[test]
    fn ensure_rustls_provider_installs_default_crypto_provider() {
        ensure_rustls_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn local_view_resolves_mapped_files_migration_and_fallbacks() {
        let root = std::env::temp_dir().join(format!(
            "web-proxy-local-view-{}",
            uuid::Uuid::new_v4()
        ));
        let data_dir = root.join("data");
        let input_dir = root.join("input");
        let output_dir = root.join("output");
        std::fs::create_dir_all(output_dir.join("H3")).unwrap();
        std::fs::create_dir_all(output_dir.join("sucanvas-migrated")).unwrap();
        std::fs::create_dir_all(&input_dir).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(output_dir.join("H3/video.mp4"), b"output").unwrap();
        std::fs::write(
            output_dir.join("sucanvas-migrated/old-video.mp4"),
            b"migrated",
        )
        .unwrap();
        std::fs::write(input_dir.join("ref.png"), b"input").unwrap();
        std::fs::write(root.join("secret.mp4"), b"outside").unwrap();

        let in_str = input_dir.to_string_lossy().into_owned();
        let out_str = output_dir.to_string_lossy().into_owned();
        let resolve = |raw_uri: &str, in_dir: &str, out_dir: &str| {
            let query = reqwest::Url::parse(&format!("http://localhost{raw_uri}")).unwrap();
            let mut upstream_query = query.clone();
            upstream_query.query_pairs_mut().clear().extend_pairs(
                query
                    .query_pairs()
                    .filter(|(key, _)| key != "downloadName" && key != "download"),
            );
            let suffix = format!(
                "/view{}",
                upstream_query
                    .query()
                    .filter(|value| !value.is_empty())
                    .map(|value| format!("?{value}"))
                    .unwrap_or_default()
            );
            resolve_local_view_path(&data_dir, in_dir, out_dir, &query, &suffix)
        };

        assert_eq!(
            resolve(
                "/api/comfy/view?filename=video.mp4&subfolder=H3&type=output&infinite_canvas_prompt=p1",
                &in_str,
                &out_str
            )
            .unwrap(),
            Some(output_dir.join("H3/video.mp4"))
        );
        assert_eq!(
            resolve("/api/comfy/view?filename=video.mp4&subfolder=H3", &in_str, &out_str).unwrap(),
            Some(output_dir.join("H3/video.mp4"))
        );
        assert_eq!(
            resolve("/api/comfy/view?filename=ref.png&type=input", &in_str, &out_str).unwrap(),
            Some(input_dir.join("ref.png"))
        );
        assert_eq!(
            resolve("/api/comfy/view?filename=video.mp4&type=temp", &in_str, &out_str).unwrap(),
            None
        );
        assert_eq!(
            resolve(
                "/api/comfy/view?filename=video.mp4&subfolder=H3&type=output&preview=webp;90",
                &in_str,
                &out_str
            )
            .unwrap(),
            None
        );
        assert_eq!(
            resolve(
                "/api/comfy/view?filename=video.mp4&subfolder=H3&type=output&channel=rgba",
                &in_str,
                &out_str
            )
            .unwrap(),
            None
        );
        assert_eq!(
            resolve("/api/comfy/view?filename=video.mp4&subfolder=H3&type=output", "", "").unwrap(),
            None
        );
        assert_eq!(
            resolve(
                "/api/comfy/view?filename=missing.mp4&type=output",
                &in_str,
                &out_str
            )
            .unwrap(),
            None
        );

        for invalid in [
            "/api/comfy/view?filename=secret.mp4&subfolder=..&type=output",
            "/api/comfy/view?filename=../secret.mp4&type=output",
            "/api/comfy/view?filename=a/b.mp4&type=output",
            "/api/comfy/view?type=output",
        ] {
            assert!(resolve(invalid, &in_str, &out_str).is_err(), "{invalid}");
        }

        std::fs::write(
            data_dir.join("storage-migration-map.json"),
            serde_json::json!({
                "/api/comfy/view?filename=legacy.mp4&subfolder=&type=output":
                    "/api/comfy/view?filename=old-video.mp4&subfolder=sucanvas-migrated&type=output"
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            resolve(
                "/api/comfy/view?filename=legacy.mp4&subfolder=&type=output",
                &in_str,
                &out_str
            )
            .unwrap(),
            Some(output_dir.join("sucanvas-migrated/old-video.mp4"))
        );
        assert_eq!(
            resolve(
                "/api/comfy/view?filename=legacy.mp4&subfolder=&type=output&infinite_canvas_prompt=p2",
                &in_str,
                &out_str
            )
            .unwrap(),
            Some(output_dir.join("sucanvas-migrated/old-video.mp4"))
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn serve_local_view_supports_range_requests_and_download_header() {
        let root = std::env::temp_dir().join(format!(
            "web-proxy-serve-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("clip.mp4");
        std::fs::write(&file, b"0123456789abcdef").unwrap();

        let full_req = Request::builder()
            .method("GET")
            .uri("/api/comfy/view?filename=clip.mp4")
            .body(Body::empty())
            .unwrap();
        let full_resp = serve_local_view(&file, full_req, false, "clip.mp4").await;
        assert_eq!(full_resp.status(), StatusCode::OK);
        assert!(full_resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("video/mp4")));
        assert_eq!(
            full_resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, max-age=3600"
        );
        assert_eq!(
            full_resp
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
        assert!(full_resp
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .is_none());
        let full_body = axum::body::to_bytes(full_resp.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&full_body[..], b"0123456789abcdef");

        let range_req = Request::builder()
            .method("GET")
            .uri("/api/comfy/view?filename=clip.mp4")
            .header(header::RANGE, "bytes=0-3")
            .body(Body::empty())
            .unwrap();
        let range_resp = serve_local_view(&file, range_req, false, "clip.mp4").await;
        assert_eq!(range_resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            range_resp.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 0-3/16"
        );
        let range_body = axum::body::to_bytes(range_resp.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&range_body[..], b"0123");

        let download_req = Request::builder()
            .method("GET")
            .uri("/api/comfy/view?filename=clip.mp4&download=true")
            .body(Body::empty())
            .unwrap();
        let download_resp = serve_local_view(&file, download_req, true, "我的视频.mp4").await;
        assert_eq!(download_resp.status(), StatusCode::OK);
        assert!(download_resp
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("attachment;")));
        let _ = axum::body::to_bytes(download_resp.into_body(), 1024)
            .await
            .unwrap();

        let _ = std::fs::remove_dir_all(&root);
    }
}
