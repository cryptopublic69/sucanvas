use std::{
    collections::{BTreeMap, HashSet},
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
use chrono::Local;
use image::{imageops::FilterType, ImageFormat};
use reqwest::{multipart, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

use crate::{
    app_backup::{self, BackupSummary, RestoreSummary},
    models::{
        AppLockStatus, CancelFolderResult, ComfyClientTaskStatus, ComfyOutputFile,
        ComfyQueueSummary, ComfySubmitInput, ComfySubmitResult, CreateEdgeInput,
        CreateEmptyFolderInput, CreateEmptyFolderResult, CreateNodeInput, CreateNodeResult,
        CreateProjectInput, DeleteFolderResult, DeleteNodesInput, DeletedBatch, EdgeRecord,
        FolderActionInput, GroupNodesIntoFolderInput, GroupNodesIntoFolderResult,
        GroupRelatedNodesIntoFolderInput, MergeFoldersInput, MergeFoldersResult, NodeRecord,
        ReplaceNodeAndDeleteInput, ReplaceNodeAndDeleteResult, ResizeImageResult,
        RestoreNodeReplacementInput, RestoreNodeReplacementResult, RuntimeInfo, SetAppLockInput,
        SetProjectPreviewImageInput, SetProjectPrivacyInput, UndoCancelFolderInput,
        UndoDeleteFolderInput, UndoFolderGroupingInput, UndoFolderMergeInput, UpdateNodeInput,
        UpdateProjectInput, WorkspaceSnapshot,
    },
    workflow_modules::{
        self, SaveWorkflowModuleInput, WorkflowBindings, WorkflowInputContract,
        WorkflowModuleRecord, WorkflowModuleValidation,
    },
    ApplicationState, CanvasSelectionState, RunningComfyTask,
};

fn portable_frontend_settings(settings: BTreeMap<String, String>) -> BTreeMap<String, String> {
    settings
        .into_iter()
        .filter(|(key, _)| key.starts_with("infinite-canvas:"))
        .collect()
}

#[tauri::command]
pub async fn export_app_backup(
    destination_path: String,
    frontend_settings: BTreeMap<String, String>,
    state: State<'_, ApplicationState>,
) -> Result<BackupSummary, String> {
    let data_dir = state.data_dir.clone();
    let database = state.database.clone();
    let destination = PathBuf::from(destination_path.trim().trim_matches('"'));
    let frontend_settings = portable_frontend_settings(frontend_settings);
    tauri::async_runtime::spawn_blocking(move || {
        app_backup::export(&data_dir, &database, &destination, &frontend_settings)
    })
    .await
    .map_err(|error| format!("软件备份任务失败：{error}"))?
}

#[tauri::command]
pub async fn stage_app_backup_restore(
    bundle_path: String,
    state: State<'_, ApplicationState>,
) -> Result<RestoreSummary, String> {
    let data_dir = state.data_dir.clone();
    let bundle_path = PathBuf::from(bundle_path.trim().trim_matches('"'));
    tauri::async_runtime::spawn_blocking(move || app_backup::stage_restore(&data_dir, &bundle_path))
        .await
        .map_err(|error| format!("软件恢复任务失败：{error}"))?
}

#[tauri::command]
pub fn take_restored_frontend_settings(
    state: State<'_, ApplicationState>,
) -> Result<Option<BTreeMap<String, String>>, String> {
    let path = app_backup::restored_settings_path(&state.data_dir);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("读取恢复设置失败：{error}"))?;
    let settings = serde_json::from_slice::<BTreeMap<String, String>>(&bytes)
        .map(portable_frontend_settings)
        .map_err(|error| format!("解析恢复设置失败：{error}"))?;
    std::fs::remove_file(path).map_err(|error| format!("完成设置恢复失败：{error}"))?;
    Ok(Some(settings))
}

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
        .map_err(|_| "active project lock is poisoned".to_owned())? = selected_id.clone();
    *state
        .current_canvas_selection
        .write()
        .map_err(|_| "canvas selection lock is poisoned".to_owned())? = CanvasSelectionState {
        canvas_id: Some(selected_id),
        node_ids: Vec::new(),
        updated_at: Local::now().to_rfc3339(),
    };
    Ok(snapshot)
}

#[tauri::command]
pub fn update_canvas_selection(
    canvas_id: Option<String>,
    node_ids: Vec<String>,
    state: State<'_, ApplicationState>,
) -> Result<(), String> {
    let active_canvas_id = state
        .active_canvas_id
        .read()
        .map_err(|_| "active project lock is poisoned".to_owned())?
        .clone();
    let canvas_id = canvas_id.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    });
    let mut selection = state
        .current_canvas_selection
        .write()
        .map_err(|_| "canvas selection lock is poisoned".to_owned())?;

    if canvas_id.as_deref() != Some(active_canvas_id.as_str()) {
        *selection = CanvasSelectionState {
            canvas_id: Some(active_canvas_id),
            node_ids: Vec::new(),
            updated_at: Local::now().to_rfc3339(),
        };
        return Ok(());
    }

    let mut seen = HashSet::new();
    *selection = CanvasSelectionState {
        canvas_id,
        node_ids: node_ids
            .into_iter()
            .filter_map(|node_id| {
                let node_id = node_id.trim().to_owned();
                (!node_id.is_empty() && seen.insert(node_id.clone())).then_some(node_id)
            })
            .collect(),
        updated_at: Local::now().to_rfc3339(),
    };
    Ok(())
}

#[tauri::command]
pub fn inspect_workspace(
    canvas_id: String,
    state: State<'_, ApplicationState>,
) -> Result<WorkspaceSnapshot, String> {
    state
        .database
        .load_project(&canvas_id)
        .map_err(|error| error.to_string())
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
pub fn group_nodes_into_folder(
    input: GroupNodesIntoFolderInput,
    state: State<'_, ApplicationState>,
) -> Result<GroupNodesIntoFolderResult, String> {
    state
        .database
        .group_nodes_into_folder(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_empty_folder(
    input: CreateEmptyFolderInput,
    state: State<'_, ApplicationState>,
) -> Result<CreateEmptyFolderResult, String> {
    state
        .database
        .create_empty_folder(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn group_related_nodes_into_folder(
    input: GroupRelatedNodesIntoFolderInput,
    state: State<'_, ApplicationState>,
) -> Result<GroupNodesIntoFolderResult, String> {
    state
        .database
        .group_related_nodes_into_folder(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn undo_folder_grouping(
    input: UndoFolderGroupingInput,
    state: State<'_, ApplicationState>,
) -> Result<WorkspaceSnapshot, String> {
    state
        .database
        .undo_folder_grouping(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn merge_folders(
    input: MergeFoldersInput,
    state: State<'_, ApplicationState>,
) -> Result<MergeFoldersResult, String> {
    state
        .database
        .merge_folders(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn undo_folder_merge(
    input: UndoFolderMergeInput,
    state: State<'_, ApplicationState>,
) -> Result<WorkspaceSnapshot, String> {
    state
        .database
        .undo_folder_merge(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_folder(
    input: FolderActionInput,
    state: State<'_, ApplicationState>,
) -> Result<CancelFolderResult, String> {
    state
        .database
        .cancel_folder(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn undo_cancel_folder(
    input: UndoCancelFolderInput,
    state: State<'_, ApplicationState>,
) -> Result<WorkspaceSnapshot, String> {
    state
        .database
        .undo_cancel_folder(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_folder_tree(
    input: FolderActionInput,
    state: State<'_, ApplicationState>,
) -> Result<DeleteFolderResult, String> {
    state
        .database
        .delete_folder_tree(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn undo_delete_folder_tree(
    input: UndoDeleteFolderInput,
    state: State<'_, ApplicationState>,
) -> Result<WorkspaceSnapshot, String> {
    state
        .database
        .undo_delete_folder_tree(input)
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
pub fn set_project_preview_image(
    input: SetProjectPreviewImageInput,
    state: State<'_, ApplicationState>,
) -> Result<crate::models::CanvasRecord, String> {
    state
        .database
        .set_project_preview_image(&input.project_id, &input.image_node_id)
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
    if let Err(error) = cleanup_unreferenced_resize_images(&state.data_dir, &state.database) {
        eprintln!("Failed to clean orphaned Resize images after project deletion: {error}");
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

fn resized_image_dimensions(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest_edge = width.max(height);
    if longest_edge <= max_edge {
        return (width, height);
    }
    let scaled = |value: u32| {
        (((value as u64 * max_edge as u64) + longest_edge as u64 / 2) / longest_edge as u64).max(1)
            as u32
    };
    (scaled(width), scaled(height))
}

fn resized_image_name(original_name: &str, width: u32, height: u32) -> String {
    let stem = Path::new(original_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("image");
    format!("{stem}-{width}x{height}.png")
}

pub(crate) fn cleanup_unreferenced_resize_images(
    data_dir: &Path,
    database: &crate::db::Database,
) -> Result<usize, String> {
    let resize_temp_dir = data_dir.join("temp").join("image-resize");
    if !resize_temp_dir.is_dir() {
        return Ok(0);
    }
    let resize_temp_dir = resize_temp_dir
        .canonicalize()
        .map_err(|error| format!("无法读取 Resize 临时目录: {error}"))?;
    let referenced_paths = database
        .list_all_projects()
        .map_err(|error| error.to_string())?
        .into_iter()
        .flat_map(|project| project.nodes)
        .filter_map(|node| {
            node.content
                .get("assetPath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .filter_map(|path| path.canonicalize().ok())
        .filter(|path| path.starts_with(&resize_temp_dir))
        .collect::<HashSet<_>>();

    let mut removed = 0;
    for entry in std::fs::read_dir(&resize_temp_dir)
        .map_err(|error| format!("扫描 Resize 临时目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取 Resize 临时文件失败: {error}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_resize_png = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("resize-") && name.ends_with(".png"))
            .unwrap_or(false);
        if !is_resize_png {
            continue;
        }
        let resolved = path
            .canonicalize()
            .map_err(|error| format!("验证 Resize 临时文件失败: {error}"))?;
        if referenced_paths.contains(&resolved) {
            continue;
        }
        match std::fs::remove_file(&resolved) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("删除孤立 Resize 临时文件失败: {error}"));
            }
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn cleanup_resize_images(state: State<'_, ApplicationState>) -> Result<usize, String> {
    let data_dir = state.data_dir.clone();
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_unreferenced_resize_images(&data_dir, &database)
    })
    .await
    .map_err(|error| format!("Resize 临时文件清理任务失败: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn resize_image(
    source_node_id: String,
    source_path: String,
    original_name: String,
    canvas_id: String,
    max_edge: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    state: State<'_, ApplicationState>,
) -> Result<ResizeImageResult, String> {
    if !(32..=16_384).contains(&max_edge) {
        return Err("图片最长边必须介于 32 到 16384 像素之间".to_owned());
    }
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return Err("Resize 节点位置或尺寸无效".to_owned());
    }

    let database = state.database.clone();
    let resize_temp_dir = state.data_dir.join("temp").join("image-resize");
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(source_path.trim());
        let source = source
            .canonicalize()
            .map_err(|error| format!("无法读取原图片: {error}"))?;
        let format =
            media_format(&source).ok_or_else(|| "原节点不是受支持的图片格式".to_owned())?;
        if format.kind != "image" {
            return Err("仅图片节点支持 Resize".to_owned());
        }

        let image = image::open(&source).map_err(|error| format!("无法解码原图片: {error}"))?;
        let original_width = image.width();
        let original_height = image.height();
        if original_width == 0 || original_height == 0 {
            return Err("原图片尺寸无效".to_owned());
        }
        let (resized_width, resized_height) =
            resized_image_dimensions(original_width, original_height, max_edge);
        let resized = if resized_width == original_width && resized_height == original_height {
            image
        } else {
            image.resize_exact(resized_width, resized_height, FilterType::Lanczos3)
        };
        std::fs::create_dir_all(&resize_temp_dir)
            .map_err(|error| format!("创建 Resize 临时目录失败: {error}"))?;
        let destination = resize_temp_dir.join(format!("resize-{}.png", Uuid::new_v4()));
        resized
            .save_with_format(&destination, ImageFormat::Png)
            .map_err(|error| format!("保存 Resize 图片失败: {error}"))?;

        let resized_name = resized_image_name(&original_name, resized_width, resized_height);
        let aspect_ratio = resized_width as f64 / resized_height as f64;
        let created = database.create_node(CreateNodeInput {
            canvas_id: Some(canvas_id.clone()),
            kind: Some("image".to_owned()),
            title: resized_name.clone(),
            content: json!({
                "assetPath": destination.to_string_lossy(),
                "mimeType": "image/png",
                "originalName": resized_name,
                "aspectRatio": aspect_ratio,
                "naturalWidth": resized_width,
                "naturalHeight": resized_height,
                "imageLayoutVersion": 1,
                "resizedFromNodeId": source_node_id,
                "resizeMaxEdge": max_edge,
            }),
            source: Some("image-resize".to_owned()),
            request_id: None,
            x: Some(x),
            y: Some(y),
            width: Some(width),
            height: Some(height),
        });
        let created = match created {
            Ok(result) => result,
            Err(error) => {
                let _ = std::fs::remove_file(&destination);
                return Err(error.to_string());
            }
        };
        let edge = database.create_edge(CreateEdgeInput {
            canvas_id: Some(canvas_id),
            source_node_id,
            target_node_id: created.node.id.clone(),
            kind: Some("image-resize".to_owned()),
            metadata: json!({
                "maxEdge": max_edge,
                "width": resized_width,
                "height": resized_height,
            }),
        });
        match edge {
            Ok(edge) => Ok(ResizeImageResult {
                node: created.node,
                edge,
            }),
            Err(error) => {
                let _ = database.delete_node(&created.node.id);
                let _ = std::fs::remove_file(&destination);
                Err(format!("创建 Resize 连线失败: {error}"))
            }
        }
    })
    .await
    .map_err(|error| format!("图片 Resize 任务失败: {error}"))?
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
    state
        .database
        .delete_node(&id)
        .map_err(|error| error.to_string())
}

fn delete_video_files_blocking(paths: Vec<String>) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }

    let mut unique_paths = HashSet::new();
    let mut resolved_paths = Vec::new();
    for path in paths {
        let candidate = PathBuf::from(&path);
        let is_video = media_format(&candidate).is_some_and(|format| format.kind == "video");
        if !is_video {
            return Err(format!("拒绝删除非视频文件：{}", candidate.display()));
        }
        let resolved = match candidate.canonicalize() {
            Ok(resolved) => resolved,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法定位视频文件 {path}: {error}")),
        };
        let metadata = resolved
            .metadata()
            .map_err(|error| format!("无法读取视频文件信息 {}: {error}", resolved.display()))?;
        if !metadata.is_file() {
            return Err(format!("目标不是文件：{}", resolved.display()));
        }
        if unique_paths.insert(resolved.clone()) {
            resolved_paths.push(resolved);
        }
    }

    let mut deleted_count = 0;
    for path in &resolved_paths {
        match std::fs::remove_file(path) {
            Ok(()) => deleted_count += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("删除视频文件失败 {}: {error}", path.display())),
        }
    }
    Ok(deleted_count)
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
pub fn replace_node_and_delete_undoable(
    input: ReplaceNodeAndDeleteInput,
    state: State<'_, ApplicationState>,
) -> Result<ReplaceNodeAndDeleteResult, String> {
    state
        .database
        .replace_node_and_delete_with_snapshot(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn restore_node_replacement(
    input: RestoreNodeReplacementInput,
    state: State<'_, ApplicationState>,
) -> Result<RestoreNodeReplacementResult, String> {
    state
        .database
        .restore_node_replacement(input)
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

#[tauri::command]
pub fn list_workflow_modules(
    include_deleted: Option<bool>,
    state: State<'_, ApplicationState>,
) -> Result<Vec<WorkflowModuleRecord>, String> {
    workflow_modules::list(
        &state.workflow_modules_dir,
        include_deleted.unwrap_or(false),
    )
}

#[tauri::command]
pub fn save_workflow_module(
    input: SaveWorkflowModuleInput,
    state: State<'_, ApplicationState>,
) -> Result<WorkflowModuleRecord, String> {
    workflow_modules::save(&state.workflow_modules_dir, input)
}

#[tauri::command]
pub fn validate_workflow_module_source(
    source_workflow_path: String,
    _adapter_kind: Option<String>,
    variant: Option<String>,
    bindings: Option<WorkflowBindings>,
) -> Result<WorkflowModuleValidation, String> {
    let variant = variant.as_deref().unwrap_or("reference-to-video");
    workflow_modules::validate_source(
        Path::new(source_workflow_path.trim().trim_matches('"')),
        variant,
        &bindings.unwrap_or_else(|| WorkflowBindings::for_variant(variant)),
    )
}

#[tauri::command]
pub fn trash_workflow_module(
    id: String,
    state: State<'_, ApplicationState>,
) -> Result<WorkflowModuleRecord, String> {
    workflow_modules::trash(&state.workflow_modules_dir, &id)
}

#[tauri::command]
pub fn restore_workflow_module(
    id: String,
    state: State<'_, ApplicationState>,
) -> Result<WorkflowModuleRecord, String> {
    workflow_modules::restore_from_trash(&state.workflow_modules_dir, &id)
}

#[tauri::command]
pub fn purge_workflow_module(id: String, state: State<'_, ApplicationState>) -> Result<(), String> {
    workflow_modules::purge(&state.workflow_modules_dir, &id)
}

#[tauri::command]
pub fn restore_workflow_module_backup(
    id: String,
    state: State<'_, ApplicationState>,
) -> Result<WorkflowModuleRecord, String> {
    workflow_modules::restore_latest_backup(&state.workflow_modules_dir, &id)
}

#[tauri::command]
pub fn export_workflow_module(
    id: String,
    state: State<'_, ApplicationState>,
) -> Result<String, String> {
    workflow_modules::export(
        &state.workflow_modules_dir,
        &state.workflow_module_exports_dir,
        &id,
    )
}

#[tauri::command]
pub fn import_workflow_module_bundle(
    bundle_path: String,
    state: State<'_, ApplicationState>,
) -> Result<WorkflowModuleRecord, String> {
    workflow_modules::import_bundle(
        &state.workflow_modules_dir,
        Path::new(bundle_path.trim().trim_matches('"')),
    )
}

#[tauri::command]
pub fn restore_workflow_module_bundle(
    id: String,
    bundle_path: String,
    state: State<'_, ApplicationState>,
) -> Result<WorkflowModuleRecord, String> {
    workflow_modules::restore_bundle(
        &state.workflow_modules_dir,
        &id,
        Path::new(bundle_path.trim().trim_matches('"')),
    )
}

fn is_model_name_in_directory(value: &str, expected_directory: &str) -> bool {
    let normalized = value.trim().replace('/', "\\");
    normalized
        .split_once('\\')
        .is_some_and(|(directory, filename)| {
            directory.eq_ignore_ascii_case(expected_directory) && !filename.trim().is_empty()
        })
}

fn diffusion_models_from_object_info(
    value: &Value,
    class_type: &str,
    directory: &str,
) -> Vec<String> {
    let pointer = format!("/{class_type}/input/required/unet_name/0");
    let mut models = value
        .pointer(&pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| is_model_name_in_directory(name, directory))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    models.sort_by_key(|name| name.to_ascii_lowercase());
    models.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    models
}

fn loras_from_object_info(value: &Value, class_type: &str, directory: &str) -> Vec<String> {
    let pointer = format!("/{class_type}/input/required/lora_name/0");
    let mut loras = value
        .pointer(&pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| is_model_name_in_directory(name, directory))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    loras.sort_by_key(|name| name.to_ascii_lowercase());
    loras.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    loras
}

#[tauri::command]
pub async fn get_comfyui_h3_loras(server_url: String) -> Result<Vec<String>, String> {
    const LORA_CLASS_TYPE: &str = "LoraLoaderModelOnly";
    const LORA_DIRECTORY: &str = "MinimaxH3";
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
        .get(format!("{server_url}/object_info/{LORA_CLASS_TYPE}"))
        .send()
        .await
        .map_err(|error| format!("读取 ComfyUI LoRA 列表失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("读取 ComfyUI LoRA 列表失败：{error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("解析 ComfyUI LoRA 列表失败：{error}"))?;
    Ok(loras_from_object_info(
        &value,
        LORA_CLASS_TYPE,
        LORA_DIRECTORY,
    ))
}

#[tauri::command]
pub async fn get_comfyui_h3_diffusion_models(
    server_url: String,
    workflow_module_id: Option<String>,
    state: State<'_, ApplicationState>,
) -> Result<Vec<String>, String> {
    let bindings = if let Some(module_id) = workflow_module_id.as_deref() {
        workflow_modules::get(&state.workflow_modules_dir, module_id)?
            .adapter
            .bindings
    } else {
        WorkflowBindings::default()
    };
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
        .get(format!(
            "{server_url}/object_info/{}",
            bindings.diffusion_model_class_type
        ))
        .send()
        .await
        .map_err(|error| format!("读取 ComfyUI 大模型列表失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("读取 ComfyUI 大模型列表失败：{error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("解析 ComfyUI 大模型列表失败：{error}"))?;
    Ok(diffusion_models_from_object_info(
        &value,
        &bindings.diffusion_model_class_type,
        &bindings.diffusion_model_directory,
    ))
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

fn configure_h3_diffusion_model(
    workflow: &mut Value,
    diffusion_model_name: &str,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    let node = workflow
        .get(&bindings.diffusion_model_node_id)
        .ok_or_else(|| {
            format!(
                "API 工作流缺少大模型加载节点 {}",
                bindings.diffusion_model_node_id
            )
        })?;
    let class_type = node.get("class_type").and_then(Value::as_str).unwrap_or("");
    if class_type != bindings.diffusion_model_class_type {
        return Err(format!(
            "节点 {} 必须是大模型加载器 {}，实际为 {}",
            bindings.diffusion_model_node_id,
            bindings.diffusion_model_class_type,
            if class_type.is_empty() {
                "<缺失>"
            } else {
                class_type
            }
        ));
    }
    set_workflow_input(
        workflow,
        &bindings.diffusion_model_node_id,
        "unet_name",
        Value::String(diffusion_model_name.to_owned()),
    )
}

fn configure_h3_loras(
    workflow: &mut Value,
    primary_lora_name: &str,
    primary_lora_strength: f64,
    primary_lora_bypassed: bool,
    secondary_lora_name: &str,
    secondary_lora_strength: f64,
    secondary_lora_bypassed: bool,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    let read_lora_upstream = |node_id: &str| -> Result<Value, String> {
        let class_type = workflow
            .get(node_id)
            .and_then(|node| node.get("class_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if class_type != bindings.lora_class_type {
            return Err(format!(
                "API 工作流节点 {node_id} 必须是 LoRA 加载器 {}",
                bindings.lora_class_type
            ));
        }
        workflow
            .get(node_id)
            .and_then(|node| node.get("inputs"))
            .and_then(|inputs| inputs.get("model"))
            .cloned()
            .ok_or_else(|| format!("API 工作流 LoRA 节点 {node_id} 缺少上游 model 连接"))
    };
    let primary_upstream = read_lora_upstream(&bindings.primary_lora_node_id)?;
    let secondary_upstream = read_lora_upstream(&bindings.secondary_lora_node_id)?;

    if !primary_lora_bypassed {
        set_workflow_input(
            workflow,
            &bindings.primary_lora_node_id,
            "lora_name",
            Value::String(primary_lora_name.to_owned()),
        )?;
        set_workflow_input(
            workflow,
            &bindings.primary_lora_node_id,
            "strength_model",
            json!(primary_lora_strength),
        )?;
    }
    if !secondary_lora_bypassed {
        set_workflow_input(
            workflow,
            &bindings.secondary_lora_node_id,
            "lora_name",
            Value::String(secondary_lora_name.to_owned()),
        )?;
        set_workflow_input(
            workflow,
            &bindings.secondary_lora_node_id,
            "strength_model",
            json!(secondary_lora_strength),
        )?;
    }

    let primary_model = if primary_lora_bypassed {
        primary_upstream
    } else {
        json!([bindings.primary_lora_node_id, 0])
    };
    let secondary_model = if secondary_lora_bypassed {
        secondary_upstream
    } else {
        json!([bindings.secondary_lora_node_id, 0])
    };
    set_workflow_input(
        workflow,
        &bindings.primary_sampler_node_id,
        "model",
        primary_model,
    )?;
    set_workflow_input(
        workflow,
        &bindings.secondary_scheduler_node_id,
        "model",
        secondary_model.clone(),
    )?;
    set_workflow_input(
        workflow,
        &bindings.secondary_guider_node_id,
        "model",
        secondary_model,
    )?;
    Ok(())
}

fn configure_h3_steps(
    workflow: &mut Value,
    primary_video_steps: u32,
    primary_audio_steps: u32,
    secondary_scheduler_steps: u32,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    set_workflow_input(
        workflow,
        &bindings.primary_sampler_node_id,
        "video_steps",
        json!(primary_video_steps),
    )?;
    set_workflow_input(
        workflow,
        &bindings.primary_sampler_node_id,
        "audio_steps",
        json!(primary_audio_steps),
    )?;
    set_workflow_input(
        workflow,
        &bindings.secondary_scheduler_node_id,
        "steps",
        json!(secondary_scheduler_steps),
    )?;
    Ok(())
}

fn configure_h3_color_adjustments(
    workflow: &mut Value,
    primary_brightness: f64,
    primary_contrast: f64,
    primary_saturation: f64,
    secondary_brightness: f64,
    secondary_contrast: f64,
    secondary_saturation: f64,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    for (node_id, brightness, contrast, saturation) in [
        (
            bindings.primary_color_node_id.as_str(),
            primary_brightness,
            primary_contrast,
            primary_saturation,
        ),
        (
            bindings.secondary_color_node_id.as_str(),
            secondary_brightness,
            secondary_contrast,
            secondary_saturation,
        ),
    ] {
        set_workflow_input(workflow, node_id, "brightness", json!(brightness))?;
        set_workflow_input(workflow, node_id, "contrast", json!(contrast))?;
        set_workflow_input(workflow, node_id, "saturation", json!(saturation))?;
    }
    Ok(())
}

fn install_clean_video_output(
    workflow: &mut Value,
    secondary_sampling_enabled: bool,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    let source_output_node_id = if secondary_sampling_enabled {
        &bindings.secondary_output_node_id
    } else {
        &bindings.primary_output_node_id
    };
    let filename_prefix_template = workflow
        .get(source_output_node_id)
        .and_then(|node| node.get("inputs"))
        .and_then(|inputs| inputs.get("filename_prefix"))
        .and_then(Value::as_str)
        .unwrap_or("%date:yyyy-MM-dd%/Minimax_H3")
        .to_owned();
    let current_date = Local::now().format("%Y-%m-%d").to_string();
    let filename_prefix = resolve_filename_prefix_date(&filename_prefix_template, &current_date);
    let (image_node_id, audio_node_id, audio_output_index) = if secondary_sampling_enabled {
        (
            bindings.secondary_color_node_id.as_str(),
            bindings.secondary_audio_output_node_id.as_str(),
            bindings.secondary_audio_output_index,
        )
    } else {
        (
            bindings.primary_color_node_id.as_str(),
            bindings.primary_audio_output_node_id.as_str(),
            bindings.primary_audio_output_index,
        )
    };
    let workflow_object = workflow
        .as_object_mut()
        .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?;
    workflow_object.remove(&bindings.primary_output_node_id);
    workflow_object.remove(&bindings.secondary_output_node_id);
    workflow_object.insert(
        bindings.clean_video_node_id.clone(),
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
        bindings.clean_save_node_id.clone(),
        json!({
            "inputs": {
                "video": [bindings.clean_video_node_id, 0],
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

fn resolve_filename_prefix_date(filename_prefix: &str, current_date: &str) -> String {
    filename_prefix.replace("%date:yyyy-MM-dd%", current_date)
}

fn configure_h3_ref_image_size(
    workflow: &mut Value,
    ref_image_size: &str,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    set_workflow_input(
        workflow,
        &bindings.conditioning_node_id,
        "ref_image_size",
        Value::String(ref_image_size.to_owned()),
    )
}

fn configure_h3_strict_prompt_tags(
    workflow: &mut Value,
    strict_prompt_tags: bool,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    set_workflow_input(
        workflow,
        &bindings.conditioning_node_id,
        "strict_prompt_tags",
        json!(strict_prompt_tags),
    )
}

fn configure_h3_uploaded_media(
    workflow: &mut Value,
    variant: &str,
    uploaded_images: &[String],
    image_roles: &[String],
    uploaded_audios: &[String],
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    if variant == "image-to-video" {
        let image_node_id = bindings
            .image_node_ids
            .first()
            .ok_or_else(|| "图生视频适配器必须配置首帧图片输入节点".to_owned())?;
        let uploaded_name = uploaded_images
            .first()
            .ok_or_else(|| "图生视频必须提供一张首帧图片".to_owned())?;
        set_workflow_input(
            workflow,
            image_node_id,
            "image",
            Value::String(uploaded_name.clone()),
        )?;
        return Ok(());
    }
    if variant == "last-frame-to-video" {
        let image_node_id = bindings
            .image_node_ids
            .first()
            .ok_or_else(|| "尾帧生视频适配器必须配置尾帧图片输入节点".to_owned())?;
        let uploaded_name = uploaded_images
            .first()
            .ok_or_else(|| "尾帧生视频必须提供一张尾帧图片".to_owned())?;
        set_workflow_input(
            workflow,
            image_node_id,
            "image",
            Value::String(uploaded_name.clone()),
        )?;
        return Ok(());
    }
    if variant == "first-last-frame" {
        let frame_nodes = bindings
            .image_node_ids
            .get(0..2)
            .ok_or_else(|| "首尾帧适配器必须配置首帧和尾帧两个图片输入节点".to_owned())?;
        for (role, node_id) in [("first", &frame_nodes[0]), ("last", &frame_nodes[1])] {
            let input_name = if role == "first" {
                "first_frame"
            } else {
                "last_frame"
            };
            let uploaded_name = uploaded_images
                .iter()
                .enumerate()
                .find_map(|(index, name)| {
                    let assigned_role = image_roles
                        .get(index)
                        .map(String::as_str)
                        .unwrap_or_else(|| if index == 0 { "first" } else { "last" });
                    (assigned_role == role).then_some(name)
                });
            if let Some(uploaded_name) = uploaded_name {
                set_workflow_input(
                    workflow,
                    node_id,
                    "image",
                    Value::String(uploaded_name.clone()),
                )?;
            } else {
                workflow
                    .as_object_mut()
                    .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?
                    .remove(node_id);
                remove_workflow_input(workflow, &bindings.conditioning_node_id, input_name)?;
            }
        }
        return Ok(());
    }

    for (index, node_id) in bindings.image_node_ids.iter().enumerate() {
        let input_name = format!("ref_images.ref_image_{index}");
        if let Some(uploaded_name) = uploaded_images.get(index) {
            set_workflow_input(
                workflow,
                node_id,
                "image",
                Value::String(uploaded_name.clone()),
            )?;
        } else {
            workflow
                .as_object_mut()
                .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?
                .remove(node_id);
            remove_workflow_input(workflow, &bindings.conditioning_node_id, &input_name)?;
        }
    }
    for (index, node_id) in bindings.audio_node_ids.iter().enumerate() {
        let input_name = format!("ref_audios.ref_audio_{index}");
        if let Some(uploaded_name) = uploaded_audios.get(index) {
            set_workflow_input(
                workflow,
                node_id,
                "audio",
                Value::String(uploaded_name.clone()),
            )?;
        } else {
            workflow
                .as_object_mut()
                .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?
                .remove(node_id);
            remove_workflow_input(workflow, &bindings.conditioning_node_id, &input_name)?;
        }
    }
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
    primary_video_steps: u32,
    primary_audio_steps: u32,
    secondary_scheduler_steps: u32,
    primary_brightness: f64,
    primary_contrast: f64,
    primary_saturation: f64,
    secondary_brightness: f64,
    secondary_contrast: f64,
    secondary_saturation: f64,
    secondary_sampling_enabled: bool,
    lora_name: &str,
    lora_strength: f64,
    lora_bypassed: bool,
    secondary_lora_name: &str,
    secondary_lora_strength: f64,
    secondary_lora_bypassed: bool,
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    set_workflow_input(
        workflow,
        &bindings.prompt_node_id,
        "value",
        Value::String(prompt.to_owned()),
    )?;
    set_workflow_input(workflow, &bindings.seed_node_id, "noise_seed", json!(seed))?;
    set_workflow_input(
        workflow,
        &bindings.duration_node_id,
        "value",
        json!(duration_seconds),
    )?;
    set_workflow_input(
        workflow,
        &bindings.primary_resolution_node_id,
        "aspect_ratio",
        Value::String(aspect_ratio.to_owned()),
    )?;
    set_workflow_input(
        workflow,
        &bindings.primary_resolution_node_id,
        "megapixels",
        json!(primary_resolution_megapixels),
    )?;
    if secondary_sampling_enabled {
        set_workflow_input(
            workflow,
            &bindings.secondary_resolution_node_id,
            "aspect_ratio",
            Value::String(aspect_ratio.to_owned()),
        )?;
        set_workflow_input(
            workflow,
            &bindings.secondary_resolution_node_id,
            "megapixels",
            json!(secondary_resolution_megapixels),
        )?;
    }
    configure_h3_steps(
        workflow,
        primary_video_steps,
        primary_audio_steps,
        secondary_scheduler_steps,
        bindings,
    )?;
    configure_h3_color_adjustments(
        workflow,
        primary_brightness,
        primary_contrast,
        primary_saturation,
        secondary_brightness,
        secondary_contrast,
        secondary_saturation,
        bindings,
    )?;
    configure_h3_loras(
        workflow,
        lora_name,
        lora_strength,
        lora_bypassed,
        secondary_lora_name,
        secondary_lora_strength,
        secondary_lora_bypassed,
        bindings,
    )?;
    install_clean_video_output(workflow, secondary_sampling_enabled, bindings)?;
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
        None,
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
    bindings: &WorkflowBindings,
) -> Result<(), String> {
    let workflow_object = workflow
        .as_object_mut()
        .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?;
    workflow_object.insert(
        bindings.secondary_video_input_node_id.clone(),
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
        &bindings.secondary_resize_node_id,
        "image",
        json!([bindings.secondary_video_input_node_id, 0]),
    )?;
    set_workflow_input(
        workflow,
        &bindings.secondary_audio_encode_node_id,
        "audio",
        json!([bindings.secondary_video_input_node_id, 2]),
    )?;
    set_workflow_input(
        workflow,
        &bindings.clean_video_node_id,
        "audio",
        json!([bindings.secondary_video_input_node_id, 2]),
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
    cache_bust: Option<&str>,
) -> Result<String, String> {
    let mut url = Url::parse(&format!("{server_url}/view"))
        .map_err(|error| format!("ComfyUI 输出地址无效：{error}"))?;
    let mut query = url.query_pairs_mut();
    query
        .append_pair("filename", filename)
        .append_pair("subfolder", subfolder)
        .append_pair("type", file_type);
    if let Some(cache_bust) = cache_bust.filter(|value| !value.is_empty()) {
        // ComfyUI reuses output paths in some workflows.  Give each completed
        // prompt a distinct media URL so WebView does not replay an older byte
        // stream from its HTTP cache when that path has been overwritten.
        query.append_pair("infinite_canvas_prompt", cache_bust);
    }
    drop(query);
    Ok(url.into())
}

fn ensure_comfy_task_active(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("ComfyUI 生成已取消".to_owned())
    } else {
        Ok(())
    }
}

fn validate_workflow_media_counts(
    variant: &str,
    contract: &WorkflowInputContract,
    image_count: usize,
    audio_count: usize,
    video_count: usize,
) -> Result<(), String> {
    if variant == "first-last-frame" {
        if image_count != 2 {
            return Err(format!(
                "首尾帧模式必须提供两张图片（首帧和尾帧），当前为 {image_count} 张"
            ));
        }
        if audio_count > 0 || video_count > 0 {
            return Err("首尾帧模式不能包含音频或视频参考".to_owned());
        }
    }
    if variant == "image-to-video" {
        if image_count != 1 {
            return Err(format!(
                "图生视频模式必须提供一张首帧图片，当前为 {image_count} 张"
            ));
        }
        if audio_count > 0 || video_count > 0 {
            return Err("图生视频模式不能包含音频或视频参考".to_owned());
        }
    }
    if variant == "last-frame-to-video" {
        if image_count != 1 {
            return Err(format!(
                "尾帧生视频模式必须提供一张尾帧图片，当前为 {image_count} 张"
            ));
        }
        if audio_count > 0 || video_count > 0 {
            return Err("尾帧生视频模式不能包含音频或视频参考".to_owned());
        }
    }
    if image_count < contract.image_min || image_count > contract.image_max {
        return Err(format!(
            "当前方案要求参考图片数量为 {}–{} 张",
            contract.image_min, contract.image_max
        ));
    }
    if audio_count < contract.audio_min || audio_count > contract.audio_max {
        return Err(format!(
            "当前方案要求参考音频数量为 {}–{} 个",
            contract.audio_min, contract.audio_max
        ));
    }
    if video_count < contract.video_min || video_count > contract.video_max {
        return Err(format!(
            "当前方案要求参考视频数量为 {}–{} 个",
            contract.video_min, contract.video_max
        ));
    }
    Ok(())
}

async fn submit_comfyui_workflow_inner(
    input: ComfySubmitInput,
    task: Arc<RunningComfyTask>,
    workflow_modules_dir: &Path,
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
    let (workflow_path, adapter) = if let Some(module_id) = input.workflow_module_id.as_deref() {
        let module = workflow_modules::get(workflow_modules_dir, module_id)?;
        (module.workflow_path, module.adapter)
    } else {
        (
            input.workflow_path.clone(),
            workflow_modules::WorkflowAdapter::current_h3(WorkflowBindings::default()),
        )
    };
    let adapter_variant = adapter.variant.clone();
    let contract = &adapter.input_contract;
    let bindings = &adapter.bindings;
    let generation_seed = resolve_generation_seed(&input.seed_mode, &input.seed)?;
    validate_workflow_media_counts(
        &adapter_variant,
        contract,
        input.image_paths.len(),
        input.audio_paths.len(),
        input.video_paths.len(),
    )?;
    if adapter_variant == "first-last-frame" && !input.image_roles.is_empty() {
        if input.image_roles.len() != input.image_paths.len() {
            return Err("首尾帧图片角色数量与图片数量不一致".to_owned());
        }
        let mut seen_roles = HashSet::new();
        for role in &input.image_roles {
            if !matches!(role.as_str(), "first" | "last") {
                return Err("首尾帧图片角色必须是 first 或 last".to_owned());
            }
            if !seen_roles.insert(role.as_str()) {
                return Err("首帧和尾帧不能重复指定".to_owned());
            }
        }
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
    if input.primary_video_steps < 1 {
        return Err("一采 Video Steps 必须是正整数".to_owned());
    }
    if input.primary_audio_steps < input.primary_video_steps {
        return Err("一采 Audio Steps 不能小于 Video Steps".to_owned());
    }
    if input.secondary_scheduler_steps < 1 {
        return Err("二采基本调度器 Steps 必须是正整数".to_owned());
    }
    let ref_image_size = input.ref_image_size.trim();
    if !matches!(ref_image_size, "max" | "match") {
        return Err("参考图片尺寸模式必须是 max 或 match".to_owned());
    }
    for (label, value) in [
        ("一采亮度", input.primary_brightness),
        ("一采对比度", input.primary_contrast),
        ("一采饱和度", input.primary_saturation),
        ("二采亮度", input.secondary_brightness),
        ("二采对比度", input.secondary_contrast),
        ("二采饱和度", input.secondary_saturation),
    ] {
        if !value.is_finite() || !(0.0..=3.0).contains(&value) {
            return Err(format!("{label}必须在0.00到3.00之间"));
        }
    }
    let lora_name = input.lora_name.trim();
    if !is_model_name_in_directory(lora_name, &bindings.lora_directory) {
        return Err(format!(
            "LoRA 只能选择 {} 目录中的模型",
            bindings.lora_directory
        ));
    }
    if !input.lora_strength.is_finite() || input.lora_strength < 0.0 || input.lora_strength > 2.0 {
        return Err("LoRA 权重必须在0.0到2.0之间".to_owned());
    }
    let secondary_lora_name = input.secondary_lora_name.as_deref().unwrap_or("").trim();
    let secondary_lora_bypassed =
        secondary_lora_name.is_empty() || input.secondary_lora_bypassed.unwrap_or(false);
    let secondary_lora_strength = input.secondary_lora_strength.unwrap_or(1.0);
    if !secondary_lora_bypassed
        && !is_model_name_in_directory(secondary_lora_name, &bindings.lora_directory)
    {
        return Err(format!(
            "二采 LoRA 只能选择 {} 目录中的模型；未设置二采 LoRA 时请开启 Bypass",
            bindings.lora_directory
        ));
    }
    if !secondary_lora_strength.is_finite()
        || secondary_lora_strength < 0.0
        || secondary_lora_strength > 2.0
    {
        return Err("二采 LoRA 权重必须在0.0到2.0之间".to_owned());
    }
    let diffusion_model_name = input.diffusion_model_name.trim();
    if !is_model_name_in_directory(diffusion_model_name, &bindings.diffusion_model_directory) {
        return Err(format!(
            "基础模型只能选择 diffusion_models/{} 目录中的模型",
            bindings.diffusion_model_directory
        ));
    }

    let workflow_bytes = tokio::fs::read(&workflow_path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "H3 API 工作流文件不存在：{}。请在应用设置中更新工作流路径",
                workflow_path
            )
        } else {
            format!("读取 H3 API 工作流失败（{}）：{error}", workflow_path)
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
    configure_h3_diffusion_model(&mut workflow, diffusion_model_name, bindings)?;

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
        input.primary_video_steps,
        input.primary_audio_steps,
        input.secondary_scheduler_steps,
        input.primary_brightness,
        input.primary_contrast,
        input.primary_saturation,
        input.secondary_brightness,
        input.secondary_contrast,
        input.secondary_saturation,
        input.secondary_sampling_enabled || uploaded_secondary_source.is_some(),
        lora_name,
        input.lora_strength,
        input.lora_bypassed,
        secondary_lora_name,
        secondary_lora_strength,
        secondary_lora_bypassed,
        &bindings,
    )?;
    configure_h3_ref_image_size(&mut workflow, ref_image_size, bindings)?;
    if let Some(strict_prompt_tags) = input.strict_prompt_tags {
        configure_h3_strict_prompt_tags(&mut workflow, strict_prompt_tags, bindings)?;
    }
    configure_h3_uploaded_media(
        &mut workflow,
        &adapter_variant,
        &uploaded_images,
        &input.image_roles,
        &uploaded_audios,
        bindings,
    )?;
    if let Some(uploaded_video) = uploaded_secondary_source.as_deref() {
        configure_secondary_source_video(&mut workflow, uploaded_video, &bindings)?;
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
        cancel_comfy_in_background(
            client.clone(),
            server_url.clone(),
            prompt_id,
            Some(task.clone()),
        );
        return Err("ComfyUI 生成已取消".to_owned());
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
                url: comfy_view_url(
                    &server_url,
                    &filename,
                    &subfolder,
                    &file_type,
                    Some(&prompt_id),
                )?,
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

    let workflow_modules_dir = state.workflow_modules_dir.clone();
    let mut result =
        submit_comfyui_workflow_inner(input, task.clone(), &workflow_modules_dir).await;
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
    let value = prompt
        .get(2)?
        .as_object()?
        .values()
        .find_map(|node| node.get("inputs")?.get("noise_seed"))?;
    value
        .as_u64()
        .map(|seed| seed.to_string())
        .or_else(|| value.as_str().map(str::to_owned))
}

fn comfy_outputs_from_history_entry(
    server_url: &str,
    entry: &Value,
) -> Result<Vec<ComfyOutputFile>, String> {
    let prompt_id = entry.pointer("/prompt/1").and_then(Value::as_str);
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
            url: comfy_view_url(server_url, &filename, &subfolder, &file_type, prompt_id)?,
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

fn cancel_comfy_in_background(
    client: Client,
    server_url: String,
    prompt_id: String,
    task: Option<Arc<RunningComfyTask>>,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = cancel_known_comfy_prompt(&client, &server_url, &prompt_id).await {
            eprintln!("ComfyUI 取消请求失败：{error}");
            return;
        }
        if let Err(error) = wait_until_comfy_prompt_stopped(&client, &server_url, &prompt_id).await
        {
            eprintln!("ComfyUI 取消确认失败：{error}");
            return;
        }
        if let Some(task) = task {
            if let Some(warning) = cleanup_comfy_task_inputs(&task).await {
                eprintln!("ComfyUI 已取消，但输入缓存清理失败：{warning}");
            }
        }
    });
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
    let server_url = server_url.trim().trim_end_matches('/').to_owned();
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
        tauri::async_runtime::spawn(async move {
            let result = async {
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
                        .find(|item| {
                            comfy_client_id_from_queue_item(item) == Some(client_id.as_str())
                        })
                        .and_then(comfy_prompt_id_from_queue_item)
                        .map(str::to_owned)
                });
                let Some(prompt_id) = prompt_id else {
                    return Ok::<(), String>(());
                };
                cancel_known_comfy_prompt(&client, &server_url, &prompt_id).await?;
                wait_until_comfy_prompt_stopped(&client, &server_url, &prompt_id).await
            }
            .await;
            if let Err(error) = result {
                eprintln!("恢复任务取消失败：{error}");
            }
        });
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

    cancel_comfy_in_background(client, server_url, prompt_id, Some(task));
    Ok(None)
}

#[tauri::command]
pub fn get_runtime_info(state: State<'_, ApplicationState>) -> RuntimeInfo {
    state.runtime.clone()
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_unreferenced_resize_images, comfy_execution_elapsed_seconds, comfy_input_task_path,
        comfy_queue_summary_from_value, comfy_view_url, configure_h3_diffusion_model,
        configure_h3_generation, configure_h3_ref_image_size, configure_h3_strict_prompt_tags,
        configure_h3_uploaded_media, configure_secondary_source_video, delete_video_files_blocking,
        diffusion_models_from_object_info, hash_app_lock_password, loras_from_object_info,
        media_format, resized_image_dimensions, resized_image_name, resolve_filename_prefix_date,
        resolve_generation_seed, validate_new_app_lock_password, validate_workflow_media_counts,
        verify_app_lock_hash, MediaFormat, WorkflowBindings, WorkflowInputContract,
        AUDIO_MAX_BYTES, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES,
    };
    use crate::{db::Database, models::CreateNodeInput};
    use serde_json::json;
    use std::{fs, path::Path};
    use uuid::Uuid;

    #[test]
    fn resizes_the_longest_image_edge_without_upscaling() {
        assert_eq!(resized_image_dimensions(4000, 3000, 1920), (1920, 1440));
        assert_eq!(resized_image_dimensions(3000, 4000, 1920), (1440, 1920));
        assert_eq!(resized_image_dimensions(800, 600, 1920), (800, 600));
    }

    #[test]
    fn names_resized_images_with_their_actual_dimensions() {
        assert_eq!(
            resized_image_name("示例照片.jpg", 1920, 1440),
            "示例照片-1920x1440.png"
        );
    }

    #[test]
    fn keeps_referenced_resize_files_until_their_node_is_deleted() {
        let root =
            std::env::temp_dir().join(format!("sucanvas-resize-cleanup-test-{}", Uuid::new_v4()));
        let data_dir = root.join("data");
        let resize_dir = data_dir.join("temp").join("image-resize");
        fs::create_dir_all(&resize_dir).unwrap();
        let referenced = resize_dir.join("resize-referenced.png");
        let orphaned = resize_dir.join("resize-orphaned.png");
        fs::write(&referenced, b"referenced").unwrap();
        fs::write(&orphaned, b"orphaned").unwrap();
        let database = Database::open(&data_dir.join("test.sqlite3")).unwrap();
        let node = database
            .create_node(CreateNodeInput {
                canvas_id: None,
                kind: Some("image".to_owned()),
                title: "Resize".to_owned(),
                content: json!({ "assetPath": referenced.to_string_lossy() }),
                source: Some("image-resize".to_owned()),
                request_id: None,
                x: None,
                y: None,
                width: None,
                height: None,
            })
            .unwrap()
            .node;

        assert_eq!(
            cleanup_unreferenced_resize_images(&data_dir, &database).unwrap(),
            1
        );
        assert!(referenced.exists());
        assert!(!orphaned.exists());

        database.delete_node(&node.id).unwrap();
        assert_eq!(
            cleanup_unreferenced_resize_images(&data_dir, &database).unwrap(),
            1
        );
        assert!(!referenced.exists());
        drop(database);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_date_template_before_submitting_save_video() {
        assert_eq!(
            resolve_filename_prefix_date("%date:yyyy-MM-dd%/Minimax_H3", "2026-08-10"),
            "2026-08-10/Minimax_H3"
        );
    }

    #[test]
    fn configures_reference_image_size_mode() {
        let mut workflow = json!({
            "363": { "inputs": { "ref_image_size": "max" } }
        });
        configure_h3_ref_image_size(&mut workflow, "match", &WorkflowBindings::default()).unwrap();
        assert_eq!(workflow["363"]["inputs"]["ref_image_size"], "match");
    }

    #[test]
    fn configures_strict_prompt_tag_validation() {
        let mut workflow = json!({
            "363": { "inputs": { "strict_prompt_tags": true } }
        });
        configure_h3_strict_prompt_tags(&mut workflow, false, &WorkflowBindings::default())
            .unwrap();
        assert_eq!(workflow["363"]["inputs"]["strict_prompt_tags"], false);
    }

    #[test]
    fn maps_first_and_last_frames_by_their_explicit_roles() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3首尾帧工作流.json");
        let mut workflow: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        configure_h3_uploaded_media(
            &mut workflow,
            "first-last-frame",
            &["tail.png".to_owned(), "head.png".to_owned()],
            &["last".to_owned(), "first".to_owned()],
            &[],
            &WorkflowBindings::first_last_frame(),
        )
        .unwrap();
        assert_eq!(workflow["335"]["inputs"]["image"], "head.png");
        assert_eq!(workflow["417"]["inputs"]["image"], "tail.png");
    }

    #[test]
    fn maps_image_to_video_image_to_the_first_frame_loader() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3图生视频工作流.json");
        let mut workflow: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        configure_h3_uploaded_media(
            &mut workflow,
            "image-to-video",
            &["first.png".to_owned()],
            &[],
            &[],
            &WorkflowBindings::image_to_video(),
        )
        .unwrap();
        assert_eq!(workflow["335"]["inputs"]["image"], "first.png");
        assert_eq!(workflow["333"]["inputs"]["first_frame"], json!(["335", 0]));
    }

    #[test]
    fn maps_last_frame_to_video_image_to_the_last_frame_loader() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3尾帧生视频工作流.json");
        let mut workflow: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        configure_h3_uploaded_media(
            &mut workflow,
            "last-frame-to-video",
            &["last.png".to_owned()],
            &[],
            &[],
            &WorkflowBindings::last_frame_to_video(),
        )
        .unwrap();
        assert_eq!(workflow["417"]["inputs"]["image"], "last.png");
        assert_eq!(workflow["333"]["inputs"]["last_frame"], json!(["417", 0]));
    }

    #[test]
    fn first_last_frame_requires_exactly_two_images_and_no_audio_or_video() {
        let contract = WorkflowInputContract {
            prompt_required: true,
            image_min: 2,
            image_max: 2,
            audio_min: 0,
            audio_max: 0,
            video_min: 0,
            video_max: 0,
        };
        assert!(validate_workflow_media_counts("first-last-frame", &contract, 2, 0, 0).is_ok());
        assert!(
            validate_workflow_media_counts("first-last-frame", &contract, 1, 0, 0)
                .unwrap_err()
                .contains("必须提供两张图片")
        );
        assert!(
            validate_workflow_media_counts("first-last-frame", &contract, 3, 0, 0)
                .unwrap_err()
                .contains("必须提供两张图片")
        );
        assert!(
            validate_workflow_media_counts("first-last-frame", &contract, 2, 1, 0)
                .unwrap_err()
                .contains("不能包含音频或视频参考")
        );
        assert!(
            validate_workflow_media_counts("first-last-frame", &contract, 2, 0, 1)
                .unwrap_err()
                .contains("不能包含音频或视频参考")
        );
    }

    #[test]
    fn image_to_video_requires_one_image_and_no_audio_or_video() {
        let contract = WorkflowInputContract {
            prompt_required: true,
            image_min: 1,
            image_max: 1,
            audio_min: 0,
            audio_max: 0,
            video_min: 0,
            video_max: 0,
        };
        assert!(validate_workflow_media_counts("image-to-video", &contract, 1, 0, 0).is_ok());
        assert!(
            validate_workflow_media_counts("image-to-video", &contract, 0, 0, 0)
                .unwrap_err()
                .contains("必须提供一张首帧图片")
        );
        assert!(
            validate_workflow_media_counts("image-to-video", &contract, 2, 0, 0)
                .unwrap_err()
                .contains("必须提供一张首帧图片")
        );
        assert!(
            validate_workflow_media_counts("image-to-video", &contract, 1, 1, 0)
                .unwrap_err()
                .contains("不能包含音频或视频参考")
        );
        assert!(
            validate_workflow_media_counts("image-to-video", &contract, 1, 0, 1)
                .unwrap_err()
                .contains("不能包含音频或视频参考")
        );
    }

    #[test]
    fn last_frame_to_video_requires_one_image_and_no_audio_or_video() {
        let contract = WorkflowInputContract {
            prompt_required: true,
            image_min: 1,
            image_max: 1,
            audio_min: 0,
            audio_max: 0,
            video_min: 0,
            video_max: 0,
        };
        assert!(validate_workflow_media_counts("last-frame-to-video", &contract, 1, 0, 0).is_ok());
        assert!(
            validate_workflow_media_counts("last-frame-to-video", &contract, 0, 0, 0)
                .unwrap_err()
                .contains("必须提供一张尾帧图片")
        );
        assert!(
            validate_workflow_media_counts("last-frame-to-video", &contract, 2, 0, 0)
                .unwrap_err()
                .contains("必须提供一张尾帧图片")
        );
        assert!(
            validate_workflow_media_counts("last-frame-to-video", &contract, 1, 1, 0)
                .unwrap_err()
                .contains("不能包含音频或视频参考")
        );
        assert!(
            validate_workflow_media_counts("last-frame-to-video", &contract, 1, 0, 1)
                .unwrap_err()
                .contains("不能包含音频或视频参考")
        );
    }

    fn resolution_test_workflow() -> serde_json::Value {
        json!({
            "339": { "inputs": { "value": "old prompt" } },
            "340": { "inputs": { "aspect_ratio": "16:9 (Widescreen)", "megapixels": 0.4 } },
            "348": { "inputs": { "noise_seed": 0 } },
            "350": { "inputs": { "value": 15.0 } },
            "357": {
                "inputs": {
                    "video_steps": 6,
                    "audio_steps": 8,
                    "model": ["354", 0]
                },
                "class_type": "MiniMaxH3MultiRateSamplerEXPT8"
            },
            "354": {
                "inputs": {
                    "lora_name": "MinimaxH3\\old-primary.safetensors",
                    "strength_model": 1.0,
                    "model": ["353", 0]
                },
                "class_type": "LoraLoaderModelOnly"
            },
            "360": { "inputs": { "save_output": false, "filename_prefix": "primary/video" } },
            "383": { "inputs": { "image": ["381", 0] } },
            "388": { "inputs": { "audio": ["382", 0] } },
            "391": {
                "inputs": {
                    "scheduler": "simple",
                    "steps": 4,
                    "denoise": 0.2,
                    "model": ["401", 0]
                },
                "class_type": "BasicScheduler"
            },
            "393": {
                "inputs": {
                    "model": ["354", 0],
                    "conditioning": ["363", 0]
                },
                "class_type": "BasicGuider"
            },
            "397": { "inputs": { "save_output": true, "filename_prefix": "secondary/video" } },
            "398": { "inputs": { "aspect_ratio": "16:9 (Widescreen)", "megapixels": 0.5 } },
            "403": {
                "inputs": { "brightness": 1.0, "contrast": 0.9, "saturation": 1.0 },
                "class_type": "LayerColor: BrightnessContrastV2"
            },
            "405": {
                "inputs": { "brightness": 1.0, "contrast": 0.9, "saturation": 0.9 },
                "class_type": "LayerColor: BrightnessContrastV2"
            },
            "401": {
                "inputs": {
                    "lora_name": "MinimaxH3\\old-secondary.safetensors",
                    "strength_model": 1.0,
                    "model": ["353", 0]
                },
                "class_type": "LoraLoaderModelOnly"
            },
            "358": {
                "inputs": {
                    "unet_name": "MinimaxH3\\old-model.safetensors",
                    "weight_dtype": "default"
                },
                "class_type": "UNETLoader"
            }
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
    fn cache_busts_completed_output_urls_by_prompt_id() {
        let old_output = comfy_view_url(
            "http://127.0.0.1:8188",
            "video.mp4",
            "primary",
            "output",
            Some("old-prompt"),
        )
        .unwrap();
        let new_output = comfy_view_url(
            "http://127.0.0.1:8188",
            "video.mp4",
            "primary",
            "output",
            Some("new-prompt"),
        )
        .unwrap();

        assert_ne!(old_output, new_output);
        assert!(old_output.contains("infinite_canvas_prompt=old-prompt"));
        assert!(new_output.contains("infinite_canvas_prompt=new-prompt"));
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
            6,
            8,
            4,
            1.0,
            0.9,
            0.9,
            1.0,
            0.9,
            1.0,
            true,
            r"MinimaxH3\test.safetensors",
            0.75,
            false,
            r"MinimaxH3\secondary-test.safetensors",
            0.55,
            false,
            &WorkflowBindings::default(),
        )
        .unwrap();
        configure_secondary_source_video(
            &mut workflow,
            "infinite-canvas/job/source.mp4",
            &WorkflowBindings::default(),
        )
        .unwrap();

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
            7,
            9,
            5,
            1.1,
            0.8,
            0.7,
            1.2,
            0.85,
            1.05,
            true,
            r"MinimaxH3\selected.safetensors",
            0.65,
            false,
            r"MinimaxH3\secondary-selected.safetensors",
            0.45,
            false,
            &WorkflowBindings::default(),
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
        assert_eq!(workflow.pointer("/357/inputs/video_steps"), Some(&json!(7)));
        assert_eq!(workflow.pointer("/357/inputs/audio_steps"), Some(&json!(9)));
        assert_eq!(workflow.pointer("/391/inputs/steps"), Some(&json!(5)));
        assert_eq!(
            workflow.pointer("/405/inputs/brightness"),
            Some(&json!(1.1))
        );
        assert_eq!(workflow.pointer("/405/inputs/contrast"), Some(&json!(0.8)));
        assert_eq!(
            workflow.pointer("/405/inputs/saturation"),
            Some(&json!(0.7))
        );
        assert_eq!(
            workflow.pointer("/403/inputs/brightness"),
            Some(&json!(1.2))
        );
        assert_eq!(workflow.pointer("/403/inputs/contrast"), Some(&json!(0.85)));
        assert_eq!(
            workflow.pointer("/403/inputs/saturation"),
            Some(&json!(1.05))
        );
        assert_eq!(
            workflow.pointer("/354/inputs/lora_name"),
            Some(&json!(r"MinimaxH3\selected.safetensors"))
        );
        assert_eq!(
            workflow.pointer("/354/inputs/strength_model"),
            Some(&json!(0.65))
        );
        assert_eq!(
            workflow.pointer("/401/inputs/lora_name"),
            Some(&json!(r"MinimaxH3\secondary-selected.safetensors"))
        );
        assert_eq!(
            workflow.pointer("/401/inputs/strength_model"),
            Some(&json!(0.45))
        );
        assert_eq!(
            workflow.pointer("/393/inputs/model"),
            Some(&json!(["401", 0]))
        );
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
            6,
            8,
            4,
            1.0,
            0.9,
            0.9,
            1.0,
            0.9,
            1.0,
            false,
            r"MinimaxH3\test.safetensors",
            1.0,
            false,
            "",
            1.0,
            true,
            &WorkflowBindings::default(),
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
                            "MinimaxH3\\minimax_h3_turbo_v4_step600_ema.safetensors",
                            "MinimaxH3\\turbo.safetensors",
                            "minimaxh3/quality.safetensors"
                        ]]
                    }
                }
            }
        });
        assert_eq!(
            loras_from_object_info(&object_info, "LoraLoaderModelOnly", "MinimaxH3"),
            vec![
                "minimaxh3/quality.safetensors".to_owned(),
                "MinimaxH3\\minimax_h3_turbo_v4_step600_ema.safetensors".to_owned(),
                "MinimaxH3\\turbo.safetensors".to_owned(),
            ]
        );
    }

    #[test]
    fn filters_and_applies_minimax_h3_diffusion_models() {
        let object_info = json!({
            "UNETLoader": {
                "input": {
                    "required": {
                        "unet_name": [[
                            "Other\\ignored.safetensors",
                            "MinimaxH3\\quality.safetensors",
                            "minimaxh3/fast.safetensors"
                        ]]
                    }
                }
            }
        });
        assert_eq!(
            diffusion_models_from_object_info(&object_info, "UNETLoader", "MinimaxH3"),
            vec![
                "minimaxh3/fast.safetensors".to_owned(),
                "MinimaxH3\\quality.safetensors".to_owned(),
            ]
        );

        let mut workflow = resolution_test_workflow();
        configure_h3_diffusion_model(
            &mut workflow,
            r"MinimaxH3\quality.safetensors",
            &WorkflowBindings::default(),
        )
        .unwrap();
        assert_eq!(
            workflow.pointer("/358/inputs/unet_name"),
            Some(&json!(r"MinimaxH3\quality.safetensors"))
        );
    }

    #[test]
    fn rejects_the_new_turbo_lora_loader_workflow() {
        let mut workflow = resolution_test_workflow();
        workflow["354"]["class_type"] = json!("MiniMaxH3TurboLoRA");
        let error = configure_h3_generation(
            &mut workflow,
            "prompt",
            42,
            6.0,
            "16:9 (Widescreen)",
            0.4,
            0.5,
            6,
            8,
            4,
            1.0,
            0.9,
            0.9,
            1.0,
            0.9,
            1.0,
            false,
            r"MinimaxH3\legacy.safetensors",
            0.8,
            false,
            "",
            1.0,
            true,
            &WorkflowBindings::default(),
        )
        .unwrap_err();
        assert!(error.contains("节点 354 必须是 LoRA 加载器 LoraLoaderModelOnly"));
    }

    #[test]
    fn bypasses_lora_in_both_sampling_stages() {
        let mut workflow = resolution_test_workflow();
        configure_h3_generation(
            &mut workflow,
            "prompt",
            42,
            6.0,
            "16:9 (Widescreen)",
            0.4,
            0.5,
            6,
            8,
            4,
            1.0,
            0.9,
            0.9,
            1.0,
            0.9,
            1.0,
            true,
            r"MinimaxH3\selected.safetensors",
            0.8,
            true,
            r"MinimaxH3\secondary-selected.safetensors",
            0.6,
            true,
            &WorkflowBindings::default(),
        )
        .unwrap();

        assert_eq!(
            workflow.pointer("/357/inputs/model"),
            Some(&json!(["353", 0]))
        );
        assert_eq!(
            workflow.pointer("/393/inputs/model"),
            Some(&json!(["353", 0]))
        );
        assert_eq!(
            workflow.pointer("/391/inputs/model"),
            Some(&json!(["353", 0]))
        );
        assert_eq!(
            workflow.pointer("/354/inputs/lora_name"),
            Some(&json!(r"MinimaxH3\old-primary.safetensors"))
        );
        assert_eq!(
            workflow.pointer("/401/inputs/lora_name"),
            Some(&json!(r"MinimaxH3\old-secondary.safetensors"))
        );
    }

    #[test]
    fn missing_secondary_lora_bypasses_only_the_secondary_stage() {
        let mut workflow = resolution_test_workflow();
        configure_h3_generation(
            &mut workflow,
            "prompt",
            42,
            6.0,
            "16:9 (Widescreen)",
            0.4,
            0.5,
            6,
            8,
            4,
            1.0,
            0.9,
            0.9,
            1.0,
            0.9,
            1.0,
            true,
            r"MinimaxH3\primary-selected.safetensors",
            0.8,
            false,
            "",
            1.0,
            true,
            &WorkflowBindings::default(),
        )
        .unwrap();

        assert_eq!(
            workflow.pointer("/357/inputs/model"),
            Some(&json!(["354", 0]))
        );
        assert_eq!(
            workflow.pointer("/391/inputs/model"),
            Some(&json!(["353", 0]))
        );
        assert_eq!(
            workflow.pointer("/393/inputs/model"),
            Some(&json!(["353", 0]))
        );
        assert_eq!(
            workflow.pointer("/354/inputs/lora_name"),
            Some(&json!(r"MinimaxH3\primary-selected.safetensors"))
        );
        assert_eq!(
            workflow.pointer("/401/inputs/lora_name"),
            Some(&json!(r"MinimaxH3\old-secondary.safetensors"))
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

        assert_eq!(delete_video_files_blocking(Vec::new()), Ok(0));

        assert_eq!(
            delete_video_files_blocking(vec![video_path.to_string_lossy().into_owned()]),
            Ok(1)
        );
        assert!(!video_path.exists());
        let missing_video_path = test_dir.join("already-deleted.mp4");
        assert_eq!(
            delete_video_files_blocking(vec![missing_video_path.to_string_lossy().into_owned()]),
            Ok(0)
        );
        assert!(
            delete_video_files_blocking(vec![text_path.to_string_lossy().into_owned()])
                .unwrap_err()
                .contains("拒绝删除非视频文件")
        );
        assert!(text_path.exists());
        assert!(delete_video_files_blocking(vec![test_dir
            .join("already-deleted.txt")
            .to_string_lossy()
            .into_owned()])
        .unwrap_err()
        .contains("拒绝删除非视频文件"));

        fs::remove_dir_all(test_dir).unwrap();
    }
}
