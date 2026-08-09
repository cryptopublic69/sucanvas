use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::db::Database;

const BACKUP_FORMAT: &str = "sucanvas-full-backup";
const BACKUP_FORMAT_VERSION: u32 = 1;
const BACKUP_EXTENSION: &str = "sucanvas-backup";
const MANIFEST_ENTRY: &str = "backup-manifest.json";
const SETTINGS_ENTRY: &str = "frontend-settings.json";
const DATABASE_FILE: &str = "infinite-canvas.sqlite3";
const RESTORED_SETTINGS_FILE: &str = "restored-frontend-settings.json";
const PENDING_DIRECTORY: &str = "data.restore-pending";
const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BACKUP_FILES: usize = 1_000_000;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: String,
    format_version: u32,
    app_version: String,
    created_at: String,
    source_data_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub path: String,
    pub created_at: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub created_at: String,
    pub source_app_version: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub requires_restart: bool,
}

fn normalized_destination(path: &Path) -> PathBuf {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(BACKUP_EXTENSION))
    {
        path.to_owned()
    } else {
        let mut path = path.to_owned();
        path.set_extension(BACKUP_EXTENSION);
        path
    }
}

fn destination_is_inside_data_dir(destination: &Path, data_dir: &Path) -> bool {
    let Some(parent) = destination.parent() else {
        return false;
    };
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    let Ok(data_dir) = data_dir.canonicalize() else {
        return false;
    };
    parent.starts_with(data_dir)
}

fn archive_name(relative: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            _ => return Err(format!("备份文件路径无效：{}", relative.display())),
        }
    }
    Ok(format!("data/{}", parts.join("/")))
}

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| format!("读取数据目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取数据目录项失败：{error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取数据文件类型失败：{error}"))?;
        if file_type.is_symlink() {
            return Err(format!("数据目录包含不支持的符号链接：{}", path.display()));
        }
        if file_type.is_dir() {
            collect_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| format!("数据文件超出数据目录：{}", path.display()))?;
            if relative == Path::new(DATABASE_FILE)
                || relative == Path::new("api.json")
                || relative == Path::new(RESTORED_SETTINGS_FILE)
            {
                continue;
            }
            files.push(path);
            if files.len() > MAX_BACKUP_FILES {
                return Err("备份文件数量超过安全限制".to_owned());
            }
        }
    }
    Ok(())
}

fn add_file(
    archive: &mut ZipWriter<fs::File>,
    archive_path: &str,
    source: &Path,
    options: SimpleFileOptions,
) -> Result<u64, String> {
    let mut file = fs::File::open(source)
        .map_err(|error| format!("读取备份文件 {} 失败：{error}", source.display()))?;
    let size = file
        .metadata()
        .map_err(|error| format!("读取备份文件信息失败：{error}"))?
        .len();
    archive
        .start_file(archive_path, options)
        .map_err(|error| format!("创建备份条目 {archive_path} 失败：{error}"))?;
    io::copy(&mut file, archive)
        .map_err(|error| format!("写入备份条目 {archive_path} 失败：{error}"))?;
    Ok(size)
}

fn file_options(source: &Path) -> SimpleFileOptions {
    let already_compressed = source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "7z" | "avi"
                    | "flac"
                    | "gif"
                    | "jpeg"
                    | "jpg"
                    | "m4a"
                    | "mkv"
                    | "mov"
                    | "mp3"
                    | "mp4"
                    | "png"
                    | "rar"
                    | "webm"
                    | "webp"
                    | "zip"
            )
        });
    SimpleFileOptions::default()
        .compression_method(if already_compressed {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        })
        .unix_permissions(0o644)
}

pub fn export(
    data_dir: &Path,
    database: &Database,
    destination: &Path,
    frontend_settings: &BTreeMap<String, String>,
) -> Result<BackupSummary, String> {
    let destination = normalized_destination(destination);
    if destination_is_inside_data_dir(&destination, data_dir) {
        return Err("软件备份不能保存在 data 数据目录内部，请选择其他目录".to_owned());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "备份目标路径无效".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建备份目标目录失败：{error}"))?;

    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("SuCanvas.sucanvas-backup");
    let temporary_archive = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4().simple()));
    let temporary_database = parent.join(format!(
        ".sucanvas-database-{}.sqlite3",
        Uuid::new_v4().simple()
    ));
    let created_at = Utc::now().to_rfc3339();

    let result = (|| -> Result<BackupSummary, String> {
        database
            .backup_to(&temporary_database)
            .map_err(|error| format!("创建数据库一致性快照失败：{error}"))?;
        let mut files = Vec::new();
        collect_files(data_dir, data_dir, &mut files)?;
        files.sort();

        let manifest = BackupManifest {
            format: BACKUP_FORMAT.to_owned(),
            format_version: BACKUP_FORMAT_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            created_at: created_at.clone(),
            source_data_dir: data_dir.to_string_lossy().into_owned(),
        };
        let archive_file = fs::File::create(&temporary_archive)
            .map_err(|error| format!("创建软件备份失败：{error}"))?;
        let mut archive = ZipWriter::new(archive_file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);

        archive
            .start_file(MANIFEST_ENTRY, options)
            .map_err(|error| format!("写入备份描述失败：{error}"))?;
        archive
            .write_all(
                &serde_json::to_vec_pretty(&manifest)
                    .map_err(|error| format!("序列化备份描述失败：{error}"))?,
            )
            .map_err(|error| format!("写入备份描述失败：{error}"))?;
        archive
            .start_file(SETTINGS_ENTRY, options)
            .map_err(|error| format!("写入软件设置失败：{error}"))?;
        archive
            .write_all(
                &serde_json::to_vec_pretty(frontend_settings)
                    .map_err(|error| format!("序列化软件设置失败：{error}"))?,
            )
            .map_err(|error| format!("写入软件设置失败：{error}"))?;

        let mut total_bytes = add_file(
            &mut archive,
            "data/infinite-canvas.sqlite3",
            &temporary_database,
            options,
        )?;
        for source in &files {
            let relative = source
                .strip_prefix(data_dir)
                .map_err(|_| format!("数据文件超出数据目录：{}", source.display()))?;
            let name = archive_name(relative)?;
            total_bytes = total_bytes
                .checked_add(add_file(&mut archive, &name, source, file_options(source))?)
                .ok_or_else(|| "备份数据大小溢出".to_owned())?;
        }
        archive
            .finish()
            .map_err(|error| format!("完成软件备份失败：{error}"))?;

        if destination.exists() {
            fs::remove_file(&destination).map_err(|error| format!("替换已有备份失败：{error}"))?;
        }
        fs::rename(&temporary_archive, &destination)
            .map_err(|error| format!("保存软件备份失败：{error}"))?;
        Ok(BackupSummary {
            path: destination.to_string_lossy().into_owned(),
            created_at: created_at.clone(),
            file_count: files.len() + 1,
            total_bytes,
        })
    })();

    let _ = fs::remove_file(&temporary_database);
    if result.is_err() {
        let _ = fs::remove_file(&temporary_archive);
    }
    result
}

fn read_metadata_entry(
    archive: &mut ZipArchive<fs::File>,
    name: &str,
    required: bool,
) -> Result<Option<Vec<u8>>, String> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) if !required => return Ok(None),
        Err(zip::result::ZipError::FileNotFound) => {
            return Err(format!("软件备份缺少 {name}"));
        }
        Err(error) => return Err(format!("读取软件备份中的 {name} 失败：{error}")),
    };
    if entry.is_dir() || entry.size() > MAX_METADATA_BYTES {
        return Err(format!("软件备份中的 {name} 无效"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取软件备份中的 {name} 失败：{error}"))?;
    Ok(Some(bytes))
}

fn validate_archive_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("软件备份包含空的数据路径".to_owned());
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("软件备份包含不安全路径：{}", path.display()));
    }
    Ok(())
}

pub fn stage_restore(data_dir: &Path, bundle_path: &Path) -> Result<RestoreSummary, String> {
    if !bundle_path.is_file() {
        return Err("选择的软件备份文件不存在".to_owned());
    }
    let data_parent = data_dir
        .parent()
        .ok_or_else(|| "当前数据目录无效".to_owned())?;
    fs::create_dir_all(data_parent).map_err(|error| format!("创建数据目录失败：{error}"))?;
    let pending = data_parent.join(PENDING_DIRECTORY);
    if pending.exists() {
        return Err("已有一个等待重启恢复的软件备份，请先重新启动软件".to_owned());
    }
    let staging = data_parent.join(format!(".data.restore-staging-{}", Uuid::new_v4().simple()));

    let result = (|| -> Result<RestoreSummary, String> {
        fs::create_dir(&staging).map_err(|error| format!("创建恢复暂存目录失败：{error}"))?;
        let file =
            fs::File::open(bundle_path).map_err(|error| format!("打开软件备份失败：{error}"))?;
        let mut archive =
            ZipArchive::new(file).map_err(|error| format!("解析软件备份失败：{error}"))?;
        if archive.len() > MAX_BACKUP_FILES + 2 {
            return Err("软件备份文件数量超过安全限制".to_owned());
        }
        let manifest_bytes = read_metadata_entry(&mut archive, MANIFEST_ENTRY, true)?.unwrap();
        let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("解析软件备份描述失败：{error}"))?;
        if manifest.format != BACKUP_FORMAT || manifest.format_version != BACKUP_FORMAT_VERSION {
            return Err("这不是当前版本支持的 SuCanvas 软件备份".to_owned());
        }
        let settings = read_metadata_entry(&mut archive, SETTINGS_ENTRY, false)?
            .map(|bytes| {
                serde_json::from_slice::<BTreeMap<String, String>>(&bytes)
                    .map_err(|error| format!("解析备份中的软件设置失败：{error}"))
            })
            .transpose()?
            .unwrap_or_default();

        let mut file_count = 0usize;
        let mut total_bytes = 0u64;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("读取软件备份条目失败：{error}"))?;
            let name = entry.name().replace('\\', "/");
            if name == MANIFEST_ENTRY || name == SETTINGS_ENTRY {
                continue;
            }
            let Some(relative_name) = name.strip_prefix("data/") else {
                return Err(format!("软件备份包含未知条目：{name}"));
            };
            let relative = Path::new(relative_name);
            validate_archive_relative_path(relative)?;
            if relative == Path::new("api.json") || relative == Path::new(RESTORED_SETTINGS_FILE) {
                continue;
            }
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(format!("软件备份包含不支持的符号链接：{name}"));
            }
            total_bytes = total_bytes
                .checked_add(entry.size())
                .ok_or_else(|| "恢复数据大小溢出".to_owned())?;
            if total_bytes > MAX_EXTRACTED_BYTES {
                return Err("软件备份展开后超过 2 TB 安全限制".to_owned());
            }
            let destination = staging.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&destination)
                    .map_err(|error| format!("创建恢复目录失败：{error}"))?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败：{error}"))?;
            }
            let mut output = fs::File::create(&destination)
                .map_err(|error| format!("创建恢复文件失败：{error}"))?;
            io::copy(&mut entry, &mut output)
                .map_err(|error| format!("展开恢复文件失败：{error}"))?;
            output
                .flush()
                .map_err(|error| format!("保存恢复文件失败：{error}"))?;
            file_count += 1;
        }

        let database_path = staging.join(DATABASE_FILE);
        if !database_path.is_file() {
            return Err("软件备份缺少项目数据库".to_owned());
        }
        let restored_database = Database::open(&database_path)
            .map_err(|error| format!("打开备份数据库失败：{error}"))?;
        restored_database
            .verify_integrity()
            .map_err(|error| format!("备份数据库完整性校验失败：{error}"))?;
        if !manifest.source_data_dir.trim().is_empty() {
            restored_database
                .rewrite_asset_paths(
                    &PathBuf::from(&manifest.source_data_dir).join("assets"),
                    &data_dir.join("assets"),
                )
                .map_err(|error| format!("更新恢复素材路径失败：{error}"))?;
        }
        drop(restored_database);
        fs::write(
            staging.join(RESTORED_SETTINGS_FILE),
            serde_json::to_vec_pretty(&settings)
                .map_err(|error| format!("序列化恢复设置失败：{error}"))?,
        )
        .map_err(|error| format!("保存恢复设置失败：{error}"))?;
        fs::rename(&staging, &pending).map_err(|error| format!("准备待恢复数据失败：{error}"))?;

        Ok(RestoreSummary {
            created_at: manifest.created_at,
            source_app_version: manifest.app_version,
            file_count,
            total_bytes,
            requires_restart: true,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

pub fn pending_directory(data_dir: &Path) -> Result<PathBuf, io::Error> {
    let parent = data_dir
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "data path has no parent"))?;
    Ok(parent.join(PENDING_DIRECTORY))
}

pub fn restored_settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RESTORED_SETTINGS_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CreateNodeInput, DEFAULT_CANVAS_ID};
    use serde_json::json;

    #[test]
    fn exports_and_stages_a_complete_portable_restore() {
        let root = std::env::temp_dir().join(format!(
            "sucanvas-full-backup-test-{}",
            Uuid::new_v4().simple()
        ));
        let source_data = root.join("source").join("data");
        let target_data = root.join("target").join("data");
        let source_assets = source_data.join("assets");
        fs::create_dir_all(&source_assets).unwrap();
        fs::create_dir_all(source_data.join("workflow-modules").join("module-one")).unwrap();
        fs::write(source_assets.join("image.png"), b"image-bytes").unwrap();
        fs::write(
            source_data
                .join("workflow-modules")
                .join("module-one")
                .join("manifest.json"),
            b"{}",
        )
        .unwrap();
        fs::write(source_data.join("app-lock.json"), b"lock-config").unwrap();
        fs::write(source_data.join("api.json"), b"ephemeral-token").unwrap();

        let source_database = Database::open(&source_data.join(DATABASE_FILE)).unwrap();
        source_database
            .create_node(CreateNodeInput {
                canvas_id: None,
                kind: Some("image".to_owned()),
                title: "Portable image".to_owned(),
                content: json!({
                    "assetPath": source_assets.join("image.png").to_string_lossy()
                }),
                source: Some("test".to_owned()),
                request_id: Some("portable-backup-node".to_owned()),
                x: None,
                y: None,
                width: None,
                height: None,
            })
            .unwrap();
        let mut settings = BTreeMap::new();
        settings.insert("infinite-canvas:theme".to_owned(), "light".to_owned());
        let bundle = root.join("portable-backup.sucanvas-backup");

        let exported = export(&source_data, &source_database, &bundle, &settings).unwrap();
        assert_eq!(Path::new(&exported.path), bundle);
        assert!(exported.file_count >= 4);
        let restored = stage_restore(&target_data, &bundle).unwrap();
        assert!(restored.requires_restart);

        let pending = pending_directory(&target_data).unwrap();
        assert!(pending.join("assets").join("image.png").is_file());
        assert!(pending
            .join("workflow-modules")
            .join("module-one")
            .join("manifest.json")
            .is_file());
        assert!(pending.join("app-lock.json").is_file());
        assert!(!pending.join("api.json").exists());
        let restored_settings = fs::read(restored_settings_path(&pending)).unwrap();
        assert_eq!(
            serde_json::from_slice::<BTreeMap<String, String>>(&restored_settings)
                .unwrap()
                .get("infinite-canvas:theme")
                .map(String::as_str),
            Some("light")
        );
        let restored_database = Database::open(&pending.join(DATABASE_FILE)).unwrap();
        restored_database.verify_integrity().unwrap();
        let workspace = restored_database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(workspace.nodes.len(), 1);
        assert_eq!(
            workspace.nodes[0].content["assetPath"],
            json!(target_data
                .join("assets")
                .join("image.png")
                .to_string_lossy())
        );

        drop(restored_database);
        drop(source_database);
        fs::remove_dir_all(root).unwrap();
    }
}
