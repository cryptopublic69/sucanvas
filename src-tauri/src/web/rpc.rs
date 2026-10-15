use super::WebState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::path::{Path as FsPath, PathBuf};

pub fn argument<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("Invalid argument {key}: {e}"))
}
pub fn channel(state: &WebState, args: &Value) -> impl Fn(()) + Send + Sync + 'static {
    let id = args
        .get("onSubmitted")
        .and_then(|v| v.get("__webChannel"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let handle = state.handle.clone();
    move |_| {
        let _ = handle.emit(&format!("channel:{id}"), Value::Null);
    }
}

pub fn export_path(state: &WebState, resource: &str) -> Result<PathBuf, String> {
    let relative = resource
        .strip_prefix("sucanvas-export://")
        .ok_or("Invalid export resource")?;
    crate::portable::resource_path(&state.downloads, &format!("sucanvas://{relative}"))
}
pub fn ensure_contained(path: &FsPath, roots: &[PathBuf]) -> Result<(), String> {
    // Check the nearest existing parent as well as the lexical target. This
    // rejects traversal, alternate streams and junction/symlink escapes.
    if path.to_string_lossy().chars().any(|c| c == '\0') {
        return Err("Invalid path".into());
    }
    if path.components().any(|part| match part {
        std::path::Component::ParentDir => true,
        std::path::Component::Normal(value) => value.to_string_lossy().contains(':'),
        _ => false,
    }) {
        return Err("Invalid path".into());
    }
    let mut ancestor = path;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Missing path parent")?;
    }
    let resolved = ancestor.canonicalize().map_err(|e| e.to_string())?;
    // Compare resolved paths: mapped drives and UNC/verbatim paths can name
    // the same file. Traversal was rejected above; junction escapes remain
    // rejected because the resolved ancestor must be inside a resolved root.
    let allowed = roots.iter().any(|root| {
        root.canonicalize()
            .is_ok_and(|root| resolved.starts_with(root))
    });
    if !allowed {
        return Err("File access is outside the configured storage directories".into());
    }
    Ok(())
}
fn path_key(key: &str) -> bool {
    matches!(
        key,
        "path"
            | "url"
            | "sourcePath"
            | "destinationPath"
            | "bundlePath"
            | "sourceWorkflowPath"
            | "workflowPath"
            | "assetPath"
            | "previewImagePath"
            | "paths"
            | "imagePaths"
            | "audioPaths"
            | "videoPaths"
            | "sourceImagePath"
            | "sourceVideoPath"
    )
}
fn comfy_source_url(value: &str, public_origin: &str, comfy_url: &str) -> Option<String> {
    let absolute_prefix = format!("{public_origin}/api/comfy");
    let tail = value
        .strip_prefix(&absolute_prefix)
        .or_else(|| value.strip_prefix("/api/comfy"))?;
    if !tail.starts_with('/') || comfy_url.is_empty() {
        return None;
    }
    Some(format!("{}{tail}", comfy_url.trim_end_matches('/')))
}
pub fn normalize_args(state: &WebState, value: &mut Value, key: &str) -> Result<(), String> {
    match value {
        Value::String(text) => {
            if path_key(key) {
                let mut value = Value::String(text.clone());
                super::storage::normalize_record(state, &mut value);
                *text = value.as_str().unwrap().to_owned();
            }
            if path_key(key) && text.starts_with("/api/resource?") {
                let url = reqwest::Url::parse(&format!("http://localhost{text}"))
                    .map_err(|e| e.to_string())?;
                let resource = url
                    .query_pairs()
                    .find(|(key, _)| key == "resource")
                    .ok_or("Missing resource")?
                    .1
                    .to_string();
                *text = resource;
            }
            if matches!(key, "serverUrl" | "sourceServerUrl" | "comfyServerUrl") {
                *text = state.config.comfy_url.clone();
                return Ok(());
            }
            if key == "inputRootPath" {
                *text = state.config.comfy_input_directory.clone();
                return Ok(());
            }
            if text.starts_with("sucanvas://")
                || text.starts_with("sucanvas-input://")
                || text.starts_with("sucanvas-output://")
            {
                *text = super::storage::resource_path(state, text)?
                    .to_string_lossy()
                    .into_owned();
            } else if text.starts_with("sucanvas-export://") {
                *text = export_path(state, text)?.to_string_lossy().into_owned();
            }
            if let Some(url) =
                comfy_source_url(text, &state.config.origin(), &state.config.comfy_url)
            {
                *text = url;
            }
            if path_key(key)
                && !text.trim().is_empty()
                && !text.starts_with("http://")
                && !text.starts_with("https://")
            {
                let path = PathBuf::from(&*text);
                // Only managed files or administrator-configured ComfyUI output are reachable.
                let mut roots = vec![
                    state.core.assets_dir.clone(),
                    state.core.data_dir.join("assets"), // Pending legacy migration only.
                    state.core.data_dir.join("uploads"),
                    state.core.data_dir.join("temp"),
                    state.core.workflow_modules_dir.clone(),
                    state.core.workflow_module_exports_dir.clone(),
                    state.downloads.clone(),
                ];
                if !state.config.comfy_output_directory.is_empty() {
                    roots.push(PathBuf::from(&state.config.comfy_output_directory));
                }
                ensure_contained(&path, &roots)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                normalize_args(state, value, key)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if key == "content" {
                    super::storage::normalize_record(state, value);
                } else {
                    normalize_args(state, value, key)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn normalize_result(state: &WebState, value: &mut Value) {
    crate::portable::transform(value, &state.core.data_dir, false);
    match value {
        Value::String(text) => {
            *text = super::storage::encode(state, text);
            if let Ok(relative) = FsPath::new(text).strip_prefix(&state.downloads) {
                *text = format!(
                    "sucanvas-export://{}",
                    relative.to_string_lossy().replace('\\', "/")
                );
            }
            let prefix = state.config.comfy_url.trim_end_matches('/');
            if !prefix.is_empty()
                && text
                    .strip_prefix(prefix)
                    .is_some_and(|tail| tail.starts_with('/'))
            {
                *text = format!(
                    "{}/api/comfy{}",
                    state.config.origin(),
                    &text[prefix.len()..]
                );
            }
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| normalize_result(state, value)),
        Value::Object(values) => values.iter_mut().for_each(|(key, value)| {
            if key == "infinite-canvas:comfy-input-root" {
                *value = Value::String(super::connection::display_directory(
                    &state.config.comfy_input_directory,
                ));
            } else if key == "infinite-canvas:comfy-output-root" {
                *value = Value::String(super::connection::display_directory(
                    &state.config.comfy_output_directory,
                ));
            } else if matches!(
                key.as_str(),
                "comfyServerUrl"
                    | "serverUrl"
                    | "sourceServerUrl"
                    | "infinite-canvas:comfy-server-url"
            ) && value.is_string()
            {
                *value = Value::String(format!("{}/api/comfy", state.config.origin()));
            } else {
                normalize_result(state, value);
            }
        }),
        _ => {}
    }
}
#[derive(Deserialize)]
pub struct Request {
    #[serde(default = "empty_args")]
    args: Value,
    #[serde(default, rename = "webTaskId")]
    web_task_id: Option<String>,
}
fn empty_args() -> Value {
    json!({})
}
fn remove_unused_workflow_fallback(command: &str, args: &mut Value) {
    if command != "submit_comfyui_workflow" {
        return;
    }
    let Some(input) = args.get_mut("input").and_then(Value::as_object_mut) else {
        return;
    };
    if input.get("workflowModuleId").is_some_and(Value::is_string) {
        // Core execution resolves the selected module inside the managed
        // repository. The desktop fallback path is unused, even after restore.
        input.insert("workflowPath".into(), Value::String(String::new()));
    }
}
pub async fn invoke(
    State(state): State<WebState>,
    Path(command): Path<String>,
    Json(mut input): Json<Request>,
) -> Response {
    let _storage_guard = if matches!(
        command.as_str(),
        "import_media" | "export_app_backup" | "stage_app_backup_restore"
    ) || command.contains("node")
        || command.starts_with("delete_")
        || command.starts_with("export_")
    {
        Some(state.media_guard.clone().lock_owned().await)
    } else {
        None
    };
    let state = state.connection_snapshot();
    if command == "disable_app_lock" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Web 应用锁同时保护网络接口，不能关闭；可以在设置中修改密码。"})),
        )
            .into_response();
    }
    if command == "set_app_lock_password" {
        return match argument(&input.args, "input") {
            Ok(password) => super::auth::change_password(state, password).await,
            Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response(),
        };
    }
    remove_unused_workflow_fallback(&command, &mut input.args);
    if command == "import_media" {
        let directory = match super::storage::input_root(&state) {
            Ok(root) => root.join(super::storage::IMPORT_FOLDER),
            Err(error) => {
                return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response()
            }
        };
        if let Err(error) = std::fs::create_dir_all(directory) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": error.to_string()})),
            )
                .into_response();
        }
    }
    if command == "capture_video_poster" {
        if let Some(source) = input.args.get_mut("source") {
            if let Err(error) = normalize_args(&state, source, "sourcePath") {
                return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response();
            }
        }
    }
    if let Err(error) = normalize_args(&state, &mut input.args, "") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response();
    }
    if let Some(id) = input.web_task_id.as_deref() {
        if !command.starts_with("submit_comfyui_") {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "此操作不支持后台生成任务"})),
            )
                .into_response();
        }
        match state.tasks.reserve(id, &command, &input.args) {
            Ok(false) => return Json(json!({"taskId": id})).into_response(),
            Ok(true) => {}
            Err(error) => {
                return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response()
            }
        }
    }
    // An HTTP disconnect must not abort a generation already submitted to ComfyUI.
    let worker_state = state.clone();
    let task_id = input.web_task_id.clone();
    let worker = tokio::spawn(async move {
        let mut result = super::dispatch::dispatch(&worker_state, &command, &input.args).await?;
        if command.starts_with("submit_comfyui_") || command == "get_comfyui_client_task_statuses" {
            super::media::reference_outputs(&mut result)?;
        }
        if command == "import_media" {
            let physical_asset = result["node"]["content"]["assetPath"]
                .as_str()
                .ok_or("导入结果缺少素材路径")?
                .to_owned();
            let mut content = result["node"]["content"].clone();
            super::storage::encode_value(&worker_state, &mut content);
            let update = serde_json::from_value(
                serde_json::json!({"id": result["node"]["id"], "content": content}),
            )
            .map_err(|e| e.to_string())?;
            let node =
                crate::commands::update_node(update, crate::platform::State(&worker_state.core))?;
            let connection = rusqlite::Connection::open(
                worker_state.core.data_dir.join("infinite-canvas.sqlite3"),
            )
            .map_err(|e| e.to_string())?;
            connection
                .busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            connection
                .execute(
                    "UPDATE canvases SET preview_image_path=?1 WHERE preview_image_path=?2",
                    rusqlite::params![
                        super::storage::encode(&worker_state, &physical_asset),
                        physical_asset
                    ],
                )
                .map_err(|e| e.to_string())?;
            result["node"] = serde_json::to_value(node).map_err(|e| e.to_string())?;
            if let Some(source) = input.args["path"].as_str() {
                let path = PathBuf::from(source);
                if path.starts_with(worker_state.core.data_dir.join("uploads")) {
                    let _ = std::fs::remove_file(&path);
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::remove_dir(parent);
                    }
                }
            }
        }
        if command == "export_app_backup" {
            super::backup::append_imported_inputs(&worker_state, &mut result)?;
        }
        normalize_result(&worker_state, &mut result);
        Ok::<_, String>(result)
    });
    if let Some(id) = task_id {
        let tasks = state.tasks.clone();
        let worker_id = id.clone();
        tokio::spawn(async move {
            let result = worker
                .await
                .unwrap_or_else(|_| Err("服务任务失败，请查看服务器日志".into()));
            tasks.finish(&worker_id, result);
        });
        return (StatusCode::ACCEPTED, Json(json!({"taskId": id}))).into_response();
    }
    let result = worker.await;
    match result {
        Ok(Ok(value)) => Json(json!({"result": value})).into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "服务任务失败，请查看服务器日志"})),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrated_relative_preview_urls_reach_comfyui() {
        let tail = "/view?filename=clip.mp4&subfolder=2026-09-25&type=output";
        let origin = "https://canvas.example.com";
        let upstream = "http://127.0.0.1:8188/";
        let expected = Some(format!("http://127.0.0.1:8188{tail}"));
        assert_eq!(
            comfy_source_url(&format!("/api/comfy{tail}"), origin, upstream),
            expected
        );
        assert_eq!(
            comfy_source_url(&format!("{origin}/api/comfy{tail}"), origin, upstream),
            expected
        );
        for value in [
            "/api/comfy-other/view",
            "https://other.example/api/comfy/view",
            "sucanvas-input://sucanvas-imports/a.png",
        ] {
            assert!(comfy_source_url(value, origin, upstream).is_none());
        }
    }
    #[test]
    fn filesystem_boundary_rejects_parent_traversal() {
        let root = std::env::temp_dir().join(format!("web-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let root = root.canonicalize().unwrap();
        assert!(ensure_contained(&root.join("assets/new.png"), &[root.join("assets")]).is_ok());
        assert!(
            ensure_contained(&root.join("assets/../outside.txt"), &[root.join("assets")]).is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_module_ignores_unused_desktop_fallback_but_keeps_media_paths() {
        let mut args = json!({"input": {
            "workflowModuleId": "workflow-module-existing",
            "workflowPath": "D:\\desktop\\workflows\\old.json",
            "imagePaths": ["sucanvas://assets/reference.png"],
            "videoPaths": ["D:\\outside\\video.mp4"]
        }});
        let original = args.clone();
        remove_unused_workflow_fallback("submit_comfyui_workflow", &mut args);
        assert_eq!(args["input"]["workflowPath"], "");
        assert_eq!(args["input"]["imagePaths"], original["input"]["imagePaths"]);
        assert_eq!(args["input"]["videoPaths"], original["input"]["videoPaths"]);
        let mut other = original.clone();
        remove_unused_workflow_fallback("save_workflow_module", &mut other);
        assert_eq!(other, original);
        let mut fallback = original;
        fallback["input"]["workflowModuleId"] = Value::Null;
        let before = fallback.clone();
        remove_unused_workflow_fallback("submit_comfyui_workflow", &mut fallback);
        assert_eq!(fallback, before);
    }

    #[test]
    fn filesystem_boundary_accepts_canonical_alias_and_rejects_outside_file() {
        let root = std::env::temp_dir().join(format!("web-alias-{}", uuid::Uuid::new_v4()));
        let assets = root.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("existing.png"), b"fixture").unwrap();
        std::fs::write(root.join("outside.png"), b"fixture").unwrap();
        let canonical = assets.canonicalize().unwrap();
        assert!(ensure_contained(&assets.join("existing.png"), &[canonical.clone()]).is_ok());
        assert!(ensure_contained(&assets.join("new.png"), &[canonical.clone()]).is_ok());
        assert!(ensure_contained(&root.join("outside.png"), &[canonical]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
