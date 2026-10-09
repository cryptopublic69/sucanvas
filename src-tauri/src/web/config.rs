use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub listen: SocketAddr,
    pub public_url: String,
    pub data_directory: String,
    pub web_directory: String,
    pub downloads_directory: String,
    #[serde(default)]
    pub comfy_url: String,
    #[serde(default)]
    pub comfy_input_directory: String,
    #[serde(default)]
    pub comfy_output_directory: String,
    #[serde(default = "default_upload")]
    pub max_upload_bytes: usize,
}
fn default_upload() -> usize {
    1024 * 1024 * 1024
}
impl Config {
    pub fn read(path: &Path) -> Result<Self, String> {
        let config: Self = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let url = reqwest::Url::parse(&config.public_url).map_err(|e| e.to_string())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("publicUrl must be an HTTP(S) origin without a path".into());
        }
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.scheme() != "https" && (!local || !config.listen.ip().is_loopback()) {
            return Err("Public deployment requires an HTTPS publicUrl. Place a TLS reverse proxy in front of the server.".into());
        }
        if !config.comfy_url.is_empty() {
            let comfy = reqwest::Url::parse(&config.comfy_url).map_err(|e| e.to_string())?;
            if !matches!(comfy.scheme(), "http" | "https")
                || comfy.host_str().is_none()
                || comfy.query().is_some()
                || comfy.fragment().is_some()
            {
                return Err("Invalid comfyUrl".into());
            }
        }
        if config.max_upload_bytes == 0 || config.max_upload_bytes > 16 * 1024 * 1024 * 1024usize {
            return Err("maxUploadBytes must be between 1 byte and 16 GiB".into());
        }
        Ok(config)
    }
    pub fn directory(root: &Path, value: &str) -> PathBuf {
        let path = Path::new(value);
        if path.is_absolute() {
            path.to_owned()
        } else {
            root.join(path)
        }
    }
    pub fn origin(&self) -> String {
        reqwest::Url::parse(&self.public_url)
            .expect("validated publicUrl")
            .origin()
            .ascii_serialization()
    }
    pub fn secure_cookie(&self) -> bool {
        reqwest::Url::parse(&self.public_url)
            .expect("validated publicUrl")
            .scheme()
            == "https"
    }
}
