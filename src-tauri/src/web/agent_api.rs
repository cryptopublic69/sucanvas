//! External agent automation API (`/v1/agent/*`) for SuCanvas Web.
//!
//! Provides Bearer-token-authenticated capability discovery, canvas/node inspection,
//! asset upload, server-managed asynchronous H3 video generation (persisting canvas
//! placeholder/result nodes and emitting SSE updates even if the caller disconnects),
//! cancellation, and output video streaming.

use super::{
    files::{download_disposition, resolve as resolve_resource_file, serve as serve_resource_file},
    media::reference_outputs,
    rpc::{self, ensure_contained},
    storage::{self, IMPORT_FOLDER},
    users::Role,
    WebState,
};
use crate::{
    colab_channel::{
        web::{inspect_colab_profile, materialize_ss_outputs},
        workflow::{
            colab_profile_spec, normalize_colab_sampler, COLAB_ALLOWED_LORAS,
            COLAB_DEFAULT_SAMPLER, COLAB_WORKFLOW_LABEL,
        },
    },
    commands,
    models::{
        ComfyOutputFile, ComfySubmitInput, CreateEdgeInput, CreateNodeInput, H3StyleLora,
        NodeRecord, UpdateNodeInput, WorkspaceSnapshot,
    },
    platform::{Channel, State as PlatformState},
    workflow_modules::WorkflowModuleRecord,
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const LOCAL_PRESETS_KEY: &str = "infinite-canvas:video-regeneration-presets:v1";
const LEGACY_PRESETS_KEY: &str = "infinite-canvas:video-regeneration-settings:v1";
const WORKFLOW_MODULE_DEFAULTS_KEY: &str = "infinite-canvas:workflow-module-defaults";
const DEFAULT_H3_DIFFUSION_MODEL_NAME: &str =
    r"MinimaxH3\minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const VIDEO_GENERATION_NODE_WIDTH: f64 = 460.0;
const VIDEO_GENERATION_NODE_HEIGHT: f64 = 356.0;
const GENERATED_VIDEO_PREVIEW_WIDTH: f64 = 420.0;
const GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH: f64 = 300.0;
const GENERATED_VIDEO_FOOTER_HEIGHT: f64 = 38.0;

const JOB_COLUMNS: &str = "id, request_id, canvas_id, kind, channel, entry_mode, preset_name,
    status, client_id, prompt_id, source_node_id, generator_node_id, placeholder_node_id,
    output_node_ids_json, outputs_json, snapshot_json, seed, execution_elapsed_seconds,
    error, created_at, updated_at";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    canvas_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    channel TEXT NOT NULL,
    entry_mode TEXT NOT NULL,
    preset_name TEXT NOT NULL,
    status TEXT NOT NULL,
    client_id TEXT NOT NULL,
    prompt_id TEXT,
    source_node_id TEXT,
    generator_node_id TEXT,
    placeholder_node_id TEXT,
    output_node_ids_json TEXT NOT NULL DEFAULT '[]',
    outputs_json TEXT NOT NULL DEFAULT '[]',
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    seed TEXT,
    execution_elapsed_seconds REAL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_canvas_created
    ON agent_jobs(canvas_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_canvas_requests (
    request_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentJobRecord {
    pub id: String,
    pub request_id: String,
    pub canvas_id: String,
    pub kind: String,
    pub channel: String,
    pub entry_mode: String,
    pub preset_name: String,
    pub status: String,
    pub client_id: String,
    pub prompt_id: Option<String>,
    pub source_node_id: Option<String>,
    pub generator_node_id: Option<String>,
    pub placeholder_node_id: Option<String>,
    pub output_node_ids: Vec<String>,
    pub outputs: Vec<Value>,
    #[serde(skip_serializing)]
    pub snapshot: Value,
    pub seed: Option<String>,
    pub execution_elapsed_seconds: Option<f64>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) struct AgentJobStore {
    connection: Mutex<Connection>,
}

impl AgentJobStore {
    pub fn open(database: &Path) -> Result<Self, String> {
        let connection = Connection::open(database).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn map_row(row: &Row<'_>) -> rusqlite::Result<AgentJobRecord> {
        let output_node_ids_json: String = row.get(13)?;
        let outputs_json: String = row.get(14)?;
        let snapshot_json: String = row.get(15)?;
        Ok(AgentJobRecord {
            id: row.get(0)?,
            request_id: row.get(1)?,
            canvas_id: row.get(2)?,
            kind: row.get(3)?,
            channel: row.get(4)?,
            entry_mode: row.get(5)?,
            preset_name: row.get(6)?,
            status: row.get(7)?,
            client_id: row.get(8)?,
            prompt_id: row.get(9)?,
            source_node_id: row.get(10)?,
            generator_node_id: row.get(11)?,
            placeholder_node_id: row.get(12)?,
            output_node_ids: serde_json::from_str(&output_node_ids_json).unwrap_or_default(),
            outputs: serde_json::from_str(&outputs_json).unwrap_or_default(),
            snapshot: serde_json::from_str(&snapshot_json).unwrap_or(Value::Null),
            seed: row.get(16)?,
            execution_elapsed_seconds: row.get(17)?,
            error: row.get(18)?,
            created_at: row.get(19)?,
            updated_at: row.get(20)?,
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<AgentJobRecord>, String> {
        let connection = self.connection.lock().map_err(|_| "任务存储锁已损坏".to_owned())?;
        connection
            .query_row(
                &format!("SELECT {JOB_COLUMNS} FROM agent_jobs WHERE id = ?1"),
                [id],
                Self::map_row,
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn get_by_request_id(&self, request_id: &str) -> Result<Option<AgentJobRecord>, String> {
        let connection = self.connection.lock().map_err(|_| "任务存储锁已损坏".to_owned())?;
        connection
            .query_row(
                &format!("SELECT {JOB_COLUMNS} FROM agent_jobs WHERE request_id = ?1"),
                [request_id],
                Self::map_row,
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn insert(&self, job: &AgentJobRecord) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "任务存储锁已损坏".to_owned())?;
        connection
            .execute(
                "INSERT INTO agent_jobs (
                    id, request_id, canvas_id, kind, channel, entry_mode, preset_name,
                    status, client_id, prompt_id, source_node_id, generator_node_id,
                    placeholder_node_id, output_node_ids_json, outputs_json, snapshot_json,
                    seed, execution_elapsed_seconds, error, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                    ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20, ?21
                )",
                params![
                    job.id,
                    job.request_id,
                    job.canvas_id,
                    job.kind,
                    job.channel,
                    job.entry_mode,
                    job.preset_name,
                    job.status,
                    job.client_id,
                    job.prompt_id,
                    job.source_node_id,
                    job.generator_node_id,
                    job.placeholder_node_id,
                    serde_json::to_string(&job.output_node_ids).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&job.outputs).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&job.snapshot).unwrap_or_else(|_| "{}".into()),
                    job.seed,
                    job.execution_elapsed_seconds,
                    job.error,
                    job.created_at,
                    job.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_status(&self, job: &AgentJobRecord) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "任务存储锁已损坏".to_owned())?;
        connection
            .execute(
                "UPDATE agent_jobs SET
                    status = ?2,
                    prompt_id = ?3,
                    output_node_ids_json = ?4,
                    outputs_json = ?5,
                    seed = ?6,
                    execution_elapsed_seconds = ?7,
                    error = ?8,
                    updated_at = ?9
                 WHERE id = ?1",
                params![
                    job.id,
                    job.status,
                    job.prompt_id,
                    serde_json::to_string(&job.output_node_ids).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&job.outputs).unwrap_or_else(|_| "[]".into()),
                    job.seed,
                    job.execution_elapsed_seconds,
                    job.error,
                    job.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_canvas_request(&self, request_id: &str) -> Result<Option<String>, String> {
        let connection = self.connection.lock().map_err(|_| "任务存储锁已损坏".to_owned())?;
        connection
            .query_row(
                "SELECT canvas_id FROM agent_canvas_requests WHERE request_id = ?1",
                [request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn record_canvas_request(&self, request_id: &str, canvas_id: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "任务存储锁已损坏".to_owned())?;
        connection
            .execute(
                "INSERT OR IGNORE INTO agent_canvas_requests (request_id, canvas_id, created_at)
                 VALUES (?1, ?2, ?3)",
                params![request_id, canvas_id, now_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct AgentActor {
    user_id: String,
    #[allow(dead_code)]
    username: String,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": message.into() })),
    )
        .into_response()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn bearer_matches(headers: &HeaderMap, expected_token: &str) -> bool {
    let Some(raw) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(provided) = raw.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(provided.as_bytes(), expected_token.as_bytes())
}

async fn require_bearer(
    State(state): State<WebState>,
    request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    if !bearer_matches(request.headers(), &state.token) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or missing bearer token");
    }
    next.run(request).await
}

fn resolve_actor(state: &WebState) -> AgentActor {
    if let Ok(users) = state.auth.users().list() {
        if let Some(admin) = users
            .into_iter()
            .find(|user| user.role == Role::Admin && !user.disabled)
        {
            return AgentActor {
                user_id: admin.id,
                username: admin.username,
            };
        }
    }
    AgentActor {
        user_id: "admin".to_owned(),
        username: "admin".to_owned(),
    }
}

pub(crate) fn router(state: WebState) -> Router {
    let upload_limit = state.config.max_upload_bytes;
    Router::new()
        .route("/v1/agent/capabilities", get(get_capabilities))
        .route("/v1/agent/canvases", get(list_canvases).post(create_canvas))
        .route("/v1/agent/canvases/{canvas_id}/nodes", get(get_canvas_nodes))
        .route(
            "/v1/agent/assets",
            post(upload_asset).layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route("/v1/agent/jobs", post(submit_job))
        .route("/v1/agent/jobs/{job_id}", get(get_job))
        .route("/v1/agent/jobs/{job_id}/cancel", post(cancel_job))
        .route("/v1/agent/jobs/{job_id}/outputs/{index}", get(download_job_output))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_bearer))
        .with_state(state)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPresetSettings {
    #[serde(default = "default_primary_res")]
    primary_resolution_megapixels: f64,
    #[serde(default = "default_secondary_res")]
    secondary_resolution_megapixels: f64,
    #[serde(default = "default_one_f64")]
    primary_upscale_factor: f64,
    #[serde(default = "default_six")]
    primary_video_steps: u32,
    #[serde(default = "default_eight")]
    primary_audio_steps: u32,
    #[serde(default = "default_four")]
    secondary_scheduler_steps: u32,
    #[serde(default = "default_one_f64")]
    primary_brightness: f64,
    #[serde(default = "default_point_nine")]
    primary_contrast: f64,
    #[serde(default = "default_point_nine")]
    primary_saturation: f64,
    #[serde(default = "default_one_f64")]
    secondary_brightness: f64,
    #[serde(default = "default_point_nine")]
    secondary_contrast: f64,
    #[serde(default = "default_one_f64")]
    secondary_saturation: f64,
    #[serde(default)]
    diffusion_model_name: Option<String>,
    #[serde(default)]
    lora_name: Option<String>,
    #[serde(default = "default_one_f64")]
    lora_strength: f64,
    #[serde(default)]
    lora_bypassed: Option<bool>,
    #[serde(default)]
    secondary_lora_name: Option<String>,
    #[serde(default)]
    secondary_lora_strength: Option<f64>,
    #[serde(default)]
    secondary_lora_bypassed: Option<bool>,
    #[serde(default)]
    style_loras: Vec<H3StyleLora>,
    #[serde(default)]
    colab_sampler: Option<String>,
}

fn default_primary_res() -> f64 {
    0.3
}
fn default_secondary_res() -> f64 {
    0.7
}
fn default_one_f64() -> f64 {
    1.0
}
fn default_point_nine() -> f64 {
    0.9
}
fn default_six() -> u32 {
    6
}
fn default_eight() -> u32 {
    8
}
fn default_four() -> u32 {
    4
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPresetEntry {
    id: String,
    name: String,
    settings: StoredPresetSettings,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPresetCollection {
    #[serde(default)]
    presets: Vec<StoredPresetEntry>,
    #[serde(default)]
    default_preset_id: String,
}

fn read_web_settings(state: &WebState) -> BTreeMap<String, String> {
    let path = state.core.data_dir.join("web-settings.json");
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, String>>(&bytes).ok())
        .unwrap_or_default()
}

fn load_local_presets(settings: &BTreeMap<String, String>) -> StoredPresetCollection {
    if let Some(raw) = settings.get(LOCAL_PRESETS_KEY) {
        if let Ok(collection) = serde_json::from_str::<StoredPresetCollection>(raw) {
            return collection;
        }
    }
    if let Some(raw) = settings.get(LEGACY_PRESETS_KEY) {
        if let Ok(legacy_settings) = serde_json::from_str::<StoredPresetSettings>(raw) {
            return StoredPresetCollection {
                presets: vec![StoredPresetEntry {
                    id: "legacy".to_owned(),
                    name: "原有设置".to_owned(),
                    settings: legacy_settings,
                }],
                default_preset_id: "legacy".to_owned(),
            };
        }
    }
    StoredPresetCollection::default()
}

fn colab_seeded_collection(profile: &str) -> StoredPresetCollection {
    let Some(spec) = colab_profile_spec(profile) else {
        return StoredPresetCollection::default();
    };
    let seeded_id = format!("colab-default-{}", spec.id);
    StoredPresetCollection {
        presets: vec![StoredPresetEntry {
            id: seeded_id.clone(),
            name: format!("{} 默认方案", spec.label),
            settings: StoredPresetSettings {
                primary_resolution_megapixels: 0.8,
                secondary_resolution_megapixels: 0.7,
                primary_upscale_factor: 1.0,
                primary_video_steps: 5,
                primary_audio_steps: 5,
                secondary_scheduler_steps: 4,
                primary_brightness: 1.0,
                primary_contrast: 0.8,
                primary_saturation: 1.0,
                secondary_brightness: 1.0,
                secondary_contrast: 0.9,
                secondary_saturation: 1.0,
                diffusion_model_name: Some(spec.diffusion_model_name.to_owned()),
                lora_name: Some(COLAB_ALLOWED_LORAS[0].to_owned()),
                lora_strength: 0.6,
                lora_bypassed: Some(false),
                secondary_lora_name: None,
                secondary_lora_strength: None,
                secondary_lora_bypassed: Some(true),
                style_loras: vec![H3StyleLora {
                    name: COLAB_ALLOWED_LORAS[1].to_owned(),
                    strength: 0.35,
                    bypassed: false,
                    apply_to_secondary: false,
                    apply_to_second_pass: Some(false),
                }],
                colab_sampler: Some(COLAB_DEFAULT_SAMPLER.to_owned()),
            },
        }],
        default_preset_id: seeded_id,
    }
}

fn load_colab_presets(
    settings: &BTreeMap<String, String>,
    profile: &str,
) -> StoredPresetCollection {
    let key = format!("infinite-canvas:colab-video-presets:{profile}:v1");
    if let Some(raw) = settings.get(&key) {
        if let Ok(collection) = serde_json::from_str::<StoredPresetCollection>(raw) {
            return collection;
        }
    }
    colab_seeded_collection(profile)
}

fn load_workflow_module_defaults(settings: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut defaults = settings
        .get(WORKFLOW_MODULE_DEFAULTS_KEY)
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(raw).ok())
        .unwrap_or_default();
    if !defaults.contains_key("video-generation:reference-to-video") {
        if let Some(legacy) = defaults.get("multi-reference-video").cloned() {
            defaults.insert("video-generation:reference-to-video".to_owned(), legacy);
        }
    }
    defaults
}

fn preset_summary_json(preset: &StoredPresetEntry, default_id: &str) -> Value {
    json!({
        "id": preset.id,
        "name": preset.name,
        "isDefault": preset.id == default_id,
        "summary": {
            "diffusionModelName": preset.settings.diffusion_model_name,
            "primaryResolutionMegapixels": preset.settings.primary_resolution_megapixels,
            "secondaryResolutionMegapixels": preset.settings.secondary_resolution_megapixels,
            "primaryVideoSteps": preset.settings.primary_video_steps,
            "primaryAudioSteps": preset.settings.primary_audio_steps,
            "secondarySchedulerSteps": preset.settings.secondary_scheduler_steps,
            "primaryUpscaleFactor": preset.settings.primary_upscale_factor,
            "loraName": preset.settings.lora_name,
            "loraStrength": preset.settings.lora_strength,
            "loraBypassed": preset.settings.lora_bypassed.unwrap_or(false),
            "styleLoraCount": preset.settings.style_loras.len(),
            "colabSampler": preset.settings.colab_sampler,
        }
    })
}

fn resolve_preset_from_collection(
    collection: &StoredPresetCollection,
    requested: Option<&str>,
) -> Result<Option<StoredPresetEntry>, String> {
    if let Some(raw_query) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(found) = collection
            .presets
            .iter()
            .find(|preset| preset.id == raw_query || preset.name.trim() == raw_query)
        {
            return Ok(Some(found.clone()));
        }
        if let Some(found) = collection.presets.iter().find(|preset| {
            preset.id.eq_ignore_ascii_case(raw_query)
                || preset.name.trim().eq_ignore_ascii_case(raw_query)
        }) {
            return Ok(Some(found.clone()));
        }
        let available = if collection.presets.is_empty() {
            "（当前通道没有已保存的预设）".to_owned()
        } else {
            collection
                .presets
                .iter()
                .map(|preset| format!("{} ({})", preset.name, preset.id))
                .collect::<Vec<_>>()
                .join("、")
        };
        return Err(format!("未找到预设“{raw_query}”。可用预设：{available}"));
    }
    Ok(collection
        .presets
        .iter()
        .find(|preset| preset.id == collection.default_preset_id)
        .cloned())
}

fn list_video_modules(state: &WebState) -> Result<Vec<WorkflowModuleRecord>, String> {
    let modules = commands::list_workflow_modules(
        state.handle.clone(),
        Some(false),
        PlatformState(&state.core),
    )?;
    Ok(modules
        .into_iter()
        .filter(|module| {
            module.manifest.deleted_at.is_none() && module.manifest.capability == "video-generation"
        })
        .collect())
}

async fn get_capabilities(State(state): State<WebState>) -> Response {
    let state = state.connection_snapshot();
    let settings = {
        let _guard = state.settings_guard.lock().await;
        read_web_settings(&state)
    };
    let local_presets = load_local_presets(&settings);
    let dasiwa_presets = load_colab_presets(&settings, "dasiwa");
    let cobijada_presets = load_colab_presets(&settings, "cobijada");
    let defaults = load_workflow_module_defaults(&settings);
    let default_ref_module_id = defaults
        .get("video-generation:reference-to-video")
        .cloned()
        .unwrap_or_default();
    let workflows = list_video_modules(&state)
        .unwrap_or_default()
        .into_iter()
        .map(|module| {
            let slot_key = format!("video-generation:{}", module.manifest.variant);
            let is_default = defaults.get(&slot_key) == Some(&module.manifest.id)
                || (module.manifest.variant == "reference-to-video"
                    && module.manifest.id == default_ref_module_id);
            json!({
                "id": module.manifest.id,
                "name": module.manifest.name,
                "variant": module.manifest.variant,
                "revision": module.manifest.revision,
                "isDefault": is_default,
                "defaultDiffusionModelName": module.manifest.defaults.diffusion_model_name,
            })
        })
        .collect::<Vec<_>>();
    let colab_status = inspect_colab_profile(&state, false).await;
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "kinds": ["h3-video"],
        "channels": {
            "local": {
                "configured": !state.config.comfy_url.trim().is_empty(),
                "inputDirectoryConfigured": !state.config.comfy_input_directory.trim().is_empty(),
                "outputDirectoryConfigured": !state.config.comfy_output_directory.trim().is_empty(),
            },
            "colab": {
                "configured": colab_status.configured,
                "reachable": colab_status.reachable,
                "available": colab_status.available,
                "effectiveProfile": colab_status.effective_profile,
                "label": colab_status.label,
                "workflowLabel": COLAB_WORKFLOW_LABEL,
                "diffusionModelName": colab_status.diffusion_model_name,
                "allowedLoras": colab_status.allowed_loras,
                "samplerOptions": colab_status.sampler_options,
                "error": colab_status.error,
            }
        },
        "workflows": workflows,
        "presets": {
            "local": {
                "defaultPresetId": local_presets.default_preset_id,
                "items": local_presets.presets.iter().map(|preset| preset_summary_json(preset, &local_presets.default_preset_id)).collect::<Vec<_>>(),
            },
            "colab": {
                "dasiwa": {
                    "defaultPresetId": dasiwa_presets.default_preset_id,
                    "items": dasiwa_presets.presets.iter().map(|preset| preset_summary_json(preset, &dasiwa_presets.default_preset_id)).collect::<Vec<_>>(),
                },
                "cobijada": {
                    "defaultPresetId": cobijada_presets.default_preset_id,
                    "items": cobijada_presets.presets.iter().map(|preset| preset_summary_json(preset, &cobijada_presets.default_preset_id)).collect::<Vec<_>>(),
                },
            }
        }
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCanvasesQuery {
    query: Option<String>,
    include_folders: Option<bool>,
}

async fn list_canvases(
    State(state): State<WebState>,
    Query(query): Query<ListCanvasesQuery>,
) -> Response {
    let state = state.connection_snapshot();
    let include_folders = query.include_folders.unwrap_or(false);
    let snapshots = if include_folders {
        match state.core.database.list_all_projects() {
            Ok(list) => list,
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    } else {
        match state.core.database.list_project_summaries() {
            Ok(list) => list,
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    };
    let mut payload = serde_json::to_value(&snapshots).unwrap_or_else(|_| Value::Array(Vec::new()));
    let _ = state.auth.ownership().annotate(&mut payload);
    let filter = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let items = payload
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|item| {
            let name = item
                .pointer("/canvas/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let id = item
                .pointer("/canvas/id")
                .and_then(Value::as_str)
                .unwrap_or("");
            filter
                .as_ref()
                .is_none_or(|needle| name.to_lowercase().contains(needle) || id.to_lowercase().contains(needle))
        })
        .map(|item| {
            let canvas = item.get("canvas").cloned().unwrap_or(Value::Null);
            let node_count = item
                .get("nodes")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let edge_count = item
                .get("edges")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            json!({
                "id": canvas.get("id").cloned().unwrap_or(Value::Null),
                "name": canvas.get("name").cloned().unwrap_or(Value::Null),
                "isShared": canvas.get("isShared").cloned().unwrap_or(json!(false)),
                "ownerUserId": canvas.get("ownerUserId").cloned().unwrap_or(Value::Null),
                "ownerUsername": canvas.get("ownerUsername").cloned().unwrap_or(Value::Null),
                "nodeCount": node_count,
                "edgeCount": edge_count,
                "createdAt": canvas.get("createdAt").cloned().unwrap_or(Value::Null),
                "updatedAt": canvas.get("updatedAt").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "ok": true, "canvases": items })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCanvasInput {
    name: String,
    #[serde(default)]
    shared: bool,
    #[serde(default)]
    request_id: Option<String>,
}

fn create_canvas_with_idempotency(
    state: &WebState,
    actor: &AgentActor,
    name: &str,
    shared: bool,
    request_id: Option<&str>,
) -> Result<(WorkspaceSnapshot, bool), (StatusCode, String)> {
    let trimmed_request_id = request_id.map(str::trim).filter(|value| !value.is_empty());
    if let Some(req_id) = trimmed_request_id {
        if let Some(existing_id) = state
            .agent_jobs
            .get_canvas_request(req_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        {
            if let Ok(existing) = state.core.database.load_project(&existing_id) {
                return Ok((existing, false));
            }
        }
    }
    let created = state
        .core
        .database
        .create_project(name)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    if let Err(error) = state
        .auth
        .ownership()
        .assign(&created.canvas.id, &actor.user_id, shared)
    {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, error));
    }
    if let Some(req_id) = trimmed_request_id {
        state
            .agent_jobs
            .record_canvas_request(req_id, &created.canvas.id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    let loaded = state
        .core
        .database
        .load_project(&created.canvas.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut val = serde_json::to_value(&loaded).unwrap_or(Value::Null);
    let _ = state.auth.ownership().annotate(&mut val);
    let snapshot = serde_json::from_value(val).unwrap_or(loaded);
    Ok((snapshot, true))
}

async fn create_canvas(
    State(state): State<WebState>,
    Json(input): Json<CreateCanvasInput>,
) -> Response {
    let state = state.connection_snapshot();
    let actor = resolve_actor(&state);
    match create_canvas_with_idempotency(
        &state,
        &actor,
        &input.name,
        input.shared,
        input.request_id.as_deref(),
    ) {
        Ok((snapshot, created)) => {
            let status = if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            let mut val = json!({ "canvas": snapshot.canvas });
            let _ = state.auth.ownership().annotate(&mut val);
            (
                status,
                Json(json!({
                    "ok": true,
                    "created": created,
                    "canvas": val.get("canvas").cloned().unwrap_or(Value::Null),
                })),
            )
                .into_response()
        }
        Err((status, message)) => api_error(status, message),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasNodesQuery {
    kind: Option<String>,
}

fn active_prompt_version(node: &NodeRecord) -> Option<&Value> {
    let active_id = node
        .content
        .get("activePromptVersionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let versions = node.content.get("promptVersions").and_then(Value::as_array)?;
    versions
        .iter()
        .find(|version| version.get("id").and_then(Value::as_str) == Some(active_id))
        .or_else(|| versions.last())
}

fn summarize_node(state: &WebState, node: &NodeRecord, edges: &[crate::models::EdgeRecord]) -> Value {
    let mut normalized = serde_json::to_value(node).unwrap_or(Value::Null);
    rpc::normalize_result(state, &mut normalized);
    let content = normalized.get("content").cloned().unwrap_or(Value::Null);
    let mut summary = json!({
        "id": node.id,
        "kind": node.kind,
        "title": node.title,
        "x": node.x,
        "y": node.y,
        "width": node.width,
        "height": node.height,
        "status": node.status,
    });
    if node.kind == "text" {
        let active_version = active_prompt_version(node);
        let text = active_version
            .and_then(|v| v.get("text").and_then(Value::as_str))
            .or_else(|| content.get("text").and_then(Value::as_str))
            .unwrap_or("");
        let info = active_version
            .and_then(|v| v.get("information").and_then(Value::as_str))
            .or_else(|| content.get("information").and_then(Value::as_str))
            .unwrap_or("");
        summary["contentType"] = content
            .get("contentType")
            .cloned()
            .unwrap_or(Value::Null);
        summary["text"] = Value::String(text.to_owned());
        summary["information"] = Value::String(info.to_owned());
        summary["activeVersionId"] = content
            .get("activePromptVersionId")
            .cloned()
            .unwrap_or(Value::Null);
        summary["activeVersionLabel"] = active_version
            .and_then(|v| v.get("label"))
            .cloned()
            .unwrap_or(Value::Null);
        summary["generationOptions"] = active_version
            .and_then(|v| v.get("generationOptions"))
            .cloned()
            .unwrap_or(Value::Null);
        summary["referenceSelection"] = active_version
            .and_then(|v| v.get("referenceSelection"))
            .cloned()
            .unwrap_or(Value::Null);
    } else if node.kind == "video-generation" {
        let incoming = edges
            .iter()
            .filter(|edge| edge.target_node_id == node.id)
            .map(|edge| edge.source_node_id.clone())
            .collect::<Vec<_>>();
        summary["workflowModuleId"] = content
            .get("workflowModuleId")
            .cloned()
            .unwrap_or(Value::Null);
        summary["generationMode"] = content
            .get("generationMode")
            .cloned()
            .unwrap_or(Value::Null);
        summary["generationChannel"] = content
            .get("generationChannel")
            .cloned()
            .unwrap_or(Value::Null);
        summary["aspectRatio"] = content
            .get("generationAspectRatio")
            .cloned()
            .unwrap_or(Value::Null);
        summary["durationSeconds"] = content
            .get("generationDuration")
            .cloned()
            .unwrap_or(Value::Null);
        summary["incomingNodeIds"] = json!(incoming);
    } else {
        summary["originalName"] = content
            .get("originalName")
            .cloned()
            .unwrap_or(Value::Null);
        summary["assetPath"] = content.get("assetPath").cloned().unwrap_or(Value::Null);
        summary["videoUrl"] = content.get("videoUrl").cloned().unwrap_or(Value::Null);
        summary["generationPlaceholder"] = content
            .get("generationPlaceholder")
            .cloned()
            .unwrap_or(Value::Bool(false));
    }
    summary
}

async fn get_canvas_nodes(
    State(state): State<WebState>,
    AxumPath(canvas_id): AxumPath<String>,
    Query(query): Query<CanvasNodesQuery>,
) -> Response {
    let state = state.connection_snapshot();
    let snapshot = match state.core.database.load_project(&canvas_id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let msg = error.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            return api_error(status, msg);
        }
    };
    let kind_filter = query
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let nodes = snapshot
        .nodes
        .iter()
        .filter(|node| kind_filter.is_none_or(|kind| node.kind == kind))
        .map(|node| summarize_node(&state, node, &snapshot.edges))
        .collect::<Vec<_>>();
    Json(json!({
        "ok": true,
        "canvas": snapshot.canvas,
        "nodes": nodes,
        "edges": snapshot.edges,
    }))
    .into_response()
}

fn sanitize_upload_filename(raw_name: &str, fallback_ext: &str) -> String {
    let mut safe: String = raw_name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    safe = safe.trim_end_matches(['.', ' ']).to_owned();
    let base = safe
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&base.as_str())
    {
        safe.insert(0, '_');
    }
    if safe.is_empty() {
        format!("upload.{fallback_ext}")
    } else {
        safe
    }
}

fn detect_media_kind(extension: &str) -> Option<&'static str> {
    match extension {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" => Some("image"),
        "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" => Some("audio"),
        "mp4" | "mov" | "webm" | "mkv" | "avi" => Some("video"),
        _ => None,
    }
}

fn place_non_overlapping(
    existing: &[NodeRecord],
    anchor_x: f64,
    anchor_y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let gap = 36.0;
    let x = (anchor_x / 16.0).round() * 16.0;
    let mut y = (anchor_y / 16.0).round() * 16.0;
    for _ in 0..80 {
        let overlaps = existing.iter().any(|other| {
            x < other.x + other.width + gap
                && x + width + gap > other.x
                && y < other.y + other.height + gap
                && y + height + gap > other.y
        });
        if !overlaps {
            return (x, y);
        }
        y += height + gap;
    }
    (x + width + gap, anchor_y)
}

async fn upload_asset(State(state): State<WebState>, mut multipart: Multipart) -> Response {
    let state = state.connection_snapshot();
    let actor = resolve_actor(&state);
    let import_dir = match storage::input_root(&state) {
        Ok(root) => root.join(IMPORT_FOLDER),
        Err(error) => return api_error(StatusCode::BAD_REQUEST, error),
    };
    if let Err(error) = std::fs::create_dir_all(&import_dir) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }

    let mut canvas_id: Option<String> = None;
    let mut create_node = false;
    let mut pos_x: Option<f64> = None;
    let mut pos_y: Option<f64> = None;
    let mut staged_file: Option<(PathBuf, String, &'static str, String)> = None;

    let parse_result: Result<(), String> = async {
        let mut total_bytes = 0usize;
        while let Some(mut field) = multipart.next_field().await.map_err(|e| e.to_string())? {
            let field_name = field.name().unwrap_or("").to_owned();
            if field_name == "file" {
                if staged_file.is_some() {
                    return Err("每次请求只能上传一个 file 字段".into());
                }
                let raw_name = field.file_name().unwrap_or("upload.bin").to_owned();
                let ext = raw_name
                    .rsplit('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let media_kind = detect_media_kind(&ext)
                    .ok_or_else(|| "不支持的参考素材格式（仅支持常见图片、音频、视频）".to_owned())?;
                let safe_name = sanitize_upload_filename(&raw_name, &ext);
                let staging_dir = state
                    .core
                    .data_dir
                    .join("uploads")
                    .join(Uuid::new_v4().to_string());
                tokio::fs::create_dir_all(&staging_dir)
                    .await
                    .map_err(|e| e.to_string())?;
                let staging_path = staging_dir.join(&safe_name);
                let mut file = tokio::fs::File::create(&staging_path)
                    .await
                    .map_err(|e| e.to_string())?;
                while let Some(chunk) = field.chunk().await.map_err(|e| e.to_string())? {
                    total_bytes += chunk.len();
                    if total_bytes > state.config.max_upload_bytes {
                        return Err("上传文件超过服务器大小限制".into());
                    }
                    file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                }
                file.flush().await.map_err(|e| e.to_string())?;
                staged_file = Some((staging_path, safe_name, media_kind, ext));
            } else {
                let text = field.text().await.map_err(|e| e.to_string())?;
                match field_name.as_str() {
                    "canvasId" => {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            canvas_id = Some(trimmed.to_owned());
                        }
                    }
                    "createNode" => {
                        create_node = matches!(
                            text.trim().to_ascii_lowercase().as_str(),
                            "true" | "1" | "yes"
                        );
                    }
                    "x" => {
                        if !text.trim().is_empty() {
                            pos_x = Some(
                                text.trim()
                                    .parse::<f64>()
                                    .map_err(|_| "无效的 x 坐标".to_owned())?,
                            );
                        }
                    }
                    "y" => {
                        if !text.trim().is_empty() {
                            pos_y = Some(
                                text.trim()
                                    .parse::<f64>()
                                    .map_err(|_| "无效的 y 坐标".to_owned())?,
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
    .await;

    if let Err(error) = parse_result {
        if let Some((path, ..)) = staged_file {
            let _ = std::fs::remove_file(&path);
            if let Some(parent) = path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        return api_error(StatusCode::BAD_REQUEST, error);
    }

    let Some((staging_path, safe_name, media_kind, ext)) = staged_file else {
        return api_error(StatusCode::BAD_REQUEST, "缺少 file 上传字段");
    };

    let cleanup_staging = |path: &Path| {
        let _ = std::fs::remove_file(path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    };

    let _guard = state.media_guard.clone().lock_owned().await;
    if create_node {
        let Some(target_canvas_id) = canvas_id else {
            cleanup_staging(&staging_path);
            return api_error(StatusCode::BAD_REQUEST, "createNode=true 时必须提供 canvasId");
        };
        let snapshot = match state.core.database.load_project(&target_canvas_id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                cleanup_staging(&staging_path);
                return api_error(StatusCode::NOT_FOUND, error.to_string());
            }
        };
        let (x, y) = match (pos_x, pos_y) {
            (Some(x), Some(y)) => (x, y),
            _ => place_non_overlapping(&snapshot.nodes, 80.0, 80.0, 360.0, 260.0),
        };
        let imported = match commands::import_media(
            staging_path.to_string_lossy().into_owned(),
            target_canvas_id.clone(),
            x,
            y,
            PlatformState(&state.core),
        )
        .await
        {
            Ok(res) => res,
            Err(error) => {
                cleanup_staging(&staging_path);
                return api_error(StatusCode::BAD_REQUEST, error);
            }
        };
        cleanup_staging(&staging_path);
        let physical_asset = imported
            .node
            .content
            .get("assetPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let mut encoded_content = imported.node.content.clone();
        storage::encode_value(&state, &mut encoded_content);
        let updated_node = match state.core.database.update_node(UpdateNodeInput {
            id: imported.node.id.clone(),
            title: None,
            content: Some(encoded_content),
            x: None,
            y: None,
            width: None,
            height: None,
            status: None,
        }) {
            Ok(node) => node,
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
        let asset_ref = storage::encode(&state, &physical_asset);
        let _ = state.media.register(
            &state.media_roots(),
            &asset_ref,
            "upload",
            &actor.user_id,
            chrono::Utc::now(),
        );
        let _ = state.handle.emit("canvas://node-created", updated_node.clone());
        return (
            StatusCode::CREATED,
            Json(json!({
                "ok": true,
                "assetRef": asset_ref,
                "mediaKind": media_kind,
                "filename": safe_name,
                "node": updated_node,
            })),
        )
            .into_response();
    }

    let destination = import_dir.join(format!("asset-{}.{ext}", Uuid::new_v4()));
    if let Err(error) = std::fs::copy(&staging_path, &destination) {
        cleanup_staging(&staging_path);
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("保存参考素材失败：{error}"),
        );
    }
    cleanup_staging(&staging_path);
    let asset_ref = storage::encode(&state, &destination.to_string_lossy());
    let _ = state.media.register(
        &state.media_roots(),
        &asset_ref,
        "upload",
        &actor.user_id,
        chrono::Utc::now(),
    );
    (
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "assetRef": asset_ref,
            "mediaKind": media_kind,
            "filename": safe_name,
        })),
    )
        .into_response()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum MediaRefInput {
    Ref(String),
    Object {
        #[serde(default, rename = "assetRef")]
        asset_ref: Option<String>,
        #[serde(default, rename = "nodeId")]
        node_id: Option<String>,
        #[serde(default)]
        role: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCanvasForJob {
    name: String,
    #[serde(default)]
    shared: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitJobInput {
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    canvas_id: Option<String>,
    #[serde(default)]
    create_canvas: Option<CreateCanvasForJob>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    source_node_id: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    information: Option<String>,
    #[serde(default)]
    create_prompt_node: Option<bool>,
    #[serde(default)]
    preset: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    workflow_module_id: Option<String>,
    #[serde(default)]
    duration_seconds: Option<f64>,
    #[serde(default)]
    aspect_ratio: Option<String>,
    #[serde(default)]
    seed_mode: Option<String>,
    #[serde(default)]
    seed: Option<String>,
    #[serde(default)]
    ref_image_size: Option<String>,
    #[serde(default)]
    strict_prompt_tags: Option<bool>,
    #[serde(default)]
    secondary_sampling_enabled: Option<bool>,
    #[serde(default)]
    colab_sampler: Option<String>,
    #[serde(default)]
    images: Vec<MediaRefInput>,
    #[serde(default)]
    audios: Vec<MediaRefInput>,
    #[serde(default)]
    videos: Vec<MediaRefInput>,
}

struct ResolvedMediaItem {
    asset_ref: String,
    node_id: Option<String>,
    role: Option<String>,
}

fn resolve_media_ref_item(
    item: &MediaRefInput,
    expected_kind: &str,
    nodes_by_id: &HashMap<&str, &NodeRecord>,
) -> Result<ResolvedMediaItem, String> {
    match item {
        MediaRefInput::Ref(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Err("参考素材引用不能为空".into());
            }
            if trimmed.starts_with("node:") {
                let node = nodes_by_id
                    .get(trimmed)
                    .ok_or_else(|| format!("画布中找不到参考素材节点：{trimmed}"))?;
                return resolve_node_media(node, expected_kind, None);
            }
            Ok(ResolvedMediaItem {
                asset_ref: trimmed.to_owned(),
                node_id: None,
                role: None,
            })
        }
        MediaRefInput::Object {
            asset_ref,
            node_id,
            role,
        } => {
            if let Some(node_id) = node_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let node = nodes_by_id
                    .get(node_id)
                    .ok_or_else(|| format!("画布中找不到参考素材节点：{node_id}"))?;
                return resolve_node_media(node, expected_kind, role.clone());
            }
            if let Some(asset_ref) = asset_ref.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                return Ok(ResolvedMediaItem {
                    asset_ref: asset_ref.to_owned(),
                    node_id: None,
                    role: role.clone(),
                });
            }
            Err("参考素材项必须提供 assetRef 或 nodeId".into())
        }
    }
}

fn node_media_kind(node: &NodeRecord) -> Option<&'static str> {
    match node.kind.as_str() {
        "image" | "generated-image" => Some("image"),
        "audio" => Some("audio"),
        "video" | "generated-video" => Some("video"),
        _ => None,
    }
}

fn resolve_node_media(
    node: &NodeRecord,
    expected_kind: &str,
    role: Option<String>,
) -> Result<ResolvedMediaItem, String> {
    let actual = node_media_kind(node)
        .ok_or_else(|| format!("节点 {}（{}）不是媒体素材节点", node.id, node.kind))?;
    if actual != expected_kind {
        return Err(format!(
            "节点 {} 类型为 {}，期望为 {}",
            node.id, actual, expected_kind
        ));
    }
    let asset_path = node
        .content
        .get("assetPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("节点 {} 缺少有效的 assetPath", node.id))?;
    Ok(ResolvedMediaItem {
        asset_ref: asset_path.to_owned(),
        node_id: Some(node.id.clone()),
        role,
    })
}

fn resolve_physical_asset_path(state: &WebState, asset_ref: &str) -> Result<String, String> {
    let trimmed = asset_ref.trim();
    if trimmed.is_empty() {
        return Err("素材路径不能为空".into());
    }
    let resolved = if trimmed.starts_with("sucanvas://")
        || trimmed.starts_with("sucanvas-input://")
        || trimmed.starts_with("sucanvas-output://")
    {
        storage::resource_path(state, trimmed)?
    } else {
        PathBuf::from(trimmed)
    };
    let mut roots = vec![
        state.core.data_dir.join("assets"),
        state.core.data_dir.join("uploads"),
        state.core.data_dir.join("temp"),
        state
            .core
            .data_dir
            .join(crate::colab_channel::COLAB_OUTPUTS_DIR),
    ];
    if !state.config.comfy_input_directory.trim().is_empty() {
        let input_dir = PathBuf::from(&state.config.comfy_input_directory);
        roots.push(input_dir.join(IMPORT_FOLDER));
        roots.push(input_dir);
    }
    if !state.config.comfy_output_directory.trim().is_empty() {
        roots.push(PathBuf::from(&state.config.comfy_output_directory));
    }
    ensure_contained(&resolved, &roots)?;
    if !resolved.is_file() {
        return Err(format!("素材文件不存在：{}", resolved.display()));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

fn video_aspect_ratio_numeric(label: &str) -> f64 {
    match label {
        "9:16" => 9.0 / 16.0,
        "4:3" => 4.0 / 3.0,
        "3:4" => 3.0 / 4.0,
        "3:2" => 3.0 / 2.0,
        "2:3" => 2.0 / 3.0,
        "1:1" => 1.0,
        _ => 16.0 / 9.0,
    }
}

fn preview_dimensions_for_aspect_ratio(label: &str) -> (f64, f64) {
    let ratio = video_aspect_ratio_numeric(label);
    let width = if ratio < 1.0 {
        GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH
    } else {
        GENERATED_VIDEO_PREVIEW_WIDTH
    };
    let height = (width / ratio + GENERATED_VIDEO_FOOTER_HEIGHT).clamp(180.0, 2400.0);
    (width, height)
}

fn normalize_output_url(state: &WebState, output: &ComfyOutputFile) -> String {
    let mut value = Value::String(output.url.clone());
    rpc::normalize_result(state, &mut value);
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| output.url.clone())
}

fn normalize_output_asset_path(output_value: &Value) -> Option<String> {
    output_value
        .get("assetPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn build_video_generation_snapshot(
    prompt: &str,
    prompt_info: &str,
    prompt_node_id: &str,
    prompt_node_title: &str,
    prompt_version_id: &str,
    prompt_version_label: &str,
    preset_name: &str,
    submit_input: &ComfySubmitInput,
    workflow_module_revision: &str,
    channel: &str,
    image_refs: &[String],
    audio_refs: &[String],
    video_refs: &[String],
) -> Value {
    let mut map = Map::new();
    map.insert("presetName".into(), json!(preset_name));
    map.insert("prompt".into(), json!(prompt));
    map.insert("promptInformation".into(), json!(prompt_info));
    map.insert("promptNodeId".into(), json!(prompt_node_id));
    map.insert("promptNodeTitle".into(), json!(prompt_node_title));
    map.insert(
        "promptNodeIdSource".into(),
        json!(if prompt_node_id.is_empty() { "" } else { "captured" }),
    );
    map.insert("promptVersionId".into(), json!(prompt_version_id));
    map.insert("promptVersionLabel".into(), json!(prompt_version_label));
    map.insert("durationSeconds".into(), json!(submit_input.duration_seconds));
    map.insert("aspectRatio".into(), json!(submit_input.aspect_ratio));
    map.insert(
        "primaryResolutionMegapixels".into(),
        json!(submit_input.primary_resolution_megapixels),
    );
    map.insert(
        "secondaryResolutionMegapixels".into(),
        json!(submit_input.secondary_resolution_megapixels),
    );
    map.insert("primaryVideoSteps".into(), json!(submit_input.primary_video_steps));
    map.insert("primaryAudioSteps".into(), json!(submit_input.primary_audio_steps));
    map.insert(
        "secondarySchedulerSteps".into(),
        json!(submit_input.secondary_scheduler_steps),
    );
    map.insert(
        "primaryUpscaleFactor".into(),
        json!(submit_input.primary_upscale_factor),
    );
    map.insert("primaryBrightness".into(), json!(submit_input.primary_brightness));
    map.insert("primaryContrast".into(), json!(submit_input.primary_contrast));
    map.insert("primarySaturation".into(), json!(submit_input.primary_saturation));
    map.insert(
        "secondaryBrightness".into(),
        json!(submit_input.secondary_brightness),
    );
    map.insert("secondaryContrast".into(), json!(submit_input.secondary_contrast));
    map.insert(
        "secondarySaturation".into(),
        json!(submit_input.secondary_saturation),
    );
    map.insert("diffusionModelName".into(), json!(submit_input.diffusion_model_name));
    map.insert("loraName".into(), json!(submit_input.lora_name));
    map.insert("loraStrength".into(), json!(submit_input.lora_strength));
    map.insert("loraStrengthRecorded".into(), json!(true));
    map.insert("loraBypassed".into(), json!(submit_input.lora_bypassed));
    map.insert(
        "secondaryLoraName".into(),
        json!(submit_input.secondary_lora_name.clone().unwrap_or_default()),
    );
    map.insert(
        "secondaryLoraStrength".into(),
        json!(submit_input.secondary_lora_strength.unwrap_or(1.0)),
    );
    map.insert("secondaryLoraStrengthRecorded".into(), json!(true));
    map.insert(
        "secondaryLoraBypassed".into(),
        json!(submit_input.secondary_lora_bypassed.unwrap_or(true)),
    );
    map.insert(
        "styleLoras".into(),
        json!(submit_input.style_loras.clone().unwrap_or_default()),
    );
    map.insert(
        "styleLoraName".into(),
        json!(submit_input.style_lora_name.clone().unwrap_or_default()),
    );
    map.insert(
        "styleLoraStrength".into(),
        json!(submit_input.style_lora_strength.unwrap_or(1.0)),
    );
    map.insert("styleLoraStrengthRecorded".into(), json!(true));
    map.insert(
        "styleLoraBypassed".into(),
        json!(submit_input.style_lora_bypassed.unwrap_or(true)),
    );
    map.insert(
        "styleLoraApplyToSecondary".into(),
        json!(submit_input.style_lora_apply_to_secondary.unwrap_or(false)),
    );
    map.insert("refImageSize".into(), json!(submit_input.ref_image_size));
    map.insert("refImageSizeRecorded".into(), json!(true));
    map.insert(
        "strictPromptTags".into(),
        json!(submit_input.strict_prompt_tags.unwrap_or(true)),
    );
    map.insert("imagePaths".into(), json!(image_refs));
    map.insert("imageRoles".into(), json!(submit_input.image_roles));
    map.insert("audioPaths".into(), json!(audio_refs));
    map.insert("videoPaths".into(), json!(video_refs));
    map.insert(
        "workflowModuleId".into(),
        json!(submit_input.workflow_module_id.clone().unwrap_or_default()),
    );
    map.insert("workflowModuleRevision".into(), json!(workflow_module_revision));
    map.insert("channel".into(), json!(channel));
    if channel == "colab" {
        map.insert("colabSampler".into(), json!(submit_input.colab_sampler));
    }
    Value::Object(map)
}

fn job_response_json(job: &AgentJobRecord) -> Value {
    let outputs = job
        .outputs
        .iter()
        .enumerate()
        .map(|(index, output)| {
            let mut item = output.clone();
            if let Some(obj) = item.as_object_mut() {
                obj.insert(
                    "downloadUrl".to_owned(),
                    json!(format!("/v1/agent/jobs/{}/outputs/{index}", job.id)),
                );
            }
            item
        })
        .collect::<Vec<_>>();
    let prompt_node_id = job
        .snapshot
        .get("promptNodeId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    json!({
        "jobId": job.id,
        "requestId": job.request_id,
        "kind": job.kind,
        "canvasId": job.canvas_id,
        "channel": job.channel,
        "entryMode": job.entry_mode,
        "presetName": job.preset_name,
        "status": job.status,
        "clientId": job.client_id,
        "promptId": job.prompt_id,
        "promptNodeId": prompt_node_id,
        "sourceNodeId": job.source_node_id,
        "generatorNodeId": job.generator_node_id,
        "placeholderNodeId": job.placeholder_node_id,
        "outputNodeIds": job.output_node_ids,
        "outputs": outputs,
        "seed": job.seed,
        "executionElapsedSeconds": job.execution_elapsed_seconds,
        "error": job.error,
        "pollUrl": format!("/v1/agent/jobs/{}", job.id),
        "cancelUrl": format!("/v1/agent/jobs/{}/cancel", job.id),
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
    })
}

fn apply_preset_to_submit(
    preset: &StoredPresetSettings,
    channel: &str,
    submit_input: &mut ComfySubmitInput,
) {
    submit_input.primary_resolution_megapixels = preset.primary_resolution_megapixels;
    submit_input.secondary_resolution_megapixels = preset.secondary_resolution_megapixels;
    submit_input.primary_upscale_factor = if channel == "colab" {
        1.0
    } else {
        preset.primary_upscale_factor
    };
    submit_input.primary_video_steps = preset.primary_video_steps;
    submit_input.primary_audio_steps = if channel == "colab" {
        preset.primary_video_steps
    } else {
        preset.primary_audio_steps.max(preset.primary_video_steps)
    };
    submit_input.secondary_scheduler_steps = preset.secondary_scheduler_steps;
    submit_input.primary_brightness = preset.primary_brightness;
    submit_input.primary_contrast = preset.primary_contrast;
    submit_input.primary_saturation = preset.primary_saturation;
    submit_input.secondary_brightness = preset.secondary_brightness;
    submit_input.secondary_contrast = preset.secondary_contrast;
    submit_input.secondary_saturation = preset.secondary_saturation;
    if let Some(model) = preset
        .diffusion_model_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        submit_input.diffusion_model_name = model.to_owned();
    }
    if let Some(lora) = preset.lora_name.as_deref() {
        submit_input.lora_name = lora.trim().to_owned();
    }
    submit_input.lora_strength = preset.lora_strength;
    if let Some(bypassed) = preset.lora_bypassed {
        submit_input.lora_bypassed = bypassed;
    }
    if channel != "colab" {
        if let Some(sec_lora) = preset.secondary_lora_name.as_deref() {
            submit_input.secondary_lora_name = Some(sec_lora.trim().to_owned());
        }
        if let Some(sec_strength) = preset.secondary_lora_strength {
            submit_input.secondary_lora_strength = Some(sec_strength);
        }
        if let Some(sec_bypassed) = preset.secondary_lora_bypassed {
            submit_input.secondary_lora_bypassed = Some(sec_bypassed);
        }
    }
    submit_input.style_loras = Some(preset.style_loras.clone());
    if channel == "colab" {
        if let Some(sampler) = preset.colab_sampler.as_deref() {
            if let Ok(normalized) = normalize_colab_sampler(Some(sampler)) {
                submit_input.colab_sampler = Some(normalized);
            }
        }
    }
}

fn apply_node_content_to_submit(
    content: &Value,
    channel: &str,
    submit_input: &mut ComfySubmitInput,
) {
    let get_f64 = |key: &str| content.get(key).and_then(Value::as_f64);
    let get_u32 = |key: &str| {
        content
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
    };
    let get_str = |key: &str| {
        content
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let get_bool = |key: &str| content.get(key).and_then(Value::as_bool);

    if let Some(aspect) = get_str("generationAspectRatio") {
        submit_input.aspect_ratio = aspect;
    }
    if let Some(duration) = get_f64("generationDuration") {
        submit_input.duration_seconds = duration;
    }
    if let Some(res) = get_f64("generationPrimaryResolution") {
        submit_input.primary_resolution_megapixels = res;
    }
    if let Some(res) = get_f64("generationSecondaryResolution") {
        submit_input.secondary_resolution_megapixels = res;
    }
    if let Some(steps) = get_u32("generationPrimaryVideoSteps") {
        submit_input.primary_video_steps = steps;
    }
    if let Some(steps) = get_u32("generationPrimaryAudioSteps") {
        submit_input.primary_audio_steps = steps;
    }
    if let Some(steps) = get_u32("generationSecondarySchedulerSteps") {
        submit_input.secondary_scheduler_steps = steps;
    }
    if let Some(upscale) = get_f64("generationPrimaryUpscaleFactor") {
        submit_input.primary_upscale_factor = upscale;
    }
    if let Some(v) = get_f64("generationPrimaryBrightness") {
        submit_input.primary_brightness = v;
    }
    if let Some(v) = get_f64("generationPrimaryContrast") {
        submit_input.primary_contrast = v;
    }
    if let Some(v) = get_f64("generationPrimarySaturation") {
        submit_input.primary_saturation = v;
    }
    if let Some(v) = get_f64("generationSecondaryBrightness") {
        submit_input.secondary_brightness = v;
    }
    if let Some(v) = get_f64("generationSecondaryContrast") {
        submit_input.secondary_contrast = v;
    }
    if let Some(v) = get_f64("generationSecondarySaturation") {
        submit_input.secondary_saturation = v;
    }
    if let Some(model) = get_str("generationDiffusionModelOverride").or_else(|| get_str("generationDiffusionModelName")) {
        submit_input.diffusion_model_name = model;
    }
    if let Some(lora) = get_str("generationLoraName") {
        submit_input.lora_name = lora;
    }
    if let Some(strength) = get_f64("generationLoraStrength") {
        submit_input.lora_strength = strength;
    }
    if let Some(bypassed) = get_bool("generationLoraBypassed") {
        submit_input.lora_bypassed = bypassed;
    }
    if let Some(lora) = get_str("generationSecondaryLoraName") {
        submit_input.secondary_lora_name = Some(lora);
    }
    if let Some(strength) = get_f64("generationSecondaryLoraStrength") {
        submit_input.secondary_lora_strength = Some(strength);
    }
    if let Some(bypassed) = get_bool("generationSecondaryLoraBypassed") {
        submit_input.secondary_lora_bypassed = Some(bypassed);
    }
    if let Some(styles) = content
        .get("generationStyleLoras")
        .and_then(|v| serde_json::from_value::<Vec<H3StyleLora>>(v.clone()).ok())
    {
        submit_input.style_loras = Some(styles);
    }
    if let Some(ref_size) = get_str("generationRefImageSize") {
        submit_input.ref_image_size = ref_size;
    }
    if let Some(strict) = get_bool("generationStrictPromptTags") {
        submit_input.strict_prompt_tags = Some(strict);
    }
    if let Some(seed_mode) = get_str("seedMode") {
        submit_input.seed_mode = seed_mode;
    }
    if let Some(seed) = get_str("generationSeed") {
        submit_input.seed = seed;
    }
    if channel == "colab" {
        if let Some(sampler) = get_str("generationColabSampler") {
            if let Ok(normalized) = normalize_colab_sampler(Some(&sampler)) {
                submit_input.colab_sampler = Some(normalized);
            }
        }
    }
}

fn default_submit_input(server_url: &str, client_id: &str) -> ComfySubmitInput {
    ComfySubmitInput {
        server_url: server_url.to_owned(),
        workflow_module_id: None,
        workflow_path: String::new(),
        input_root_path: String::new(),
        client_id: client_id.to_owned(),
        prompt: String::new(),
        seed_mode: "random".to_owned(),
        seed: String::new(),
        duration_seconds: 5.0,
        aspect_ratio: "16:9".to_owned(),
        primary_resolution_megapixels: 0.3,
        secondary_resolution_megapixels: 0.7,
        primary_video_steps: 6,
        primary_audio_steps: 8,
        secondary_scheduler_steps: 4,
        primary_upscale_factor: 1.0,
        primary_brightness: 1.0,
        primary_contrast: 0.9,
        primary_saturation: 0.9,
        secondary_brightness: 1.0,
        secondary_contrast: 0.9,
        secondary_saturation: 1.0,
        secondary_sampling_enabled: false,
        diffusion_model_name: DEFAULT_H3_DIFFUSION_MODEL_NAME.to_owned(),
        lora_name: String::new(),
        lora_strength: 1.0,
        lora_bypassed: true,
        secondary_lora_name: None,
        secondary_lora_strength: None,
        secondary_lora_bypassed: Some(true),
        style_loras: Some(Vec::new()),
        style_lora_name: None,
        style_lora_strength: None,
        style_lora_bypassed: Some(true),
        style_lora_apply_to_secondary: Some(false),
        ref_image_size: "match".to_owned(),
        strict_prompt_tags: Some(true),
        image_paths: Vec::new(),
        image_roles: Vec::new(),
        audio_paths: Vec::new(),
        video_paths: Vec::new(),
        secondary_source: None,
        secondary_source_path: None,
        colab_mode: false,
        colab_profile: String::new(),
        colab_sampler: None,
        ss_password: String::new(),
        ss_compress: None,
    }
}

fn build_generator_content(
    submit_input: &ComfySubmitInput,
    channel: &str,
    mode: &str,
    workflow_module_revision: &str,
) -> Value {
    let mut map = Map::new();
    map.insert("provider".into(), json!(""));
    map.insert("model".into(), json!(""));
    map.insert("status".into(), json!("idle"));
    map.insert(
        "secondarySamplingEnabled".into(),
        json!(submit_input.secondary_sampling_enabled),
    );
    map.insert("generationMode".into(), json!(mode));
    map.insert("generationChannel".into(), json!(channel));
    map.insert(
        "workflowModuleId".into(),
        json!(submit_input.workflow_module_id.clone().unwrap_or_default()),
    );
    map.insert("workflowModuleRevision".into(), json!(workflow_module_revision));
    map.insert(
        "generationDiffusionModelName".into(),
        json!(submit_input.diffusion_model_name),
    );
    map.insert(
        "generationDiffusionModelOverride".into(),
        json!(submit_input.diffusion_model_name),
    );
    map.insert("generationDuration".into(), json!(submit_input.duration_seconds));
    map.insert("generationAspectRatio".into(), json!(submit_input.aspect_ratio));
    map.insert(
        "generationPrimaryResolution".into(),
        json!(submit_input.primary_resolution_megapixels),
    );
    map.insert(
        "generationSecondaryResolution".into(),
        json!(submit_input.secondary_resolution_megapixels),
    );
    map.insert(
        "generationPrimaryVideoSteps".into(),
        json!(submit_input.primary_video_steps),
    );
    map.insert(
        "generationPrimaryAudioSteps".into(),
        json!(submit_input.primary_audio_steps),
    );
    map.insert(
        "generationSecondarySchedulerSteps".into(),
        json!(submit_input.secondary_scheduler_steps),
    );
    map.insert(
        "generationPrimaryUpscaleFactor".into(),
        json!(submit_input.primary_upscale_factor),
    );
    map.insert(
        "generationPrimaryBrightness".into(),
        json!(submit_input.primary_brightness),
    );
    map.insert(
        "generationPrimaryContrast".into(),
        json!(submit_input.primary_contrast),
    );
    map.insert(
        "generationPrimarySaturation".into(),
        json!(submit_input.primary_saturation),
    );
    map.insert(
        "generationSecondaryBrightness".into(),
        json!(submit_input.secondary_brightness),
    );
    map.insert(
        "generationSecondaryContrast".into(),
        json!(submit_input.secondary_contrast),
    );
    map.insert(
        "generationSecondarySaturation".into(),
        json!(submit_input.secondary_saturation),
    );
    map.insert("generationLoraName".into(), json!(submit_input.lora_name));
    map.insert("generationLoraStrength".into(), json!(submit_input.lora_strength));
    map.insert("generationLoraBypassed".into(), json!(submit_input.lora_bypassed));
    map.insert(
        "generationSecondaryLoraName".into(),
        json!(submit_input.secondary_lora_name.clone().unwrap_or_default()),
    );
    map.insert(
        "generationSecondaryLoraStrength".into(),
        json!(submit_input.secondary_lora_strength.unwrap_or(1.0)),
    );
    map.insert(
        "generationSecondaryLoraBypassed".into(),
        json!(submit_input.secondary_lora_bypassed.unwrap_or(true)),
    );
    map.insert(
        "generationStyleLoras".into(),
        json!(submit_input.style_loras.clone().unwrap_or_default()),
    );
    map.insert("seedMode".into(), json!(submit_input.seed_mode));
    map.insert("generationSeed".into(), json!(submit_input.seed));
    map.insert(
        "generationStrictPromptTags".into(),
        json!(submit_input.strict_prompt_tags.unwrap_or(true)),
    );
    map.insert("generationRefImageSize".into(), json!(submit_input.ref_image_size));
    map.insert(
        "generationColabSampler".into(),
        json!(
            submit_input
                .colab_sampler
                .clone()
                .unwrap_or_else(|| COLAB_DEFAULT_SAMPLER.to_owned())
        ),
    );
    map.insert("manualHeight".into(), json!(VIDEO_GENERATION_NODE_HEIGHT));
    map.insert("layoutTextInputCount".into(), json!(1));
    Value::Object(map)
}

fn finalize_placeholder_to_outputs(
    state: &WebState,
    job: &mut AgentJobRecord,
    prompt_id: &str,
    seed: &str,
    elapsed: Option<f64>,
    raw_outputs: Vec<Value>,
) -> Result<(), String> {
    if raw_outputs.is_empty() {
        return Err("ComfyUI 没有返回视频输出".into());
    }
    let snapshot_val = job.snapshot.clone();
    let aspect_label = snapshot_val
        .get("aspectRatio")
        .and_then(Value::as_str)
        .unwrap_or("16:9");
    let aspect_numeric = video_aspect_ratio_numeric(aspect_label);
    let server_url_display = if job.channel == "colab" {
        format!("{}/api/comfy-colab", state.config.origin())
    } else {
        format!("{}/api/comfy", state.config.origin())
    };
    let generator_id = job.generator_node_id.clone().unwrap_or_default();
    let total = raw_outputs.len();
    let mut output_node_ids = Vec::with_capacity(total);
    let mut normalized_outputs = Vec::with_capacity(total);

    let canvas_snapshot = state
        .core
        .database
        .load_project(&job.canvas_id)
        .map_err(|e| e.to_string())?;
    let mut existing_nodes = canvas_snapshot.nodes;

    for (index, mut output_val) in raw_outputs.into_iter().enumerate() {
        let output_file: ComfyOutputFile = serde_json::from_value(output_val.clone())
            .map_err(|e| format!("解析输出视频元信息失败：{e}"))?;
        let video_url = normalize_output_url(state, &output_file);
        let asset_path = normalize_output_asset_path(&output_val);
        if let Some(obj) = output_val.as_object_mut() {
            obj.insert("url".to_owned(), json!(video_url));
        }
        normalized_outputs.push(output_val);

        let title = if total > 1 {
            format!("视频预览 {}", index + 1)
        } else {
            "视频预览".to_owned()
        };
        let mut content = Map::new();
        content.insert("videoUrl".to_owned(), json!(video_url));
        if let Some(ref ap) = asset_path {
            content.insert("assetPath".to_owned(), json!(ap));
        }
        content.insert("originalName".to_owned(), json!(output_file.filename));
        content.insert("filename".to_owned(), json!(output_file.filename));
        content.insert("subfolder".to_owned(), json!(output_file.subfolder));
        content.insert("fileType".to_owned(), json!(output_file.file_type));
        content.insert("seed".to_owned(), json!(seed));
        content.insert("comfyPromptId".to_owned(), json!(prompt_id));
        content.insert("comfyServerUrl".to_owned(), json!(server_url_display));
        if job.channel == "colab" {
            content.insert("comfyChannel".to_owned(), json!("colab"));
        }
        content.insert("sourceGeneratorId".to_owned(), json!(generator_id));
        content.insert("outputIndex".to_owned(), json!(index));
        content.insert("aspectRatio".to_owned(), json!(aspect_numeric));
        content.insert("generationSnapshot".to_owned(), snapshot_val.clone());
        content.insert("hasBeenPlayed".to_owned(), json!(false));
        if let Some(sec) = elapsed {
            content.insert("generationElapsedSeconds".to_owned(), json!(sec));
        }

        if index == 0 {
            if let Some(placeholder_id) = job.placeholder_node_id.as_deref() {
                if let Ok(updated) = state.core.database.update_node(UpdateNodeInput {
                    id: placeholder_id.to_owned(),
                    title: Some(title.clone()),
                    content: Some(Value::Object(content.clone())),
                    x: None,
                    y: None,
                    width: None,
                    height: None,
                    status: Some("ready".to_owned()),
                }) {
                    output_node_ids.push(updated.id.clone());
                    let _ = state.handle.emit("canvas://node-updated", updated);
                    continue;
                }
            }
        }

        let (width, height) = preview_dimensions_for_aspect_ratio(aspect_label);
        let anchor = existing_nodes
            .iter()
            .find(|n| Some(n.id.as_str()) == job.placeholder_node_id.as_deref())
            .or_else(|| {
                existing_nodes
                    .iter()
                    .find(|n| n.id == generator_id)
            });
        let (ax, ay) = anchor
            .map(|n| (n.x, n.y + n.height + 36.0))
            .unwrap_or((80.0, 80.0));
        let (x, y) = place_non_overlapping(&existing_nodes, ax, ay, width, height);
        let created = state
            .core
            .database
            .create_node(CreateNodeInput {
                canvas_id: Some(job.canvas_id.clone()),
                kind: Some("generated-video".to_owned()),
                title,
                content: Value::Object(content),
                source: Some("comfyui".to_owned()),
                request_id: Some(format!("agent-preview:{}:{index}", job.id)),
                x: Some(x),
                y: Some(y),
                width: Some(width),
                height: Some(height),
            })
            .map_err(|e| e.to_string())?;
        existing_nodes.push(created.node.clone());
        output_node_ids.push(created.node.id.clone());
        if created.created {
            let _ = state.handle.emit("canvas://node-created", created.node.clone());
            if !generator_id.is_empty() {
                if let Ok(edge) = state.core.database.create_edge(CreateEdgeInput {
                    canvas_id: Some(job.canvas_id.clone()),
                    source_node_id: generator_id.clone(),
                    target_node_id: created.node.id.clone(),
                    kind: Some("output".to_owned()),
                    metadata: json!({
                        "clientId": job.client_id,
                        "promptId": prompt_id,
                        "outputIndex": index,
                    }),
                }) {
                    let _ = state.handle.emit("canvas://edge-created", edge);
                }
            }
        }
    }

    job.status = "succeeded".to_owned();
    job.prompt_id = Some(prompt_id.to_owned());
    job.seed = Some(seed.to_owned());
    job.execution_elapsed_seconds = elapsed;
    job.output_node_ids = output_node_ids;
    job.outputs = normalized_outputs;
    job.error = None;
    job.updated_at = now_rfc3339();
    state.agent_jobs.update_status(job)?;
    Ok(())
}

fn mark_placeholder_failed(
    state: &WebState,
    job: &mut AgentJobRecord,
    cancelled: bool,
    message: &str,
) {
    let status_text = if cancelled { "cancelled" } else { "invalid" };
    if let Some(placeholder_id) = job.placeholder_node_id.as_deref() {
        if let Ok(snapshot) = state.core.database.load_project(&job.canvas_id) {
            if let Some(node) = snapshot.nodes.into_iter().find(|n| n.id == placeholder_id) {
                let mut content = node.content.as_object().cloned().unwrap_or_default();
                content.insert("status".to_owned(), json!(status_text));
                content.insert("executionProgress".to_owned(), Value::Null);
                content.insert("validationMessage".to_owned(), json!(message));
                if let Ok(updated) = state.core.database.update_node(UpdateNodeInput {
                    id: placeholder_id.to_owned(),
                    title: None,
                    content: Some(Value::Object(content)),
                    x: None,
                    y: None,
                    width: None,
                    height: None,
                    status: None,
                }) {
                    let _ = state.handle.emit("canvas://node-updated", updated);
                }
            }
        }
    }
    job.status = if cancelled {
        "cancelled".to_owned()
    } else {
        "failed".to_owned()
    };
    job.error = Some(message.to_owned());
    job.updated_at = now_rfc3339();
    let _ = state.agent_jobs.update_status(job);
}

async fn submit_job(State(state): State<WebState>, Json(input): Json<SubmitJobInput>) -> Response {
    let state = state.connection_snapshot();
    let actor = resolve_actor(&state);

    let kind = input
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("h3-video");
    if kind != "h3-video" {
        return api_error(
            StatusCode::BAD_REQUEST,
            format!("当前仅支持 h3-video 生成类型，收到：{kind}"),
        );
    }

    let request_id = input
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("agent-req:{}", Uuid::new_v4()));

    match state.agent_jobs.get_by_request_id(&request_id) {
        Ok(Some(existing)) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "deduplicated": true,
                    "job": job_response_json(&existing),
                })),
            )
                .into_response();
        }
        Ok(None) => {}
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }

    if input.canvas_id.is_some() && input.create_canvas.is_some() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "canvasId 与 createCanvas 不能同时传入",
        );
    }
    if input.canvas_id.is_none() && input.create_canvas.is_none() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "必须指定已有 canvasId 或传 createCanvas 新建画布",
        );
    }

    let channel = input
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("local")
        .to_ascii_lowercase();
    if channel != "local" && channel != "colab" {
        return api_error(StatusCode::BAD_REQUEST, "channel 必须是 local 或 colab");
    }

    let entry_mode = match input
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some("standalone") => "standalone",
        Some("node") => "node",
        Some(other) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                format!("无效的 mode：{other}（应为 standalone 或 node）"),
            )
        }
        None => {
            if input
                .source_node_id
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                "node"
            } else {
                "standalone"
            }
        }
    };

    if entry_mode == "node" && input.create_canvas.is_some() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "mode=node 必须配合已有画布 canvasId 使用",
        );
    }

    // Check channel readiness and resolve presets before mutating the canvas.
    let settings = {
        let _guard = state.settings_guard.lock().await;
        read_web_settings(&state)
    };
    let workflow_defaults = load_workflow_module_defaults(&settings);

    let (target_server_url, colab_profile_id, colab_diffusion_model) = if channel == "colab" {
        let profile = inspect_colab_profile(&state, false).await;
        if !profile.configured {
            return api_error(
                StatusCode::BAD_REQUEST,
                "管理员尚未配置 Colab ComfyUI 服务地址",
            );
        }
        if !profile.reachable {
            return api_error(
                StatusCode::BAD_REQUEST,
                profile
                    .error
                    .unwrap_or_else(|| "Colab 实例当前未运行或无法连接".to_owned()),
            );
        }
        let Some(effective_profile) = profile.effective_profile else {
            return api_error(
                StatusCode::BAD_REQUEST,
                profile
                    .error
                    .unwrap_or_else(|| "未能识别当前 Colab 档位".to_owned()),
            );
        };
        (
            state.config.colab_comfy_url.clone(),
            Some(effective_profile),
            Some(profile.diffusion_model_name),
        )
    } else {
        if state.config.comfy_url.trim().is_empty() {
            return api_error(
                StatusCode::BAD_REQUEST,
                "请先在基础设置中配置本地 ComfyUI 服务地址",
            );
        }
        (state.config.comfy_url.clone(), None, None)
    };

    let preset_collection = if channel == "colab" {
        load_colab_presets(&settings, colab_profile_id.as_deref().unwrap_or("dasiwa"))
    } else {
        load_local_presets(&settings)
    };
    let resolved_preset = match resolve_preset_from_collection(
        &preset_collection,
        input.preset.as_deref(),
    ) {
        Ok(found) => found,
        Err(message) => return api_error(StatusCode::BAD_REQUEST, message),
    };

    let video_modules = match list_video_modules(&state) {
        Ok(list) => list,
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    if channel == "local" && video_modules.is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "当前没有可用的本地视频生成工作流模块，请先在工作流管理中安装或配置 H3 模块",
        );
    }

    // Resolve or create canvas.
    let (mut canvas_snapshot, canvas_created) = if let Some(cid) = input
        .canvas_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        match state.core.database.load_project(cid) {
            Ok(snapshot) => (snapshot, false),
            Err(error) => {
                let msg = error.to_string();
                let status = if msg.contains("not found") {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
                return api_error(status, msg);
            }
        }
    } else if let Some(create_req) = &input.create_canvas {
        match create_canvas_with_idempotency(
            &state,
            &actor,
            &create_req.name,
            create_req.shared,
            Some(&format!("job-canvas:{request_id}")),
        ) {
            Ok(res) => res,
            Err((status, msg)) => return api_error(status, msg),
        }
    } else {
        return api_error(StatusCode::BAD_REQUEST, "缺少目标画布");
    };

    let client_id = Uuid::new_v4().to_string();
    let mut submit_input = default_submit_input(&target_server_url, &client_id);
    if channel == "colab" {
        submit_input.colab_mode = true;
        submit_input.colab_profile = colab_profile_id.clone().unwrap_or_default();
        submit_input.diffusion_model_name = colab_diffusion_model.unwrap_or_default();
        submit_input.ss_password = state.config.colab_ss_password.clone();
        submit_input.secondary_sampling_enabled = false;
    }

    let mut prompt_text = input
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_default();
    let mut prompt_info = input.information.clone().unwrap_or_default();
    let mut prompt_node_id = String::new();
    let mut prompt_node_title = String::new();
    let mut prompt_version_id = String::new();
    let mut prompt_version_label = String::new();
    let mut generator_node_id = String::new();
    let mut source_node_record: Option<NodeRecord> = None;
    let mut preset_name = resolved_preset
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "默认参数".to_owned());

    let mut collected_images: Vec<ResolvedMediaItem> = Vec::new();
    let mut collected_audios: Vec<ResolvedMediaItem> = Vec::new();
    let mut collected_videos: Vec<ResolvedMediaItem> = Vec::new();
    let mut detected_duration: Option<f64> = None;
    let mut generator_mode = "reference-to-video".to_owned();
    let mut explicit_module_id = input
        .workflow_module_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    if entry_mode == "node" {
        let Some(src_id) = input
            .source_node_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return api_error(StatusCode::BAD_REQUEST, "mode=node 时必须提供 sourceNodeId");
        };
        let Some(src_node) = canvas_snapshot
            .nodes
            .iter()
            .find(|node| node.id == src_id)
            .cloned()
        else {
            return api_error(
                StatusCode::NOT_FOUND,
                format!("画布 {} 中找不到节点：{src_id}", canvas_snapshot.canvas.id),
            );
        };
        source_node_record = Some(src_node.clone());
        let nodes_by_id: HashMap<&str, &NodeRecord> = canvas_snapshot
            .nodes
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();

        if src_node.kind == "text" {
            let active_ver = active_prompt_version(&src_node);
            if prompt_text.is_empty() {
                prompt_text = active_ver
                    .and_then(|v| v.get("text").and_then(Value::as_str))
                    .or_else(|| src_node.content.get("text").and_then(Value::as_str))
                    .unwrap_or("")
                    .trim()
                    .to_owned();
            }
            if prompt_info.is_empty() {
                prompt_info = active_ver
                    .and_then(|v| v.get("information").and_then(Value::as_str))
                    .or_else(|| src_node.content.get("information").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_owned();
            }
            prompt_node_id = src_node.id.clone();
            prompt_node_title = active_ver
                .and_then(|v| v.get("title").and_then(Value::as_str))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&src_node.title)
                .to_owned();
            prompt_version_id = active_ver
                .and_then(|v| v.get("id").and_then(Value::as_str))
                .unwrap_or("")
                .to_owned();
            prompt_version_label = active_ver
                .and_then(|v| v.get("label").and_then(Value::as_str))
                .unwrap_or("")
                .to_owned();
            if let Some(dur) = active_ver
                .and_then(|v| v.pointer("/generationOptions/durationSeconds"))
                .and_then(Value::as_f64)
            {
                detected_duration = Some(dur);
            }
            // Collect any referenceSelection assets declared on the prompt version.
            let mut ref_selection_media_ids: Vec<(String, String)> = Vec::new();
            if let Some(assets) = active_ver
                .and_then(|v| v.pointer("/referenceSelection/assets"))
                .and_then(Value::as_array)
            {
                for asset in assets {
                    if let (Some(sid), Some(kind)) = (
                        asset.get("sourceId").and_then(Value::as_str),
                        asset.get("kind").and_then(Value::as_str),
                    ) {
                        ref_selection_media_ids.push((sid.to_owned(), kind.to_owned()));
                    }
                }
            }

            // Look for connected downstream video-generation node.
            let connected_generators: Vec<&NodeRecord> = canvas_snapshot
                .edges
                .iter()
                .filter(|e| e.source_node_id == src_node.id)
                .filter_map(|e| nodes_by_id.get(e.target_node_id.as_str()).copied())
                .filter(|n| n.kind == "video-generation")
                .collect();
            if let Some(gen_node) = connected_generators.first() {
                generator_node_id = gen_node.id.clone();
                if explicit_module_id.is_none() {
                    explicit_module_id = gen_node
                        .content
                        .get("workflowModuleId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                }
                if let Some(mode) = gen_node
                    .content
                    .get("generationMode")
                    .and_then(Value::as_str)
                {
                    generator_mode = mode.to_owned();
                }
                apply_node_content_to_submit(&gen_node.content, &channel, &mut submit_input);
                if detected_duration.is_none() {
                    detected_duration = gen_node
                        .content
                        .get("generationDuration")
                        .and_then(Value::as_f64);
                }
                // Gather connected media inputs of that generator node.
                let mut incoming_media: Vec<&NodeRecord> = canvas_snapshot
                    .edges
                    .iter()
                    .filter(|e| e.target_node_id == gen_node.id)
                    .filter_map(|e| nodes_by_id.get(e.source_node_id.as_str()).copied())
                    .filter(|n| node_media_kind(n).is_some())
                    .collect();
                if !ref_selection_media_ids.is_empty() {
                    for (sid, mkind) in &ref_selection_media_ids {
                        if let Some(mnode) = incoming_media.iter().find(|n| &n.id == sid) {
                            if let Ok(item) = resolve_node_media(mnode, mkind, None) {
                                match mkind.as_str() {
                                    "image" => collected_images.push(item),
                                    "audio" => collected_audios.push(item),
                                    "video" => collected_videos.push(item),
                                    _ => {}
                                }
                            }
                        }
                    }
                } else {
                    for mnode in incoming_media.drain(..) {
                        if let Some(mkind) = node_media_kind(mnode) {
                            if let Ok(item) = resolve_node_media(mnode, mkind, None) {
                                match mkind {
                                    "image" => collected_images.push(item),
                                    "audio" => collected_audios.push(item),
                                    "video" => collected_videos.push(item),
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            } else if !ref_selection_media_ids.is_empty() {
                for (sid, mkind) in &ref_selection_media_ids {
                    if let Some(mnode) = nodes_by_id.get(sid.as_str()) {
                        if let Ok(item) = resolve_node_media(mnode, mkind, None) {
                            match mkind.as_str() {
                                "image" => collected_images.push(item),
                                "audio" => collected_audios.push(item),
                                "video" => collected_videos.push(item),
                                _ => {}
                            }
                        }
                    }
                }
            }
        } else if src_node.kind == "video-generation" {
            generator_node_id = src_node.id.clone();
            if explicit_module_id.is_none() {
                explicit_module_id = src_node
                    .content
                    .get("workflowModuleId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
            }
            if let Some(mode) = src_node
                .content
                .get("generationMode")
                .and_then(Value::as_str)
            {
                generator_mode = mode.to_owned();
            }
            apply_node_content_to_submit(&src_node.content, &channel, &mut submit_input);
            detected_duration = src_node
                .content
                .get("generationDuration")
                .and_then(Value::as_f64);

            let incoming_nodes: Vec<&NodeRecord> = canvas_snapshot
                .edges
                .iter()
                .filter(|e| e.target_node_id == src_node.id)
                .filter_map(|e| nodes_by_id.get(e.source_node_id.as_str()).copied())
                .collect();
            let active_text_id = src_node
                .content
                .get("activeTextInputId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let chosen_text = incoming_nodes
                .iter()
                .copied()
                .find(|n| n.kind == "text" && n.id == active_text_id)
                .or_else(|| incoming_nodes.iter().copied().find(|n| n.kind == "text"));
            if let Some(text_node) = chosen_text {
                let active_ver = active_prompt_version(text_node);
                if prompt_text.is_empty() {
                    prompt_text = active_ver
                        .and_then(|v| v.get("text").and_then(Value::as_str))
                        .or_else(|| text_node.content.get("text").and_then(Value::as_str))
                        .unwrap_or("")
                        .trim()
                        .to_owned();
                }
                if prompt_info.is_empty() {
                    prompt_info = active_ver
                        .and_then(|v| v.get("information").and_then(Value::as_str))
                        .or_else(|| text_node.content.get("information").and_then(Value::as_str))
                        .unwrap_or("")
                        .to_owned();
                }
                prompt_node_id = text_node.id.clone();
                prompt_node_title = active_ver
                    .and_then(|v| v.get("title").and_then(Value::as_str))
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(&text_node.title)
                    .to_owned();
                prompt_version_id = active_ver
                    .and_then(|v| v.get("id").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_owned();
                prompt_version_label = active_ver
                    .and_then(|v| v.get("label").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_owned();
                if let Some(dur) = active_ver
                    .and_then(|v| v.pointer("/generationOptions/durationSeconds"))
                    .and_then(Value::as_f64)
                {
                    detected_duration = Some(dur);
                }
            }
            for node in incoming_nodes {
                if let Some(mkind) = node_media_kind(node) {
                    if let Ok(item) = resolve_node_media(node, mkind, None) {
                        match mkind {
                            "image" => collected_images.push(item),
                            "audio" => collected_audios.push(item),
                            "video" => collected_videos.push(item),
                            _ => {}
                        }
                    }
                }
            }
        } else {
            return api_error(
                StatusCode::BAD_REQUEST,
                format!(
                    "sourceNodeId 只能指向 text 或 video-generation 节点，当前为：{}",
                    src_node.kind
                ),
            );
        }
    }

    if prompt_text.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "提示词不能为空");
    }

    // Apply explicit media overrides if supplied in the request.
    {
        let nodes_by_id: HashMap<&str, &NodeRecord> = canvas_snapshot
            .nodes
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();
        if !input.images.is_empty() {
            collected_images.clear();
            for item in &input.images {
                match resolve_media_ref_item(item, "image", &nodes_by_id) {
                    Ok(resolved) => collected_images.push(resolved),
                    Err(msg) => return api_error(StatusCode::BAD_REQUEST, msg),
                }
            }
        }
        if !input.audios.is_empty() {
            collected_audios.clear();
            for item in &input.audios {
                match resolve_media_ref_item(item, "audio", &nodes_by_id) {
                    Ok(resolved) => collected_audios.push(resolved),
                    Err(msg) => return api_error(StatusCode::BAD_REQUEST, msg),
                }
            }
        }
        if !input.videos.is_empty() {
            collected_videos.clear();
            for item in &input.videos {
                match resolve_media_ref_item(item, "video", &nodes_by_id) {
                    Ok(resolved) => collected_videos.push(resolved),
                    Err(msg) => return api_error(StatusCode::BAD_REQUEST, msg),
                }
            }
        }
    }

    // Apply preset (if explicitly specified, or in standalone mode, or when resolved as default).
    if let Some(ref preset) = resolved_preset {
        if input.preset.is_some() || generator_node_id.is_empty() {
            apply_preset_to_submit(&preset.settings, &channel, &mut submit_input);
            preset_name = preset.name.clone();
        }
    } else if input.preset.is_none() && !generator_node_id.is_empty() {
        preset_name = "节点当前参数".to_owned();
    }

    // Resolve local workflow module if channel == "local".
    let workflow_module_revision = if channel == "local" {
        submit_input.input_root_path = state.config.comfy_input_directory.clone();
        let chosen = explicit_module_id
            .as_deref()
            .and_then(|id| video_modules.iter().find(|m| m.manifest.id == id))
            .or_else(|| {
                let slot_key = format!("video-generation:{generator_mode}");
                workflow_defaults
                    .get(&slot_key)
                    .or_else(|| workflow_defaults.get("video-generation:reference-to-video"))
                    .and_then(|id| video_modules.iter().find(|m| &m.manifest.id == id))
            })
            .or_else(|| {
                video_modules
                    .iter()
                    .find(|m| m.manifest.variant == generator_mode)
                    .or_else(|| video_modules.first())
            });
        let Some(module) = chosen else {
            return api_error(StatusCode::BAD_REQUEST, "未找到可用的本地 H3 工作流模块");
        };
        submit_input.workflow_module_id = Some(module.manifest.id.clone());
        generator_mode = module.manifest.variant.clone();
        if resolved_preset.is_none() && generator_node_id.is_empty() {
            let dm = module.manifest.defaults.diffusion_model_name.trim();
            if !dm.is_empty() {
                submit_input.diffusion_model_name = dm.to_owned();
            }
        }
        module.manifest.revision.clone()
    } else {
        submit_input.workflow_module_id = None;
        if let Some(sampler) = input.colab_sampler.as_deref() {
            match normalize_colab_sampler(Some(sampler)) {
                Ok(normalized) => submit_input.colab_sampler = Some(normalized),
                Err(error) => return api_error(StatusCode::BAD_REQUEST, error),
            }
        }
        colab_profile_id.clone().unwrap_or_default()
    };

    // Apply per-request overrides.
    submit_input.prompt = prompt_text.clone();
    if let Some(duration) = input.duration_seconds.or(detected_duration) {
        submit_input.duration_seconds = duration;
    }
    if let Some(ref ratio) = input.aspect_ratio {
        submit_input.aspect_ratio = ratio.trim().to_owned();
    }
    if let Some(ref smode) = input.seed_mode {
        submit_input.seed_mode = smode.trim().to_owned();
    }
    if let Some(ref s) = input.seed {
        submit_input.seed = s.trim().to_owned();
    }
    if let Some(ref ref_size) = input.ref_image_size {
        submit_input.ref_image_size = ref_size.trim().to_owned();
    }
    if let Some(strict) = input.strict_prompt_tags {
        submit_input.strict_prompt_tags = Some(strict);
    }
    if channel != "colab" {
        if let Some(sec) = input.secondary_sampling_enabled {
            submit_input.secondary_sampling_enabled = sec;
        }
    } else {
        submit_input.secondary_sampling_enabled = false;
    }

    // Validate physical paths for all media inputs before creating canvas nodes.
    let mut physical_images = Vec::with_capacity(collected_images.len());
    let mut image_refs = Vec::with_capacity(collected_images.len());
    let mut image_roles = Vec::with_capacity(collected_images.len());
    let mut has_explicit_roles = false;
    for (idx, item) in collected_images.iter().enumerate() {
        match resolve_physical_asset_path(&state, &item.asset_ref) {
            Ok(physical) => physical_images.push(physical),
            Err(error) => return api_error(StatusCode::BAD_REQUEST, error),
        }
        image_refs.push(storage::encode(&state, &item.asset_ref));
        if let Some(ref r) = item.role {
            has_explicit_roles = true;
            image_roles.push(r.clone());
        } else {
            image_roles.push(if idx == 0 {
                "first".to_owned()
            } else {
                "last".to_owned()
            });
        }
    }
    let mut physical_audios = Vec::with_capacity(collected_audios.len());
    let mut audio_refs = Vec::with_capacity(collected_audios.len());
    for item in &collected_audios {
        match resolve_physical_asset_path(&state, &item.asset_ref) {
            Ok(physical) => physical_audios.push(physical),
            Err(error) => return api_error(StatusCode::BAD_REQUEST, error),
        }
        audio_refs.push(storage::encode(&state, &item.asset_ref));
    }
    let mut video_refs = Vec::with_capacity(collected_videos.len());
    for item in &collected_videos {
        if let Err(error) = resolve_physical_asset_path(&state, &item.asset_ref) {
            return api_error(StatusCode::BAD_REQUEST, error);
        }
        video_refs.push(storage::encode(&state, &item.asset_ref));
    }
    submit_input.image_paths = physical_images;
    if generator_mode == "first-last-frame" && (has_explicit_roles || !image_refs.is_empty()) {
        submit_input.image_roles = image_roles;
    }
    submit_input.audio_paths = physical_audios;
    submit_input.video_paths = video_refs.clone();

    // Reserve job & create canvas nodes under media_guard.
    let job_id = format!("job:{}", Uuid::new_v4());
    let _media_guard = state.media_guard.clone().lock_owned().await;

    // 1) Create prompt node if standalone and requested.
    let create_prompt_node = entry_mode == "standalone" && input.create_prompt_node.unwrap_or(true);
    if create_prompt_node {
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("H3 生成提示词")
            .to_owned();
        let version_id = format!("version:{}", Uuid::new_v4());
        let created_at = now_rfc3339();
        let (px, py) = place_non_overlapping(&canvas_snapshot.nodes, 80.0, 80.0, 460.0, 320.0);
        let pcontent = json!({
            "text": prompt_text,
            "information": prompt_info,
            "contentNode": true,
            "contentType": "prompt",
            "promptVersions": [{
                "id": version_id,
                "label": "v1",
                "title": title,
                "text": prompt_text,
                "information": prompt_info,
                "createdAt": created_at,
                "requestId": format!("{request_id}:prompt"),
                "source": "agent",
                "generationOptions": {
                    "durationSeconds": submit_input.duration_seconds.round() as i64,
                },
            }],
            "activePromptVersionId": version_id,
            "bestPromptVersionId": "",
        });
        match state.core.database.create_node(CreateNodeInput {
            canvas_id: Some(canvas_snapshot.canvas.id.clone()),
            kind: Some("text".to_owned()),
            title: title.clone(),
            content: pcontent,
            source: Some("agent".to_owned()),
            request_id: Some(format!("agent-prompt:{job_id}")),
            x: Some(px),
            y: Some(py),
            width: Some(460.0),
            height: Some(320.0),
        }) {
            Ok(res) => {
                prompt_node_id = res.node.id.clone();
                prompt_node_title = res.node.title.clone();
                prompt_version_id = version_id;
                prompt_version_label = "v1".to_owned();
                canvas_snapshot.nodes.push(res.node.clone());
                if res.created {
                    let _ = state.handle.emit("canvas://node-created", res.node);
                }
            }
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }

    // 2) Create video-generation node if we do not already have one.
    if generator_node_id.is_empty() {
        let anchor = if !prompt_node_id.is_empty() {
            canvas_snapshot
                .nodes
                .iter()
                .find(|n| n.id == prompt_node_id)
        } else {
            source_node_record.as_ref()
        };
        let (gx_anchor, gy_anchor) = anchor
            .map(|n| (n.x + n.width + 60.0, n.y))
            .unwrap_or((80.0, 80.0));
        let (gx, gy) = place_non_overlapping(
            &canvas_snapshot.nodes,
            gx_anchor,
            gy_anchor,
            VIDEO_GENERATION_NODE_WIDTH,
            VIDEO_GENERATION_NODE_HEIGHT,
        );
        let gen_content = build_generator_content(
            &submit_input,
            &channel,
            &generator_mode,
            &workflow_module_revision,
        );
        match state.core.database.create_node(CreateNodeInput {
            canvas_id: Some(canvas_snapshot.canvas.id.clone()),
            kind: Some("video-generation".to_owned()),
            title: "视频生成".to_owned(),
            content: gen_content,
            source: Some("agent".to_owned()),
            request_id: Some(format!("agent-generator:{job_id}")),
            x: Some(gx),
            y: Some(gy),
            width: Some(VIDEO_GENERATION_NODE_WIDTH),
            height: Some(VIDEO_GENERATION_NODE_HEIGHT),
        }) {
            Ok(res) => {
                generator_node_id = res.node.id.clone();
                canvas_snapshot.nodes.push(res.node.clone());
                if res.created {
                    let _ = state.handle.emit("canvas://node-created", res.node);
                }
                if !prompt_node_id.is_empty() {
                    if let Ok(edge) = state.core.database.create_edge(CreateEdgeInput {
                        canvas_id: Some(canvas_snapshot.canvas.id.clone()),
                        source_node_id: prompt_node_id.clone(),
                        target_node_id: generator_node_id.clone(),
                        kind: Some("input".to_owned()),
                        metadata: json!({}),
                    }) {
                        let _ = state.handle.emit("canvas://edge-created", edge);
                    }
                }
                for item in collected_images
                    .iter()
                    .chain(collected_audios.iter())
                    .chain(collected_videos.iter())
                {
                    if let Some(ref media_node_id) = item.node_id {
                        if let Ok(edge) = state.core.database.create_edge(CreateEdgeInput {
                            canvas_id: Some(canvas_snapshot.canvas.id.clone()),
                            source_node_id: media_node_id.clone(),
                            target_node_id: generator_node_id.clone(),
                            kind: Some("input".to_owned()),
                            metadata: json!({}),
                        }) {
                            let _ = state.handle.emit("canvas://edge-created", edge);
                        }
                    }
                }
            }
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }

    // 3) Create generated-video placeholder node + output edge.
    let generation_snapshot = build_video_generation_snapshot(
        &prompt_text,
        &prompt_info,
        &prompt_node_id,
        &prompt_node_title,
        &prompt_version_id,
        &prompt_version_label,
        &preset_name,
        &submit_input,
        &workflow_module_revision,
        &channel,
        &image_refs,
        &audio_refs,
        &video_refs,
    );
    let (preview_w, preview_h) = preview_dimensions_for_aspect_ratio(&submit_input.aspect_ratio);
    let placement_anchor = source_node_record
        .as_ref()
        .filter(|n| n.kind == "text")
        .or_else(|| {
            canvas_snapshot
                .nodes
                .iter()
                .find(|n| n.id == generator_node_id)
        });
    let (ph_anchor_x, ph_anchor_y) = match placement_anchor {
        Some(n) if n.kind == "text" => (n.x, n.y + n.height + 36.0),
        Some(n) => (n.x + n.width + 60.0, n.y),
        None => (80.0, 80.0),
    };
    let (ph_x, ph_y) =
        place_non_overlapping(&canvas_snapshot.nodes, ph_anchor_x, ph_anchor_y, preview_w, preview_h);
    let mut ph_content = Map::new();
    ph_content.insert("generationPlaceholder".to_owned(), json!(true));
    ph_content.insert("placeholderClientId".to_owned(), json!(client_id));
    ph_content.insert("status".to_owned(), json!("running"));
    ph_content.insert("executionProgress".to_owned(), Value::Null);
    ph_content.insert(
        "validationMessage".to_owned(),
        json!(if channel == "colab" {
            "正在上传素材并提交到 Colab ComfyUI…"
        } else {
            "正在上传素材并提交到远程 ComfyUI…"
        }),
    );
    ph_content.insert("sourceGeneratorId".to_owned(), json!(generator_node_id));
    if channel == "colab" {
        ph_content.insert("comfyChannel".to_owned(), json!("colab"));
    }
    ph_content.insert("generationSnapshot".to_owned(), generation_snapshot.clone());

    let placeholder_node = match state.core.database.create_node(CreateNodeInput {
        canvas_id: Some(canvas_snapshot.canvas.id.clone()),
        kind: Some("generated-video".to_owned()),
        title: "视频预览（生成中）".to_owned(),
        content: Value::Object(ph_content),
        source: Some("comfyui-placeholder".to_owned()),
        request_id: Some(format!("generation-placeholder:{client_id}")),
        x: Some(ph_x),
        y: Some(ph_y),
        width: Some(preview_w),
        height: Some(preview_h),
    }) {
        Ok(res) => {
            if res.created {
                let _ = state.handle.emit("canvas://node-created", res.node.clone());
            }
            res.node
        }
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };

    if let Ok(edge) = state.core.database.create_edge(CreateEdgeInput {
        canvas_id: Some(canvas_snapshot.canvas.id.clone()),
        source_node_id: generator_node_id.clone(),
        target_node_id: placeholder_node.id.clone(),
        kind: Some("output".to_owned()),
        metadata: json!({ "placeholder": true, "clientId": client_id }),
    }) {
        let _ = state.handle.emit("canvas://edge-created", edge);
    }

    let _ = state
        .auth
        .ownership()
        .remember_task(&client_id, &actor.user_id);

    let now = now_rfc3339();
    let job = AgentJobRecord {
        id: job_id.clone(),
        request_id: request_id.clone(),
        canvas_id: canvas_snapshot.canvas.id.clone(),
        kind: kind.to_owned(),
        channel: channel.clone(),
        entry_mode: entry_mode.to_owned(),
        preset_name: preset_name.clone(),
        status: "running".to_owned(),
        client_id: client_id.clone(),
        prompt_id: None,
        source_node_id: source_node_record.map(|n| n.id),
        generator_node_id: Some(generator_node_id),
        placeholder_node_id: Some(placeholder_node.id.clone()),
        output_node_ids: Vec::new(),
        outputs: Vec::new(),
        snapshot: generation_snapshot,
        seed: None,
        execution_elapsed_seconds: None,
        error: None,
        created_at: now.clone(),
        updated_at: now,
    };

    if let Err(error) = state.agent_jobs.insert(&job) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, error);
    }

    // Spawn background ComfyUI execution + node finalization.
    let worker_state = state.clone();
    let mut worker_job = job.clone();
    let worker_actor = actor.clone();
    tokio::spawn(async move {
        let result = commands::submit_comfyui_workflow(
            submit_input,
            PlatformState(&worker_state.core),
            Channel::new(|_| {}),
        )
        .await;

        match result {
            Ok(submit_result) => {
                let mut value = serde_json::to_value(&submit_result).unwrap_or(Value::Null);
                if worker_job.channel == "colab" {
                    if let Err(error) = materialize_ss_outputs(&worker_state, &mut value).await {
                        mark_placeholder_failed(&worker_state, &mut worker_job, false, &error);
                        return;
                    }
                }
                if let Err(error) = reference_outputs(&mut value) {
                    mark_placeholder_failed(&worker_state, &mut worker_job, false, &error);
                    return;
                }
                rpc::normalize_result(&worker_state, &mut value);
                let raw_outputs = value
                    .get("outputs")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let media_roots = worker_state.media_roots();
                let media_registry = worker_state.media.clone();
                let reg_value = value.clone();
                let reg_user = worker_actor.user_id.clone();
                tokio::task::spawn_blocking(move || {
                    let _ = media_registry.register_outputs(
                        &media_roots,
                        &reg_value,
                        &reg_user,
                        chrono::Utc::now(),
                    );
                });
                if let Err(error) = finalize_placeholder_to_outputs(
                    &worker_state,
                    &mut worker_job,
                    &submit_result.prompt_id,
                    &submit_result.seed,
                    submit_result.execution_elapsed_seconds,
                    raw_outputs,
                ) {
                    mark_placeholder_failed(&worker_state, &mut worker_job, false, &error);
                }
            }
            Err(error) => {
                let is_cancelled = error.contains("已取消")
                    || worker_state
                        .agent_jobs
                        .get(&worker_job.id)
                        .ok()
                        .flatten()
                        .is_some_and(|latest| latest.status == "cancelled");
                mark_placeholder_failed(&worker_state, &mut worker_job, is_cancelled, &error);
            }
        }
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({
            "ok": true,
            "canvasCreated": canvas_created,
            "deduplicated": false,
            "job": job_response_json(&job),
        })),
    )
        .into_response()
}

async fn reconcile_orphan_job(state: &WebState, job: &mut AgentJobRecord) {
    if !matches!(job.status.as_str(), "queued" | "running") {
        return;
    }
    let active_in_memory = state
        .core
        .running_comfy_tasks
        .lock()
        .ok()
        .is_some_and(|map| map.contains_key(&job.client_id));
    if active_in_memory {
        return;
    }
    let server_url = if job.channel == "colab" {
        state.config.colab_comfy_url.clone()
    } else {
        state.config.comfy_url.clone()
    };
    if server_url.trim().is_empty() {
        return;
    }
    let colab_ids = if job.channel == "colab" {
        Some(vec![job.client_id.clone()])
    } else {
        None
    };
    let Ok(statuses) = commands::get_comfyui_client_task_statuses(
        server_url,
        vec![job.client_id.clone()],
        None,
        None,
        colab_ids,
    )
    .await
    else {
        return;
    };
    let Some(status) = statuses.into_iter().next() else {
        return;
    };
    match status.status.as_str() {
        "completed" => {
            let mut value = serde_json::to_value(&status).unwrap_or(Value::Null);
            if job.channel == "colab" && materialize_ss_outputs(state, &mut value).await.is_err() {
                return;
            }
            if reference_outputs(&mut value).is_err() {
                return;
            }
            rpc::normalize_result(state, &mut value);
            let raw_outputs = value
                .get("outputs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let prompt_id = status.prompt_id.unwrap_or_default();
            let seed = status.seed.unwrap_or_default();
            let _ = finalize_placeholder_to_outputs(
                state,
                job,
                &prompt_id,
                &seed,
                status.execution_elapsed_seconds,
                raw_outputs,
            );
        }
        "failed" => {
            mark_placeholder_failed(state, job, false, "ComfyUI 生成失败");
        }
        _ => {}
    }
}

async fn get_job(State(state): State<WebState>, AxumPath(job_id): AxumPath<String>) -> Response {
    let state = state.connection_snapshot();
    let mut job = match state.agent_jobs.get(&job_id) {
        Ok(Some(job)) => job,
        Ok(None) => return api_error(StatusCode::NOT_FOUND, format!("找不到任务：{job_id}")),
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    reconcile_orphan_job(&state, &mut job).await;
    Json(json!({
        "ok": true,
        "job": job_response_json(&job),
    }))
    .into_response()
}

async fn cancel_job(State(state): State<WebState>, AxumPath(job_id): AxumPath<String>) -> Response {
    let state = state.connection_snapshot();
    let mut job = match state.agent_jobs.get(&job_id) {
        Ok(Some(job)) => job,
        Ok(None) => return api_error(StatusCode::NOT_FOUND, format!("找不到任务：{job_id}")),
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    if matches!(
        job.status.as_str(),
        "succeeded" | "failed" | "cancelled"
    ) {
        return Json(json!({
            "ok": true,
            "job": job_response_json(&job),
        }))
        .into_response();
    }
    let server_url = if job.channel == "colab" {
        state.config.colab_comfy_url.clone()
    } else {
        state.config.comfy_url.clone()
    };
    if !server_url.trim().is_empty() {
        let _ = commands::cancel_comfyui_workflow(
            server_url,
            job.client_id.clone(),
            PlatformState(&state.core),
        )
        .await;
    }
    mark_placeholder_failed(&state, &mut job, true, "任务已被外部请求取消");
    Json(json!({
        "ok": true,
        "job": job_response_json(&job),
    }))
    .into_response()
}

async fn download_job_output(
    State(state): State<WebState>,
    AxumPath((job_id, index)): AxumPath<(String, usize)>,
    request: axum::http::Request<Body>,
) -> Response {
    let state = state.connection_snapshot();
    let job = match state.agent_jobs.get(&job_id) {
        Ok(Some(job)) => job,
        Ok(None) => return api_error(StatusCode::NOT_FOUND, format!("找不到任务：{job_id}")),
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let Some(output_val) = job.outputs.get(index) else {
        return api_error(
            StatusCode::NOT_FOUND,
            format!("任务 {job_id} 不存在索引为 {index} 的输出文件"),
        );
    };
    if let Some(asset_path) = output_val.get("assetPath").and_then(Value::as_str) {
        if let Ok(path) = resolve_resource_file(&state, asset_path) {
            let mut response = serve_resource_file(&path, request).await;
            if response.status().is_success() {
                let display_name = output_val
                    .get("filename")
                    .and_then(Value::as_str)
                    .map(Path::new)
                    .unwrap_or(path.as_path());
                response
                    .headers_mut()
                    .insert(header::CONTENT_DISPOSITION, download_disposition(display_name));
            }
            return response;
        }
    }

    // Fallback: proxy directly from ComfyUI /view when comfy_output_directory is unconfigured.
    let filename = output_val
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("");
    if filename.is_empty() {
        return api_error(StatusCode::NOT_FOUND, "输出文件信息缺失");
    }
    let subfolder = output_val
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or("");
    let file_type = output_val
        .get("fileType")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let upstream_base = if job.channel == "colab" {
        &state.config.colab_comfy_url
    } else {
        &state.config.comfy_url
    };
    if upstream_base.trim().is_empty() {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "ComfyUI 服务地址未配置");
    }
    let Ok(mut url) = reqwest::Url::parse(&format!("{}/view", upstream_base.trim_end_matches('/')))
    else {
        return api_error(StatusCode::BAD_GATEWAY, "上游地址无效");
    };
    url.query_pairs_mut()
        .append_pair("filename", filename)
        .append_pair("subfolder", subfolder)
        .append_pair("type", file_type);
    match state.client.get(url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let content_type = resp.headers().get(header::CONTENT_TYPE).cloned();
            let content_len = resp.headers().get(header::CONTENT_LENGTH).cloned();
            let mut response = Response::new(Body::from_stream(resp.bytes_stream().map(|res| {
                res.map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))
            })));
            *response.status_mut() = status;
            if let Some(ct) = content_type {
                response.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            if let Some(cl) = content_len {
                response.headers_mut().insert(header::CONTENT_LENGTH, cl);
            }
            if status.is_success() {
                response.headers_mut().insert(
                    header::CONTENT_DISPOSITION,
                    download_disposition(Path::new(filename)),
                );
            }
            response
        }
        Err(error) => api_error(StatusCode::BAD_GATEWAY, format!("拉取成片失败：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        colab_channel::workflow::{
            colab_fla_reference_v3_adapter, colab_fla_reference_v3_bindings,
            COLAB_FLA_V3_WORKFLOW_JSON,
        },
        db::Database,
        models::{RuntimeInfo, DEFAULT_CANVAS_ID},
        platform::AppHandle,
        web::{auth, config::Config, connection, media_cleanup, presence, tasks, users},
        workflow_modules::{SaveWorkflowModuleInput, WorkflowModuleDefaults},
        ApplicationState, CanvasSelectionState,
    };
    use axum::{body::to_bytes, routing::get as axum_get, routing::post as axum_post};
    use std::sync::{atomic::AtomicBool, atomic::Ordering as AtomicOrdering, Arc, Mutex as StdMutex, RwLock};
    use tower::ServiceExt;

    struct MockComfyState {
        prompt_calls: Arc<StdMutex<usize>>,
        cancelled: Arc<StdMutex<Vec<String>>>,
        hold_history: Arc<AtomicBool>,
        video_bytes: Vec<u8>,
    }

    async fn spawn_mock_comfy(
        video_bytes: Vec<u8>,
    ) -> (
        String,
        Arc<StdMutex<usize>>,
        Arc<StdMutex<Vec<String>>>,
        Arc<AtomicBool>,
    ) {
        let prompt_calls = Arc::new(StdMutex::new(0usize));
        let cancelled = Arc::new(StdMutex::new(Vec::<String>::new()));
        let hold_history = Arc::new(AtomicBool::new(false));
        let mock_state = Arc::new(MockComfyState {
            prompt_calls: prompt_calls.clone(),
            cancelled: cancelled.clone(),
            hold_history: hold_history.clone(),
            video_bytes,
        });
        let app = Router::new()
            .route(
                "/upload/image",
                axum_post(|_body: axum::body::Bytes| async {
                    Json(json!({ "name": "uploaded_ref.png" }))
                }),
            )
            .route(
                "/prompt",
                axum_post(|State(s): State<Arc<MockComfyState>>, Json(_body): Json<Value>| async move {
                    let mut count = s.prompt_calls.lock().unwrap();
                    *count += 1;
                    Json(json!({ "prompt_id": format!("mock-prompt-{}", *count) }))
                }),
            )
            .route(
                "/history/{prompt_id}",
                axum_get(|State(s): State<Arc<MockComfyState>>, AxumPath(prompt_id): AxumPath<String>| async move {
                    if s.hold_history.load(AtomicOrdering::SeqCst) {
                        return Json(json!({}));
                    }
                    Json(json!({
                        prompt_id: {
                            "status": {
                                "status_str": "success",
                                "messages": [
                                    ["execution_start", { "timestamp": 1000 }],
                                    ["execution_success", { "timestamp": 2500 }]
                                ]
                            },
                            "outputs": {
                                "221": {
                                    "gifs": [{
                                        "filename": "mock_out.mp4",
                                        "subfolder": "agent-test",
                                        "type": "output"
                                    }]
                                }
                            }
                        }
                    }))
                }),
            )
            .route(
                "/queue",
                axum_get(|| async { Json(json!({ "queue_running": [], "queue_pending": [] })) }),
            )
            .route(
                "/interrupt",
                axum_post(|State(s): State<Arc<MockComfyState>>, Json(body): Json<Value>| async move {
                    if let Some(pid) = body.get("prompt_id").and_then(Value::as_str) {
                        s.cancelled.lock().unwrap().push(pid.to_owned());
                    }
                    StatusCode::OK
                }),
            )
            .route(
                "/view",
                axum_get(|State(s): State<Arc<MockComfyState>>| async move {
                    ([(header::CONTENT_TYPE, "video/mp4")], s.video_bytes.clone())
                }),
            )
            .with_state(mock_state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), prompt_calls, cancelled, hold_history)
    }

    fn setup_test_env(comfy_url: &str) -> (PathBuf, WebState, Router) {
        let root = std::env::temp_dir().join(format!("agent-api-test-{}", Uuid::new_v4()));
        let data = root.join("data");
        let input_dir = root.join("comfy-input");
        let output_dir = root.join("comfy-output");
        std::fs::create_dir_all(data.join("uploads")).unwrap();
        std::fs::create_dir_all(data.join("temp")).unwrap();
        std::fs::create_dir_all(data.join("workflow-modules")).unwrap();
        std::fs::create_dir_all(data.join("workflow-module-exports")).unwrap();
        std::fs::create_dir_all(data.join(crate::colab_channel::COLAB_OUTPUTS_DIR)).unwrap();
        std::fs::create_dir_all(input_dir.join(IMPORT_FOLDER)).unwrap();
        std::fs::create_dir_all(output_dir.join("agent-test")).unwrap();
        std::fs::create_dir_all(root.join("downloads")).unwrap();
        std::fs::create_dir_all(root.join("web")).unwrap();
        std::fs::write(root.join("web/index.html"), "<html></html>").unwrap();

        let workflow_file = root.join("h3_test_workflow.json");
        std::fs::write(&workflow_file, COLAB_FLA_V3_WORKFLOW_JSON.as_bytes()).unwrap();

        let auth_path = data.join("app-lock.json");
        auth::write_password(&auth_path, "test-password-123").unwrap();
        let db_path = data.join("infinite-canvas.sqlite3");
        let database = Database::open(&db_path).unwrap();
        users::migrate(&db_path, &auth_path).unwrap();
        let auth_store = Arc::new(auth::Auth::open(&db_path).unwrap());
        let media = Arc::new(media_cleanup::MediaRegistry::open(&db_path).unwrap());
        let agent_jobs = Arc::new(AgentJobStore::open(&db_path).unwrap());
        let (event_sender, _) = tokio::sync::broadcast::channel(64);
        let handle = AppHandle {
            root: root.clone(),
            events: event_sender,
        };
        let active_canvas_id = Arc::new(RwLock::new(DEFAULT_CANVAS_ID.to_owned()));
        let selection = Arc::new(RwLock::new(CanvasSelectionState::default()));
        let core = ApplicationState {
            database,
            runtime: RuntimeInfo {
                base_url: "http://127.0.0.1:18742".to_owned(),
                data_path: db_path.to_string_lossy().into_owned(),
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
            },
            assets_dir: input_dir.join(IMPORT_FOLDER),
            workflow_modules_dir: data.join("workflow-modules"),
            workflow_module_exports_dir: data.join("workflow-module-exports"),
            app_lock_path: auth_path,
            data_dir: data.clone(),
            app_lock_guard: Arc::new(StdMutex::new(())),
            active_canvas_id,
            current_canvas_selection: selection,
            running_comfy_tasks: Arc::new(StdMutex::new(HashMap::new())),
        };

        // Install one local H3 workflow module and save a local preset in web-settings.json.
        let module_saved = crate::workflow_modules::save(
            &core.workflow_modules_dir,
            SaveWorkflowModuleInput {
                id: None,
                name: "Test H3 Module".to_owned(),
                capability: "video-generation".to_owned(),
                variant: "reference-to-video".to_owned(),
                revision: "1".to_owned(),
                adapter_kind: "minimax-h3-multi-reference-v1".to_owned(),
                source_workflow_path: workflow_file.to_string_lossy().into_owned(),
                bindings: Some(colab_fla_reference_v3_bindings()),
                adapter: Some(colab_fla_reference_v3_adapter()),
                ui_schema: None,
                defaults: Some(WorkflowModuleDefaults {
                    diffusion_model_name: r"MinimaxH3\test.safetensors".to_owned(),
                    sampler_name: None,
                    primary_video_steps: 6,
                    primary_audio_steps: 6,
                    secondary_scheduler_steps: 4,
                    primary_upscale_factor: 1.0,
                    primary_brightness: 1.0,
                    primary_contrast: 0.9,
                    primary_saturation: 0.9,
                    secondary_brightness: 1.0,
                    secondary_contrast: 0.9,
                    secondary_saturation: 1.0,
                    lora_name: String::new(),
                    lora_strength: 1.0,
                }),
            },
        )
        .unwrap();
        let presets_json = json!({
            "presets": [{
                "id": "preset-fast",
                "name": "测试快速预设",
                "settings": {
                    "primaryResolutionMegapixels": 0.4,
                    "secondaryResolutionMegapixels": 0.7,
                    "primaryUpscaleFactor": 1.0,
                    "primaryVideoSteps": 5,
                    "primaryAudioSteps": 5,
                    "secondarySchedulerSteps": 4,
                    "primaryBrightness": 1.0,
                    "primaryContrast": 0.9,
                    "primarySaturation": 0.9,
                    "secondaryBrightness": 1.0,
                    "secondaryContrast": 0.9,
                    "secondarySaturation": 1.0,
                    "diffusionModelName": r"MinimaxH3\test.safetensors",
                    "loraName": "",
                    "loraStrength": 1.0,
                    "loraBypassed": true,
                    "styleLoras": []
                }
            }],
            "defaultPresetId": "preset-fast"
        });
        let settings_map = BTreeMap::from([
            (LOCAL_PRESETS_KEY.to_owned(), presets_json.to_string()),
            (
                WORKFLOW_MODULE_DEFAULTS_KEY.to_owned(),
                json!({ "video-generation:reference-to-video": module_saved.manifest.id }).to_string(),
            ),
        ]);
        std::fs::write(
            data.join("web-settings.json"),
            serde_json::to_vec(&settings_map).unwrap(),
        )
        .unwrap();

        let config_path = root.join("config.json");
        let config = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            public_url: "http://127.0.0.1:18742/".to_owned(),
            allowed_origins: Vec::new(),
            data_directory: data.to_string_lossy().into_owned(),
            web_directory: root.join("web").to_string_lossy().into_owned(),
            downloads_directory: root.join("downloads").to_string_lossy().into_owned(),
            comfy_url: comfy_url.to_owned(),
            colab_comfy_url: String::new(),
            colab_ss_password: String::new(),
            colab_profile: String::new(),
            comfy_input_directory: input_dir.to_string_lossy().into_owned(),
            comfy_output_directory: output_dir.to_string_lossy().into_owned(),
            max_upload_bytes: 32 * 1024 * 1024,
            trusted_proxies: crate::web::config::default_trusted_proxies(),
        };
        std::fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();

        let state = WebState {
            core: Arc::new(core),
            config: Arc::new(config.clone()),
            connection: Arc::new(connection::Store::new(config_path, config)),
            auth: auth_store,
            handle,
            downloads: root.join("downloads"),
            token: "secret-agent-token".to_owned(),
            client: reqwest::Client::new(),
            settings_guard: Arc::new(tokio::sync::Mutex::new(())),
            media_guard: Arc::new(tokio::sync::Mutex::new(())),
            tasks: Arc::new(tasks::Tasks::default()),
            agent_jobs,
            comfy_relays: Arc::default(),
            presence: Arc::new(presence::Presence::new(AppHandle {
                root: root.clone(),
                events: tokio::sync::broadcast::channel(8).0,
            })),
            media,
        };
        let app = router(state.clone()).layer(middleware::from_fn_with_state(
            state.clone(),
            crate::web::check_origin,
        ));
        (root, state, app)
    }

    async fn read_json(resp: Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 16 * 1024 * 1024).await.unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn agent_api_enforces_bearer_auth_and_exposes_capabilities() {
        let (root, _state, app) = setup_test_env("http://127.0.0.1:9");

        // Missing / wrong token returns 401 even on POST without Origin header.
        let (status, _) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/agent/jobs")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, body) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("GET")
                        .uri("/v1/agent/capabilities")
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["presets"]["local"]["items"][0]["name"], "测试快速预设");
        assert_eq!(body["presets"]["colab"]["dasiwa"]["items"][0]["name"], "DaSiWa V5xs 默认方案");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn standalone_and_node_jobs_finalize_canvas_and_stream_outputs() {
        let fake_mp4 = b"\x00\x00\x00\x18ftypmp42mock-video-payload".to_vec();
        let (comfy_url, prompt_calls, _cancelled, _hold_history) =
            spawn_mock_comfy(fake_mp4.clone()).await;
        let (root, state, app) = setup_test_env(&comfy_url);
        std::fs::write(
            PathBuf::from(&state.config.comfy_output_directory).join("agent-test/mock_out.mp4"),
            &fake_mp4,
        )
        .unwrap();

        // Unknown preset returns 400 with available presets list.
        let (status, err_body) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/agent/jobs")
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            json!({
                                "createCanvas": { "name": "Bad Preset Canvas" },
                                "prompt": "a dog running",
                                "preset": "不存在的预设"
                            })
                            .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(err_body["error"].as_str().unwrap().contains("测试快速预设"));

        // Upload reference asset first.
        let boundary = "----testboundary";
        let multipart_body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"ref.png\"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--{boundary}--\r\n"
        );
        let (status, upload_body) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/agent/assets")
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .header(
                            header::CONTENT_TYPE,
                            format!("multipart/form-data; boundary={boundary}"),
                        )
                        .body(Body::from(multipart_body))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let asset_ref = upload_body["assetRef"].as_str().unwrap().to_owned();
        assert!(asset_ref.starts_with("sucanvas-input://sucanvas-imports/"));

        // Entry 1: standalone submit creating new canvas with idempotency.
        let submit_payload = json!({
            "requestId": "stable-job-req-1",
            "createCanvas": { "name": "Agent 自动画布" },
            "prompt": "A serene river at sunset",
            "title": "分镜 S01",
            "preset": "测试快速预设",
            "durationSeconds": 6,
            "images": [asset_ref],
        });
        let (status, submit_body) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/agent/jobs")
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(submit_payload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = submit_body["job"]["jobId"].as_str().unwrap().to_owned();
        let canvas_id = submit_body["job"]["canvasId"].as_str().unwrap().to_owned();
        let placeholder_id = submit_body["job"]["placeholderNodeId"]
            .as_str()
            .unwrap()
            .to_owned();

        // Idempotent retry returns 200 and same jobId without re-submitting.
        let (dup_status, dup_body) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/agent/jobs")
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(submit_payload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(dup_status, StatusCode::OK);
        assert_eq!(dup_body["deduplicated"], true);
        assert_eq!(dup_body["job"]["jobId"], job_id);

        // Poll until terminal state.
        let mut final_job = Value::Null;
        for _ in 0..80 {
            let (_, body) = read_json(
                app.clone()
                    .oneshot(
                        axum::http::Request::builder()
                            .method("GET")
                            .uri(format!("/v1/agent/jobs/{job_id}"))
                            .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
            )
            .await;
            final_job = body["job"].clone();
            if matches!(
                final_job["status"].as_str(),
                Some("succeeded" | "failed" | "cancelled")
            ) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        assert_eq!(final_job["status"], "succeeded", "job={final_job}");
        assert_eq!(*prompt_calls.lock().unwrap(), 1);
        assert_eq!(final_job["outputNodeIds"][0], placeholder_id);

        // Placeholder node was updated to a final playable generated-video node.
        let loaded = state.core.database.load_project(&canvas_id).unwrap();
        let video_node = loaded
            .nodes
            .iter()
            .find(|n| n.id == placeholder_id)
            .unwrap();
        assert_eq!(video_node.title, "视频预览");
        assert!(video_node.content.get("generationPlaceholder").is_none());
        assert_eq!(
            video_node.content.pointer("/generationSnapshot/presetName"),
            Some(&json!("测试快速预设"))
        );

        // Stream output video via Bearer-protected download endpoint.
        let dl_resp = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri(format!("/v1/agent/jobs/{job_id}/outputs/0"))
                    .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(dl_resp.status(), StatusCode::OK);
        let dl_bytes = to_bytes(dl_resp.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(dl_bytes.as_ref(), fake_mp4.as_slice());

        // Entry 2: drive an existing text node inside the same canvas.
        let text_node_id = loaded
            .nodes
            .iter()
            .find(|n| n.kind == "text")
            .unwrap()
            .id
            .clone();
        let (status2, body2) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/agent/jobs")
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            json!({
                                "requestId": "stable-job-req-2",
                                "canvasId": canvas_id,
                                "sourceNodeId": text_node_id,
                                "preset": "测试快速预设"
                            })
                            .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status2, StatusCode::ACCEPTED);
        let job2_id = body2["job"]["jobId"].as_str().unwrap().to_owned();
        let mut final_job2 = Value::Null;
        for _ in 0..80 {
            let (_, body) = read_json(
                app.clone()
                    .oneshot(
                        axum::http::Request::builder()
                            .method("GET")
                            .uri(format!("/v1/agent/jobs/{job2_id}"))
                            .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
            )
            .await;
            final_job2 = body["job"].clone();
            if matches!(
                final_job2["status"].as_str(),
                Some("succeeded" | "failed" | "cancelled")
            ) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        assert_eq!(final_job2["status"], "succeeded", "job2={final_job2}");
        assert_eq!(final_job2["entryMode"], "node");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancel_job_updates_placeholder_and_persists_cancelled_status() {
        let fake_mp4 = b"\x00\x00\x00\x18ftypmp42mock-video-payload".to_vec();
        let (comfy_url, _prompt_calls, _cancelled, hold_history) =
            spawn_mock_comfy(fake_mp4).await;
        hold_history.store(true, AtomicOrdering::SeqCst);
        let (root, state, app) = setup_test_env(&comfy_url);

        let (status, submit_body) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/agent/jobs")
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            json!({
                                "requestId": "cancel-job-req-1",
                                "createCanvas": { "name": "Cancel Test Canvas" },
                                "prompt": "Cancel me please",
                                "preset": "测试快速预设"
                            })
                            .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = submit_body["job"]["jobId"].as_str().unwrap().to_owned();
        let canvas_id = submit_body["job"]["canvasId"].as_str().unwrap().to_owned();
        let placeholder_id = submit_body["job"]["placeholderNodeId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(submit_body["job"]["promptNodeId"]
            .as_str()
            .is_some_and(|s| s.starts_with("node:")));

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let (cancel_status, cancel_body) = read_json(
            app.clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(format!("/v1/agent/jobs/{job_id}/cancel"))
                        .header(header::AUTHORIZATION, "Bearer secret-agent-token")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(cancel_status, StatusCode::OK);
        assert_eq!(cancel_body["job"]["status"], "cancelled");

        let persisted = state.agent_jobs.get(&job_id).unwrap().unwrap();
        assert_eq!(persisted.status, "cancelled");
        let loaded = state.core.database.load_project(&canvas_id).unwrap();
        let ph = loaded
            .nodes
            .iter()
            .find(|n| n.id == placeholder_id)
            .unwrap();
        assert_eq!(ph.content["status"], "cancelled");

        let _ = std::fs::remove_dir_all(root);
    }
}
