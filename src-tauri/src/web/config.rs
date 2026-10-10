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
    #[serde(default)]
    pub allowed_origins: Vec<String>,
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
pub(super) fn validate_comfy_url(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    let invalid = "ComfyUI 服务地址无效，请填写不含账号、查询参数的 HTTP(S) 地址";
    let url = reqwest::Url::parse(value).map_err(|_| invalid.to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid.into());
    }
    Ok(())
}
impl Config {
    pub fn read(path: &Path) -> Result<Self, String> {
        let mut config: Self =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
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
        validate_comfy_url(&config.comfy_url)?;
        for origin in &mut config.allowed_origins {
            let url =
                reqwest::Url::parse(origin).map_err(|e| format!("Invalid allowedOrigins: {e}"))?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || url.host_str().is_some_and(|host| host.contains('*'))
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("allowedOrigins must contain explicit HTTPS origins without credentials, paths or wildcards".into());
            }
            *origin = url.origin().ascii_serialization();
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
    pub fn allows_origin(&self, origin: &str) -> bool {
        origin == self.origin() || self.allowed_origins.iter().any(|allowed| allowed == origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_config(allowed: Option<serde_json::Value>) -> Result<Config, String> {
        let path = std::env::temp_dir().join(format!("web-origins-{}.json", uuid::Uuid::new_v4()));
        let mut value = json!({
            "listen": "127.0.0.1:18740", "publicUrl": "https://canvas.example.com:8888",
            "dataDirectory": "data", "webDirectory": "web", "downloadsDirectory": "downloads"
        });
        if let Some(allowed) = allowed {
            value["allowedOrigins"] = allowed;
        }
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let result = Config::read(&path);
        std::fs::remove_file(path).unwrap();
        result
    }

    #[test]
    fn existing_config_remains_public_only() {
        let config = read_config(None).unwrap();
        assert!(config.allows_origin("https://canvas.example.com:8888"));
        assert!(!config.allows_origin("https://192.168.5.108:18741"));
        assert!(!config.allows_origin("null"));
    }

    #[test]
    fn public_and_explicit_lan_origins_are_allowed_with_exact_scheme_host_and_port() {
        let config = read_config(Some(json!(["https://192.168.5.108:18741/"]))).unwrap();
        assert!(config.allows_origin("https://canvas.example.com:8888"));
        assert!(config.allows_origin("https://192.168.5.108:18741"));
        for origin in [
            "https://192.168.5.108",
            "http://192.168.5.108:18741",
            "https://192.168.5.109:18741",
            "https://untrusted.invalid",
            "null",
        ] {
            assert!(!config.allows_origin(origin), "{origin}");
        }
        assert!(config.secure_cookie());
    }

    #[test]
    fn additional_origins_reject_insecure_or_non_origin_values() {
        for origin in [
            "*",
            "https://*.example.com",
            "null",
            "http://192.168.5.108:18741",
            "https://192.168.5.108:18741/api",
            "https://user:password@192.168.5.108:18741",
            "https://192.168.5.108:18741?query=1",
            "https://192.168.5.108:18741#fragment",
        ] {
            assert!(read_config(Some(json!([origin]))).is_err(), "{origin}");
        }
    }
}
