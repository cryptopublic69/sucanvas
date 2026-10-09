use super::{rpc, WebState};
use axum::{
    body::Body,
    extract::{Multipart, Query, State},
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;

pub(super) fn download_disposition(path: &std::path::Path) -> axum::http::HeaderValue {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " .-_()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = filename
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._".contains(byte) {
                (*byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
        .parse()
        .unwrap()
}

pub async fn upload(State(state): State<WebState>, mut multipart: Multipart) -> Response {
    match receive(&state, &mut multipart).await {
        Ok(files) => Json(json!({"paths": files})).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response(),
    }
}
async fn receive(state: &WebState, multipart: &mut Multipart) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    let mut created = Vec::new();
    let mut total = 0;
    let result = async {
        while let Some(mut field) = multipart.next_field().await.map_err(|e| e.to_string())? {
            if paths.len() >= 100 {
                return Err("一次最多上传 100 个文件".into());
            }
            let name = field.file_name().unwrap_or("upload.bin");
            let extension = name
                .rsplit('.')
                .next()
                .unwrap_or("bin")
                .to_ascii_lowercase();
            if ![
                "png",
                "jpg",
                "jpeg",
                "webp",
                "gif",
                "bmp",
                "avif",
                "mp4",
                "mov",
                "webm",
                "mkv",
                "avi",
                "mp3",
                "wav",
                "flac",
                "m4a",
                "aac",
                "ogg",
                "json",
                "zip",
                "sucanvas-module",
                "sucanvas-workflow",
                "sucanvas-backup",
            ]
            .contains(&extension.as_str())
            {
                return Err("不支持的文件类型".into());
            }
            let mut safe_name: String = name
                .chars()
                .map(|c| {
                    if c.is_control() || "<>:\"/\\|?*".contains(c) {
                        '_'
                    } else {
                        c
                    }
                })
                .collect();
            safe_name = safe_name.trim_end_matches(['.', ' ']).to_owned();
            let base = safe_name
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase();
            if [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ]
            .contains(&base.as_str())
            {
                safe_name.insert(0, '_');
            }
            if safe_name.is_empty() {
                safe_name = format!("upload.{extension}");
            }
            let directory = state
                .core
                .data_dir
                .join("uploads")
                .join(Uuid::new_v4().to_string());
            tokio::fs::create_dir(&directory)
                .await
                .map_err(|e| e.to_string())?;
            let path = directory.join(safe_name);
            created.push(path.clone());
            let mut file = tokio::fs::File::create(&path)
                .await
                .map_err(|e| e.to_string())?;
            while let Some(chunk) = field.chunk().await.map_err(|e| e.to_string())? {
                total += chunk.len();
                if total > state.config.max_upload_bytes {
                    return Err("上传文件超过服务器大小限制".into());
                }
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            file.flush().await.map_err(|e| e.to_string())?;
            paths.push(crate::portable::encode(
                &state.core.data_dir,
                &path.to_string_lossy(),
            ));
        }
        if paths.is_empty() {
            return Err("没有选择文件".into());
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        for path in created {
            let _ = tokio::fs::remove_file(path).await;
        }
        return Err(error);
    }
    Ok(paths)
}
#[derive(Deserialize)]
pub struct Resource {
    resource: String,
    #[serde(default)]
    download: bool,
    filename: Option<String>,
}
pub async fn resource(
    State(state): State<WebState>,
    Query(input): Query<Resource>,
    request: Request<Body>,
) -> Response {
    let path = if input.resource.starts_with("sucanvas-export://") {
        rpc::export_path(&state, &input.resource)
    } else {
        crate::portable::resource_path(&state.core.data_dir, &input.resource)
    };
    let Ok(path) = path else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let roots = vec![
        state.core.assets_dir.clone(),
        state.core.data_dir.join("temp/image-resize"),
        state.core.data_dir.join("uploads"),
        state.core.workflow_module_exports_dir.clone(),
        state.downloads.clone(),
    ];
    if rpc::ensure_contained(&path, &roots).is_err() || !path.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let download = input.download
        || !matches!(
            path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "png"
                | "jpg"
                | "jpeg"
                | "webp"
                | "gif"
                | "bmp"
                | "avif"
                | "mp4"
                | "mov"
                | "webm"
                | "mkv"
                | "avi"
                | "mp3"
                | "wav"
                | "flac"
                | "m4a"
                | "aac"
                | "ogg"
        );
    let mut response = ServeFile::new(&path)
        .oneshot(request)
        .await
        .unwrap()
        .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "private, max-age=3600".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    if download {
        let filename = input
            .filename
            .as_deref()
            .and_then(|name| name.rsplit(['/', '\\']).next())
            .filter(|name| !name.is_empty());
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            download_disposition(filename.map(std::path::Path::new).unwrap_or(&path)),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachment_preserves_backup_extension_and_unicode_filename() {
        let header = download_disposition(std::path::Path::new(
            "exports/SuCanvas-软件备份.sucanvas-backup",
        ));
        assert_eq!(header.to_str().unwrap(), "attachment; filename=\"SuCanvas-____.sucanvas-backup\"; filename*=UTF-8''SuCanvas-%E8%BD%AF%E4%BB%B6%E5%A4%87%E4%BB%BD.sucanvas-backup");
    }
    #[test]
    fn attachment_escapes_quotes_and_control_characters() {
        let header = download_disposition(std::path::Path::new("bad\"\r\n.sucanvas-backup"));
        assert_eq!(header.to_str().unwrap(), "attachment; filename=\"bad___.sucanvas-backup\"; filename*=UTF-8''bad%22%0D%0A.sucanvas-backup");
    }
}
