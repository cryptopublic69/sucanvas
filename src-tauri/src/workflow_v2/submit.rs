//! Commands of the generic workflow node (CANVAS-024c): describe a module's package, list the
//! files a control may choose from, and run one of the package's operations. Generic: every
//! module goes through the same code; nothing here names a workflow or a node (checked by a
//! test).

use super::{engine, runtime, validate, PortType};
use crate::commands::{
    collect_image_files, collect_video_files, comfy_execution_elapsed_seconds, comfy_view_url,
    resolve_generation_seed, upload_comfy_input, upload_comfy_output_as_input,
};
use crate::models::{ComfyOutputFile, ComfySubmitResult};
use crate::platform::State;
use crate::workflow_modules::{self, WorkflowModuleDefaults, WorkflowModuleRecord};
use crate::ApplicationState;
use chrono::Local;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
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

/// The module settings (manifest `defaults`) only; the package files are not rewritten,
/// which keeps a v2 package intact (CANVAS-024d).
#[cfg_attr(feature = "desktop", tauri::command(async))]
pub fn update_workflow_module_defaults(
    workflow_module_id: String,
    defaults: WorkflowModuleDefaults,
    state: State<'_, ApplicationState>,
) -> Result<WorkflowModuleRecord, String> {
    workflow_modules::update_defaults(&state.workflow_modules_dir, &workflow_module_id, defaults)
}

/// The import check against ComfyUI: node types installed, every declared directory list
/// has files, defaults and presets exist. When ComfyUI cannot be reached the report says
/// it was not checked.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn check_workflow_package(
    server_url: String,
    workflow_module_id: String,
    state: State<'_, ApplicationState>,
) -> Result<validate::ValidationReport, String> {
    let record = workflow_modules::get(&state.workflow_modules_dir, &workflow_module_id)?;
    let loaded = load_module(&record)?;
    let server_url = comfy_server(&server_url)?;
    let info = async {
        Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(60))
            .build()
            .ok()?
            .get(format!("{server_url}/object_info"))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json::<Value>()
            .await
            .ok()
    }
    .await;
    let mut report = validate::validate_package(&loaded.package, &loaded.workflow, info.as_ref());
    // Presets come from the module settings; they must exist in ComfyUI too.
    if let Some(info) = info.as_ref() {
        for operation in loaded.package.operations.values() {
            for control in &operation.controls {
                let (Some(preset), Some(files)) = (
                    control.preset.as_ref().and_then(Value::as_str),
                    control.options.as_ref().and_then(|o| o.comfyui.as_ref()),
                ) else {
                    continue;
                };
                let known = validate::comfy_choices(info, &files.class_type, &files.input)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(|name| name.replace('/', "\\") == preset.replace('/', "\\"));
                let message = format!("ComfyUI 中找不到 {} 的设置值 {preset}", control.id);
                if !known && !report.errors.contains(&message) {
                    report.errors.push(message);
                }
            }
        }
    }
    Ok(report)
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

/// What the settings page offers for a module's sampler (CANVAS-039).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerChoices {
    /// The value the package's workflow carries (used while the setting is unset).
    pub package_value: String,
    /// ComfyUI's `sampler_name` choices for the declared nodes' class (all of them, in
    /// ComfyUI's order); empty when ComfyUI could not be read.
    pub options: Vec<String>,
    pub comfyui_error: Option<String>,
}

/// A combo input's choices in either object_info shape: `[[...]]` or `["COMBO", {options}]`.
pub(crate) fn combo_choices(info: &Value, class_type: &str, input: &str) -> Vec<String> {
    let Some(inputs) = info.get(class_type).and_then(|class| class.get("input")) else {
        return Vec::new();
    };
    let Some(spec) = ["required", "optional"]
        .iter()
        .find_map(|kind| inputs.get(*kind)?.get(input))
    else {
        return Vec::new();
    };
    spec.get(0)
        .and_then(Value::as_array)
        .or_else(|| spec.get(1)?.get("options")?.as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// `sampler_name` choices ComfyUI offers for every class (those all classes share).
async fn sampler_options(server_url: &str, classes: &[String]) -> Result<Vec<String>, String> {
    let server_url = comfy_server(server_url)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建 ComfyUI 客户端失败：{error}"))?;
    let mut shared: Option<Vec<String>> = None;
    for class_type in classes {
        let mut url = Url::parse(&server_url).map_err(|error| error.to_string())?;
        url.path_segments_mut()
            .map_err(|_| "ComfyUI 地址无效".to_owned())?
            .pop_if_empty()
            .push("object_info")
            .push(class_type);
        let info = client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("读取 ComfyUI 采样器列表失败：{error}"))?
            .error_for_status()
            .map_err(|error| format!("读取 ComfyUI 采样器列表失败：{error}"))?
            .json::<Value>()
            .await
            .map_err(|error| format!("解析 ComfyUI 采样器列表失败：{error}"))?;
        let names = combo_choices(&info, class_type, "sampler_name");
        if names.is_empty() {
            return Err(format!(
                "ComfyUI 没有列出 {class_type} 的 sampler_name 选项"
            ));
        }
        shared = Some(match shared {
            None => names,
            Some(previous) => previous
                .into_iter()
                .filter(|name| names.contains(name))
                .collect(),
        });
    }
    Ok(shared.unwrap_or_default())
}

/// The sampler choices of a module whose package declares sampler nodes. The package value
/// comes from the module's own workflow; ComfyUI being unreachable is reported, not an error.
/// Web settings page only (the desktop build is frozen, CANVAS-RULES 2).
#[cfg_attr(feature = "desktop", allow(dead_code))]
pub async fn get_workflow_sampler_choices(
    server_url: String,
    workflow_module_id: String,
    state: State<'_, ApplicationState>,
) -> Result<SamplerChoices, String> {
    let record = workflow_modules::get(&state.workflow_modules_dir, &workflow_module_id)?;
    let bindings = &record.adapter.bindings;
    let Some(first) = bindings.sampler_select_node_ids.first() else {
        return Err("这个方案的方案包没有声明采样器节点".to_owned());
    };
    let workflow: Value = serde_json::from_slice(
        &std::fs::read(&record.workflow_path)
            .map_err(|error| format!("读取工作流失败：{error}"))?,
    )
    .map_err(|error| format!("解析工作流失败：{error}"))?;
    if let Some(issue) = workflow_modules::sampler_declaration_issues(&workflow, bindings)
        .into_iter()
        .next()
    {
        return Err(format!("方案包的采样器声明无效：{issue}"));
    }
    let package_value = workflow[first.as_str()]["inputs"]["sampler_name"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let mut classes = bindings
        .sampler_select_node_ids
        .iter()
        .filter_map(|id| workflow[id.as_str()]["class_type"].as_str())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    classes.sort();
    classes.dedup();
    let (options, comfyui_error) = match sampler_options(&server_url, &classes).await {
        Ok(options) => (options, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    Ok(SamplerChoices {
        package_value,
        options,
        comfyui_error,
    })
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
