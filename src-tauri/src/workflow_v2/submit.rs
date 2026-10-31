//! Commands of the generic workflow node (CANVAS-024c): describe a module's package, list the
//! files a control may choose from, and run one of the package's operations. Generic: every
//! module goes through the same code; nothing here names a workflow or a node (checked by a
//! test).

use super::{engine, runtime, PortType};
use crate::commands::{
    collect_image_files, collect_video_files, comfy_execution_elapsed_seconds, comfy_view_url,
    resolve_generation_seed, upload_comfy_input, upload_comfy_output_as_input,
};
use crate::models::{ComfyOutputFile, ComfySubmitResult};
use crate::platform::State;
use crate::workflow_modules::{self, WorkflowModuleRecord};
use crate::ApplicationState;
use chrono::Local;
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

/// One item connected to an input port: a text, a local file, or a ComfyUI output.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum WorkflowMediaItem {
    Text { text: String },
    Path { path: String },
    Output { output: ComfyOutputFile },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOperationInput {
    pub server_url: String,
    pub client_id: String,
    pub workflow_module_id: String,
    pub operation: String,
    #[serde(default)]
    pub values: Map<String, Value>,
    #[serde(default)]
    pub inputs: BTreeMap<String, Vec<WorkflowMediaItem>>,
    #[serde(default = "random_seed_mode")]
    pub seed_mode: String,
    #[serde(default)]
    pub seed: String,
}

fn random_seed_mode() -> String {
    "random".to_owned()
}

fn comfy_server(server_url: &str) -> Result<String, String> {
    let server_url = server_url.trim().trim_end_matches('/').to_owned();
    let parsed = Url::parse(&server_url).map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("ComfyUI 地址只允许 http 或 https".to_owned());
    }
    Ok(server_url)
}

/// The module's package as the node uses it (a v1 package converted, settings as presets).
pub(crate) fn load_module(record: &WorkflowModuleRecord) -> Result<runtime::LoadedPackage, String> {
    let adapter_path = Path::new(&record.adapter_path);
    let raw_adapter = std::fs::read(adapter_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    let workflow_bytes =
        std::fs::read(&record.workflow_path).map_err(|error| format!("读取工作流失败：{error}"))?;
    let workflow: Value = serde_json::from_slice(&workflow_bytes)
        .map_err(|error| format!("解析工作流失败：{error}"))?;
    let manifest = serde_json::to_value(&record.manifest).map_err(|error| error.to_string())?;
    // A v2 package file is used as written; a v1 package is read as the module store
    // migrated it, exactly what the old submission commands used.
    let adapter = if raw_adapter.get("engineApiVersion").and_then(Value::as_u64)
        == Some(u64::from(super::ENGINE_API_VERSION))
    {
        raw_adapter
    } else {
        serde_json::to_value(&record.adapter).map_err(|error| error.to_string())?
    };
    let ui_schema = serde_json::to_value(&record.ui_schema).map_err(|error| error.to_string())?;
    runtime::load_from_files(&manifest, &adapter, &ui_schema, workflow)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_workflow_package(
    workflow_module_id: String,
    state: State<'_, ApplicationState>,
) -> Result<Value, String> {
    let record = workflow_modules::get(&state.workflow_modules_dir, &workflow_module_id)?;
    let loaded = load_module(&record)?;
    let mut described = runtime::describe(&loaded.package);
    described["moduleId"] = json!(record.manifest.id);
    described["revision"] = json!(record.manifest.revision);
    Ok(described)
}

fn in_directories(name: &str, dirs: &[String]) -> bool {
    name.replace('/', "\\")
        .split_once('\\')
        .is_some_and(|(directory, file)| {
            !file.trim().is_empty() && dirs.iter().any(|dir| dir.eq_ignore_ascii_case(directory))
        })
}

/// Files ComfyUI offers for `classType.input`, limited to the control's directories.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_comfyui_control_choices(
    server_url: String,
    class_type: String,
    input: String,
    dirs: Vec<String>,
) -> Result<Vec<String>, String> {
    let server_url = comfy_server(&server_url)?;
    let mut url = Url::parse(&server_url).map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "ComfyUI 地址无效".to_owned())?
        .pop_if_empty()
        .push("object_info")
        .push(&class_type);
    let info = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建 ComfyUI 客户端失败：{error}"))?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("读取 ComfyUI 文件列表失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("读取 ComfyUI 文件列表失败：{error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("解析 ComfyUI 文件列表失败：{error}"))?;
    let mut names = super::validate::comfy_choices(&info, &class_type, &input)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| in_directories(name, &dirs))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    names.sort_by_key(|name| name.to_ascii_lowercase());
    names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    Ok(names)
}

fn extension_fits(port: PortType, filename: &str) -> bool {
    let extension = Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let allowed: &[&str] = match port {
        PortType::Image => &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
        PortType::Video => &["mp4", "webm", "mov", "mkv"],
        PortType::Audio => &["wav", "mp3", "flac", "ogg", "m4a", "aac"],
        PortType::Text => return true,
    };
    allowed.contains(&extension.as_str())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn submit_comfyui_workflow_operation(
    input: WorkflowOperationInput,
    state: State<'_, ApplicationState>,
) -> Result<ComfySubmitResult, String> {
    let server_url = comfy_server(&input.server_url)?;
    let record = workflow_modules::get(&state.workflow_modules_dir, &input.workflow_module_id)?;
    let loaded = load_module(&record)?;
    let operation = loaded
        .package
        .operations
        .get(&input.operation)
        .ok_or_else(|| format!("所选方案没有操作 {}", input.operation))?;
    let seed = resolve_generation_seed(&input.seed_mode, &input.seed)?;
    if let Some(port) = input.inputs.keys().find(|port| {
        !operation
            .inputs
            .iter()
            .any(|declared| &declared.id == *port)
    }) {
        return Err(format!("所选方案没有输入口 {port}"));
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|error| format!("创建 ComfyUI 客户端失败：{error}"))?;
    let upload_subfolder = format!("infinite-canvas/{}", Uuid::new_v4());
    let mut media = BTreeMap::new();
    for port in &operation.inputs {
        let Some(items) = input.inputs.get(&port.id) else {
            continue;
        };
        let label = if port.label.is_empty() {
            port.id.as_str()
        } else {
            port.label.as_str()
        };
        let mut names = Vec::with_capacity(items.len());
        for item in items {
            names.push(match (port.port_type, item) {
                (PortType::Text, WorkflowMediaItem::Text { text }) => text.clone(),
                (PortType::Text, _) => return Err(format!("{label} 只能接文字")),
                (_, WorkflowMediaItem::Text { .. }) => return Err(format!("{label} 不能接文字")),
                (kind, WorkflowMediaItem::Path { path }) => {
                    if !extension_fits(kind, path) {
                        return Err(format!("{label} 的素材类型不对：{path}"));
                    }
                    upload_comfy_input(&client, &server_url, path, &upload_subfolder).await?
                }
                (kind, WorkflowMediaItem::Output { output }) => {
                    if !extension_fits(kind, &output.filename) {
                        return Err(format!("{label} 的素材类型不对：{}", output.filename));
                    }
                    upload_comfy_output_as_input(
                        &client,
                        &server_url,
                        output,
                        &upload_subfolder,
                        label,
                    )
                    .await?
                }
            });
        }
        media.insert(port.id.clone(), names);
    }
    let date = Local::now().format("%Y-%m-%d").to_string();
    let request = runtime::engine_request(
        &loaded.package,
        &input.operation,
        &input.values,
        media,
        seed,
        &date,
    )?;
    let built = engine::build(
        &loaded.package,
        &input.operation,
        &loaded.workflow,
        &request,
    )?;
    let result_nodes = runtime::result_nodes(&loaded.package, &input.operation, &request)?;
    let videos = operation
        .outputs
        .iter()
        .any(|port| port.port_type == PortType::Video);
    let response = client
        .post(format!("{server_url}/prompt"))
        .json(&json!({"prompt": built.workflow, "client_id": input.client_id}))
        .send()
        .await
        .map_err(|error| format!("提交 ComfyUI 工作流失败：{error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 ComfyUI 响应失败（HTTP {status}）：{error}"))?;
    if !status.is_success() {
        return Err(format!("ComfyUI 拒绝工作流（HTTP {status}）：{body}"));
    }
    let prompt_id = body
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI 响应缺少 prompt_id：{body}"))?
        .to_owned();
    for _ in 0..5400 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = client
            .get(format!("{server_url}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("查询 ComfyUI 任务失败：{error}"))?;
        if !response.status().is_success() {
            continue;
        }
        let history: Value = response
            .json()
            .await
            .map_err(|error| format!("解析 ComfyUI 任务失败：{error}"))?;
        let Some(entry) = history.get(&prompt_id) else {
            continue;
        };
        match entry
            .pointer("/status/status_str")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "error" => {
                return Err(format!(
                    "ComfyUI 生成失败：{}",
                    entry
                        .pointer("/status/messages")
                        .cloned()
                        .unwrap_or(Value::Null)
                ))
            }
            "success" => {
                let outputs = entry.get("outputs").unwrap_or(&Value::Null);
                let mut files = Vec::new();
                let mut collect = |value: &Value| {
                    if videos {
                        collect_video_files(value, &mut files);
                    } else {
                        collect_image_files(value, &mut files);
                    }
                };
                match &result_nodes {
                    None => collect(outputs),
                    Some(nodes) => {
                        for node in nodes {
                            if let Some(output) = outputs.get(node) {
                                collect(output);
                            }
                        }
                    }
                }
                let mut seen = HashSet::new();
                let outputs = files
                    .into_iter()
                    .filter_map(|(filename, subfolder, file_type)| {
                        if !seen.insert(format!("{file_type}/{subfolder}/{filename}")) {
                            return None;
                        }
                        comfy_view_url(
                            &server_url,
                            &filename,
                            &subfolder,
                            &file_type,
                            Some(&prompt_id),
                        )
                        .ok()
                        .map(|url| ComfyOutputFile {
                            filename,
                            subfolder,
                            file_type,
                            url,
                        })
                    })
                    .collect::<Vec<_>>();
                if outputs.is_empty() {
                    return Err("ComfyUI 已完成，但没有找到输出".to_owned());
                }
                return Ok(ComfySubmitResult {
                    prompt_id,
                    seed: seed.to_string(),
                    outputs,
                    model_name: built
                        .record
                        .get("modelName")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    execution_elapsed_seconds: comfy_execution_elapsed_seconds(entry),
                    cleanup_warning: None,
                });
            }
            _ => {}
        }
    }
    Err(format!("等待 ComfyUI 任务超时：{prompt_id}"))
}
