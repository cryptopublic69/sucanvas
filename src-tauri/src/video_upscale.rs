use crate::{
    commands::{
        cancel_comfy_in_background, cleanup_comfy_task_inputs, comfy_execution_elapsed_seconds,
        comfy_outputs_from_history_entry, ensure_comfy_task_active, set_workflow_input,
        upload_comfy_output_from_server,
    },
    models::{ComfySubmitResult, ComfyVideoUpscaleInput},
    workflow_modules::{self, WorkflowModuleRecord},
    ApplicationState, RunningComfyTask,
};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::State;
use uuid::Uuid;

fn configure_video_processing(
    workflow: &mut Value,
    module: &WorkflowModuleRecord,
    uploaded: &str,
    parameters: &BTreeMap<String, f64>,
) -> Result<(), String> {
    let processing = module
        .adapter
        .video_processing
        .as_ref()
        .ok_or_else(|| "缺少视频超分映射".to_owned())?;
    let values = workflow_modules::video_processing_parameters(module, parameters)?;
    set_workflow_input(
        workflow,
        &processing.video_input.node_id,
        &processing.video_input.input_name,
        json!(uploaded),
    )?;
    for (key, value) in values {
        let binding = &processing.parameters[&key];
        let value = if value.fract() == 0.0 {
            json!(value as i64)
        } else {
            json!(value)
        };
        set_workflow_input(workflow, &binding.node_id, &binding.input_name, value)?;
    }
    Ok(())
}

fn server_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed = Url::parse(value).map_err(|error| format!("ComfyUI 地址无效：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("ComfyUI 地址只允许 http 或 https".to_owned());
    }
    Ok(value.to_owned())
}

async fn submit_inner(
    input: &ComfyVideoUpscaleInput,
    module: &WorkflowModuleRecord,
    task: Arc<RunningComfyTask>,
    on_submitted: &tauri::ipc::Channel<()>,
) -> Result<ComfySubmitResult, String> {
    if module.manifest.deleted_at.is_some() || module.adapter.capability != "video-upscale" {
        return Err("所选方案不是可用的视频超分模块".to_owned());
    }
    let processing = module
        .adapter
        .video_processing
        .as_ref()
        .ok_or_else(|| "视频超分方案缺少映射".to_owned())?;
    workflow_modules::video_processing_parameters(module, &input.parameters)?;
    let server = server_url(&input.server_url)?;
    let source_server = if input.source_server_url.trim().is_empty() {
        server.clone()
    } else {
        server_url(&input.source_server_url)?
    };
    if !matches!(
        Path::new(&input.source.filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v")
    ) {
        return Err("超分源不是受支持的视频文件".to_owned());
    }
    let bytes = tokio::fs::read(&module.workflow_path)
        .await
        .map_err(|error| format!("读取超分工作流失败：{error}"))?;
    let validation = workflow_modules::validate_workflow_bytes(&bytes, &module.adapter);
    if !validation.compatible {
        return Err(validation.issues.join("；"));
    }
    let mut workflow: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|error| error.to_string())?;
    ensure_comfy_task_active(&task.cancelled)?;
    let uploaded = upload_comfy_output_from_server(
        &client,
        &source_server,
        &server,
        &input.source,
        &task.upload_subfolder,
        "视频超分源视频",
    )
    .await?;
    ensure_comfy_task_active(&task.cancelled)?;
    configure_video_processing(&mut workflow, module, &uploaded, &input.parameters)?;
    // Once submission begins, keep inputs until the server confirms completion/cancellation.
    task.submitted.store(true, Ordering::SeqCst);
    let response = client
        .post(format!("{server}/prompt"))
        .json(&json!({"prompt": workflow, "client_id": input.client_id}))
        .send()
        .await
        .map_err(|error| format!("提交超分任务失败：{error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("解析超分响应失败：{error}"))?;
    if !status.is_success() {
        task.submitted.store(false, Ordering::SeqCst);
        return Err(format!("ComfyUI 拒绝超分任务（HTTP {status}）：{body}"));
    }
    let prompt_id = body
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "超分响应缺少 prompt_id".to_owned())?
        .to_owned();
    *task
        .prompt_id
        .lock()
        .map_err(|_| "任务状态锁已损坏".to_owned())? = Some(prompt_id.clone());
    if task.cancelled.load(Ordering::SeqCst) {
        cancel_comfy_in_background(
            client.clone(),
            server.clone(),
            prompt_id,
            Some(task.clone()),
        );
        return Err("ComfyUI 超分已取消".to_owned());
    }
    let _ = on_submitted.send(());
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(u64::from(processing.timeout_minutes) * 60 + 1800);
    while tokio::time::Instant::now() < deadline {
        ensure_comfy_task_active(&task.cancelled)?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        ensure_comfy_task_active(&task.cancelled)?;
        let response = match client
            .get(format!("{server}/history/{prompt_id}"))
            .timeout(Duration::from_secs(20))
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }
        let history: Value = response.json().await.map_err(|error| error.to_string())?;
        let Some(entry) = history.get(&prompt_id) else {
            continue;
        };
        match entry
            .pointer("/status/status_str")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "error" => {
                let warning = cleanup_comfy_task_inputs(&task).await;
                return Err(format!(
                    "ComfyUI 超分失败：{}{}",
                    entry.pointer("/status/messages").unwrap_or(&Value::Null),
                    warning.map(|w| format!("；{w}")).unwrap_or_default()
                ));
            }
            "success" => {
                // Only return this module's declared output, not unrelated workflow previews.
                let output = entry
                    .get("outputs")
                    .and_then(|outputs| outputs.get(&processing.output_node_id))
                    .cloned()
                    .unwrap_or(Value::Null);
                let filtered = json!({"outputs": output, "prompt": [null, prompt_id]});
                let outputs = comfy_outputs_from_history_entry(&server, &filtered, false)?;
                let cleanup_warning = cleanup_comfy_task_inputs(&task).await;
                if outputs.is_empty() {
                    return Err("超分已完成，但模块指定的节点没有视频输出".to_owned());
                }
                return Ok(ComfySubmitResult {
                    prompt_id,
                    seed: String::new(),
                    outputs,
                    model_name: None,
                    execution_elapsed_seconds: comfy_execution_elapsed_seconds(entry),
                    cleanup_warning,
                });
            }
            _ => {}
        }
    }
    Err(format!(
        "等待超分任务超时：{prompt_id}；保留输入素材，可从任务历史恢复结果"
    ))
}

#[tauri::command]
pub async fn submit_comfyui_video_upscale(
    input: ComfyVideoUpscaleInput,
    state: State<'_, ApplicationState>,
    on_submitted: tauri::ipc::Channel<()>,
) -> Result<ComfySubmitResult, String> {
    let module = workflow_modules::get(&state.workflow_modules_dir, &input.workflow_module_id)?;
    let task = Arc::new(RunningComfyTask {
        cancelled: AtomicBool::new(false),
        submitted: AtomicBool::new(false),
        prompt_id: std::sync::Mutex::new(None),
        input_root_path: input.input_root_path.clone(),
        upload_subfolder: format!("infinite-canvas/{}", Uuid::new_v4()),
        cleanup_started: AtomicBool::new(false),
    });
    state
        .running_comfy_tasks
        .lock()
        .map_err(|_| "任务列表锁已损坏".to_owned())?
        .insert(input.client_id.clone(), task.clone());
    let mut result = submit_inner(&input, &module, task.clone(), &on_submitted).await;
    if !task.submitted.load(Ordering::SeqCst) {
        if let Some(warning) = cleanup_comfy_task_inputs(&task).await {
            if let Err(error) = &mut result {
                error.push_str(&format!("；{warning}"));
            }
        }
    }
    state
        .running_comfy_tasks
        .lock()
        .map_err(|_| "任务列表锁已损坏".to_owned())?
        .remove(&input.client_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn bundle_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflows/video-upscale")
    }

    fn test_module() -> (PathBuf, WorkflowModuleRecord) {
        let root =
            std::env::temp_dir().join(format!("infinite-canvas-video-upscale-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        workflow_modules::install_bundled_modules(&root, &bundle_root()).unwrap();
        let module = workflow_modules::list(&root, false).unwrap().remove(0);
        (root, module)
    }

    fn cleanup(root: &Path) {
        assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("infinite-canvas-video-upscale-"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_processing_bundle_and_keeps_defaults_across_export() {
        let (root, module) = test_module();
        assert_eq!(module.manifest.capability, "video-upscale");
        let defaults =
            workflow_modules::video_processing_parameters(&module, &BTreeMap::new()).unwrap();
        assert_eq!(defaults["softness"], 3.0);
        assert_eq!(defaults["upscaleFactor"], 1.0);
        let exported =
            workflow_modules::export(&root, &root.join("export"), &module.manifest.id).unwrap();
        let imported = workflow_modules::import_bundle(&root, Path::new(&exported)).unwrap();
        assert_eq!(
            workflow_modules::video_processing_parameters(&imported, &BTreeMap::new()).unwrap(),
            defaults
        );
        workflow_modules::install_bundled_modules(&root, &bundle_root()).unwrap();
        assert_eq!(workflow_modules::list(&root, false).unwrap().len(), 2);
        cleanup(&root);
    }

    #[test]
    fn rejects_fractional_out_of_range_and_unmapped_parameters() {
        let (root, module) = test_module();
        for (key, value) in [
            ("softness", 0.0),
            ("softness", 2.5),
            ("upscaleFactor", 5.0),
            ("upscaleFactor", 1.5),
            ("unknown", 1.0),
        ] {
            assert!(workflow_modules::video_processing_parameters(
                &module,
                &BTreeMap::from([(key.to_owned(), value)])
            )
            .is_err());
        }
        assert!(workflow_modules::video_processing_parameters(
            &module,
            &BTreeMap::from([
                ("softness".to_owned(), 1.0),
                ("upscaleFactor".to_owned(), 4.0)
            ])
        )
        .is_ok());
        cleanup(&root);
    }

    #[test]
    fn executes_module_mappings_after_node_ids_change_without_altering_other_inputs() {
        let (root, mut module) = test_module();
        let mut workflow: Value =
            serde_json::from_slice(&fs::read(&module.workflow_path).unwrap()).unwrap();
        let original: Value = workflow.clone();
        let node = workflow.as_object_mut().unwrap().remove("2").unwrap();
        workflow["custom_enhancer"] = node;
        workflow["4"]["inputs"]["video"] = json!(["custom_enhancer", 0]);
        for binding in module
            .adapter
            .video_processing
            .as_mut()
            .unwrap()
            .parameters
            .values_mut()
        {
            binding.node_id = "custom_enhancer".to_owned();
        }
        configure_video_processing(
            &mut workflow,
            &module,
            "infinite-canvas/task/source.mp4",
            &BTreeMap::from([
                ("softness".to_owned(), 1.0),
                ("upscaleFactor".to_owned(), 4.0),
            ]),
        )
        .unwrap();
        assert_eq!(
            workflow["3"]["inputs"]["file"],
            json!("infinite-canvas/task/source.mp4")
        );
        assert_eq!(workflow["custom_enhancer"]["inputs"]["softness"], json!(1));
        assert_eq!(
            workflow["custom_enhancer"]["inputs"]["upscale_factor"],
            json!(4)
        );
        for key in [
            "model",
            "keep_audio",
            "topaz_dir",
            "model_store",
            "timeout_minutes",
        ] {
            assert_eq!(
                workflow["custom_enhancer"]["inputs"][key],
                original["2"]["inputs"][key]
            );
        }
        let validation = workflow_modules::validate_workflow_bytes(
            &serde_json::to_vec(&workflow).unwrap(),
            &module.adapter,
        );
        assert!(validation.compatible, "{}", validation.issues.join("; "));
        cleanup(&root);
    }

    #[test]
    fn deleted_or_purged_bundled_module_is_not_reinstalled() {
        let (root, module) = test_module();
        workflow_modules::trash(&root, &module.manifest.id).unwrap();
        workflow_modules::install_bundled_modules(&root, &bundle_root()).unwrap();
        assert!(workflow_modules::list(&root, false).unwrap().is_empty());
        fs::remove_dir_all(root.join(&module.manifest.id)).unwrap();
        workflow_modules::install_bundled_modules(&root, &bundle_root()).unwrap();
        assert!(workflow_modules::list(&root, true).unwrap().is_empty());
        cleanup(&root);
    }
}
