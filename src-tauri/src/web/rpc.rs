use super::{
    auth::{Denied, Grant, Session},
    dispatch::{permissions, submitted_client_id, Command},
    WebState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::path::{Path as FsPath, PathBuf};

pub fn argument<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("Invalid argument {key}: {e}"))
}
// Progress for a submitted generation reaches every tab of the user who started it.
pub fn channel(
    state: &WebState,
    args: &Value,
    user_id: &str,
) -> impl Fn(()) + Send + Sync + 'static {
    let id = args
        .get("onSubmitted")
        .and_then(|v| v.get("__webChannel"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let handle = state.handle.clone();
    let user_id = user_id.to_owned();
    move |_| {
        let _ = handle.emit_to_user(&format!("channel:{id}"), &user_id, Value::Null);
    }
}

fn authorize_command(
    state: &WebState,
    session: &Session,
    command: Command,
    args: &Value,
) -> Result<Grant, Denied> {
    let mut grant = Grant::default();
    for permission in permissions(&state.core.active_canvas_id, session, command, args)
        .map_err(Denied::Invalid)?
    {
        let granted = state.auth.authorize(session, &permission)?;
        for owner in granted.audit {
            if !grant.audit.contains(&owner) {
                grant.audit.push(owner);
            }
        }
        for root in granted.written_roots {
            if !grant.written_roots.contains(&root) {
                grant.written_roots.push(root);
            }
        }
    }
    Ok(grant)
}

// After a successful command: child canvases follow their root's ownership,
// admin writes to other users' private canvases are audited, and project
// records carry their owner for the Web home page.
fn finish_command(
    state: &WebState,
    session: &Session,
    command: Command,
    grant: &Grant,
    result: &mut Value,
) -> Result<(), String> {
    let ownership = state.auth.ownership();
    for root in &grant.written_roots {
        ownership.normalize(root)?;
    }
    if !grant.audit.is_empty() {
        let username = state
            .auth
            .users()
            .by_id(&session.user_id)?
            .map(|credential| credential.user.username)
            .unwrap_or_default();
        for owner in &grant.audit {
            ownership.audit(&session.user_id, &username, owner, command.name())?;
        }
    }
    if matches!(
        command,
        Command::ListProjects
            | Command::ListProjectSummaries
            | Command::LoadWorkspace
            | Command::InspectWorkspace
            | Command::CreateProject
            | Command::CopyProject
    ) {
        ownership.annotate(result)?;
    }
    Ok(())
}

// Commands after which files may have lost their last reference: the
// registry is refreshed with the caller as `released_by` (CANVAS-012c4).
// Anything missed here is caught by the periodic refresh, without a name.
fn releases_media(command: Command) -> bool {
    matches!(
        command,
        Command::DeleteNode
            | Command::DeleteNodesUndoable
            | Command::ReplaceNodeAndDeleteUndoable
            | Command::DeleteFolderTree
            | Command::DeleteProject
            | Command::AdminDeleteProject
    )
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
            | "secondarySourcePath"
    )
}
fn comfy_source_url(
    value: &str,
    public_origin: &str,
    comfy_url: &str,
    colab_comfy_url: &str,
) -> Option<String> {
    for (route, upstream) in [
        ("/api/comfy-colab", colab_comfy_url),
        ("/api/comfy", comfy_url),
    ] {
        let absolute_prefix = format!("{public_origin}{route}");
        if let Some(tail) = value
            .strip_prefix(&absolute_prefix)
            .or_else(|| value.strip_prefix(route))
        {
            if tail.starts_with('/') && !upstream.is_empty() {
                return Some(format!("{}{tail}", upstream.trim_end_matches('/')));
            }
            return None;
        }
    }
    None
}

fn is_colab_comfy_url(config: &super::config::Config, value: &str) -> bool {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed == "/api/comfy-colab" || trimmed.starts_with("/api/comfy-colab/") {
        return true;
    }
    reqwest::Url::parse(trimmed).ok().is_some_and(|url| {
        config.allows_origin(&url.origin().ascii_serialization())
            && (url.path() == "/api/comfy-colab" || url.path().starts_with("/api/comfy-colab/"))
    })
}

fn targets_colab_channel(state: &WebState, args: &Value) -> bool {
    [args.get("serverUrl"), args.pointer("/input/serverUrl")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|url| is_colab_comfy_url(&state.config, url))
}

fn is_colab_result_url(config: &super::config::Config, value: &str) -> bool {
    if is_colab_comfy_url(config, value) {
        return true;
    }
    let trimmed = value.trim().trim_end_matches('/');
    let colab_prefix = config.colab_comfy_url.trim().trim_end_matches('/');
    !colab_prefix.is_empty()
        && (trimmed == colab_prefix
            || trimmed
                .strip_prefix(colab_prefix)
                .is_some_and(|tail| tail.starts_with('/')))
}

fn resolve_server_url_arg(config: &super::config::Config, value: &str) -> Result<String, String> {
    if is_colab_comfy_url(config, value) {
        if config.colab_comfy_url.is_empty() {
            return Err("请先在基础设置中配置 Colab ComfyUI 服务地址".into());
        }
        Ok(config.colab_comfy_url.clone())
    } else {
        Ok(config.comfy_url.clone())
    }
}

fn rewrite_server_url_result(config: &super::config::Config, key: &str, value: &str) -> String {
    let route = if key != "infinite-canvas:comfy-server-url" && is_colab_result_url(config, value) {
        "/api/comfy-colab"
    } else {
        "/api/comfy"
    };
    format!("{}{route}", config.origin())
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
                *text = resolve_server_url_arg(&state.config, text)?;
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
            if let Some(url) = comfy_source_url(
                text,
                &state.config.origin(),
                &state.config.comfy_url,
                &state.config.colab_comfy_url,
            ) {
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
                    state.core.data_dir.join(super::colab::COLAB_OUTPUTS_DIR),
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
            let colab_prefix = state.config.colab_comfy_url.trim_end_matches('/');
            let local_prefix = state.config.comfy_url.trim_end_matches('/');
            if !colab_prefix.is_empty()
                && text
                    .strip_prefix(colab_prefix)
                    .is_some_and(|tail| tail.starts_with('/'))
            {
                *text = format!(
                    "{}/api/comfy-colab{}",
                    state.config.origin(),
                    &text[colab_prefix.len()..]
                );
            } else if !local_prefix.is_empty()
                && text
                    .strip_prefix(local_prefix)
                    .is_some_and(|tail| tail.starts_with('/'))
            {
                *text = format!(
                    "{}/api/comfy{}",
                    state.config.origin(),
                    &text[local_prefix.len()..]
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
                *value = Value::String(rewrite_server_url_result(
                    &state.config,
                    key,
                    value.as_str().unwrap_or(""),
                ));
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
    Extension(session): Extension<Session>,
    Path(name): Path<String>,
    Json(mut input): Json<Request>,
) -> Response {
    let Some(kind) = Command::parse(&name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("Unknown command: {name}")})),
        )
            .into_response();
    };
    let command = kind.name();
    let _storage_guard = if matches!(
        command,
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
    // Every command declares its permission category (dispatch::permissions)
    // and is checked before anything else touches its arguments or the disk.
    let grant = match authorize_command(&state, &session, kind, &input.args) {
        Ok(grant) => grant,
        Err(denied) => return denied.into_response(),
    };
    if let Some(client_id) = submitted_client_id(kind, &input.args) {
        match state
            .auth
            .ownership()
            .remember_task(&client_id, &session.user_id)
        {
            Ok(true) => {}
            Ok(false) => {
                return Denied::Forbidden("该生成任务 id 已被其他用户使用".to_owned())
                    .into_response()
            }
            // Not submitted unless its owner is on record (the owner cancels it).
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": format!("无法记录生成任务：{error}")})),
                )
                    .into_response()
            }
        }
    }
    remove_unused_workflow_fallback(command, &mut input.args);
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
    let colab_channel = targets_colab_channel(&state, &input.args);
    if let Err(error) = normalize_args(&state, &mut input.args, "") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response();
    }
    if colab_channel {
        if command == "submit_comfyui_workflow" {
            let profile = super::colab::inspect_colab_profile(&state).await;
            if !profile.reachable {
                let message = profile
                    .error
                    .unwrap_or_else(|| "Colab 实例当前未运行或无法连接".to_owned());
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": message })))
                    .into_response();
            }
            let Some(effective_profile) = profile.effective_profile else {
                let message = profile.error.unwrap_or_else(|| {
                    "未能识别当前 Colab 档位（请管理员在基础设置中选择 DaSiWa V5xs 或 Cobijada）"
                        .to_owned()
                });
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": message })))
                    .into_response();
            };
            if let Some(obj) = input.args.get_mut("input").and_then(Value::as_object_mut) {
                obj.insert("colabMode".to_owned(), Value::Bool(true));
                obj.insert(
                    "colabProfile".to_owned(),
                    Value::String(effective_profile),
                );
                obj.insert(
                    "diffusionModelName".to_owned(),
                    Value::String(profile.diffusion_model_name),
                );
                obj.insert("workflowModuleId".to_owned(), Value::Null);
                obj.insert("workflowPath".to_owned(), Value::String(String::new()));
                obj.insert("secondarySamplingEnabled".to_owned(), Value::Bool(false));
                obj.insert("secondaryLoraName".to_owned(), Value::String(String::new()));
                obj.insert("secondaryLoraBypassed".to_owned(), Value::Bool(true));
                obj.insert("secondarySource".to_owned(), Value::Null);
                obj.insert("secondarySourcePath".to_owned(), Value::Null);
                obj.insert(
                    "ssPassword".to_owned(),
                    Value::String(state.config.colab_ss_password.clone()),
                );
                obj.insert("inputRootPath".to_owned(), Value::String(String::new()));
            }
        } else if command == "get_comfyui_client_task_statuses" {
            let image_ids: std::collections::HashSet<String> = input
                .args
                .get("imageClientIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let ss_ids: Vec<Value> = input
                .args
                .get("clientIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|id| !image_ids.contains(*id))
                .map(|id| Value::String(id.to_owned()))
                .collect();
            if let Some(obj) = input.args.as_object_mut() {
                obj.insert("colabSsClientIds".to_owned(), Value::Array(ss_ids));
            }
        }
    }
    if let Some(id) = input.web_task_id.as_deref() {
        if !command.starts_with("submit_comfyui_") {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "此操作不支持后台生成任务"})),
            )
                .into_response();
        }
        match state.tasks.reserve(id, command, &input.args) {
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
        let mut result =
            super::dispatch::dispatch(&worker_state, &session, kind, &input.args).await?;
        finish_command(&worker_state, &session, kind, &grant, &mut result)?;
        if releases_media(kind) {
            worker_state.refresh_media(Some(session.user_id.clone()));
        }
        if command.starts_with("submit_comfyui_") || command == "get_comfyui_client_task_statuses" {
            if colab_channel
                && (command == "submit_comfyui_workflow"
                    || command == "get_comfyui_client_task_statuses")
            {
                super::colab::materialize_ss_outputs(&worker_state, &mut result).await?;
            }
            super::media::reference_outputs(&mut result)?;
            // Registered on return so a node deleted before any refresh still
            // leaves a file the cleanup knows about. Off the async workers
            // (status polls must not wait for a running refresh); failure
            // only loses that registration.
            let (media, roots, outputs, user_id) = (
                worker_state.media.clone(),
                worker_state.media_roots(),
                result.clone(),
                session.user_id.clone(),
            );
            tokio::task::spawn_blocking(move || {
                if let Err(error) =
                    media.register_outputs(&roots, &outputs, &user_id, chrono::Utc::now())
                {
                    eprintln!("生成结果登记失败：{error}");
                }
            });
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
            let reference = super::storage::encode(&worker_state, &physical_asset);
            if let Err(error) = worker_state.media.register(
                &worker_state.media_roots(),
                &reference,
                "upload",
                &session.user_id,
                chrono::Utc::now(),
            ) {
                eprintln!("导入素材登记失败：{error}");
            }
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
            comfy_source_url(&format!("/api/comfy{tail}"), origin, upstream, ""),
            expected
        );
        assert_eq!(
            comfy_source_url(&format!("{origin}/api/comfy{tail}"), origin, upstream, ""),
            expected
        );
        let colab_upstream = "https://demo.trycloudflare.com/";
        assert_eq!(
            comfy_source_url(
                &format!("/api/comfy-colab{tail}"),
                origin,
                upstream,
                colab_upstream
            ),
            Some(format!("https://demo.trycloudflare.com{tail}"))
        );
        assert_eq!(
            comfy_source_url(
                &format!("{origin}/api/comfy-colab{tail}"),
                origin,
                upstream,
                colab_upstream
            ),
            Some(format!("https://demo.trycloudflare.com{tail}"))
        );
        for value in [
            "/api/comfy-other/view",
            "https://other.example/api/comfy/view",
            "sucanvas-input://sucanvas-imports/a.png",
        ] {
            assert!(comfy_source_url(value, origin, upstream, colab_upstream).is_none());
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

    #[test]
    fn colab_server_urls_normalize_and_rewrite_without_touching_local() {
        let mut config = super::super::config::Config {
            listen: "127.0.0.1:18742".parse().unwrap(),
            public_url: "https://canvas.example.com".into(),
            allowed_origins: vec![],
            data_directory: "data".into(),
            web_directory: "web".into(),
            downloads_directory: "downloads".into(),
            comfy_url: "http://127.0.0.1:8188".into(),
            colab_comfy_url: String::new(),
            colab_ss_password: String::new(),
            colab_profile: String::new(),
            comfy_input_directory: String::new(),
            comfy_output_directory: String::new(),
            max_upload_bytes: 12345,
            trusted_proxies: vec![],
        };
        assert_eq!(
            resolve_server_url_arg(&config, "https://canvas.example.com/api/comfy").unwrap(),
            "http://127.0.0.1:8188"
        );
        let err = resolve_server_url_arg(&config, "https://canvas.example.com/api/comfy-colab")
            .unwrap_err();
        assert!(err.contains("Colab ComfyUI"), "{err}");

        config.colab_comfy_url = "https://demo.trycloudflare.com".into();
        assert_eq!(
            resolve_server_url_arg(&config, "https://canvas.example.com/api/comfy-colab").unwrap(),
            "https://demo.trycloudflare.com"
        );
        assert_eq!(
            resolve_server_url_arg(&config, "/api/comfy-colab").unwrap(),
            "https://demo.trycloudflare.com"
        );
        assert_eq!(
            rewrite_server_url_result(&config, "comfyServerUrl", "https://demo.trycloudflare.com"),
            "https://canvas.example.com/api/comfy-colab"
        );
        assert_eq!(
            rewrite_server_url_result(
                &config,
                "comfyServerUrl",
                "https://canvas.example.com/api/comfy-colab"
            ),
            "https://canvas.example.com/api/comfy-colab"
        );
        assert_eq!(
            rewrite_server_url_result(
                &config,
                "infinite-canvas:comfy-server-url",
                "https://demo.trycloudflare.com"
            ),
            "https://canvas.example.com/api/comfy"
        );
    }
}
