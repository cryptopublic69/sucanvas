// CANVAS-039: an H3 scheme's sampler (su 11-11). A package declares the nodes whose
// `sampler_name` the scheme's sampler writes (adapter bindings `samplerSelectNodeIds`);
// the value is the module setting `samplerName` (manifest defaults). Never set = the
// workflow's own value, so every golden stays byte for byte; set = every declared node
// gets it (both passes use the one sampler). These tests cover the v1 -> v2 conversion
// and the H3 release packages (workflow-packages/h3-v1).
use super::{engine, legacy_v1_convert, runtime};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

const H3_MODULES: [&str; 5] = ["0dca5130", "24f40f6d", "3e0ce25b", "eb7a5470", "ec9f2156"];

fn testdata() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("workflow_v2")
}

fn release_dir(short: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("workflow-packages")
        .join("h3-v1")
        .join(short)
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_slice(&fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap()
}

fn v1_file(short: &str, name: &str) -> Value {
    read_json(testdata().join("v1").join(short).join(name))
}

/// The sampler-select nodes of each production H3 workflow (CANVAS-039 survey): the
/// single-image schemes have 123 (its second pass 9387 reads 123 too); Fla has 123 for the
/// first pass and 389 for the second.
fn declared(short: &str) -> Vec<&'static str> {
    match short {
        "24f40f6d" | "eb7a5470" => vec!["123", "389"],
        _ => vec!["123"],
    }
}

fn with_declaration(short: &str, ids: &[&str]) -> Value {
    let mut adapter = v1_file(short, "adapter.json");
    adapter["bindings"]["samplerSelectNodeIds"] = json!(ids);
    adapter
}

fn with_setting(short: &str, sampler: Option<&str>) -> Value {
    let mut manifest = v1_file(short, "manifest.json");
    if let Some(sampler) = sampler {
        manifest["defaults"]["samplerName"] = json!(sampler);
    }
    manifest
}

fn h3_cases() -> Vec<Value> {
    let goldens = read_json(testdata().join("goldens.json"));
    let cases = goldens["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| H3_MODULES.contains(&case["module"].as_str().unwrap()))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(cases.len(), 40, "H3 golden cases");
    cases
}

/// The prompt a golden case builds through the v2 engine from this package and manifest.
fn built(case: &Value, manifest: &Value, adapter: &Value) -> Result<Value, String> {
    let short = case["module"].as_str().unwrap();
    let workflow = v1_file(short, "workflow.json");
    let loaded = runtime::load_from_files(
        manifest,
        adapter,
        &v1_file(short, "ui-schema.json"),
        workflow,
    )?;
    let operation = case["operation"].as_str().unwrap();
    let request = legacy_v1_convert::convert_request(
        &loaded.package,
        operation,
        &case["request"],
        &case["media"],
        case["date"].as_str().unwrap(),
    )?;
    engine::build_workflow(&loaded.package, operation, &loaded.workflow, &request)
}

fn with_sampler(prompt: &Value, ids: &[&str], sampler: &str) -> Value {
    let mut prompt = prompt.clone();
    for id in ids {
        prompt[*id]["inputs"]["sampler_name"] = json!(sampler);
    }
    prompt
}

#[test]
fn a_declared_but_unset_sampler_leaves_every_h3_golden_unchanged() {
    let mut failures = Vec::new();
    for case in h3_cases() {
        let short = case["module"].as_str().unwrap();
        let name = case["case"].as_str().unwrap();
        let adapter = with_declaration(short, &declared(short));
        match built(&case, &with_setting(short, None), &adapter) {
            Ok(prompt) if prompt == case["prompt"] => {}
            Ok(_) => failures.push(format!("{name}: differs from the golden")),
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_set_sampler_reaches_every_declared_node_and_nothing_else() {
    let mut failures = Vec::new();
    for case in h3_cases() {
        let short = case["module"].as_str().unwrap();
        let name = case["case"].as_str().unwrap();
        let ids = declared(short);
        for id in &ids {
            assert_eq!(
                case["prompt"][*id]["inputs"]["sampler_name"], "euler",
                "{name}: the golden's {id} is the package value"
            );
        }
        let adapter = with_declaration(short, &ids);
        let expected = with_sampler(&case["prompt"], &ids, "res_multistep");
        match built(&case, &with_setting(short, Some("res_multistep")), &adapter) {
            Ok(prompt) if prompt == expected => {}
            Ok(prompt) => failures.push(format!(
                "{name}: {}",
                ids.iter()
                    .map(|id| format!("{id}={}", prompt[*id]["inputs"]["sampler_name"]))
                    .collect::<Vec<_>>()
                    .join(" ")
            )),
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_sampler_setting_without_a_declaration_changes_nothing() {
    // Old packages (no samplerSelectNodeIds) keep working exactly as before, even with a
    // stray setting in the manifest.
    for case in h3_cases() {
        let short = case["module"].as_str().unwrap();
        let prompt = built(
            &case,
            &with_setting(short, Some("res_multistep")),
            &v1_file(short, "adapter.json"),
        )
        .unwrap();
        assert_eq!(prompt, case["prompt"], "{}", case["case"]);
    }
}

#[test]
fn packages_without_the_declaration_convert_exactly_as_before() {
    for short in H3_MODULES {
        let manifest = v1_file(short, "manifest.json");
        let ui_schema = v1_file(short, "ui-schema.json");
        let workflow = v1_file(short, "workflow.json");
        let original = legacy_v1_convert::convert_package(
            &manifest,
            &v1_file(short, "adapter.json"),
            &ui_schema,
            &workflow,
        )
        .unwrap();
        let empty = legacy_v1_convert::convert_package(
            &manifest,
            &with_declaration(short, &[]),
            &ui_schema,
            &workflow,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&original).unwrap(),
            serde_json::to_value(&empty).unwrap(),
            "{short}: an empty declaration is no declaration"
        );
    }
}

#[test]
fn a_declared_node_must_exist_with_a_sampler_name_input() {
    let short = "3e0ce25b";
    let manifest = with_setting(short, Some("res_multistep"));
    let ui_schema = v1_file(short, "ui-schema.json");
    for (ids, expected) in [(["999"], "999"), (["125"], "sampler_name")] {
        let error = runtime::load_from_files(
            &manifest,
            &with_declaration(short, &ids),
            &ui_schema,
            v1_file(short, "workflow.json"),
        )
        .err()
        .unwrap_or_else(|| panic!("{ids:?}: a wrong declaration must be refused on load"));
        assert!(error.contains(expected), "{ids:?}: {error}");
    }
}

#[test]
fn sampler_choices_are_read_from_both_object_info_shapes() {
    // ComfyUI (192.168.5.108, 11-11) answers object_info/KSamplerSelect in the COMBO shape;
    // older servers list the choices directly. Abridged from the real answer.
    let combo = json!({ "KSamplerSelect": { "input": { "required": { "sampler_name":
        ["COMBO", { "multiselect": false, "options": ["euler", "res_multistep", "er_sde"] }] } } } });
    let listed = json!({ "KSamplerSelect": { "input": { "required": { "sampler_name":
        [["euler", "res_multistep", "er_sde"]] } } } });
    for info in [combo, listed] {
        assert_eq!(
            super::submit::combo_choices(&info, "KSamplerSelect", "sampler_name"),
            ["euler", "res_multistep", "er_sde"]
        );
    }
    assert!(super::submit::combo_choices(&json!({}), "KSamplerSelect", "sampler_name").is_empty());
}

// ---- the H3 release packages (workflow-packages/h3-v1/<short>) ----

#[test]
fn each_h3_release_package_is_the_production_package_plus_the_sampler_declaration() {
    for short in H3_MODULES {
        let dir = release_dir(short);
        let manifest = read_json(dir.join("manifest.json"));
        let adapter = read_json(dir.join("adapter.json"));
        let workflow = read_json(dir.join("workflow.json"));
        let original_manifest = v1_file(short, "manifest.json");
        // Same module (id, name, kind, settings), new revision.
        for key in [
            "id",
            "name",
            "capability",
            "variant",
            "adapterKind",
            "defaults",
        ] {
            assert_eq!(
                manifest[key], original_manifest[key],
                "{short}: manifest {key}"
            );
        }
        assert_ne!(
            manifest["revision"], original_manifest["revision"],
            "{short}: revision"
        );
        assert!(
            manifest["defaults"].get("samplerName").is_none(),
            "{short}: a package never sets the sampler"
        );
        // Workflow and ui-schema untouched; the adapter only gains the declaration.
        assert_eq!(
            workflow,
            v1_file(short, "workflow.json"),
            "{short}: workflow"
        );
        assert_eq!(
            read_json(dir.join("ui-schema.json")),
            v1_file(short, "ui-schema.json"),
            "{short}: ui-schema"
        );
        let mut expected = v1_file(short, "adapter.json");
        expected["bindings"]["samplerSelectNodeIds"] = json!(declared(short));
        assert_eq!(adapter, expected, "{short}: adapter");
        // Every sampler-select node of the workflow is declared (both passes, one value).
        let mut selects = workflow
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, node)| node["class_type"] == "KSamplerSelect")
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        selects.sort();
        assert_eq!(selects, declared(short), "{short}: declared nodes");
    }
}

/// Writes workflow-packages/h3-v1/bundles/<short>.zip from the package directories (run with
/// --ignored). Fixed entry times and order: the same files always give the same bytes.
#[test]
#[ignore]
fn write_h3_release_bundles() {
    use std::io::Write;
    let out = release_dir("bundles");
    fs::create_dir_all(&out).unwrap();
    for short in H3_MODULES {
        let mut archive =
            zip::ZipWriter::new(fs::File::create(out.join(format!("{short}.zip"))).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default())
            .unix_permissions(0o644);
        for name in [
            "manifest.json",
            "workflow.json",
            "adapter.json",
            "ui-schema.json",
        ] {
            archive.start_file(name, options).unwrap();
            archive
                .write_all(&fs::read(release_dir(short).join(name)).unwrap())
                .unwrap();
        }
        archive.finish().unwrap();
    }
}

#[test]
fn h3_release_bundles_hold_the_package_files() {
    // The importable files (workflow-packages/h3-v1/bundles/<short>.zip) carry exactly the
    // four package files of the directory.
    for short in H3_MODULES {
        let bundle = release_dir("bundles").join(format!("{short}.zip"));
        let file = fs::File::open(&bundle).unwrap_or_else(|e| panic!("{}: {e}", bundle.display()));
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            [
                "adapter.json",
                "manifest.json",
                "ui-schema.json",
                "workflow.json"
            ],
            "{short}"
        );
        for name in names {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut archive.by_name(&name).unwrap(), &mut bytes).unwrap();
            assert_eq!(
                bytes,
                fs::read(release_dir(short).join(&name)).unwrap(),
                "{short}/{name}"
            );
        }
    }
}
