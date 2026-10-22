// Small JPEG covers for the project home page (CANVAS-021). The home page used
// to load every cover through /api/resource, i.e. the original image (often
// several MB), which on a remote link delayed opening a canvas until they had
// all arrived. /api/thumbnail reaches exactly the files /api/resource reaches
// (files::resolve, same session check) and answers with a cached copy whose
// longer side is at most MAX_SIDE.
//
// Cache: data/thumbnails/<key>.jpg. The key covers the original's path, size
// and modification time, so a changed original gets a new entry and a removed
// original is never served (resolve answers 404 before the cache is looked at).
// Entries unused for MAX_UNUSED are removed, and the oldest go first once the
// directory exceeds MAX_CACHE_BYTES (prune, at most once per PRUNE_EVERY).
// Originals are never modified. Anything that cannot be decoded is served as
// the original instead, so a cover never disappears because of this cache.
use super::{files, WebState};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, Request},
    response::{IntoResponse, Response},
};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageReader, RgbImage};
use serde::Deserialize;
use std::{
    fs,
    io::BufWriter,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

pub const DIRECTORY: &str = "thumbnails";
const MAX_SIDE: u32 = 400;
const QUALITY: u8 = 80;
// Bump when the output changes so old entries are no longer used (and expire).
const FORMAT_VERSION: &str = "1";
const MAX_CACHE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_UNUSED: Duration = Duration::from_secs(30 * 24 * 3600);
const TOUCH_AFTER: Duration = Duration::from_secs(24 * 3600);
const PRUNE_EVERY: Duration = Duration::from_secs(3600);
// Decoding a large original takes memory and a CPU core; a home page asks for
// every cover at once.
static SLOTS: Semaphore = Semaphore::const_new(2);
static LAST_PRUNE: AtomicU64 = AtomicU64::new(0);
// Covers flattened onto the home page's thumbnail background.
const BACKGROUND: [f32; 3] = [13.0, 16.0, 23.0];

#[derive(Deserialize)]
pub struct Thumbnail {
    resource: String,
}

pub async fn thumbnail(
    State(state): State<WebState>,
    Query(input): Query<Thumbnail>,
    request: Request<Body>,
) -> Response {
    let state = state.connection_snapshot();
    let original = match files::resolve(&state, &input.resource) {
        Ok(path) => path,
        Err(status) => return status.into_response(),
    };
    let directory = state.core.data_dir.join(DIRECTORY);
    let Some(cached) = cache_path(&directory, &original) else {
        return files::serve(&original, request).await;
    };
    if cached.is_file() {
        touch(&cached);
    } else {
        let Ok(_slot) = SLOTS.acquire().await else {
            return files::serve(&original, request).await;
        };
        // Another request may have made it while this one waited.
        if !cached.is_file() {
            let (source, target) = (original.clone(), cached.clone());
            let made = tokio::task::spawn_blocking(move || generate(&source, &target)).await;
            if !matches!(made, Ok(Ok(()))) {
                return files::serve(&original, request).await;
            }
            prune_soon(directory);
        }
    }
    let mut response = files::serve(&cached, request).await;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "image/jpeg".parse().unwrap());
    response
}

fn fnv1a(seed: u64, parts: &[&[u8]]) -> u64 {
    let mut hash = seed;
    for part in parts {
        for byte in part.iter().chain(&[0xff]) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

/// The cache entry for `original` as it is now; None if it cannot be read.
fn cache_path(directory: &Path, original: &Path) -> Option<PathBuf> {
    let metadata = fs::metadata(original).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos()
        .to_le_bytes();
    let (side, path, len) = (
        MAX_SIDE.to_le_bytes(),
        original.to_string_lossy(),
        metadata.len().to_le_bytes(),
    );
    let parts: [&[u8]; 5] = [
        FORMAT_VERSION.as_bytes(),
        &side,
        path.as_bytes(),
        &len,
        &modified,
    ];
    // Two independent 64-bit FNV-1a hashes: 128 bits, no extra dependency.
    let key = format!(
        "{:016x}{:016x}",
        fnv1a(0xcbf2_9ce4_8422_2325, &parts),
        fnv1a(0x6c62_272e_07bb_0142, &parts)
    );
    Some(directory.join(format!("{key}.jpg")))
}

fn generate(original: &Path, target: &Path) -> Result<(), String> {
    let image = ImageReader::open(original)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    let image = if image.width() > MAX_SIDE || image.height() > MAX_SIDE {
        image.thumbnail(MAX_SIDE, MAX_SIDE)
    } else {
        image
    };
    let rgb = flatten(&image);
    let directory = target.parent().ok_or("缩略图目录无效")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| {
        let file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        JpegEncoder::new_with_quality(BufWriter::new(file), QUALITY)
            .encode_image(&rgb)
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, target).map_err(|e| e.to_string())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

fn flatten(image: &DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let alpha = f32::from(a) / 255.0;
        let mix = |value: u8, background: f32| {
            (f32::from(value) * alpha + background * (1.0 - alpha)).round() as u8
        };
        image::Rgb([
            mix(r, BACKGROUND[0]),
            mix(g, BACKGROUND[1]),
            mix(b, BACKGROUND[2]),
        ])
    })
}

/// Marks an entry as used, at most once per TOUCH_AFTER (it is a write).
fn touch(path: &Path) {
    let stale = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > TOUCH_AFTER);
    if stale {
        if let Ok(file) = fs::File::options().write(true).open(path) {
            let _ = file.set_modified(SystemTime::now());
        }
    }
}

fn prune_soon(directory: PathBuf) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let last = LAST_PRUNE.load(Ordering::Relaxed);
    if now.saturating_sub(last) < PRUNE_EVERY.as_secs()
        || LAST_PRUNE
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    tokio::task::spawn_blocking(move || prune(&directory, SystemTime::now(), MAX_CACHE_BYTES));
}

/// Removes entries unused for MAX_UNUSED, leftover temporary files, then the
/// least recently used entries until the directory is within `max_bytes`.
/// Returns the number of files removed.
fn prune(directory: &Path, now: SystemTime, max_bytes: u64) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    let mut kept = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(now);
        let age = now.duration_since(modified).unwrap_or_default();
        let temporary = path.extension().is_some_and(|e| e == "tmp");
        if (temporary && age > Duration::from_secs(3600)) || (!temporary && age > MAX_UNUSED) {
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        } else if !temporary {
            kept.push((modified, metadata.len(), path));
        }
    }
    let mut total: u64 = kept.iter().map(|(_, len, _)| len).sum();
    kept.sort_by_key(|(modified, _, _)| *modified);
    for (_, len, path) in kept {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total -= len;
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};

    fn scratch(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("web-thumbnails-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn large_originals_become_small_jpegs_and_the_original_is_untouched() {
        let root = scratch("large");
        let original = root.join("cover.png");
        RgbaImage::from_fn(1600, 900, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 90, 255])
        })
        .save_with_format(&original, ImageFormat::Png)
        .unwrap();
        let before = fs::read(&original).unwrap();
        let cached = cache_path(&root.join(DIRECTORY), &original).unwrap();
        generate(&original, &cached).unwrap();
        let thumbnail = image::open(&cached).unwrap();
        assert_eq!((thumbnail.width(), thumbnail.height()), (400, 225));
        assert_eq!(
            image::guess_format(&fs::read(&cached).unwrap()).unwrap(),
            ImageFormat::Jpeg
        );
        assert!(fs::metadata(&cached).unwrap().len() < 60 * 1024);
        assert_eq!(fs::read(&original).unwrap(), before);
        // No temporary files are left next to the entry.
        assert_eq!(fs::read_dir(cached.parent().unwrap()).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn small_and_transparent_originals_keep_their_size_and_flatten_onto_the_background() {
        let root = scratch("small");
        let original = root.join("icon.png");
        RgbaImage::from_pixel(120, 80, Rgba([255, 255, 255, 0]))
            .save_with_format(&original, ImageFormat::Png)
            .unwrap();
        let cached = cache_path(&root.join(DIRECTORY), &original).unwrap();
        generate(&original, &cached).unwrap();
        let thumbnail = image::open(&cached).unwrap().to_rgb8();
        assert_eq!(thumbnail.dimensions(), (120, 80));
        let pixel = thumbnail.get_pixel(60, 40).0;
        assert!(
            pixel
                .iter()
                .zip(BACKGROUND)
                .all(|(v, b)| (f32::from(*v) - b).abs() <= 6.0),
            "{pixel:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_key_follows_the_original_and_undecodable_files_are_refused() {
        let root = scratch("key");
        let directory = root.join(DIRECTORY);
        let original = root.join("cover.png");
        RgbaImage::from_pixel(10, 10, Rgba([1, 2, 3, 255]))
            .save_with_format(&original, ImageFormat::Png)
            .unwrap();
        let first = cache_path(&directory, &original).unwrap();
        assert_eq!(cache_path(&directory, &original), Some(first.clone()));
        RgbaImage::from_pixel(11, 10, Rgba([1, 2, 3, 255]))
            .save_with_format(&original, ImageFormat::Png)
            .unwrap();
        fs::File::options()
            .write(true)
            .open(&original)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        assert_ne!(cache_path(&directory, &original).unwrap(), first);
        assert_ne!(cache_path(&directory, &root.join("other.png")), Some(first));
        // A removed original has no entry at all.
        fs::remove_file(&original).unwrap();
        assert_eq!(cache_path(&directory, &original), None);
        let broken = root.join("broken.png");
        fs::write(&broken, b"not an image").unwrap();
        let target = cache_path(&directory, &broken).unwrap();
        assert!(generate(&broken, &target).is_err());
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prune_drops_unused_and_temporary_entries_then_the_oldest_over_the_limit() {
        let root = scratch("prune");
        let now = SystemTime::now();
        let write = |name: &str, bytes: usize, age_hours: u64| {
            let path = root.join(name);
            fs::write(&path, vec![0u8; bytes]).unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(now - Duration::from_secs(age_hours * 3600))
                .unwrap();
        };
        write("unused.jpg", 10, 31 * 24);
        write("left.tmp", 10, 2);
        write("fresh.tmp", 10, 0);
        write("old.jpg", 400, 48);
        write("middle.jpg", 400, 24);
        write("new.jpg", 400, 1);
        assert_eq!(prune(&root, now, 1000), 3);
        let mut left: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["fresh.tmp", "middle.jpg", "new.jpg"]);
        fs::remove_dir_all(root).unwrap();
    }
}
