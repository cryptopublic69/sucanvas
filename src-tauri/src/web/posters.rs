use super::{rpc, WebState};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};
use tokio::{process::Command, sync::Semaphore};

// Match the Web client limit; each extractor uses one decoding/filter thread.
static POSTER_SLOTS: Semaphore = Semaphore::const_new(6);

#[derive(Default)]
struct MigrationLookup {
    signature: Option<(PathBuf, u64, Option<SystemTime>)>,
    replacements: BTreeMap<String, String>,
}
impl MigrationLookup {
    fn replacement(&mut self, path: &Path, source: &str) -> Option<String> {
        let signature = std::fs::metadata(path)
            .ok()
            .map(|metadata| (path.to_owned(), metadata.len(), metadata.modified().ok()));
        if self.signature != signature {
            self.replacements = std::fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            self.signature = signature;
        }
        self.replacements.get(source).cloned()
    }
}
static MIGRATION_LOOKUP: OnceLock<Mutex<MigrationLookup>> = OnceLock::new();

fn mapped_view_source(
    source: &str,
    comfy_url: &str,
    input: &str,
    output: &str,
) -> Result<Option<PathBuf>, String> {
    let proxy_source = source
        .strip_prefix("/api/comfy/view?")
        .map(|query| format!("{}/view?{query}", comfy_url.trim_end_matches('/')));
    let source = proxy_source.as_deref().unwrap_or(source);
    let Ok(url) = reqwest::Url::parse(source) else {
        return Ok(None);
    };
    let Ok(expected) = reqwest::Url::parse(&format!("{}/view", comfy_url.trim_end_matches('/')))
    else {
        return Ok(None);
    };
    if url.origin() != expected.origin() || url.path() != expected.path() {
        return Ok(None);
    }
    let query = url
        .query_pairs()
        .collect::<std::collections::BTreeMap<_, _>>();
    let root = match query.get("type").map(|s| s.as_ref()).unwrap_or("output") {
        "output" => output,
        "input" => input,
        _ => return Ok(None),
    };
    if root.is_empty() {
        return Ok(None);
    }
    let filename = query.get("filename").ok_or("缺少视频文件名")?.as_ref();
    if filename.is_empty() || filename.contains(['/', '\\']) {
        return Err("无效的视频文件名".into());
    }
    let folder = query
        .get("subfolder")
        .map(|s| s.as_ref())
        .unwrap_or("")
        .replace('\\', "/");
    let relative = if folder.is_empty() {
        filename.to_owned()
    } else {
        format!("{folder}/{filename}")
    };
    let path = crate::portable::resource_path(Path::new(root), &format!("sucanvas://{relative}"))?;
    rpc::ensure_contained(&path, &[PathBuf::from(root)])?;
    Ok(path.is_file().then_some(path))
}

pub async fn capture(state: &WebState, source: String) -> Result<Vec<u8>, String> {
    let mut source = source;
    if let Ok(url) = reqwest::Url::parse(&source) {
        if state
            .config
            .allows_origin(&url.origin().ascii_serialization())
            && matches!(url.path(), "/api/comfy/view" | "/api/resource")
        {
            source = format!(
                "{}{}",
                url.path(),
                url.query().map(|q| format!("?{q}")).unwrap_or_default()
            );
        }
    }
    // Reuse parsed legacy references until the map changes. Old URLs can name
    // an existing, different file, so migration replacements must still win.
    let current_source = MIGRATION_LOOKUP
        .get_or_init(|| Mutex::new(MigrationLookup::default()))
        .lock()
        .map_err(|e| e.to_string())?
        .replacement(
            &state.core.data_dir.join("storage-migration-map.json"),
            &source,
        )
        .unwrap_or_else(|| source.clone());
    if let Some(path) = mapped_view_source(
        &current_source,
        &state.config.comfy_url,
        &state.config.comfy_input_directory,
        &state.config.comfy_output_directory,
    )? {
        source = path.to_string_lossy().into_owned();
    } else {
        let mut value = json!(source);
        rpc::normalize_args(state, &mut value, "sourcePath")?;
        source = value.as_str().ok_or("无效的视频地址")?.to_owned();
        if let Some(path) = mapped_view_source(
            &source,
            &state.config.comfy_url,
            &state.config.comfy_input_directory,
            &state.config.comfy_output_directory,
        )? {
            source = path.to_string_lossy().into_owned();
        }
    }
    if !Path::new(&source).is_file() {
        let url = reqwest::Url::parse(&source).map_err(|_| "无效的视频地址")?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("无效的视频地址".into());
        }
    }
    let _permit = POSTER_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    let bundled = state.handle.root.join("tools/ffmpeg.exe");
    let mut executable = if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("ffmpeg")
    };
    #[cfg(windows)]
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let installed = PathBuf::from(program_files).join("ffmpeg/bin/ffmpeg.exe");
        if executable == PathBuf::from("ffmpeg") && installed.is_file() {
            executable = installed;
        }
    }
    let mut command = Command::new(executable);
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-rw_timeout",
            "5000000",
            "-threads",
            "1",
            "-i",
            &source,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-vf",
            "scale=480:480:force_original_aspect_ratio=decrease",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let result = tokio::time::timeout(Duration::from_secs(12), command.output())
        .await
        .map_err(|_| "视频封面提取超时")?
        .map_err(|e| format!("无法运行 FFmpeg：{e}"))?;
    if !result.status.success() || result.stdout.is_empty() || result.stdout.len() > 1_048_576 {
        return Err("无法提取视频封面".into());
    }
    Ok(result.stdout)
}

#[derive(Deserialize)]
pub struct PosterRequest {
    source: String,
}
pub async fn image(State(state): State<WebState>, Query(input): Query<PosterRequest>) -> Response {
    let state = state.connection_snapshot();
    match capture(&state, input.source).await {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, "image/jpeg".parse().unwrap());
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
        }
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_lookup_refreshes_changed_maps_and_removal() {
        let root = std::env::temp_dir().join(format!("web-poster-map-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("map.json");
        let mut lookup = MigrationLookup::default();
        assert_eq!(lookup.replacement(&path, "old"), None);
        std::fs::write(&path, br#"{"old":"first"}"#).unwrap();
        assert_eq!(lookup.replacement(&path, "old"), Some("first".into()));
        assert_eq!(lookup.replacement(&path, "old"), Some("first".into()));
        std::fs::write(&path, br#"{"old":"second-target"}"#).unwrap();
        assert_eq!(
            lookup.replacement(&path, "old"),
            Some("second-target".into())
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(lookup.replacement(&path, "old"), None);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mapped_outputs_use_original_files_and_reject_traversal() {
        let root = std::env::temp_dir().join(format!("web-posters-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("H3")).unwrap();
        std::fs::write(root.join("H3/video.mp4"), b"fixture").unwrap();
        let mapped = root.to_string_lossy();
        let comfy = "http://127.0.0.1:8188";
        assert_eq!(
            mapped_view_source(
                "/api/comfy/view?filename=video.mp4&subfolder=H3&type=output",
                comfy,
                "",
                &mapped
            )
            .unwrap(),
            Some(root.join("H3/video.mp4"))
        );
        assert_eq!(
            mapped_view_source(
                "http://127.0.0.1:8188/view?filename=video.mp4&subfolder=H3&type=output",
                comfy,
                "",
                &mapped
            )
            .unwrap(),
            Some(root.join("H3/video.mp4"))
        );
        assert!(mapped_view_source(
            "http://127.0.0.1:8188/view?filename=video.mp4&subfolder=../outside",
            comfy,
            "",
            &mapped
        )
        .is_err());
        assert!(mapped_view_source(
            "http://elsewhere/view?filename=video.mp4",
            comfy,
            "",
            &mapped
        )
        .unwrap()
        .is_none());
        assert!(mapped_view_source(
            "http://127.0.0.1:8188/view?filename=missing.mp4",
            comfy,
            "",
            &mapped
        )
        .unwrap()
        .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
