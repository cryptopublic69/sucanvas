//! TRANSITIONAL — delete in stage five (CANVAS-024 design §6, su 11-01: v1 packages are
//! converted on import during the transition).
//!
//! This is the ONLY place allowed to know the v1 packages (adapter ids, their bindings, the
//! node topology the old submission code inferred). It turns a v1 package into a v2 package
//! whose generic steps reproduce the old submission field by field (proven by the golden
//! test), and turns a v1 request into the v2 engine request. The engine itself stays generic.

#[cfg(test)]
use super::{EngineRequest, PortType};
use super::{PackageV2, ENGINE_API_VERSION};
use crate::workflow_modules::{
    WorkflowAdapter, WorkflowBindings, WorkflowUiSchema, H3_FIRST_LAST_FRAME_ADAPTER,
    H3_IMAGE_TO_VIDEO_ADAPTER, H3_LAST_FRAME_TO_VIDEO_ADAPTER, H3_MULTI_REFERENCE_ADAPTER,
    KREA2_IMAGE_EDIT_ADAPTER, KREA2_TEXT_TO_IMAGE_ADAPTER, MOSS_TEXT_TO_IMAGE_ADAPTER,
    VIDEO_PROCESSING_ADAPTER,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

// ---------- small JSON builders for steps, values and conditions ----------

fn c(id: &str) -> Value {
    json!({ "control": id })
}
fn item(field: &str) -> Value {
    json!({ "item": field })
}
fn konst(value: Value) -> Value {
    json!({ "const": value })
}
fn link(node: &str, index: u64) -> Value {
    json!({ "link": [node, index] })
}
fn var(id: &str) -> Value {
    json!({ "var": id })
}
fn media(port: &str, index: usize) -> Value {
    json!({ "media": { "port": port, "index": index } })
}
fn seed() -> Value {
    json!({ "seed": true })
}
fn trim(value: Value) -> Value {
    json!({ "trim": value })
}
fn path(value: Value) -> Value {
    json!({ "path": value })
}
fn int(value: Value) -> Value {
    json!({ "int": value })
}
fn float(value: Value) -> Value {
    json!({ "float": value })
}
fn iff(cond: Value, then: Value, otherwise: Value) -> Value {
    json!({ "if": { "cond": cond, "then": then, "else": otherwise } })
}
fn empty(value: Value) -> Value {
    json!({ "empty": value })
}
fn truthy(value: Value) -> Value {
    json!({ "truthy": value })
}
fn not(cond: Value) -> Value {
    json!({ "not": cond })
}
fn all(conds: Vec<Value>) -> Value {
    json!({ "all": conds })
}
fn any(conds: Vec<Value>) -> Value {
    json!({ "any": conds })
}
fn at_least(port: &str, count: usize) -> Value {
    json!({ "mediaAtLeast": { "port": port, "count": count } })
}
fn set(node: &str, input: &str, value: Value) -> Value {
    json!({ "op": "set", "node": node, "input": input, "value": value })
}
fn set_when(node: &str, input: &str, value: Value, cond: Value) -> Value {
    json!({ "op": "set", "node": node, "input": input, "value": value, "when": cond })
}
fn remove_node_when(node: &str, cond: Value) -> Value {
    json!({ "op": "removeNode", "node": node, "when": cond })
}
fn remove_input_when(node: &str, input: &str, cond: Value) -> Value {
    json!({ "op": "removeInput", "node": node, "input": input, "when": cond })
}
fn capture(id: &str, node: &str, input: &str) -> Value {
    json!({ "op": "capture", "id": id, "value": { "input": { "node": node, "input": input } } })
}

fn text(id: &str, label: &str, trimmed_default: &str) -> Value {
    json!({ "id": id, "type": "textarea", "label": label, "default": trimmed_default })
}
fn number(
    id: &str,
    label: &str,
    format: &str,
    min: f64,
    max: Option<f64>,
    default: Value,
) -> Value {
    let mut control = json!({ "id": id, "type": "number", "label": label, "number": format, "min": min, "default": default });
    if let Some(max) = max {
        control["max"] = json!(max);
    }
    control
}
fn toggle(id: &str, label: &str, default: bool) -> Value {
    json!({ "id": id, "type": "toggle", "label": label, "default": default })
}
fn files(
    id: &str,
    label: &str,
    class_type: &str,
    input: &str,
    dirs: Vec<String>,
    default: &str,
) -> Value {
    json!({ "id": id, "type": "select", "label": label, "default": default, "allowEmpty": true,
            "options": { "comfyui": { "classType": class_type, "input": input, "dirs": dirs } } })
}
fn seed_control() -> Value {
    json!({ "id": "seed", "type": "seed", "label": "种子" })
}

fn workflow_input<'a>(workflow: &'a Value, node: &str, input: &str) -> Option<&'a Value> {
    workflow.get(node)?.get("inputs")?.get(input)
}

// ---------- package conversion ----------

pub fn convert_package(
    _manifest: &Value,
    adapter: &Value,
    ui_schema: &Value,
    workflow: &Value,
) -> Result<PackageV2, String> {
    let adapter: WorkflowAdapter = serde_json::from_value(adapter.clone())
        .map_err(|error| format!("第 1 版适配器无法解析：{error}"))?;
    let ui_schema: WorkflowUiSchema = serde_json::from_value(ui_schema.clone())
        .map_err(|error| format!("第 1 版界面定义无法解析：{error}"))?;
    let mut node_types = BTreeMap::new();
    let operations = match adapter.adapter_id.as_str() {
        KREA2_TEXT_TO_IMAGE_ADAPTER => {
            let bindings = krea2_bindings(&adapter.bindings);
            node_types.insert(
                bindings.primary_lora_node_id.clone(),
                bindings.lora_class_type.clone(),
            );
            json!({ "generate": krea2_generate(&bindings), "upscaleImage": krea2_upscale(&bindings) })
        }
        KREA2_IMAGE_EDIT_ADAPTER => json!({ "generate": krea2_edit(&adapter.bindings) }),
        MOSS_TEXT_TO_IMAGE_ADAPTER => {
            json!({ "generate": moss_generate(&moss_bindings(&adapter.bindings)) })
        }
        VIDEO_PROCESSING_ADAPTER => json!({ "generate": video_processing(&adapter, &ui_schema)? }),
        H3_MULTI_REFERENCE_ADAPTER
        | H3_IMAGE_TO_VIDEO_ADAPTER
        | H3_LAST_FRAME_TO_VIDEO_ADAPTER
        | H3_FIRST_LAST_FRAME_ADAPTER => {
            json!({ "generate": h3_generate(&adapter, workflow, &mut node_types)? })
        }
        other => return Err(format!("没有第 1 版方案 {other} 的转换规则")),
    };
    let mut operations = operations;
    mark_created_inputs(&mut operations, workflow);
    // CANVAS-022: images made by Moss do not offer the toolbar upscale (a Krea2 branch).
    let result_upscale = adapter.adapter_id != MOSS_TEXT_TO_IMAGE_ADAPTER;
    serde_json::from_value(json!({
        "engineApiVersion": ENGINE_API_VERSION,
        "capability": adapter.capability,
        "variant": adapter.variant,
        "nodeTypes": node_types,
        "operations": operations,
        "resultUpscale": result_upscale,
    }))
    .map_err(|error| format!("转换结果不是有效的第 2 版方案包：{error}"))
}

/// CANVAS-024c: the module settings a v1 package kept in manifest.json `defaults`, as
/// (operation, control, value) presets. The image modules' settings page chose the base
/// model the old frontend submitted when the node did not say otherwise.
pub fn module_presets(manifest: &Value, package: &PackageV2) -> Vec<(String, String, Value)> {
    let mut presets = Vec::new();
    if package.capability != "image-generation" {
        return presets;
    }
    let model = manifest
        .pointer("/defaults/diffusionModelName")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if model.is_empty() {
        return presets;
    }
    for (name, operation) in &package.operations {
        if operation
            .controls
            .iter()
            .any(|control| control.id == "modelName")
        {
            presets.push((name.clone(), "modelName".to_owned(), json!(model)));
        }
    }
    presets
}

/// The old code inserted values even where the workflow node had no such input yet; mark
/// those writes `create` so import validation stays exact for everything else.
fn mark_created_inputs(operations: &mut Value, workflow: &Value) {
    let Some(operations) = operations.as_object_mut() else {
        return;
    };
    for operation in operations.values_mut() {
        let Some(steps) = operation.get_mut("steps").and_then(Value::as_array_mut) else {
            continue;
        };
        for step in steps {
            if step["op"] != "set" || step.get("create").is_some() {
                continue;
            }
            let node = step["node"].as_str().unwrap_or_default().to_owned();
            let input = step["input"].as_str().unwrap_or_default().to_owned();
            if workflow.get(&node).is_some() && workflow_input(workflow, &node, &input).is_none() {
                step["create"] = json!(true);
            }
        }
    }
}

/// The old Krea2 path filled empty LoRA / upscale bindings from the built-in defaults.
fn krea2_bindings(bindings: &WorkflowBindings) -> WorkflowBindings {
    let defaults = WorkflowBindings::image_generation();
    let mut bindings = bindings.clone();
    for (value, default) in [
        (
            &mut bindings.primary_lora_node_id,
            &defaults.primary_lora_node_id,
        ),
        (&mut bindings.lora_class_type, &defaults.lora_class_type),
        (&mut bindings.lora_directory, &defaults.lora_directory),
        (
            &mut bindings.secondary_resize_node_id,
            &defaults.secondary_resize_node_id,
        ),
    ] {
        if value.trim().is_empty() {
            value.clone_from(default);
        }
    }
    bindings
}

fn moss_bindings(bindings: &WorkflowBindings) -> WorkflowBindings {
    let defaults = WorkflowBindings::moss_image_generation();
    let mut bindings = bindings.clone();
    for (value, default) in [
        (&mut bindings.prompt_node_id, &defaults.prompt_node_id),
        (
            &mut bindings.conditioning_node_id,
            &defaults.conditioning_node_id,
        ),
        (&mut bindings.seed_node_id, &defaults.seed_node_id),
        (
            &mut bindings.primary_resolution_node_id,
            &defaults.primary_resolution_node_id,
        ),
        (
            &mut bindings.primary_output_node_id,
            &defaults.primary_output_node_id,
        ),
        (
            &mut bindings.diffusion_model_node_id,
            &defaults.diffusion_model_node_id,
        ),
        (
            &mut bindings.diffusion_model_directory,
            &defaults.diffusion_model_directory,
        ),
    ] {
        if value.trim().is_empty() {
            value.clone_from(default);
        }
    }
    bindings
}

/// Krea2 model names also live in the historical "Kera2" directory (su 11-01: a typo,
/// renamed at go-live); until then both are accepted.
fn krea2_model_dirs(bindings: &WorkflowBindings) -> Vec<String> {
    let mut dirs = vec![bindings.diffusion_model_directory.clone()];
    if !dirs.iter().any(|dir| dir.eq_ignore_ascii_case("Kera2")) {
        dirs.push("Kera2".to_owned());
    }
    dirs
}

/// CANVAS-024c: the image node's look as the old fixed UI drew it. The positive prompt is the
/// text connected to the node (a text port), everything else a control.
fn image_controls(steps_default: u32) -> Vec<Value> {
    let mut negative = text("negativePrompt", "负向提示词", "");
    negative["help"] = json!("可选：直接输入不希望出现的内容");
    let mut width = number("width", "宽度", "int", 64.0, Some(4096.0), json!(1280));
    let mut height = number("height", "高度", "int", 64.0, Some(4096.0), json!(720));
    for size in [&mut width, &mut height] {
        size["group"] = json!("size");
        size["unit"] = json!("px");
    }
    let mut steps = number(
        "steps",
        "生图步数",
        "int",
        1.0,
        Some(1000.0),
        json!(steps_default),
    );
    steps["group"] = json!("sampling");
    steps["help"] = json!("基础文生图 K 采样器的采样步数");
    vec![negative, width, height, steps, seed_control()]
}

fn image_groups() -> Value {
    json!([{ "id": "size", "swap": true }, { "id": "sampling" }])
}

fn prompt_port() -> Value {
    json!({ "id": "prompt", "type": "text", "label": "提示词", "min": 1, "max": 1 })
}

fn model_record(node: &str) -> Value {
    json!({ "modelName": { "input": { "node": node, "input": "unet_name" } } })
}

fn cfg_by_negative() -> Value {
    iff(
        empty(trim(c("negativePrompt"))),
        konst(json!(1.0)),
        konst(json!(1.5)),
    )
}

fn krea2_generate(b: &WorkflowBindings) -> Value {
    let mut lora = files(
        "loraName",
        "LoRA",
        "LoraLoaderModelOnly",
        "lora_name",
        vec![b.lora_directory.clone()],
        "",
    );
    lora["emptyLabel"] = json!("不使用 LoRA");
    let mut controls = vec![
        lora,
        files(
            "modelName",
            "模型",
            &b.diffusion_model_class_type,
            "unet_name",
            krea2_model_dirs(b),
            "",
        ),
    ];
    controls.extend(image_controls(8));
    let mut upscale = toggle("upscaleEnabled", "输出放大", false);
    upscale["group"] = json!("sampling");
    controls.push(upscale);
    let mut megapixels = number(
        "upscaleMegapixels",
        "放大像素数",
        "float",
        0.1,
        Some(64.0),
        json!(8.0),
    );
    megapixels["group"] = json!("sampling");
    megapixels["unit"] = json!("MP");
    megapixels["help"] = json!("放大后的目标像素数（MP）");
    controls.push(megapixels);
    let has_model = not(empty(trim(c("modelName"))));
    let steps = vec![
        set_when(
            &b.diffusion_model_node_id,
            "unet_name",
            path(c("modelName")),
            has_model,
        ),
        set_when(
            &b.primary_lora_node_id,
            "lora_1",
            json!({ "object": { "on": konst(json!(true)), "lora": trim(c("loraName")), "strength": konst(json!(1.0)) } }),
            not(empty(trim(c("loraName")))),
        ),
        set(&b.prompt_node_id, "text", trim(media("prompt", 0))),
        set(&b.conditioning_node_id, "text", trim(c("negativePrompt"))),
        set(&b.seed_node_id, "cfg", cfg_by_negative()),
        set(&b.primary_sampler_node_id, "cfg", cfg_by_negative()),
        set(&b.seed_node_id, "noise_seed", seed()),
        set(&b.seed_node_id, "steps", int(c("steps"))),
        set(&b.primary_resolution_node_id, "width", int(c("width"))),
        set(&b.primary_resolution_node_id, "height", int(c("height"))),
        set(
            &b.seed_node_id,
            "latent_image",
            link(&b.primary_resolution_node_id, 0),
        ),
        set(
            &b.secondary_resize_node_id,
            "megapixels",
            float(c("upscaleMegapixels")),
        ),
        set(
            &b.primary_output_node_id,
            "images",
            iff(truthy(c("upscaleEnabled")), link("163", 0), link("30", 0)),
        ),
    ];
    json!({ "label": "生成", "inputs": [prompt_port()], "outputs": [{ "id": "image", "type": "image" }],
            "controls": controls, "groups": image_groups(), "steps": steps,
            "record": model_record(&b.diffusion_model_node_id) })
}

fn krea2_upscale(b: &WorkflowBindings) -> Value {
    const SOURCE: &str = "infinite_canvas_image_upscale_source";
    let controls = vec![
        number(
            "megapixels",
            "放大像素数",
            "float",
            0.1,
            Some(64.0),
            json!(8.0),
        ),
        files(
            "modelName",
            "模型",
            &b.diffusion_model_class_type,
            "unet_name",
            krea2_model_dirs(b),
            "",
        ),
    ];
    let steps = vec![
        set_when(
            &b.diffusion_model_node_id,
            "unet_name",
            path(c("modelName")),
            not(empty(trim(c("modelName")))),
        ),
        json!({ "op": "addNode", "node": SOURCE, "classType": "LoadImage", "inputs": { "image": media("source", 0) } }),
        set(&b.secondary_resize_node_id, "image", link(SOURCE, 0)),
        set(
            &b.secondary_resize_node_id,
            "megapixels",
            float(c("megapixels")),
        ),
        set(
            &b.primary_output_node_id,
            "images",
            link(&b.secondary_resize_node_id, 0),
        ),
    ];
    json!({ "label": "放大图片", "inputs": [{ "id": "source", "type": "image", "label": "源图片", "min": 1, "max": 1 }],
            "outputs": [{ "id": "image", "type": "image" }], "controls": controls, "steps": steps,
            "record": model_record(&b.diffusion_model_node_id) })
}

fn krea2_edit(b: &WorkflowBindings) -> Value {
    let mut model = files(
        "modelName",
        "模型",
        &b.diffusion_model_class_type,
        "unet_name",
        krea2_model_dirs(b),
        "Kera2\\pornmasterKrea2_v2TurboBF16.safetensors",
    );
    model["allowEmpty"] = json!(false);
    model["emptyMeansDefault"] = json!(true);
    let mut controls = vec![model];
    controls.extend(image_controls(8));
    let single = not(at_least("images", 2));
    let dual = at_least("images", 2);
    let first_dual_input = b.image_node_ids.first().cloned().unwrap_or_default();
    let mut steps = vec![set(
        &b.primary_output_node_id,
        "filename_prefix",
        json!({ "date": konst(json!("%date:yyyy-MM-dd%/ComfyUI_krea2_image_edit")) }),
    )];
    for node in ["43", "18"] {
        steps.push(set(node, "unet_name", path(c("modelName"))));
    }
    for node in ["42", "17"] {
        steps.push(set(
            node,
            "lora_name",
            konst(json!("Krea2\\krea2_identity_edit_v1_2.safetensors")),
        ));
    }
    steps.extend([
        set_when(
            &b.single_image_input_node_id,
            "image",
            media("images", 0),
            single.clone(),
        ),
        set_when(
            &b.primary_output_node_id,
            "images",
            link("29", 0),
            single.clone(),
        ),
        set_when(
            &b.primary_resolution_node_id,
            "width",
            int(c("width")),
            single.clone(),
        ),
        set_when(
            &b.primary_resolution_node_id,
            "height",
            int(c("height")),
            single,
        ),
        set_when(&first_dual_input, "image", media("images", 0), dual.clone()),
        set_when(
            &b.secondary_image_input_node_id,
            "image",
            media("images", 1),
            dual.clone(),
        ),
        set_when(
            &b.secondary_resolution_node_id,
            "width",
            int(c("width")),
            dual.clone(),
        ),
        set_when(
            &b.secondary_resolution_node_id,
            "height",
            int(c("height")),
            dual.clone(),
        ),
        set_when(&b.primary_output_node_id, "images", link("6", 0), dual),
        set(&b.prompt_node_id, "value", trim(media("prompt", 0))),
        set(
            &b.secondary_prompt_node_id,
            "value",
            trim(media("prompt", 0)),
        ),
        set(&b.conditioning_node_id, "prompt", trim(c("negativePrompt"))),
        set(
            &b.secondary_conditioning_node_id,
            "prompt",
            trim(c("negativePrompt")),
        ),
    ]);
    for node in [&b.seed_node_id, &b.primary_sampler_node_id] {
        steps.push(set(node, "seed", seed()));
        steps.push(set(node, "steps", int(c("steps"))));
        steps.push(set(node, "cfg", cfg_by_negative()));
    }
    json!({ "label": "生成",
            "inputs": [prompt_port(), { "id": "images", "type": "image", "label": "编辑图片", "min": 1, "max": 2 }],
            "outputs": [{ "id": "image", "type": "image" }], "controls": controls, "groups": image_groups(),
            "steps": steps, "record": model_record("43") })
}

fn moss_generate(b: &WorkflowBindings) -> Value {
    let mut controls = vec![files(
        "modelName",
        "模型",
        &b.diffusion_model_class_type,
        "unet_name",
        vec![b.diffusion_model_directory.clone()],
        "",
    )];
    controls.extend(image_controls(25));
    let round = |control: &str| json!({ "roundTo": { "value": int(c(control)), "multiple": 16, "min": 16 } });
    let steps = vec![
        set_when(
            &b.diffusion_model_node_id,
            "unet_name",
            path(c("modelName")),
            not(empty(trim(c("modelName")))),
        ),
        set(&b.prompt_node_id, "value", trim(media("prompt", 0))),
        set_when(
            &b.conditioning_node_id,
            "text",
            trim(c("negativePrompt")),
            not(empty(trim(c("negativePrompt")))),
        ),
        set(&b.seed_node_id, "seed", seed()),
        set(&b.seed_node_id, "steps", int(c("steps"))),
        set(&b.primary_resolution_node_id, "width", round("width")),
        set(&b.primary_resolution_node_id, "height", round("height")),
        json!({ "op": "keepReachable", "from": [b.primary_output_node_id] }),
    ];
    json!({ "label": "生成", "inputs": [prompt_port()], "outputs": [{ "id": "image", "type": "image" }],
            "controls": controls, "groups": image_groups(), "steps": steps,
            "results": [{ "node": b.primary_output_node_id }],
            "record": model_record(&b.diffusion_model_node_id) })
}

fn video_processing(
    adapter: &WorkflowAdapter,
    ui_schema: &WorkflowUiSchema,
) -> Result<Value, String> {
    let processing = adapter
        .video_processing
        .as_ref()
        .ok_or_else(|| "视频处理方案缺少 videoProcessing 映射".to_owned())?;
    let controls = ui_schema
        .groups
        .iter()
        .flat_map(|group| &group.fields)
        .map(|field| json!({ "id": field.key, "type": "number", "label": field.label, "number": "intIfWhole",
                             "min": field.min, "max": field.max, "step": field.step, "default": field.default }))
        .collect::<Vec<_>>();
    let mut steps = vec![set(
        &processing.video_input.node_id,
        &processing.video_input.input_name,
        media("source", 0),
    )];
    for (key, binding) in &processing.parameters {
        steps.push(set(
            &binding.node_id,
            &binding.input_name,
            json!({ "intIfWhole": c(key) }),
        ));
    }
    Ok(
        json!({ "label": "处理", "inputs": [{ "id": "source", "type": "video", "min": 1, "max": 1 }],
               "outputs": [{ "id": "video", "type": "video" }], "controls": controls, "steps": steps }),
    )
}

// ---------- the video-generation packages ----------

const ASPECT_RATIOS: [(&str, &str); 7] = [
    ("16:9", "16:9 (Widescreen)"),
    ("9:16", "9:16 (Portrait Widescreen)"),
    ("4:3", "4:3 (Standard)"),
    ("3:4", "3:4 (Portrait Standard)"),
    ("2:3", "2:3 (Portrait Photo)"),
    ("3:2", "3:2 (Photo)"),
    ("1:1", "1:1 (Square)"),
];
const DEFAULT_VIDEO_PREFIX: &str = "%date:yyyy-MM-dd%/Minimax_H3";

fn aspect_ratio() -> Value {
    let table = ASPECT_RATIOS
        .iter()
        .map(|(key, value)| (key.to_string(), json!(value)))
        .collect::<Map<_, _>>();
    json!({ "map": { "value": trim(c("aspectRatio")), "table": table } })
}

fn video_prefix(workflow: &Value, output_node: &str) -> String {
    workflow_input(workflow, output_node, "filename_prefix")
        .and_then(Value::as_str)
        .map(|prefix| match prefix.trim().replace('\\', "/").as_str() {
            "video/MiniMax_H3" | "video/Minimax_H3" => DEFAULT_VIDEO_PREFIX.to_owned(),
            _ => prefix.to_owned(),
        })
        .unwrap_or_else(|| DEFAULT_VIDEO_PREFIX.to_owned())
}

fn slots(ids: &[String], legacy: &str) -> Vec<String> {
    if ids.is_empty() {
        vec![legacy.to_owned()]
    } else {
        ids.to_vec()
    }
}

fn chain(
    id: &str,
    slot_ids: &[String],
    item_when: Value,
    from: Value,
    to: Vec<(&str, &str)>,
) -> Value {
    json!({ "op": "chain", "id": id, "repeat": "styleLoras", "slots": slot_ids, "linkInput": "model",
            "itemWhen": item_when,
            "fields": { "lora_name": trim(item("name")), "strength_model": float(item("strength")) },
            "from": from,
            "to": to.into_iter().map(|(node, input)| json!({ "node": node, "input": input })).collect::<Vec<_>>() })
}

fn h3_generate(
    adapter: &WorkflowAdapter,
    workflow: &Value,
    node_types: &mut BTreeMap<String, String>,
) -> Result<Value, String> {
    let b = &adapter.bindings;
    let variant = adapter.variant.as_str();
    let contract = &adapter.input_contract;
    let lora_dirs = vec![b.lora_directory.clone()];
    let secondary_enabled = any(vec![
        truthy(c("secondarySamplingEnabled")),
        at_least("secondarySource", 1),
    ]);

    // ports
    let mut inputs = Vec::new();
    match variant {
        "first-last-frame" => {
            inputs.push(
                json!({ "id": "firstFrame", "type": "image", "label": "首帧", "min": 0, "max": 1 }),
            );
            inputs.push(
                json!({ "id": "lastFrame", "type": "image", "label": "尾帧", "min": 0, "max": 1 }),
            );
        }
        "image-to-video" | "last-frame-to-video" => {
            inputs.push(json!({ "id": "images", "type": "image", "min": contract.image_min, "max": contract.image_max }));
        }
        _ => {
            inputs.push(json!({ "id": "images", "type": "image", "min": contract.image_min, "max": contract.image_max }));
            inputs.push(json!({ "id": "audios", "type": "audio", "min": contract.audio_min, "max": contract.audio_max }));
        }
    }
    inputs.push(json!({ "id": "secondarySource", "type": "video", "label": "二采源视频", "min": 0, "max": 1 }));

    // controls (ids are the v1 request field names)
    let mut controls = vec![
        json!({ "id": "prompt", "type": "textarea", "label": "提示词", "default": "" }),
        number(
            "durationSeconds",
            "时长",
            "float",
            2.0,
            Some(15.0),
            json!(5.0),
        ),
        json!({ "id": "aspectRatio", "type": "select", "label": "画面比例", "default": "16:9",
                "options": { "values": ASPECT_RATIOS.iter().map(|(key, _)| json!({ "value": key })).collect::<Vec<_>>() } }),
        number(
            "primaryResolutionMegapixels",
            "1采分辨率",
            "float",
            0.2,
            Some(2.0),
            json!(0.4),
        ),
        number(
            "secondaryResolutionMegapixels",
            "2采分辨率",
            "float",
            0.2,
            Some(2.0),
            json!(0.5),
        ),
        number(
            "primaryVideoSteps",
            "1采 Video Steps",
            "int",
            1.0,
            None,
            json!(6),
        ),
        number(
            "primaryAudioSteps",
            "1采 Audio Steps",
            "int",
            1.0,
            None,
            json!(8),
        ),
        number(
            "secondarySchedulerSteps",
            "2采 Steps",
            "int",
            1.0,
            None,
            json!(4),
        ),
        number(
            "primaryUpscaleFactor",
            "1采放大倍率",
            "float",
            1.0,
            Some(4.0),
            json!(1.0),
        ),
    ];
    for (id, label, default) in [
        ("primaryBrightness", "1采亮度", 1.0),
        ("primaryContrast", "1采对比度", 0.9),
        ("primarySaturation", "1采饱和度", 0.9),
        ("secondaryBrightness", "2采亮度", 1.0),
        ("secondaryContrast", "2采对比度", 0.9),
        ("secondarySaturation", "2采饱和度", 1.0),
    ] {
        controls.push(number(id, label, "float", 0.0, Some(3.0), json!(default)));
    }
    let mut model = files(
        "diffusionModelName",
        "基础模型",
        &b.diffusion_model_class_type,
        "unet_name",
        vec![b.diffusion_model_directory.clone()],
        "",
    );
    model["allowEmpty"] = json!(false);
    controls.extend([
        toggle("secondarySamplingEnabled", "2采", false),
        model,
        files(
            "loraName",
            "LoRA",
            &b.lora_class_type,
            "lora_name",
            lora_dirs.clone(),
            "",
        ),
        number(
            "loraStrength",
            "LoRA 权重",
            "float",
            0.0,
            Some(10.0),
            json!(1.0),
        ),
        toggle("loraBypassed", "LoRA Bypass", false),
        files(
            "secondaryLoraName",
            "2采 LoRA",
            &b.lora_class_type,
            "lora_name",
            lora_dirs.clone(),
            "",
        ),
        number(
            "secondaryLoraStrength",
            "2采 LoRA 权重",
            "float",
            0.0,
            Some(10.0),
            json!(1.0),
        ),
        toggle("secondaryLoraBypassed", "2采 LoRA Bypass", false),
        json!({ "id": "styleLoras", "type": "repeat", "label": "风格 LoRA", "max": 6, "fields": [
            files("name", "LoRA", &b.lora_class_type, "lora_name", lora_dirs, ""),
            number("strength", "权重", "float", 0.0, Some(10.0), json!(1.0)),
            toggle("on", "启用", true),
            toggle("toSecondary", "应用到二段", false),
            toggle("toSecondPass", "应用到2采", false),
        ] }),
    ]);
    let conditioning_has =
        |input: &str| workflow_input(workflow, &b.conditioning_node_id, input).is_some();
    if variant == "reference-to-video" {
        controls.push(json!({ "id": "refImageSize", "type": "select", "label": "参考图尺寸", "default": "max",
                              "options": { "values": [{ "value": "max" }, { "value": "match" }] } }));
    }
    if conditioning_has("strict_prompt_tags") {
        controls.push(toggle("strictPromptTags", "严格提示词标签", false));
    }
    controls.push(seed_control());

    let mut steps = Vec::new();
    // diffusion model
    node_types.insert(
        b.diffusion_model_node_id.clone(),
        b.diffusion_model_class_type.clone(),
    );
    steps.push(set(
        &b.diffusion_model_node_id,
        "unet_name",
        trim(c("diffusionModelName")),
    ));
    if !b.secondary_diffusion_model_node_id.trim().is_empty() {
        node_types.insert(
            b.secondary_diffusion_model_node_id.clone(),
            b.diffusion_model_class_type.clone(),
        );
        steps.push(set(
            &b.secondary_diffusion_model_node_id,
            "unet_name",
            trim(c("diffusionModelName")),
        ));
    }
    // generation
    steps.extend([
        set(&b.prompt_node_id, "value", c("prompt")),
        set(&b.seed_node_id, "noise_seed", seed()),
        set(&b.duration_node_id, "value", float(c("durationSeconds"))),
        set(
            &b.primary_resolution_node_id,
            "aspect_ratio",
            aspect_ratio(),
        ),
        set(
            &b.primary_resolution_node_id,
            "megapixels",
            float(c("primaryResolutionMegapixels")),
        ),
        set_when(
            &b.secondary_resolution_node_id,
            "aspect_ratio",
            aspect_ratio(),
            secondary_enabled.clone(),
        ),
        set_when(
            &b.secondary_resolution_node_id,
            "megapixels",
            float(c("secondaryResolutionMegapixels")),
            secondary_enabled.clone(),
        ),
    ]);
    let steps_node = if b.primary_steps_node_id.trim().is_empty() {
        &b.primary_sampler_node_id
    } else {
        &b.primary_steps_node_id
    };
    steps.push(set(
        steps_node,
        &b.primary_video_steps_input_name,
        int(c("primaryVideoSteps")),
    ));
    if !b.primary_audio_steps_input_name.trim().is_empty() {
        steps.push(set(
            steps_node,
            &b.primary_audio_steps_input_name,
            int(c("primaryAudioSteps")),
        ));
    }
    if b.secondary_scheduler_node_id != *steps_node {
        steps.push(set(
            &b.secondary_scheduler_node_id,
            "steps",
            int(c("secondarySchedulerSteps")),
        ));
    }
    if !b.primary_upscale_node_id.trim().is_empty() {
        let input = if workflow_input(workflow, &b.primary_upscale_node_id, "scale").is_some() {
            "scale"
        } else {
            "value"
        };
        steps.push(set(
            &b.primary_upscale_node_id,
            input,
            float(c("primaryUpscaleFactor")),
        ));
    }
    for (node, prefix) in [
        (&b.primary_color_node_id, "primary"),
        (&b.secondary_color_node_id, "secondary"),
    ] {
        for (input, field) in [
            ("brightness", "Brightness"),
            ("contrast", "Contrast"),
            ("saturation", "Saturation"),
        ] {
            steps.push(set(node, input, float(c(&format!("{prefix}{field}")))));
        }
    }
    h3_loras(b, workflow, node_types, &mut steps);
    h3_clean_output(b, workflow, &secondary_enabled, &mut steps);
    if variant == "reference-to-video" {
        let create = !conditioning_has("ref_image_size");
        steps.push(
            json!({ "op": "set", "node": b.conditioning_node_id, "input": "ref_image_size",
                           "value": c("refImageSize"), "create": create }),
        );
    }
    if conditioning_has("strict_prompt_tags") {
        steps.push(set_when(
            &b.conditioning_node_id,
            "strict_prompt_tags",
            c("strictPromptTags"),
            json!({ "defined": "strictPromptTags" }),
        ));
    }
    h3_media(b, variant, &mut steps)?;
    h3_secondary_source(b, node_types, &mut steps);
    Ok(
        json!({ "label": "生成", "inputs": inputs, "outputs": [{ "id": "video", "type": "video" }],
               "controls": controls, "steps": steps }),
    )
}

fn h3_loras(
    b: &WorkflowBindings,
    workflow: &Value,
    node_types: &mut BTreeMap<String, String>,
    steps: &mut Vec<Value>,
) {
    for node in [&b.primary_lora_node_id, &b.secondary_lora_node_id] {
        node_types.insert(node.clone(), b.lora_class_type.clone());
    }
    let primary_slots = slots(
        &b.primary_style_lora_node_ids,
        &b.primary_style_lora_node_id,
    );
    let secondary_slots = slots(
        &b.secondary_style_lora_node_ids,
        &b.secondary_style_lora_node_id,
    );
    let independent_slots = (9600..9606).map(|id| id.to_string()).collect::<Vec<_>>();
    let on = truthy(item("on"));
    let on_secondary = all(vec![truthy(item("on")), truthy(item("toSecondary"))]);
    let on_second_pass = all(vec![truthy(item("on")), truthy(item("toSecondPass"))]);
    let primary_bypassed = any(vec![empty(trim(c("loraName"))), truthy(c("loraBypassed"))]);
    let secondary_bypassed = any(vec![
        empty(trim(c("secondaryLoraName"))),
        truthy(c("secondaryLoraBypassed")),
    ]);
    let live = b.live_preview_node_id.as_str();
    steps.push(capture("primaryUpstream", &b.primary_lora_node_id, "model"));
    steps.push(capture(
        "secondaryUpstream",
        &b.secondary_lora_node_id,
        "model",
    ));
    steps.extend([
        set_when(
            &b.primary_lora_node_id,
            "lora_name",
            trim(c("loraName")),
            not(primary_bypassed.clone()),
        ),
        set_when(
            &b.primary_lora_node_id,
            "strength_model",
            float(c("loraStrength")),
            not(primary_bypassed.clone()),
        ),
        set_when(
            &b.secondary_lora_node_id,
            "lora_name",
            trim(c("secondaryLoraName")),
            not(secondary_bypassed.clone()),
        ),
        set_when(
            &b.secondary_lora_node_id,
            "strength_model",
            float(c("secondaryLoraStrength")),
            not(secondary_bypassed.clone()),
        ),
    ]);
    for node in primary_slots.iter().chain(&secondary_slots) {
        node_types.insert(node.clone(), b.lora_class_type.clone());
    }
    let stage_local = b.primary_lora_node_id == b.secondary_lora_node_id
        && b.primary_sol_attn_node_id.trim().is_empty()
        && b.secondary_sol_attn_node_id.trim().is_empty()
        && b.primary_model_target_node_id == "142"
        && !live.trim().is_empty()
        && !b.primary_style_lora_node_id.trim().is_empty()
        && !b.secondary_style_lora_node_id.trim().is_empty();
    if stage_local {
        for node in &independent_slots {
            node_types.insert(node.clone(), b.lora_class_type.clone());
        }
        steps.push(set(
            &b.primary_model_target_node_id,
            "model",
            iff(
                all(vec![primary_bypassed, secondary_bypassed]),
                var("primaryUpstream"),
                link(&b.primary_lora_node_id, 0),
            ),
        ));
        steps.push(set(&b.secondary_scheduler_node_id, "model", link(live, 0)));
        steps.push(chain(
            "primaryStage",
            &primary_slots,
            on,
            link(live, 0),
            vec![],
        ));
        steps.push(chain(
            "secondaryStage",
            &secondary_slots,
            on_secondary,
            link(live, 0),
            vec![],
        ));
        let guider = workflow_input(workflow, &b.primary_sampler_node_id, "guider")
            .and_then(Value::as_array)
            .and_then(|connection| connection.first())
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        steps.push(set(&guider, "model", var("primaryStage")));
        steps.push(set(
            &b.secondary_guider_node_id,
            "model",
            var("secondaryStage"),
        ));
        steps.push(chain(
            "independent",
            &independent_slots,
            on_second_pass,
            link(live, 0),
            vec![("9391", "model"), ("9393", "model")],
        ));
        return;
    }
    let primary_model = iff(
        primary_bypassed,
        var("primaryUpstream"),
        link(&b.primary_lora_node_id, 0),
    );
    let secondary_model = iff(
        secondary_bypassed,
        var("secondaryUpstream"),
        link(&b.secondary_lora_node_id, 0),
    );
    let native_stages = !live.is_empty() && workflow.get("209").is_some();
    let primary_style_model = if native_stages {
        for node in &independent_slots {
            node_types.insert(node.clone(), b.lora_class_type.clone());
        }
        steps.push(set(
            &b.primary_model_target_node_id,
            "model",
            primary_model.clone(),
        ));
        steps.push(chain(
            "first",
            &primary_slots,
            on,
            link(live, 0),
            vec![("126", "model")],
        ));
        steps.push(chain(
            "second",
            &independent_slots,
            on_secondary,
            link(live, 0),
            vec![("9606", "model")],
        ));
        primary_model
    } else {
        steps.push(chain(
            "primaryStyle",
            &primary_slots,
            on,
            primary_model,
            vec![],
        ));
        var("primaryStyle")
    };
    steps.push(chain(
        "secondaryStyle",
        &secondary_slots,
        on_second_pass,
        secondary_model,
        vec![],
    ));
    let mut stage = |sol: &str, value: Value| -> Value {
        if sol.trim().is_empty() {
            value
        } else {
            node_types.insert(sol.to_owned(), "SolAttnMiniMax".to_owned());
            steps.push(set(sol, "model", value));
            link(sol, 0)
        }
    };
    let primary_stage = stage(&b.primary_sol_attn_node_id, primary_style_model);
    let secondary_stage = stage(&b.secondary_sol_attn_node_id, var("secondaryStyle"));
    let target = if b.primary_model_target_node_id.trim().is_empty() {
        &b.primary_sampler_node_id
    } else {
        &b.primary_model_target_node_id
    };
    steps.push(set(target, "model", primary_stage));
    let reuse = b.primary_lora_node_id == b.secondary_lora_node_id
        && b.primary_sol_attn_node_id.trim().is_empty()
        && b.secondary_sol_attn_node_id.trim().is_empty();
    if !reuse {
        steps.push(set(
            &b.secondary_scheduler_node_id,
            "model",
            secondary_stage.clone(),
        ));
        steps.push(set(&b.secondary_guider_node_id, "model", secondary_stage));
    }
}

fn native_second_stage(b: &WorkflowBindings) -> bool {
    b.primary_lora_node_id == b.secondary_lora_node_id
        && b.primary_model_target_node_id == "142"
        && b.secondary_scheduler_node_id == "124"
        && b.secondary_guider_node_id == "279"
        && !b.live_preview_node_id.trim().is_empty()
}

fn h3_clean_output(
    b: &WorkflowBindings,
    workflow: &Value,
    secondary_enabled: &Value,
    steps: &mut Vec<Value>,
) {
    let primary_prefix = video_prefix(workflow, &b.primary_output_node_id);
    let secondary_prefix = video_prefix(workflow, &b.secondary_output_node_id);
    steps.push(json!({ "op": "removeNode", "node": b.primary_output_node_id }));
    steps.push(json!({ "op": "removeNode", "node": b.secondary_output_node_id }));
    if native_second_stage(b) {
        steps.push(json!({ "op": "removeNode", "node": "9404" }));
    }
    steps.push(json!({ "op": "addNode", "node": b.clean_video_node_id, "classType": "CreateVideo",
        "inputs": {
            "images": iff(secondary_enabled.clone(), link(&b.secondary_color_node_id, 0), link(&b.primary_color_node_id, 0)),
            "fps": konst(json!(24.0)),
            "audio": iff(secondary_enabled.clone(),
                link(&b.secondary_audio_output_node_id, u64::from(b.secondary_audio_output_index)),
                link(&b.primary_audio_output_node_id, u64::from(b.primary_audio_output_index))),
            "bit_depth": konst(json!(8)),
        },
        "meta": { "title": "Create Final Video" } }));
    steps.push(json!({ "op": "addNode", "node": b.clean_save_node_id, "classType": "SaveVideo",
        "inputs": {
            "video": link(&b.clean_video_node_id, 0),
            "filename_prefix": { "date": iff(secondary_enabled.clone(), konst(json!(secondary_prefix)), konst(json!(primary_prefix))) },
            "format": konst(json!("mp4")),
            "codec": konst(json!("auto")),
        },
        "meta": { "title": "Save Final Video" } }));
}

fn h3_media(b: &WorkflowBindings, variant: &str, steps: &mut Vec<Value>) -> Result<(), String> {
    match variant {
        "image-to-video" | "last-frame-to-video" => {
            let node = b
                .image_node_ids
                .first()
                .ok_or_else(|| "图生视频方案缺少图片输入节点".to_owned())?;
            steps.push(set(node, "image", media("images", 0)));
        }
        "first-last-frame" => {
            let nodes = b
                .image_node_ids
                .get(0..2)
                .ok_or_else(|| "首尾帧方案缺少两个图片输入节点".to_owned())?;
            for (port, node, input) in [
                ("firstFrame", &nodes[0], "first_frame"),
                ("lastFrame", &nodes[1], "last_frame"),
            ] {
                let present = at_least(port, 1);
                steps.push(set_when(node, "image", media(port, 0), present.clone()));
                steps.push(remove_node_when(node, not(present.clone())));
                steps.push(remove_input_when(
                    &b.conditioning_node_id,
                    input,
                    not(present),
                ));
            }
        }
        _ => {
            for (port, nodes, input, prefix) in [
                (
                    "images",
                    &b.image_node_ids,
                    "image",
                    "ref_images.ref_image_",
                ),
                (
                    "audios",
                    &b.audio_node_ids,
                    "audio",
                    "ref_audios.ref_audio_",
                ),
            ] {
                for (index, node) in nodes.iter().enumerate() {
                    let present = at_least(port, index + 1);
                    steps.push(set_when(node, input, media(port, index), present.clone()));
                    steps.push(remove_node_when(node, not(present.clone())));
                    steps.push(remove_input_when(
                        &b.conditioning_node_id,
                        &format!("{prefix}{index}"),
                        not(present),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn h3_secondary_source(
    b: &WorkflowBindings,
    node_types: &mut BTreeMap<String, String>,
    steps: &mut Vec<Value>,
) {
    let present = at_least("secondarySource", 1);
    if native_second_stage(b) {
        for (id, class) in [
            ("9300", "VHS_LoadVideo"),
            ("9398", "ResolutionSelector"),
            ("9383", "ImageResizeKJv2"),
            ("9386", "VAEEncode"),
            ("9388", "VAEEncodeAudio"),
            ("9390", "PT_H3ConcatAVLatent"),
            ("9391", "BasicScheduler"),
            ("9393", "BasicGuider"),
            ("9387", "SamplerCustomAdvanced"),
            ("9395", "VAEDecode"),
            ("9403", "LayerColor: BrightnessContrastV2"),
        ] {
            node_types.insert(id.to_owned(), class.to_owned());
        }
        let mut capture_model = capture("secondarySourceModel", "9393", "model");
        capture_model["when"] = present.clone();
        steps.push(capture_model);
        for (node, input, value) in [
            ("9300", "video", media("secondarySource", 0)),
            ("9398", "aspect_ratio", aspect_ratio()),
            (
                "9398",
                "megapixels",
                float(c("secondaryResolutionMegapixels")),
            ),
            ("9383", "image", link("9300", 0)),
            ("9388", "audio", link("9300", 2)),
            ("9391", "steps", int(c("secondarySchedulerSteps"))),
            ("9391", "model", var("secondarySourceModel")),
            ("9393", "model", var("secondarySourceModel")),
            ("9403", "brightness", float(c("secondaryBrightness"))),
            ("9403", "contrast", float(c("secondaryContrast"))),
            ("9403", "saturation", float(c("secondarySaturation"))),
            (b.clean_video_node_id.as_str(), "images", link("9403", 0)),
            (b.clean_video_node_id.as_str(), "audio", link("9300", 2)),
        ] {
            steps.push(set_when(node, input, value, present.clone()));
        }
        return;
    }
    let source = b.secondary_video_input_node_id.as_str();
    steps.push(
        json!({ "op": "addNode", "node": source, "classType": "VHS_LoadVideo", "when": present,
        "inputs": {
            "video": media("secondarySource", 0),
            "force_rate": konst(json!(24.0)),
            "custom_width": konst(json!(0)),
            "custom_height": konst(json!(0)),
            "frame_load_cap": konst(json!(0)),
            "skip_first_frames": konst(json!(0)),
            "select_every_nth": konst(json!(1)),
        },
        "meta": { "title": "Load Selected Preview For Secondary Sampling" } }),
    );
    steps.push(set_when(
        &b.secondary_resize_node_id,
        "image",
        link(source, 0),
        present.clone(),
    ));
    steps.push(set_when(
        &b.secondary_audio_encode_node_id,
        "audio",
        link(source, 2),
        present.clone(),
    ));
    steps.push(set_when(
        &b.clean_video_node_id,
        "audio",
        link(source, 2),
        present,
    ));
}

// ---------- request conversion ----------
// Test-only since CANVAS-024c: the generic node sends v2 requests itself; the golden test
// still drives the recorded v1 requests through here.

#[cfg(test)]
fn names(media: &Value, key: &str) -> Vec<String> {
    media
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A v1 request (as the old submission commands received it) plus the names its media
/// were uploaded under -> the v2 engine request.
#[cfg(test)]
pub fn convert_request(
    package: &PackageV2,
    operation: &str,
    legacy: &Value,
    uploaded: &Value,
    date: &str,
) -> Result<EngineRequest, String> {
    let declared = package
        .operations
        .get(operation)
        .ok_or_else(|| format!("方案包没有操作 {operation}"))?;
    let mut values = Map::new();
    for control in &declared.controls {
        if let Some(value) = legacy.get(&control.id) {
            values.insert(control.id.clone(), value.clone());
        }
    }
    let seed = match legacy.get("seedMode").and_then(Value::as_str) {
        None | Some("fixed") => legacy
            .get("seed")
            .and_then(Value::as_str)
            .map(|seed| {
                seed.trim()
                    .parse::<u64>()
                    .map_err(|_| format!("固定种子无效：{seed}"))
            })
            .transpose()?
            .unwrap_or(0),
        Some(other) => return Err(format!("转换旧请求需要固定种子，实际为 {other}")),
    };
    let mut media = BTreeMap::new();
    for port in &declared.inputs {
        let list = names(uploaded, &port.id);
        if !list.is_empty() {
            media.insert(port.id.clone(), list);
        }
        // A text port carries the old request's field of the same name (the prompt).
        if port.port_type == PortType::Text {
            if let Some(text) = legacy.get(&port.id).and_then(Value::as_str) {
                media.insert(port.id.clone(), vec![text.to_owned()]);
            }
        }
    }
    if let Some(parameters) = legacy.get("parameters").and_then(Value::as_object) {
        for (key, value) in parameters {
            values.insert(key.clone(), value.clone());
        }
    }
    if package.capability == "image-generation"
        && package.variant == "image-generation"
        && operation == "generate"
    {
        let has_lora_control = declared
            .controls
            .iter()
            .any(|control| control.id == "loraName");
        let lora = legacy
            .get("loraName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !has_lora_control && !lora.is_empty() {
            return Err("这个方案不支持 LoRA，请清空 LoRA 后再生成".to_owned());
        }
        let has_upscale_control = declared
            .controls
            .iter()
            .any(|control| control.id == "upscaleEnabled");
        if !has_upscale_control && legacy.get("upscaleEnabled") == Some(&json!(true)) {
            return Err("这个方案不支持输出放大，请关闭放大后再生成".to_owned());
        }
    }
    if package.capability == "video-generation" {
        values.insert("styleLoras".to_owned(), Value::Array(style_items(legacy)));
        if package.variant == "first-last-frame" {
            let images = names(uploaded, "images");
            let roles = names(uploaded, "roles");
            for (port, role) in [("firstFrame", "first"), ("lastFrame", "last")] {
                let chosen = images.iter().enumerate().find_map(|(index, name)| {
                    let assigned = roles
                        .get(index)
                        .map(String::as_str)
                        .unwrap_or(if index == 0 { "first" } else { "last" });
                    (assigned == role).then(|| name.clone())
                });
                if let Some(name) = chosen {
                    media.insert(port.to_owned(), vec![name]);
                }
            }
        }
    }
    Ok(EngineRequest {
        values,
        media,
        seed,
        date: date.to_owned(),
    })
}

/// The v1 style LoRA list, or the single legacy style LoRA when the list is absent.
#[cfg(test)]
fn style_items(legacy: &Value) -> Vec<Value> {
    if let Some(list) = legacy.get("styleLoras").and_then(Value::as_array) {
        return list
            .iter()
            .map(|slot| {
                let to_secondary = slot.get("applyToSecondary").and_then(Value::as_bool).unwrap_or(false);
                json!({
                    "name": slot.get("name").cloned().unwrap_or(json!("")),
                    "strength": slot.get("strength").cloned().unwrap_or(json!(1.0)),
                    "on": !slot.get("bypassed").and_then(Value::as_bool).unwrap_or(false),
                    "toSecondary": to_secondary,
                    "toSecondPass": slot.get("applyToSecondPass").and_then(Value::as_bool).unwrap_or(to_secondary),
                })
            })
            .collect();
    }
    let name = legacy
        .get("styleLoraName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let bypassed = name.is_empty()
        || legacy
            .get("styleLoraBypassed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let to_secondary = legacy
        .get("styleLoraApplyToSecondary")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    vec![json!({
        "name": name,
        "strength": legacy.get("styleLoraStrength").cloned().unwrap_or(json!(1.0)),
        "on": !bypassed,
        "toSecondary": to_secondary,
        "toSecondPass": to_secondary,
    })]
}
