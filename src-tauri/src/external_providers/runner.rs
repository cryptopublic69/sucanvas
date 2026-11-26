use super::catalog::{
    parse_json_or_last_ndjson, resolve_lovart_credentials, resolve_model_spec,
    resolve_provider_binary, resolve_python_executable, ProviderId,
};
use super::PROVIDER_OUTPUTS_DIR;
use crate::{
    models::{NodeRecord, UpdateNodeInput},
    web::{rpc::ensure_contained, storage, WebState},
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::process::Command;
use tokio::sync::{watch, Mutex as AsyncMutex};
use uuid::Uuid;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS external_video_jobs (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_label TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_label TEXT NOT NULL,
    generator_node_id TEXT NOT NULL,
    placeholder_node_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stage_message TEXT NOT NULL,
    cost_credits INTEGER,
    quote_summary TEXT,
    remote_project_id TEXT,
    remote_node_id TEXT,
    remote_submit_id TEXT,
    remote_thread_id TEXT,
    working_dir TEXT,
    output_asset_path TEXT,
    output_video_url TEXT,
    request_json TEXT NOT NULL,
    error TEXT,
    execution_elapsed_seconds REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_external_video_jobs_canvas_created
    ON external_video_jobs(canvas_id, created_at DESC);
";

const JOB_COLUMNS: &str = "id, canvas_id, provider, provider_label, model_id, model_label,
    generator_node_id, placeholder_node_id, user_id, status, stage_message, cost_credits,
    quote_summary, remote_project_id, remote_node_id, remote_submit_id, remote_thread_id,
    working_dir, output_asset_path, output_video_url, request_json, error,
    execution_elapsed_seconds, created_at, updated_at";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalVideoSubmitInput {
    pub canvas_id: String,
    pub provider: ProviderId,
    #[serde(default)]
    pub model_id: Option<String>,
    pub prompt: String,
    #[serde(default = "default_duration_seconds")]
    pub duration_seconds: i64,
    #[serde(default = "default_aspect_ratio")]
    pub aspect_ratio: String,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub enable_sound: Option<bool>,
    pub generator_node_id: String,
    pub placeholder_node_id: String,
    #[serde(default)]
    pub image_paths: Vec<String>,
    #[serde(default)]
    pub video_paths: Vec<String>,
    #[serde(default)]
    pub audio_paths: Vec<String>,
    #[serde(default)]
    pub prompt_version_label: Option<String>,
    #[serde(default)]
    pub prompt_source_node_id: Option<String>,
    #[serde(default)]
    pub prompt_source_title: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

fn default_duration_seconds() -> i64 {
    5
}

fn default_aspect_ratio() -> String {
    "16:9".to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalVideoJobRecord {
    pub id: String,
    pub canvas_id: String,
    pub provider: ProviderId,
    pub provider_label: String,
    pub model_id: String,
    pub model_label: String,
    pub generator_node_id: String,
    pub placeholder_node_id: String,
    pub user_id: String,
    pub status: String,
    pub stage_message: String,
    pub cost_credits: Option<i64>,
    pub quote_summary: Option<String>,
    pub remote_project_id: Option<String>,
    pub remote_node_id: Option<String>,
    pub remote_submit_id: Option<String>,
    pub remote_thread_id: Option<String>,
    pub working_dir: Option<String>,
    pub output_asset_path: Option<String>,
    pub output_video_url: Option<String>,
    #[serde(skip_serializing)]
    pub request_json: String,
    pub error: Option<String>,
    pub execution_elapsed_seconds: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) struct ExternalJobStore {
    connection: Mutex<Connection>,
    cancel_signals: Mutex<HashMap<String, watch::Sender<bool>>>,
    libtv_workspace_lock: Arc<AsyncMutex<()>>,
}

impl ExternalJobStore {
    pub fn open(database: &Path) -> Result<Self, String> {
        let connection = Connection::open(database).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
            cancel_signals: Mutex::new(HashMap::new()),
            libtv_workspace_lock: Arc::new(AsyncMutex::new(())),
        })
    }

    fn map_row(row: &Row<'_>) -> rusqlite::Result<ExternalVideoJobRecord> {
        let provider_raw: String = row.get(2)?;
        let provider = ProviderId::from_str(&provider_raw).unwrap_or(ProviderId::JimengCn);
        Ok(ExternalVideoJobRecord {
            id: row.get(0)?,
            canvas_id: row.get(1)?,
            provider,
            provider_label: row.get(3)?,
            model_id: row.get(4)?,
            model_label: row.get(5)?,
            generator_node_id: row.get(6)?,
            placeholder_node_id: row.get(7)?,
            user_id: row.get(8)?,
            status: row.get(9)?,
            stage_message: row.get(10)?,
            cost_credits: row.get(11)?,
            quote_summary: row.get(12)?,
            remote_project_id: row.get(13)?,
            remote_node_id: row.get(14)?,
            remote_submit_id: row.get(15)?,
            remote_thread_id: row.get(16)?,
            working_dir: row.get(17)?,
            output_asset_path: row.get(18)?,
            output_video_url: row.get(19)?,
            request_json: row.get(20)?,
            error: row.get(21)?,
            execution_elapsed_seconds: row.get(22)?,
            created_at: row.get(23)?,
            updated_at: row.get(24)?,
        })
    }

    pub fn insert(&self, job: &ExternalVideoJobRecord) -> Result<(), String> {
        let conn = self.connection.lock().map_err(|_| "外部任务存储锁已损坏".to_owned())?;
        conn.execute(
            "INSERT INTO external_video_jobs (
                id, canvas_id, provider, provider_label, model_id, model_label,
                generator_node_id, placeholder_node_id, user_id, status, stage_message, cost_credits,
                quote_summary, remote_project_id, remote_node_id, remote_submit_id, remote_thread_id,
                working_dir, output_asset_path, output_video_url, request_json, error,
                execution_elapsed_seconds, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21, ?22,
                ?23, ?24, ?25
            )",
            params![
                job.id,
                job.canvas_id,
                job.provider.as_str(),
                job.provider_label,
                job.model_id,
                job.model_label,
                job.generator_node_id,
                job.placeholder_node_id,
                job.user_id,
                job.status,
                job.stage_message,
                job.cost_credits,
                job.quote_summary,
                job.remote_project_id,
                job.remote_node_id,
                job.remote_submit_id,
                job.remote_thread_id,
                job.working_dir,
                job.output_asset_path,
                job.output_video_url,
                job.request_json,
                job.error,
                job.execution_elapsed_seconds,
                job.created_at,
                job.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get(&self, job_id: &str) -> Result<Option<ExternalVideoJobRecord>, String> {
        let conn = self.connection.lock().map_err(|_| "外部任务存储锁已损坏".to_owned())?;
        conn.query_row(
            &format!("SELECT {JOB_COLUMNS} FROM external_video_jobs WHERE id = ?1"),
            [job_id],
            Self::map_row,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn update(&self, job: &ExternalVideoJobRecord) -> Result<(), String> {
        let conn = self.connection.lock().map_err(|_| "外部任务存储锁已损坏".to_owned())?;
        conn.execute(
            "UPDATE external_video_jobs SET
                status = ?2,
                stage_message = ?3,
                cost_credits = ?4,
                quote_summary = ?5,
                remote_project_id = ?6,
                remote_node_id = ?7,
                remote_submit_id = ?8,
                remote_thread_id = ?9,
                working_dir = ?10,
                output_asset_path = ?11,
                output_video_url = ?12,
                error = ?13,
                execution_elapsed_seconds = ?14,
                updated_at = ?15
             WHERE id = ?1",
            params![
                job.id,
                job.status,
                job.stage_message,
                job.cost_credits,
                job.quote_summary,
                job.remote_project_id,
                job.remote_node_id,
                job.remote_submit_id,
                job.remote_thread_id,
                job.working_dir,
                job.output_asset_path,
                job.output_video_url,
                job.error,
                job.execution_elapsed_seconds,
                job.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn register_cancel(&self, job_id: &str) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        if let Ok(mut map) = self.cancel_signals.lock() {
            map.insert(job_id.to_owned(), tx);
        }
        rx
    }

    fn clear_cancel(&self, job_id: &str) {
        if let Ok(mut map) = self.cancel_signals.lock() {
            map.remove(job_id);
        }
    }

    pub fn trigger_cancel(&self, job_id: &str) {
        if let Ok(map) = self.cancel_signals.lock() {
            if let Some(tx) = map.get(job_id) {
                let _ = tx.send(true);
            }
        }
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn build_resource_url(asset_path: &str) -> String {
    let mut url = reqwest::Url::parse("http://localhost/api/resource").expect("valid base url");
    url.query_pairs_mut().append_pair("resource", asset_path);
    format!("/api/resource?{}", url.query().unwrap_or(""))
}

fn allowed_media_roots(state: &WebState) -> Vec<PathBuf> {
    let mut roots = vec![
        state.core.assets_dir.clone(),
        state.core.data_dir.join("assets"),
        state.core.data_dir.join("uploads"),
        state.core.data_dir.join("temp"),
        state.downloads.clone(),
        state.core.data_dir.join(crate::colab_channel::COLAB_OUTPUTS_DIR),
        state.core.data_dir.join(PROVIDER_OUTPUTS_DIR),
    ];
    if !state.config.comfy_input_directory.trim().is_empty() {
        roots.push(PathBuf::from(state.config.comfy_input_directory.trim()));
    }
    if !state.config.comfy_output_directory.trim().is_empty() {
        roots.push(PathBuf::from(state.config.comfy_output_directory.trim()));
    }
    roots
}

fn extract_resource_ref(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("sucanvas://")
        || trimmed.starts_with("sucanvas-input://")
        || trimmed.starts_with("sucanvas-output://")
    {
        return Some(trimmed.to_owned());
    }
    let parsed = if trimmed.starts_with('/') {
        reqwest::Url::parse(&format!("http://localhost{trimmed}")).ok()
    } else {
        reqwest::Url::parse(trimmed).ok()
    }?;
    if parsed.path() == "/api/resource" {
        return parsed
            .query_pairs()
            .find(|(k, _)| k == "resource")
            .map(|(_, v)| v.into_owned());
    }
    if parsed.path() == "/api/comfy/view" {
        let filename = parsed
            .query_pairs()
            .find(|(k, _)| k == "filename")
            .map(|(_, v)| v.into_owned())
            .filter(|v| !v.is_empty())?;
        let subfolder = parsed
            .query_pairs()
            .find(|(k, _)| k == "subfolder")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        let file_type = parsed
            .query_pairs()
            .find(|(k, _)| k == "type")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_else(|| "output".to_owned());
        let rel = if subfolder.is_empty() {
            filename
        } else {
            format!("{}/{}", subfolder.trim_matches(&['/', '\\'][..]), filename)
        };
        if file_type.eq_ignore_ascii_case("input") {
            return Some(format!("sucanvas-input://{rel}"));
        }
        return Some(format!("sucanvas-output://{rel}"));
    }
    None
}

pub(crate) fn resolve_local_media_files(state: &WebState, refs: &[String]) -> Result<Vec<PathBuf>, String> {
    let roots = allowed_media_roots(state);
    let mut resolved = Vec::new();
    for raw in refs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = if let Some(resource_ref) = extract_resource_ref(trimmed) {
            storage::resource_path(state, &resource_ref)?
        } else {
            PathBuf::from(trimmed)
        };
        ensure_contained(&path, &roots)?;
        if !path.is_file() {
            return Err(format!("参考素材不存在：{}", path.display()));
        }
        resolved.push(path);
    }
    Ok(resolved)
}

fn find_canvas_node(state: &WebState, canvas_id: &str, node_id: &str) -> Option<NodeRecord> {
    let snapshot = state.core.database.load_project(canvas_id).ok()?;
    snapshot.nodes.into_iter().find(|n| n.id == node_id)
}

fn patch_node_content(
    state: &WebState,
    canvas_id: &str,
    node_id: &str,
    new_record_status: Option<&str>,
    new_title: Option<String>,
    mutate: impl FnOnce(&mut Map<String, Value>),
) {
    let Some(node) = find_canvas_node(state, canvas_id, node_id) else {
        return;
    };
    let mut content = node.content.as_object().cloned().unwrap_or_default();
    mutate(&mut content);
    if let Ok(updated) = state.core.database.update_node(UpdateNodeInput {
        id: node.id,
        title: new_title,
        content: Some(Value::Object(content)),
        x: None,
        y: None,
        width: None,
        height: None,
        status: new_record_status.map(str::to_owned),
    }) {
        let _ = state.handle.emit("canvas://node-updated", updated);
    }
}

fn sync_nodes_status(
    state: &WebState,
    job: &ExternalVideoJobRecord,
    placeholder_status: &str,
    generator_status: &str,
    stage_message: &str,
    cost_credits: Option<i64>,
    quote_summary: Option<&str>,
    error_msg: Option<&str>,
) {
    patch_node_content(
        state,
        &job.canvas_id,
        &job.placeholder_node_id,
        None,
        None,
        |content| {
            content.insert("status".to_owned(), json!(placeholder_status));
            content.insert("validationMessage".to_owned(), json!(error_msg.unwrap_or(stage_message)));
            content.insert("executionProgress".to_owned(), Value::Null);
            content.insert("externalJobId".to_owned(), json!(job.id));
            content.insert("externalProvider".to_owned(), json!(job.provider.as_str()));
            content.insert("externalProviderLabel".to_owned(), json!(job.provider_label));
            content.insert("externalModelId".to_owned(), json!(job.model_id));
            content.insert("externalModelLabel".to_owned(), json!(job.model_label));
            if let Some(credits) = cost_credits {
                content.insert("externalCostCredits".to_owned(), json!(credits));
            }
            if let Some(summary) = quote_summary {
                content.insert("externalQuoteSummary".to_owned(), json!(summary));
            }
        },
    );

    patch_node_content(
        state,
        &job.canvas_id,
        &job.generator_node_id,
        Some(generator_status),
        None,
        |content| {
            content.insert("externalJobId".to_owned(), json!(job.id));
            content.insert("externalJobStatus".to_owned(), json!(job.status));
            content.insert("externalStageMessage".to_owned(), json!(stage_message));
            if let Some(credits) = cost_credits {
                content.insert("externalCostCredits".to_owned(), json!(credits));
            } else if generator_status == "idle" {
                content.remove("externalCostCredits");
            }
            if let Some(summary) = quote_summary {
                content.insert("externalQuoteSummary".to_owned(), json!(summary));
            } else if generator_status == "idle" {
                content.remove("externalQuoteSummary");
            }
        },
    );
}

fn update_job_stage(
    state: &WebState,
    job: &mut ExternalVideoJobRecord,
    status: &str,
    stage_message: &str,
) -> Result<(), String> {
    job.status = status.to_owned();
    job.stage_message = stage_message.to_owned();
    job.updated_at = now_rfc3339();
    state.external_jobs.update(job)?;
    sync_nodes_status(
        state,
        job,
        status,
        if status == "awaiting_confirmation" {
            "awaiting_confirmation"
        } else {
            "running"
        },
        stage_message,
        job.cost_credits,
        job.quote_summary.as_deref(),
        None,
    );
    Ok(())
}

fn parse_numeric_aspect(ratio: &str) -> f64 {
    let mut parts = ratio.trim().split(':');
    let Some(w) = parts.next().and_then(|s| s.parse::<f64>().ok()) else {
        return 16.0 / 9.0;
    };
    let Some(h) = parts.next().and_then(|s| s.parse::<f64>().ok()) else {
        return 16.0 / 9.0;
    };
    if w > 0.0 && h > 0.0 {
        w / h
    } else {
        16.0 / 9.0
    }
}

fn sanitize_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "seedance_video".to_owned()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn prepare_output_location(
    state: &WebState,
    job: &ExternalVideoJobRecord,
    ext: &str,
) -> Result<(PathBuf, String, String, String, String), String> {
    let date_folder = Utc::now().format("%Y-%m-%d").to_string();
    let clean_ext = ext
        .trim()
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    let final_ext = if clean_ext.is_empty() {
        "mp4".to_owned()
    } else {
        clean_ext
    };
    let short_id = &job.id[..job.id.len().min(8)];
    let stem = sanitize_stem(&job.model_id);
    let filename = format!("{}_{}_{}.{}", job.provider.as_str(), stem, short_id, final_ext);
    let subfolder = format!("{}/{}", job.provider.as_str(), date_folder);
    let provider_root = state.core.data_dir.join(PROVIDER_OUTPUTS_DIR);
    let target_dir = provider_root.join(job.provider.as_str()).join(&date_folder);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建平台视频输出目录失败：{e}"))?;
    let target_path = target_dir.join(&filename);
    ensure_contained(&target_path, &[provider_root])?;
    let asset_path = format!("sucanvas://{PROVIDER_OUTPUTS_DIR}/{subfolder}/{filename}");
    let video_url = build_resource_url(&asset_path);
    Ok((target_path, asset_path, video_url, subfolder, filename))
}

fn finalize_job_success(
    state: &WebState,
    job: &mut ExternalVideoJobRecord,
    input: &ExternalVideoSubmitInput,
    asset_path: String,
    video_url: String,
    subfolder: String,
    filename: String,
    elapsed_seconds: f64,
) -> Result<(), String> {
    let _ = state.media.register(
        &state.media_roots(),
        &asset_path,
        "generated",
        &job.user_id,
        Utc::now(),
    );

    let spec = resolve_model_spec(job.provider, Some(&job.model_id));
    let resolution = input
        .resolution
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| spec.default_resolution.clone());
    let mode = input
        .mode
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "auto".to_owned());

    let snapshot = json!({
        "generationChannel": job.provider.as_str(),
        "externalProvider": job.provider.as_str(),
        "externalProviderLabel": job.provider_label,
        "externalModelId": job.model_id,
        "externalModelLabel": job.model_label,
        "externalResolution": resolution,
        "externalMode": mode,
        "externalQuotedCredits": job.cost_credits,
        "externalEnableSound": input.enable_sound.unwrap_or(true),
        "durationSeconds": input.duration_seconds,
        "aspectRatio": input.aspect_ratio,
        "prompt": input.prompt,
        "promptVersionLabel": input.prompt_version_label,
        "promptSourceTitle": input.prompt_source_title,
        "promptSourceNodeId": input.prompt_source_node_id,
    });

    let title = format!("生成视频 · {} · {}", job.provider_label, job.model_label);
    let aspect_numeric = parse_numeric_aspect(&input.aspect_ratio);

    patch_node_content(
        state,
        &job.canvas_id,
        &job.placeholder_node_id,
        Some("ready"),
        Some(title),
        |content| {
            content.insert("status".to_owned(), json!("ready"));
            content.insert("validationMessage".to_owned(), Value::Null);
            content.insert("executionProgress".to_owned(), Value::Null);
            content.insert("videoUrl".to_owned(), json!(video_url));
            content.insert("assetPath".to_owned(), json!(asset_path));
            content.insert("originalName".to_owned(), json!(filename));
            content.insert("filename".to_owned(), json!(filename));
            content.insert("subfolder".to_owned(), json!(subfolder));
            content.insert("fileType".to_owned(), json!("output"));
            content.insert("sourceGeneratorId".to_owned(), json!(job.generator_node_id));
            content.insert("aspectRatio".to_owned(), json!(aspect_numeric));
            content.insert("generationElapsedSeconds".to_owned(), json!(elapsed_seconds));
            content.insert("generationSnapshot".to_owned(), snapshot);
            content.insert("externalProvider".to_owned(), json!(job.provider.as_str()));
            content.insert("externalProviderLabel".to_owned(), json!(job.provider_label));
            content.insert("externalModelId".to_owned(), json!(job.model_id));
            content.insert("externalModelLabel".to_owned(), json!(job.model_label));
            content.insert("externalJobId".to_owned(), json!(job.id));
            if let Some(credits) = job.cost_credits {
                content.insert("externalCostCredits".to_owned(), json!(credits));
            }
            content.insert("hasBeenPlayed".to_owned(), json!(false));
        },
    );

    patch_node_content(
        state,
        &job.canvas_id,
        &job.generator_node_id,
        Some("idle"),
        None,
        |content| {
            content.insert("externalJobId".to_owned(), json!(job.id));
            content.insert("externalJobStatus".to_owned(), json!("succeeded"));
            content.insert("externalStageMessage".to_owned(), json!("生成完成"));
            content.remove("externalCostCredits");
            content.remove("externalQuoteSummary");
        },
    );

    job.status = "succeeded".to_owned();
    job.stage_message = "视频生成完成".to_owned();
    job.output_asset_path = Some(asset_path);
    job.output_video_url = Some(video_url);
    job.execution_elapsed_seconds = Some(elapsed_seconds);
    job.error = None;
    job.updated_at = now_rfc3339();
    state.external_jobs.update(job)?;
    Ok(())
}

fn finalize_job_error(state: &WebState, job: &mut ExternalVideoJobRecord, cancelled: bool, message: &str) {
    let status = if cancelled { "cancelled" } else { "failed" };
    let node_status = if cancelled { "cancelled" } else { "invalid" };
    job.status = status.to_owned();
    job.stage_message = message.to_owned();
    job.error = Some(message.to_owned());
    job.updated_at = now_rfc3339();
    let _ = state.external_jobs.update(job);
    sync_nodes_status(
        state,
        job,
        node_status,
        "idle",
        message,
        None,
        None,
        Some(message),
    );
    state.external_jobs.clear_cancel(&job.id);
}

async fn run_cancellable_command(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(&str, &str)],
    timeout: Duration,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<(i32, String, String), (bool, String)> {
    if *cancel_rx.borrow() {
        return Err((true, "用户已取消任务".to_owned()));
    }
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let child = cmd
        .spawn()
        .map_err(|e| (false, format!("启动平台 CLI 失败：{e}")))?;

    tokio::select! {
        res = tokio::time::timeout(timeout, child.wait_with_output()) => {
            match res {
                Ok(Ok(out)) => {
                    let code = out.status.code().unwrap_or(-1);
                    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                    Ok((code, stdout, stderr))
                }
                Ok(Err(e)) => Err((false, format!("等待平台 CLI 执行失败：{e}"))),
                Err(_) => Err((false, "平台 CLI 执行超时".to_owned())),
            }
        }
        _ = async {
            while !*cancel_rx.borrow() {
                if cancel_rx.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        } => {
            Err((true, "用户已取消生成任务".to_owned()))
        }
    }
}

fn format_dreamina_cli_error(rc: i32, parsed: Option<&Value>, stdout: &str, stderr: &str) -> String {
    if let Some(val) = parsed {
        if let Some(err) = val.get("error") {
            let code = err.get("code").and_then(Value::as_i64);
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("");
            let reason = err.get("reason").and_then(Value::as_str).unwrap_or("");
            let diags = err
                .get("diagnostics")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|d| d.get("detail").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default();
            let mut parts = Vec::new();
            if let Some(c) = code {
                parts.push(format!("code={c}"));
            }
            if !reason.is_empty() {
                parts.push(reason.to_owned());
            }
            if !msg.is_empty() {
                parts.push(msg.to_owned());
            }
            if !diags.is_empty() {
                parts.push(diags);
            }
            if !parts.is_empty() {
                return parts.join(" | ");
            }
        }
    }
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    format!("即梦 CLI 返回错误（exit={rc}）：{detail}")
}

async fn dreamina_cli_call(
    bin: &Path,
    provider: ProviderId,
    subargs: &[String],
    yes: bool,
    timeout: Duration,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<(i32, Option<Value>, String, String), (bool, String)> {
    let mut full: Vec<String> = provider
        .dreamina_profile_args()
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    full.extend(["--format".into(), "json".into(), "--non-interactive".into()]);
    if yes {
        full.push("--yes".into());
    }
    full.extend(subargs.iter().cloned());
    let bin_str = bin.to_string_lossy().into_owned();
    let (rc, stdout, stderr) =
        run_cancellable_command(&bin_str, &full, None, &[], timeout, cancel_rx).await?;
    let parsed = parse_json_or_last_ndjson(&stdout).or_else(|| parse_json_or_last_ndjson(&stderr));
    Ok((rc, parsed, stdout, stderr))
}

async fn resolve_dreamina_project_id(
    bin: &Path,
    provider: ProviderId,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<String, (bool, String)> {
    let env_vars: &[&str] = match provider {
        ProviderId::JimengCn => &["JIMENG_CN_PROJECT_ID", "DREAMINA_CN_PROJECT_ID"],
        ProviderId::DreaminaJp => &["DREAMINA_JP_PROJECT_ID", "DREAMINA_PROJECT_ID"],
        _ => &[],
    };
    for key in env_vars {
        if let Ok(val) = std::env::var(key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_owned());
            }
        }
    }

    let (_, curr_val, _, _) = dreamina_cli_call(
        bin,
        provider,
        &["canvas".into(), "current".into()],
        false,
        Duration::from_secs(20),
        cancel_rx,
    )
    .await?;
    if let Some(pid) = curr_val
        .as_ref()
        .and_then(|v| v.pointer("/data/currentCanvas/canvas/projectId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return Ok(pid.to_owned());
    }

    let (_, ls_val, _, _) = dreamina_cli_call(
        bin,
        provider,
        &["canvas".into(), "ls".into()],
        false,
        Duration::from_secs(20),
        cancel_rx,
    )
    .await?;
    if let Some(pid) = ls_val
        .as_ref()
        .and_then(|v| v.pointer("/data/items/0/projectId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return Ok(pid.to_owned());
    }

    let (rc, create_val, stdout, stderr) = dreamina_cli_call(
        bin,
        provider,
        &[
            "canvas".into(),
            "create".into(),
            "SuCanvas Web".into(),
            "--use".into(),
        ],
        false,
        Duration::from_secs(25),
        cancel_rx,
    )
    .await?;
    if rc != 0 || create_val.as_ref().and_then(|v| v.get("ok")).and_then(Value::as_bool) != Some(true) {
        return Err((
            false,
            format_dreamina_cli_error(rc, create_val.as_ref(), &stdout, &stderr),
        ));
    }
    create_val
        .as_ref()
        .and_then(|v| v.pointer("/data/canvas/projectId").or_else(|| v.pointer("/data/projectId")))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| (false, "无法获取或创建即梦项目画布 ID".to_owned()))
}

fn parse_dreamina_quote_result(resp: &Value) -> Result<(Option<i64>, bool), String> {
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format_dreamina_cli_error(-1, Some(resp), "", ""));
    }
    let data = resp.get("data").unwrap_or(&Value::Null);
    if let Some(item_err) = data
        .get("items")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("error"))
        .filter(|v| !v.is_null())
    {
        let msg = item_err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("报价失败");
        return Err(format!("即梦积分报价失败：{msg}"));
    }
    let credits = data.get("totalMaxCredits").and_then(Value::as_i64);
    let confirmation_required = data
        .get("confirmationRequired")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((credits, confirmation_required))
}

fn parse_dreamina_wait_result(resp: &Value) -> Result<(String, Option<String>), String> {
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format_dreamina_cli_error(-1, Some(resp), "", ""));
    }
    let data = resp.get("data").unwrap_or(&Value::Null);
    let state = data.get("state").and_then(Value::as_str).unwrap_or("");
    let resources = data
        .get("resources")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("等待任务完成时未返回资源（state={state}）"))?;
    let primary = resources
        .first()
        .ok_or_else(|| format!("任务未产生输出视频（state={state}）"))?;
    let res_state = primary.get("state").and_then(Value::as_str).unwrap_or("");
    let service_code = primary.get("serviceCode").and_then(Value::as_i64);
    if state == "failed" || res_state == "failed" || matches!(service_code, Some(20103) | Some(20112)) {
        let msg = primary
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| data.pointer("/submissionError/message").and_then(Value::as_str))
            .unwrap_or("平台审核未通过或生成失败");
        let suffix = if matches!(service_code, Some(20103) | Some(20112)) {
            "（触发内容或资产审核拦截，请修改提示词或更换参考素材，不要原样重试）"
        } else {
            ""
        };
        return Err(format!("{msg}{suffix}"));
    }
    let resource_id = primary
        .get("resourceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "生成完成但缺少 resourceId".to_owned())?;
    let format = primary
        .get("format")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok((resource_id.to_owned(), format))
}

async fn run_dreamina_prepare_and_quote(
    state: &WebState,
    job: &mut ExternalVideoJobRecord,
    input: &ExternalVideoSubmitInput,
    bin: &Path,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), (bool, String)> {
    update_job_stage(state, job, "running", &format!("正在连接{}画布…", job.provider_label))
        .map_err(|e| (false, e))?;

    let project_id = resolve_dreamina_project_id(bin, job.provider, &mut cancel_rx).await?;
    job.remote_project_id = Some(project_id.clone());
    let _ = state.external_jobs.update(job);

    let mut all_ref_inputs = Vec::new();
    all_ref_inputs.extend(input.image_paths.iter().cloned());
    all_ref_inputs.extend(input.video_paths.iter().cloned());
    all_ref_inputs.extend(input.audio_paths.iter().cloned());

    let local_refs = resolve_local_media_files(state, &all_ref_inputs).map_err(|e| (false, e))?;
    let mut uploaded_refs = Vec::new();
    if !local_refs.is_empty() {
        update_job_stage(
            state,
            job,
            "running",
            &format!("正在上传 {} 个参考素材到{}…", local_refs.len(), job.provider_label),
        )
        .map_err(|e| (false, e))?;
        for file_path in &local_refs {
            let args = vec![
                "resource".into(),
                "upload".into(),
                "--project-id".into(),
                project_id.clone(),
                "--file".into(),
                file_path.to_string_lossy().into_owned(),
            ];
            let (rc, parsed, stdout, stderr) = dreamina_cli_call(
                bin,
                job.provider,
                &args,
                false,
                Duration::from_secs(120),
                &mut cancel_rx,
            )
            .await?;
            if rc != 0
                || parsed
                    .as_ref()
                    .and_then(|v| v.get("ok"))
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return Err((
                    false,
                    format_dreamina_cli_error(rc, parsed.as_ref(), &stdout, &stderr),
                ));
            }
            let res_id = parsed
                .as_ref()
                .and_then(|v| {
                    v.pointer("/data/resource/resourceId")
                        .or_else(|| v.pointer("/data/resourceId"))
                })
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| (false, "上传素材成功但未返回 resourceId".to_owned()))?;
            uploaded_refs.push(format!("res:{res_id}"));
        }
    }

    let spec = resolve_model_spec(job.provider, Some(&job.model_id));
    let resolution = input
        .resolution
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&spec.default_resolution)
        .to_owned();
    let mode = match input.mode.as_deref().map(str::trim) {
        Some(m) if !m.is_empty() && m != "auto" => m.to_owned(),
        _ => {
            if !uploaded_refs.is_empty() || input.prompt.contains("{{res:") || input.prompt.contains("{{node:") {
                "m2v".to_owned()
            } else {
                "t2v".to_owned()
            }
        }
    };

    update_job_stage(
        state,
        job,
        "running",
        &format!("正在{}创建 {} 生成任务并查询积分报价…", job.provider_label, job.model_label),
    )
    .map_err(|e| (false, e))?;

    let mut create_args = vec![
        "node".into(),
        "create".into(),
        "video".into(),
        "--model".into(),
        job.model_id.clone(),
        "--mode".into(),
        mode,
        "--duration".into(),
        input.duration_seconds.to_string(),
        "--ratio".into(),
        input.aspect_ratio.clone(),
        "--resolution".into(),
        resolution,
        "--count".into(),
        "1".into(),
        "--title".into(),
        input
            .title
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("SuCanvas {}", job.model_label)),
        "--prompt".into(),
        input.prompt.clone(),
        "--project-id".into(),
        project_id.clone(),
    ];
    for rf in &uploaded_refs {
        create_args.push("--ref".into());
        create_args.push(rf.clone());
    }

    let (rc_c, create_resp, stdout_c, stderr_c) = dreamina_cli_call(
        bin,
        job.provider,
        &create_args,
        false,
        Duration::from_secs(60),
        &mut cancel_rx,
    )
    .await?;
    if rc_c != 0
        || create_resp
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err((
            false,
            format_dreamina_cli_error(rc_c, create_resp.as_ref(), &stdout_c, &stderr_c),
        ));
    }
    let node_id = create_resp
        .as_ref()
        .and_then(|v| v.pointer("/data/node/nodeId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| (false, "创建远端视频节点失败：未返回 nodeId".to_owned()))?
        .to_owned();
    job.remote_node_id = Some(node_id.clone());
    let _ = state.external_jobs.update(job);

    // Mandatory prompt readback integrity verification
    let (rc_s, show_resp, stdout_s, stderr_s) = dreamina_cli_call(
        bin,
        job.provider,
        &[
            "node".into(),
            "show".into(),
            "--project-id".into(),
            project_id.clone(),
            "--node-id".into(),
            node_id.clone(),
        ],
        false,
        Duration::from_secs(30),
        &mut cancel_rx,
    )
    .await?;
    if rc_s == 0 {
        if let Some(remote_prompt) = show_resp
            .as_ref()
            .and_then(|v| v.pointer("/data/nodes/0/node/generation/prompt"))
            .and_then(Value::as_str)
        {
            if remote_prompt.trim() != input.prompt.trim() {
                return Err((
                    false,
                    format!(
                        "远端提示词回读校验失败（本地 {} 字 vs 远端 {} 字）",
                        input.prompt.trim().chars().count(),
                        remote_prompt.trim().chars().count()
                    ),
                ));
            }
        }
    } else {
        return Err((
            false,
            format_dreamina_cli_error(rc_s, show_resp.as_ref(), &stdout_s, &stderr_s),
        ));
    }

    let (rc_q, quote_resp, stdout_q, stderr_q) = dreamina_cli_call(
        bin,
        job.provider,
        &[
            "node".into(),
            "quote".into(),
            "--project-id".into(),
            project_id,
            "--node-id".into(),
            node_id,
        ],
        false,
        Duration::from_secs(30),
        &mut cancel_rx,
    )
    .await?;
    if rc_q != 0 {
        return Err((
            false,
            format_dreamina_cli_error(rc_q, quote_resp.as_ref(), &stdout_q, &stderr_q),
        ));
    }
    let Some(qval) = quote_resp else {
        return Err((false, "无法解析积分报价返回".to_owned()));
    };
    let (credits, _confirm_req) = parse_dreamina_quote_result(&qval).map_err(|e| (false, e))?;
    let quote_summary = match credits {
        Some(c) => format!("预计消耗 {c} 积分（{} · {}），请确认后继续生成", job.provider_label, job.model_label),
        None => format!("{} · {} 已完成预检，请确认后开始生成", job.provider_label, job.model_label),
    };
    job.cost_credits = credits;
    job.quote_summary = Some(quote_summary.clone());
    update_job_stage(state, job, "awaiting_confirmation", &quote_summary).map_err(|e| (false, e))?;
    Ok(())
}

async fn run_dreamina_confirm_and_wait(
    state: &WebState,
    job: &mut ExternalVideoJobRecord,
    input: &ExternalVideoSubmitInput,
    bin: &Path,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), (bool, String)> {
    let started = Instant::now();
    let project_id = job
        .remote_project_id
        .clone()
        .ok_or_else(|| (false, "缺少即梦画布 projectId".to_owned()))?;
    let node_id = job
        .remote_node_id
        .clone()
        .ok_or_else(|| (false, "缺少即梦节点 nodeId".to_owned()))?;

    update_job_stage(
        state,
        job,
        "confirming",
        &format!("正在确认积分并提交{}生成任务…", job.provider_label),
    )
    .map_err(|e| (false, e))?;

    let ceiling = job.cost_credits.unwrap_or(9999).max(1);
    let (rc_cf, cf_resp, stdout_cf, stderr_cf) = dreamina_cli_call(
        bin,
        job.provider,
        &[
            "node".into(),
            "confirm".into(),
            "--project-id".into(),
            project_id.clone(),
            "--node-id".into(),
            node_id.clone(),
            "--credit-ceiling".into(),
            ceiling.to_string(),
        ],
        true,
        Duration::from_secs(30),
        &mut cancel_rx,
    )
    .await?;

    let credit_token = if rc_cf == 0 {
        cf_resp
            .as_ref()
            .and_then(|v| v.pointer("/data/creditConfirmationToken"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else if job.cost_credits.unwrap_or(0) == 0 {
        None
    } else {
        return Err((
            false,
            format_dreamina_cli_error(rc_cf, cf_resp.as_ref(), &stdout_cf, &stderr_cf),
        ));
    };

    let mut submit_id = Uuid::new_v4().to_string();
    let mut run_args = vec![
        "node".into(),
        "run".into(),
        "--project-id".into(),
        project_id.clone(),
        "--node-id".into(),
        node_id,
        "--submit-id".into(),
        submit_id.clone(),
    ];
    if let Some(tok) = credit_token {
        run_args.push("--credit-token".into());
        run_args.push(tok);
    }

    let (rc_r, run_resp, stdout_r, stderr_r) = dreamina_cli_call(
        bin,
        job.provider,
        &run_args,
        true,
        Duration::from_secs(60),
        &mut cancel_rx,
    )
    .await?;
    if rc_r != 0
        || run_resp
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err((
            false,
            format_dreamina_cli_error(rc_r, run_resp.as_ref(), &stdout_r, &stderr_r),
        ));
    }
    if let Some(actual_sid) = run_resp
        .as_ref()
        .and_then(|v| v.pointer("/data/items/0/submitId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        submit_id = actual_sid.to_owned();
    }
    job.remote_submit_id = Some(submit_id.clone());
    update_job_stage(
        state,
        job,
        "running",
        &format!("正在等待{}生成 {} 视频…", job.provider_label, job.model_label),
    )
    .map_err(|e| (false, e))?;

    let (rc_w, wait_resp, stdout_w, stderr_w) = dreamina_cli_call(
        bin,
        job.provider,
        &[
            "operation".into(),
            "wait".into(),
            submit_id,
            "--project-id".into(),
            project_id.clone(),
            "--timeout".into(),
            "12m".into(),
            "--interval".into(),
            "5s".into(),
        ],
        false,
        Duration::from_secs(750),
        &mut cancel_rx,
    )
    .await?;
    if rc_w != 0 {
        return Err((
            false,
            format_dreamina_cli_error(rc_w, wait_resp.as_ref(), &stdout_w, &stderr_w),
        ));
    }
    let Some(wval) = wait_resp else {
        return Err((false, "等待生成结果时未收到有效 JSON".to_owned()));
    };
    let (resource_id, format_ext) = parse_dreamina_wait_result(&wval).map_err(|e| (false, e))?;

    let (target_path, asset_path, video_url, subfolder, filename) =
        prepare_output_location(state, job, format_ext.as_deref().unwrap_or("mp4"))
            .map_err(|e| (false, e))?;

    update_job_stage(
        state,
        job,
        "running",
        &format!("正在下载{}生成的视频到本地服务器…", job.provider_label),
    )
    .map_err(|e| (false, e))?;

    let (rc_d, dl_resp, stdout_d, stderr_d) = dreamina_cli_call(
        bin,
        job.provider,
        &[
            "resource".into(),
            "download".into(),
            resource_id,
            "--project-id".into(),
            project_id,
            "-o".into(),
            target_path.to_string_lossy().into_owned(),
        ],
        false,
        Duration::from_secs(180),
        &mut cancel_rx,
    )
    .await?;
    if rc_d != 0
        || dl_resp
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
            != Some(true)
        || !target_path.is_file()
    {
        return Err((
            false,
            format_dreamina_cli_error(rc_d, dl_resp.as_ref(), &stdout_d, &stderr_d),
        ));
    }

    finalize_job_success(
        state,
        job,
        input,
        asset_path,
        video_url,
        subfolder,
        filename,
        started.elapsed().as_secs_f64(),
    )
    .map_err(|e| (false, e))
}

fn infer_libtv_mode(image_count: usize, video_count: usize, audio_count: usize, requested: Option<&str>) -> String {
    if let Some(mode) = requested.map(str::trim).filter(|m| !m.is_empty() && *m != "auto") {
        return mode.to_owned();
    }
    if video_count > 0 || audio_count > 0 {
        "mixed2video".to_owned()
    } else if image_count == 0 {
        "text2video".to_owned()
    } else if image_count == 1 {
        "singleImage2video".to_owned()
    } else if image_count == 2 {
        "frames2video".to_owned()
    } else {
        "image2video".to_owned()
    }
}

fn parse_libtv_ndjson(stdout: &str) -> (Option<i64>, Vec<String>, Option<String>) {
    let mut merged_status: Option<i64> = None;
    let mut urls = Vec::new();
    let mut prompt: Option<String> = None;

    for raw in stdout.lines() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(s) = val
            .get("status")
            .or_else(|| val.pointer("/taskInfo/status"))
            .or_else(|| val.pointer("/data/status"))
            .or_else(|| val.pointer("/data/taskInfo/status"))
            .and_then(Value::as_i64)
        {
            merged_status = Some(s);
        }
        if let Some(p) = val
            .pointer("/data/params/prompt")
            .or_else(|| val.get("prompt"))
            .and_then(Value::as_str)
        {
            prompt = Some(p.to_owned());
        }
        for candidate in [
            val.get("url"),
            val.pointer("/data/url"),
            val.pointer("/taskInfo/url"),
            val.pointer("/data/taskInfo/url"),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(u) = candidate.as_str().filter(|s| !s.is_empty()) {
                if !urls.iter().any(|existing| existing == u) {
                    urls.push(u.to_owned());
                }
            }
        }
        if let Some(arr) = val
            .pointer("/taskInfo/urls")
            .or_else(|| val.pointer("/data/taskInfo/urls"))
            .and_then(Value::as_array)
        {
            for item in arr {
                if let Some(u) = item.as_str().filter(|s| !s.is_empty()) {
                    if !urls.iter().any(|existing| existing == u) {
                        urls.push(u.to_owned());
                    }
                }
            }
        }
    }
    (merged_status, urls, prompt)
}

async fn ensure_libtv_workspace(
    state: &WebState,
    bin: &Path,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<PathBuf, (bool, String)> {
    let _guard = state.external_jobs.libtv_workspace_lock.lock().await;
    let workspace = state.core.data_dir.join("providers").join("libtv-workspace");
    fs::create_dir_all(&workspace).map_err(|e| (false, format!("创建 LibTV 工作目录失败：{e}")))?;
    let binding_file = workspace.join(".libtv").join("project.json");
    if binding_file.is_file() {
        return Ok(workspace);
    }

    let bin_str = bin.to_string_lossy().into_owned();
    let (rc_ls, stdout_ls, _) = run_cancellable_command(
        &bin_str,
        &["project".into(), "list".into()],
        Some(&workspace),
        &[],
        Duration::from_secs(20),
        cancel_rx,
    )
    .await?;

    let mut project_uuid = if rc_ls == 0 {
        parse_json_or_last_ndjson(&stdout_ls)
            .and_then(|v| {
                v.pointer("/projectMetaList/0/uuid")
                    .or_else(|| v.pointer("/projectMetaList/0/projectUuid"))
                    .or_else(|| v.pointer("/0/uuid"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    if project_uuid.is_none() {
        let (rc_cr, stdout_cr, stderr_cr) = run_cancellable_command(
            &bin_str,
            &[
                "project".into(),
                "create".into(),
                "SuCanvas Web".into(),
                "-w".into(),
                "0".into(),
            ],
            Some(&workspace),
            &[],
            Duration::from_secs(25),
            cancel_rx,
        )
        .await?;
        if rc_cr != 0 {
            return Err((
                false,
                format!("创建 LibTV 默认画布失败：{}", stderr_cr.trim()),
            ));
        }
        project_uuid = parse_json_or_last_ndjson(&stdout_cr).and_then(|v| {
            v.get("uuid")
                .or_else(|| v.get("projectUuid"))
                .or_else(|| v.pointer("/data/uuid"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    }

    if let Some(uuid) = project_uuid {
        let (rc_use, _, stderr_use) = run_cancellable_command(
            &bin_str,
            &["project".into(), "use".into(), uuid],
            Some(&workspace),
            &[],
            Duration::from_secs(20),
            cancel_rx,
        )
        .await?;
        if rc_use != 0 && !binding_file.is_file() {
            return Err((
                false,
                format!("绑定 LibTV 默认画布失败：{}", stderr_use.trim()),
            ));
        }
    }

    if !binding_file.is_file() {
        return Err((
            false,
            format!("未能初始化 LibTV 画布绑定（{}）", binding_file.display()),
        ));
    }
    Ok(workspace)
}

async fn run_libtv_video(
    state: &WebState,
    job: &mut ExternalVideoJobRecord,
    input: &ExternalVideoSubmitInput,
    bin: &Path,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), (bool, String)> {
    let started = Instant::now();
    update_job_stage(state, job, "running", "正在初始化 LibTV 画布…")
        .map_err(|e| (false, e))?;
    let workspace = ensure_libtv_workspace(state, bin, &mut cancel_rx).await?;
    let bin_str = bin.to_string_lossy().into_owned();

    let images = resolve_local_media_files(state, &input.image_paths).map_err(|e| (false, e))?;
    let videos = resolve_local_media_files(state, &input.video_paths).map_err(|e| (false, e))?;
    let audios = resolve_local_media_files(state, &input.audio_paths).map_err(|e| (false, e))?;

    let mut left_nodes = Vec::new();
    let total_refs = images.len() + videos.len() + audios.len();
    if total_refs > 0 {
        update_job_stage(
            state,
            job,
            "running",
            &format!("正在上传 {total_refs} 个参考素材到 LibTV…"),
        )
        .map_err(|e| (false, e))?;
        for (idx, (kind, path)) in images
            .iter()
            .map(|p| ("image", p))
            .chain(videos.iter().map(|p| ("video", p)))
            .chain(audios.iter().map(|p| ("audio", p)))
            .enumerate()
        {
            let short_id = &job.id[..job.id.len().min(8)];
            let ref_name = format!("ref_{short_id}_{idx}");
            let (rc_up, stdout_up, stderr_up) = run_cancellable_command(
                &bin_str,
                &[
                    "upload".into(),
                    ref_name.clone(),
                    "--file".into(),
                    path.to_string_lossy().into_owned(),
                    "-t".into(),
                    kind.into(),
                ],
                Some(&workspace),
                &[],
                Duration::from_secs(120),
                &mut cancel_rx,
            )
            .await?;
            if rc_up != 0 {
                return Err((
                    false,
                    format!("LibTV 上传参考素材失败：{}", stderr_up.trim()),
                ));
            }
            let uploaded_id = parse_json_or_last_ndjson(&stdout_up)
                .and_then(|v| {
                    v.get("id")
                        .or_else(|| v.get("nodeId"))
                        .or_else(|| v.pointer("/data/id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or(ref_name);
            left_nodes.push(uploaded_id);
        }
    }

    let spec = resolve_model_spec(ProviderId::Libtv, Some(&job.model_id));
    let resolution = input
        .resolution
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&spec.default_resolution)
        .to_owned();
    let mode_type = infer_libtv_mode(
        images.len(),
        videos.len(),
        audios.len(),
        input.mode.as_deref(),
    );
    let enable_sound = if input.enable_sound.unwrap_or(true) {
        "on"
    } else {
        "off"
    };
    let node_name = format!("sucanvas_{}", &job.id[..job.id.len().min(10)]);
    let mut args = vec![
        "node".into(),
        "create".into(),
        node_name.clone(),
        "-t".into(),
        "video".into(),
        "--prompt".into(),
        input.prompt.clone(),
        "-s".into(),
        format!("model={}", job.model_id),
        "-s".into(),
        format!("modeType={mode_type}"),
        "-s".into(),
        format!("ratio={}", input.aspect_ratio),
        "-s".into(),
        format!("resolution={resolution}"),
        "-s".into(),
        format!("duration={}", input.duration_seconds),
        "-s".into(),
        format!("enableSound={enable_sound}"),
    ];
    for left in &left_nodes {
        args.push("--left".into());
        args.push(left.clone());
    }
    args.push("--run".into());

    update_job_stage(
        state,
        job,
        "running",
        &format!("正在通过 LibTV 生成 {} 视频…", job.model_label),
    )
    .map_err(|e| (false, e))?;

    let (rc, stdout, stderr) = run_cancellable_command(
        &bin_str,
        &args,
        Some(&workspace),
        &[],
        Duration::from_secs(900),
        &mut cancel_rx,
    )
    .await?;

    if stderr.contains("403") || stderr.contains("不符合平台规则") {
        return Err((
            false,
            format!(
                "LibTV 内容审核拦截（403），请修改提示词后再试，切勿原样重试：{}",
                stderr.trim()
            ),
        ));
    }

    let (mut status_code, mut urls, _prompt) = parse_libtv_ndjson(&stdout);
    if urls.is_empty() && status_code == Some(2) {
        let (rc_rb, stdout_rb, _) = run_cancellable_command(
            &bin_str,
            &["node".into(), node_name],
            Some(&workspace),
            &[],
            Duration::from_secs(20),
            &mut cancel_rx,
        )
        .await?;
        if rc_rb == 0 {
            let (rb_status, rb_urls, _) = parse_libtv_ndjson(&stdout_rb);
            if status_code.is_none() {
                status_code = rb_status;
            }
            urls = rb_urls;
        }
    }

    if status_code != Some(2) {
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err((
            false,
            format!("LibTV 生成未成功（status={status_code:?}, exit={rc}）：{detail}"),
        ));
    }
    let Some(download_url) = urls.first() else {
        return Err((false, "LibTV 生成完成但未返回视频下载地址".to_owned()));
    };

    update_job_stage(state, job, "running", "正在下载 LibTV 生成的视频…")
        .map_err(|e| (false, e))?;
    let (target_path, asset_path, video_url, subfolder, filename) =
        prepare_output_location(state, job, "mp4").map_err(|e| (false, e))?;

    let dl_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| (false, format!("初始化下载客户端失败：{e}")))?;
    let resp = dl_client
        .get(download_url)
        .send()
        .await
        .map_err(|e| (false, format!("下载 LibTV 视频失败：{e}")))?;
    if !resp.status().is_success() {
        return Err((
            false,
            format!("下载 LibTV 视频返回 HTTP {}", resp.status()),
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| (false, format!("读取 LibTV 视频数据失败：{e}")))?;
    fs::write(&target_path, &bytes).map_err(|e| (false, format!("保存 LibTV 视频失败：{e}")))?;

    finalize_job_success(
        state,
        job,
        input,
        asset_path,
        video_url,
        subfolder,
        filename,
        started.elapsed().as_secs_f64(),
    )
    .map_err(|e| (false, e))
}

fn lovart_has_asset_moderation_rejection(val: &Value) -> bool {
    val.get("failures")
        .and_then(Value::as_array)
        .is_some_and(|arr| {
            arr.iter()
                .any(|item| item.to_string().contains("SEEDANCE_ASSET_MODERATION_REJECTED"))
        })
}

fn find_lovart_downloaded_video(val: &Value, work_dir: &Path) -> Option<PathBuf> {
    if let Some(arr) = val.get("downloaded").and_then(Value::as_array) {
        for item in arr {
            if let Some(local) = item.get("local_path").and_then(Value::as_str) {
                let path = PathBuf::from(local);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(work_dir) {
        let mut videos: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "mp4" | "mov" | "webm"))
            })
            .collect();
        videos.sort();
        return videos.pop();
    }
    None
}

async fn run_lovart_submit_or_chat(
    state: &WebState,
    job: &mut ExternalVideoJobRecord,
    input: &ExternalVideoSubmitInput,
    skill_script: &Path,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), (bool, String)> {
    let started = Instant::now();
    let Some((ak, sk)) = resolve_lovart_credentials(&state.core.data_dir) else {
        return Err((
            false,
            "缺少 Lovart AK/SK（LOVART_ACCESS_KEY / LOVART_SECRET_KEY）".to_owned(),
        ));
    };
    let py = resolve_python_executable();
    let script_str = skill_script.to_string_lossy().into_owned();
    let work_dir = state
        .core
        .data_dir
        .join("providers")
        .join("lovart-work")
        .join(&job.id);
    fs::create_dir_all(&work_dir).map_err(|e| (false, format!("创建 Lovart 工作目录失败：{e}")))?;
    job.working_dir = Some(work_dir.to_string_lossy().into_owned());
    let _ = state.external_jobs.update(job);

    let local_images = resolve_local_media_files(state, &input.image_paths).map_err(|e| (false, e))?;
    let mut attachment_urls = Vec::new();
    if !local_images.is_empty() {
        update_job_stage(
            state,
            job,
            "running",
            &format!("正在上传 {} 张参考图片到 Lovart…", local_images.len()),
        )
        .map_err(|e| (false, e))?;
        for img_path in &local_images {
            let args = vec![
                script_str.clone(),
                "upload".into(),
                "--file".into(),
                img_path.to_string_lossy().into_owned(),
            ];
            let (rc_up, stdout_up, stderr_up) = run_cancellable_command(
                &py,
                &args,
                None,
                &[
                    ("PYTHONIOENCODING", "utf-8"),
                    ("LOVART_ACCESS_KEY", &ak),
                    ("LOVART_SECRET_KEY", &sk),
                ],
                Duration::from_secs(120),
                &mut cancel_rx,
            )
            .await?;
            let parsed = parse_json_or_last_ndjson(&stdout_up);
            let uploaded_url = parsed.as_ref().and_then(|v| {
                v.get("url")
                    .or_else(|| v.pointer("/data/url"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            if rc_up != 0 || uploaded_url.is_none() {
                let err_txt = if !stderr_up.trim().is_empty() {
                    stderr_up.trim()
                } else {
                    stdout_up.trim()
                };
                return Err((false, format!("Lovart 上传图片失败：{err_txt}")));
            }
            if let Some(url) = uploaded_url {
                attachment_urls.push(url);
            }
        }
    }

    let prefer_models = json!({ "VIDEO": [job.model_id] }).to_string();
    let skip_hint = format!(
        "直接调用 {}、跳过故事板确认和分镜图（画面比例 {}，时长 {} 秒）",
        job.model_label, input.aspect_ratio, input.duration_seconds
    );
    let final_prompt = if input.prompt.contains("跳过故事板") {
        input.prompt.clone()
    } else {
        format!("{}\n{}", input.prompt.trim(), skip_hint)
    };

    let mut chat_args = vec![
        script_str,
        "chat".into(),
        "--prompt".into(),
        final_prompt,
        "--include-tools".into(),
        job.model_id.clone(),
        "--prefer-models".into(),
        prefer_models,
        "--json".into(),
        "--download".into(),
        "--output-dir".into(),
        work_dir.to_string_lossy().into_owned(),
    ];
    if !attachment_urls.is_empty() {
        chat_args.push("--attachments".into());
        chat_args.extend(attachment_urls);
    }

    update_job_stage(
        state,
        job,
        "running",
        &format!("正在通过 Lovart 请求 {} 生成…", job.model_label),
    )
    .map_err(|e| (false, e))?;

    let (rc_chat, stdout_chat, stderr_chat) = run_cancellable_command(
        &py,
        &chat_args,
        None,
        &[
            ("PYTHONIOENCODING", "utf-8"),
            ("LOVART_ACCESS_KEY", &ak),
            ("LOVART_SECRET_KEY", &sk),
        ],
        Duration::from_secs(900),
        &mut cancel_rx,
    )
    .await?;

    let Some(parsed) = parse_json_or_last_ndjson(&stdout_chat) else {
        let err_txt = if !stderr_chat.trim().is_empty() {
            stderr_chat.trim()
        } else {
            stdout_chat.trim()
        };
        return Err((
            false,
            format!("Lovart 返回无法解析的输出（exit={rc_chat}）：{err_txt}"),
        ));
    };

    if lovart_has_asset_moderation_rejection(&parsed) {
        return Err((
            false,
            "Lovart 参考图审核未通过（SEEDANCE_ASSET_MODERATION_REJECTED），请更换参考图片或改用纯文生视频，切勿裁剪或模糊原图重试".to_owned(),
        ));
    }

    let final_status = parsed
        .get("final_status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let thread_id = parsed
        .get("thread_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(ref tid) = thread_id {
        job.remote_thread_id = Some(tid.clone());
        let _ = state.external_jobs.update(job);
    }

    if final_status == "pending_confirmation" {
        let summary = parsed
            .get("agent_message")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Lovart {} 等待确认积分消耗后开始生成", job.model_label));
        job.quote_summary = Some(summary.clone());
        update_job_stage(state, job, "awaiting_confirmation", &summary)
            .map_err(|e| (false, e))?;
        return Ok(());
    }

    if rc_chat != 0 || parsed.get("generation_succeeded").and_then(Value::as_bool) != Some(true) {
        let msg = parsed
            .get("warning")
            .or_else(|| parsed.get("agent_message"))
            .and_then(Value::as_str)
            .unwrap_or("Lovart 视频生成失败");
        return Err((false, msg.to_owned()));
    }

    let Some(downloaded_file) = find_lovart_downloaded_video(&parsed, &work_dir) else {
        return Err((false, "Lovart 生成成功但未找到本地下载视频文件".to_owned()));
    };
    let ext = downloaded_file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let (target_path, asset_path, video_url, subfolder, filename) =
        prepare_output_location(state, job, ext).map_err(|e| (false, e))?;
    fs::copy(&downloaded_file, &target_path)
        .map_err(|e| (false, format!("保存 Lovart 视频失败：{e}")))?;

    finalize_job_success(
        state,
        job,
        input,
        asset_path,
        video_url,
        subfolder,
        filename,
        started.elapsed().as_secs_f64(),
    )
    .map_err(|e| (false, e))
}

async fn run_lovart_confirm(
    state: &WebState,
    job: &mut ExternalVideoJobRecord,
    input: &ExternalVideoSubmitInput,
    skill_script: &Path,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), (bool, String)> {
    let started = Instant::now();
    let Some((ak, sk)) = resolve_lovart_credentials(&state.core.data_dir) else {
        return Err((
            false,
            "缺少 Lovart AK/SK（LOVART_ACCESS_KEY / LOVART_SECRET_KEY）".to_owned(),
        ));
    };
    let thread_id = job
        .remote_thread_id
        .clone()
        .ok_or_else(|| (false, "缺少 Lovart threadId，无法确认".to_owned()))?;
    let work_dir = job
        .working_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| state.core.data_dir.join("providers").join("lovart-work").join(&job.id));
    fs::create_dir_all(&work_dir).map_err(|e| (false, format!("创建 Lovart 工作目录失败：{e}")))?;

    update_job_stage(
        state,
        job,
        "confirming",
        &format!("正在确认 Lovart {} 生成任务…", job.model_label),
    )
    .map_err(|e| (false, e))?;

    let py = resolve_python_executable();
    let script_str = skill_script.to_string_lossy().into_owned();
    let args = vec![
        script_str,
        "confirm".into(),
        "--thread-id".into(),
        thread_id,
        "--json".into(),
        "--download".into(),
        "--output-dir".into(),
        work_dir.to_string_lossy().into_owned(),
    ];

    let (rc_cf, stdout_cf, stderr_cf) = run_cancellable_command(
        &py,
        &args,
        None,
        &[
            ("PYTHONIOENCODING", "utf-8"),
            ("LOVART_ACCESS_KEY", &ak),
            ("LOVART_SECRET_KEY", &sk),
        ],
        Duration::from_secs(900),
        &mut cancel_rx,
    )
    .await?;

    let Some(parsed) = parse_json_or_last_ndjson(&stdout_cf) else {
        let err_txt = if !stderr_cf.trim().is_empty() {
            stderr_cf.trim()
        } else {
            stdout_cf.trim()
        };
        return Err((
            false,
            format!("Lovart confirm 返回无法解析输出（exit={rc_cf}）：{err_txt}"),
        ));
    };

    if lovart_has_asset_moderation_rejection(&parsed) {
        return Err((
            false,
            "Lovart 参考图审核未通过（SEEDANCE_ASSET_MODERATION_REJECTED），请更换参考图片后重试".to_owned(),
        ));
    }

    if rc_cf != 0 || parsed.get("generation_succeeded").and_then(Value::as_bool) != Some(true) {
        let msg = parsed
            .get("warning")
            .or_else(|| parsed.get("agent_message"))
            .and_then(Value::as_str)
            .unwrap_or("Lovart 确认生成失败");
        return Err((false, msg.to_owned()));
    }

    let Some(downloaded_file) = find_lovart_downloaded_video(&parsed, &work_dir) else {
        return Err((false, "Lovart 确认完成但未找到本地下载视频文件".to_owned()));
    };
    let ext = downloaded_file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let (target_path, asset_path, video_url, subfolder, filename) =
        prepare_output_location(state, job, ext).map_err(|e| (false, e))?;
    fs::copy(&downloaded_file, &target_path)
        .map_err(|e| (false, format!("保存 Lovart 视频失败：{e}")))?;

    finalize_job_success(
        state,
        job,
        input,
        asset_path,
        video_url,
        subfolder,
        filename,
        started.elapsed().as_secs_f64(),
    )
    .map_err(|e| (false, e))
}

pub(crate) async fn submit_video(
    state: WebState,
    user_id: String,
    mut input: ExternalVideoSubmitInput,
) -> Result<ExternalVideoJobRecord, String> {
    if input.prompt.trim().is_empty() {
        return Err("视频生成提示词不能为空".to_owned());
    }
    let spec = resolve_model_spec(input.provider, input.model_id.as_deref());
    input.model_id = Some(spec.id.clone());
    input.duration_seconds = input
        .duration_seconds
        .clamp(spec.min_duration, spec.max_duration);
    if input.aspect_ratio.trim().is_empty() {
        input.aspect_ratio = "16:9".to_owned();
    }

    let bin = resolve_provider_binary(input.provider, &state.executable_root).ok_or_else(|| {
        format!(
            "服务器未找到 {} 对应的 CLI/脚本（请先在服务器配置并登录）",
            input.provider.label()
        )
    })?;

    let job_id = format!("ext-{}", Uuid::new_v4().simple());
    let now = now_rfc3339();
    let request_json = serde_json::to_string(&input).map_err(|e| e.to_string())?;
    let job = ExternalVideoJobRecord {
        id: job_id.clone(),
        canvas_id: input.canvas_id.clone(),
        provider: input.provider,
        provider_label: input.provider.label().to_owned(),
        model_id: spec.id.clone(),
        model_label: spec.label.clone(),
        generator_node_id: input.generator_node_id.clone(),
        placeholder_node_id: input.placeholder_node_id.clone(),
        user_id,
        status: "queued".to_owned(),
        stage_message: format!("已排队，准备调用 {} · {}…", input.provider.label(), spec.label),
        cost_credits: None,
        quote_summary: None,
        remote_project_id: None,
        remote_node_id: None,
        remote_submit_id: None,
        remote_thread_id: None,
        working_dir: None,
        output_asset_path: None,
        output_video_url: None,
        request_json,
        error: None,
        execution_elapsed_seconds: None,
        created_at: now.clone(),
        updated_at: now,
    };
    state.external_jobs.insert(&job)?;
    sync_nodes_status(
        &state,
        &job,
        "running",
        "running",
        &job.stage_message,
        None,
        None,
        None,
    );

    let cancel_rx = state.external_jobs.register_cancel(&job_id);
    let mut bg_job = job.clone();
    tokio::spawn(async move {
        let res = match bg_job.provider {
            ProviderId::JimengCn | ProviderId::DreaminaJp => {
                run_dreamina_prepare_and_quote(&state, &mut bg_job, &input, &bin, cancel_rx).await
            }
            ProviderId::Libtv => {
                run_libtv_video(&state, &mut bg_job, &input, &bin, cancel_rx).await
            }
            ProviderId::Lovart => {
                run_lovart_submit_or_chat(&state, &mut bg_job, &input, &bin, cancel_rx).await
            }
        };
        if let Err((cancelled, message)) = res {
            finalize_job_error(&state, &mut bg_job, cancelled, &message);
        } else if bg_job.status != "awaiting_confirmation" {
            state.external_jobs.clear_cancel(&bg_job.id);
        }
    });

    Ok(job)
}

pub(crate) async fn confirm_video(
    state: WebState,
    mut job: ExternalVideoJobRecord,
) -> Result<ExternalVideoJobRecord, String> {
    if job.status != "awaiting_confirmation" {
        return Err(format!("当前任务状态（{}）不支持确认提交", job.status));
    }
    let input: ExternalVideoSubmitInput =
        serde_json::from_str(&job.request_json).map_err(|e| format!("读取任务参数失败：{e}"))?;
    let bin = resolve_provider_binary(job.provider, &state.executable_root).ok_or_else(|| {
        format!("服务器未找到 {} 对应的 CLI/脚本", job.provider.label())
    })?;

    update_job_stage(&state, &mut job, "confirming", "已确认，正在启动生成…")?;
    let cancel_rx = state.external_jobs.register_cancel(&job.id);
    let mut bg_job = job.clone();
    tokio::spawn(async move {
        let res = match bg_job.provider {
            ProviderId::JimengCn | ProviderId::DreaminaJp => {
                run_dreamina_confirm_and_wait(&state, &mut bg_job, &input, &bin, cancel_rx).await
            }
            ProviderId::Lovart => {
                run_lovart_confirm(&state, &mut bg_job, &input, &bin, cancel_rx).await
            }
            ProviderId::Libtv => Ok(()),
        };
        if let Err((cancelled, message)) = res {
            finalize_job_error(&state, &mut bg_job, cancelled, &message);
        } else {
            state.external_jobs.clear_cancel(&bg_job.id);
        }
    });
    Ok(job)
}

pub(crate) async fn cancel_video(
    state: WebState,
    mut job: ExternalVideoJobRecord,
) -> Result<ExternalVideoJobRecord, String> {
    if matches!(job.status.as_str(), "succeeded" | "failed" | "cancelled") {
        return Ok(job);
    }
    state.external_jobs.trigger_cancel(&job.id);
    finalize_job_error(&state, &mut job, true, "任务已取消");
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_dreamina_quote_and_moderation_codes() {
        let quote = json!({
            "schemaVersion": "1",
            "ok": true,
            "data": { "totalMaxCredits": 35, "confirmationRequired": true, "items": [] }
        });
        assert_eq!(parse_dreamina_quote_result(&quote).unwrap(), (Some(35), true));

        let wait_blocked = json!({
            "ok": true,
            "data": {
                "state": "failed",
                "resources": [{
                    "state": "failed",
                    "serviceCode": 20112,
                    "message": "asset rejected"
                }]
            }
        });
        let err = parse_dreamina_wait_result(&wait_blocked).unwrap_err();
        assert!(err.contains("审核拦截"));
    }

    #[test]
    fn parses_libtv_ndjson_and_infers_mode_types() {
        assert_eq!(infer_libtv_mode(0, 0, 0, None), "text2video");
        assert_eq!(infer_libtv_mode(1, 0, 0, None), "singleImage2video");
        assert_eq!(infer_libtv_mode(2, 0, 0, None), "frames2video");
        assert_eq!(infer_libtv_mode(3, 0, 0, None), "image2video");
        assert_eq!(infer_libtv_mode(1, 1, 0, None), "mixed2video");
        assert_eq!(infer_libtv_mode(2, 0, 0, Some("image2video")), "image2video");

        let ndjson = "{\"status\":1}\n{\"status\":2,\"taskInfo\":{\"url\":\"https://cdn.example/out.mp4\"}}\n";
        let (status, urls, _) = parse_libtv_ndjson(ndjson);
        assert_eq!(status, Some(2));
        assert_eq!(urls, vec!["https://cdn.example/out.mp4"]);
    }

    #[test]
    fn detects_lovart_moderation_and_stores_jobs_in_sqlite() {
        let val = json!({
            "final_status": "failed",
            "failures": [{ "error": "SEEDANCE_ASSET_MODERATION_REJECTED" }]
        });
        assert!(lovart_has_asset_moderation_rejection(&val));

        let temp_dir = std::env::temp_dir().join(format!("ext-jobs-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();
        let store = ExternalJobStore::open(&temp_dir.join("test.sqlite3")).unwrap();
        let mut job = ExternalVideoJobRecord {
            id: "ext-1".into(),
            canvas_id: "canvas:main".into(),
            provider: ProviderId::Libtv,
            provider_label: "LibTV".into(),
            model_id: "Seedance 2.5".into(),
            model_label: "Seedance 2.5".into(),
            generator_node_id: "gen-1".into(),
            placeholder_node_id: "ph-1".into(),
            user_id: "user-1".into(),
            status: "queued".into(),
            stage_message: "queued".into(),
            cost_credits: None,
            quote_summary: None,
            remote_project_id: None,
            remote_node_id: None,
            remote_submit_id: None,
            remote_thread_id: None,
            working_dir: None,
            output_asset_path: None,
            output_video_url: None,
            request_json: "{}".into(),
            error: None,
            execution_elapsed_seconds: None,
            created_at: "2026-11-26T00:00:00Z".into(),
            updated_at: "2026-11-26T00:00:00Z".into(),
        };
        store.insert(&job).unwrap();
        job.status = "succeeded".into();
        job.output_asset_path = Some("sucanvas://provider-outputs/libtv/clip.mp4".into());
        store.update(&job).unwrap();
        let fetched = store.get("ext-1").unwrap().unwrap();
        assert_eq!(fetched.status, "succeeded");
        assert_eq!(
            fetched.output_asset_path.as_deref(),
            Some("sucanvas://provider-outputs/libtv/clip.mp4")
        );
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
