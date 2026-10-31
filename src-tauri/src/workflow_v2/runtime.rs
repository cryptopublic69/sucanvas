//! Packages at run time (CANVAS-024c): load a module's package (a v1 package is converted on
//! load and never written back), apply the module's settings as presets, describe the node
//! for the frontend and turn a generic node request into an engine request. Generic: no
//! workflow, adapter or node is named here (checked by a test).

use super::{engine, legacy_v1_convert, validate, EngineRequest, PackageV2, ENGINE_API_VERSION};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub struct LoadedPackage {
    pub package: PackageV2,
    pub workflow: Value,
}

/// A package from a module's manifest, adapter (v1 or v2), ui-schema and workflow.
pub fn load_from_files(
    manifest: &Value,
    adapter: &Value,
    ui_schema: &Value,
    workflow: Value,
) -> Result<LoadedPackage, String> {
    let declared_version = adapter.get("engineApiVersion").and_then(Value::as_u64);
    let mut package = if declared_version == Some(u64::from(ENGINE_API_VERSION)) {
        serde_json::from_value::<PackageV2>(adapter.clone())
            .map_err(|error| format!("方案包第 2 版格式无效：{error}"))?
    } else {
        legacy_v1_convert::convert_package(manifest, adapter, ui_schema, &workflow)?
    };
    for operation in package.operations.values_mut() {
        for control in &mut operation.controls {
            control.preset = None;
        }
    }
    // A control naming a module setting takes it as preset; a setting the control would
    // refuse is ignored (the node falls back to the default).
    for operation in package.operations.values_mut() {
        for control in &mut operation.controls {
            if control.setting.is_empty() {
                continue;
            }
            let value = manifest
                .get("defaults")
                .and_then(|defaults| defaults.get(&control.setting))
                .filter(|value| {
                    !value.is_null() && value.as_str().is_none_or(|text| !text.trim().is_empty())
                })
                .cloned();
            if let Some(value) = value.filter(|value| engine::accepts(control, value)) {
                control.preset = Some(value);
            }
        }
    }
    let report = validate::validate_package(&package, &workflow, None);
    if !report.errors.is_empty() {
        return Err(format!("方案包无效：{}", report.errors.join("；")));
    }
    Ok(LoadedPackage { package, workflow })
}

/// What the node needs to draw itself: ports, controls, groups, labels. Steps, records,
/// result rules and node types stay on the server.
pub fn describe(package: &PackageV2) -> Value {
    let mut value = serde_json::to_value(package).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.remove("nodeTypes");
        if let Some(operations) = object.get_mut("operations").and_then(Value::as_object_mut) {
            for operation in operations.values_mut() {
                if let Some(operation) = operation.as_object_mut() {
                    for key in ["steps", "record", "results"] {
                        operation.remove(key);
                    }
                }
            }
        }
    }
    value
}

/// A generic node request (control values + per-port texts or uploaded names) -> engine request.
/// Values for controls the operation does not declare are refused.
pub fn engine_request(
    package: &PackageV2,
    operation: &str,
    values: &Map<String, Value>,
    media: BTreeMap<String, Vec<String>>,
    seed: u64,
    date: &str,
) -> Result<EngineRequest, String> {
    let declared = package
        .operations
        .get(operation)
        .ok_or_else(|| format!("方案包没有操作 {operation}"))?;
    if let Some(unknown) = values
        .keys()
        .find(|id| !declared.controls.iter().any(|control| &control.id == *id))
    {
        return Err(format!("方案包的操作 {operation} 没有控件 {unknown}"));
    }
    Ok(EngineRequest {
        values: values.clone(),
        media,
        seed,
        date: date.to_owned(),
    })
}

pub fn result_nodes(
    package: &PackageV2,
    operation: &str,
    request: &EngineRequest,
) -> Result<Option<Vec<String>>, String> {
    engine::result_nodes(package, operation, request)
}
