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
    let suffix = format!(
        "{tail}{}",
        request
            .uri()
            .query()
            .map(|q| format!("?{q}"))
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
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                "private, max-age=60".parse().unwrap(),
            );
            response
        }
        Err(_) => (StatusCode::BAD_GATEWAY, "无法连接服务器配置的 ComfyUI").into_response(),
    }
}
pub async fn websocket(
    State(state): State<WebState>,
    request: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
    uri: axum::http::Uri,
) -> Response {
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
    ws.on_upgrade(move |socket| relay(state, request, socket, url))
}
async fn relay(
    state: WebState,
    headers: axum::http::HeaderMap,
    mut browser: WebSocket,
    url: String,
) {
    let Ok((mut comfy, _)) = tokio_tungstenite::connect_async(url).await else {
        let _ = browser.send(Message::Close(None)).await;
        return;
    };
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = heartbeat.tick() => { if !state.auth.authenticated(&headers) { break; } },
            message = browser.recv() => {
                let message = match message { Some(Ok(Message::Text(value))) => tokio_tungstenite::tungstenite::Message::Text(value.to_string().into()), Some(Ok(Message::Binary(value))) => tokio_tungstenite::tungstenite::Message::Binary(value), Some(Ok(Message::Ping(value))) => tokio_tungstenite::tungstenite::Message::Ping(value), Some(Ok(Message::Pong(value))) => tokio_tungstenite::tungstenite::Message::Pong(value), _ => break };
                if comfy.send(message).await.is_err() { break; }
            },
            message = comfy.next() => {
                let message = match message { Some(Ok(tokio_tungstenite::tungstenite::Message::Text(value))) => Message::Text(value.to_string().into()), Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(value))) => Message::Binary(value), Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(value))) => Message::Ping(value), Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(value))) => Message::Pong(value), _ => break };
                if browser.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = browser.close().await;
    let _ = comfy.close(None).await;
}
