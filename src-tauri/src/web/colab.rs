use super::WebState;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub const COLAB_OUTPUTS_DIR: &str = "colab-outputs";

const WATERMARK_SKIP_W_RATIO: f64 = 0.40;
const WATERMARK_SKIP_H_RATIO: f64 = 0.08;

fn format_hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn extract_payload_with_k(raw_rgb: &[u8], width: usize, height: usize, k: usize) -> Option<Vec<u8>> {
    if !matches!(k, 2 | 6 | 8) {
        return None;
    }
    let skip_w = ((width as f64) * WATERMARK_SKIP_W_RATIO) as usize;
    let skip_h = ((height as f64) * WATERMARK_SKIP_H_RATIO) as usize;
    let excluded_pixels = if skip_w > 0 && skip_h > 0 {
        skip_w.min(width) * skip_h.min(height)
    } else {
        0
    };
    let usable_pixels = width.saturating_mul(height).saturating_sub(excluded_pixels);
    let usable_bits = (usable_pixels as u64).saturating_mul(3).saturating_mul(k as u64);
    if usable_bits < 32 {
        return None;
    }

    struct BitReader<'a> {
        raw_rgb: &'a [u8],
        width: usize,
        height: usize,
        skip_w: usize,
        skip_h: usize,
        k: usize,
        y: usize,
        x: usize,
        c: usize,
        bit_in_channel: usize,
        current_channel: u8,
        need_load: bool,
    }

    impl<'a> BitReader<'a> {
        fn new(raw_rgb: &'a [u8], width: usize, height: usize, skip_w: usize, skip_h: usize, k: usize) -> Self {
            Self {
                raw_rgb,
                width,
                height,
                skip_w,
                skip_h,
                k,
                y: 0,
                x: 0,
                c: 0,
                bit_in_channel: 0,
                current_channel: 0,
                need_load: true,
            }
        }

        fn next_byte(&mut self) -> Option<u8> {
            let mut acc = 0u8;
            for _ in 0..8 {
                if self.need_load {
                    loop {
                        if self.y >= self.height {
                            return None;
                        }
                        let skipped = self.skip_w > 0
                            && self.skip_h > 0
                            && self.y < self.skip_h
                            && self.x < self.skip_w;
                        if skipped {
                            self.x = self.skip_w.min(self.width);
                            self.c = 0;
                            if self.x >= self.width {
                                self.x = 0;
                                self.y += 1;
                            }
                            continue;
                        }
                        let idx = (self.y * self.width + self.x) * 3 + self.c;
                        self.current_channel = *self.raw_rgb.get(idx)?;
                        self.bit_in_channel = self.k;
                        self.need_load = false;
                        self.c += 1;
                        if self.c == 3 {
                            self.c = 0;
                            self.x += 1;
                            if self.x == self.width {
                                self.x = 0;
                                self.y += 1;
                            }
                        }
                        break;
                    }
                }
                self.bit_in_channel -= 1;
                let bit = (self.current_channel >> self.bit_in_channel) & 1;
                acc = (acc << 1) | bit;
                if self.bit_in_channel == 0 {
                    self.need_load = true;
                }
            }
            Some(acc)
        }
    }

    let mut reader = BitReader::new(raw_rgb, width, height, skip_w, skip_h, k);
    let len_bytes = [
        reader.next_byte()?,
        reader.next_byte()?,
        reader.next_byte()?,
        reader.next_byte()?,
    ];
    let header_len = u32::from_be_bytes(len_bytes) as usize;
    let total_bits = 32u64.saturating_add((header_len as u64).saturating_mul(8));
    if header_len == 0 || total_bits > usable_bits {
        return None;
    }
    let mut header = Vec::with_capacity(header_len);
    for _ in 0..header_len {
        header.push(reader.next_byte()?);
    }
    Some(header)
}

enum ParsedHeader<'a> {
    Matched {
        has_pwd: bool,
        pwd_hash: &'a [u8],
        salt: &'a [u8],
        ext: &'a str,
        data: &'a [u8],
    },
    Invalid,
}

fn parse_header_structure(header: &[u8]) -> ParsedHeader<'_> {
    if header.is_empty() || header[0] > 1 {
        return ParsedHeader::Invalid;
    }
    let has_pwd = header[0] == 1;
    let mut idx = 1usize;
    let (pwd_hash, salt) = if has_pwd {
        if header.len() < idx + 32 + 16 {
            return ParsedHeader::Invalid;
        }
        let hash = &header[idx..idx + 32];
        idx += 32;
        let salt = &header[idx..idx + 16];
        idx += 16;
        (hash, salt)
    } else {
        (&[][..], &[][..])
    };
    if header.len() < idx + 1 {
        return ParsedHeader::Invalid;
    }
    let ext_len = header[idx] as usize;
    idx += 1;
    if ext_len == 0 || ext_len > 32 || header.len() < idx + ext_len + 4 {
        return ParsedHeader::Invalid;
    }
    let Ok(ext) = std::str::from_utf8(&header[idx..idx + ext_len]) else {
        return ParsedHeader::Invalid;
    };
    if !ext
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.')
    {
        return ParsedHeader::Invalid;
    }
    idx += ext_len;
    let data_len = u32::from_be_bytes(header[idx..idx + 4].try_into().unwrap()) as usize;
    idx += 4;
    let data = &header[idx..];
    if data.len() != data_len {
        return ParsedHeader::Invalid;
    }
    ParsedHeader::Matched {
        has_pwd,
        pwd_hash,
        salt,
        ext,
        data,
    }
}

/// Decodes a carrier PNG produced by `copyangle/SS_tools` (`DuckHideNode`) into raw payload bytes and file extension.
pub fn decode_duck_png(png_bytes: &[u8], password: &str) -> Result<(Vec<u8>, String), String> {
    let img = image::load_from_memory(png_bytes)
        .map_err(|error| format!("读取 SS_tools 载体图片失败：{error}"))?
        .to_rgb8();
    let width = img.width() as usize;
    let height = img.height() as usize;
    let raw_rgb = img.as_raw();

    for k in [2usize, 6, 8] {
        let Some(header) = extract_payload_with_k(raw_rgb, width, height, k) else {
            continue;
        };
        let ParsedHeader::Matched {
            has_pwd,
            pwd_hash,
            salt,
            ext,
            data,
        } = parse_header_structure(&header)
        else {
            continue;
        };

        let plain = if has_pwd {
            if password.is_empty() {
                return Err("Colab SS_tools 产物已加密，请先在基础设置中填写解码密码".to_owned());
            }
            let salt_hex = format_hex_lower(salt);
            let check_hash = Sha256::digest(format!("{password}{salt_hex}").as_bytes());
            if check_hash.as_slice() != pwd_hash {
                return Err("Colab SS_tools 解码密码错误，请检查基础设置中的解码密码".to_owned());
            }
            let mut plain = data.to_vec();
            let mut offset = 0usize;
            let mut counter = 0u64;
            while offset < plain.len() {
                let block = Sha256::digest(format!("{password}{salt_hex}{counter}").as_bytes());
                let take = (plain.len() - offset).min(block.len());
                for i in 0..take {
                    plain[offset + i] ^= block[i];
                }
                offset += take;
                counter += 1;
            }
            plain
        } else {
            data.to_vec()
        };

        let lower_ext = ext.to_ascii_lowercase();
        if let Some(prefix) = lower_ext.strip_suffix(".binpng") {
            let bin_img = image::load_from_memory(&plain)
                .map_err(|error| format!("解析 SS_tools 视频载体数据失败：{error}"))?
                .to_rgb8();
            let mut raw_video = bin_img.into_raw();
            while raw_video.last() == Some(&0) {
                raw_video.pop();
            }
            let real_ext: String = prefix
                .trim_start_matches('.')
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            let final_ext = if real_ext.is_empty() {
                "mp4".to_owned()
            } else {
                real_ext
            };
            return Ok((raw_video, final_ext));
        }

        let sanitized_ext: String = lower_ext
            .trim_start_matches('.')
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let final_ext = if sanitized_ext.is_empty() {
            "mp4".to_owned()
        } else {
            sanitized_ext
        };
        return Ok((plain, final_ext));
    }

    Err("无法解析 SS_tools 鸭鸭图，文件可能不是有效的 SS_tools 编码载体".to_owned())
}

fn sanitize_filename_stem(filename: &str) -> String {
    let raw_stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("colab_output");
    let mut safe: String = raw_stem
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    safe = safe.trim_matches(['.', ' ']).to_owned();
    if safe.is_empty() {
        "colab_output".to_owned()
    } else {
        safe
    }
}

fn sanitize_subfolder_segments(subfolder: &str) -> Result<Vec<String>, String> {
    let mut segments = Vec::new();
    for part in subfolder.split(['/', '\\']) {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "." || trimmed == ".." || trimmed.contains(':') || trimmed.chars().any(char::is_control) {
            return Err("生成结果子目录包含非法路径段".to_owned());
        }
        segments.push(trimmed.to_owned());
    }
    Ok(segments)
}

fn short_prompt_tag(prompt_id: &str, uniqueness_seed: &str) -> String {
    let alnum: String = prompt_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    if alnum.len() >= 6 {
        return alnum;
    }
    let digest = Sha256::digest(uniqueness_seed.as_bytes());
    format_hex_lower(&digest[..4])
}

fn find_cached_decoded_file(dir: &Path, base_name: &str) -> Option<(PathBuf, String)> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str())?;
        let ext = path.extension().and_then(|s| s.to_str())?;
        if stem == base_name
            && !ext.is_empty()
            && !ext.eq_ignore_ascii_case("part")
            && !ext.eq_ignore_ascii_case("tmp")
        {
            return Some((path.clone(), ext.to_ascii_lowercase()));
        }
    }
    None
}

fn build_resource_url(asset_path: &str) -> String {
    let mut url = reqwest::Url::parse("http://localhost/api/resource").unwrap();
    url.query_pairs_mut().append_pair("resource", asset_path);
    format!("/api/resource?{}", url.query().unwrap())
}

fn write_atomic_file(target: &Path, root: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target.parent().ok_or("Colab 输出目录无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 Colab 输出目录失败：{error}"))?;
    super::rpc::ensure_contained(target, &[root.to_owned()])?;
    let temporary = target.with_extension(format!("{}.part", Uuid::new_v4()));
    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("创建 Colab 临时输出文件失败：{error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("写入 Colab 输出文件失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("落盘 Colab 输出文件失败：{error}"))?;
        drop(file);
        fs::rename(&temporary, target)
            .map_err(|error| format!("保存 Colab 输出文件失败：{error}"))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

async fn materialize_entry_outputs(state: &WebState, entry: &mut Value) -> Result<(), String> {
    let prompt_id = entry
        .get("promptId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let Some(outputs) = entry.get_mut("outputs").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    if outputs.is_empty() {
        return Ok(());
    }

    let expected_origin = reqwest::Url::parse(&state.config.colab_comfy_url)
        .map_err(|_| "请先在基础设置中配置有效的 Colab ComfyUI 服务地址".to_owned())?
        .origin()
        .ascii_serialization();
    let colab_root = state.core.data_dir.join(COLAB_OUTPUTS_DIR);
    fs::create_dir_all(&colab_root)
        .map_err(|error| format!("创建 Colab 本地输出根目录失败：{error}"))?;
    let download_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("创建 Colab 下载客户端失败：{error}"))?;

    for output in outputs.iter_mut() {
        if output
            .get("assetPath")
            .and_then(Value::as_str)
            .is_some_and(|path| path.starts_with("sucanvas://colab-outputs/"))
        {
            continue;
        }
        let url = output
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if url.is_empty() {
            continue;
        }
        let parsed_url =
            reqwest::Url::parse(&url).map_err(|error| format!("Colab 产物地址无效：{error}"))?;
        if !matches!(parsed_url.scheme(), "http" | "https")
            || parsed_url.origin().ascii_serialization() != expected_origin
        {
            return Err("拒绝拉取非当前配置的 Colab ComfyUI 地址产物".to_owned());
        }

        let source_filename = output
            .get("filename")
            .and_then(Value::as_str)
            .unwrap_or("colab_output.png")
            .to_owned();
        let source_subfolder = output
            .get("subfolder")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let segments = sanitize_subfolder_segments(&source_subfolder)?;
        let target_dir = segments
            .iter()
            .fold(colab_root.clone(), |dir, segment| dir.join(segment));
        let stem = sanitize_filename_stem(&source_filename);
        let tag = short_prompt_tag(&prompt_id, &format!("{source_subfolder}/{source_filename}/{url}"));
        let base_name = format!("{stem}_{tag}");

        let (decoded_filename, ext) =
            if let Some((_existing_path, existing_ext)) = find_cached_decoded_file(&target_dir, &base_name) {
                (format!("{base_name}.{existing_ext}"), existing_ext)
            } else {
                let response = download_client
                    .get(&url)
                    .send()
                    .await
                    .map_err(|error| format!("下载 Colab SS_tools 载体图失败：{error}"))?;
                let status = response.status();
                if !status.is_success() {
                    return Err(format!("下载 Colab SS_tools 载体图失败（HTTP {status}）"));
                }
                let png_bytes = response
                    .bytes()
                    .await
                    .map_err(|error| format!("读取 Colab SS_tools 载体图响应失败：{error}"))?;
                let password = state.config.colab_ss_password.clone();
                let (decoded_bytes, decoded_ext) =
                    tokio::task::spawn_blocking(move || decode_duck_png(&png_bytes, &password))
                        .await
                        .map_err(|error| format!("解码任务执行失败：{error}"))??;
                let final_name = format!("{base_name}.{decoded_ext}");
                let target_path = target_dir.join(&final_name);
                let root_clone = colab_root.clone();
                tokio::task::spawn_blocking(move || {
                    write_atomic_file(&target_path, &root_clone, &decoded_bytes)
                })
                .await
                .map_err(|error| format!("保存解码文件任务失败：{error}"))??;
                (final_name, decoded_ext)
            };

        let _ = ext;
        let clean_subfolder = segments.join("/");
        let relative = if clean_subfolder.is_empty() {
            format!("{COLAB_OUTPUTS_DIR}/{decoded_filename}")
        } else {
            format!("{COLAB_OUTPUTS_DIR}/{clean_subfolder}/{decoded_filename}")
        };
        let asset_path = format!("sucanvas://{relative}");
        let resource_url = build_resource_url(&asset_path);
        output["filename"] = Value::String(decoded_filename);
        output["subfolder"] = Value::String(clean_subfolder);
        output["fileType"] = Value::String("output".to_owned());
        output["assetPath"] = Value::String(asset_path);
        output["url"] = Value::String(resource_url);
    }

    Ok(())
}

/// Downloads and decodes `SS_tools` carrier PNGs returned from Colab into local `data/colab-outputs/`.
pub async fn materialize_ss_outputs(state: &WebState, result: &mut Value) -> Result<(), String> {
    if let Value::Array(entries) = result {
        for entry in entries.iter_mut() {
            materialize_entry_outputs(state, entry).await?;
        }
    } else if result.is_object() {
        materialize_entry_outputs(state, result).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, RgbImage};
    use std::io::Cursor;

    fn encode_test_duck(raw: &[u8], ext: &str, password: &str, k: usize) -> Vec<u8> {
        let (payload, salt, pwd_hash, has_pwd) = if password.is_empty() {
            (raw.to_vec(), Vec::new(), Vec::new(), false)
        } else {
            let salt = b"0123456789abcdef".to_vec();
            let salt_hex = format_hex_lower(&salt);
            let pwd_hash = Sha256::digest(format!("{password}{salt_hex}").as_bytes()).to_vec();
            let mut cipher = raw.to_vec();
            let mut offset = 0usize;
            let mut counter = 0u64;
            while offset < cipher.len() {
                let block = Sha256::digest(format!("{password}{salt_hex}{counter}").as_bytes());
                let take = (cipher.len() - offset).min(block.len());
                for i in 0..take {
                    cipher[offset + i] ^= block[i];
                }
                offset += take;
                counter += 1;
            }
            (cipher, salt, pwd_hash, true)
        };

        let mut header = Vec::new();
        header.push(u8::from(has_pwd));
        if has_pwd {
            header.extend_from_slice(&pwd_hash);
            header.extend_from_slice(&salt);
        }
        header.push(ext.len() as u8);
        header.extend_from_slice(ext.as_bytes());
        header.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        header.extend_from_slice(&payload);

        let mut full = Vec::with_capacity(4 + header.len());
        full.extend_from_slice(&(header.len() as u32).to_be_bytes());
        full.extend_from_slice(&header);

        let total_bits = full.len() * 8;
        let mut side = 640usize;
        loop {
            let sw = (side as f64 * WATERMARK_SKIP_W_RATIO) as usize;
            let sh = (side as f64 * WATERMARK_SKIP_H_RATIO) as usize;
            let usable = (side * side - sw * sh) * 3 * k;
            if usable >= total_bits {
                break;
            }
            side += 64;
        }

        let sw = (side as f64 * WATERMARK_SKIP_W_RATIO) as usize;
        let sh = (side as f64 * WATERMARK_SKIP_H_RATIO) as usize;
        let mut img = RgbImage::from_pixel(side as u32, side as u32, image::Rgb([153, 204, 255]));
        let raw_buf = img.as_mut();
        let mask = ((1u16 << k) - 1) as u8;

        let mut bit_idx = 0usize;
        for y in 0..side {
            for x in 0..side {
                if y < sh && x < sw {
                    // Put noise into watermark zone to ensure decoder actually skips it.
                    let pos = (y * side + x) * 3;
                    raw_buf[pos] ^= 0x55;
                    continue;
                }
                for c in 0..3 {
                    if bit_idx >= total_bits {
                        break;
                    }
                    let mut val = 0u8;
                    for _ in 0..k {
                        let bit = if bit_idx < total_bits {
                            (full[bit_idx / 8] >> (7 - (bit_idx % 8))) & 1
                        } else {
                            0
                        };
                        val = (val << 1) | bit;
                        bit_idx += 1;
                    }
                    let pos = (y * side + x) * 3 + c;
                    raw_buf[pos] = (raw_buf[pos] & !mask) | val;
                }
            }
        }

        let mut png_out = Vec::new();
        img.write_to(&mut Cursor::new(&mut png_out), ImageFormat::Png)
            .unwrap();
        png_out
    }

    fn wrap_bytes_in_binpng(data: &[u8]) -> Vec<u8> {
        let width = 512usize;
        let pixels = data.len().div_ceil(3);
        let height = pixels.div_ceil(width).max(1);
        let mut padded = data.to_vec();
        padded.resize(width * height * 3, 0);
        let img = RgbImage::from_raw(width as u32, height as u32, padded).unwrap();
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn roundtrip_all_k_with_and_without_password() {
        let sample = b"hello colab ss_tools payload bytes!".repeat(25);
        for k in [2usize, 6, 8] {
            let plain_duck = encode_test_duck(&sample, "png", "", k);
            let (decoded, ext) = decode_duck_png(&plain_duck, "").unwrap();
            assert_eq!(ext, "png");
            assert_eq!(decoded, sample);

            let encrypted_duck = encode_test_duck(&sample, "png", "5555", k);
            let (decoded, ext) = decode_duck_png(&encrypted_duck, "5555").unwrap();
            assert_eq!(ext, "png");
            assert_eq!(decoded, sample);
        }
    }

    #[test]
    fn roundtrip_binpng_recovers_mp4_bytes() {
        let fake_mp4 = b"\x00\x00\x00\x1cftypisom\x00\x00\x02\x00isomiso2mp41fake-video-stream";
        let binpng = wrap_bytes_in_binpng(fake_mp4);
        let duck = encode_test_duck(&binpng, "mp4.binpng", "5555", 2);
        let (decoded, ext) = decode_duck_png(&duck, "5555").unwrap();
        assert_eq!(ext, "mp4");
        assert_eq!(decoded, fake_mp4);
    }

    #[test]
    fn missing_or_wrong_password_and_plain_png_report_clear_errors() {
        let sample = b"secret video bytes";
        let duck = encode_test_duck(sample, "mp4", "5555", 2);
        let err_missing = decode_duck_png(&duck, "").unwrap_err();
        assert!(err_missing.contains("填写解码密码"), "{err_missing}");
        let err_wrong = decode_duck_png(&duck, "9999").unwrap_err();
        assert!(err_wrong.contains("密码错误"), "{err_wrong}");

        let plain_img = RgbImage::from_pixel(64, 64, image::Rgb([10, 20, 30]));
        let mut plain_png = Vec::new();
        plain_img
            .write_to(&mut Cursor::new(&mut plain_png), ImageFormat::Png)
            .unwrap();
        let err_plain = decode_duck_png(&plain_png, "5555").unwrap_err();
        assert!(err_plain.contains("无法解析"), "{err_plain}");
    }
}
