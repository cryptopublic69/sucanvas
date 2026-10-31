// CANVAS-024b: tests for the workflow package v2 engine, its import validation and the
// transitional v1 -> v2 converter. The golden file was produced by the unmodified c588f8d
// server against a recording ComfyUI stand-in (see testdata/workflow_v2/goldens.json).
use super::{engine, legacy_v1_convert, validate, EngineRequest, PackageV2, ENGINE_API_VERSION};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn testdata() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("workflow_v2")
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_slice(&fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap()
}

fn v1_files(short: &str) -> (Value, Value, Value, Value) {
    let dir = testdata().join("v1").join(short);
    (
        read_json(dir.join("manifest.json")),
        read_json(dir.join("adapter.json")),
        read_json(dir.join("ui-schema.json")),
        read_json(dir.join("workflow.json")),
    )
}

fn v2_package(short: &str) -> PackageV2 {
    serde_json::from_value(read_json(testdata().join("v2").join(short).join("adapter.json"))).unwrap()
}

fn shorts() -> Vec<String> {
    let mut names = fs::read_dir(testdata().join("v1"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    names
}

/// First differing paths between two JSON values (for readable failures).
fn differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    if out.len() >= 12 || expected == actual {
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
        _ => out.push(format!("{path}: expected {expected} got {actual}")),
    }
}

#[test]
fn every_golden_submission_is_reproduced_field_by_field() {
    let goldens = read_json(testdata().join("goldens.json"));
    let cases = goldens["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 55);
    let mut failures = Vec::new();
    for case in cases {
        let name = case["case"].as_str().unwrap();
        let short = case["module"].as_str().unwrap();
        let operation = case["operation"].as_str().unwrap();
        let package = v2_package(short);
        let workflow = read_json(testdata().join("v2").join(short).join("workflow.json"));
        let request = legacy_v1_convert::convert_request(
            &package,
            operation,
            &case["request"],
            &case["media"],
            case["date"].as_str().unwrap(),
        )
        .unwrap_or_else(|e| panic!("{name}: request conversion failed: {e}"));
        match engine::build_workflow(&package, operation, &workflow, &request) {
            Ok(built) => {
                let mut diff = Vec::new();
                differences("", &case["prompt"], &built, &mut diff);
                if !diff.is_empty() {
                    failures.push(format!("{name}:\n  {}", diff.join("\n  ")));
                }
            }
            Err(error) => failures.push(format!("{name}: engine error: {error}")),
        }
    }
    assert!(failures.is_empty(), "{} of 55 differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn checked_in_v2_packages_are_exactly_the_converter_output() {
    let names = shorts();
    assert_eq!(names.len(), 9);
    for short in names {
        let (manifest, adapter, ui_schema, workflow) = v1_files(&short);
        let converted =
            legacy_v1_convert::convert_package(&manifest, &adapter, &ui_schema, &workflow).unwrap();
        assert_eq!(converted.engine_api_version, ENGINE_API_VERSION, "{short}");
        assert_eq!(
            serde_json::to_value(&converted).unwrap(),
            read_json(testdata().join("v2").join(&short).join("adapter.json")),
            "{short}: testdata/workflow_v2/v2 is stale, regenerate it from the converter"
        );
        assert_eq!(
            read_json(testdata().join("v2").join(&short).join("workflow.json")),
            workflow,
            "{short}: v2 workflow must be the module's own workflow"
        );
    }
}

#[test]
fn every_converted_package_passes_static_import_validation() {
    for short in shorts() {
        let package = v2_package(&short);
        let workflow = read_json(testdata().join("v2").join(&short).join("workflow.json"));
        let report = validate::validate_package(&package, &workflow, None);
        assert!(report.errors.is_empty(), "{short}: {:?}", report.errors);
        assert!(!report.comfyui_checked, "{short}");
    }
}

// ---- generic behaviour on small synthetic packages (no real module involved) ----

fn request(values: Value, media: Value) -> EngineRequest {
    EngineRequest {
        values: serde_json::from_value(values).unwrap(),
        media: serde_json::from_value(media).unwrap(),
        seed: 7,
        date: "2026-11-01".to_owned(),
    }
}

fn synthetic(operation: Value) -> PackageV2 {
    serde_json::from_value(json!({
        "engineApiVersion": ENGINE_API_VERSION,
        "capability": "image-generation",
        "variant": "image-generation",
        "operations": { "generate": operation }
    }))
    .unwrap()
}

fn chain_workflow() -> Value {
    json!({
        "base": { "class_type": "Loader", "inputs": { "name": "m" } },
        "a": { "class_type": "Lora", "inputs": { "model": ["base", 0], "lora_name": "", "strength_model": 1.0 } },
        "b": { "class_type": "Lora", "inputs": { "model": ["a", 0], "lora_name": "", "strength_model": 1.0 } },
        "c": { "class_type": "Lora", "inputs": { "model": ["b", 0], "lora_name": "", "strength_model": 1.0 } },
        "use": { "class_type": "Sampler", "inputs": { "model": ["c", 0] } }
    })
}

fn chain_package() -> PackageV2 {
    synthetic(json!({
        "controls": [
            { "id": "loras", "type": "repeat", "max": 3, "fields": [
                { "id": "name", "type": "select", "default": "" },
                { "id": "weight", "type": "number", "number": "float", "default": 1.0, "min": 0, "max": 2 },
                { "id": "on", "type": "toggle", "default": true }
            ] }
        ],
        "steps": [
            { "op": "chain", "id": "chain", "repeat": "loras", "slots": ["a", "b", "c"], "linkInput": "model",
              "itemWhen": { "all": [{ "truthy": { "item": "on" } }, { "not": { "empty": { "item": "name" } } }] },
              "fields": { "lora_name": { "trim": { "item": "name" } }, "strength_model": { "float": { "item": "weight" } } },
              "from": { "link": ["base", 0] },
              "to": [{ "node": "use", "input": "model" }] }
        ]
    }))
}

#[test]
fn switched_off_slots_are_skipped_and_downstream_reconnects_to_the_upstream() {
    let built = engine::build_workflow(
        &chain_package(),
        "generate",
        &chain_workflow(),
        &request(
            json!({ "loras": [
                { "name": " one.safetensors ", "weight": 0.5, "on": true },
                { "name": "two.safetensors", "weight": 1, "on": false },
                { "name": "three.safetensors", "weight": 2, "on": true }
            ] }),
            json!({}),
        ),
    )
    .unwrap();
    assert_eq!(built["a"]["inputs"], json!({ "model": ["base", 0], "lora_name": "one.safetensors", "strength_model": 0.5 }));
    assert_eq!(built["c"]["inputs"], json!({ "model": ["a", 0], "lora_name": "three.safetensors", "strength_model": 2.0 }));
    assert_eq!(built["use"]["inputs"]["model"], json!(["c", 0]));
    // The skipped slot is left exactly as it was in the workflow.
    assert_eq!(built["b"], chain_workflow()["b"]);

    let none = engine::build_workflow(&chain_package(), "generate", &chain_workflow(), &request(json!({ "loras": [] }), json!({}))).unwrap();
    assert_eq!(none["use"]["inputs"]["model"], json!(["base", 0]));
}

#[test]
fn repeat_groups_are_capped_by_the_package() {
    let error = engine::build_workflow(
        &chain_package(),
        "generate",
        &chain_workflow(),
        &request(json!({ "loras": [{ "name": "x" }, { "name": "x" }, { "name": "x" }, { "name": "x" }] }), json!({})),
    )
    .unwrap_err();
    assert!(error.contains("loras") && error.contains('3'), "{error}");
}

#[test]
fn one_node_with_several_slots_is_filled_by_input_pattern() {
    let package = synthetic(json!({
        "controls": [
            { "id": "loras", "type": "repeat", "max": 4, "fields": [
                { "id": "name", "type": "select", "default": "" },
                { "id": "weight", "type": "number", "number": "float", "default": 1.0 }
            ] }
        ],
        "steps": [
            { "op": "fill", "repeat": "loras", "node": "multi", "inputPattern": "slot_{n}",
              "itemWhen": { "not": { "empty": { "item": "name" } } },
              "value": { "object": { "on": { "const": true }, "lora": { "item": "name" }, "strength": { "float": { "item": "weight" } } } } }
        ]
    }));
    let workflow = json!({ "multi": { "class_type": "MultiLoader", "inputs": { "slot_1": { "on": false, "lora": "", "strength": 1 } } } });
    let built = engine::build_workflow(
        &package,
        "generate",
        &workflow,
        &request(json!({ "loras": [{ "name": "a" }, { "name": "" }, { "name": "c", "weight": 0.25 }] }), json!({})),
    )
    .unwrap();
    assert_eq!(built["multi"]["inputs"]["slot_1"], json!({ "on": true, "lora": "a", "strength": 1.0 }));
    assert!(built["multi"]["inputs"].get("slot_2").is_none());
    assert_eq!(built["multi"]["inputs"]["slot_3"], json!({ "on": true, "lora": "c", "strength": 0.25 }));
}

#[test]
fn outputs_and_derived_values_follow_declared_conditions() {
    let package = synthetic(json!({
        "controls": [
            { "id": "negative", "type": "textarea", "default": "" },
            { "id": "upscale", "type": "toggle", "default": false },
            { "id": "width", "type": "number", "number": "int", "default": 1000 }
        ],
        "steps": [
            { "op": "set", "node": "s", "input": "cfg", "value": { "if": { "cond": { "empty": { "trim": { "control": "negative" } } }, "then": { "const": 1.0 }, "else": { "const": 1.5 } } } },
            { "op": "set", "node": "save", "input": "images", "value": { "if": { "cond": { "truthy": { "control": "upscale" } }, "then": { "link": ["big", 0] }, "else": { "link": ["small", 0] } } } },
            { "op": "set", "node": "s", "input": "width", "value": { "roundTo": { "value": { "int": { "control": "width" } }, "multiple": 16, "min": 16 } } },
            { "op": "set", "node": "save", "input": "filename_prefix", "value": { "date": { "const": "%date:yyyy-MM-dd%/out" } } },
            { "op": "set", "node": "s", "input": "seed", "value": { "seed": true } },
            { "op": "keepReachable", "from": ["save"] }
        ]
    }));
    let workflow = json!({
        "s": { "class_type": "Sampler", "inputs": { "cfg": 3, "width": 0, "seed": 0 } },
        "small": { "class_type": "Decode", "inputs": { "samples": ["s", 0] } },
        "big": { "class_type": "Upscale", "inputs": { "image": ["small", 0] } },
        "save": { "class_type": "Save", "inputs": { "images": ["small", 0], "filename_prefix": "" } },
        "orphan": { "class_type": "Note", "inputs": {} }
    });
    let plain = engine::build_workflow(&package, "generate", &workflow, &request(json!({ "negative": "  " }), json!({}))).unwrap();
    assert_eq!(plain["s"]["inputs"]["cfg"], json!(1.0));
    assert_eq!(plain["save"]["inputs"]["images"], json!(["small", 0]));
    assert_eq!(plain["s"]["inputs"]["width"], json!(1008));
    assert_eq!(plain["s"]["inputs"]["seed"], json!(7));
    assert_eq!(plain["save"]["inputs"]["filename_prefix"], json!("2026-11-01/out"));
    assert!(plain.get("orphan").is_none() && plain.get("big").is_none());
    let upscaled = engine::build_workflow(&package, "generate", &workflow, &request(json!({ "negative": "ugly", "upscale": true }), json!({}))).unwrap();
    assert_eq!(upscaled["s"]["inputs"]["cfg"], json!(1.5));
    assert_eq!(upscaled["save"]["inputs"]["images"], json!(["big", 0]));
    assert!(upscaled.get("big").is_some());
}

// ---- import validation counter-examples ----

fn validation_package(node: &str, input: &str, version: u32) -> PackageV2 {
    let mut package = synthetic(json!({
        "controls": [{ "id": "prompt", "type": "textarea", "default": "" },
                     { "id": "model", "type": "select", "default": "dir\\base.safetensors",
                       "options": { "comfyui": { "classType": "Loader", "input": "name", "dirs": ["dir"] } } }],
        "steps": [{ "op": "set", "node": node, "input": input, "value": { "control": "prompt" } },
                  { "op": "set", "node": "load", "input": "name", "value": { "control": "model" } }]
    }));
    package.engine_api_version = version;
    package.node_types.insert("load".to_owned(), "Loader".to_owned());
    package
}

fn validation_workflow() -> Value {
    json!({
        "text": { "class_type": "TextEncode", "inputs": { "text": "" } },
        "load": { "class_type": "Loader", "inputs": { "name": "dir\\base.safetensors" } }
    })
}

#[test]
fn validation_rejects_a_missing_node() {
    let report = validate::validate_package(&validation_package("99", "text", ENGINE_API_VERSION), &validation_workflow(), None);
    assert!(report.errors.iter().any(|e| e.contains("节点 99 不存在")), "{:?}", report.errors);
}

#[test]
fn validation_rejects_a_missing_input() {
    let report = validate::validate_package(&validation_package("text", "prompt_text", ENGINE_API_VERSION), &validation_workflow(), None);
    assert!(report.errors.iter().any(|e| e.contains("节点 text 没有输入 prompt_text")), "{:?}", report.errors);
}

#[test]
fn validation_rejects_a_wrong_node_type() {
    let mut workflow = validation_workflow();
    workflow["load"]["class_type"] = json!("OtherLoader");
    let report = validate::validate_package(&validation_package("text", "text", ENGINE_API_VERSION), &workflow, None);
    assert!(report.errors.iter().any(|e| e.contains("节点 load 的类型应为 Loader，实际为 OtherLoader")), "{:?}", report.errors);
}

#[test]
fn validation_rejects_an_unsupported_engine_version() {
    let report = validate::validate_package(&validation_package("text", "text", 3), &validation_workflow(), None);
    assert_eq!(report.errors, vec![format!("方案包需要引擎接口版本 3，本程序支持版本 {ENGINE_API_VERSION}")]);
}

#[test]
fn validation_against_comfyui_reports_missing_classes_and_models_or_says_it_was_not_checked() {
    let package = validation_package("text", "text", ENGINE_API_VERSION);
    let unchecked = validate::validate_package(&package, &validation_workflow(), None);
    assert!(!unchecked.comfyui_checked && unchecked.notes.iter().any(|n| n.contains("未检查")), "{:?}", unchecked.notes);
    let object_info = json!({ "Loader": { "input": { "required": { "name": [["dir\\other.safetensors"]] } } } });
    let checked = validate::validate_package(&package, &validation_workflow(), Some(&object_info));
    assert!(checked.comfyui_checked);
    assert!(checked.errors.iter().any(|e| e.contains("ComfyUI 缺少节点类型 TextEncode")), "{:?}", checked.errors);
    assert!(checked.errors.iter().any(|e| e.contains("dir\\base.safetensors")), "{:?}", checked.errors);
    let complete = json!({
        "Loader": { "input": { "required": { "name": [["dir\\base.safetensors"]] } } },
        "TextEncode": { "input": { "required": { "text": ["STRING"] } } }
    });
    assert!(validate::validate_package(&package, &validation_workflow(), Some(&complete)).errors.is_empty());
}

// ---- the plug-in rule, checked in code: generic files never name a module or a node ----

#[test]
fn generic_engine_files_name_no_module_and_no_node_id() {
    let forbidden = ["krea", "kera", "moss", "h3", "minimax", "video-processing"];
    for (file, source) in [
        ("mod.rs", include_str!("mod.rs")),
        ("engine.rs", include_str!("engine.rs")),
        ("validate.rs", include_str!("validate.rs")),
    ] {
        let lower = source.to_lowercase();
        for word in forbidden {
            assert!(!lower.contains(word), "{file} mentions {word}");
        }
        // A quoted string made only of digits would be a hard-coded node id.
        let mut index = 0;
        while let Some(start) = source[index..].find('"').map(|p| p + index) {
            let end = match source[start + 1..].find('"') {
                Some(p) => start + 1 + p,
                None => break,
            };
            let inner = &source[start + 1..end];
            assert!(
                inner.is_empty() || !inner.bytes().all(|b| b.is_ascii_digit()),
                "{file}: quoted number \"{inner}\" looks like a node id"
            );
            index = end + 1;
        }
    }
}
