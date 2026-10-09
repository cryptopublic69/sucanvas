use super::{config::Config, WebState};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Connection {
    comfy_url: String,
    comfy_input_directory: String,
    comfy_output_directory: String,
}
impl Connection {
    fn from_config(config: &Config) -> Self {
        Self {
            comfy_url: config.comfy_url.clone(),
            comfy_input_directory: config.comfy_input_directory.clone(),
            comfy_output_directory: config.comfy_output_directory.clone(),
        }
    }
    fn apply(&self, config: &mut Config) {
        config.comfy_url = self.comfy_url.clone();
        config.comfy_input_directory = self.comfy_input_directory.clone();
        config.comfy_output_directory = self.comfy_output_directory.clone();
    }
}

pub(super) fn resolve_directories(config: &mut Config, root: &Path) -> Result<(), String> {
    for (label, directory) in [
        ("ComfyUI 输入映射目录", &mut config.comfy_input_directory),
        ("ComfyUI 输出映射目录", &mut config.comfy_output_directory),
    ] {
        if directory.is_empty() {
            continue;
        }
        let path = Config::directory(root, directory);
        if !path.is_dir() {
            return Err(format!(
                "{label}不存在或无法访问，请填写 Web 服务器上的可访问目录"
            ));
        }
        *directory = path
            .canonicalize()
            .map_err(|e| format!("{label}：{e}"))?
            .to_string_lossy()
            .into_owned();
    }
    Ok(())
}

// Each request keeps a snapshot so an in-flight generation retains its endpoint.
pub(super) struct Store {
    path: PathBuf,
    current: RwLock<Arc<Config>>,
}
impl Store {
    pub fn new(path: PathBuf, config: Config) -> Self {
        Self {
            path,
            current: RwLock::new(Arc::new(config)),
        }
    }
    pub fn snapshot(&self) -> Arc<Config> {
        self.current.read().expect("connection lock").clone()
    }
    fn save(&self, mut input: Connection) -> Result<Connection, String> {
        input.comfy_url = input
            .comfy_url
            .trim()
            .trim_matches('"')
            .trim_end_matches('/')
            .to_owned();
        for directory in [
            &mut input.comfy_input_directory,
            &mut input.comfy_output_directory,
        ] {
            *directory = directory.trim().trim_matches('"').to_owned();
        }
        super::config::validate_comfy_url(&input.comfy_url)?;
        let mut current = self.current.write().map_err(|_| "无法锁定 ComfyUI 配置")?;
        if let Ok(url) = reqwest::Url::parse(&input.comfy_url) {
            if url.origin().ascii_serialization() == current.origin()
                && url.path().starts_with("/api/comfy")
            {
                return Err("请填写实际的 ComfyUI 服务地址，不能填写画布代理地址".into());
            }
        }
        let root = self.path.parent().ok_or("配置文件目录不存在")?;
        let mut updated = (**current).clone();
        input.apply(&mut updated);
        resolve_directories(&mut updated, root)?;
        // Preserve other fields and relative paths in the portable config file.
        let mut disk_config = Config::read(&self.path)?;
        input.apply(&mut disk_config);
        let bytes = serde_json::to_vec_pretty(&disk_config).map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4();
        let backup = root.join(format!("config.before-comfy-{id}.json"));
        let temporary = root.join(format!("config.comfy-{id}.new"));
        fs::copy(&self.path, &backup).map_err(|e| format!("备份服务器配置失败：{e}"))?;
        let result = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.path)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(format!("保存服务器配置失败：{error}"));
        }
        let result = Connection::from_config(&updated);
        *current = Arc::new(updated);
        Ok(result)
    }
}

pub(super) async fn read(State(state): State<WebState>) -> Json<Connection> {
    Json(Connection::from_config(&state.connection.snapshot()))
}
pub(super) async fn write(
    State(state): State<WebState>,
    Json(input): Json<Connection>,
) -> Response {
    match state.connection.save(input) {
        Ok(saved) => Json(saved).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!("web-connection-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("input")).unwrap();
        fs::create_dir_all(root.join("output")).unwrap();
        let config = Config {
            listen: "127.0.0.1:18742".parse().unwrap(),
            public_url: "http://127.0.0.1:18742".into(),
            data_directory: "data".into(),
            web_directory: "web".into(),
            downloads_directory: "downloads".into(),
            max_upload_bytes: 12345,
            comfy_url: "http://127.0.0.1:8188".into(),
            comfy_input_directory: String::new(),
            comfy_output_directory: String::new(),
        };
        let path = root.join("config.json");
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        (root, Store::new(path, config))
    }

    #[test]
    fn save_is_live_portable_and_preserves_in_flight_snapshot_and_original_config() {
        let (root, store) = fixture();
        let old = store.snapshot();
        let original = fs::read(root.join("config.json")).unwrap();
        let saved = store
            .save(Connection {
                comfy_url: " http://192.168.5.108:8188/comfy/// ".into(),
                comfy_input_directory: "input".into(),
                comfy_output_directory: "output".into(),
            })
            .unwrap();
        assert_eq!(saved.comfy_url, "http://192.168.5.108:8188/comfy");
        assert_eq!(old.comfy_url, "http://127.0.0.1:8188");
        assert_eq!(store.snapshot().comfy_url, saved.comfy_url);
        assert_eq!(
            saved.comfy_input_directory,
            root.join("input").canonicalize().unwrap().to_string_lossy()
        );
        let disk = Config::read(&root.join("config.json")).unwrap();
        assert_eq!(disk.comfy_input_directory, "input");
        assert_eq!(disk.comfy_output_directory, "output");
        assert_eq!(disk.data_directory, "data");
        assert_eq!(disk.max_upload_bytes, 12345);
        assert_eq!(disk.comfy_url, saved.comfy_url);
        let backup = fs::read_dir(&root)
            .unwrap()
            .map(|item| item.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("config.before-comfy-")
            })
            .unwrap();
        assert_eq!(fs::read(backup).unwrap(), original);
        let mut restarted = disk;
        resolve_directories(&mut restarted, &root).unwrap();
        assert_eq!(restarted.comfy_input_directory, saved.comfy_input_directory);
        // Both mappings can be cleared without restarting the server.
        let saved = store
            .save(Connection {
                comfy_url: saved.comfy_url,
                comfy_input_directory: String::new(),
                comfy_output_directory: String::new(),
            })
            .unwrap();
        assert!(saved.comfy_input_directory.is_empty());
        assert!(store.snapshot().comfy_output_directory.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_address_or_directory_preserves_disk_and_runtime() {
        let (root, store) = fixture();
        let original = fs::read(root.join("config.json")).unwrap();
        for url in [
            "ftp://host",
            "http://user:pass@host",
            "http://host?token=x",
            "http://host#x",
            "http://127.0.0.1:18742/api/comfy",
        ] {
            let mut input = Connection::from_config(&store.snapshot());
            input.comfy_url = url.into();
            assert!(store.save(input).is_err());
        }
        for directory in ["missing", "config.json"] {
            let mut input = Connection::from_config(&store.snapshot());
            input.comfy_input_directory = directory.into();
            assert!(store.save(input).is_err());
        }
        assert_eq!(fs::read(root.join("config.json")).unwrap(), original);
        assert_eq!(store.snapshot().comfy_url, "http://127.0.0.1:8188");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_persistence_does_not_publish_new_runtime_connection() {
        let (root, store) = fixture();
        fs::remove_file(root.join("config.json")).unwrap();
        let mut input = Connection::from_config(&store.snapshot());
        input.comfy_url = "http://192.168.5.108:8188".into();
        assert!(store.save(input).is_err());
        assert_eq!(store.snapshot().comfy_url, "http://127.0.0.1:8188");
        fs::remove_dir_all(root).unwrap();
    }
}
