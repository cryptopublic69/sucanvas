use super::{
    catalog::{probe_all_providers, ProviderStatusSnapshot},
    runner::{
        cancel_video, confirm_video, submit_video, ExternalVideoJobRecord, ExternalVideoSubmitInput,
    },
};
use crate::web::{
    auth::{Permission, Session},
    WebState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Serialize;
use serde_json::json;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvidersStatusResponse {
    providers: Vec<ProviderStatusSnapshot>,
}

pub(crate) fn mount_routes(router: Router<WebState>) -> Router<WebState> {
    router
        .route("/api/external-providers/status", get(read_providers_status))
        .route("/api/external-providers/video/submit", post(submit_video_job))
        .route("/api/external-providers/video/{jobId}", get(get_video_job))
        .route(
            "/api/external-providers/video/{jobId}/confirm",
            post(confirm_video_job),
        )
        .route(
            "/api/external-providers/video/{jobId}/cancel",
            post(cancel_video_job),
        )
}

async fn read_providers_status(State(state): State<WebState>) -> Json<ProvidersStatusResponse> {
    let state = state.connection_snapshot();
    let providers = probe_all_providers(&state.executable_root, &state.core.data_dir).await;
    Json(ProvidersStatusResponse { providers })
}

async fn submit_video_job(
    State(state): State<WebState>,
    Extension(session): Extension<Session>,
    Json(input): Json<ExternalVideoSubmitInput>,
) -> Response {
    let state = state.connection_snapshot();
    if let Err(denied) = state
        .auth
        .authorize(&session, &Permission::CanvasWrite(input.canvas_id.clone()))
    {
        return denied.into_response();
    }
    match submit_video(state, session.user_id, input).await {
        Ok(job) => (StatusCode::ACCEPTED, Json(job)).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

fn load_authorized_job(
    state: &WebState,
    session: &Session,
    job_id: &str,
    write: bool,
) -> Result<ExternalVideoJobRecord, Response> {
    let job = match state.external_jobs.get(job_id) {
        Ok(Some(job)) => job,
        Ok(None) => {
            return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "外部生成任务不存在" }))).into_response())
        }
        Err(error) => {
            return Err(
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": error }))).into_response(),
            )
        }
    };
    let perm = if write {
        Permission::CanvasWrite(job.canvas_id.clone())
    } else {
        Permission::CanvasRead(job.canvas_id.clone())
    };
    if let Err(denied) = state.auth.authorize(session, &perm) {
        return Err(denied.into_response());
    }
    Ok(job)
}

async fn get_video_job(
    State(state): State<WebState>,
    Extension(session): Extension<Session>,
    Path(job_id): Path<String>,
) -> Response {
    let state = state.connection_snapshot();
    match load_authorized_job(&state, &session, &job_id, false) {
        Ok(job) => (StatusCode::OK, Json(job)).into_response(),
        Err(resp) => resp,
    }
}

async fn confirm_video_job(
    State(state): State<WebState>,
    Extension(session): Extension<Session>,
    Path(job_id): Path<String>,
) -> Response {
    let state = state.connection_snapshot();
    let job = match load_authorized_job(&state, &session, &job_id, true) {
        Ok(job) => job,
        Err(resp) => return resp,
    };
    match confirm_video(state, job).await {
        Ok(updated) => (StatusCode::OK, Json(updated)).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

async fn cancel_video_job(
    State(state): State<WebState>,
    Extension(session): Extension<Session>,
    Path(job_id): Path<String>,
) -> Response {
    let state = state.connection_snapshot();
    let job = match load_authorized_job(&state, &session, &job_id, true) {
        Ok(job) => job,
        Err(resp) => return resp,
    };
    match cancel_video(state, job).await {
        Ok(updated) => (StatusCode::OK, Json(updated)).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}
