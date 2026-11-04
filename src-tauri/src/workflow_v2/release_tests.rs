// CANVAS-024d: the three image packages as version 2 releases (workflow-packages/image-v2),
// the format additions they need (increment, port order, setting), and v2 bundles in the
// workflow module store (restore keeps the module id).
use super::{engine, legacy_v1_convert, runtime, validate, PortType};
use crate::workflow_modules;
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, fs, path::PathBuf};

const IMAGE_MODULES: [&str; 3] = ["0bf9145b", "52cba27b", "5dd20ec7"];

fn testdata() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("workflow_v2")
}

fn release_dir(short: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("workflow-packages")
        .join("image-v2")
        .join(short)
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_slice(&fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap()
}

fn v1_loaded(short: &str) -> runtime::LoadedPackage {
    let dir = testdata().join("v1").join(short);
    runtime::load_from_files(
        &read_json(dir.join("manifest.json")),
        &read_json(dir.join("adapter.json")),
        &read_json(dir.join("ui-schema.json")),
        read_json(dir.join("workflow.json")),
    )
    .unwrap()
}

fn release_loaded(short: &str) -> runtime::LoadedPackage {
    let dir = release_dir(short);
    runtime::load_from_files(
        &read_json(dir.join("manifest.json")),
        &read_json(dir.join("adapter.json")),
        &Value::Null,
        read_json(dir.join("workflow.json")),
    )
    .unwrap_or_else(|e| panic!("{short}: {e}"))
}

fn control<'a>(
    loaded: &'a runtime::LoadedPackage,
    operation: &str,
    id: &str,
) -> &'a super::Control {
    loaded.package.operations[operation]
        .controls
        .iter()
        .find(|control| control.id == id)
        .unwrap_or_else(|| panic!("no control {id}"))
}

fn build(
    loaded: &runtime::LoadedPackage,
    operation: &str,
    values: Value,
    media: BTreeMap<String, Vec<String>>,
) -> Result<engine::Built, String> {
    let values: Map<String, Value> = serde_json::from_value(values).unwrap();
    let request =
        runtime::engine_request(&loaded.package, operation, &values, media, 7, "2026-11-01")?;
    engine::build(&loaded.package, operation, &loaded.workflow, &request)
}

fn prompt(text: &str) -> BTreeMap<String, Vec<String>> {
    BTreeMap::from([("prompt".to_owned(), vec![text.to_owned()])])
}

// ---- section 0: interface-only increment and port display order ----

#[test]
fn width_and_height_step_by_64_in_the_interface_without_a_validation_step() {
    for short in IMAGE_MODULES {
        let loaded = v1_loaded(short);
        for id in ["width", "height"] {
            let size = control(&loaded, "generate", id);
            assert_eq!(size.increment, Some(64.0), "{short} {id}");
            assert_eq!(size.step, None, "{short} {id}: 1000 px must stay valid");
        }
        // Inputs the package requires (the image edit needs an image).
        let mut media = prompt("fox");
        if loaded.package.operations["generate"]
            .inputs
            .iter()
            .any(|p| p.id == "images")
        {
            media.insert("images".to_owned(), vec!["a.png".to_owned()]);
        }
        assert!(build(&loaded, "generate", json!({ "width": 1000 }), media).is_ok());
    }
}

#[test]
fn the_image_edit_node_shows_its_images_before_the_prompt() {
    let edit = v1_loaded("52cba27b");
    let inputs = &edit.package.operations["generate"].inputs;
    let order = |id: &str| {
        let port = inputs.iter().find(|port| port.id == id).unwrap();
        port.order
            .unwrap_or(inputs.iter().position(|p| p.id == id).unwrap() as i32)
    };
    assert!(order("images") < order("prompt"));
    // Checking still reports the prompt first when it is blank (engine order is unchanged).
    let error = build(&edit, "generate", json!({}), prompt(" ")).unwrap_err();
    assert!(error.contains("不能为空"), "{error}");
}

#[test]
fn the_settings_model_reaches_the_control_through_its_declared_setting() {
    for short in IMAGE_MODULES {
        let loaded = v1_loaded(short);
        assert_eq!(
            control(&loaded, "generate", "modelName").setting,
            "diffusionModelName",
            "{short}"
        );
    }
}

// ---- section 1: the release packages ----

#[test]
fn release_packages_keep_their_module_ids_and_load_as_version_2() {
    for short in IMAGE_MODULES {
        let dir = release_dir(short);
        let manifest = read_json(dir.join("manifest.json"));
        let production = read_json(testdata().join("v1").join(short).join("manifest.json"));
        assert_eq!(manifest["id"], production["id"], "{short}");
        assert_eq!(
            read_json(dir.join("adapter.json"))["engineApiVersion"],
            json!(2)
        );
        let loaded = release_loaded(short);
        let report = validate::validate_package(&loaded.package, &loaded.workflow, None);
        assert!(report.errors.is_empty(), "{short}: {:?}", report.errors);
    }
}

#[test]
fn release_packages_name_the_krea2_directory_for_their_defaults() {
    for short in ["0bf9145b", "52cba27b"] {
        let loaded = release_loaded(short);
        let model = control(&loaded, "generate", "modelName");
        let default = model.default.as_ref().and_then(Value::as_str).unwrap();
        assert!(default.starts_with("Krea2\\"), "{short}: {default}");
        assert!(model
            .preset
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|preset| preset.starts_with("Krea2\\")));
        let text = fs::read_to_string(release_dir(short).join("workflow.json")).unwrap()
            + &fs::read_to_string(release_dir(short).join("manifest.json")).unwrap();
        assert!(
            !text.contains("Kera2\\\\"),
            "{short}: Kera2 left in workflow/manifest"
        );
    }
}

fn differences(
    path: &str,
    expected: &Value,
    actual: &Value,
    out: &mut Vec<(String, Value, Value)>,
) {
    if expected == actual {
        return;
    }
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys = a.keys().chain(b.keys()).collect::<Vec<_>>();
            keys.sort();
            keys.dedup();
            for key in keys {
                differences(
                    &format!("{path}/{key}"),
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        _ => out.push((path.to_owned(), expected.clone(), actual.clone())),
    }
}

fn uploaded_names(inputs: &Value) -> BTreeMap<String, Vec<String>> {
    let mut media = BTreeMap::new();
    for (port, items) in inputs.as_object().into_iter().flatten() {
        let names = items
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    text.to_owned()
                } else if let Some(path) = item.get("path").and_then(Value::as_str) {
                    path.rsplit(['/', '\\']).next().unwrap().to_owned()
                } else {
                    item["output"]["filename"].as_str().unwrap().to_owned()
                }
            })
            .collect();
        media.insert(port.clone(), names);
    }
    media
}

/// CANVAS-029: where the package has a LoRA group instead of the single LoRA control, a request
/// written for the single control carries its LoRA as item 1 (what an old node converts to,
/// src/workflow/legacyImageNode.ts).
fn single_lora_as_first_item(loaded: &runtime::LoadedPackage, values: &mut Map<String, Value>) {
    let has = |id: &str| {
        loaded
            .package
            .operations
            .values()
            .any(|operation| operation.controls.iter().any(|control| control.id == id))
    };
    if has("loraName") || !has("loras") {
        return;
    }
    if let Some(Value::String(name)) = values.remove("loraName") {
        if !name.trim().is_empty() {
            values.insert("loras".to_owned(), json!([{ "name": name }]));
        }
    }
}

/// Release package vs the converted v1 package, same generic requests (the 12 image golden
/// cases): identical except where a default model now names the Krea2 directory.
#[test]
fn release_packages_submit_what_the_converted_v1_packages_submit_except_the_renamed_defaults() {
    let fixture = read_json(testdata().join("generic-requests.json"));
    let mut found = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let short = case["module"].as_str().unwrap();
        let request = &case["request"];
        let operation = request["operation"].as_str().unwrap();
        let seed: u64 = request["seed"].as_str().unwrap().parse().unwrap_or(0);
        let run = |loaded: &runtime::LoadedPackage| {
            let mut values: Map<String, Value> =
                serde_json::from_value(request["values"].clone()).unwrap();
            single_lora_as_first_item(loaded, &mut values);
            let engine_request = runtime::engine_request(
                &loaded.package,
                operation,
                &values,
                uploaded_names(&request["inputs"]),
                seed,
                "2026-11-01",
            )
            .unwrap();
            engine::build(
                &loaded.package,
                operation,
                &loaded.workflow,
                &engine_request,
            )
            .unwrap()
            .workflow
        };
        let old = run(&v1_loaded(short));
        let new = run(&release_loaded(short));
        let mut diff = Vec::new();
        differences("", &old, &new, &mut diff);
        for (path, before, after) in diff {
            assert_eq!(
                after,
                json!(before
                    .as_str()
                    .unwrap_or_default()
                    .replacen("Kera2\\", "Krea2\\", 1)),
                "{name} {path}: only the Kera2 -> Krea2 default may differ"
            );
            found.push(format!("{name} {path}"));
        }
    }
    assert_eq!(
        found,
        vec![
            "krea2-plain /98/inputs/unet_name",
            "krea2-upscale-only /98/inputs/unet_name",
            "krea2-toolbar-upscale /98/inputs/unet_name",
            "edit-single /18/inputs/unet_name",
            "edit-single /43/inputs/unet_name",
        ]
    );
}

#[test]
fn moss_offers_six_lora_slots_weighted_0_to_2_that_act_on_the_model_only() {
    let moss = release_loaded("5dd20ec7");
    let loras = control(&moss, "generate", "loras");
    assert_eq!(loras.max, Some(6.0));
    let weight = loras.fields.iter().find(|f| f.id == "weight").unwrap();
    assert_eq!((weight.min, weight.max), (Some(0.0), Some(2.0)));
    let name = loras.fields.iter().find(|f| f.id == "name").unwrap();
    let files = name.options.as_ref().unwrap().comfyui.as_ref().unwrap();
    assert_eq!(files.class_type, "LoraLoaderModelOnly");
    for slot in ["9701", "9702", "9703", "9704", "9705", "9706"] {
        assert_eq!(
            moss.workflow[slot]["class_type"],
            json!("LoraLoaderModelOnly"),
            "{slot}"
        );
    }
    // No LoRA: identical to the package without slots (checked byte for byte above too).
    let none = build(&moss, "generate", json!({}), prompt("fox"))
        .unwrap()
        .workflow;
    assert_eq!(none["38"]["inputs"]["model"], json!(["28", 0]));
    assert!(none.get("9701").is_none());
    // One LoRA.
    let one = build(
        &moss,
        "generate",
        json!({ "loras": [{ "name": "moss\\a.safetensors", "weight": 0.8 }] }),
        prompt("fox"),
    )
    .unwrap()
    .workflow;
    assert_eq!(
        one["9701"]["inputs"],
        json!({ "model": ["28", 0], "lora_name": "moss\\a.safetensors", "strength_model": 0.8 })
    );
    assert_eq!(one["38"]["inputs"]["model"], json!(["9701", 0]));
    assert!(one.get("9702").is_none());
    // Three with the middle one switched off: it is skipped, the others chain.
    let three = build(
        &moss,
        "generate",
        json!({ "loras": [
        { "name": "moss\\a.safetensors", "weight": 1.0 },
        { "name": "moss\\b.safetensors", "weight": 0.5, "on": false },
        { "name": "moss\\c.safetensors", "weight": 1.5 }
    ] }),
        prompt("fox"),
    )
    .unwrap()
    .workflow;
    assert_eq!(three["9701"]["inputs"]["model"], json!(["28", 0]));
    assert_eq!(
        three["9703"]["inputs"],
        json!({ "model": ["9701", 0], "lora_name": "moss\\c.safetensors", "strength_model": 1.5 })
    );
    assert_eq!(three["38"]["inputs"]["model"], json!(["9703", 0]));
    assert!(
        three.get("9702").is_none(),
        "the switched-off slot is not submitted"
    );
    // Out of range or too many are refused.
    assert!(build(
        &moss,
        "generate",
        json!({ "loras": [{ "name": "moss\\a.safetensors", "weight": 2.5 }] }),
        prompt("fox")
    )
    .is_err());
    let seven = (0..7)
        .map(|_| json!({ "name": "moss\\a.safetensors" }))
        .collect::<Vec<_>>();
    assert!(build(&moss, "generate", json!({ "loras": seven }), prompt("fox")).is_err());
    assert!(build(
        &moss,
        "generate",
        json!({ "loras": [{ "name": "elsewhere\\a.safetensors" }] }),
        prompt("fox")
    )
    .is_err());
}

#[test]
fn import_check_reports_the_krea2_default_missing_while_the_directory_is_still_kera2() {
    let loaded = release_loaded("0bf9145b");
    // ComfyUI before the rename: the models are under Kera2 only.
    let object_info = json!({
        "UNETLoader": { "input": { "required": { "unet_name": [["Kera2\\pornmasterKrea2_v2TurboBF16.safetensors"]] } } },
        "LoraLoaderModelOnly": { "input": { "required": { "lora_name": [["Krea2\\PornMaster_Krea2_Realism_slider_V1.safetensors"]] } } }
    });
    let report = validate::validate_package(&loaded.package, &loaded.workflow, Some(&object_info));
    // Reported once, though both operations (generate, upscaleImage) declare that default.
    assert_eq!(
        report
            .errors
            .iter()
            .filter(|e| *e == "ComfyUI 中找不到 modelName 的默认值 Krea2\\pornmasterKrea2_v2TurboBF16.safetensors")
            .count(),
        1,
        "{:?}",
        report.errors
    );
    // A directory list is fine when at least one of its directories has files.
    assert!(
        !report
            .errors
            .iter()
            .any(|e| e.contains("目录里没有可用文件（modelName）")),
        "{:?}",
        report.errors
    );
}

// ---- v2 bundles in the workflow module store ----

fn module_root() -> PathBuf {
    std::env::temp_dir().join(format!("c024d-modules-{}", uuid::Uuid::new_v4()))
}

#[test]
fn restoring_a_v2_bundle_over_a_v1_module_keeps_its_id_and_its_package() {
    let root = module_root();
    fs::create_dir_all(&root).unwrap();
    let v1 =
        workflow_modules::import_bundle(&root, &testdata().join("v1").join("5dd20ec7")).unwrap();
    let id = v1.manifest.id.clone();
    let restored = workflow_modules::restore_bundle(&root, &id, &release_dir("5dd20ec7")).unwrap();
    assert_eq!(restored.manifest.id, id);
    assert_eq!(
        restored.adapter.adapter_id,
        workflow_modules::PACKAGE_V2_ADAPTER
    );
    assert_eq!(
        read_json(PathBuf::from(&restored.adapter_path)),
        read_json(release_dir("5dd20ec7").join("adapter.json")),
        "the v2 package is stored as written"
    );
    assert_eq!(
        restored.backup_count, 1,
        "the v1 package is kept as a restore point"
    );
    let listed = workflow_modules::list(&root, false).unwrap();
    assert_eq!(listed.len(), 1);
    // The settings page changes only the module settings; the v2 package stays.
    let mut defaults = restored.manifest.defaults.clone();
    defaults.diffusion_model_name = "Moss\\other.safetensors".to_owned();
    let updated = workflow_modules::update_defaults(&root, &id, defaults).unwrap();
    assert_eq!(
        updated.manifest.defaults.diffusion_model_name,
        "Moss\\other.safetensors"
    );
    assert_eq!(
        read_json(PathBuf::from(&updated.adapter_path)),
        read_json(release_dir("5dd20ec7").join("adapter.json"))
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn a_v2_bundle_whose_steps_name_a_missing_node_is_refused() {
    let root = module_root();
    let bundle = root.join("broken");
    fs::create_dir_all(&bundle).unwrap();
    for file in ["manifest.json", "workflow.json"] {
        fs::copy(release_dir("5dd20ec7").join(file), bundle.join(file)).unwrap();
    }
    let mut adapter = read_json(release_dir("5dd20ec7").join("adapter.json"));
    adapter["operations"]["generate"]["steps"][0]["node"] = json!("99999");
    fs::write(
        bundle.join("adapter.json"),
        serde_json::to_vec(&adapter).unwrap(),
    )
    .unwrap();
    let error = workflow_modules::import_bundle(&root, &bundle).unwrap_err();
    assert!(error.contains("节点 99999 不存在"), "{error}");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn text_ports_keep_their_type_after_the_release() {
    for short in IMAGE_MODULES {
        let loaded = release_loaded(short);
        let port = loaded.package.operations["generate"]
            .inputs
            .iter()
            .find(|p| p.id == "prompt")
            .unwrap();
        assert_eq!(port.port_type, PortType::Text);
    }
    // The converter is still what produces the v1 view of these modules.
    let _ = legacy_v1_convert::convert_package;
}

// ---- CANVAS-029: the Krea2 packages get Moss's LoRA group ----

fn submitted(
    loaded: &runtime::LoadedPackage,
    values: Value,
    media: BTreeMap<String, Vec<String>>,
) -> String {
    serde_json::to_string(&build(loaded, "generate", values, media).unwrap().workflow).unwrap()
}

fn assert_moss_lora_group(short: &str) {
    let loaded = release_loaded(short);
    let ids = loaded.package.operations["generate"]
        .controls
        .iter()
        .map(|control| control.id.as_str())
        .collect::<Vec<_>>();
    let at = ids.iter().position(|id| *id == "loras").expect("loras");
    assert_eq!(ids[at - 1], "modelName", "{short}: {ids:?}");
    assert!(!ids.contains(&"loraName"), "{short}: {ids:?}");
    let mut expected =
        serde_json::to_value(control(&release_loaded("5dd20ec7"), "generate", "loras")).unwrap();
    expected["fields"][0]["options"]["comfyui"]["dirs"] = json!(["Krea2"]);
    assert_eq!(
        serde_json::to_value(control(&loaded, "generate", "loras")).unwrap(),
        expected,
        "{short}"
    );
}

#[test]
fn krea2_text_to_image_offers_the_moss_lora_group_in_the_krea2_directory() {
    assert_moss_lora_group("0bf9145b");
}

/// No LoRA, or the old single LoRA as item 1 (weight 1, on): byte for byte what the package
/// submitted before (the converted v1 package, which the release reproduces; model given so the
/// renamed default plays no part).
#[test]
fn krea2_text_to_image_without_or_with_one_lora_submits_what_it_did_before() {
    let before = v1_loaded("0bf9145b");
    let now = release_loaded("0bf9145b");
    let model = "Krea2\\base.safetensors";
    let lora = "Krea2\\PornMaster_Krea2_Realism_slider_V1.safetensors";
    let old = |name: &str| {
        submitted(
            &before,
            json!({ "modelName": model, "loraName": name }),
            prompt("fox"),
        )
    };
    for values in [
        json!({ "modelName": model }),
        json!({ "modelName": model, "loras": [] }),
    ] {
        assert_eq!(submitted(&now, values, prompt("fox")), old(""));
    }
    for item in [
        json!({ "name": lora }),
        json!({ "name": lora, "weight": 1, "on": true }),
        json!({ "name": lora, "weight": 1.0 }),
    ] {
        assert_eq!(
            submitted(
                &now,
                json!({ "modelName": model, "loras": [item] }),
                prompt("fox")
            ),
            old(lora),
            "{item}"
        );
    }
}

#[test]
fn krea2_text_to_image_writes_each_item_into_node_159_by_position() {
    let now = release_loaded("0bf9145b");
    let run = |items: Value| build(&now, "generate", json!({ "loras": items }), prompt("fox"));
    let node = |items: Value| run(items).unwrap().workflow["159"]["inputs"].clone();
    let three = node(json!([
        { "name": "Krea2\\a.safetensors", "weight": 0.8 },
        { "name": "Krea2\\b.safetensors", "weight": 0.5, "on": false },
        { "name": "Krea2\\c.safetensors", "weight": 1.5 }
    ]));
    assert_eq!(
        three["lora_1"],
        json!({ "lora": "Krea2\\a.safetensors", "on": true, "strength": 0.8 })
    );
    assert_eq!(
        three["lora_2"],
        json!({ "lora": "Krea2\\b.safetensors", "on": false, "strength": 0.5 })
    );
    assert_eq!(
        three["lora_3"],
        json!({ "lora": "Krea2\\c.safetensors", "on": true, "strength": 1.5 })
    );
    assert!(three.get("lora_4").is_none());
    // The node's other inputs stay as the workflow has them.
    let original = &now.workflow["159"]["inputs"];
    for input in [
        "PowerLoraLoaderHeaderWidget",
        "➕ Add Lora",
        "model",
        "clip",
    ] {
        assert_eq!(three[input], original[input], "{input}");
    }
    let six = node(Value::Array(
        (1..=6)
            .map(|n| json!({ "name": format!("Krea2\\l{n}.safetensors"), "weight": 2.0 }))
            .collect(),
    ));
    for n in 1..=6 {
        assert_eq!(
            six[format!("lora_{n}")],
            json!({ "lora": format!("Krea2\\l{n}.safetensors"), "on": true, "strength": 2.0 })
        );
    }
    // An item without a file is not written; the workflow's own lora_1 stays when item 1 is empty.
    let gap = node(json!([{ "name": "" }, { "name": " " }, { "name": "Krea2\\c.safetensors" }]));
    assert_eq!(gap["lora_1"], original["lora_1"]);
    assert!(gap.get("lora_2").is_none());
    assert_eq!(gap["lora_3"]["lora"], json!("Krea2\\c.safetensors"));
    // Refused: 7 items, weight out of range or off the 0.05 step, a file outside Krea2.
    let seven = Value::Array(
        (0..7)
            .map(|_| json!({ "name": "Krea2\\a.safetensors" }))
            .collect(),
    );
    assert!(run(seven).is_err());
    assert!(run(json!([{ "name": "Krea2\\a.safetensors", "weight": 2.5 }])).is_err());
    assert!(run(json!([{ "name": "Krea2\\a.safetensors", "weight": 0.33 }])).is_err());
    assert!(run(json!([{ "name": "moss\\a.safetensors" }])).is_err());
}

#[test]
fn krea2_image_edit_offers_the_moss_lora_group_in_the_krea2_directory() {
    assert_moss_lora_group("52cba27b");
}

fn edit_media(images: usize) -> BTreeMap<String, Vec<String>> {
    let mut media = prompt("swap the hat");
    media.insert(
        "images".to_owned(),
        ["a.png", "b.png"][..images]
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
    );
    media
}

/// No item, or none switched on with a file: byte for byte what the edit package submitted
/// before, on both branches (the converted v1 package; model given, see above).
#[test]
fn krea2_image_edit_without_an_active_lora_submits_what_it_did_before() {
    let before = v1_loaded("52cba27b");
    let now = release_loaded("52cba27b");
    let model = "Krea2\\edit.safetensors";
    for images in [1, 2] {
        let old = submitted(&before, json!({ "modelName": model }), edit_media(images));
        for loras in [
            json!(null),
            json!([]),
            json!([{ "name": "Krea2\\a.safetensors", "on": false }, { "name": "" }]),
        ] {
            let mut values = json!({ "modelName": model });
            if !loras.is_null() {
                values["loras"] = loras.clone();
            }
            assert_eq!(
                submitted(&now, values, edit_media(images)),
                old,
                "{images} images, {loras}"
            );
        }
    }
}

/// User LoRAs sit between the edit LoRA (42 / 17, unchanged) and the model patch (35 / 5), one
/// model-only loader per item that is on and has a file, on the branch the images select.
#[test]
fn krea2_image_edit_chains_active_loras_between_the_edit_lora_and_the_model_patch() {
    let before = v1_loaded("52cba27b");
    let now = release_loaded("52cba27b");
    let model = "Krea2\\edit.safetensors";
    let three = json!([
        { "name": "Krea2\\a.safetensors", "weight": 0.8 },
        { "name": "Krea2\\b.safetensors", "weight": 0.5, "on": false },
        { "name": "Krea2\\c.safetensors", "weight": 1.5 }
    ]);
    // (images, its edit LoRA, its model patch, the other branch's model patch and edit LoRA)
    for (images, edit, patch, other_patch, other_edit) in
        [(1, "42", "35", "5", "17"), (2, "17", "5", "35", "42")]
    {
        let old = build(
            &before,
            "generate",
            json!({ "modelName": model }),
            edit_media(images),
        )
        .unwrap()
        .workflow;
        let new = |loras: Value| {
            build(
                &now,
                "generate",
                json!({ "modelName": model, "loras": loras }),
                edit_media(images),
            )
            .unwrap()
            .workflow
        };
        let added = |workflow: &Value| {
            workflow
                .as_object()
                .unwrap()
                .keys()
                .filter(|id| old.get(id.as_str()).is_none())
                .cloned()
                .collect::<Vec<_>>()
        };
        let one = new(json!([{ "name": "Krea2\\a.safetensors" }]));
        let slot = added(&one);
        assert_eq!(slot.len(), 1, "{images} images: {slot:?}");
        let slot = &slot[0];
        assert_eq!(one[slot]["class_type"], json!("LoraLoaderModelOnly"));
        assert_eq!(
            one[slot]["inputs"],
            json!({ "model": [edit, 0], "lora_name": "Krea2\\a.safetensors", "strength_model": 1.0 })
        );
        assert_eq!(one[patch]["inputs"]["model"], json!([slot, 0]));
        // Nothing else changes: the edit LoRA, the other branch, every other node.
        let mut diff = Vec::new();
        differences("", &old, &one, &mut diff);
        let paths = diff
            .iter()
            .map(|(path, _, _)| path.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![format!("/{patch}/inputs/model"), format!("/{slot}")],
            "{images} images"
        );
        assert_eq!(one[edit], old[edit]);
        assert_eq!(one[other_patch]["inputs"]["model"], json!([other_edit, 0]));

        let chained = new(three.clone());
        let slots = added(&chained);
        assert_eq!(
            slots.len(),
            2,
            "{images} images: the switched-off item adds no node: {slots:?}"
        );
        let (first, second) = if chained[&slots[0]]["inputs"]["model"] == json!([edit, 0]) {
            (&slots[0], &slots[1])
        } else {
            (&slots[1], &slots[0])
        };
        assert_eq!(
            chained[first]["inputs"],
            json!({ "model": [edit, 0], "lora_name": "Krea2\\a.safetensors", "strength_model": 0.8 })
        );
        assert_eq!(
            chained[second]["inputs"],
            json!({ "model": [first, 0], "lora_name": "Krea2\\c.safetensors", "strength_model": 1.5 })
        );
        assert_eq!(chained[patch]["inputs"]["model"], json!([second, 0]));
        assert_eq!(
            chained[other_patch]["inputs"]["model"],
            json!([other_edit, 0])
        );

        let six = new(Value::Array(
            (1..=6)
                .map(|n| json!({ "name": format!("Krea2\\l{n}.safetensors"), "weight": 2.0 }))
                .collect(),
        ));
        assert_eq!(added(&six).len(), 6, "{images} images");
    }
    let run = |loras: Value| build(&now, "generate", json!({ "loras": loras }), edit_media(1));
    let seven = Value::Array(
        (0..7)
            .map(|_| json!({ "name": "Krea2\\a.safetensors" }))
            .collect(),
    );
    assert!(run(seven).is_err());
    assert!(run(json!([{ "name": "Krea2\\a.safetensors", "weight": 2.5 }])).is_err());
    assert!(run(json!([{ "name": "moss\\a.safetensors" }])).is_err());
}

// ---- CANVAS-031a: Qwen Image 2.1 image edit, up to 8 images, each optionally scaled ----

const QWEN_EDIT: &str = "5a9e19a3";
/// Image n's LoadImage and ImageScaleToMaxDimension nodes in the package's workflow.
fn qwen_load(n: usize) -> String {
    format!("96{:02}", n)
}
fn qwen_scale(n: usize) -> String {
    format!("96{:02}", 10 + n)
}

fn qwen_media(images: usize) -> BTreeMap<String, Vec<String>> {
    let mut media = prompt("  让图 1 人物做出图 2 的姿势。  ");
    media.insert(
        "images".to_owned(),
        (1..=images).map(|n| format!("img{n}.png")).collect(),
    );
    media
}

fn qwen_prompt(values: Value, images: usize) -> Value {
    build(
        &release_loaded(QWEN_EDIT),
        "generate",
        values,
        qwen_media(images),
    )
    .unwrap_or_else(|e| panic!("{images} images: {e}"))
    .workflow
}

/// The encoder's image inputs: `images.image_n` -> the link it carries.
fn qwen_images(prompt: &Value) -> BTreeMap<String, Value> {
    prompt["493"]["inputs"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(name, _)| name.starts_with("images."))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn qwen_classes(prompt: &Value, class_type: &str) -> Vec<String> {
    prompt
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, node)| node["class_type"] == class_type)
        .map(|(id, _)| id.clone())
        .collect()
}

#[test]
fn qwen_edit_is_a_new_module_with_eight_images_and_its_controls() {
    let dir = release_dir(QWEN_EDIT);
    let manifest = read_json(dir.join("manifest.json"));
    assert_eq!(
        manifest["id"],
        json!("workflow-module-5a9e19a3-c5cb-43fe-a76f-641e2a5c6e33")
    );
    assert_eq!(manifest["name"], json!("Qwen Image 2.1 图像编辑"));
    assert_eq!(manifest["revision"], json!("v1"));
    assert_eq!(manifest["engineApiVersion"], json!("2"));
    let loaded = release_loaded(QWEN_EDIT);
    let report = validate::validate_package(&loaded.package, &loaded.workflow, None);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let generate = &loaded.package.operations["generate"];
    let port = |id: &str| generate.inputs.iter().find(|p| p.id == id).unwrap();
    assert_eq!(
        (
            port("images").port_type,
            port("images").min,
            port("images").max,
            port("images").order
        ),
        (PortType::Image, 1, 8, Some(1))
    );
    assert_eq!(
        (port("prompt").port_type, port("prompt").order),
        (PortType::Text, Some(2))
    );
    let mut expected = vec![
        "modelName",
        "negativePrompt",
        "customSize",
        "width",
        "height",
        "steps",
        "seed",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    for n in 1..=8 {
        expected.push(format!("scale{n}"));
        expected.push(format!("maxSize{n}"));
    }
    let ids = generate
        .controls
        .iter()
        .map(|c| c.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(ids, expected);
    let model = control(&loaded, "generate", "modelName");
    assert_eq!(
        model.default,
        Some(json!("Qwen2.1\\qwen_image_2.1_int8_convrot.safetensors"))
    );
    let files = model.options.as_ref().unwrap().comfyui.as_ref().unwrap();
    assert_eq!(
        (
            files.class_type.as_str(),
            files.input.as_str(),
            files.dirs.clone()
        ),
        ("UNETLoader", "unet_name", vec!["Qwen2.1".to_owned()])
    );
    assert_eq!(
        control(&loaded, "generate", "steps").default,
        Some(json!(40))
    );
    assert_eq!(
        control(&loaded, "generate", "customSize").default,
        Some(json!(false))
    );
    for id in ["width", "height"] {
        assert_eq!(
            serde_json::to_value(&control(&loaded, "generate", id).visible_when).unwrap(),
            json!({ "truthy": { "control": "customSize" } }),
            "{id}"
        );
    }
    for n in 1..=8 {
        let scale = control(&loaded, "generate", &format!("scale{n}"));
        assert_eq!(scale.default, Some(json!(false)), "scale{n}");
        let shown = json!({ "mediaAtLeast": { "port": "images", "count": n } });
        assert_eq!(serde_json::to_value(&scale.visible_when).unwrap(), shown);
        let size = control(&loaded, "generate", &format!("maxSize{n}"));
        assert_eq!(size.default, Some(json!(1536)), "maxSize{n}");
        assert_eq!(
            serde_json::to_value(&size.visible_when).unwrap(),
            json!({ "all": [shown, { "truthy": { "control": format!("scale{n}") } }] })
        );
    }
}

/// 1, 2 and 8 images with every scale switch off (the default): the encoder gets exactly
/// image_1..image_n, each straight from its LoadImage; no scale node, no unused loader.
#[test]
fn qwen_edit_wires_only_the_connected_images_straight_from_their_loaders() {
    for images in [1, 2, 8] {
        let prompt = qwen_prompt(json!({}), images);
        let expected = (1..=images)
            .map(|n| (format!("images.image_{n}"), json!([qwen_load(n), 0])))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(qwen_images(&prompt), expected, "{images} images");
        for n in 1..=8 {
            let load = &prompt[qwen_load(n)];
            if n <= images {
                assert_eq!(load["class_type"], json!("LoadImage"));
                assert_eq!(load["inputs"]["image"], json!(format!("img{n}.png")));
            } else {
                assert!(load.is_null(), "{images} images: loader {n} left");
            }
        }
        assert!(qwen_classes(&prompt, "ImageScaleToMaxDimension").is_empty());
        assert_eq!(qwen_classes(&prompt, "LoadImage").len(), images);
        assert_eq!(prompt["491"]["inputs"]["switch"], json!(false));
        assert_eq!(prompt["491"]["inputs"]["on_false"], json!(["493", 2]));
        assert_eq!(prompt["491"]["inputs"]["on_true"], json!(["488", 0]));
        assert_eq!(prompt["490"]["inputs"]["latent_image"], json!(["491", 0]));
        assert!(prompt["13"].is_null() && prompt["494"].is_null());
    }
}

#[test]
fn qwen_edit_scales_an_image_through_its_own_node_when_its_switch_is_on() {
    // Two images, image 2 scaled to 768.
    let prompt = qwen_prompt(json!({ "scale2": true, "maxSize2": 768 }), 2);
    assert_eq!(
        qwen_images(&prompt),
        BTreeMap::from([
            ("images.image_1".to_owned(), json!([qwen_load(1), 0])),
            ("images.image_2".to_owned(), json!([qwen_scale(2), 0])),
        ])
    );
    assert_eq!(
        qwen_classes(&prompt, "ImageScaleToMaxDimension"),
        vec![qwen_scale(2)]
    );
    let scale = &prompt[qwen_scale(2)]["inputs"];
    assert_eq!(scale["image"], json!([qwen_load(2), 0]));
    assert_eq!(scale["largest_size"], json!(768));
    assert_eq!(scale["upscale_method"], json!("lanczos"));
    // Eight images, 1 / 4 / 8 scaled (4 with its own size, the others at the default 1536).
    let prompt = qwen_prompt(
        json!({ "scale1": true, "scale4": true, "maxSize4": 2048, "scale8": true }),
        8,
    );
    let wired = qwen_images(&prompt);
    for n in 1..=8 {
        let scaled = [1, 4, 8].contains(&n);
        let source = if scaled { qwen_scale(n) } else { qwen_load(n) };
        assert_eq!(
            wired[&format!("images.image_{n}")],
            json!([source, 0]),
            "image {n}"
        );
        if scaled {
            assert_eq!(
                prompt[qwen_scale(n)]["inputs"]["image"],
                json!([qwen_load(n), 0])
            );
            let size = if n == 4 { 2048 } else { 1536 };
            assert_eq!(prompt[qwen_scale(n)]["inputs"]["largest_size"], json!(size));
        } else {
            assert!(prompt[qwen_scale(n)].is_null(), "scale node {n} left");
        }
    }
}

#[test]
fn qwen_edit_ignores_the_scale_switch_of_an_image_that_is_not_connected() {
    assert_eq!(
        qwen_prompt(json!({ "scale5": true, "maxSize5": 512 }), 2),
        qwen_prompt(json!({}), 2)
    );
}

#[test]
fn qwen_edit_custom_size_switches_the_latent_to_the_empty_latent_of_that_size() {
    let follow = qwen_prompt(json!({ "width": 832, "height": 1216 }), 2);
    assert_eq!(follow["491"]["inputs"]["switch"], json!(false));
    let custom = qwen_prompt(
        json!({ "customSize": true, "width": 832, "height": 1216 }),
        2,
    );
    assert_eq!(custom["491"]["inputs"]["switch"], json!(true));
    assert_eq!(custom["488"]["inputs"]["width"], json!(832));
    assert_eq!(custom["488"]["inputs"]["height"], json!(1216));
    assert_eq!(custom["488"]["inputs"]["batch_size"], json!(1));
    let default_size = qwen_prompt(json!({ "customSize": true }), 1);
    assert_eq!(default_size["488"]["inputs"]["width"], json!(1024));
    assert_eq!(default_size["488"]["inputs"]["height"], json!(1024));
}

/// Model, prompts, steps, seed and output; everything else keeps the source workflow's value.
#[test]
fn qwen_edit_writes_model_prompts_steps_seed_and_keeps_the_rest_of_the_workflow() {
    let prompt = qwen_prompt(json!({}), 1);
    assert_eq!(
        prompt["485"]["inputs"]["unet_name"],
        json!("Qwen2.1\\qwen_image_2.1_int8_convrot.safetensors")
    );
    let encoder = &prompt["493"]["inputs"];
    assert_eq!(encoder["prompt"], json!("让图 1 人物做出图 2 的姿势。"));
    assert_eq!(encoder["negative_prompt"], json!(""));
    assert_eq!(encoder["resolution"], json!(1024));
    let sampler = &prompt["490"]["inputs"];
    assert_eq!(
        (
            &sampler["steps"],
            &sampler["seed"],
            &sampler["cfg"],
            &sampler["sampler_name"],
            &sampler["scheduler"]
        ),
        (
            &json!(40),
            &json!(7),
            &json!(1),
            &json!("euler"),
            &json!("simple")
        )
    );
    assert_eq!(prompt["503"]["inputs"]["attention"], json!("kitchen_int8"));
    assert_eq!(prompt["503"]["inputs"]["step_cache"], json!("te_predictor"));
    assert_eq!(prompt["484"]["class_type"], json!("Image Save"));
    assert_eq!(prompt["484"]["inputs"]["images"], json!(["489", 0]));
    assert_eq!(
        prompt["484"]["inputs"]["output_path"],
        json!("[time(%Y-%m-%d)]")
    );
    assert_eq!(
        prompt["484"]["inputs"]["filename_prefix"],
        json!("ComfyUI_qwen21_image_edit")
    );
    let chosen = qwen_prompt(
        json!({
            "modelName": "Qwen2.1\\qwen_image_2.1_bf16.safetensors",
            "negativePrompt": "  blurry ",
            "steps": 30
        }),
        1,
    );
    assert_eq!(
        chosen["485"]["inputs"]["unet_name"],
        json!("Qwen2.1\\qwen_image_2.1_bf16.safetensors")
    );
    assert_eq!(chosen["493"]["inputs"]["negative_prompt"], json!("blurry"));
    assert_eq!(chosen["490"]["inputs"]["steps"], json!(30));
    // Nothing but the controls' inputs and the image wiring differs from the source workflow.
    let source = read_json(release_dir(QWEN_EDIT).join("workflow.json"));
    for id in ["486", "487", "489", "492", "502", "503"] {
        assert_eq!(prompt[id], source[id], "node {id}");
    }
}

/// Through the module store's own import (what the settings page does), not only the package loader:
/// the store also reads the manifest's module settings.
#[test]
fn qwen_edit_imports_through_the_module_store_as_a_v2_package() {
    let root = module_root();
    fs::create_dir_all(&root).unwrap();
    let imported = workflow_modules::import_bundle(&root, &release_dir(QWEN_EDIT)).unwrap();
    assert_eq!(
        imported.adapter.adapter_id,
        workflow_modules::PACKAGE_V2_ADAPTER
    );
    assert_eq!(imported.manifest.revision, "v1");
    assert_eq!(
        imported.manifest.defaults.diffusion_model_name,
        "Qwen2.1\\qwen_image_2.1_int8_convrot.safetensors"
    );
    assert_eq!(
        read_json(PathBuf::from(&imported.adapter_path)),
        read_json(release_dir(QWEN_EDIT).join("adapter.json"))
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn qwen_edit_refuses_no_image_nine_images_and_sizes_out_of_range() {
    let loaded = release_loaded(QWEN_EDIT);
    assert!(build(&loaded, "generate", json!({}), qwen_media(0)).is_err());
    assert!(build(&loaded, "generate", json!({}), qwen_media(9)).is_err());
    assert!(build(
        &loaded,
        "generate",
        json!({ "maxSize1": 100 }),
        qwen_media(1)
    )
    .is_err());
    assert!(build(&loaded, "generate", json!({ "width": 8192 }), qwen_media(1)).is_err());
}
