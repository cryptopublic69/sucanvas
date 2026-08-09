use std::{
    net::TcpListener as StdTcpListener,
    path::Path,
    sync::{Arc, RwLock},
};

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{
    db::{CanvasError, CanvasResult, Database},
    models::{ApiConfig, CreateNodeInput},
};

#[derive(Clone)]
pub struct ApiState {
    pub database: Database,
    pub token: String,
    pub app_handle: Option<AppHandle>,
    pub active_canvas_id: Arc<RwLock<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiErrorResponse {
    ok: bool,
    error: String,
}

pub fn write_config(path: &Path, config: &ApiConfig) -> CanvasResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(config)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

pub async fn serve(listener: StdTcpListener, state: ApiState) -> CanvasResult<()> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, router(state))
        .await
        .map_err(CanvasError::Io)
}

fn router(state: ApiState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/nodes", post(create_node))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "SuCanvas",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn create_node(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut input): Json<CreateNodeInput>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }

    if input.canvas_id.is_none() {
        let active_canvas_id = match state.active_canvas_id.read() {
            Ok(active_canvas_id) => active_canvas_id.clone(),
            Err(_) => {
                return api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "active project lock is poisoned",
                );
            }
        };
        input.canvas_id = Some(active_canvas_id);
    }

    match state.database.create_node(input) {
        Ok(result) => {
            if result.created {
                if let Some(app_handle) = state.app_handle.as_ref() {
                    let _ = app_handle.emit("canvas://node-created", result.node.clone());
                }
            }
            let status = if result.created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(result)).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

fn authorized(headers: &HeaderMap, expected_token: &str) -> bool {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token.as_bytes() == expected_token.as_bytes())
        .unwrap_or(false)
}

fn status_for_error(error: &CanvasError) -> StatusCode {
    match error {
        CanvasError::Validation(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn api_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ApiErrorResponse {
            ok: false,
            error: message.to_owned(),
        }),
    )
        .into_response()
}
