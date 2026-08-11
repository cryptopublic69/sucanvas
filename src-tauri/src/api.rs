use std::{
    net::TcpListener as StdTcpListener,
    path::Path as FsPath,
    sync::{Arc, RwLock},
};

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{
    db::{CanvasError, CanvasResult, Database},
    models::{
        ApiConfig, AppendPromptVersionInput, CreateMissingPromptScenesInput, CreateNodeInput,
        UpdateNodeInput,
    },
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptSetListQuery {
    active_canvas_only: Option<bool>,
}

pub fn write_config(path: &FsPath, config: &ApiConfig) -> CanvasResult<()> {
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
        .route("/v1/nodes:update", post(update_node))
        .route("/v1/prompt-sets", get(list_prompt_sets))
        .route(
            "/v1/prompt-sets/{prompt_set_id}/scenes",
            get(get_prompt_set_scenes),
        )
        .route(
            "/v1/prompt-sets/{prompt_set_id}/scenes:create-missing",
            post(create_missing_prompt_scenes),
        )
        .route(
            "/v1/prompt-sets/{prompt_set_id}/scenes/{scene_key}/versions:append",
            post(append_prompt_version),
        )
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

async fn update_node(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<UpdateNodeInput>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }

    match state.database.update_node(input) {
        Ok(node) => {
            if let Some(app_handle) = state.app_handle.as_ref() {
                let _ = app_handle.emit("canvas://node-updated", node.clone());
            }
            Json(node).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn list_prompt_sets(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<PromptSetListQuery>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }

    let result = if query.active_canvas_only.unwrap_or(false) {
        let active_canvas_id = match state.active_canvas_id.read() {
            Ok(active_canvas_id) => active_canvas_id.clone(),
            Err(_) => {
                return api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "active project lock is poisoned",
                );
            }
        };
        state
            .database
            .list_prompt_sets_for_canvas(&active_canvas_id)
    } else {
        state.database.list_prompt_sets()
    };

    match result {
        Ok(prompt_sets) => Json(prompt_sets).into_response(),
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn get_prompt_set_scenes(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(prompt_set_id): Path<String>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    match state.database.get_prompt_set_scenes(&prompt_set_id) {
        Ok(result) => Json(result).into_response(),
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn create_missing_prompt_scenes(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(prompt_set_id): Path<String>,
    Json(input): Json<CreateMissingPromptScenesInput>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    let active_canvas_id = match state.active_canvas_id.read() {
        Ok(active_canvas_id) => active_canvas_id.clone(),
        Err(_) => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "active project lock is poisoned",
            );
        }
    };
    match state
        .database
        .create_missing_prompt_scenes(&prompt_set_id, &active_canvas_id, input)
    {
        Ok(result) => {
            if let Some(app_handle) = state.app_handle.as_ref() {
                for scene in result.scenes.iter().filter(|scene| scene.created) {
                    let _ = app_handle.emit("canvas://node-created", scene.node.clone());
                }
            }
            let status = if result.created_count > 0 {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(result)).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn append_prompt_version(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((prompt_set_id, scene_key)): Path<(String, String)>,
    Json(input): Json<AppendPromptVersionInput>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    match state
        .database
        .append_prompt_version(&prompt_set_id, &scene_key, input)
    {
        Ok(result) => {
            if result.created {
                if let Some(app_handle) = state.app_handle.as_ref() {
                    let _ = app_handle.emit("canvas://node-updated", result.node.clone());
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
        CanvasError::NotFound(_) => StatusCode::NOT_FOUND,
        CanvasError::Conflict(_) => StatusCode::CONFLICT,
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
