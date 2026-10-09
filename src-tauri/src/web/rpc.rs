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
    let allowed = roots.iter().any(|root| {
        path.starts_with(root)
            && root
                .canonicalize()
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
pub fn normalize_args(state: &WebState, value: &mut Value, key: &str) -> Result<(), String> {
    match value {
        Value::String(text) => {
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
            if text.starts_with("sucanvas://") {
                *text = crate::portable::resource_path(&state.core.data_dir, text)?
                    .to_string_lossy()
                    .into_owned();
            } else if text.starts_with("sucanvas-export://") {
                *text = export_path(state, text)?.to_string_lossy().into_owned();
            }
            let proxy_prefix = format!("{}/api/comfy", state.config.origin());
            if text.starts_with(&proxy_prefix) {
                *text = format!(
                    "{}{}",
                    state.config.comfy_url.trim_end_matches('/'),
                    &text[proxy_prefix.len()..]
                );
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
                normalize_args(state, value, key)?;
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
                *value = Value::String(state.config.comfy_input_directory.clone());
            } else if key == "infinite-canvas:comfy-output-root" {
                *value = Value::String(state.config.comfy_output_directory.clone());
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
}
fn empty_args() -> Value {
    json!({})
}
pub async fn invoke(
    State(state): State<WebState>,
    Path(command): Path<String>,
    Json(mut input): Json<Request>,
) -> Response {
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
    // An HTTP disconnect must not abort a generation already submitted to ComfyUI.
    let worker_state = state.clone();
    let result = tokio::spawn(async move {
        let mut result = super::dispatch::dispatch(&worker_state, &command, &input.args).await?;
        if command.starts_with("submit_comfyui_") || command == "get_comfyui_client_task_statuses" {
            super::media::retain_outputs(&worker_state, &mut result).await?;
        }
        Ok::<_, String>(result)
    })
    .await;
    match result {
        Ok(Ok(mut value)) => {
            normalize_result(&state, &mut value);
            Json(json!({"result": value})).into_response()
        }
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
}
