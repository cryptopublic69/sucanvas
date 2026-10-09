use super::WebState;
use futures_util::StreamExt;
use serde_json::Value;
use std::hash::{Hash, Hasher};
use tokio::io::AsyncWriteExt;

// Completed outputs live with the canvas data, so changing ComfyUI or moving
// the Web server does not invalidate existing project previews and references.
pub async fn retain_outputs(state: &WebState, result: &mut Value) -> Result<(), String> {
    let _guard = state.media_guard.lock().await;
    if let Value::Array(statuses) = result {
        for status in statuses {
            retain_result(state, status).await?;
        }
    } else {
        retain_result(state, result).await?;
    }
    Ok(())
}
async fn retain_result(state: &WebState, result: &mut Value) -> Result<(), String> {
    let Some(outputs) = result.get_mut("outputs").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for output in outputs {
        let url = output
            .get("url")
            .and_then(Value::as_str)
            .ok_or("Missing output URL")?
            .to_owned();
        let prefix = state.config.comfy_url.trim_end_matches('/');
        if prefix.is_empty()
            || !url
                .strip_prefix(prefix)
                .is_some_and(|tail| tail.starts_with("/view?"))
        {
            return Err("Unexpected ComfyUI output URL".into());
        }
        let filename = output
            .get("filename")
            .and_then(Value::as_str)
            .unwrap_or("output.mp4");
        let extension = filename
            .rsplit('.')
            .next()
            .unwrap_or("mp4")
            .to_ascii_lowercase();
        if ![
            "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "mp4", "mov", "webm", "mkv", "avi",
            "mp3", "wav", "flac", "m4a", "aac", "ogg",
        ]
        .contains(&extension.as_str())
        {
            return Err("Unsupported output file format".into());
        }
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        url.hash(&mut hash);
        let path = state
            .core
            .assets_dir
            .join(format!("generated-{:016x}.{extension}", hash.finish()));
        if !path.is_file() {
            let temporary = path.with_extension(format!("{extension}.part"));
            let download = async {
                let response = state
                    .client
                    .get(&url)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .error_for_status()
                    .map_err(|e| e.to_string())?;
                let mut file = tokio::fs::File::create(&temporary)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut stream = response.bytes_stream();
                let mut total = 0;
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| e.to_string())?;
                    total += chunk.len();
                    if total > state.config.max_upload_bytes {
                        return Err("生成文件超过服务器大小限制".to_owned());
                    }
                    file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                }
                if total == 0 {
                    return Err("生成文件为空".to_owned());
                }
                file.flush().await.map_err(|e| e.to_string())?;
                drop(file);
                tokio::fs::rename(&temporary, &path)
                    .await
                    .map_err(|e| e.to_string())
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(300), download)
                .await
                .map_err(|_| "保存生成文件超时".to_owned())
                .and_then(|result| result);
            if let Err(error) = result {
                let _ = tokio::fs::remove_file(&temporary).await;
                return Err(error);
            }
        }
        let resource = crate::portable::encode(&state.core.data_dir, &path.to_string_lossy());
        let mut query = reqwest::Url::parse("http://localhost/api/resource").unwrap();
        query.query_pairs_mut().append_pair("resource", &resource);
        output["url"] = Value::String(format!("/api/resource?{}", query.query().unwrap()));
        output["assetPath"] = Value::String(resource);
    }
    Ok(())
}
