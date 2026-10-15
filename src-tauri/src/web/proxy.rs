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

fn upstream(state: &WebState, suffix: &str) -> Result<String, StatusCode> {
    if state.config.comfy_url.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    Ok(format!(
        "{}{}",
        state.config.comfy_url.trim_end_matches('/'),
        suffix
    ))
}
pub async fn http(State(state): State<WebState>, request: Request<Body>) -> Response {
    let state = state.connection_snapshot();
    let tail = request
        .uri()
        .path()
        .strip_prefix("/api/comfy")
        .unwrap_or("");
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
    let url = match upstream(&state, &suffix) {
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
) -> Result<ComfyWebSocket, StatusCode> {
    match tokio::time::timeout(deadline, tokio_tungstenite::connect_async(url)).await {
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(error)) => {
            eprintln!("[comfy-ws] upstream handshake failed: {error}");
            Err(StatusCode::BAD_GATEWAY)
        }
        Err(_) => {
            eprintln!("[comfy-ws] upstream handshake timed out");
            Err(StatusCode::GATEWAY_TIMEOUT)
        }
    }
}

pub async fn websocket(
    State(state): State<WebState>,
    request: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
    uri: axum::http::Uri,
) -> Response {
    let state = state.connection_snapshot();
    let url = match upstream(
        &state,
        &format!(
            "/ws{}",
            uri.query().map(|q| format!("?{q}")).unwrap_or_default()
        ),
    ) {
        Ok(url) => url.replacen("http", "ws", 1),
        Err(status) => return status.into_response(),
    };
    // Do not report an open browser socket until ComfyUI has accepted it.
    let comfy = match connect_comfy(&url, UPSTREAM_CONNECT_TIMEOUT).await {
        Ok(socket) => socket,
        Err(status) => return status.into_response(),
    };
    if !state.auth.authenticated(&request) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| relay(state, request, socket, comfy))
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

async fn relay(
    state: WebState,
    headers: axum::http::HeaderMap,
    mut browser: WebSocket,
    mut comfy: ComfyWebSocket,
) {
    use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut upstream_seen = tokio::time::Instant::now();
    let reason = loop {
        if !state.auth.authenticated(&headers) {
            break "session expired";
        }
        tokio::select! {
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
                        eprintln!("[comfy-ws] browser read failed: {error}");
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
                        eprintln!("[comfy-ws] upstream read failed: {error}");
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
        eprintln!("[comfy-ws] relay stopped: {reason}");
    }
    let _ = tokio::time::timeout(IO_TIMEOUT, browser.close()).await;
    let _ = tokio::time::timeout(IO_TIMEOUT, comfy.close(None)).await;
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
        let result = connect_comfy(&url, std::time::Duration::from_millis(30)).await;
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
        let result = connect_comfy(&url, std::time::Duration::from_secs(2)).await;
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
        let mut socket = connect_comfy(&url, std::time::Duration::from_secs(2))
            .await
            .unwrap();
        let message = socket.next().await.unwrap().unwrap();
        assert!(message.to_text().unwrap().contains("crystools.monitor"));
        server.await.unwrap();
    }
}
