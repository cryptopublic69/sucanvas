// CANVAS-039: the scheme sampler in the module store. It is a module setting (manifest
// `defaults.samplerName`, next to primaryVideoSteps); a package declares the nodes it goes to
// (adapter `bindings.samplerSelectNodeIds`). An old manifest without the key reads as unset.
use super::{get, restore_bundle, save, update_defaults, validate_workflow_bytes};
use super::{SaveWorkflowModuleInput, WorkflowAdapter, WorkflowModuleDefaults};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

fn testdata(short: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("workflow_v2")
        .join("v1")
        .join(short)
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_slice(&fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap()
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("canvas039-{label}-{}", Uuid::new_v4().simple()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A copy of a production module as package files; `declare` adds the sampler nodes.
fn package_dir(short: &str, declare: Option<&[&str]>, sampler: Option<&str>) -> PathBuf {
    let dir = temp_dir(short);
    for name in [
        "manifest.json",
        "workflow.json",
        "adapter.json",
        "ui-schema.json",
    ] {
        fs::copy(testdata(short).join(name), dir.join(name)).unwrap();
    }
    if let Some(ids) = declare {
        let mut adapter = read_json(dir.join("adapter.json"));
        adapter["bindings"]["samplerSelectNodeIds"] = json!(ids);
        fs::write(
            dir.join("adapter.json"),
            serde_json::to_vec_pretty(&adapter).unwrap(),
        )
        .unwrap();
    }
    if let Some(sampler) = sampler {
        let mut manifest = read_json(dir.join("manifest.json"));
        manifest["defaults"]["samplerName"] = json!(sampler);
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }
    dir
}

/// A module store holding that module under its production id.
fn store(short: &str, declare: Option<&[&str]>) -> (PathBuf, String) {
    let root = temp_dir("store");
    let source = package_dir(short, declare, None);
    let id = read_json(source.join("manifest.json"))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target = root.join(&id);
    fs::create_dir_all(&target).unwrap();
    for name in [
        "manifest.json",
        "workflow.json",
        "adapter.json",
        "ui-schema.json",
    ] {
        fs::copy(source.join(name), target.join(name)).unwrap();
    }
    let _ = fs::remove_dir_all(source);
    (root, id)
}

fn defaults_with(root: &Path, id: &str, sampler: Value) -> WorkflowModuleDefaults {
    let mut defaults = serde_json::to_value(&get(root, id).unwrap().manifest.defaults).unwrap();
    defaults["samplerName"] = sampler;
    serde_json::from_value(defaults).unwrap()
}

fn sampler_of(root: &Path, id: &str) -> Value {
    serde_json::to_value(&get(root, id).unwrap().manifest.defaults).unwrap()["samplerName"].clone()
}

#[test]
fn a_sampler_setting_is_saved_read_back_and_cleared() {
    let (root, id) = store("24f40f6d", Some(&["123", "389"]));
    assert_eq!(sampler_of(&root, &id), Value::Null, "unset by default");
    update_defaults(
        &root,
        &id,
        defaults_with(&root, &id, json!("res_multistep")),
    )
    .unwrap();
    assert_eq!(sampler_of(&root, &id), json!("res_multistep"));
    let on_disk = read_json(root.join(&id).join("manifest.json"));
    assert_eq!(on_disk["defaults"]["samplerName"], "res_multistep");
    // Back to "not set": the key leaves the manifest (the package value applies again).
    update_defaults(&root, &id, defaults_with(&root, &id, Value::Null)).unwrap();
    let on_disk = read_json(root.join(&id).join("manifest.json"));
    assert!(
        on_disk["defaults"].get("samplerName").is_none(),
        "{on_disk}"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn an_old_manifest_without_the_key_reads_as_unset() {
    let (root, id) = store("3e0ce25b", None);
    let record = get(&root, &id).unwrap();
    let defaults = serde_json::to_value(&record.manifest.defaults).unwrap();
    assert!(defaults.get("samplerName").is_none(), "{defaults}");
    // And the old adapter serialises without the new binding (its bytes stay the same).
    let bindings = serde_json::to_value(&record.adapter.bindings).unwrap();
    assert!(bindings.get("samplerSelectNodeIds").is_none(), "{bindings}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_sampler_needs_a_declaring_package_and_a_name() {
    let (root, id) = store("3e0ce25b", None);
    let error = update_defaults(
        &root,
        &id,
        defaults_with(&root, &id, json!("res_multistep")),
    )
    .expect_err("a package without sampler nodes has no sampler setting");
    assert!(error.contains("采样器"), "{error}");
    let _ = fs::remove_dir_all(root);
    let (root, id) = store("3e0ce25b", Some(&["123"]));
    for blank in ["", "   "] {
        let error = update_defaults(&root, &id, defaults_with(&root, &id, json!(blank)))
            .expect_err("an empty sampler is refused");
        assert!(error.contains("采样器"), "{blank:?}: {error}");
    }
    assert_eq!(sampler_of(&root, &id), Value::Null);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn validation_reports_a_wrong_sampler_declaration() {
    let short = "3e0ce25b";
    let workflow = fs::read(testdata(short).join("workflow.json")).unwrap();
    let adapter_for = |ids: &[&str]| -> WorkflowAdapter {
        let mut adapter = read_json(testdata(short).join("adapter.json"));
        adapter["bindings"]["samplerSelectNodeIds"] = json!(ids);
        serde_json::from_value(adapter).unwrap()
    };
    let ok = validate_workflow_bytes(&workflow, &adapter_for(&["123"]));
    assert!(ok.compatible, "{:?}", ok.issues);
    for (ids, expected) in [(vec!["999"], "999"), (vec!["125"], "sampler_name")] {
        let report = validate_workflow_bytes(&workflow, &adapter_for(&ids));
        assert!(!report.compatible, "{ids:?} must be refused");
        assert!(
            report.issues.iter().any(|issue| issue.contains(expected)),
            "{ids:?}: {:?}",
            report.issues
        );
    }
}

#[test]
fn each_release_bundle_restores_onto_its_production_module() {
    // What the deployment does: 「从备份恢复当前方案」 with workflow-packages/h3-v1/bundles.
    let bundles = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("workflow-packages")
        .join("h3-v1")
        .join("bundles");
    for (short, nodes) in [
        ("0dca5130", vec!["123"]),
        ("24f40f6d", vec!["123", "389"]),
        ("3e0ce25b", vec!["123"]),
        ("eb7a5470", vec!["123", "389"]),
        ("ec9f2156", vec!["123"]),
    ] {
        let (root, id) = store(short, None);
        let before = get(&root, &id).unwrap();
        let bundle = bundles.join(format!("{short}.zip")).canonicalize().unwrap();
        let after = restore_bundle(&root, &id, &bundle).unwrap();
        assert_eq!(after.manifest.id, id, "{short}: same module");
        assert_eq!(
            after.adapter.bindings.sampler_select_node_ids, nodes,
            "{short}"
        );
        assert!(
            after.manifest.revision.starts_with("V3.1-"),
            "{short}: {}",
            after.manifest.revision
        );
        assert_eq!(
            serde_json::to_value(&after.manifest.defaults).unwrap(),
            serde_json::to_value(&before.manifest.defaults).unwrap(),
            "{short}: settings unchanged"
        );
        assert_eq!(
            fs::read(&after.workflow_path).unwrap(),
            fs::read(testdata(short).join("workflow.json")).unwrap(),
            "{short}: workflow unchanged"
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn restoring_or_resaving_a_package_keeps_the_sampler_setting() {
    let (root, id) = store("eb7a5470", Some(&["123", "389"]));
    update_defaults(
        &root,
        &id,
        defaults_with(&root, &id, json!("res_multistep")),
    )
    .unwrap();
    // "从备份恢复到原方案" with a release package (its manifest never carries the sampler).
    let bundle = package_dir("eb7a5470", Some(&["123", "389"]), None);
    restore_bundle(&root, &id, &bundle).unwrap();
    assert_eq!(
        sampler_of(&root, &id),
        json!("res_multistep"),
        "after restore"
    );
    // "保存" on the settings page sends defaults without the key (older pages did).
    let record = get(&root, &id).unwrap();
    let mut defaults = serde_json::to_value(&record.manifest.defaults).unwrap();
    defaults.as_object_mut().unwrap().remove("samplerName");
    save(
        &root,
        SaveWorkflowModuleInput {
            id: Some(id.clone()),
            name: record.manifest.name.clone(),
            capability: record.manifest.capability.clone(),
            variant: record.manifest.variant.clone(),
            revision: record.manifest.revision.clone(),
            adapter_kind: record.manifest.adapter_kind.clone(),
            source_workflow_path: record.workflow_path.clone(),
            bindings: None,
            adapter: Some(record.adapter.clone()),
            ui_schema: Some(record.ui_schema.clone()),
            defaults: Some(serde_json::from_value(defaults).unwrap()),
        },
    )
    .unwrap();
    assert_eq!(sampler_of(&root, &id), json!("res_multistep"), "after save");
    let _ = fs::remove_dir_all(bundle);
    let _ = fs::remove_dir_all(root);
}

// CANVAS-041: the settings page keeps the sampler as a draft and sends it with 「保存」 or
// 「另存为新方案」. These are the store calls the page makes; the store itself is unchanged.
const MODULE_FILES: [&str; 4] = [
    "manifest.json",
    "workflow.json",
    "adapter.json",
    "ui-schema.json",
];

fn module_bytes(root: &Path, id: &str) -> Vec<Vec<u8>> {
    MODULE_FILES
        .iter()
        .map(|name| fs::read(root.join(id).join(name)).unwrap())
        .collect()
}

fn backups_of(root: &Path, id: &str) -> usize {
    get(root, id).unwrap().backup_count
}

/// The page's save input: 「另存为新方案」 (`overwrite` false) sends no id, the bindings draft
/// and no adapter/ui schema; 「保存」 sends the scheme's id, adapter and ui schema.
fn page_save_input(
    root: &Path,
    id: &str,
    overwrite: bool,
    sampler: Value,
) -> SaveWorkflowModuleInput {
    let record = get(root, id).unwrap();
    SaveWorkflowModuleInput {
        id: overwrite.then(|| id.to_owned()),
        name: format!("{} LCM", record.manifest.name),
        capability: record.manifest.capability.clone(),
        variant: record.manifest.variant.clone(),
        revision: record.manifest.revision.clone(),
        adapter_kind: record.manifest.adapter_kind.clone(),
        source_workflow_path: record.workflow_path.clone(),
        bindings: Some(record.bindings.clone()),
        adapter: overwrite.then(|| record.adapter.clone()),
        ui_schema: overwrite.then(|| record.ui_schema.clone()),
        defaults: Some(defaults_with(root, id, sampler)),
    }
}

#[test]
fn save_as_copies_the_scheme_settings_with_the_draft_and_leaves_the_source_alone() {
    let (root, id) = store("24f40f6d", Some(&["123", "389"]));
    let before = module_bytes(&root, &id);
    let backups = backups_of(&root, &id);
    let source_defaults =
        serde_json::to_value(&get(&root, &id).unwrap().manifest.defaults).unwrap();
    let copy = save(&root, page_save_input(&root, &id, false, json!("lcm"))).unwrap();
    assert_ne!(copy.manifest.id, id, "a new scheme");
    assert_eq!(
        copy.adapter.bindings.sampler_select_node_ids,
        vec!["123", "389"],
        "the copy keeps the sampler declaration"
    );
    let mut expected = source_defaults.clone();
    expected["samplerName"] = json!("lcm");
    assert_eq!(
        serde_json::to_value(&copy.manifest.defaults).unwrap(),
        expected
    );
    assert_eq!(
        module_bytes(&root, &id),
        before,
        "source files byte for byte"
    );
    assert_eq!(
        backups_of(&root, &id),
        backups,
        "no restore point on the source"
    );
    assert_eq!(sampler_of(&root, &id), Value::Null);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn save_writes_the_draft_into_the_scheme_with_a_restore_point_and_clears_with_null() {
    let (root, id) = store("24f40f6d", Some(&["123", "389"]));
    let backups = backups_of(&root, &id);
    save(&root, page_save_input(&root, &id, true, json!("lcm"))).unwrap();
    assert_eq!(sampler_of(&root, &id), json!("lcm"));
    assert_eq!(backups_of(&root, &id), backups + 1, "restore point");
    // Back to "unset": a save naming no sampler keeps the scheme's (CANVAS-039 rule), so the
    // page clears it with the settings command afterwards.
    save(&root, page_save_input(&root, &id, true, Value::Null)).unwrap();
    assert_eq!(sampler_of(&root, &id), json!("lcm"), "save alone keeps it");
    update_defaults(&root, &id, defaults_with(&root, &id, Value::Null)).unwrap();
    assert_eq!(sampler_of(&root, &id), Value::Null);
    let _ = fs::remove_dir_all(root);
}
