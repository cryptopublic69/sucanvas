use std::collections::HashSet;

use serde_json::{json, Value};

use crate::{
    commands::collect_image_files,
    models::{ComfySubmitInput, H3StyleLora},
    workflow_modules::{
        WorkflowAdapter, WorkflowBindings, WorkflowInputContract, H3_MULTI_REFERENCE_ADAPTER,
        WORKFLOW_ENGINE_API_VERSION, WORKFLOW_PACKAGE_SCHEMA_VERSION,
    },
};

pub const COLAB_WORKFLOW_LABEL: &str = "Colab 专用 · Fla全能参考 V3.1 (1采 SS)";
pub const COLAB_DASIWA_PROFILE: &str = "dasiwa";
pub const COLAB_COBIJADA_PROFILE: &str = "cobijada";
pub const COLAB_DASIWA_MODEL: &str =
    "MinimaxH3/dasiwa_minimax_h3_ref2va_v5xs_pruned_graviton_int8_row-wise_convrot_runtime_mixed.safetensors";
pub const COLAB_COBIJADA_MODEL: &str =
    "MinimaxH3/Cobijada_H3_Hybrid_Uncensored_pruned_hybrid_int8_convrot_pruned.safetensors";
pub const COLAB_ALLOWED_LORAS: [&str; 2] = [
    "MinimaxH3/pika_h3_flex_fl2va_comfy_bf16.safetensors",
    "MinimaxH3/MysticXXX_MMH3-V1.safetensors",
];
pub const COLAB_FLA_V3_WORKFLOW_JSON: &str =
    include_str!("../../../workflows/MiniMax+H3+Fla全能参考V3.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColabProfileSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub diffusion_model_name: &'static str,
}

/// Resolves one of the two locked Colab notebook profiles (`dasiwa` / `cobijada`).
pub fn colab_profile_spec(id: &str) -> Option<ColabProfileSpec> {
    match id.trim().to_ascii_lowercase().as_str() {
        COLAB_DASIWA_PROFILE => Some(ColabProfileSpec {
            id: COLAB_DASIWA_PROFILE,
            label: "DaSiWa V5xs",
            diffusion_model_name: COLAB_DASIWA_MODEL,
        }),
        COLAB_COBIJADA_PROFILE => Some(ColabProfileSpec {
            id: COLAB_COBIJADA_PROFILE,
            label: "Cobijada",
            diffusion_model_name: COLAB_COBIJADA_MODEL,
        }),
        _ => None,
    }
}

/// Infers a Colab profile from a locked base UNet model name.
pub fn colab_profile_for_model(model_name: &str) -> Option<ColabProfileSpec> {
    let normalized = model_name.trim().replace('\\', "/");
    [COLAB_DASIWA_PROFILE, COLAB_COBIJADA_PROFILE]
        .into_iter()
        .filter_map(colab_profile_spec)
        .find(|spec| normalized.eq_ignore_ascii_case(spec.diffusion_model_name))
}

/// Checks whether a LoRA path is one of the pre-warmed Colab NVMe LoRAs.
pub fn is_allowed_colab_lora(name: &str) -> bool {
    let normalized = name.trim().replace('\\', "/");
    !normalized.is_empty()
        && COLAB_ALLOWED_LORAS
            .iter()
            .any(|allowed| normalized.eq_ignore_ascii_case(allowed))
}

/// Locked bindings for the bundled Colab `MiniMax+H3+Fla全能参考V3.json` workflow.
pub fn colab_fla_reference_v3_bindings() -> WorkflowBindings {
    WorkflowBindings {
        prompt_node_id: "138".to_owned(),
        seed_node_id: "129".to_owned(),
        duration_node_id: "132".to_owned(),
        primary_resolution_node_id: "115".to_owned(),
        secondary_resolution_node_id: "398".to_owned(),
        primary_lora_node_id: "147".to_owned(),
        secondary_lora_node_id: "401".to_owned(),
        primary_style_lora_node_id: "9200".to_owned(),
        secondary_style_lora_node_id: "9201".to_owned(),
        primary_style_lora_node_ids: ["9200", "9500", "9502", "9504", "9506", "9508"]
            .map(str::to_owned)
            .to_vec(),
        secondary_style_lora_node_ids: ["9201", "9501", "9503", "9505", "9507", "9509"]
            .map(str::to_owned)
            .to_vec(),
        primary_sol_attn_node_id: String::new(),
        secondary_sol_attn_node_id: "9202".to_owned(),
        primary_sampler_node_id: "125".to_owned(),
        primary_model_target_node_id: "142".to_owned(),
        primary_steps_node_id: "124".to_owned(),
        primary_video_steps_input_name: "steps".to_owned(),
        primary_audio_steps_input_name: String::new(),
        primary_upscale_node_id: "210".to_owned(),
        live_preview_node_id: "141".to_owned(),
        secondary_scheduler_node_id: "391".to_owned(),
        secondary_guider_node_id: "393".to_owned(),
        primary_output_node_id: "221".to_owned(),
        secondary_output_node_id: "397".to_owned(),
        primary_color_node_id: "259".to_owned(),
        secondary_color_node_id: "403".to_owned(),
        clean_video_node_id: "9000".to_owned(),
        clean_save_node_id: "9001".to_owned(),
        secondary_video_input_node_id: "9002".to_owned(),
        conditioning_node_id: "136".to_owned(),
        audio_node_ids: ["268", "270", "9607"].map(str::to_owned).to_vec(),
        image_node_ids: [
            "139", "258", "263", "264", "266", "262", "261", "265", "267",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        primary_audio_output_node_id: "218".to_owned(),
        primary_audio_output_index: 0,
        secondary_audio_output_node_id: "218".to_owned(),
        secondary_audio_output_index: 0,
        secondary_resize_node_id: "383".to_owned(),
        secondary_audio_encode_node_id: "388".to_owned(),
        diffusion_model_node_id: "127".to_owned(),
        diffusion_model_class_type: "UNETLoader".to_owned(),
        diffusion_model_directory: "MinimaxH3".to_owned(),
        secondary_diffusion_model_node_id: "358".to_owned(),
        lora_class_type: "LoraLoaderModelOnly".to_owned(),
        lora_directory: "MinimaxH3".to_owned(),
        secondary_prompt_node_id: String::new(),
        secondary_conditioning_node_id: String::new(),
        single_image_input_node_id: String::new(),
        secondary_image_input_node_id: String::new(),
        sampler_select_node_ids: Vec::new(),
    }
}

/// Adapter locked for the Google Colab channel using bundled `MiniMax+H3+Fla全能参考V3.json`.
pub fn colab_fla_reference_v3_adapter() -> WorkflowAdapter {
    WorkflowAdapter {
        schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
        engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
        adapter_id: H3_MULTI_REFERENCE_ADAPTER.to_owned(),
        capability: "video-generation".to_owned(),
        variant: "reference-to-video".to_owned(),
        input_contract: WorkflowInputContract {
            prompt_required: true,
            image_min: 0,
            image_max: 9,
            audio_min: 0,
            audio_max: 3,
            video_min: 0,
            video_max: 0,
        },
        bindings: colab_fla_reference_v3_bindings(),
        video_processing: None,
    }
}

fn validate_colab_lora_allowlist(
    lora_name: &str,
    lora_bypassed: bool,
    style_loras: Option<&[H3StyleLora]>,
    style_lora_name: &str,
    style_lora_bypassed: bool,
) -> Result<(), String> {
    let allowed_hint = "pika_h3_flex_fl2va_comfy_bf16.safetensors / MysticXXX_MMH3-V1.safetensors";
    if !lora_bypassed && !is_allowed_colab_lora(lora_name) {
        return Err(format!(
            "Colab 渠道 1采 LoRA 仅允许选择本地预热 LoRA（{allowed_hint}）"
        ));
    }
    if let Some(styles) = style_loras {
        for (index, slot) in styles.iter().enumerate() {
            if !slot.bypassed && !is_allowed_colab_lora(slot.name.trim()) {
                return Err(format!(
                    "Colab 渠道风格 LoRA {} 仅允许选择本地预热 LoRA（{allowed_hint}）或开启 Bypass",
                    index + 1
                ));
            }
        }
    }
    if !style_lora_bypassed && !is_allowed_colab_lora(style_lora_name) {
        return Err(format!(
            "Colab 渠道风格化 LoRA 仅允许选择本地预热 LoRA（{allowed_hint}）或开启 Bypass"
        ));
    }
    Ok(())
}

/// Validates and locks a Colab submission's workflow, base model, LoRA allowlist, and 1采-only constraints.
pub(crate) fn prepare_colab_submission_input(
    input: &mut ComfySubmitInput,
) -> Result<(WorkflowAdapter, Value), String> {
    if input.secondary_sampling_enabled
        || input.secondary_source.is_some()
        || input
            .secondary_source_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
    {
        return Err("Colab 渠道仅锁定 1采专用工作流，不支持 2采".to_owned());
    }
    let spec = colab_profile_spec(&input.colab_profile).ok_or_else(|| {
        "未识别有效的 Colab 档位（请检查自动识别或手动选择 DaSiWa V5xs / Cobijada）".to_owned()
    })?;
    let lora_name = input.lora_name.trim().to_owned();
    let lora_bypassed = lora_name.is_empty() || input.lora_bypassed;
    let style_lora_name = input.style_lora_name.as_deref().unwrap_or("").trim().to_owned();
    let style_lora_bypassed =
        style_lora_name.is_empty() || input.style_lora_bypassed.unwrap_or(false);
    validate_colab_lora_allowlist(
        &lora_name,
        lora_bypassed,
        input.style_loras.as_deref(),
        &style_lora_name,
        style_lora_bypassed,
    )?;
    input.diffusion_model_name = spec.diffusion_model_name.to_owned();
    input.secondary_lora_name = Some(String::new());
    input.secondary_lora_bypassed = Some(true);
    let workflow: Value = serde_json::from_str(COLAB_FLA_V3_WORKFLOW_JSON)
        .map_err(|error| format!("解析内置 Colab 工作流失败：{error}"))?;
    Ok((colab_fla_reference_v3_adapter(), workflow))
}

fn bypass_workflow_node(
    workflow_object: &mut serde_json::Map<String, Value>,
    target_id: &str,
    passthrough_input_key: &str,
) {
    let Some(upstream) = workflow_object
        .get(target_id)
        .and_then(|node| node.get("inputs"))
        .and_then(|inputs| inputs.get(passthrough_input_key))
        .cloned()
    else {
        return;
    };
    for (node_id, node) in workflow_object.iter_mut() {
        if node_id == target_id {
            continue;
        }
        let Some(inputs) = node.get_mut("inputs").and_then(Value::as_object_mut) else {
            continue;
        };
        for value in inputs.values_mut() {
            if let Some(link) = value.as_array() {
                if link.first().and_then(Value::as_str) == Some(target_id) {
                    *value = upstream.clone();
                }
            }
        }
    }
    workflow_object.remove(target_id);
}

fn workflow_references_node(workflow_object: &serde_json::Map<String, Value>, target_id: &str) -> bool {
    workflow_object.iter().any(|(node_id, node)| {
        node_id != target_id
            && node
                .get("inputs")
                .and_then(Value::as_object)
                .is_some_and(|inputs| {
                    inputs.values().any(|value| {
                        value
                            .as_array()
                            .is_some_and(|link| link.first().and_then(Value::as_str) == Some(target_id))
                    })
                })
    })
}

pub(crate) fn adapt_workflow_for_colab_ss(
    workflow: &mut Value,
    ss_password: &str,
    ss_compress: u8,
) -> Result<Vec<String>, String> {
    let workflow_object = workflow
        .as_object_mut()
        .ok_or_else(|| "API 工作流顶层必须是 JSON 对象".to_owned())?;

    // Linux ComfyUI rejects Windows backslashes in model/LoRA paths.
    for node in workflow_object.values_mut() {
        let Some(inputs) = node.get_mut("inputs").and_then(Value::as_object_mut) else {
            continue;
        };
        for (key, value) in inputs.iter_mut() {
            if matches!(
                key.as_str(),
                "unet_name" | "lora_name" | "clip_name" | "vae_name" | "model_name"
            ) {
                if let Some(text) = value.as_str() {
                    if text.contains('\\') {
                        *value = Value::String(text.replace('\\', "/"));
                    }
                }
            } else if let Some(entry) = value.as_object_mut() {
                let normalized = entry
                    .get("lora")
                    .and_then(Value::as_str)
                    .filter(|s| s.contains('\\'))
                    .map(|s| s.replace('\\', "/"));
                if let Some(normalized) = normalized {
                    entry.insert("lora".to_owned(), Value::String(normalized));
                }
            }
        }
    }

    let sage_patch_ids: Vec<String> = workflow_object
        .iter()
        .filter(|(_, node)| {
            node.get("class_type").and_then(Value::as_str)
                == Some("MiniMaxH3MemoryEfficientSageAttentionPatch")
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in sage_patch_ids {
        bypass_workflow_node(workflow_object, &id, "model");
    }

    let upscaler_3d_ids: Vec<String> = workflow_object
        .iter()
        .filter(|(_, node)| {
            matches!(
                node.get("class_type").and_then(Value::as_str),
                Some("MinimaxH3LatentUpscalerNode3D" | "MinimaxH3LatentUpscaler3D")
            )
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in upscaler_3d_ids {
        bypass_workflow_node(workflow_object, &id, "latent");
    }

    let existing_duck_ids: Vec<String> = workflow_object
        .iter()
        .filter(|(_, node)| node.get("class_type").and_then(Value::as_str) == Some("DuckHideNode"))
        .map(|(id, _)| id.clone())
        .collect();
    if !existing_duck_ids.is_empty() {
        for duck_id in &existing_duck_ids {
            if let Some(inputs) = workflow_object
                .get_mut(duck_id)
                .and_then(|node| node.get_mut("inputs"))
                .and_then(Value::as_object_mut)
            {
                inputs.insert("password".to_owned(), Value::String(ss_password.to_owned()));
            }
        }
        let duck_set: HashSet<&str> = existing_duck_ids.iter().map(String::as_str).collect();
        let linked_save_ids: Vec<String> = workflow_object
            .iter()
            .filter(|(_, node)| {
                node.get("class_type").and_then(Value::as_str) == Some("SaveImage")
                    && node
                        .pointer("/inputs/images/0")
                        .and_then(Value::as_str)
                        .is_some_and(|src| duck_set.contains(src))
            })
            .map(|(id, _)| id.clone())
            .collect();
        if !linked_save_ids.is_empty() {
            return Ok(linked_save_ids);
        }
        let any_save_ids: Vec<String> = workflow_object
            .iter()
            .filter(|(_, node)| node.get("class_type").and_then(Value::as_str) == Some("SaveImage"))
            .map(|(id, _)| id.clone())
            .collect();
        return Ok(any_save_ids);
    }

    let save_video_ids: Vec<String> = workflow_object
        .iter()
        .filter(|(_, node)| node.get("class_type").and_then(Value::as_str) == Some("SaveVideo"))
        .map(|(id, _)| id.clone())
        .collect();
    if save_video_ids.is_empty() {
        return Err("Colab SS_tools 工作流缺少 SaveVideo 或 DuckHideNode 节点".to_owned());
    }

    let compress: u64 = match ss_compress {
        6 => 6,
        8 => 8,
        _ => 2,
    };
    let mut ss_save_node_ids = Vec::with_capacity(save_video_ids.len());
    let mut create_video_candidates = Vec::new();
    for save_id in save_video_ids {
        let Some(save_node) = workflow_object.get(&save_id).cloned() else {
            continue;
        };
        let filename_prefix = save_node
            .pointer("/inputs/filename_prefix")
            .and_then(Value::as_str)
            .unwrap_or("%date:yyyy-MM-dd%/Minimax_H3")
            .to_owned();
        let create_id = save_node
            .pointer("/inputs/video/0")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("SaveVideo 节点 {save_id} 缺少 CreateVideo 输入"))?
            .to_owned();
        let create_node = workflow_object
            .get(&create_id)
            .ok_or_else(|| format!("工作流缺少 CreateVideo 节点 {create_id}"))?
            .clone();
        let images = create_node
            .pointer("/inputs/images")
            .cloned()
            .ok_or_else(|| format!("CreateVideo 节点 {create_id} 缺少 images 输入"))?;
        let audio = create_node.pointer("/inputs/audio").cloned();
        let fps = create_node
            .pointer("/inputs/fps")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_f64().map(|n| n.round().clamp(1.0, 60.0) as u64))
            })
            .unwrap_or(24);

        let duck_id = format!("sucanvas_ss_encode_{save_id}");
        let mut duck_inputs = serde_json::Map::new();
        duck_inputs.insert("images".to_owned(), images);
        if let Some(audio_val) = audio.filter(|val| !val.is_null()) {
            duck_inputs.insert("audio".to_owned(), audio_val);
        }
        duck_inputs.insert("password".to_owned(), Value::String(ss_password.to_owned()));
        duck_inputs.insert("title".to_owned(), Value::String(String::new()));
        duck_inputs.insert("fps".to_owned(), json!(fps));
        duck_inputs.insert("compress".to_owned(), json!(compress));
        duck_inputs.insert("combine_video".to_owned(), json!(true));

        workflow_object.insert(
            duck_id.clone(),
            json!({
                "inputs": Value::Object(duck_inputs),
                "class_type": "DuckHideNode",
                "_meta": { "title": "SS_tools Encode" }
            }),
        );
        workflow_object.insert(
            save_id.clone(),
            json!({
                "inputs": {
                    "images": [duck_id, 0],
                    "filename_prefix": format!("{filename_prefix}_SS"),
                },
                "class_type": "SaveImage",
                "_meta": { "title": "Save Image (SS)" }
            }),
        );
        create_video_candidates.push(create_id);
        ss_save_node_ids.push(save_id);
    }

    for create_id in create_video_candidates {
        if !workflow_references_node(workflow_object, &create_id) {
            workflow_object.remove(&create_id);
        }
    }

    Ok(ss_save_node_ids)
}

pub(crate) fn collect_colab_ss_carrier_files(
    outputs: &Value,
    preferred_node_ids: &[String],
) -> Vec<(String, String, String)> {
    let mut files = Vec::new();
    if !preferred_node_ids.is_empty() {
        for node_id in preferred_node_ids {
            if let Some(node_output) = outputs.get(node_id) {
                collect_image_files(node_output, &mut files);
            }
        }
    }
    if files.is_empty() {
        collect_image_files(outputs, &mut files);
    }
    let has_saved = files
        .iter()
        .any(|(filename, _, _)| filename != "duck_payload.png");
    if has_saved {
        files.retain(|(filename, _, _)| filename != "duck_payload.png");
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapt_workflow_for_colab_ss_normalizes_paths_bypasses_patches_and_wraps_save_video() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../workflows/MiniMax+H3+Fla全能参考V3.json");
        let mut workflow: Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let save_ids = adapt_workflow_for_colab_ss(&mut workflow, "5555", 2).unwrap();
        assert_eq!(save_ids, vec!["221".to_owned()]);

        let obj = workflow.as_object().unwrap();
        assert!(!obj.contains_key("142"));
        assert!(!obj.contains_key("210"));
        assert!(!obj.contains_key("220"));
        assert_eq!(workflow["149"]["inputs"]["model"], json!(["147", 0]));
        assert_eq!(workflow["212"]["inputs"]["video_latent"], json!(["211", 0]));
        assert_eq!(
            workflow["127"]["inputs"]["unet_name"],
            json!("MinimaxH3/minimax_h3_fl2va_int8_convrot.safetensors")
        );
        assert_eq!(
            workflow["147"]["inputs"]["lora_name"],
            json!("MinimaxH3/minimax_h3_turbo_4STEPS_comfyui.safetensors")
        );
        let duck = &workflow["sucanvas_ss_encode_221"];
        assert_eq!(duck["class_type"], "DuckHideNode");
        assert_eq!(duck["inputs"]["images"], json!(["259", 0]));
        assert_eq!(duck["inputs"]["audio"], json!(["218", 0]));
        assert_eq!(duck["inputs"]["password"], "5555");
        assert_eq!(duck["inputs"]["fps"], 24);
        assert_eq!(duck["inputs"]["compress"], 2);
        assert_eq!(duck["inputs"]["combine_video"], true);

        let save = &workflow["221"];
        assert_eq!(save["class_type"], "SaveImage");
        assert_eq!(save["inputs"]["images"], json!(["sucanvas_ss_encode_221", 0]));
        assert_eq!(save["inputs"]["filename_prefix"], "%date:yyyy-MM-dd%/Minimax_H3_SS");
    }

    #[test]
    fn colab_locked_profile_and_allowlist_enforce_nvme_models_and_preserve_preview_node() {
        let dasiwa = colab_profile_spec("DaSiWa").unwrap();
        assert_eq!(dasiwa.id, "dasiwa");
        assert!(dasiwa.diffusion_model_name.contains("dasiwa_minimax_h3"));
        let cobijada = colab_profile_spec("cobijada").unwrap();
        assert_eq!(cobijada.id, "cobijada");
        assert!(cobijada.diffusion_model_name.contains("Cobijada"));
        assert!(colab_profile_spec("unknown").is_none());

        assert!(is_allowed_colab_lora(
            r"MinimaxH3\pika_h3_flex_fl2va_comfy_bf16.safetensors"
        ));
        assert!(is_allowed_colab_lora(
            "MinimaxH3/MysticXXX_MMH3-V1.safetensors"
        ));
        assert!(!is_allowed_colab_lora(
            "MinimaxH3/some_drive_only_lora.safetensors"
        ));

        let styles = vec![H3StyleLora {
            name: r"MinimaxH3\MysticXXX_MMH3-V1.safetensors".to_owned(),
            strength: 0.35,
            bypassed: false,
            apply_to_secondary: false,
            apply_to_second_pass: None,
        }];
        assert!(validate_colab_lora_allowlist(
            "MinimaxH3/pika_h3_flex_fl2va_comfy_bf16.safetensors",
            false,
            Some(&styles),
            "",
            true,
        )
        .is_ok());

        let foreign = vec![H3StyleLora {
            name: "MinimaxH3/drive_only.safetensors".to_owned(),
            strength: 0.5,
            bypassed: false,
            apply_to_secondary: false,
            apply_to_second_pass: None,
        }];
        assert!(validate_colab_lora_allowlist(
            "MinimaxH3/pika_h3_flex_fl2va_comfy_bf16.safetensors",
            false,
            Some(&foreign),
            "",
            true,
        )
        .is_err());

        let bindings = colab_fla_reference_v3_bindings();
        let mut workflow: Value = serde_json::from_str(COLAB_FLA_V3_WORKFLOW_JSON).unwrap();
        crate::commands::configure_h3_diffusion_model(
            &mut workflow,
            dasiwa.diffusion_model_name,
            &bindings,
        )
        .unwrap();
        crate::commands::configure_h3_generation(
            &mut workflow,
            "test prompt",
            42,
            10.0,
            "16:9 (Widescreen)",
            0.8,
            0.5,
            5,
            5,
            4,
            1.0,
            1.0,
            0.8,
            1.0,
            1.0,
            0.9,
            1.0,
            false,
            "MinimaxH3/pika_h3_flex_fl2va_comfy_bf16.safetensors",
            0.6,
            false,
            "",
            1.0,
            true,
            "",
            1.0,
            true,
            false,
            &bindings,
            Some(&styles),
        )
        .unwrap();
        crate::commands::configure_h3_uploaded_media(
            &mut workflow,
            "reference-to-video",
            &["ref0.png".to_owned(), "ref1.png".to_owned()],
            &[],
            &["aud0.mp3".to_owned(), "aud1.mp3".to_owned(), "aud2.mp3".to_owned()],
            &bindings,
        )
        .unwrap();
        let save_ids = adapt_workflow_for_colab_ss(&mut workflow, "5555", 2).unwrap();
        assert_eq!(save_ids, vec!["9001".to_owned()]);
        assert_eq!(
            workflow["127"]["inputs"]["unet_name"],
            json!(dasiwa.diffusion_model_name)
        );
        assert_eq!(workflow["141"]["class_type"], "ModelPreviewOverrideKJ");
        assert_eq!(workflow["124"]["inputs"]["model"], json!(["141", 0]));
        assert_eq!(workflow["9200"]["inputs"]["model"], json!(["141", 0]));
        assert_eq!(
            workflow["9200"]["inputs"]["lora_name"],
            json!("MinimaxH3/MysticXXX_MMH3-V1.safetensors")
        );
        assert_eq!(workflow["139"]["inputs"]["image"], json!("ref0.png"));
        assert_eq!(workflow["258"]["inputs"]["image"], json!("ref1.png"));
        assert_eq!(workflow["9607"]["inputs"]["audio"], json!("aud2.mp3"));
        assert!(workflow.get("sucanvas_ss_encode_9001").is_some());
        assert_eq!(workflow["9001"]["class_type"], "SaveImage");
    }
}
