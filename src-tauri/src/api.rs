use std::{
    net::TcpListener as StdTcpListener,
    path::Path as FsPath,
    sync::{Arc, RwLock},
};

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{
    db::{CanvasError, CanvasResult, Database},
    models::{
        ApiConfig, AppendPromptVersionInput, CreateEdgeInput, CreateMissingPromptScenesInput,
        CreateNodeInput, CreateNodesBatchInput, CreateNodesBatchResult, UpdateContentVersionInput,
        UpdateNodeInput,
    },
    CanvasSelectionState,
};

#[derive(Clone)]
pub struct ApiState {
    pub database: Database,
    pub token: String,
    pub app_handle: Option<AppHandle>,
    pub active_canvas_id: Arc<RwLock<String>>,
    pub current_canvas_selection: Arc<RwLock<CanvasSelectionState>>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentGraphQuery {
    canvas_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasSelectionResponse {
    canvas_id: String,
    node_ids: Vec<String>,
    nodes: Vec<CanvasSelectionNode>,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasSelectionNode {
    id: String,
    kind: String,
    title: String,
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
        .route("/v1/nodes/{node_id}", delete(delete_node))
        .route("/v1/nodes:create-batch", post(create_nodes_batch))
        .route("/v1/nodes:update", post(update_node))
        .route("/v1/edges", post(create_edge))
        .route("/v1/edges/{edge_id}", delete(delete_edge))
        .route("/v1/canvas-selection", get(get_canvas_selection))
        .route("/v1/content-graph", get(get_content_graph))
        .route(
            "/v1/content-nodes/{node_id}/versions/{version_id}",
            delete(delete_content_version).put(update_content_version),
        )
        .route(
            "/v1/content-nodes/{node_id}/versions:append",
            post(append_content_version),
        )
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

async fn get_canvas_selection(State(state): State<ApiState>, headers: HeaderMap) -> Response {
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
    let selection = match state.current_canvas_selection.read() {
        Ok(selection) => selection.clone(),
        Err(_) => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "canvas selection lock is poisoned",
            );
        }
    };
    if selection.canvas_id.as_deref() != Some(active_canvas_id.as_str())
        || selection.node_ids.is_empty()
    {
        return Json(CanvasSelectionResponse {
            canvas_id: active_canvas_id,
            node_ids: Vec::new(),
            nodes: Vec::new(),
            updated_at: selection.updated_at,
        })
        .into_response();
    }

    match state.database.load_project(&active_canvas_id) {
        Ok(snapshot) => {
            let nodes_by_id = snapshot
                .nodes
                .into_iter()
                .map(|node| (node.id.clone(), node))
                .collect::<std::collections::HashMap<_, _>>();
            let nodes = selection
                .node_ids
                .iter()
                .filter_map(|node_id| nodes_by_id.get(node_id))
                .map(|node| CanvasSelectionNode {
                    id: node.id.clone(),
                    kind: node.kind.clone(),
                    title: node.title.clone(),
                })
                .collect::<Vec<_>>();
            Json(CanvasSelectionResponse {
                canvas_id: active_canvas_id,
                node_ids: nodes.iter().map(|node| node.id.clone()).collect(),
                nodes,
                updated_at: selection.updated_at,
            })
            .into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn get_content_graph(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<ContentGraphQuery>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    let canvas_id = if let Some(canvas_id) = query.canvas_id.filter(|value| !value.is_empty()) {
        canvas_id
    } else {
        match state.active_canvas_id.read() {
            Ok(active_canvas_id) => active_canvas_id.clone(),
            Err(_) => {
                return api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "active project lock is poisoned",
                );
            }
        }
    };
    match state.database.load_project(&canvas_id) {
        Ok(mut snapshot) => {
            let content_node_ids = snapshot
                .nodes
                .iter()
                .filter(|node| {
                    node.kind == "text"
                        && (node.content.get("contentNode") == Some(&serde_json::Value::Bool(true))
                            || node.content.get("promptVersionNode")
                                == Some(&serde_json::Value::Bool(true))
                            || node.content.get("storySceneNode")
                                == Some(&serde_json::Value::Bool(true)))
                })
                .map(|node| node.id.clone())
                .collect::<std::collections::BTreeSet<_>>();
            snapshot
                .nodes
                .retain(|node| content_node_ids.contains(&node.id));
            snapshot.edges.retain(|edge| {
                (edge.kind == "content-derivation" || edge.kind == "scene-branch")
                    && content_node_ids.contains(&edge.source_node_id)
                    && content_node_ids.contains(&edge.target_node_id)
            });
            Json(snapshot).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn create_edge(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut input): Json<CreateEdgeInput>,
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
    match state.database.create_edge_with_status(input) {
        Ok((edge, created)) => {
            let should_capture_initial_sources = created
                && edge.kind == "content-derivation"
                && edge
                    .metadata
                    .get("captureInitialVersionSources")
                    .and_then(|value| value.as_bool())
                    == Some(true);
            let positioned_target = if created
                && edge.kind == "content-derivation"
                && edge
                    .metadata
                    .get("layoutPlacement")
                    .and_then(|value| value.as_str())
                    == Some("right-of-source")
            {
                match state
                    .database
                    .place_node_to_the_right_of(&edge.source_node_id, &edge.target_node_id)
                {
                    Ok(node) => Some(node),
                    Err(error) => return api_error(status_for_error(&error), &error.to_string()),
                }
            } else {
                None
            };
            let updated_target = if should_capture_initial_sources {
                match state
                    .database
                    .capture_active_version_sources(&edge.target_node_id)
                {
                    Ok(node) => Some(node),
                    Err(error) => return api_error(status_for_error(&error), &error.to_string()),
                }
            } else {
                positioned_target
            };
            if let Some(app_handle) = state.app_handle.as_ref() {
                if let Some(node) = updated_target {
                    let _ = app_handle.emit("canvas://node-updated", node);
                }
                let _ = app_handle.emit("canvas://edge-created", edge.clone());
            }
            Json(edge).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn delete_edge(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(edge_id): Path<String>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    match state.database.delete_edge(&edge_id) {
        Ok(()) => {
            if let Some(app_handle) = state.app_handle.as_ref() {
                let _ = app_handle.emit("canvas://edge-deleted", edge_id.clone());
            }
            Json(serde_json::json!({ "id": edge_id })).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn delete_node(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    match state.database.delete_node(&node_id) {
        Ok(()) => {
            if let Some(app_handle) = state.app_handle.as_ref() {
                let _ = app_handle.emit("canvas://node-deleted", node_id.clone());
            }
            Json(serde_json::json!({ "id": node_id })).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

async fn delete_content_version(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((node_id, version_id)): Path<(String, String)>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    match state.database.delete_content_version(&node_id, &version_id) {
        Ok(node) => {
            if let Some(app_handle) = state.app_handle.as_ref() {
                let _ = app_handle.emit("canvas://node-updated", node.clone());
            }
            Json(node).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
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

async fn create_nodes_batch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<CreateNodesBatchInput>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    if input.nodes.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "nodes must not be empty");
    }
    if input.nodes.len() > 64 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "a node batch may contain at most 64 nodes",
        );
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

    let mut results = Vec::with_capacity(input.nodes.len());
    for mut node_input in input.nodes {
        if node_input.canvas_id.is_none() {
            node_input.canvas_id = Some(active_canvas_id.clone());
        }
        match state.database.create_node(node_input) {
            Ok(result) => results.push(result),
            Err(error) => return api_error(status_for_error(&error), &error.to_string()),
        }
    }
    let created_indices = results
        .iter()
        .enumerate()
        .filter_map(|(index, result)| result.created.then_some(index))
        .collect::<Vec<_>>();
    if created_indices.len() > 1 {
        let first = &results[created_indices[0]].node;
        let mut next_x = first.x;
        let row_y = first.y;
        for index in created_indices.iter().copied() {
            let node = &results[index].node;
            match state.database.update_node(UpdateNodeInput {
                id: node.id.clone(),
                title: None,
                content: None,
                x: Some(next_x),
                y: Some(row_y),
                width: None,
                height: None,
                status: None,
            }) {
                Ok(updated) => {
                    next_x += updated.width + 60.0;
                    results[index].node = updated;
                }
                Err(error) => return api_error(status_for_error(&error), &error.to_string()),
            }
        }
    }
    let created_nodes = results
        .iter()
        .filter(|result| result.created)
        .map(|result| result.node.clone())
        .collect::<Vec<_>>();
    if !created_nodes.is_empty() {
        if let Some(app_handle) = state.app_handle.as_ref() {
            let _ = app_handle.emit("canvas://nodes-created", created_nodes);
        }
    }
    let created_count = results.iter().filter(|result| result.created).count();
    let existing_count = results.len() - created_count;
    let status = if created_count > 0 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    (
        status,
        Json(CreateNodesBatchResult {
            nodes: results,
            created_count,
            existing_count,
        }),
    )
        .into_response()
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
                let created_nodes = result
                    .scenes
                    .iter()
                    .filter(|scene| scene.created)
                    .map(|scene| scene.node.clone())
                    .collect::<Vec<_>>();
                if !created_nodes.is_empty() {
                    let _ = app_handle.emit("canvas://nodes-created", created_nodes);
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

async fn append_content_version(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
    Json(input): Json<AppendPromptVersionInput>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    match state.database.append_content_version(&node_id, input) {
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

async fn update_content_version(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((node_id, version_id)): Path<(String, String)>,
    Json(input): Json<UpdateContentVersionInput>,
) -> Response {
    if !authorized(&headers, &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    match state
        .database
        .update_content_version(&node_id, &version_id, input)
    {
        Ok(result) => {
            if let Some(app_handle) = state.app_handle.as_ref() {
                let _ = app_handle.emit("canvas://node-updated", result.node.clone());
            }
            Json(result).into_response()
        }
        Err(error) => api_error(status_for_error(&error), &error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::to_bytes,
        http::{header::AUTHORIZATION, HeaderValue},
    };

    #[tokio::test]
    async fn canvas_selection_ignores_stale_canvas_state() {
        let active_canvas_id = Arc::new(RwLock::new("canvas:active".to_owned()));
        let database_path = std::env::temp_dir().join(format!(
            "infinite-canvas-selection-api-test-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        ));
        let state = ApiState {
            database: Database::open(&database_path).unwrap(),
            token: "selection-test-token".to_owned(),
            app_handle: None,
            active_canvas_id,
            current_canvas_selection: Arc::new(RwLock::new(CanvasSelectionState {
                canvas_id: Some("canvas:stale".to_owned()),
                node_ids: vec!["node:stale".to_owned()],
                updated_at: "2026-08-14T00:00:00+00:00".to_owned(),
            })),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer selection-test-token"),
        );

        let response = get_canvas_selection(State(state), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
        assert_eq!(payload["canvasId"], "canvas:active");
        assert_eq!(payload["nodeIds"], serde_json::json!([]));
        assert_eq!(payload["nodes"], serde_json::json!([]));
        std::fs::remove_file(database_path).unwrap();
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
