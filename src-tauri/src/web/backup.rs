use super::{rpc, WebState};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn inputs(directory: &Path, root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        rpc::ensure_contained(&path, &[root.to_owned()])?;
        if fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("导入素材备份不支持符号链接".into());
        }
        if path.is_dir() {
            inputs(&path, root, files)?;
        } else {
            files.push(path);
        }
    }
    Ok(())
}

// Extend only the Web backup. Desktop's exporter and archive format stay intact.
pub fn append_imported_inputs(state: &WebState, result: &mut Value) -> Result<(), String> {
    let root = &state.core.assets_dir;
    if !root.is_dir() {
        return Ok(());
    }
    let path = PathBuf::from(result["path"].as_str().ok_or("备份结果缺少文件路径")?);
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut files = Vec::new();
    inputs(root, root, &mut files)?;
    if files.is_empty() {
        return Ok(());
    }
    let augmentation = (|| {
        fs::copy(&path, &temporary).map_err(|e| e.to_string())?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut archive = ZipWriter::new_append(file).map_err(|e| e.to_string())?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        let mut total = 0u64;
        for source in &files {
            let relative = source
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            archive
                .start_file(
                    format!("data/comfy-input/sucanvas-imports/{relative}"),
                    options,
                )
                .map_err(|e| e.to_string())?;
            let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 65536];
            loop {
                let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                archive
                    .write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
                total += count as u64;
            }
        }
        archive
            .finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        result["totalBytes"] = Value::from(result["totalBytes"].as_u64().unwrap_or(0) + total);
        result["fileCount"] =
            Value::from(result["fileCount"].as_u64().unwrap_or(0) + files.len() as u64);
        Ok(())
    })();
    if augmentation.is_err() {
        let _ = fs::remove_file(temporary);
    }
    augmentation
}
