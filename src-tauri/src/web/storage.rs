use super::{rpc, WebState};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const IMPORT_FOLDER: &str = "sucanvas-imports";

pub fn input_root(state: &WebState) -> Result<PathBuf, String> {
    if state.config.comfy_input_directory.is_empty() {
        return Err("请先在基础设置中填写服务器本机的 ComfyUI 输入映射目录".into());
    }
    Ok(PathBuf::from(&state.config.comfy_input_directory))
}

pub fn resource_path(state: &WebState, resource: &str) -> Result<PathBuf, String> {
    let mapped: Option<String> = fs::read(state.core.data_dir.join("storage-migration-map.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, String>>(&bytes).ok())
        .and_then(|map| map.get(resource).cloned());
    let resource = mapped.as_deref().unwrap_or(resource);
    for (prefix, root) in [
        (
            "sucanvas-input://",
            state.config.comfy_input_directory.as_str(),
        ),
        (
            "sucanvas-output://",
            state.config.comfy_output_directory.as_str(),
        ),
    ] {
        if let Some(relative) = resource.strip_prefix(prefix) {
            if root.is_empty() {
                return Err("请先配置对应的 ComfyUI 映射目录".into());
            }
            return crate::portable::resource_path(
                Path::new(root),
                &format!("sucanvas://{relative}"),
            );
        }
    }
    crate::portable::resource_path(&state.core.data_dir, resource)
}

pub fn encode(state: &WebState, text: &str) -> String {
    for (root, prefix) in [
        (&state.config.comfy_input_directory, "sucanvas-input://"),
        (&state.config.comfy_output_directory, "sucanvas-output://"),
    ] {
        if root.is_empty() {
            continue;
        }
        let encoded = crate::portable::encode(Path::new(root), text);
        if encoded == text {
            continue;
        }
        if let Some(relative) = encoded.strip_prefix("sucanvas://") {
            return format!("{prefix}{relative}");
        }
    }
    text.to_owned()
}

pub fn encode_value(state: &WebState, value: &mut Value) {
    match value {
        Value::String(text) => *text = encode(state, text),
        Value::Array(values) => {
            for value in values {
                encode_value(state, value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                encode_value(state, value);
            }
        }
        _ => {}
    }
}

pub fn normalize_record(state: &WebState, value: &mut Value) {
    encode_value(state, value);
    if let Ok(bytes) = fs::read(state.core.data_dir.join("storage-migration-map.json")) {
        if let Ok(replacements) = serde_json::from_slice(&bytes) {
            replace_strings(value, &replacements);
        }
    }
}

pub fn normalize_settings(state: &WebState, settings: &mut BTreeMap<String, String>) {
    let replacements: BTreeMap<String, String> =
        fs::read(state.core.data_dir.join("storage-migration-map.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
    for text in settings.values_mut() {
        let parsed = serde_json::from_str::<Value>(text);
        let original = parsed.as_ref().cloned().unwrap_or_else(|_| json!(text));
        let mut value = original.clone();
        encode_value(state, &mut value);
        replace_strings(&mut value, &replacements);
        if value == original {
            continue;
        }
        *text = if parsed.is_ok() {
            serde_json::to_string(&value).unwrap()
        } else {
            value.as_str().unwrap_or(text).to_owned()
        };
    }
}

pub fn output_reference(output: &mut Value) -> Result<(), String> {
    let filename = output
        .get("filename")
        .and_then(Value::as_str)
        .ok_or("生成结果缺少文件名")?;
    let subfolder = output
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or("");
    let relative = if subfolder.is_empty() {
        filename.to_owned()
    } else {
        format!("{subfolder}/{filename}")
    }
    .replace('\\', "/");
    // Use the same validation for references even before the mapping is filled.
    crate::portable::resource_path(Path::new("."), &format!("sucanvas://{relative}"))?;
    output["assetPath"] = Value::String(format!("sucanvas-output://{relative}"));
    Ok(())
}

fn same_contents(a: &Path, b: &Path) -> Result<bool, String> {
    if fs::metadata(a).map_err(|e| e.to_string())?.len()
        != fs::metadata(b).map_err(|e| e.to_string())?.len()
    {
        return Ok(false);
    }
    let mut a = fs::File::open(a).map_err(|e| e.to_string())?;
    let mut b = fs::File::open(b).map_err(|e| e.to_string())?;
    let mut left = [0u8; 65536];
    let mut right = [0u8; 65536];
    loop {
        let count = a.read(&mut left).map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(true);
        }
        b.read_exact(&mut right[..count])
            .map_err(|e| e.to_string())?;
        if left[..count] != right[..count] {
            return Ok(false);
        }
    }
}

fn verified_copy(source: &Path, target: &Path, root: &Path) -> Result<(), String> {
    rpc::ensure_contained(target, &[root.to_owned()])?;
    if target.is_file() {
        if same_contents(source, target)? {
            return Ok(());
        }
        return Err(format!(
            "目标已有不同内容的文件，已保留原数据：{}",
            target.display()
        ));
    }
    fs::create_dir_all(target.parent().ok_or("文件缺少父目录")?).map_err(|e| e.to_string())?;
    rpc::ensure_contained(target, &[root.to_owned()])?;
    let temporary = target.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let mut created_target = false;
    let result = (|| {
        fs::copy(source, &temporary).map_err(|e| e.to_string())?;
        if !same_contents(source, &temporary)? {
            return Err("迁移文件校验失败".into());
        }
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        // create_new prevents replacing a file produced while migration runs.
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| e.to_string())?;
        created_target = true;
        std::io::copy(
            &mut fs::File::open(&temporary).map_err(|e| e.to_string())?,
            &mut destination,
        )
        .map_err(|e| e.to_string())?;
        destination
            .flush()
            .and_then(|_| destination.sync_all())
            .map_err(|e| e.to_string())?;
        if !same_contents(source, target)? {
            return Err("迁移后的文件校验失败".into());
        }
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    if result.is_err() && created_target {
        let _ = fs::remove_file(target);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_are_references_and_reject_path_traversal() {
        let mut output = json!({"filename": "scene.mp4", "subfolder": "H3/day"});
        output_reference(&mut output).unwrap();
        assert_eq!(output["assetPath"], "sucanvas-output://H3/day/scene.mp4");
        for filename in ["../outside.mp4", "secret:stream.mp4", "C:\\outside.mp4"] {
            assert!(output_reference(&mut json!({"filename": filename})).is_err());
        }
    }

    #[test]
    fn verified_copy_preserves_conflicting_files_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!("comfy-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("input")).unwrap();
        let source = root.join("old.png");
        let target = root.join("input/import.png");
        fs::write(&source, b"original media").unwrap();
        verified_copy(&source, &target, &root.join("input")).unwrap();
        verified_copy(&source, &target, &root.join("input")).unwrap();
        assert!(same_contents(&source, &target).unwrap());
        fs::write(&target, b"another existing file").unwrap();
        assert!(verified_copy(&source, &target, &root.join("input")).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"another existing file");
        assert_eq!(fs::read(&source).unwrap(), b"original media");
        assert!(verified_copy(&source, &root.join("outside.png"), &root.join("input")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

fn replace_strings(value: &mut Value, replacements: &BTreeMap<String, String>) {
    match value {
        Value::String(text) => {
            if let Some(replacement) = replacements.get(text) {
                *text = replacement.clone();
            }
        }
        Value::Array(values) => {
            for value in values {
                replace_strings(value, replacements);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                replace_strings(value, replacements);
            }
        }
        _ => {}
    }
}

fn legacy_file(state: &WebState, text: &str) -> Option<PathBuf> {
    let normalized = crate::portable::encode(&state.core.data_dir, text);
    let path = if normalized.starts_with("sucanvas://") {
        crate::portable::resource_path(&state.core.data_dir, &normalized).ok()?
    } else {
        PathBuf::from(text)
    };
    path.strip_prefix(state.core.data_dir.join("assets")).ok()?;
    Some(path)
}

fn add_replacement(
    state: &WebState,
    source: &Path,
    resource: &str,
    replacements: &mut BTreeMap<String, String>,
) {
    let absolute = source.to_string_lossy().into_owned();
    let legacy = crate::portable::encode(&state.core.data_dir, &absolute);
    replacements.insert(absolute, resource.to_owned());
    let clean = source
        .to_string_lossy()
        .strip_prefix(r"\\?\")
        .unwrap_or(&source.to_string_lossy())
        .to_owned();
    replacements.insert(clean.clone(), resource.to_owned());
    replacements.insert(clean.replace('\\', "/"), resource.to_owned());
    replacements.insert(legacy.clone(), resource.to_owned());
    let mut url = reqwest::Url::parse("http://localhost/api/resource").unwrap();
    url.query_pairs_mut().append_pair("resource", &legacy);
    let old_url = format!("/api/resource?{}", url.query().unwrap());
    let mut new_url = reqwest::Url::parse("http://localhost/api/resource").unwrap();
    new_url.query_pairs_mut().append_pair("resource", resource);
    let new_url = format!("/api/resource?{}", new_url.query().unwrap());
    replacements.insert(old_url.clone(), new_url.clone());
    replacements.insert(format!("{}{old_url}", state.config.origin()), new_url);
}

pub fn migrate(state: &WebState) -> Result<Value, String> {
    let legacy = state.core.data_dir.join("assets");
    let restored_inputs = state.core.data_dir.join("comfy-input");
    if !legacy.is_dir() && !restored_inputs.is_dir() {
        return Ok(json!({"migrated": false}));
    }
    if state.config.comfy_input_directory.is_empty()
        || state.config.comfy_output_directory.is_empty()
    {
        return Ok(
            json!({"migrated": false, "pending": true, "message": "填写并保存 ComfyUI 输入、输出映射后，旧素材将迁入对应目录"}),
        );
    }
    let input = input_root(state)?;
    let output = PathBuf::from(&state.config.comfy_output_directory);
    let backup = state
        .handle
        .root
        .join("backup")
        .join(format!("storage-migration-{}", uuid::Uuid::new_v4()));
    let settings = fs::read(state.core.data_dir.join("web-settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, String>>(&bytes).ok())
        .unwrap_or_default();
    crate::app_backup::export(
        &state.core.data_dir,
        &state.core.database,
        &backup.join("before-migration.sucanvas-backup"),
        &settings,
    )?;
    if restored_inputs.is_dir() {
        restore_inputs(&restored_inputs, &restored_inputs, &input)?;
    }
    // This migration belongs entirely to the Web adapter. Its write operations
    // are serialized with Web mutations and use SQLite's atomic transaction.
    let mut connection =
        rusqlite::Connection::open(state.core.data_dir.join("infinite-canvas.sqlite3"))
            .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let nodes = {
        let mut query = transaction
            .prepare("SELECT id, kind, content_json FROM nodes")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let mut replacements = BTreeMap::new();
    let mut updates = BTreeMap::new();
    for (id, kind, raw) in &nodes {
        let mut content: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        if !matches!(kind.as_str(), "generated-video" | "generated-image")
            || content["generationPlaceholder"] == true
        {
            continue;
        }
        let filename = content["filename"].as_str().unwrap_or("");
        let source = content["assetPath"]
            .as_str()
            .and_then(|text| legacy_file(state, text));
        if filename.is_empty() && source.is_none() {
            continue;
        }
        let folder = content["subfolder"].as_str().unwrap_or("");
        let mut relative = if folder.is_empty() {
            filename.to_owned()
        } else {
            format!("{folder}/{filename}")
        }
        .replace('\\', "/");
        let mut target =
            crate::portable::resource_path(&output, &format!("sucanvas://{relative}")).ok();
        if let Some(target) = &target {
            rpc::ensure_contained(target, &[output.clone()])?;
        }
        if let Some(source) = source {
            rpc::ensure_contained(&source, &[legacy.clone()])?;
            if !source.is_file() {
                return Err(format!("旧素材缺失，未修改项目引用：{}", source.display()));
            }
            let reusable = target.as_ref().is_some_and(|path| {
                path.is_file() && same_contents(&source, path).unwrap_or(false)
            });
            if !reusable {
                relative = format!(
                    "sucanvas-migrated/{}",
                    source
                        .file_name()
                        .ok_or("无效素材文件名")?
                        .to_string_lossy()
                );
                target = Some(crate::portable::resource_path(
                    &output,
                    &format!("sucanvas://{relative}"),
                )?);
                verified_copy(&source, target.as_ref().unwrap(), &output)?;
            }
            add_replacement(
                state,
                &source,
                &format!("sucanvas-output://{relative}"),
                &mut replacements,
            );
        } else if target.as_ref().is_none_or(|path| !path.is_file()) {
            return Err(format!("无法定位生成素材原件：{filename}。项目引用保持不变，请检查输出映射目录或恢复原文件。"));
        }
        let (folder, filename) = relative.rsplit_once('/').unwrap_or(("", &relative));
        content["filename"] = json!(filename);
        content["subfolder"] = json!(folder);
        content["fileType"] = json!("output");
        content["assetPath"] = json!(format!("sucanvas-output://{relative}"));
        let mut url = reqwest::Url::parse("http://localhost/api/comfy/view").unwrap();
        url.query_pairs_mut()
            .append_pair("filename", filename)
            .append_pair("subfolder", folder)
            .append_pair("type", "output");
        let key = if kind == "generated-video" {
            "videoUrl"
        } else {
            "imageUrl"
        };
        let new_url = format!("/api/comfy/view?{}", url.query().unwrap());
        if let Some(old_url) = content[key].as_str() {
            replacements.insert(old_url.to_owned(), new_url.clone());
        }
        content[key] = json!(new_url);
        content["comfyServerUrl"] = json!(format!("{}/api/comfy", state.config.origin()));
        updates.insert(id.clone(), content);
    }
    // Move remaining imported assets (including references in saved snapshots).
    // Unknown generated files retain their bytes in output, rather than being discarded.
    let entries = if legacy.is_dir() {
        fs::read_dir(&legacy)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    for entry in entries {
        let source = entry.path();
        if !source.is_file() {
            return Err("旧素材目录含子目录或无效文件，请检查后再迁移".into());
        }
        let old_resource = crate::portable::encode(&state.core.data_dir, &source.to_string_lossy());
        if replacements.contains_key(&old_resource) {
            continue;
        }
        rpc::ensure_contained(&source, &[legacy.clone()])?;
        let name = source
            .file_name()
            .ok_or("无效素材文件名")?
            .to_string_lossy();
        let (root, prefix, relative) = if name.starts_with("generated-") {
            (
                &output,
                "sucanvas-output://",
                format!("sucanvas-migrated/{name}"),
            )
        } else {
            (
                &input,
                "sucanvas-input://",
                format!("{IMPORT_FOLDER}/{name}"),
            )
        };
        let target = crate::portable::resource_path(root, &format!("sucanvas://{relative}"))?;
        verified_copy(&source, &target, root)?;
        add_replacement(
            state,
            &source,
            &format!("{prefix}{relative}"),
            &mut replacements,
        );
    }
    let mut changed_nodes = 0;
    for (id, _, raw) in &nodes {
        let mut content = updates
            .get(id)
            .cloned()
            .unwrap_or(serde_json::from_str(raw).map_err(|e| e.to_string())?);
        replace_strings(&mut content, &replacements);
        let serialized = serde_json::to_string(&content).map_err(|e| e.to_string())?;
        if &serialized != raw {
            transaction
                .execute(
                    "UPDATE nodes SET content_json=?2 WHERE id=?1",
                    rusqlite::params![id, serialized],
                )
                .map_err(|e| e.to_string())?;
            changed_nodes += 1;
        }
    }
    // Cover canvases and JSON snapshots used by folder undo and scene bindings.
    let tables = {
        let mut query = transaction.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='nodes'").map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for table in tables {
        let quoted = table.replace('"', "\"\"");
        let columns = {
            let mut query = transaction
                .prepare(&format!("PRAGMA table_info(\"{quoted}\")"))
                .map_err(|e| e.to_string())?;
            let rows = query
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for column in columns
            .into_iter()
            .filter(|column| column.ends_with("_json") || column.ends_with("_path"))
        {
            let col = column.replace('"', "\"\"");
            let rows = {
                let mut query = transaction
                    .prepare(&format!(
                        "SELECT rowid, \"{col}\" FROM \"{quoted}\" WHERE \"{col}\" IS NOT NULL"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = query
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                rows
            };
            for (rowid, raw) in rows {
                let parsed = serde_json::from_str::<Value>(&raw);
                let mut value = parsed.as_ref().cloned().unwrap_or_else(|_| json!(raw));
                replace_strings(&mut value, &replacements);
                let updated = if parsed.is_ok() {
                    serde_json::to_string(&value).map_err(|e| e.to_string())?
                } else {
                    value.as_str().unwrap_or(&raw).to_owned()
                };
                if updated != raw {
                    transaction
                        .execute(
                            &format!("UPDATE \"{quoted}\" SET \"{col}\"=?1 WHERE rowid=?2"),
                            rusqlite::params![updated, rowid],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    fs::write(
        backup.join("migration-map.json"),
        serde_json::to_vec_pretty(&replacements).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    let map_path = state.core.data_dir.join("storage-migration-map.json");
    let mut all_replacements: BTreeMap<String, String> = fs::read(&map_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    all_replacements.extend(replacements);
    fs::write(
        &map_path,
        serde_json::to_vec_pretty(&all_replacements).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Preserve the old directory with the backup; it is no longer active storage.
    let mut settings = settings;
    normalize_settings(state, &mut settings);
    super::settings::write(&state.core.data_dir, &settings).map_err(|e| e.to_string())?;
    if legacy.is_dir() {
        fs::rename(&legacy, backup.join("legacy-media"))
            .map_err(|e| format!("引用已迁移，但旧素材归档失败：{e}"))?;
    }
    if restored_inputs.is_dir() {
        fs::rename(&restored_inputs, backup.join("restored-inputs")).map_err(|e| e.to_string())?;
    }
    Ok(json!({"migrated": true, "nodes": changed_nodes, "backup": backup.to_string_lossy()}))
}

fn restore_inputs(directory: &Path, base: &Path, input: &Path) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        rpc::ensure_contained(&path, &[base.to_owned()])?;
        if path.is_dir() {
            restore_inputs(&path, base, input)?;
        } else {
            let relative = path.strip_prefix(base).map_err(|e| e.to_string())?;
            if !relative.starts_with(IMPORT_FOLDER) {
                return Err("备份输入素材目录无效".into());
            }
            verified_copy(&path, &input.join(relative), input)?;
        }
    }
    Ok(())
}
