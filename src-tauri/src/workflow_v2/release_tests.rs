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
            let values: Map<String, Value> =
                serde_json::from_value(request["values"].clone()).unwrap();
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
