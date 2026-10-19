// Orphan media cleanup (CANVAS-012c4, design canvas-012c-orphan-media-design.md).
//
// Only files the canvas itself manages are ever touched, and only through the
// `media_files` registry (fail-closed: what is not registered is never listed
// or removed). Registered files:
// - stock in canvas-owned directories (scanned): ComfyUI input `sucanvas-imports`
//   (uploads), `data/uploads` (upload staging), `data/temp/image-resize` (resize),
//   ComfyUI input `infinite-canvas/<task>` and `infinite-canvas-image-edit-*`
//   (task copies);
// - generated output (the shared ComfyUI output folder is never scanned): files
//   referenced by a node at any refresh, and results registered when a
//   generation returns them.
//
// References are recomputed on the server from every string of every node's
// content (generationSnapshot paths included), edge metadata and project
// covers; the client's view is never trusted. A file becomes a candidate only
// after GRACE_DAYS without a reference; removal moves it to the trash (kept
// TRASH_RETENTION_DAYS) after re-checking registry, media roots and references.
use super::ownership::{insert_audit, Actor};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

// Days a file must stay unreferenced before it is offered for cleanup
// (covers Ctrl+Z, undo restores and generations not yet written back).
pub const GRACE_DAYS: i64 = 7;
// Days a trashed file is kept (restorable) before it is removed for good.
pub const TRASH_RETENTION_DAYS: i64 = 30;
// Trash folder inside the data directory.
pub const TRASH_DIR: &str = "media-trash";
// Background refresh interval (also expires old trash).
pub const REFRESH_HOURS: u64 = 6;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS media_files (
    ref_key TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    category TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_by TEXT,
    registered_at TEXT NOT NULL,
    last_referenced_at TEXT,
    unreferenced_since TEXT,
    released_by TEXT,
    last_canvas_id TEXT,
    last_canvas_name TEXT,
    trashed_at TEXT,
    trash_path TEXT
)";
const SYSTEM: Actor<'static> = Actor {
    id: "system",
    username: "system",
};

fn error(error: impl ToString) -> String {
    error.to_string()
}
// Fixed width (microseconds, "Z") so SQL compares the text like the time.
fn time(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}
fn parse(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

// Comparison key: Windows paths are case-insensitive and separators vary.
fn key(reference: &str) -> String {
    reference.replace('\\', "/").to_lowercase()
}

// The managed directories, from the live configuration.
#[derive(Clone, Debug)]
pub struct MediaRoots {
    pub input: Option<PathBuf>,
    pub output: Option<PathBuf>,
    pub data: PathBuf,
}

impl MediaRoots {
    fn prefixed(&self) -> Vec<(&'static str, &Path)> {
        let mut roots = Vec::new();
        if let Some(input) = &self.input {
            roots.push(("sucanvas-input://", input.as_path()));
        }
        if let Some(output) = &self.output {
            roots.push(("sucanvas-output://", output.as_path()));
        }
        roots.push(("sucanvas://", self.data.as_path()));
        roots
    }

    pub fn reference_of(&self, path: &Path) -> Option<String> {
        let clean = path.to_string_lossy();
        let clean = clean.strip_prefix(r"\\?\").unwrap_or(&clean).to_owned();
        self.prefixed().into_iter().find_map(|(prefix, root)| {
            let root = root.to_string_lossy();
            let root = root.strip_prefix(r"\\?\").unwrap_or(&root).to_owned();
            Path::new(&clean)
                .strip_prefix(&root)
                .ok()
                .filter(|relative| !relative.as_os_str().is_empty())
                .map(|relative| {
                    format!("{prefix}{}", relative.to_string_lossy().replace('\\', "/"))
                })
        })
    }

    // None for invalid references and for roots that are not configured.
    pub fn resolve(&self, reference: &str) -> Option<PathBuf> {
        self.prefixed().into_iter().find_map(|(prefix, root)| {
            let relative = reference.strip_prefix(prefix)?;
            crate::portable::resource_path(root, &format!("sucanvas://{relative}")).ok()
        })
    }

    fn root_available(&self, reference: &str) -> bool {
        self.prefixed()
            .into_iter()
            .find(|(prefix, _)| reference.starts_with(prefix))
            .is_some_and(|(_, root)| root.is_dir())
    }

    // Folders files may be removed from (and restored into).
    fn removable_roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![
            self.data.join("uploads"),
            self.data.join("temp").join("image-resize"),
        ];
        roots.extend(self.input.clone());
        roots.extend(self.output.clone());
        roots
    }

    // The reference a string in node content points at, if any: managed
    // references, /api/resource URLs, ComfyUI /view URLs and absolute paths
    // inside a managed root.
    pub fn reference_key(&self, text: &str) -> Option<String> {
        let text = text.trim();
        if let Some(index) = text.find("/api/resource?") {
            let url = reqwest::Url::parse(&format!("http://localhost{}", &text[index..])).ok()?;
            let resource = url
                .query_pairs()
                .find(|(name, _)| name == "resource")?
                .1
                .into_owned();
            return self.reference_key(&resource);
        }
        if ["sucanvas-input://", "sucanvas-output://", "sucanvas://"]
            .iter()
            .any(|prefix| text.starts_with(prefix))
        {
            return Some(key(text));
        }
        // ComfyUI /view URLs, absolute or relative (/api/comfy/view?...).
        let web_url = text.starts_with("http://") || text.starts_with("https://");
        if (web_url || text.starts_with('/')) && text.contains("/view?") {
            let url = if web_url {
                reqwest::Url::parse(text).ok()?
            } else {
                reqwest::Url::parse(&format!("http://localhost{text}")).ok()?
            };
            let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
            let filename = query.get("filename").filter(|name| !name.is_empty())?;
            let prefix = match query.get("type").map(String::as_str) {
                None | Some("output") => "sucanvas-output://",
                Some("input") => "sucanvas-input://",
                _ => return None,
            };
            let subfolder = query
                .get("subfolder")
                .map(|sub| sub.trim_matches(['/', '\\']))
                .unwrap_or("");
            let relative = if subfolder.is_empty() {
                filename.clone()
            } else {
                format!("{subfolder}/{filename}")
            };
            return Some(key(&format!("{prefix}{relative}")));
        }
        let bytes = text.as_bytes();
        let absolute = text.starts_with(r"\\")
            || (bytes.len() > 2 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'));
        if absolute {
            return self
                .reference_of(Path::new(text))
                .map(|reference| key(&reference));
        }
        None
    }

    // Registry key of a file named in a request. The Web RPC layer turns
    // managed references into absolute paths before dispatch, so both forms
    // are accepted; anything else matches no row and is skipped.
    fn requested_key(&self, requested: &str) -> String {
        self.reference_key(requested)
            .unwrap_or_else(|| key(requested))
    }
}

fn strings<'a>(value: &'a Value, found: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => found.push(text),
        Value::Array(items) => items.iter().for_each(|item| strings(item, found)),
        Value::Object(map) => map.values().for_each(|item| strings(item, found)),
        _ => {}
    }
}

// Where a reference was found: the text as written and its canvas.
struct Reference {
    text: String,
    canvas_id: String,
    canvas_name: Option<String>,
}

// Every file any canvas references now (key -> first reference found). A node
// whose content cannot be read stops the refresh: nothing may be marked
// unreferenced on incomplete information.
fn referenced(
    connection: &Connection,
    roots: &MediaRoots,
) -> Result<HashMap<String, Reference>, String> {
    let mut found = HashMap::new();
    let mut add = |text: &str, canvas_id: &str, canvas_name: &Option<String>| {
        if let Some(reference_key) = roots.reference_key(text) {
            found.entry(reference_key).or_insert_with(|| Reference {
                text: text.trim().to_owned(),
                canvas_id: canvas_id.to_owned(),
                canvas_name: canvas_name.clone(),
            });
        }
    };
    for (sql, json) in [
        ("SELECT nodes.canvas_id, canvases.name, nodes.content_json FROM nodes LEFT JOIN canvases ON canvases.id = nodes.canvas_id", true),
        ("SELECT edges.canvas_id, canvases.name, edges.metadata_json FROM edges LEFT JOIN canvases ON canvases.id = edges.canvas_id", true),
        ("SELECT id, name, preview_image_path FROM canvases WHERE preview_image_path IS NOT NULL", false),
    ] {
        let mut statement = connection.prepare(sql).map_err(error)?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?)))
            .map_err(error)?;
        for row in rows {
            let (canvas_id, canvas_name, text) = row.map_err(error)?;
            if !json {
                add(&text, &canvas_id, &canvas_name);
                continue;
            }
            let value: Value = serde_json::from_str(&text)
                .map_err(|e| format!("画布内容无法解析，已停止素材清理：{e}"))?;
            let mut texts = Vec::new();
            strings(&value, &mut texts);
            for text in texts {
                add(text, &canvas_id, &canvas_name);
            }
        }
    }
    Ok(found)
}

fn walk(directory: &Path, category: &'static str, found: &mut Vec<(PathBuf, &'static str, u64)>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        // Links are never followed or registered.
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            walk(&entry.path(), category, found);
        } else if kind.is_file() {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            found.push((entry.path(), category, size));
        }
    }
}

// Stock files in the canvas-owned directories.
fn scan(roots: &MediaRoots) -> Vec<(PathBuf, &'static str, u64)> {
    let mut found = Vec::new();
    if let Some(input) = &roots.input {
        walk(
            &input.join(super::storage::IMPORT_FOLDER),
            "upload",
            &mut found,
        );
        walk(&input.join("infinite-canvas"), "task-temp", &mut found);
        if let Ok(entries) = fs::read_dir(input) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("infinite-canvas-image-edit-")
                    && entry.file_type().is_ok_and(|kind| kind.is_dir())
                {
                    walk(&entry.path(), "task-temp", &mut found);
                }
            }
        }
    }
    walk(&roots.data.join("uploads"), "upload-staging", &mut found);
    if let Ok(entries) = fs::read_dir(roots.data.join("temp").join("image-resize")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("resize-")
                && name.ends_with(".png")
                && entry.file_type().is_ok_and(|kind| kind.is_file())
            {
                let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                found.push((entry.path(), "resize", size));
            }
        }
    }
    found
}

// Moves a file, also across drives (ComfyUI input and the data folder may be
// on different volumes): copy, check the size, then remove the original.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(error)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let expected = fs::metadata(from).map_err(error)?.len();
    let copied = fs::copy(from, to).map_err(error);
    if copied.as_ref().ok() != Some(&expected) {
        let _ = fs::remove_file(to);
        return Err(copied
            .err()
            .unwrap_or_else(|| "复制后大小不一致".to_owned()));
    }
    fs::remove_file(from).map_err(|e| {
        let _ = fs::remove_file(to);
        error(e)
    })
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub reference: String,
    pub name: String,
    pub category: String,
    pub size: u64,
    pub unreferenced_since: Option<String>,
    pub released_by: Option<String>,
    pub created_by: Option<String>,
    pub trashed_at: Option<String>,
    // Name of the canvas that last referenced the file, as it was then.
    pub canvas_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaListing {
    pub candidates: Vec<MediaItem>,
    pub trash: Vec<MediaItem>,
    pub candidate_bytes: u64,
    pub grace_days: i64,
    pub trash_retention_days: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub reference: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaOutcome {
    pub done: Vec<String>,
    pub bytes: u64,
    pub skipped: Vec<Skipped>,
}

#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct ScanStats {
    pub nodes: usize,
    pub held: std::time::Duration,
}

// Refresh requests from deletions (see schedule_refresh).
#[derive(Default)]
struct RefreshQueue {
    running: bool,
    pending: bool,
    actors: BTreeSet<String>,
}

pub struct MediaRegistry {
    connection: Mutex<Connection>,
    queue: Mutex<RefreshQueue>,
    scans: AtomicUsize,
    last_scan: Mutex<Option<ScanStats>>,
}

impl MediaRegistry {
    pub fn open(database: &Path) -> Result<Self, String> {
        let connection = Connection::open(database).map_err(error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(error)?;
        connection.execute_batch(SCHEMA).map_err(error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            queue: Mutex::default(),
            scans: AtomicUsize::new(0),
            last_scan: Mutex::default(),
        })
    }

    // Registers new stock, backfills referenced output, updates every row's
    // reference state and expires old trash. `actor`: the user whose deletion
    // triggered the refresh; becomes `released_by` of files that were
    // referenced before and are not now.
    pub fn refresh(
        &self,
        roots: &MediaRoots,
        now: DateTime<Utc>,
        actor: Option<&str>,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        // The write lock is held from here to the commit.
        let locked = std::time::Instant::now();
        let nodes: usize = transaction
            .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get::<_, i64>(0))
            .map_err(error)? as usize;
        let references = referenced(&transaction, roots)?;
        let stamp = time(now);
        for (path, category, size) in scan(roots) {
            if let Some(reference) = roots.reference_of(&path) {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO media_files (ref_key, reference, category, size, registered_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![key(&reference), reference, category, size as i64, stamp],
                    )
                    .map_err(error)?;
            }
        }
        for (reference_key, found) in &references {
            if !reference_key.starts_with("sucanvas-output://") {
                continue;
            }
            let Some(reference) = canonical_reference(roots, &found.text) else {
                continue;
            };
            let Some(path) = roots.resolve(&reference).filter(|path| path.is_file()) else {
                continue;
            };
            let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            transaction
                .execute(
                    "INSERT OR IGNORE INTO media_files (ref_key, reference, category, size, registered_at) VALUES (?1, ?2, 'generated', ?3, ?4)",
                    params![reference_key, reference, size as i64, stamp],
                )
                .map_err(error)?;
        }
        let rows: Vec<(String, String, Option<String>, Option<String>)> = {
            let mut statement = transaction
                .prepare("SELECT ref_key, reference, unreferenced_since, last_referenced_at FROM media_files WHERE trashed_at IS NULL")
                .map_err(error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .map_err(error)?;
            rows.collect::<Result<_, _>>().map_err(error)?
        };
        for (reference_key, reference, unreferenced_since, last_referenced_at) in rows {
            // A root that is not configured leaves its rows untouched.
            let Some(path) = roots.resolve(&reference) else {
                continue;
            };
            if !path.is_file() {
                // An unreachable root (drive offline) says nothing about its files.
                if !roots.root_available(&reference) {
                    continue;
                }
                transaction
                    .execute(
                        "DELETE FROM media_files WHERE ref_key = ?1",
                        [&reference_key],
                    )
                    .map_err(error)?;
            } else if let Some(found) = references.get(&reference_key) {
                transaction
                    .execute(
                        "UPDATE media_files SET last_referenced_at = ?2, unreferenced_since = NULL, released_by = NULL, last_canvas_id = ?3, last_canvas_name = ?4 WHERE ref_key = ?1",
                        params![reference_key, stamp, found.canvas_id, found.canvas_name],
                    )
                    .map_err(error)?;
            } else if unreferenced_since.is_none() {
                let released_by = last_referenced_at.and(actor);
                transaction
                    .execute(
                        "UPDATE media_files SET unreferenced_since = ?2, released_by = ?3 WHERE ref_key = ?1",
                        params![reference_key, stamp, released_by],
                    )
                    .map_err(error)?;
            }
        }
        expire_trash(&transaction, roots, now)?;
        transaction.commit().map_err(error)?;
        let held = locked.elapsed();
        self.scans.fetch_add(1, Ordering::SeqCst);
        *self.last_scan.lock().unwrap() = Some(ScanStats { nodes, held });
        if held > std::time::Duration::from_secs(1) {
            eprintln!(
                "素材登记刷新持有写锁 {} ms（{nodes} 个节点）",
                held.as_millis()
            );
        }
        Ok(())
    }

    // CANVAS-012c4 R1: deletions ask for a refresh; at most one runs and one
    // more is queued, every request in between is merged into the queued one.
    // `spawn` starts the worker (a blocking thread). released_by of a merged
    // pass: its only operator, or nobody when several users asked.
    pub fn schedule_refresh(
        self: &Arc<Self>,
        roots: MediaRoots,
        actor: Option<&str>,
        spawn: impl FnOnce(Box<dyn FnOnce() + Send>),
    ) {
        {
            let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.pending = true;
            if let Some(actor) = actor {
                queue.actors.insert(actor.to_owned());
            }
            if queue.running {
                return;
            }
            queue.running = true;
        }
        let registry = self.clone();
        spawn(Box::new(move || registry.drain(&roots)));
    }

    // The worker: one pass per batch of requests until none is pending.
    fn drain(&self, roots: &MediaRoots) {
        // A panicking pass must not leave the queue marked as running forever.
        struct Reset<'a>(&'a Mutex<RefreshQueue>);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                if std::thread::panicking() {
                    self.0.lock().unwrap_or_else(|e| e.into_inner()).running = false;
                }
            }
        }
        let _reset = Reset(&self.queue);
        while let Some(actor) = self.next_pass() {
            if let Err(error) = self.refresh(roots, Utc::now(), actor.as_deref()) {
                eprintln!("素材登记刷新失败：{error}");
            }
        }
    }

    // Takes the pending batch (None: nothing pending, the worker stops).
    fn next_pass(&self) -> Option<Option<String>> {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if !queue.pending {
            queue.running = false;
            return None;
        }
        queue.pending = false;
        let actors = std::mem::take(&mut queue.actors);
        Some(if actors.len() == 1 {
            actors.into_iter().next()
        } else {
            None
        })
    }

    // Full scans run so far and the last one's size and write-lock time
    // (read by the tests and the R2 timing run).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn scan_stats(&self) -> (usize, Option<ScanStats>) {
        (
            self.scans.load(Ordering::SeqCst),
            *self.last_scan.lock().unwrap(),
        )
    }

    // Generation results returned to the browser: registered so they can be
    // cleaned up later even if their node is deleted before any refresh.
    pub fn register_outputs(
        &self,
        roots: &MediaRoots,
        result: &Value,
        user_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        let mut texts = Vec::new();
        strings(result, &mut texts);
        let connection = self.connection.lock().unwrap();
        for text in texts {
            if !text.starts_with("sucanvas-output://") {
                continue;
            }
            let Some(path) = roots.resolve(text).filter(|path| path.is_file()) else {
                continue;
            };
            let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            connection
                .execute(
                    "INSERT OR IGNORE INTO media_files (ref_key, reference, category, size, created_by, registered_at) VALUES (?1, ?2, 'generated', ?3, ?4, ?5)",
                    params![key(text), text, size as i64, user_id, time(now)],
                )
                .map_err(error)?;
        }
        Ok(())
    }

    // A file the canvas just created for a user (imports). Same rules as
    // stock: only existing files inside a managed root are registered.
    pub fn register(
        &self,
        roots: &MediaRoots,
        reference: &str,
        category: &str,
        user_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        let Some(path) = roots.resolve(reference).filter(|path| path.is_file()) else {
            return Ok(());
        };
        let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        self.connection
            .lock()
            .unwrap()
            .execute(
                "INSERT OR IGNORE INTO media_files (ref_key, reference, category, size, created_by, registered_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![key(reference), reference, category, size as i64, user_id, time(now)],
            )
            .map_err(error)?;
        Ok(())
    }

    fn items(&self, condition: &str) -> Result<Vec<MediaItem>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare(&format!(
                "SELECT media_files.reference, media_files.category, media_files.size, media_files.unreferenced_since,
                        released.username, created.username, media_files.trashed_at, media_files.last_canvas_name
                 FROM media_files
                 LEFT JOIN users AS released ON released.id = media_files.released_by
                 LEFT JOIN users AS created ON created.id = media_files.created_by
                 WHERE {condition} ORDER BY media_files.size DESC, media_files.reference"
            ))
            .map_err(error)?;
        let rows = statement
            .query_map([], |row| {
                let reference: String = row.get(0)?;
                Ok(MediaItem {
                    name: reference.rsplit('/').next().unwrap_or_default().to_owned(),
                    reference,
                    category: row.get(1)?,
                    size: row.get::<_, i64>(2)? as u64,
                    unreferenced_since: row.get(3)?,
                    released_by: row.get(4)?,
                    created_by: row.get(5)?,
                    trashed_at: row.get(6)?,
                    canvas_name: row.get(7)?,
                })
            })
            .map_err(error)?;
        rows.collect::<Result<_, _>>().map_err(error)
    }

    // Refreshes, then lists the cleanup candidates (past the grace period)
    // and the trash.
    pub fn list(&self, roots: &MediaRoots, now: DateTime<Utc>) -> Result<MediaListing, String> {
        self.refresh(roots, now, None)?;
        let cutoff = time(now - Duration::days(GRACE_DAYS));
        let candidates = self.items(&format!(
            "media_files.trashed_at IS NULL AND media_files.unreferenced_since IS NOT NULL AND media_files.unreferenced_since <= '{cutoff}'"
        ))?;
        let trash = self.items("media_files.trashed_at IS NOT NULL")?;
        Ok(MediaListing {
            candidate_bytes: candidates.iter().map(|item| item.size).sum(),
            candidates,
            trash,
            grace_days: GRACE_DAYS,
            trash_retention_days: TRASH_RETENTION_DAYS,
        })
    }

    // Moves candidates to the trash. Each file is checked again right before:
    // registered and not trashed, past the grace period, not referenced by a
    // fresh scan, inside a media root. Anything else is skipped with a reason.
    pub fn trash(
        &self,
        actor: &Actor<'_>,
        roots: &MediaRoots,
        references: &[String],
        now: DateTime<Utc>,
    ) -> Result<MediaOutcome, String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let live = referenced(&transaction, roots)?;
        let cutoff = now - Duration::days(GRACE_DAYS);
        let removable = roots.removable_roots();
        let mut outcome = MediaOutcome::default();
        for requested in references {
            let reference_key = roots.requested_key(requested);
            let skip = |reason: &str| Skipped {
                reference: requested.clone(),
                reason: reason.to_owned(),
            };
            let row: Option<(String, Option<String>, i64)> = transaction
                .query_row(
                    "SELECT reference, unreferenced_since, size FROM media_files WHERE ref_key = ?1 AND trashed_at IS NULL",
                    [&reference_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(error)?;
            let Some((reference, unreferenced_since, size)) = row else {
                outcome.skipped.push(skip("不在素材登记表中，或已在回收区"));
                continue;
            };
            if live.contains_key(&reference_key) {
                outcome.skipped.push(skip("仍被画布引用"));
                continue;
            }
            if !unreferenced_since
                .as_deref()
                .and_then(parse)
                .is_some_and(|since| since <= cutoff)
            {
                outcome.skipped.push(skip("仍在宽限期内"));
                continue;
            }
            let Some(path) = roots.resolve(&reference) else {
                outcome.skipped.push(skip("路径无效或目录未配置"));
                continue;
            };
            if super::rpc::ensure_contained(&path, &removable).is_err() || !path.is_file() {
                outcome.skipped.push(skip("文件不在媒体目录内或已不存在"));
                continue;
            }
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let relative = format!("{}/{file_name}", uuid::Uuid::new_v4());
            let target = roots.data.join(TRASH_DIR).join(&relative);
            if let Err(reason) = move_file(&path, &target) {
                outcome.skipped.push(skip(&format!("移动失败：{reason}")));
                continue;
            }
            if let Err(reason) = transaction.execute(
                "UPDATE media_files SET trashed_at = ?2, trash_path = ?3 WHERE ref_key = ?1",
                params![reference_key, time(now), relative],
            ) {
                let _ = move_file(&target, &path);
                return Err(error(reason));
            }
            outcome.bytes += size as u64;
            outcome.done.push(reference);
        }
        audit(&transaction, actor, "media_trash", &outcome)?;
        transaction.commit().map_err(error)?;
        Ok(outcome)
    }

    // Puts trashed files back where they were; their grace period restarts.
    pub fn restore(
        &self,
        actor: &Actor<'_>,
        roots: &MediaRoots,
        references: &[String],
        now: DateTime<Utc>,
    ) -> Result<MediaOutcome, String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let removable = roots.removable_roots();
        let mut outcome = MediaOutcome::default();
        for requested in references {
            let reference_key = roots.requested_key(requested);
            let skip = |reason: &str| Skipped {
                reference: requested.clone(),
                reason: reason.to_owned(),
            };
            let row: Option<(String, String, i64)> = transaction
                .query_row(
                    "SELECT reference, trash_path, size FROM media_files WHERE ref_key = ?1 AND trashed_at IS NOT NULL",
                    [&reference_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(error)?;
            let Some((reference, trash_path, size)) = row else {
                outcome.skipped.push(skip("不在回收区"));
                continue;
            };
            let Some(target) = roots.resolve(&reference) else {
                outcome.skipped.push(skip("路径无效或目录未配置"));
                continue;
            };
            if super::rpc::ensure_contained(&target, &removable).is_err() {
                outcome.skipped.push(skip("原位置不在媒体目录内"));
                continue;
            }
            if target.exists() {
                outcome.skipped.push(skip("原位置已有同名文件"));
                continue;
            }
            let Some(source) = trash_file(roots, &trash_path) else {
                outcome.skipped.push(skip("回收区里找不到这个文件"));
                continue;
            };
            if let Err(reason) = move_file(&source, &target) {
                outcome.skipped.push(skip(&format!("移动失败：{reason}")));
                continue;
            }
            if let Err(reason) = transaction.execute(
                "UPDATE media_files SET trashed_at = NULL, trash_path = NULL, unreferenced_since = ?2 WHERE ref_key = ?1",
                params![reference_key, time(now)],
            ) {
                let _ = move_file(&target, &source);
                return Err(error(reason));
            }
            remove_empty_parent(&source);
            outcome.bytes += size as u64;
            outcome.done.push(reference);
        }
        audit(&transaction, actor, "media_restore", &outcome)?;
        transaction.commit().map_err(error)?;
        Ok(outcome)
    }

    // Removes trashed files for good (only files already in the trash).
    pub fn purge(
        &self,
        actor: &Actor<'_>,
        roots: &MediaRoots,
        references: &[String],
    ) -> Result<MediaOutcome, String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut outcome = MediaOutcome::default();
        for requested in references {
            let reference_key = roots.requested_key(requested);
            let row: Option<(String, String, i64)> = transaction
                .query_row(
                    "SELECT reference, trash_path, size FROM media_files WHERE ref_key = ?1 AND trashed_at IS NOT NULL",
                    [&reference_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(error)?;
            let Some((reference, trash_path, size)) = row else {
                outcome.skipped.push(Skipped {
                    reference: requested.clone(),
                    reason: "只能彻底删除回收区里的文件".to_owned(),
                });
                continue;
            };
            if let Some(file) = trash_file(roots, &trash_path) {
                fs::remove_file(&file).map_err(error)?;
                remove_empty_parent(&file);
            }
            transaction
                .execute(
                    "DELETE FROM media_files WHERE ref_key = ?1",
                    [&reference_key],
                )
                .map_err(error)?;
            outcome.bytes += size as u64;
            outcome.done.push(reference);
        }
        audit(&transaction, actor, "media_purge", &outcome)?;
        transaction.commit().map_err(error)?;
        Ok(outcome)
    }
}

// The output reference as written in content (or derived from a /view URL).
fn canonical_reference(roots: &MediaRoots, text: &str) -> Option<String> {
    if text.starts_with("sucanvas-output://") {
        return Some(text.to_owned());
    }
    let reference_key = roots.reference_key(text)?;
    // /view URLs and absolute paths: rebuild the reference from the file the
    // key resolves to (Windows paths are case-insensitive).
    let path = roots.resolve(&reference_key)?;
    roots.reference_of(&path)
}

// A trash entry must stay inside the trash folder.
fn trash_file(roots: &MediaRoots, relative: &str) -> Option<PathBuf> {
    let trash = roots.data.join(TRASH_DIR);
    let path = crate::portable::resource_path(&trash, &format!("sucanvas://{relative}")).ok()?;
    (super::rpc::ensure_contained(&path, std::slice::from_ref(&trash)).is_ok() && path.is_file())
        .then_some(path)
}

fn remove_empty_parent(file: &Path) {
    if let Some(parent) = file.parent() {
        let _ = fs::remove_dir(parent);
    }
}

fn expire_trash(
    connection: &Connection,
    roots: &MediaRoots,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let cutoff = time(now - Duration::days(TRASH_RETENTION_DAYS));
    let expired: Vec<(String, String, String, i64)> = {
        let mut statement = connection
            .prepare("SELECT ref_key, reference, trash_path, size FROM media_files WHERE trashed_at IS NOT NULL AND trashed_at <= ?1")
            .map_err(error)?;
        let rows = statement
            .query_map([&cutoff], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(error)?;
        rows.collect::<Result<_, _>>().map_err(error)?
    };
    let mut outcome = MediaOutcome::default();
    for (reference_key, reference, trash_path, size) in expired {
        if let Some(file) = trash_file(roots, &trash_path) {
            fs::remove_file(&file).map_err(error)?;
            remove_empty_parent(&file);
        }
        connection
            .execute(
                "DELETE FROM media_files WHERE ref_key = ?1",
                [&reference_key],
            )
            .map_err(error)?;
        outcome.bytes += size as u64;
        outcome.done.push(reference);
    }
    audit(connection, &SYSTEM, "media_trash_expired", &outcome)
}

// One audit row per action (usernames and file names, no contents).
fn audit(
    connection: &Connection,
    actor: &Actor<'_>,
    action: &str,
    outcome: &MediaOutcome,
) -> Result<(), String> {
    if outcome.done.is_empty() {
        return Ok(());
    }
    if connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(error)?
        .is_none()
    {
        return Ok(());
    }
    let mut files: Vec<&str> = outcome.done.iter().take(20).map(String::as_str).collect();
    if outcome.done.len() > files.len() {
        files.push("…");
    }
    insert_audit(
        connection,
        actor.id,
        actor.username,
        "",
        None,
        &format!(
            "{action} count={} bytes={} files={}",
            outcome.done.len(),
            outcome.bytes,
            files.join(",")
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::super::authz::tests::{world, World};
    use super::*;
    use serde_json::json;

    struct Media {
        world: World,
        roots: MediaRoots,
        registry: MediaRegistry,
        canvas: String,
        t0: DateTime<Utc>,
    }

    fn media() -> Media {
        let world = world();
        let root = world.fixture.root.clone();
        let roots = MediaRoots {
            input: Some(root.join("comfy-input")),
            output: Some(root.join("comfy-output")),
            data: root.join("data"),
        };
        for directory in [
            roots.data.join("uploads"),
            roots.data.join("temp").join("image-resize"),
            roots.input.clone().unwrap().join("sucanvas-imports"),
            roots.output.clone().unwrap(),
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        let registry = MediaRegistry::open(&world.fixture.database()).unwrap();
        let canvas = world.project(&world.alice, false);
        Media {
            world,
            roots,
            registry,
            canvas,
            t0: DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    impl Media {
        fn file(&self, reference: &str) -> PathBuf {
            let path = self.roots.resolve(reference).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, reference.as_bytes()).unwrap();
            path
        }
        // A node whose stored content is exactly `content` (as the Web stores it).
        fn node(&self, content: Value) -> String {
            let id = self.world.node(&self.canvas).id;
            self.set_content(&id, content);
            id
        }
        fn set_content(&self, node: &str, content: Value) {
            Connection::open(self.world.fixture.database())
                .unwrap()
                .execute(
                    "UPDATE nodes SET content_json = ?2 WHERE id = ?1",
                    params![node, content.to_string()],
                )
                .unwrap();
        }
        fn days(&self, days: i64) -> DateTime<Utc> {
            self.t0 + Duration::days(days)
        }
        fn candidates(&self, now: DateTime<Utc>) -> Vec<String> {
            let mut names: Vec<_> = self
                .registry
                .list(&self.roots, now)
                .unwrap()
                .candidates
                .into_iter()
                .map(|item| item.reference)
                .collect();
            names.sort();
            names
        }
        fn admin(&self) -> String {
            self.world.admin.user_id.clone()
        }
        fn audit(&self) -> Vec<String> {
            let connection = Connection::open(self.world.fixture.database()).unwrap();
            let mut statement = connection
                .prepare("SELECT username || ' ' || command FROM audit_log WHERE command LIKE 'media_%' ORDER BY id")
                .unwrap();
            let rows = statement.query_map([], |row| row.get(0)).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        }
    }

    fn admin_actor(id: &str) -> Actor<'_> {
        Actor {
            id,
            username: "admin",
        }
    }

    // Everything a node can point at in every stored form counts, including
    // generationSnapshot reference images and audio; only the file nobody
    // references becomes a candidate, and a foreign file in the shared
    // ComfyUI output (never registered) is neither listed nor removable.
    #[test]
    fn referenced_files_never_become_candidates() {
        let media = media();
        let asset = media.file("sucanvas-input://sucanvas-imports/asset.png");
        let reference_image = media.file("sucanvas-input://sucanvas-imports/reference.png");
        let audio = media.file("sucanvas-input://sucanvas-imports/voice.mp3");
        let resize = media.file("sucanvas://temp/image-resize/resize-1.png");
        let generated = media.file("sucanvas-output://video/clip.mp4");
        let foreign = media.file("sucanvas-output://someone-else.png");
        let orphan = media.file("sucanvas-input://sucanvas-imports/orphan.png");
        media.node(json!({"assetPath": "sucanvas-input://sucanvas-imports/asset.png"}));
        media.node(json!({"generationSnapshot": {
            "imagePaths": ["sucanvas-input://sucanvas-imports/reference.png"],
            "audioPaths": ["/api/resource?resource=sucanvas-input%3A%2F%2Fsucanvas-imports%2Fvoice.mp3"],
        }}));
        media.node(json!({"assetPath": "sucanvas://temp/image-resize/resize-1.png"}));
        media.node(json!({"videoUrl": "http://127.0.0.1:8188/view?filename=clip.mp4&subfolder=video&type=output"}));
        // The output file is registered (backfilled) because it is referenced.
        media
            .registry
            .refresh(&media.roots, media.t0, None)
            .unwrap();
        let later = media.days(GRACE_DAYS + 30);
        assert_eq!(
            media.candidates(later),
            vec!["sucanvas-input://sucanvas-imports/orphan.png".to_owned()]
        );
        let actor_id = media.admin();
        let outcome = media
            .registry
            .trash(
                &admin_actor(&actor_id),
                &media.roots,
                &[
                    "sucanvas-input://sucanvas-imports/reference.png".to_owned(),
                    "sucanvas-input://sucanvas-imports/voice.mp3".to_owned(),
                    "sucanvas-output://someone-else.png".to_owned(),
                ],
                later,
            )
            .unwrap();
        assert!(outcome.done.is_empty());
        assert_eq!(
            outcome
                .skipped
                .iter()
                .map(|skip| skip.reason.as_str())
                .collect::<Vec<_>>(),
            vec![
                "仍被画布引用",
                "仍被画布引用",
                "不在素材登记表中，或已在回收区"
            ]
        );
        for path in [
            asset,
            reference_image,
            audio,
            resize,
            generated,
            foreign,
            orphan,
        ] {
            assert!(path.is_file(), "{}", path.display());
        }
    }

    #[test]
    fn files_inside_the_grace_period_are_not_removed() {
        let media = media();
        let orphan = media.file("sucanvas://uploads/staging/left-over.png");
        media
            .registry
            .refresh(&media.roots, media.t0, None)
            .unwrap();
        let within = media.t0 + Duration::days(GRACE_DAYS) - Duration::seconds(1);
        assert!(media.candidates(within).is_empty());
        let actor_id = media.admin();
        let outcome = media
            .registry
            .trash(
                &admin_actor(&actor_id),
                &media.roots,
                &["sucanvas://uploads/staging/left-over.png".to_owned()],
                within,
            )
            .unwrap();
        assert_eq!(outcome.skipped[0].reason, "仍在宽限期内");
        assert!(orphan.is_file());
        assert_eq!(
            media.candidates(media.days(GRACE_DAYS)),
            vec!["sucanvas://uploads/staging/left-over.png".to_owned()]
        );
    }

    // Trash, restore (grace period restarts), trash again, purge; each step
    // audited with the acting admin.
    #[test]
    fn trashed_files_can_be_restored_then_purged() {
        let media = media();
        let reference = "sucanvas-input://sucanvas-imports/old.png".to_owned();
        let path = media.file(&reference);
        media
            .registry
            .refresh(&media.roots, media.t0, None)
            .unwrap();
        let actor_id = media.admin();
        let actor = admin_actor(&actor_id);
        let now = media.days(GRACE_DAYS + 1);
        let trashed = media
            .registry
            .trash(&actor, &media.roots, std::slice::from_ref(&reference), now)
            .unwrap();
        assert_eq!(trashed.done, vec![reference.clone()]);
        assert!(!path.exists());
        let listing = media.registry.list(&media.roots, now).unwrap();
        assert!(listing.candidates.is_empty());
        assert_eq!(listing.trash.len(), 1);
        assert!(listing.trash[0].trashed_at.is_some());
        // The Web RPC layer hands the registry absolute paths: same file.
        let restored = media
            .registry
            .restore(
                &actor,
                &media.roots,
                &[path.to_string_lossy().into_owned()],
                now,
            )
            .unwrap();
        assert_eq!(restored.done, vec![reference.clone()]);
        assert_eq!(fs::read(&path).unwrap(), reference.as_bytes());
        assert!(
            media.candidates(now).is_empty(),
            "the grace period restarts"
        );
        assert!(fs::read_dir(media.roots.data.join(TRASH_DIR))
            .unwrap()
            .next()
            .is_none());
        let later = now + Duration::days(GRACE_DAYS);
        media
            .registry
            .trash(
                &actor,
                &media.roots,
                std::slice::from_ref(&reference),
                later,
            )
            .unwrap();
        // Only trashed files can be purged.
        let other = "sucanvas-input://sucanvas-imports/kept.png".to_owned();
        let kept = media.file(&other);
        let purged = media
            .registry
            .purge(&actor, &media.roots, &[reference.clone(), other])
            .unwrap();
        assert_eq!(purged.done, vec![reference.clone()]);
        assert_eq!(purged.skipped[0].reason, "只能彻底删除回收区里的文件");
        assert!(kept.is_file() && !path.exists());
        assert!(media
            .registry
            .list(&media.roots, later)
            .unwrap()
            .trash
            .is_empty());
        let audit = media.audit();
        assert_eq!(audit.len(), 4);
        for (row, action) in
            audit
                .iter()
                .zip(["media_trash", "media_restore", "media_trash", "media_purge"])
        {
            assert!(
                row.starts_with(&format!("admin {action} count=1 ")),
                "{row}"
            );
            assert!(row.ends_with(&format!("files={reference}")), "{row}");
        }
    }

    // The check right before the move: a file listed as a candidate that a
    // node references again (undo, paste) is skipped and stays in place.
    #[test]
    fn a_reference_added_after_listing_blocks_the_removal() {
        let media = media();
        let reference = "sucanvas-input://sucanvas-imports/again.png".to_owned();
        let path = media.file(&reference);
        media
            .registry
            .refresh(&media.roots, media.t0, None)
            .unwrap();
        let now = media.days(GRACE_DAYS + 1);
        assert_eq!(media.candidates(now), vec![reference.clone()]);
        media.node(json!({"generationSnapshot": {"imagePaths": [reference]}}));
        let actor_id = media.admin();
        let outcome = media
            .registry
            .trash(
                &admin_actor(&actor_id),
                &media.roots,
                std::slice::from_ref(&reference),
                now,
            )
            .unwrap();
        assert_eq!(outcome.skipped[0].reason, "仍被画布引用");
        assert!(path.is_file());
        assert!(media.audit().is_empty());
    }

    // Registered rows pointing outside the removable folders (here the
    // database itself, in the data root) are never moved.
    #[test]
    fn only_files_inside_media_folders_are_removed() {
        let media = media();
        fs::create_dir_all(&media.roots.data).unwrap();
        let outside = media.roots.data.join("settings.json");
        fs::write(&outside, "{}").unwrap();
        Connection::open(media.world.fixture.database())
            .unwrap()
            .execute(
                "INSERT INTO media_files (ref_key, reference, category, size, registered_at, unreferenced_since) VALUES ('sucanvas://settings.json', 'sucanvas://settings.json', 'upload', 2, ?1, ?1)",
                [time(media.t0)],
            )
            .unwrap();
        let actor_id = media.admin();
        let outcome = media
            .registry
            .trash(
                &admin_actor(&actor_id),
                &media.roots,
                &[
                    "sucanvas://settings.json".to_owned(),
                    "sucanvas://../escape.png".to_owned(),
                ],
                media.days(GRACE_DAYS + 1),
            )
            .unwrap();
        assert!(outcome.done.is_empty());
        assert_eq!(outcome.skipped[0].reason, "文件不在媒体目录内或已不存在");
        assert!(outside.is_file());
    }

    // Deleting the last referencing node names the user; undo clears it.
    #[test]
    fn released_by_names_the_user_who_removed_the_last_reference() {
        let media = media();
        let reference = "sucanvas-output://image/gen.png".to_owned();
        media.file(&reference);
        let alice = media.world.alice.user_id.clone();
        media
            .registry
            .register_outputs(
                &media.roots,
                &json!({"outputs": [reference]}),
                &alice,
                media.t0,
            )
            .unwrap();
        let node = media.node(
            json!({"imageUrl": "/api/comfy/view?filename=gen.png&subfolder=image&type=output"}),
        );
        media
            .registry
            .refresh(&media.roots, media.t0, None)
            .unwrap();
        media.set_content(&node, json!({}));
        media
            .registry
            .refresh(&media.roots, media.t0, Some(&alice))
            .unwrap();
        let listing = media
            .registry
            .list(&media.roots, media.days(GRACE_DAYS))
            .unwrap();
        assert_eq!(listing.candidates.len(), 1);
        assert_eq!(listing.candidates[0].released_by.as_deref(), Some("alice"));
        assert_eq!(listing.candidates[0].created_by.as_deref(), Some("alice"));
        assert_eq!(listing.candidates[0].category, "generated");
        assert_eq!(
            listing.candidates[0].canvas_name.as_deref(),
            Some("project")
        );
        media.set_content(
            &node,
            json!({"imageUrl": "/api/comfy/view?filename=gen.png&subfolder=image&type=output"}),
        );
        assert!(media.candidates(media.days(GRACE_DAYS)).is_empty());
    }

    #[test]
    fn trash_expires_after_the_retention_period() {
        let media = media();
        let reference = "sucanvas://temp/image-resize/resize-old.png".to_owned();
        media.file(&reference);
        media
            .registry
            .refresh(&media.roots, media.t0, None)
            .unwrap();
        let actor_id = media.admin();
        let trashed_at = media.days(GRACE_DAYS);
        media
            .registry
            .trash(
                &admin_actor(&actor_id),
                &media.roots,
                std::slice::from_ref(&reference),
                trashed_at,
            )
            .unwrap();
        let kept = trashed_at + Duration::days(TRASH_RETENTION_DAYS) - Duration::seconds(1);
        assert_eq!(
            media.registry.list(&media.roots, kept).unwrap().trash.len(),
            1
        );
        let expired = trashed_at + Duration::days(TRASH_RETENTION_DAYS);
        assert!(media
            .registry
            .list(&media.roots, expired)
            .unwrap()
            .trash
            .is_empty());
        assert!(fs::read_dir(media.roots.data.join(TRASH_DIR))
            .unwrap()
            .next()
            .is_none());
        assert!(media
            .audit()
            .last()
            .unwrap()
            .starts_with("system media_trash_expired count=1 "));
    }

    // Incomplete information marks nothing: unreadable content stops the refresh.
    #[test]
    fn unreadable_content_stops_the_refresh() {
        let media = media();
        let reference = "sucanvas-input://sucanvas-imports/kept.png".to_owned();
        media.file(&reference);
        let node = media.node(json!({"assetPath": reference}));
        media
            .registry
            .refresh(&media.roots, media.t0, None)
            .unwrap();
        Connection::open(media.world.fixture.database())
            .unwrap()
            .execute(
                "UPDATE nodes SET content_json = '{broken' WHERE id = ?1",
                [&node],
            )
            .unwrap();
        assert!(media
            .registry
            .refresh(&media.roots, media.days(1), None)
            .is_err());
        assert!(media
            .registry
            .list(&media.roots, media.days(GRACE_DAYS + 1))
            .is_err());
        let actor_id = media.admin();
        assert!(media
            .registry
            .trash(
                &admin_actor(&actor_id),
                &media.roots,
                &[reference],
                media.days(GRACE_DAYS + 1)
            )
            .is_err());
    }

    // R1: 20 deletions in a row while a pass is running trigger one worker
    // and at most two full scans; every file is still released, by alice.
    #[test]
    fn twenty_deletions_trigger_at_most_two_scans() {
        let media = media();
        let alice = media.world.alice.user_id.clone();
        let mut nodes = Vec::new();
        for n in 0..20 {
            let reference = format!("sucanvas-input://sucanvas-imports/n{n}.png");
            media.file(&reference);
            nodes.push(media.node(json!({"assetPath": reference})));
        }
        let registry = Arc::new(MediaRegistry::open(&media.world.fixture.database()).unwrap());
        registry.refresh(&media.roots, media.t0, None).unwrap();
        let (before, _) = registry.scan_stats();
        let workers = Mutex::new(Vec::new());
        let connection = Connection::open(media.world.fixture.database()).unwrap();
        {
            // The first pass blocks on the registry until all 20 requests are in.
            let busy = registry.connection.lock().unwrap();
            for (n, node) in nodes.iter().enumerate() {
                connection
                    .execute("DELETE FROM nodes WHERE id = ?1", [node])
                    .unwrap();
                registry.schedule_refresh(media.roots.clone(), Some(&alice), |job| {
                    workers.lock().unwrap().push(std::thread::spawn(job));
                });
                if n == 0 {
                    // Let the worker take the first request before the others arrive.
                    while registry.queue.lock().unwrap().pending {
                        std::thread::yield_now();
                    }
                }
            }
            drop(busy);
        }
        let workers = workers.into_inner().unwrap();
        let started = workers.len();
        for worker in workers {
            worker.join().unwrap();
        }
        let (after, stats) = registry.scan_stats();
        assert_eq!(started, 1, "one worker for 20 deletions");
        assert!(
            after - before <= 2,
            "{} full scans for 20 deletions",
            after - before
        );
        assert_eq!(stats.unwrap().nodes, 0);
        assert!(!registry.queue.lock().unwrap().running);
        // The worker passes run on the real clock.
        let listing = registry
            .list(&media.roots, Utc::now() + Duration::days(GRACE_DAYS + 1))
            .unwrap();
        assert_eq!(listing.candidates.len(), 20);
        assert!(listing
            .candidates
            .iter()
            .all(|item| item.released_by.as_deref() == Some("alice")));
    }

    // Merged requests name their operator only when there was exactly one;
    // refreshes without an operator (periodic) do not count.
    #[test]
    fn merged_refreshes_name_a_single_operator_only() {
        let media = media();
        let registry = Arc::new(MediaRegistry::open(&media.world.fixture.database()).unwrap());
        let mut started = 0;
        let mut ask = |actor: Option<&str>| {
            registry.schedule_refresh(media.roots.clone(), actor, |_job| started += 1)
        };
        ask(Some("alice"));
        ask(None);
        assert_eq!(registry.next_pass(), Some(Some("alice".to_owned())));
        ask(Some("alice"));
        ask(Some("bob"));
        assert_eq!(registry.next_pass(), Some(None));
        assert_eq!(registry.next_pass(), None);
        assert!(!registry.queue.lock().unwrap().running);
        ask(None);
        assert_eq!(registry.next_pass(), Some(None));
        assert_eq!(
            started, 2,
            "a new worker only after the previous one stopped"
        );
    }

    // R2 measurement on a copy of a real database (not part of the suite):
    // SUCANVAS_MEDIA_BENCH_DB=<copy> cargo test -- --ignored media_refresh_timing --nocapture
    #[test]
    #[ignore]
    fn media_refresh_timing() {
        let database = PathBuf::from(std::env::var("SUCANVAS_MEDIA_BENCH_DB").unwrap());
        let root = database.parent().unwrap().join("bench-roots");
        let roots = MediaRoots {
            input: Some(root.join("input")),
            output: Some(root.join("output")),
            data: root.join("data"),
        };
        for directory in [
            roots.input.clone().unwrap(),
            roots.output.clone().unwrap(),
            roots.data.clone(),
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        let registry = MediaRegistry::open(&database).unwrap();
        for run in 1..=3 {
            let start = std::time::Instant::now();
            registry.refresh(&roots, Utc::now(), None).unwrap();
            let total = start.elapsed();
            let stats = registry.scan_stats().1.unwrap();
            let edges: i64 = registry
                .connection
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))
                .unwrap();
            let bytes: i64 = registry
                .connection
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COALESCE(SUM(LENGTH(content_json)), 0) FROM nodes",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            println!(
                "BENCH run={run} nodes={} edges={edges} content_bytes={bytes} total_ms={:.1} write_lock_ms={:.1}",
                stats.nodes,
                total.as_secs_f64() * 1000.0,
                stats.held.as_secs_f64() * 1000.0
            );
        }
    }

    #[test]
    fn constants_match_the_decision() {
        assert_eq!((GRACE_DAYS, TRASH_RETENTION_DAYS), (7, 30));
    }
}
