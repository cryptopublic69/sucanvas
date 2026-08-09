use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use reqwest::{multipart, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

use crate::{
    models::{
        AppLockStatus, ComfyClientTaskStatus, ComfyOutputFile, ComfyQueueSummary, ComfySubmitInput,
        ComfySubmitResult, CreateEdgeInput, CreateNodeInput, CreateNodeResult, CreateProjectInput,
        DeleteNodesInput, DeletedBatch, EdgeRecord, NodeRecord, RuntimeInfo, SetAppLockInput,
        SetProjectPrivacyInput, UpdateNodeInput, UpdateProjectInput, WorkspaceSnapshot,
    },
    ApplicationState, RunningComfyTask,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppLockConfig {
    password_hash: String,
}

fn read_app_lock_config(path: &Path) -> Result<Option<AppLockConfig>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|error| format!("无法读取应用锁配置：{error}"))?;
    let config = serde_json::from_slice::<AppLockConfig>(&bytes)
        .map_err(|error| format!("应用锁配置已损坏：{error}"))?;
    if config.password_hash.trim().is_empty() {
        return Err("应用锁配置已损坏：密码哈希为空".to_owned());
    }
    Ok(Some(config))
}

fn password_character_count(password: &str) -> usize {
    password.chars().count()
}

fn validate_new_app_lock_password(password: &str) -> Result<(), String> {
    let length = password_character_count(password);
    if length < 4 {
        return Err("新密码至少需要 4 个字符".to_owned());
    }
    if length > 128 {
        return Err("新密码不能超过 128 个字符".to_owned());
    }
    Ok(())
}

fn hash_app_lock_password(password: &str) -> Result<String, String> {
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes())
        .map_err(|error| format!("无法生成密码盐：{error}"))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| format!("无法创建密码哈希：{error}"))
}

fn verify_app_lock_hash(password: &str, encoded_hash: &str) -> Result<bool, String> {
    let parsed_hash =
        PasswordHash::new(encoded_hash).map_err(|error| format!("应用锁配置已损坏：{error}"))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

fn write_app_lock_config(path: &Path, config: &AppLockConfig) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("无法序列化应用锁配置：{error}"))?;
    std::fs::write(path, bytes).map_err(|error| format!("无法保存应用锁配置：{error}"))
}

#[tauri::command]
pub fn get_app_lock_status(state: State<'_, ApplicationState>) -> Result<AppLockStatus, String> {
    let _guard = state
        .app_lock_guard
        .lock()
        .map_err(|_| "应用锁状态不可用".to_owned())?;
    Ok(AppLockStatus {
        enabled: read_app_lock_config(&state.app_lock_path)?.is_some(),
    })
}

#[tauri::command]
pub async fn verify_app_lock_password(
    password: String,
    state: State<'_, ApplicationState>,
) -> Result<bool, String> {
    let path = state.app_lock_path.clone();
    let guard = state.app_lock_guard.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard.lock().map_err(|_| "应用锁状态不可用".to_owned())?;
        let config = read_app_lock_config(&path)?.ok_or_else(|| "应用锁尚未启用".to_owned())?;
        verify_app_lock_hash(&password, &config.password_hash)
    })
    .await
    .map_err(|error| format!("应用锁验证任务失败：{error}"))?
}

#[tauri::command]
pub async fn set_app_lock_password(
    input: SetAppLockInput,
    state: State<'_, ApplicationState>,
) -> Result<(), String> {
    validate_new_app_lock_password(&input.new_password)?;
    let path = state.app_lock_path.clone();
    let guard = state.app_lock_guard.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard.lock().map_err(|_| "应用锁状态不可用".to_owned())?;
        if let Some(config) = read_app_lock_config(&path)? {
            let current_password = input.current_password.as_deref().unwrap_or_default();
            if !verify_app_lock_hash(current_password, &config.password_hash)? {
                return Err("当前密码错误".to_owned());
            }
        }
        let password_hash = hash_app_lock_password(&input.new_password)?;
        write_app_lock_config(&path, &AppLockConfig { password_hash })
    })
    .await
    .map_err(|error| format!("应用锁设置任务失败：{error}"))?
}

#[tauri::command]
pub async fn disable_app_lock(
    password: String,
    state: State<'_, ApplicationState>,
) -> Result<(), String> {
    let path = state.app_lock_path.clone();
    let guard = state.app_lock_guard.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard.lock().map_err(|_| "应用锁状态不可用".to_owned())?;
        let config = read_app_lock_config(&path)?.ok_or_else(|| "应用锁尚未启用".to_owned())?;
        if !verify_app_lock_hash(&password, &config.password_hash)? {
            return Err("当前密码错误".to_owned());
        }
        std::fs::remove_file(&path).map_err(|error| format!("无法关闭应用锁：{error}"))
    })
    .await
    .map_err(|error| format!("关闭应用锁任务失败：{error}"))?
}

#[tauri::command]
pub fn load_workspace(
    canvas_id: Option<String>,
    state: State<'_, ApplicationState>,
) -> Result<WorkspaceSnapshot, String> {
    let selected_id = match canvas_id {
        Some(canvas_id) => canvas_id,
        None => state
            .active_canvas_id
            .read()
            .map_err(|_| "active project lock is poisoned".to_owned())?
            .clone(),
    };
    let snapshot = state
        .database
        .load_project(&selected_id)
        .map_err(|error| error.to_string())?;
    *state
        .active_canvas_id
        .write()
        .map_err(|_| "active project lock is poisoned".to_owned())? = selected_id;
    Ok(snapshot)
}

#[tauri::command]
pub fn list_projects(state: State<'_, ApplicationState>) -> Result<Vec<WorkspaceSnapshot>, String> {
    state
        .database
        .list_projects()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_project(
    input: CreateProjectInput,
    state: State<'_, ApplicationState>,
) -> Result<WorkspaceSnapshot, String> {
    state
        .database
        .create_project(&input.name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_project(
    input: UpdateProjectInput,
    state: State<'_, ApplicationState>,
) -> Result<crate::models::CanvasRecord, String> {
    state
        .database
        .rename_project(&input.id, &input.name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_project_private(
    input: SetProjectPrivacyInput,
    state: State<'_, ApplicationState>,
) -> Result<crate::models::CanvasRecord, String> {
    state
        .database
        .set_project_private(&input.id, input.is_private)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_project(id: String, state: State<'_, ApplicationState>) -> Result<(), String> {
    state
        .database
        .delete_project(&id)
        .map_err(|error| error.to_string())?;

    let deleted_active_project = state
        .active_canvas_id
        .read()
        .map_err(|_| "active project lock is poisoned".to_owned())?
        .as_str()
        == id;
    if deleted_active_project {
        let fallback_id = state
            .database
            .list_projects()
            .map_err(|error| error.to_string())?
            .first()
            .map(|project| project.canvas.id.clone())
            .unwrap_or_else(|| crate::models::DEFAULT_CANVAS_ID.to_owned());
        *state
            .active_canvas_id
            .write()
            .map_err(|_| "active project lock is poisoned".to_owned())? = fallback_id;
    }
    Ok(())
}

#[tauri::command]
pub fn create_node(
    input: CreateNodeInput,
    state: State<'_, ApplicationState>,
) -> Result<CreateNodeResult, String> {
    state
        .database
        .create_node(input)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct MediaFormat {
    extension: &'static str,
    mime_type: &'static str,
    kind: &'static str,
    max_bytes: u64,
}

const IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const AUDIO_MAX_BYTES: u64 = 512 * 1024 * 1024;
const VIDEO_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

fn media_format(path: &Path) -> Option<MediaFormat> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some(MediaFormat {
            extension: "png",
            mime_type: "image/png",
            kind: "image",
            max_bytes: IMAGE_MAX_BYTES,
        }),
        "jpg" | "jpeg" => Some(MediaFormat {
            extension: "jpg",
            mime_type: "image/jpeg",
            kind: "image",
            max_bytes: IMAGE_MAX_BYTES,
        }),
        "webp" => Some(MediaFormat {
            extension: "webp",
            mime_type: "image/webp",
            kind: "image",
            max_bytes: IMAGE_MAX_BYTES,
        }),
        "gif" => Some(MediaFormat {
            extension: "gif",
            mime_type: "image/gif",
            kind: "image",
            max_bytes: IMAGE_MAX_BYTES,
        }),
        "bmp" => Some(MediaFormat {
            extension: "bmp",
            mime_type: "image/bmp",
            kind: "image",
            max_bytes: IMAGE_MAX_BYTES,
        }),
        "avif" => Some(MediaFormat {
            extension: "avif",
            mime_type: "image/avif",
            kind: "image",
            max_bytes: IMAGE_MAX_BYTES,
        }),
        "mp3" => Some(MediaFormat {
            extension: "mp3",
            mime_type: "audio/mpeg",
            kind: "audio",
            max_bytes: AUDIO_MAX_BYTES,
        }),
        "wav" => Some(MediaFormat {
            extension: "wav",
            mime_type: "audio/wav",
            kind: "audio",
            max_bytes: AUDIO_MAX_BYTES,
        }),
        "m4a" => Some(MediaFormat {
            extension: "m4a",
            mime_type: "audio/mp4",
            kind: "audio",
            max_bytes: AUDIO_MAX_BYTES,
        }),
        "aac" => Some(MediaFormat {
            extension: "aac",
            mime_type: "audio/aac",
            kind: "audio",
            max_bytes: AUDIO_MAX_BYTES,
        }),
        "flac" => Some(MediaFormat {
            extension: "flac",
            mime_type: "audio/flac",
            kind: "audio",
            max_bytes: AUDIO_MAX_BYTES,
        }),
        "ogg" | "oga" => Some(MediaFormat {
            extension: "ogg",
            mime_type: "audio/ogg",
            kind: "audio",
            max_bytes: AUDIO_MAX_BYTES,
        }),
        "opus" => Some(MediaFormat {
            extension: "opus",
            mime_type: "audio/ogg",
            kind: "audio",
            max_bytes: AUDIO_MAX_BYTES,
        }),
        "mp4" => Some(MediaFormat {
            extension: "mp4",
            mime_type: "video/mp4",
            kind: "video",
            max_bytes: VIDEO_MAX_BYTES,
        }),
        "m4v" => Some(MediaFormat {
            extension: "m4v",
            mime_type: "video/x-m4v",
            kind: "video",
            max_bytes: VIDEO_MAX_BYTES,
        }),
        "mov" => Some(MediaFormat {
            extension: "mov",
            mime_type: "video/quicktime",
            kind: "video",
            max_bytes: VIDEO_MAX_BYTES,
        }),
        "webm" => Some(MediaFormat {
            extension: "webm",
            mime_type: "video/webm",
            kind: "video",
            max_bytes: VIDEO_MAX_BYTES,
        }),
        "ogv" => Some(MediaFormat {
            extension: "ogv",
            mime_type: "video/ogg",
            kind: "video",
            max_bytes: VIDEO_MAX_BYTES,
        }),
        "mkv" => Some(MediaFormat {
            extension: "mkv",
            mime_type: "video/x-matroska",
            kind: "video",
            max_bytes: VIDEO_MAX_BYTES,
        }),
        "avi" => Some(MediaFormat {
            extension: "avi",
            mime_type: "video/x-msvideo",
            kind: "video",
            max_bytes: VIDEO_MAX_BYTES,
        }),
        _ => None,
    }
}

#[tauri::command]
pub async fn import_media(
    path: String,
    canvas_id: String,
    x: f64,
    y: f64,
    state: State<'_, ApplicationState>,
) -> Result<CreateNodeResult, String> {
    let database = state.database.clone();
    let assets_dir = state.assets_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_media_blocking(path, canvas_id, x, y, database, assets_dir)
    })
    .await
    .map_err(|error| format!("媒体导入任务失败: {error}"))?
}

fn import_media_blocking(
    path: String,
    canvas_id: String,
    x: f64,
    y: f64,
    database: crate::db::Database,
    assets_dir: PathBuf,
) -> Result<CreateNodeResult, String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("媒体落点无效".to_owned());
    }

    let source = PathBuf::from(&path);
    let source = source
        .canonicalize()
        .map_err(|error| format!("无法读取媒体 {path}: {error}"))?;
    let metadata = source
        .metadata()
        .map_err(|error| format!("无法读取媒体信息: {error}"))?;
    if !metadata.is_file() {
        return Err("拖入的项目不是文件".to_owned());
    }
    let format =
        media_format(&source).ok_or_else(|| "仅支持常见图片、音频和视频格式".to_owned())?;
    if metadata.len() > format.max_bytes {
        let (limit, media_label) = match format.kind {
            "image" => ("64 MiB", "图片"),
            "audio" => ("512 MiB", "音频"),
            _ => ("4 GiB", "视频"),
        };
        return Err(format!("{media_label}文件超过 {limit} 限制",));
    }
    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "媒体文件名不是有效的 Unicode".to_owned())?
        .to_owned();
    let destination = assets_dir.join(format!("asset-{}.{}", Uuid::new_v4(), format.extension));

    std::fs::copy(&source, &destination)
        .map_err(|error| format!("复制媒体到应用数据目录失败: {error}"))?;
    let result = database.create_node(CreateNodeInput {
        canvas_id: Some(canvas_id),
        kind: Some(format.kind.to_owned()),
        title: original_name.clone(),
        content: json!({
            "assetPath": destination.to_string_lossy(),
            "mimeType": format.mime_type,
            "originalName": original_name,
        }),
        source: Some("manual".to_owned()),
        request_id: None,
        x: Some(x),
        y: Some(y),
        width: Some(if format.kind == "video" { 420.0 } else { 360.0 }),
        height: Some(if format.kind == "audio" { 240.0 } else { 300.0 }),
    });

    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ = std::fs::remove_file(&destination);
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub fn update_node(
    input: UpdateNodeInput,
    state: State<'_, ApplicationState>,
) -> Result<NodeRecord, String> {
    state
        .database
        .update_node(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_node(id: String, state: State<'_, ApplicationState>) -> Result<(), String> {
    let asset_path = state
        .database
        .get_node(&id)
        .map_err(|error| error.to_string())?
        .filter(|node| node.kind == "image" || node.kind == "audio" || node.kind == "video")
        .and_then(|node| node.content.get("assetPath")?.as_str().map(PathBuf::from));

    state
        .database
        .delete_node(&id)
        .map_err(|error| error.to_string())?;

    if let Some(asset_path) = asset_path {
        let assets_dir = state.assets_dir.canonicalize().ok();
        let asset_path = asset_path.canonicalize().ok();
        if let (Some(assets_dir), Some(asset_path)) = (assets_dir, asset_path) {
            if asset_path.starts_with(assets_dir) {
                let _ = std::fs::remove_file(asset_path);
            }
        }
    }
    Ok(())
}

fn delete_video_files_blocking(paths: Vec<String>) -> Result<usize, String> {
    if paths.is_empty() {
        return Err("没有可删除的视频文件".to_owned());
    }

    let mut unique_paths = HashSet::new();
    let mut resolved_paths = Vec::new();
    for path in paths {
        let resolved = PathBuf::from(&path)
            .canonicalize()
            .map_err(|error| format!("无法定位视频文件 {path}: {error}"))?;
        let metadata = resolved
            .metadata()
            .map_err(|error| format!("无法读取视频文件信息 {}: {error}", resolved.display()))?;
        if !metadata.is_file() {
            return Err(format!("目标不是文件：{}", resolved.display()));
        }
        let is_video = media_format(&resolved).is_some_and(|format| format.kind == "video");
        if !is_video {
            return Err(format!("拒绝删除非视频文件：{}", resolved.display()));
        }
        if unique_paths.insert(resolved.clone()) {
            resolved_paths.push(resolved);
        }
    }

    for path in &resolved_paths {
        std::fs::remove_file(path)
            .map_err(|error| format!("删除视频文件失败 {}: {error}", path.display()))?;
    }
    Ok(resolved_paths.len())
}

#[tauri::command]
pub async fn delete_video_files(paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || delete_video_files_blocking(paths))
        .await
        .map_err(|error| format!("视频文件删除任务失败: {error}"))?
}

#[tauri::command]
pub fn delete_nodes_undoable(
    input: DeleteNodesInput,
    state: State<'_, ApplicationState>,
) -> Result<DeletedBatch, String> {
    state
        .database
        .delete_nodes_with_snapshot(&input.ids)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn restore_deleted_nodes(
    batch: DeletedBatch,
    state: State<'_, ApplicationState>,
) -> Result<DeletedBatch, String> {
    state
        .database
        .restore_deleted_batch(batch)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_edge(
    input: CreateEdgeInput,
    state: State<'_, ApplicationState>,
) -> Result<EdgeRecord, String> {
    state
        .database
        .create_edge(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_edge(id: String, state: State<'_, ApplicationState>) -> Result<(), String> {
    state
        .database
        .delete_edge(&id)
        .map_err(|error| error.to_string())
}

const H3_PROMPT_NODE_ID: &str = "339";
const H3_SEED_NODE_ID: &str = "348";
const H3_DURATION_NODE_ID: &str = "350";
const H3_PRIMARY_RESOLUTION_NODE_ID: &str = "340";
const H3_SECONDARY_RESOLUTION_NODE_ID: &str = "398";
const H3_PRIMARY_LORA_NODE_ID: &str = "354";
const H3_SECONDARY_LORA_NODE_ID: &str = "401";
const H3_PRIMARY_OUTPUT_NODE_ID: &str = "360";
const H3_SECONDARY_OUTPUT_NODE_ID: &str = "397";
const H3_CLEAN_VIDEO_NODE_ID: &str = "9000";
const H3_CLEAN_SAVE_NODE_ID: &str = "9001";
const H3_SECONDARY_VIDEO_INPUT_NODE_ID: &str = "9002";
const H3_CONDITIONING_NODE_ID: &str = "363";
const H3_AUDIO_NODE_IDS: [&str; 2] = ["374", "416"];
const H3_IMAGE_NODE_IDS: [&str; 9] = [
    "362", "364", "365", "367", "368", "369", "370", "371", "372",
];

fn is_minimax_h3_lora_name(value: &str) -> bool {
    let normalized = value.trim().replace('/', "\\");
    normalized
        .split_once('\\')
        .is_some_and(|(directory, filename)| {
            directory.eq_ignore_ascii_case("MinimaxH3") && !filename.trim().is_empty()
        })
}

fn minimax_h3_loras_from_object_info(value: &Value) -> Vec<String> {
    let mut loras = value
        .pointer("/LoraLoaderModelOnly/input/required/lora_name/0")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| is_minimax_h3_lora_name(name))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    loras.sort_by_key(|name| name.to_ascii_lowercase());
    loras.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    loras
}

#[tauri::command]
pub async fn get_comfyui_h3_loras(server_url: String) -> Result<Vec<String>, String> {
    let parsed_server =
        Url::parse(server_url.trim()).map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    if parsed_server.scheme() != "http" && parsed_server.scheme() != "https" {
        return Err("ComfyUI 地址只允许 http 或 https".to_owned());
    }
    let server_url = server_url.trim().trim_end_matches('/');
    let value = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建 ComfyUI 客户端失败：{error}"))?
        .get(format!("{server_url}/object_info/LoraLoaderModelOnly"))
        .send()
        .await
        .map_err(|error| format!("读取 ComfyUI LoRA 列表失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("读取 ComfyUI LoRA 列表失败：{error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("解析 ComfyUI LoRA 列表失败：{error}"))?;
    Ok(minimax_h3_loras_from_object_info(&value))
}

fn workflow_inputs_mut<'a>(
    workflow: &'a mut Value,
    node_id: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    workflow
        .get_mut(node_id)
        .and_then(Value::as_object_mut)
        .and_then(|node| node.get_mut("inputs"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("API 工作流缺少节点 {node_id} 的 inputs"))
}

fn set_workflow_input(
    workflow: &mut Value,
    node_id: &str,
    input_name: &str,
    value: Value,
) -> Result<(), String> {
    workflow_inputs_mut(workflow, node_id)?.insert(input_name.to_owned(), value);
    Ok(())
}

fn remove_workflow_input(
    workflow: &mut Value,
    node_id: &str,
    input_name: &str,
) -> Result<(), String> {
    workflow_inputs_mut(workflow, node_id)?.remove(input_name);
    Ok(())
}

fn install_clean_video_output(
    workflow: &mut Value,
    secondary_sampling_enabled: bool,
) -> Result<(), String> {
    let source_output_node_id = if secondary_sampling_enabled {
        H3_SECONDARY_OUTPUT_NODE_ID
    } else {
        H3_PRIMARY_OUTPUT_NODE_ID
    };
    let filename_prefix = workflow
        .get(source_output_node_id)
        .and_then(|node| node.get("inputs"))
        .and_then(|inputs| inputs.get("filename_prefix"))
        .and_then(Value::as_str)
        .unwrap_or("SuCanvas/Minimax_H3")
        .to_owned();
    let (image_node_id, audio_node_id, audio_output_index) = if secondary_sampling_enabled {
        ("403", "382", 0)
    } else {
        ("405", "356", 1)
    };
    let workflow_object = workflow
        .as_object_mut()
        .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?;
    workflow_object.remove(H3_PRIMARY_OUTPUT_NODE_ID);
    workflow_object.remove(H3_SECONDARY_OUTPUT_NODE_ID);
    workflow_object.insert(
        H3_CLEAN_VIDEO_NODE_ID.to_owned(),
        json!({
            "inputs": {
                "images": [image_node_id, 0],
                "fps": 24.0,
                "audio": [audio_node_id, audio_output_index],
                "bit_depth": 8
            },
            "class_type": "CreateVideo",
            "_meta": { "title": "Create Final Video" }
        }),
    );
    workflow_object.insert(
        H3_CLEAN_SAVE_NODE_ID.to_owned(),
        json!({
            "inputs": {
                "video": [H3_CLEAN_VIDEO_NODE_ID, 0],
                "filename_prefix": filename_prefix,
                "format": "mp4",
                "codec": "auto"
            },
            "class_type": "SaveVideo",
            "_meta": { "title": "Save Final Video" }
        }),
    );
    Ok(())
}

fn configure_h3_generation(
    workflow: &mut Value,
    prompt: &str,
    seed: u64,
    duration_seconds: f64,
    aspect_ratio: &str,
    primary_resolution_megapixels: f64,
    secondary_resolution_megapixels: f64,
    secondary_sampling_enabled: bool,
    lora_name: &str,
    lora_strength: f64,
) -> Result<(), String> {
    set_workflow_input(
        workflow,
        H3_PROMPT_NODE_ID,
        "value",
        Value::String(prompt.to_owned()),
    )?;
    set_workflow_input(workflow, H3_SEED_NODE_ID, "noise_seed", json!(seed))?;
    set_workflow_input(
        workflow,
        H3_DURATION_NODE_ID,
        "value",
        json!(duration_seconds),
    )?;
    set_workflow_input(
        workflow,
        H3_PRIMARY_RESOLUTION_NODE_ID,
        "aspect_ratio",
        Value::String(aspect_ratio.to_owned()),
    )?;
    set_workflow_input(
        workflow,
        H3_PRIMARY_RESOLUTION_NODE_ID,
        "megapixels",
        json!(primary_resolution_megapixels),
    )?;
    if secondary_sampling_enabled {
        set_workflow_input(
            workflow,
            H3_SECONDARY_RESOLUTION_NODE_ID,
            "aspect_ratio",
            Value::String(aspect_ratio.to_owned()),
        )?;
        set_workflow_input(
            workflow,
            H3_SECONDARY_RESOLUTION_NODE_ID,
            "megapixels",
            json!(secondary_resolution_megapixels),
        )?;
    }
    for node_id in [H3_PRIMARY_LORA_NODE_ID, H3_SECONDARY_LORA_NODE_ID] {
        set_workflow_input(
            workflow,
            node_id,
            "lora_name",
            Value::String(lora_name.to_owned()),
        )?;
        set_workflow_input(workflow, node_id, "strength_model", json!(lora_strength))?;
    }
    install_clean_video_output(workflow, secondary_sampling_enabled)?;
    Ok(())
}

fn h3_workflow_aspect_ratio(value: &str) -> Option<&'static str> {
    match value.trim() {
        "16:9" => Some("16:9 (Widescreen)"),
        "9:16" => Some("9:16 (Portrait Widescreen)"),
        "4:3" => Some("4:3 (Standard)"),
        "3:4" => Some("3:4 (Portrait Standard)"),
        "2:3" => Some("2:3 (Portrait Photo)"),
        "3:2" => Some("3:2 (Photo)"),
        "1:1" => Some("1:1 (Square)"),
        _ => None,
    }
}

fn resolve_generation_seed(seed_mode: &str, seed: &str) -> Result<u64, String> {
    match seed_mode {
        "random" => Ok(Uuid::new_v4().as_u128() as u64),
        "fixed" => seed
            .trim()
            .parse::<u64>()
            .map_err(|_| "固定种子必须是0到18446744073709551615之间的整数".to_owned()),
        _ => Err("种子模式必须是 random 或 fixed".to_owned()),
    }
}

async fn upload_comfy_input(
    client: &Client,
    server_url: &str,
    path: &str,
    subfolder: &str,
) -> Result<String, String> {
    let source = Path::new(path);
    if !source.is_file() {
        return Err(format!("素材文件不存在：{path}"));
    }
    let filename = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("素材文件名无效：{path}"))?
        .to_owned();
    let part = multipart::Part::file(source)
        .await
        .map_err(|error| format!("读取素材失败 {path}：{error}"))?
        .file_name(filename);
    let form = multipart::Form::new()
        .part("image", part)
        .text("type", "input")
        .text("subfolder", subfolder.to_owned())
        .text("overwrite", "true");
    let response = client
        .post(format!("{server_url}/upload/image"))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传素材失败：{error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析素材上传响应失败（HTTP {status}）：{error}"))?;
    if !status.is_success() {
        return Err(format!("ComfyUI 拒绝素材上传（HTTP {status}）：{body}"));
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "ComfyUI 上传响应缺少文件名".to_owned())?;
    let returned_subfolder = body.get("subfolder").and_then(Value::as_str).unwrap_or("");
    Ok(if returned_subfolder.is_empty() {
        name.to_owned()
    } else {
        format!("{returned_subfolder}/{name}")
    })
}

async fn upload_comfy_output_as_input(
    client: &Client,
    server_url: &str,
    output: &ComfyOutputFile,
    subfolder: &str,
) -> Result<String, String> {
    if output.filename.trim().is_empty() {
        return Err("二采源视频缺少文件名".to_owned());
    }
    let source_url = comfy_view_url(
        server_url,
        &output.filename,
        &output.subfolder,
        &output.file_type,
    )?;
    let response = client
        .get(source_url)
        .send()
        .await
        .map_err(|error| format!("读取二采源视频失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("读取二采源视频失败（HTTP {status}）"));
    }
    let part = multipart::Part::stream(reqwest::Body::wrap_stream(response.bytes_stream()))
        .file_name(output.filename.clone());
    let form = multipart::Form::new()
        .part("image", part)
        .text("type", "input")
        .text("subfolder", subfolder.to_owned())
        .text("overwrite", "true");
    let response = client
        .post(format!("{server_url}/upload/image"))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传二采源视频失败：{error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析二采源视频上传响应失败（HTTP {status}）：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "ComfyUI 拒绝二采源视频上传（HTTP {status}）：{body}"
        ));
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "ComfyUI 二采源视频上传响应缺少文件名".to_owned())?;
    let returned_subfolder = body.get("subfolder").and_then(Value::as_str).unwrap_or("");
    Ok(if returned_subfolder.is_empty() {
        name.to_owned()
    } else {
        format!("{returned_subfolder}/{name}")
    })
}

fn comfy_input_task_path(
    input_root_path: &str,
    upload_subfolder: &str,
) -> Result<Option<PathBuf>, String> {
    let input_root_path = input_root_path.trim().trim_matches('"');
    if input_root_path.is_empty() {
        return Ok(None);
    }
    let task_id = upload_subfolder
        .strip_prefix("infinite-canvas/")
        .ok_or_else(|| "拒绝清理非 infinite-canvas 上传目录".to_owned())?;
    if task_id.contains('/') || task_id.contains('\\') || Uuid::parse_str(task_id).is_err() {
        return Err("拒绝清理无效的 ComfyUI 任务目录".to_owned());
    }
    let input_root = PathBuf::from(input_root_path);
    if !input_root.is_absolute() {
        return Err("ComfyUI 输入映射目录必须是绝对路径".to_owned());
    }
    Ok(Some(input_root.join("infinite-canvas").join(task_id)))
}

async fn cleanup_comfy_input_directory(
    input_root_path: &str,
    upload_subfolder: &str,
) -> Result<(), String> {
    let Some(task_path) = comfy_input_task_path(input_root_path, upload_subfolder)? else {
        return Ok(());
    };
    let metadata = match tokio::fs::symlink_metadata(&task_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法检查 ComfyUI 输入任务目录：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("拒绝删除不是普通目录的 ComfyUI 输入任务路径".to_owned());
    }
    tokio::fs::remove_dir_all(&task_path)
        .await
        .map_err(|error| format!("删除 ComfyUI 输入任务目录失败：{error}"))
}

async fn cleanup_comfy_task_inputs(task: &RunningComfyTask) -> Option<String> {
    if task.input_root_path.trim().is_empty() || task.cleanup_started.swap(true, Ordering::SeqCst) {
        return None;
    }
    match cleanup_comfy_input_directory(&task.input_root_path, &task.upload_subfolder).await {
        Ok(()) => None,
        Err(error) => {
            task.cleanup_started.store(false, Ordering::SeqCst);
            Some(error)
        }
    }
}

fn append_cleanup_warning(message: String, cleanup_warning: Option<String>) -> String {
    match cleanup_warning {
        Some(warning) => format!("{message}；输入缓存清理失败：{warning}"),
        None => message,
    }
}

fn configure_secondary_source_video(
    workflow: &mut Value,
    uploaded_video: &str,
) -> Result<(), String> {
    let workflow_object = workflow
        .as_object_mut()
        .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?;
    workflow_object.insert(
        H3_SECONDARY_VIDEO_INPUT_NODE_ID.to_owned(),
        json!({
            "inputs": {
                "video": uploaded_video,
                "force_rate": 24.0,
                "custom_width": 0,
                "custom_height": 0,
                "frame_load_cap": 0,
                "skip_first_frames": 0,
                "select_every_nth": 1
            },
            "class_type": "VHS_LoadVideo",
            "_meta": { "title": "Load Selected Preview For Secondary Sampling" }
        }),
    );
    set_workflow_input(
        workflow,
        "383",
        "image",
        json!([H3_SECONDARY_VIDEO_INPUT_NODE_ID, 0]),
    )?;
    set_workflow_input(
        workflow,
        "388",
        "audio",
        json!([H3_SECONDARY_VIDEO_INPUT_NODE_ID, 2]),
    )?;
    set_workflow_input(
        workflow,
        H3_CLEAN_VIDEO_NODE_ID,
        "audio",
        json!([H3_SECONDARY_VIDEO_INPUT_NODE_ID, 2]),
    )?;
    Ok(())
}

fn collect_video_files(value: &Value, files: &mut Vec<(String, String, String)>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_video_files(item, files);
            }
        }
        Value::Object(object) => {
            if let Some(filename) = object.get("filename").and_then(Value::as_str) {
                let extension = Path::new(filename)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ["mp4", "webm", "mov", "mkv"].contains(&extension.as_str()) {
                    files.push((
                        filename.to_owned(),
                        object
                            .get("subfolder")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        object
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("output")
                            .to_owned(),
                    ));
                }
            }
            for child in object.values() {
                collect_video_files(child, files);
            }
        }
        _ => {}
    }
}

fn comfy_execution_elapsed_seconds(entry: &Value) -> Option<f64> {
    let messages = entry.pointer("/status/messages")?.as_array()?;
    let timestamp_for = |message: &Value, event_name: &str| {
        let parts = message.as_array()?;
        if parts.first()?.as_str()? != event_name {
            return None;
        }
        parts.get(1)?.get("timestamp")?.as_f64()
    };
    let started_at = messages
        .iter()
        .find_map(|message| timestamp_for(message, "execution_start"))?;
    let completed_at = messages
        .iter()
        .rev()
        .find_map(|message| timestamp_for(message, "execution_success"))?;
    (completed_at >= started_at).then_some((completed_at - started_at) / 1000.0)
}

fn comfy_view_url(
    server_url: &str,
    filename: &str,
    subfolder: &str,
    file_type: &str,
) -> Result<String, String> {
    let mut url = Url::parse(&format!("{server_url}/view"))
        .map_err(|error| format!("ComfyUI 输出地址无效：{error}"))?;
    url.query_pairs_mut()
        .append_pair("filename", filename)
        .append_pair("subfolder", subfolder)
        .append_pair("type", file_type);
    Ok(url.into())
}

fn ensure_comfy_task_active(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("ComfyUI 生成已取消".to_owned())
    } else {
        Ok(())
    }
}

async fn submit_comfyui_workflow_inner(
    input: ComfySubmitInput,
    task: Arc<RunningComfyTask>,
) -> Result<ComfySubmitResult, String> {
    ensure_comfy_task_active(&task.cancelled)?;
    let parsed_server = Url::parse(input.server_url.trim())
        .map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    if parsed_server.scheme() != "http" && parsed_server.scheme() != "https" {
        return Err("ComfyUI 地址只允许 http 或 https".to_owned());
    }
    let server_url = input.server_url.trim().trim_end_matches('/').to_owned();
    if input.client_id.trim().is_empty() {
        return Err("ComfyUI WebSocket client_id 不能为空".to_owned());
    }
    if input.prompt.trim().is_empty() {
        return Err("提示词不能为空".to_owned());
    }
    let generation_seed = resolve_generation_seed(&input.seed_mode, &input.seed)?;
    if input.image_paths.len() > H3_IMAGE_NODE_IDS.len() {
        return Err(format!(
            "当前工作流最多支持 {} 张参考图片",
            H3_IMAGE_NODE_IDS.len()
        ));
    }
    if input.audio_paths.len() > H3_AUDIO_NODE_IDS.len() {
        return Err(format!(
            "当前工作流最多支持 {} 个参考音频",
            H3_AUDIO_NODE_IDS.len()
        ));
    }
    if !input.video_paths.is_empty() {
        return Err("当前 API 工作流没有参考视频输入节点".to_owned());
    }
    if !input.duration_seconds.is_finite()
        || input.duration_seconds < 2.0
        || input.duration_seconds > 15.0
    {
        return Err("生成时长必须在2到15秒之间".to_owned());
    }
    let aspect_ratio = h3_workflow_aspect_ratio(&input.aspect_ratio)
        .ok_or_else(|| "画面比例必须是 16:9、9:16、4:3、3:4、2:3、3:2 或 1:1".to_owned())?;
    if !input.primary_resolution_megapixels.is_finite()
        || input.primary_resolution_megapixels < 0.2
        || input.primary_resolution_megapixels > 2.0
    {
        return Err("一采分辨率必须在0.2到2.0 MP之间".to_owned());
    }
    if !input.secondary_resolution_megapixels.is_finite()
        || input.secondary_resolution_megapixels < 0.2
        || input.secondary_resolution_megapixels > 2.0
    {
        return Err("二采分辨率必须在0.2到2.0 MP之间".to_owned());
    }
    let lora_name = input.lora_name.trim();
    if !is_minimax_h3_lora_name(lora_name) {
        return Err("LoRA 只能选择 MinimaxH3 目录中的模型".to_owned());
    }
    if !input.lora_strength.is_finite() || input.lora_strength < 0.0 || input.lora_strength > 2.0 {
        return Err("LoRA 权重必须在0.0到2.0之间".to_owned());
    }

    let workflow_bytes = tokio::fs::read(&input.workflow_path)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "H3 API 工作流文件不存在：{}。请在应用设置中更新工作流路径",
                    input.workflow_path
                )
            } else {
                format!("读取 H3 API 工作流失败（{}）：{error}", input.workflow_path)
            }
        })?;
    ensure_comfy_task_active(&task.cancelled)?;
    let mut workflow: Value = serde_json::from_slice(&workflow_bytes)
        .map_err(|error| format!("解析 API 工作流失败：{error}"))?;
    let workflow_object = workflow
        .as_object()
        .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?;
    if workflow_object.contains_key("nodes") || workflow_object.contains_key("links") {
        return Err("这是普通 UI 工作流，请改用 Export Workflow (API Format)".to_owned());
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|error| format!("创建 ComfyUI 客户端失败：{error}"))?;
    let mut uploaded_images = Vec::with_capacity(input.image_paths.len());
    for path in &input.image_paths {
        ensure_comfy_task_active(&task.cancelled)?;
        uploaded_images
            .push(upload_comfy_input(&client, &server_url, path, &task.upload_subfolder).await?);
    }
    let mut uploaded_audios = Vec::with_capacity(input.audio_paths.len());
    for path in &input.audio_paths {
        ensure_comfy_task_active(&task.cancelled)?;
        uploaded_audios
            .push(upload_comfy_input(&client, &server_url, path, &task.upload_subfolder).await?);
    }
    let uploaded_secondary_source = if let Some(source) = input.secondary_source.as_ref() {
        ensure_comfy_task_active(&task.cancelled)?;
        Some(
            upload_comfy_output_as_input(&client, &server_url, source, &task.upload_subfolder)
                .await?,
        )
    } else {
        None
    };
    ensure_comfy_task_active(&task.cancelled)?;

    configure_h3_generation(
        &mut workflow,
        &input.prompt,
        generation_seed,
        input.duration_seconds,
        aspect_ratio,
        input.primary_resolution_megapixels,
        input.secondary_resolution_megapixels,
        input.secondary_sampling_enabled || uploaded_secondary_source.is_some(),
        lora_name,
        input.lora_strength,
    )?;
    for (index, node_id) in H3_IMAGE_NODE_IDS.iter().enumerate() {
        let input_name = format!("ref_images.ref_image_{index}");
        if let Some(uploaded_name) = uploaded_images.get(index) {
            set_workflow_input(
                &mut workflow,
                node_id,
                "image",
                Value::String(uploaded_name.clone()),
            )?;
        } else {
            workflow
                .as_object_mut()
                .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?
                .remove(*node_id);
            remove_workflow_input(&mut workflow, H3_CONDITIONING_NODE_ID, &input_name)?;
        }
    }
    for (index, node_id) in H3_AUDIO_NODE_IDS.iter().enumerate() {
        let input_name = format!("ref_audios.ref_audio_{index}");
        if let Some(uploaded_name) = uploaded_audios.get(index) {
            set_workflow_input(
                &mut workflow,
                node_id,
                "audio",
                Value::String(uploaded_name.clone()),
            )?;
        } else {
            workflow
                .as_object_mut()
                .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?
                .remove(*node_id);
            remove_workflow_input(&mut workflow, H3_CONDITIONING_NODE_ID, &input_name)?;
        }
    }
    if let Some(uploaded_video) = uploaded_secondary_source.as_deref() {
        configure_secondary_source_video(&mut workflow, uploaded_video)?;
    }

    ensure_comfy_task_active(&task.cancelled)?;
    task.submitted.store(true, Ordering::SeqCst);
    let response = client
        .post(format!("{server_url}/prompt"))
        .json(&json!({ "prompt": workflow, "client_id": input.client_id }))
        .send()
        .await
        .map_err(|error| format!("提交 ComfyUI 工作流失败：{error}"))?;
    let status = response.status();
    let response_body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 ComfyUI 提交响应失败（HTTP {status}）：{error}"))?;
    if !status.is_success() {
        let cleanup_warning = cleanup_comfy_task_inputs(&task).await;
        return Err(append_cleanup_warning(
            format!("ComfyUI 拒绝工作流（HTTP {status}）：{response_body}"),
            cleanup_warning,
        ));
    }
    let prompt_id = response_body
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI 响应缺少 prompt_id：{response_body}"))?
        .to_owned();
    *task
        .prompt_id
        .lock()
        .map_err(|_| "ComfyUI 任务状态锁已损坏".to_owned())? = Some(prompt_id.clone());
    if task.cancelled.load(Ordering::SeqCst) {
        cancel_known_comfy_prompt(&client, &server_url, &prompt_id).await?;
        wait_until_comfy_prompt_stopped(&client, &server_url, &prompt_id).await?;
        let cleanup_warning = cleanup_comfy_task_inputs(&task).await;
        return Err(append_cleanup_warning(
            "ComfyUI 生成已取消".to_owned(),
            cleanup_warning,
        ));
    }

    for _ in 0..5400 {
        ensure_comfy_task_active(&task.cancelled)?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        ensure_comfy_task_active(&task.cancelled)?;
        let history_response = client
            .get(format!("{server_url}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("查询 ComfyUI 任务状态失败：{error}"))?;
        if !history_response.status().is_success() {
            continue;
        }
        let history: Value = history_response
            .json()
            .await
            .map_err(|error| format!("解析 ComfyUI 历史记录失败：{error}"))?;
        let Some(entry) = history.get(&prompt_id) else {
            continue;
        };
        let status_text = entry
            .pointer("/status/status_str")
            .and_then(Value::as_str)
            .unwrap_or("");
        if status_text == "error" {
            let messages = entry
                .pointer("/status/messages")
                .cloned()
                .unwrap_or(Value::Null);
            let cleanup_warning = cleanup_comfy_task_inputs(&task).await;
            return Err(append_cleanup_warning(
                format!("ComfyUI 生成失败：{messages}"),
                cleanup_warning,
            ));
        }
        if status_text != "success" {
            continue;
        }
        let mut raw_files = Vec::new();
        collect_video_files(entry.get("outputs").unwrap_or(&Value::Null), &mut raw_files);
        let mut seen = HashSet::new();
        let mut outputs = Vec::new();
        for (filename, subfolder, file_type) in raw_files {
            let identity = format!("{file_type}/{subfolder}/{filename}");
            if !seen.insert(identity) {
                continue;
            }
            outputs.push(ComfyOutputFile {
                url: comfy_view_url(&server_url, &filename, &subfolder, &file_type)?,
                filename,
                subfolder,
                file_type,
            });
        }
        let cleanup_warning = cleanup_comfy_task_inputs(&task).await;
        if outputs.is_empty() {
            return Err(append_cleanup_warning(
                "ComfyUI 已完成，但历史记录中没有找到视频输出".to_owned(),
                cleanup_warning,
            ));
        }
        return Ok(ComfySubmitResult {
            prompt_id,
            seed: generation_seed.to_string(),
            outputs,
            execution_elapsed_seconds: comfy_execution_elapsed_seconds(entry),
            cleanup_warning,
        });
    }

    Err(format!("等待 ComfyUI 任务超时：{prompt_id}"))
}

#[tauri::command]
pub async fn submit_comfyui_workflow(
    input: ComfySubmitInput,
    state: State<'_, ApplicationState>,
) -> Result<ComfySubmitResult, String> {
    let client_id = input.client_id.clone();
    let upload_subfolder = format!("infinite-canvas/{}", Uuid::new_v4().simple());
    let task = Arc::new(RunningComfyTask {
        cancelled: AtomicBool::new(false),
        submitted: AtomicBool::new(false),
        prompt_id: std::sync::Mutex::new(None),
        input_root_path: input.input_root_path.clone(),
        upload_subfolder,
        cleanup_started: AtomicBool::new(false),
    });
    state
        .running_comfy_tasks
        .lock()
        .map_err(|_| "ComfyUI 任务列表锁已损坏".to_owned())?
        .insert(client_id.clone(), task.clone());

    let mut result = submit_comfyui_workflow_inner(input, task.clone()).await;
    if !task.submitted.load(Ordering::SeqCst) {
        if let Some(cleanup_warning) = cleanup_comfy_task_inputs(&task).await {
            result = match result {
                Ok(mut success) => {
                    success.cleanup_warning = Some(cleanup_warning);
                    Ok(success)
                }
                Err(error) => Err(append_cleanup_warning(error, Some(cleanup_warning))),
            };
        }
    }
    state
        .running_comfy_tasks
        .lock()
        .map_err(|_| "ComfyUI 任务列表锁已损坏".to_owned())?
        .remove(&client_id);
    result
}

fn value_contains_string(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(value) => value == needle,
        Value::Array(values) => values
            .iter()
            .any(|value| value_contains_string(value, needle)),
        Value::Object(values) => values
            .values()
            .any(|value| value_contains_string(value, needle)),
        _ => false,
    }
}

fn comfy_client_id_from_queue_item(item: &Value) -> Option<&str> {
    item.get(3)?.get("client_id")?.as_str()
}

fn comfy_prompt_id_from_queue_item(item: &Value) -> Option<&str> {
    item.get(1)?.as_str()
}

fn comfy_seed_from_prompt(prompt: &Value) -> Option<String> {
    let value = prompt.pointer(&format!("/2/{H3_SEED_NODE_ID}/inputs/noise_seed"))?;
    value
        .as_u64()
        .map(|seed| seed.to_string())
        .or_else(|| value.as_str().map(str::to_owned))
}

fn comfy_outputs_from_history_entry(
    server_url: &str,
    entry: &Value,
) -> Result<Vec<ComfyOutputFile>, String> {
    let mut raw_files = Vec::new();
    collect_video_files(entry.get("outputs").unwrap_or(&Value::Null), &mut raw_files);
    let mut seen = HashSet::new();
    let mut outputs = Vec::new();
    for (filename, subfolder, file_type) in raw_files {
        let identity = format!("{file_type}/{subfolder}/{filename}");
        if !seen.insert(identity) {
            continue;
        }
        outputs.push(ComfyOutputFile {
            url: comfy_view_url(server_url, &filename, &subfolder, &file_type)?,
            filename,
            subfolder,
            file_type,
        });
    }
    Ok(outputs)
}

async fn cancel_known_comfy_prompt(
    client: &Client,
    server_url: &str,
    prompt_id: &str,
) -> Result<(), String> {
    let mut cancel_url = Url::parse(&format!("{}/", server_url.trim_end_matches('/')))
        .map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    cancel_url
        .path_segments_mut()
        .map_err(|_| "ComfyUI 地址不能作为任务取消接口".to_owned())?
        .extend(["api", "jobs", prompt_id, "cancel"]);
    let atomic_response = client
        .post(cancel_url)
        .send()
        .await
        .map_err(|error| format!("按任务 ID 取消 ComfyUI 任务失败：{error}"))?;
    let atomic_status = atomic_response.status();
    if atomic_status.is_success() {
        return Ok(());
    }
    if atomic_status.as_u16() != 404 && atomic_status.as_u16() != 405 {
        return Err(format!(
            "ComfyUI 拒绝按任务 ID 取消（HTTP {atomic_status}）"
        ));
    }

    // Older ComfyUI versions do not expose the atomic job-cancel endpoint.
    // Keep the legacy queue/interrupt flow only as a compatibility fallback.
    let queue = client
        .get(format!("{server_url}/queue"))
        .send()
        .await
        .map_err(|error| format!("查询 ComfyUI 队列失败：{error}"))?;
    let queue_status = queue.status();
    let queue_body: Value = queue
        .json()
        .await
        .map_err(|error| format!("解析 ComfyUI 队列失败（HTTP {queue_status}）：{error}"))?;
    if !queue_status.is_success() {
        return Err(format!(
            "ComfyUI 拒绝查询队列（HTTP {queue_status}）：{queue_body}"
        ));
    }

    let is_running = queue_body
        .get("queue_running")
        .is_some_and(|running| value_contains_string(running, prompt_id));
    let endpoint = if is_running { "/interrupt" } else { "/queue" };
    let mut request = client.post(format!("{server_url}{endpoint}"));
    if !is_running {
        request = request.json(&json!({ "delete": [prompt_id] }));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("取消 ComfyUI 任务失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "ComfyUI 拒绝取消任务（HTTP {}）",
            response.status()
        ));
    }
    Ok(())
}

async fn wait_until_comfy_prompt_stopped(
    client: &Client,
    server_url: &str,
    prompt_id: &str,
) -> Result<(), String> {
    for _ in 0..120 {
        let response = client
            .get(format!("{server_url}/queue"))
            .send()
            .await
            .map_err(|error| format!("确认 ComfyUI 取消状态失败：{error}"))?;
        let status = response.status();
        let queue: Value = response
            .json()
            .await
            .map_err(|error| format!("解析 ComfyUI 取消状态失败（HTTP {status}）：{error}"))?;
        if !status.is_success() {
            return Err(format!(
                "ComfyUI 拒绝确认取消状态（HTTP {status}）：{queue}"
            ));
        }
        let still_queued = queue
            .get("queue_running")
            .is_some_and(|value| value_contains_string(value, prompt_id))
            || queue
                .get("queue_pending")
                .is_some_and(|value| value_contains_string(value, prompt_id));
        if !still_queued {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("ComfyUI 尚未确认任务停止，已保留输入素材避免提前删除".to_owned())
}

fn comfy_queue_summary_from_value(queue: &Value) -> ComfyQueueSummary {
    let running_count = queue
        .get("queue_running")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let pending_count = queue
        .get("queue_pending")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    ComfyQueueSummary {
        running_count,
        pending_count,
        total_count: running_count + pending_count,
    }
}

#[tauri::command]
pub async fn get_comfyui_queue_summary(server_url: String) -> Result<ComfyQueueSummary, String> {
    let parsed_server =
        Url::parse(server_url.trim()).map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    if parsed_server.scheme() != "http" && parsed_server.scheme() != "https" {
        return Err("ComfyUI 地址只允许 http 或 https".to_owned());
    }
    let server_url = server_url.trim().trim_end_matches('/');
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建 ComfyUI 队列客户端失败：{error}"))?;
    let response = client
        .get(format!("{server_url}/queue"))
        .send()
        .await
        .map_err(|error| format!("查询 ComfyUI 队列失败：{error}"))?;
    let status = response.status();
    let queue: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 ComfyUI 队列失败（HTTP {status}）：{error}"))?;
    if !status.is_success() {
        return Err(format!("ComfyUI 拒绝查询队列（HTTP {status}）：{queue}"));
    }
    Ok(comfy_queue_summary_from_value(&queue))
}

#[tauri::command]
pub async fn get_comfyui_client_task_statuses(
    server_url: String,
    client_ids: Vec<String>,
) -> Result<Vec<ComfyClientTaskStatus>, String> {
    if client_ids.is_empty() {
        return Ok(Vec::new());
    }
    let parsed_server =
        Url::parse(server_url.trim()).map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    if parsed_server.scheme() != "http" && parsed_server.scheme() != "https" {
        return Err("ComfyUI 地址只允许 http 或 https".to_owned());
    }
    let server_url = server_url.trim().trim_end_matches('/').to_owned();
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建 ComfyUI 状态客户端失败：{error}"))?;
    let queue_response = client
        .get(format!("{server_url}/queue"))
        .send()
        .await
        .map_err(|error| format!("查询 ComfyUI 队列失败：{error}"))?;
    let queue_status = queue_response.status();
    let queue: Value = queue_response
        .json()
        .await
        .map_err(|error| format!("解析 ComfyUI 队列失败（HTTP {queue_status}）：{error}"))?;
    if !queue_status.is_success() {
        return Err(format!(
            "ComfyUI 拒绝查询队列（HTTP {queue_status}）：{queue}"
        ));
    }
    let history_response = client
        .get(format!("{server_url}/history?max_items=500"))
        .send()
        .await
        .map_err(|error| format!("查询 ComfyUI 历史记录失败：{error}"))?;
    let history_status = history_response.status();
    let history: Value = history_response
        .json()
        .await
        .map_err(|error| format!("解析 ComfyUI 历史记录失败（HTTP {history_status}）：{error}"))?;
    if !history_status.is_success() {
        return Err(format!(
            "ComfyUI 拒绝查询历史记录（HTTP {history_status}）：{history}"
        ));
    }

    let running = queue
        .get("queue_running")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pending = queue
        .get("queue_pending")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let history_entries = history.as_object();
    let mut statuses = Vec::with_capacity(client_ids.len());
    for client_id in client_ids {
        let active = running
            .iter()
            .find(|item| comfy_client_id_from_queue_item(item) == Some(client_id.as_str()))
            .map(|item| ("running", item))
            .or_else(|| {
                pending
                    .iter()
                    .find(|item| comfy_client_id_from_queue_item(item) == Some(client_id.as_str()))
                    .map(|item| ("pending", item))
            });
        if let Some((status, item)) = active {
            statuses.push(ComfyClientTaskStatus {
                client_id,
                prompt_id: comfy_prompt_id_from_queue_item(item).map(str::to_owned),
                status: status.to_owned(),
                seed: comfy_seed_from_prompt(item),
                outputs: Vec::new(),
                execution_elapsed_seconds: None,
            });
            continue;
        }

        let history_entry = history_entries.and_then(|entries| {
            entries.values().find(|entry| {
                entry.pointer("/prompt/3/client_id").and_then(Value::as_str)
                    == Some(client_id.as_str())
            })
        });
        if let Some(entry) = history_entry {
            let status = entry
                .pointer("/status/status_str")
                .and_then(Value::as_str)
                .unwrap_or("error");
            statuses.push(ComfyClientTaskStatus {
                client_id,
                prompt_id: entry
                    .pointer("/prompt/1")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                status: status.to_owned(),
                seed: comfy_seed_from_prompt(entry.get("prompt").unwrap_or(&Value::Null)),
                outputs: if status == "success" {
                    comfy_outputs_from_history_entry(&server_url, entry)?
                } else {
                    Vec::new()
                },
                execution_elapsed_seconds: comfy_execution_elapsed_seconds(entry),
            });
            continue;
        }

        statuses.push(ComfyClientTaskStatus {
            client_id,
            prompt_id: None,
            status: "missing".to_owned(),
            seed: None,
            outputs: Vec::new(),
            execution_elapsed_seconds: None,
        });
    }
    Ok(statuses)
}

#[tauri::command]
pub async fn cancel_comfyui_workflow(
    server_url: String,
    client_id: String,
    state: State<'_, ApplicationState>,
) -> Result<Option<String>, String> {
    let parsed_server =
        Url::parse(server_url.trim()).map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    if parsed_server.scheme() != "http" && parsed_server.scheme() != "https" {
        return Err("ComfyUI 地址只允许 http 或 https".to_owned());
    }
    let server_url = server_url.trim().trim_end_matches('/');
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建 ComfyUI 取消客户端失败：{error}"))?;
    let task = state
        .running_comfy_tasks
        .lock()
        .map_err(|_| "ComfyUI 任务列表锁已损坏".to_owned())?
        .get(&client_id)
        .cloned();
    let Some(task) = task else {
        let queue_response = client
            .get(format!("{server_url}/queue"))
            .send()
            .await
            .map_err(|error| format!("查询 ComfyUI 队列失败：{error}"))?;
        let queue: Value = queue_response
            .json()
            .await
            .map_err(|error| format!("解析 ComfyUI 队列失败：{error}"))?;
        let prompt_id = ["queue_running", "queue_pending"].iter().find_map(|key| {
            queue
                .get(*key)
                .and_then(Value::as_array)?
                .iter()
                .find(|item| comfy_client_id_from_queue_item(item) == Some(client_id.as_str()))
                .and_then(comfy_prompt_id_from_queue_item)
                .map(str::to_owned)
        });
        let Some(prompt_id) = prompt_id else {
            return Ok(None);
        };
        cancel_known_comfy_prompt(&client, server_url, &prompt_id).await?;
        wait_until_comfy_prompt_stopped(&client, server_url, &prompt_id).await?;
        return Ok(None);
    };
    task.cancelled.store(true, Ordering::SeqCst);

    let prompt_id = task
        .prompt_id
        .lock()
        .map_err(|_| "ComfyUI 任务状态锁已损坏".to_owned())?
        .clone();
    let Some(prompt_id) = prompt_id else {
        return Ok(None);
    };

    cancel_known_comfy_prompt(&client, server_url, &prompt_id).await?;
    wait_until_comfy_prompt_stopped(&client, server_url, &prompt_id).await?;
    Ok(cleanup_comfy_task_inputs(&task).await)
}

#[tauri::command]
pub fn get_runtime_info(state: State<'_, ApplicationState>) -> RuntimeInfo {
    state.runtime.clone()
}

#[cfg(test)]
mod tests {
    use super::{
        comfy_execution_elapsed_seconds, comfy_input_task_path, comfy_queue_summary_from_value,
        configure_h3_generation, configure_secondary_source_video, delete_video_files_blocking,
        hash_app_lock_password, media_format, minimax_h3_loras_from_object_info,
        resolve_generation_seed, validate_new_app_lock_password, verify_app_lock_hash, MediaFormat,
        AUDIO_MAX_BYTES, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES,
    };
    use serde_json::json;
    use std::{fs, path::Path};
    use uuid::Uuid;

    fn resolution_test_workflow() -> serde_json::Value {
        json!({
            "339": { "inputs": { "value": "old prompt" } },
            "340": { "inputs": { "aspect_ratio": "16:9 (Widescreen)", "megapixels": 0.4 } },
            "348": { "inputs": { "noise_seed": 0 } },
            "350": { "inputs": { "value": 15.0 } },
            "354": { "inputs": { "lora_name": "MinimaxH3\\old-primary.safetensors", "strength_model": 1.0 } },
            "360": { "inputs": { "save_output": false, "filename_prefix": "primary/video" } },
            "383": { "inputs": { "image": ["381", 0] } },
            "388": { "inputs": { "audio": ["382", 0] } },
            "397": { "inputs": { "save_output": true, "filename_prefix": "secondary/video" } },
            "398": { "inputs": { "aspect_ratio": "16:9 (Widescreen)", "megapixels": 0.5 } }
            ,"401": { "inputs": { "lora_name": "MinimaxH3\\old-secondary.safetensors", "strength_model": 1.0 } }
        })
    }

    #[test]
    fn app_lock_hash_accepts_only_the_original_password() {
        let hash = hash_app_lock_password("本机锁密码123").unwrap();
        assert!(verify_app_lock_hash("本机锁密码123", &hash).unwrap());
        assert!(!verify_app_lock_hash("错误密码", &hash).unwrap());
        assert!(!hash.contains("本机锁密码123"));
    }

    #[test]
    fn app_lock_password_length_is_bounded() {
        assert!(validate_new_app_lock_password("123").is_err());
        assert!(validate_new_app_lock_password("1234").is_ok());
        assert!(validate_new_app_lock_password(&"a".repeat(129)).is_err());
    }

    #[test]
    fn cleanup_path_is_limited_to_the_infinite_canvas_uuid_directory() {
        let task_id = "0123456789abcdef0123456789abcdef";
        let path = comfy_input_task_path(
            r"X:\ComfyUI_windows_portable\ComfyUI\input",
            &format!("infinite-canvas/{task_id}"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            path,
            Path::new(r"X:\ComfyUI_windows_portable\ComfyUI\input")
                .join("infinite-canvas")
                .join(task_id)
        );
        assert!(comfy_input_task_path(
            r"X:\ComfyUI_windows_portable\ComfyUI\input",
            "infinite-canvas/../output",
        )
        .is_err());
        assert!(comfy_input_task_path(
            r"X:\ComfyUI_windows_portable\ComfyUI\input",
            "other-folder/0123456789abcdef0123456789abcdef",
        )
        .is_err());
    }

    #[test]
    fn reports_the_global_running_and_pending_queue_counts() {
        let queue = json!({
            "queue_running": [[1, "running-prompt", {}]],
            "queue_pending": [
                [2, "first-pending", {}],
                [3, "second-pending", {}]
            ]
        });
        let summary = comfy_queue_summary_from_value(&queue);
        assert_eq!(summary.running_count, 1);
        assert_eq!(summary.pending_count, 2);
        assert_eq!(summary.total_count, 3);
    }

    #[test]
    fn measures_only_comfy_execution_time() {
        let history_entry = json!({
            "status": {
                "messages": [
                    ["execution_start", { "timestamp": 1_786_228_387_929_u64 }],
                    ["execution_cached", { "timestamp": 1_786_228_387_990_u64 }],
                    ["execution_success", { "timestamp": 1_786_228_555_233_u64 }]
                ]
            }
        });
        let elapsed = comfy_execution_elapsed_seconds(&history_entry).unwrap();
        assert!((elapsed - 167.304).abs() < 0.001);
    }

    #[test]
    fn selected_preview_replaces_only_the_secondary_stage_inputs() {
        let mut workflow = resolution_test_workflow();
        configure_h3_generation(
            &mut workflow,
            "prompt",
            42,
            8.0,
            "3:4 (Portrait Standard)",
            0.4,
            0.8,
            true,
            r"MinimaxH3\test.safetensors",
            0.75,
        )
        .unwrap();
        configure_secondary_source_video(&mut workflow, "infinite-canvas/job/source.mp4").unwrap();

        assert_eq!(
            workflow.pointer("/9002/class_type"),
            Some(&json!("VHS_LoadVideo"))
        );
        assert_eq!(
            workflow.pointer("/9002/inputs/video"),
            Some(&json!("infinite-canvas/job/source.mp4"))
        );
        assert_eq!(
            workflow.pointer("/383/inputs/image"),
            Some(&json!(["9002", 0]))
        );
        assert_eq!(
            workflow.pointer("/388/inputs/audio"),
            Some(&json!(["9002", 2]))
        );
        assert_eq!(
            workflow.pointer("/9000/inputs/audio"),
            Some(&json!(["9002", 2]))
        );
    }

    #[test]
    fn supports_random_and_full_u64_fixed_seeds() {
        assert!(resolve_generation_seed("random", "").is_ok());
        assert_eq!(
            resolve_generation_seed("fixed", "18446744073709551615").unwrap(),
            u64::MAX
        );
        assert!(resolve_generation_seed("fixed", "18446744073709551616").is_err());
        assert!(resolve_generation_seed("unknown", "1").is_err());
    }

    #[test]
    fn configures_both_sampling_resolutions_when_secondary_sampling_is_enabled() {
        let mut workflow = resolution_test_workflow();
        configure_h3_generation(
            &mut workflow,
            "new prompt",
            u64::MAX,
            8.0,
            "9:16 (Portrait Widescreen)",
            0.3,
            2.0,
            true,
            r"MinimaxH3\selected.safetensors",
            0.65,
        )
        .unwrap();

        assert_eq!(
            workflow.pointer("/339/inputs/value"),
            Some(&json!("new prompt"))
        );
        assert_eq!(workflow.pointer("/350/inputs/value"), Some(&json!(8.0)));
        assert_eq!(
            workflow.pointer("/348/inputs/noise_seed"),
            Some(&json!(u64::MAX))
        );
        assert_eq!(
            workflow.pointer("/340/inputs/megapixels"),
            Some(&json!(0.3))
        );
        assert_eq!(
            workflow.pointer("/340/inputs/aspect_ratio"),
            Some(&json!("9:16 (Portrait Widescreen)"))
        );
        assert_eq!(
            workflow.pointer("/398/inputs/megapixels"),
            Some(&json!(2.0))
        );
        assert_eq!(
            workflow.pointer("/398/inputs/aspect_ratio"),
            Some(&json!("9:16 (Portrait Widescreen)"))
        );
        for node_id in ["354", "401"] {
            assert_eq!(
                workflow.pointer(&format!("/{node_id}/inputs/lora_name")),
                Some(&json!(r"MinimaxH3\selected.safetensors"))
            );
            assert_eq!(
                workflow.pointer(&format!("/{node_id}/inputs/strength_model")),
                Some(&json!(0.65))
            );
        }
        assert!(workflow.get("360").is_none());
        assert!(workflow.get("397").is_none());
        assert_eq!(
            workflow.pointer("/9000/inputs/images"),
            Some(&json!(["403", 0]))
        );
        assert_eq!(
            workflow.pointer("/9000/inputs/audio"),
            Some(&json!(["382", 0]))
        );
        assert_eq!(
            workflow.pointer("/9001/inputs/filename_prefix"),
            Some(&json!("secondary/video"))
        );
    }

    #[test]
    fn disabling_secondary_sampling_saves_primary_output_and_removes_secondary_output() {
        let mut workflow = resolution_test_workflow();
        configure_h3_generation(
            &mut workflow,
            "prompt",
            42,
            6.0,
            "16:9 (Widescreen)",
            0.2,
            0.8,
            false,
            r"MinimaxH3\test.safetensors",
            1.0,
        )
        .unwrap();

        assert_eq!(
            workflow.pointer("/340/inputs/megapixels"),
            Some(&json!(0.2))
        );
        assert!(workflow.get("360").is_none());
        assert!(workflow.get("397").is_none());
        assert_eq!(
            workflow.pointer("/9000/inputs/images"),
            Some(&json!(["405", 0]))
        );
        assert_eq!(
            workflow.pointer("/9000/inputs/audio"),
            Some(&json!(["356", 1]))
        );
        assert_eq!(
            workflow.pointer("/9001/inputs/filename_prefix"),
            Some(&json!("primary/video"))
        );
        assert_eq!(
            workflow.pointer("/398/inputs/megapixels"),
            Some(&json!(0.5))
        );
    }

    #[test]
    fn filters_comfy_loras_to_the_minimax_h3_directory() {
        let object_info = json!({
            "LoraLoaderModelOnly": {
                "input": {
                    "required": {
                        "lora_name": [[
                            "Other\\ignored.safetensors",
                            "MinimaxH3\\turbo.safetensors",
                            "minimaxh3/quality.safetensors"
                        ]]
                    }
                }
            }
        });
        assert_eq!(
            minimax_h3_loras_from_object_info(&object_info),
            vec![
                "minimaxh3/quality.safetensors".to_owned(),
                "MinimaxH3\\turbo.safetensors".to_owned(),
            ]
        );
    }

    #[test]
    fn accepts_supported_image_audio_and_video_extensions() {
        assert_eq!(
            media_format(Path::new("photo.JPEG")),
            Some(MediaFormat {
                extension: "jpg",
                mime_type: "image/jpeg",
                kind: "image",
                max_bytes: IMAGE_MAX_BYTES
            })
        );
        assert_eq!(
            media_format(Path::new("still.avif")),
            Some(MediaFormat {
                extension: "avif",
                mime_type: "image/avif",
                kind: "image",
                max_bytes: IMAGE_MAX_BYTES
            })
        );
        assert_eq!(
            media_format(Path::new("voice.MP3")),
            Some(MediaFormat {
                extension: "mp3",
                mime_type: "audio/mpeg",
                kind: "audio",
                max_bytes: AUDIO_MAX_BYTES
            })
        );
        assert_eq!(
            media_format(Path::new("voice.oga")),
            Some(MediaFormat {
                extension: "ogg",
                mime_type: "audio/ogg",
                kind: "audio",
                max_bytes: AUDIO_MAX_BYTES
            })
        );
        assert_eq!(
            media_format(Path::new("clip.mp4")),
            Some(MediaFormat {
                extension: "mp4",
                mime_type: "video/mp4",
                kind: "video",
                max_bytes: VIDEO_MAX_BYTES
            })
        );
        assert_eq!(media_format(Path::new("vector.svg")), None);
    }

    #[test]
    fn deletes_only_supported_video_files() {
        let test_dir = std::env::temp_dir().join(format!(
            "infinite-canvas-delete-video-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&test_dir).unwrap();
        let video_path = test_dir.join("preview.mp4");
        let text_path = test_dir.join("notes.txt");
        fs::write(&video_path, b"video").unwrap();
        fs::write(&text_path, b"text").unwrap();

        assert_eq!(
            delete_video_files_blocking(vec![video_path.to_string_lossy().into_owned()]),
            Ok(1)
        );
        assert!(!video_path.exists());
        assert!(
            delete_video_files_blocking(vec![text_path.to_string_lossy().into_owned()])
                .unwrap_err()
                .contains("拒绝删除非视频文件")
        );
        assert!(text_path.exists());

        fs::remove_dir_all(test_dir).unwrap();
    }
}
