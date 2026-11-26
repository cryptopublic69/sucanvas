use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    JimengCn,
    DreaminaJp,
    Libtv,
    Lovart,
}

impl ProviderId {
    pub const ALL: [ProviderId; 4] = [
        ProviderId::JimengCn,
        ProviderId::DreaminaJp,
        ProviderId::Libtv,
        ProviderId::Lovart,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::JimengCn => "jimeng-cn",
            ProviderId::DreaminaJp => "dreamina-jp",
            ProviderId::Libtv => "libtv",
            ProviderId::Lovart => "lovart",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProviderId::JimengCn => "即梦（国区）",
            ProviderId::DreaminaJp => "即梦（日区）",
            ProviderId::Libtv => "LibTV",
            ProviderId::Lovart => "Lovart",
        }
    }

    pub fn from_str(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "jimeng-cn" | "jimeng" | "cn" => Some(ProviderId::JimengCn),
            "dreamina-jp" | "dreamina" | "jp" => Some(ProviderId::DreaminaJp),
            "libtv" => Some(ProviderId::Libtv),
            "lovart" => Some(ProviderId::Lovart),
            _ => None,
        }
    }

    pub fn dreamina_profile_args(self) -> &'static [&'static str] {
        match self {
            ProviderId::JimengCn => &["--profile", "cn"],
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalVideoModelSpec {
    pub id: String,
    pub label: String,
    pub series: String,
    pub resolutions: Vec<String>,
    pub default_resolution: String,
    pub min_duration: i64,
    pub max_duration: i64,
    pub default_duration: i64,
    pub aspect_ratios: Vec<String>,
    pub modes: Vec<String>,
    pub supports_audio_toggle: bool,
    pub max_images: usize,
    pub max_videos: usize,
    pub max_audios: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatusSnapshot {
    pub provider: ProviderId,
    pub label: String,
    pub installed: bool,
    pub logged_in: bool,
    pub ready: bool,
    pub status_text: String,
    pub error: Option<String>,
    pub binary_path: Option<String>,
    pub models: Vec<ExternalVideoModelSpec>,
}

fn default_ratios() -> Vec<String> {
    vec![
        "21:9".into(),
        "16:9".into(),
        "4:3".into(),
        "1:1".into(),
        "3:4".into(),
        "9:16".into(),
    ]
}

fn dreamina_modes() -> Vec<String> {
    vec![
        "auto".into(),
        "t2v".into(),
        "first_last_frame".into(),
        "m2v".into(),
    ]
}

fn libtv_modes() -> Vec<String> {
    vec![
        "auto".into(),
        "text2video".into(),
        "singleImage2video".into(),
        "frames2video".into(),
        "image2video".into(),
        "mixed2video".into(),
    ]
}

fn lovart_modes() -> Vec<String> {
    vec!["auto".into()]
}

fn model_spec(
    id: &str,
    label: &str,
    series: &str,
    resolutions: &[&str],
    default_resolution: &str,
    min_duration: i64,
    max_duration: i64,
    default_duration: i64,
    modes: Vec<String>,
    supports_audio_toggle: bool,
    max_images: usize,
    max_videos: usize,
    max_audios: usize,
) -> ExternalVideoModelSpec {
    ExternalVideoModelSpec {
        id: id.to_owned(),
        label: label.to_owned(),
        series: series.to_owned(),
        resolutions: resolutions.iter().map(|s| (*s).to_owned()).collect(),
        default_resolution: default_resolution.to_owned(),
        min_duration,
        max_duration,
        default_duration,
        aspect_ratios: default_ratios(),
        modes,
        supports_audio_toggle,
        max_images,
        max_videos,
        max_audios,
    }
}

pub fn models_for_provider(provider: ProviderId) -> Vec<ExternalVideoModelSpec> {
    match provider {
        ProviderId::JimengCn => vec![
            model_spec("seedance_2.5", "Seedance 2.5", "2.5", &["480p", "720p", "1080p", "4k"], "720p", 4, 30, 5, dreamina_modes(), false, 30, 10, 10),
            model_spec("seedance_2.5_flash", "Seedance 2.5 Flash", "2.5", &["480p", "720p"], "720p", 4, 30, 5, dreamina_modes(), false, 10, 5, 5),
            model_spec("seedance_2.5_draft", "Seedance 2.5 Draft（样片）", "2.5", &["480p"], "480p", 4, 30, 5, dreamina_modes(), false, 30, 10, 10),
            model_spec("seedance_2.0_vip", "Seedance 2.0 VIP", "2.0", &["720p", "1080p", "4K"], "720p", 4, 15, 5, dreamina_modes(), false, 9, 3, 3),
            model_spec("seedance_2.0_fast_vip", "Seedance 2.0 Fast VIP", "2.0", &["720p"], "720p", 4, 15, 5, dreamina_modes(), false, 9, 3, 3),
            model_spec("seedance_2.0_mini", "Seedance 2.0 Mini", "2.0", &["720p"], "720p", 4, 15, 5, dreamina_modes(), false, 9, 3, 3),
        ],
        ProviderId::DreaminaJp => vec![
            model_spec("seedance_2.5", "Seedance 2.5", "2.5", &["480p", "720p", "1080p", "4k"], "720p", 4, 30, 5, dreamina_modes(), false, 30, 10, 10),
            model_spec("seedance_2.5_flash", "Seedance 2.5 Flash", "2.5", &["480p", "720p"], "720p", 4, 30, 5, dreamina_modes(), false, 10, 5, 5),
            model_spec("seedance_2.5_draft", "Seedance 2.5 Draft", "2.5", &["480p"], "480p", 4, 30, 5, dreamina_modes(), false, 30, 10, 10),
            model_spec("seedance_2.0", "Seedance 2.0", "2.0", &["720p", "1080p", "4K"], "720p", 4, 15, 5, dreamina_modes(), false, 9, 3, 3),
            model_spec("seedance_2.0_fast", "Seedance 2.0 Fast", "2.0", &["720p"], "720p", 4, 15, 5, dreamina_modes(), false, 9, 3, 3),
            model_spec("seedance_2.0_mini", "Seedance 2.0 Mini", "2.0", &["720p"], "720p", 4, 15, 5, dreamina_modes(), false, 9, 3, 3),
        ],
        ProviderId::Libtv => vec![
            model_spec("Seedance 2.5", "Seedance 2.5", "2.5", &["480p", "720p", "1080p", "4k"], "720p", 4, 30, 5, libtv_modes(), true, 30, 10, 10),
            model_spec("Seedance 2.5 Flash", "Seedance 2.5 Flash", "2.5", &["480p", "720p"], "720p", 4, 30, 5, libtv_modes(), true, 10, 5, 5),
            model_spec("Seedance 2.5（样片模式）", "Seedance 2.5（样片模式）", "2.5", &["480p"], "480p", 4, 30, 5, libtv_modes(), true, 30, 10, 10),
            model_spec("Seedance 2.0 VIP", "Seedance 2.0 VIP", "2.0", &["480p", "720p"], "720p", 4, 15, 5, libtv_modes(), true, 9, 3, 3),
            model_spec("Seedance 2.0 Fast VIP", "Seedance 2.0 Fast VIP", "2.0", &["480p", "720p"], "720p", 4, 15, 5, libtv_modes(), true, 9, 3, 3),
            model_spec("Seedance 2.0 Mini", "Seedance 2.0 Mini", "2.0", &["480p", "720p"], "720p", 4, 15, 5, libtv_modes(), true, 9, 3, 3),
        ],
        ProviderId::Lovart => vec![
            model_spec("generate_video_seedance_v2_5", "Seedance 2.5", "2.5", &["auto"], "auto", 4, 15, 5, lovart_modes(), false, 9, 0, 0),
            model_spec("generate_video_seedance_v2_5_flash", "Seedance 2.5 Flash", "2.5", &["auto"], "auto", 4, 15, 5, lovart_modes(), false, 9, 0, 0),
            model_spec("generate_video_seedance_v2_0", "Seedance 2.0", "2.0", &["auto"], "auto", 4, 15, 5, lovart_modes(), false, 9, 0, 0),
            model_spec("generate_video_seedance_v2_0_fast", "Seedance 2.0 Fast", "2.0", &["auto"], "auto", 4, 15, 5, lovart_modes(), false, 9, 0, 0),
            model_spec("generate_video_seedance_v2_0_mini", "Seedance 2.0 Mini", "2.0", &["auto"], "auto", 4, 15, 5, lovart_modes(), false, 9, 0, 0),
        ],
    }
}

pub fn resolve_model_spec(provider: ProviderId, model_id: Option<&str>) -> ExternalVideoModelSpec {
    let models = models_for_provider(provider);
    if let Some(requested) = model_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(found) = models
            .iter()
            .find(|m| m.id.eq_ignore_ascii_case(requested) || m.label.eq_ignore_ascii_case(requested))
        {
            return found.clone();
        }
    }
    models.into_iter().next().expect("non-empty Seedance catalog")
}

pub fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn first_existing_file(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
}

pub fn resolve_provider_binary(provider: ProviderId, executable_root: &Path) -> Option<PathBuf> {
    let home = user_home_dir();
    match provider {
        ProviderId::JimengCn => {
            let mut candidates = Vec::new();
            for var in ["JIMENG_CN_BIN", "DREAMINA_CN_BIN"] {
                if let Some(path) = std::env::var_os(var) {
                    candidates.push(PathBuf::from(path));
                }
            }
            if let Some(ref h) = home {
                candidates.push(h.join("bin").join("jimeng-cn").join("dreamina-canvas.exe"));
                candidates.push(h.join(".local").join("bin").join("jimeng-cn").join("dreamina-canvas.exe"));
                candidates.push(h.join(".local").join("bin").join("jimeng-cn").join("dreamina-canvas"));
            }
            candidates.push(executable_root.join("tools").join("jimeng-cn").join("dreamina-canvas.exe"));
            first_existing_file(candidates)
        }
        ProviderId::DreaminaJp => {
            let mut candidates = Vec::new();
            for var in ["DREAMINA_JP_BIN", "DREAMINA_BIN"] {
                if let Some(path) = std::env::var_os(var) {
                    candidates.push(PathBuf::from(path));
                }
            }
            if let Some(ref h) = home {
                candidates.push(h.join("bin").join("dreamina-canvas.exe"));
                candidates.push(h.join(".local").join("bin").join("dreamina-canvas.exe"));
                candidates.push(h.join(".local").join("bin").join("dreamina-canvas"));
            }
            candidates.push(executable_root.join("tools").join("dreamina-jp").join("dreamina-canvas.exe"));
            first_existing_file(candidates)
        }
        ProviderId::Libtv => {
            let mut candidates = Vec::new();
            if let Some(path) = std::env::var_os("LIBTV_BIN") {
                candidates.push(PathBuf::from(path));
            }
            if let Some(ref h) = home {
                candidates.push(h.join(".libtv").join("libtv.exe"));
                candidates.push(h.join(".libtv").join("libtv"));
            }
            candidates.push(executable_root.join("tools").join("libtv").join("libtv.exe"));
            first_existing_file(candidates)
        }
        ProviderId::Lovart => {
            let mut candidates = Vec::new();
            if let Some(path) = std::env::var_os("LOVART_SKILL_SCRIPT") {
                candidates.push(PathBuf::from(path));
            }
            candidates.push(executable_root.join("tools").join("lovart").join("agent_skill.py"));
            candidates.push(executable_root.join("scripts").join("providers").join("lovart_agent_skill.py"));
            candidates.push(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("scripts")
                    .join("providers")
                    .join("lovart_agent_skill.py"),
            );
            first_existing_file(candidates)
        }
    }
}

pub fn resolve_python_executable() -> String {
    if let Some(py) = std::env::var_os("SUCANVAS_PYTHON_BIN") {
        let trimmed = py.to_string_lossy().trim().to_owned();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    if let Some(h) = user_home_dir() {
        let local_py = h
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("Python")
            .join("Python312")
            .join("python.exe");
        if local_py.is_file() {
            return local_py.to_string_lossy().into_owned();
        }
    }
    "python".to_owned()
}

pub fn parse_env_file_pairs(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw_line in text.lines() {
        let mut line = raw_line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("export ") {
            line = rest.trim();
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !key.is_empty() && !value.is_empty() {
            map.insert(key.to_owned(), value.to_owned());
        }
    }
    map
}

pub fn resolve_lovart_credentials(data_dir: &Path) -> Option<(String, String)> {
    let env_ak = std::env::var("LOVART_ACCESS_KEY").ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let env_sk = std::env::var("LOVART_SECRET_KEY").ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    if let (Some(ak), Some(sk)) = (env_ak.clone(), env_sk.clone()) {
        return Some((ak, sk));
    }
    let mut files = vec![
        data_dir.join("providers").join("lovart").join("credentials.env"),
    ];
    if let Some(h) = user_home_dir() {
        files.push(h.join(".lovart").join("credentials.env"));
    }
    for path in files {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let pairs = parse_env_file_pairs(&content);
        let ak = env_ak.clone().or_else(|| pairs.get("LOVART_ACCESS_KEY").cloned());
        let sk = env_sk.clone().or_else(|| pairs.get("LOVART_SECRET_KEY").cloned());
        if let (Some(ak), Some(sk)) = (ak, sk) {
            return Some((ak, sk));
        }
    }
    None
}

pub fn parse_json_or_last_ndjson(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let mut last: Option<Value> = None;
    for line in trimmed.lines() {
        let candidate = line.trim();
        if candidate.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            last = Some(value);
        }
    }
    last
}

pub fn parse_dreamina_auth_logged_in(stdout: &str, stderr: &str) -> (bool, Option<String>) {
    let parsed = parse_json_or_last_ndjson(stdout).or_else(|| parse_json_or_last_ndjson(stderr));
    let Some(val) = parsed else {
        return (false, Some("无法解析即梦 CLI 登录状态输出".into()));
    };
    if val.get("ok").and_then(Value::as_bool) != Some(true) {
        let msg = val
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("即梦 CLI 未登录");
        return (false, Some(msg.to_owned()));
    }
    let logged_in = val
        .pointer("/data/loggedIn")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if logged_in {
        (true, None)
    } else {
        (false, Some("登录态已过期或尚未登录".into()))
    }
}

pub fn parse_libtv_auth_logged_in(stdout: &str, stderr: &str) -> (bool, Option<String>) {
    let parsed = parse_json_or_last_ndjson(stdout).or_else(|| parse_json_or_last_ndjson(stderr));
    let Some(val) = parsed else {
        return (false, Some("无法解析 LibTV CLI 状态输出".into()));
    };
    let logged_in = val
        .pointer("/auth/loggedIn")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if logged_in {
        (true, None)
    } else {
        (false, Some("LibTV 尚未登录，请在服务器执行 libtv login".into()))
    }
}

async fn run_probe_command(program: &Path, args: &[&str], timeout_secs: u64) -> Result<(i32, String, String), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| "检查登录状态超时".to_owned())?
        .map_err(|e| format!("无法启动 CLI：{e}"))?;
    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok((code, stdout, stderr))
}

pub async fn probe_provider(
    provider: ProviderId,
    executable_root: &Path,
    data_dir: &Path,
) -> ProviderStatusSnapshot {
    let models = models_for_provider(provider);
    let Some(bin_path) = resolve_provider_binary(provider, executable_root) else {
        return ProviderStatusSnapshot {
            provider,
            label: provider.label().to_owned(),
            installed: false,
            logged_in: false,
            ready: false,
            status_text: "未安装服务器 CLI".into(),
            error: Some(format!("未在服务器找到 {} 对应 CLI/脚本", provider.label())),
            binary_path: None,
            models,
        };
    };
    let bin_display = bin_path.to_string_lossy().into_owned();
    match provider {
        ProviderId::JimengCn | ProviderId::DreaminaJp => {
            let mut args: Vec<&str> = provider.dreamina_profile_args().to_vec();
            args.extend(["--format", "json", "--non-interactive", "auth", "status"]);
            match run_probe_command(&bin_path, &args, 10).await {
                Ok((_code, stdout, stderr)) => {
                    let (logged_in, err) = parse_dreamina_auth_logged_in(&stdout, &stderr);
                    ProviderStatusSnapshot {
                        provider,
                        label: provider.label().to_owned(),
                        installed: true,
                        logged_in,
                        ready: logged_in,
                        status_text: if logged_in {
                            "已就绪（已登录）".into()
                        } else {
                            "需在服务器登录授权".into()
                        },
                        error: err,
                        binary_path: Some(bin_display),
                        models,
                    }
                }
                Err(error) => ProviderStatusSnapshot {
                    provider,
                    label: provider.label().to_owned(),
                    installed: true,
                    logged_in: false,
                    ready: false,
                    status_text: "状态检查失败".into(),
                    error: Some(error),
                    binary_path: Some(bin_display),
                    models,
                },
            }
        }
        ProviderId::Libtv => match run_probe_command(&bin_path, &["status"], 10).await {
            Ok((_code, stdout, stderr)) => {
                let (logged_in, err) = parse_libtv_auth_logged_in(&stdout, &stderr);
                ProviderStatusSnapshot {
                    provider,
                    label: provider.label().to_owned(),
                    installed: true,
                    logged_in,
                    ready: logged_in,
                    status_text: if logged_in {
                        "已就绪（已登录）".into()
                    } else {
                        "需在服务器登录".into()
                    },
                    error: err,
                    binary_path: Some(bin_display),
                    models,
                }
            }
            Err(error) => ProviderStatusSnapshot {
                provider,
                label: provider.label().to_owned(),
                installed: true,
                logged_in: false,
                ready: false,
                status_text: "状态检查失败".into(),
                error: Some(error),
                binary_path: Some(bin_display),
                models,
            },
        },
        ProviderId::Lovart => {
            let has_creds = resolve_lovart_credentials(data_dir).is_some();
            ProviderStatusSnapshot {
                provider,
                label: provider.label().to_owned(),
                installed: true,
                logged_in: has_creds,
                ready: has_creds,
                status_text: if has_creds {
                    "已就绪（已配置密钥）".into()
                } else {
                    "缺少 AK/SK 密钥".into()
                },
                error: if has_creds {
                    None
                } else {
                    Some("请在服务器配置 LOVART_ACCESS_KEY / LOVART_SECRET_KEY 或 credentials.env".into())
                },
                binary_path: Some(bin_display),
                models,
            }
        }
    }
}

pub async fn probe_all_providers(executable_root: &Path, data_dir: &Path) -> Vec<ProviderStatusSnapshot> {
    let (a, b, c, d) = tokio::join!(
        probe_provider(ProviderId::JimengCn, executable_root, data_dir),
        probe_provider(ProviderId::DreaminaJp, executable_root, data_dir),
        probe_provider(ProviderId::Libtv, executable_root, data_dir),
        probe_provider(ProviderId::Lovart, executable_root, data_dir),
    );
    vec![a, b, c, d]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_round_trip_and_seedance_series() {
        for id in ProviderId::ALL {
            assert_eq!(ProviderId::from_str(id.as_str()), Some(id));
            let models = models_for_provider(id);
            assert!(
                models.iter().any(|m| m.series == "2.5") && models.iter().any(|m| m.series == "2.0"),
                "{:?} should expose both Seedance 2.5 and 2.0 models",
                id
            );
            assert!(models.iter().all(|m| m.series == "2.5" || m.series == "2.0"));
        }
    }

    #[test]
    fn parses_dreamina_and_libtv_auth_status() {
        let (ok, err) = parse_dreamina_auth_logged_in(
            r#"{"ok":true,"data":{"loggedIn":true}}"#,
            "",
        );
        assert!(ok && err.is_none());

        let (ok, err) = parse_dreamina_auth_logged_in(
            "",
            r#"{"ok":false,"error":{"message":"Authentication is required"}}"#,
        );
        assert!(!ok && err.unwrap().contains("Authentication"));

        let (ok, err) = parse_libtv_auth_logged_in(
            r#"{"cliVersion":"1.2.0","auth":{"loggedIn":true}}"#,
            "",
        );
        assert!(ok && err.is_none());
    }

    #[test]
    fn parses_credentials_env_without_shell_syntax_issues() {
        let pairs = parse_env_file_pairs(
            "\u{feff}# comment\nexport LOVART_ACCESS_KEY=\"ak_123\"\nLOVART_SECRET_KEY='sk_456'\n",
        );
        assert_eq!(pairs.get("LOVART_ACCESS_KEY").map(String::as_str), Some("ak_123"));
        assert_eq!(pairs.get("LOVART_SECRET_KEY").map(String::as_str), Some("sk_456"));
    }
}
