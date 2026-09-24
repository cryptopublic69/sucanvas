use std::{process::Stdio, time::Duration};
use tokio::{process::Command, sync::Semaphore};

static POSTER_SLOT: Semaphore = Semaphore::const_new(1);

fn validate_source(source: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(source).map_err(|_| "无效的视频地址")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("后台封面提取仅支持 HTTP 视频".into());
    }
    Ok(())
}

// Only one bounded decoder, without hardware decoding, temporary video copies,
// or a visible console. The frontend persists the small JPEG in its poster cache.
#[tauri::command]
pub async fn capture_video_poster(source: String) -> Result<Vec<u8>, String> {
    validate_source(&source)?;
    let _permit = POSTER_SLOT
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    let mut executable = std::path::PathBuf::from("ffmpeg");
    #[cfg(windows)]
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let installed = std::path::PathBuf::from(program_files).join("ffmpeg/bin/ffmpeg.exe");
        if installed.is_file() {
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
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(Duration::from_secs(12), command.output())
        .await
        .map_err(|_| "视频封面提取超时")?
        .map_err(|error| format!("无法运行 FFmpeg：{error}"))?;
    if !output.status.success() || output.stdout.is_empty() || output.stdout.len() > 1_048_576 {
        return Err("无法提取视频封面".into());
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_video_sources_are_accepted() {
        assert!(validate_source("http://192.168.5.108:8188/view?filename=clip.mp4").is_ok());
        assert!(validate_source("https://example.com/video.mp4").is_ok());
        for source in [
            "file:///C:/video.mp4",
            "concat:a|b",
            "-version",
            "pipe:0",
            "invalid",
        ] {
            assert!(validate_source(source).is_err());
        }
    }
}
