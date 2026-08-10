use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::models::{
    AppendPromptVersionInput, AppendPromptVersionResult, CanvasRecord, CreateEdgeInput,
    CreateMissingPromptScenesInput, CreateMissingPromptScenesResult, CreateNodeInput,
    CreateNodeResult, DeletedBatch, EdgeRecord, NodeRecord, PromptSceneBinding,
    PromptSceneBindingRecord, PromptSceneMutation, PromptSetScenesResult, PromptSetSummary,
    PromptVersionRecord, ReplaceNodeAndDeleteInput, ReplaceNodeAndDeleteResult,
    RestoreNodeReplacementInput, RestoreNodeReplacementResult, UpdateNodeInput, WorkspaceSnapshot,
    DEFAULT_CANVAS_ID,
};

#[derive(Debug, Error)]
pub enum CanvasError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("database lock is poisoned")]
    Poisoned,
}

pub type CanvasResult<T> = Result<T, CanvasError>;

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open(path: &std::path::Path) -> CanvasResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        let database = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        database.initialize()?;
        Ok(database)
    }

    #[cfg(test)]
    fn in_memory() -> CanvasResult<Self> {
        let database = Self {
            connection: Arc::new(Mutex::new(Connection::open_in_memory()?)),
        };
        database.initialize()?;
        Ok(database)
    }

    fn lock(&self) -> CanvasResult<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| CanvasError::Poisoned)
    }

    fn initialize(&self) -> CanvasResult<()> {
        let connection = self.lock()?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = DELETE;

            CREATE TABLE IF NOT EXISTS canvases (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                is_private INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                content_json TEXT NOT NULL,
                source TEXT NOT NULL,
                request_id TEXT UNIQUE,
                x REAL NOT NULL,
                y REAL NOT NULL,
                width REAL NOT NULL,
                height REAL NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_nodes_canvas_created
                ON nodes(canvas_id, created_at);

            CREATE TABLE IF NOT EXISTS edges (
                id TEXT PRIMARY KEY,
                canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(canvas_id, source_node_id, target_node_id, kind)
            );

            CREATE INDEX IF NOT EXISTS idx_edges_canvas
                ON edges(canvas_id);

            CREATE TABLE IF NOT EXISTS prompt_scene_bindings (
                prompt_set_id TEXT NOT NULL,
                prompt_set_title TEXT NOT NULL,
                canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                scene_key TEXT NOT NULL,
                scene_title TEXT NOT NULL,
                node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(prompt_set_id, scene_key)
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_scene_bindings_canvas
                ON prompt_scene_bindings(canvas_id, prompt_set_id, scene_key);

            CREATE TABLE IF NOT EXISTS prompt_version_requests (
                request_id TEXT PRIMARY KEY,
                node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                version_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_version_requests_node
                ON prompt_version_requests(node_id);
            ",
        )?;

        if !table_has_column(&connection, "canvases", "is_private")? {
            connection.execute(
                "ALTER TABLE canvases ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }

        let now = now();
        connection.execute(
            "INSERT OR IGNORE INTO canvases (id, name, created_at, updated_at)
             VALUES (?1, 'Main Canvas', ?2, ?2)",
            params![DEFAULT_CANVAS_ID, now],
        )?;
        Ok(())
    }

    pub fn rewrite_asset_paths(
        &self,
        legacy_assets_dir: &Path,
        assets_dir: &Path,
    ) -> CanvasResult<usize> {
        if legacy_assets_dir == assets_dir {
            return Ok(0);
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows = {
            let mut statement = transaction.prepare("SELECT id, content_json FROM nodes")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut updated = 0;

        for (id, content_json) in rows {
            let mut content: serde_json::Value = serde_json::from_str(&content_json)?;
            if rewrite_asset_paths_in_value(&mut content, legacy_assets_dir, assets_dir) {
                transaction.execute(
                    "UPDATE nodes SET content_json = ?2 WHERE id = ?1",
                    params![id, serde_json::to_string(&content)?],
                )?;
                updated += 1;
            }
        }

        transaction.commit()?;
        Ok(updated)
    }

    pub fn backup_to(&self, destination: &Path) -> CanvasResult<()> {
        if destination.exists() {
            return Err(CanvasError::Validation(format!(
                "backup database already exists: {}",
                destination.display()
            )));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let destination = destination.to_str().ok_or_else(|| {
            CanvasError::Validation("backup database path is not valid UTF-8".to_owned())
        })?;
        let connection = self.lock()?;
        connection.execute("VACUUM INTO ?1", [destination])?;
        Ok(())
    }

    pub fn verify_integrity(&self) -> CanvasResult<()> {
        let connection = self.lock()?;
        let result =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))?;
        if result.eq_ignore_ascii_case("ok") {
            Ok(())
        } else {
            Err(CanvasError::Validation(format!(
                "database integrity check failed: {result}"
            )))
        }
    }

    pub fn list_projects(&self) -> CanvasResult<Vec<WorkspaceSnapshot>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT id FROM canvases ORDER BY updated_at DESC, created_at DESC")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| load_workspace_from_connection(&connection, &id))
            .collect()
    }

    pub fn create_project(&self, name: &str) -> CanvasResult<WorkspaceSnapshot> {
        let name = validate_project_name(name)?;
        let connection = self.lock()?;
        let id = format!("canvas:{}", Uuid::new_v4());
        let timestamp = now();
        connection.execute(
            "INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, name, timestamp],
        )?;
        load_workspace_from_connection(&connection, &id)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> CanvasResult<CanvasRecord> {
        let name = validate_project_name(name)?;
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE canvases SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!("project not found: {id}")));
        }
        connection
            .query_row(
                "SELECT id, name, is_private, created_at, updated_at FROM canvases WHERE id = ?1",
                [id],
                |row| {
                    Ok(CanvasRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        is_private: row.get::<_, i64>(2)? != 0,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .map_err(CanvasError::Database)
    }

    pub fn set_project_private(&self, id: &str, is_private: bool) -> CanvasResult<CanvasRecord> {
        if id.trim().is_empty() {
            return Err(CanvasError::Validation(
                "project id cannot be empty".to_owned(),
            ));
        }
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE canvases SET is_private = ?2 WHERE id = ?1",
            params![id, i64::from(is_private)],
        )?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!("project not found: {id}")));
        }
        connection
            .query_row(
                "SELECT id, name, is_private, created_at, updated_at FROM canvases WHERE id = ?1",
                [id],
                |row| {
                    Ok(CanvasRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        is_private: row.get::<_, i64>(2)? != 0,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .map_err(CanvasError::Database)
    }

    pub fn delete_project(&self, id: &str) -> CanvasResult<()> {
        if id.trim().is_empty() {
            return Err(CanvasError::Validation(
                "project id cannot be empty".to_owned(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute("DELETE FROM canvases WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!("project not found: {id}")));
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn load_project(&self, canvas_id: &str) -> CanvasResult<WorkspaceSnapshot> {
        let connection = self.lock()?;
        load_workspace_from_connection(&connection, canvas_id)
    }

    pub fn list_prompt_sets(&self) -> CanvasResult<Vec<PromptSetSummary>> {
        let connection = self.lock()?;
        let bindings = list_prompt_scene_binding_records(&connection, None)?;
        prompt_set_summaries(&connection, &bindings)
    }

    pub fn get_prompt_set_scenes(
        &self,
        prompt_set_id: &str,
    ) -> CanvasResult<PromptSetScenesResult> {
        validate_prompt_identifier("prompt set id", prompt_set_id, 128)?;
        let connection = self.lock()?;
        let bindings = list_prompt_scene_binding_records(&connection, Some(prompt_set_id))?;
        if bindings.is_empty() {
            return Err(CanvasError::NotFound(format!(
                "prompt set not found: {prompt_set_id}"
            )));
        }
        let summaries = prompt_set_summaries(&connection, &bindings)?;
        let prompt_set = summaries.into_iter().next().ok_or_else(|| {
            CanvasError::NotFound(format!("prompt set not found: {prompt_set_id}"))
        })?;
        let scenes = bindings
            .iter()
            .map(|binding| prompt_scene_binding_view(&connection, binding))
            .collect::<CanvasResult<Vec<_>>>()?;
        Ok(PromptSetScenesResult { prompt_set, scenes })
    }

    pub fn create_missing_prompt_scenes(
        &self,
        prompt_set_id: &str,
        fallback_canvas_id: &str,
        input: CreateMissingPromptScenesInput,
    ) -> CanvasResult<CreateMissingPromptScenesResult> {
        validate_prompt_identifier("prompt set id", prompt_set_id, 128)?;
        let requested_title = validate_prompt_title("prompt set title", &input.prompt_set_title)?;
        if input.scenes.is_empty() {
            return Err(CanvasError::Validation(
                "at least one prompt scene is required".to_owned(),
            ));
        }
        if input.scenes.len() > 100 {
            return Err(CanvasError::Validation(
                "a prompt scene batch cannot exceed 100 scenes".to_owned(),
            ));
        }
        validate_optional_request_id(input.request_id.as_deref())?;

        let mut seen_scene_keys = BTreeSet::new();
        for scene in &input.scenes {
            validate_prompt_identifier("scene key", &scene.scene_key, 64)?;
            validate_prompt_title("scene title", &scene.title)?;
            validate_prompt_text(&scene.text, &scene.information)?;
            if !seen_scene_keys.insert(scene.scene_key.clone()) {
                return Err(CanvasError::Validation(format!(
                    "duplicate scene key in request: {}",
                    scene.scene_key
                )));
            }
        }

        let source = input
            .source
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "codex".to_owned());
        if source.chars().count() > 120 {
            return Err(CanvasError::Validation(
                "source exceeds 120 characters".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing_bindings =
            list_prompt_scene_binding_records(&transaction, Some(prompt_set_id))?;
        let existing_canvas_ids = existing_bindings
            .iter()
            .map(|binding| binding.canvas_id.as_str())
            .collect::<BTreeSet<_>>();
        if existing_canvas_ids.len() > 1 {
            return Err(CanvasError::Conflict(format!(
                "prompt set spans multiple projects: {prompt_set_id}"
            )));
        }
        let canvas_id = existing_canvas_ids
            .iter()
            .next()
            .map(|value| (*value).to_owned())
            .or(input.canvas_id.clone())
            .unwrap_or_else(|| fallback_canvas_id.to_owned());
        if let Some(requested_canvas_id) = input.canvas_id.as_deref() {
            if requested_canvas_id != canvas_id {
                return Err(CanvasError::Conflict(format!(
                    "prompt set {prompt_set_id} belongs to project {canvas_id}, not {requested_canvas_id}"
                )));
            }
        }
        ensure_canvas_exists(&transaction, &canvas_id)?;

        let prompt_set_title = existing_bindings
            .first()
            .map(|binding| binding.prompt_set_title.clone())
            .unwrap_or_else(|| requested_title.to_owned());
        if !existing_bindings.is_empty() && prompt_set_title != requested_title {
            return Err(CanvasError::Conflict(format!(
                "prompt set title mismatch: existing title is {prompt_set_title}"
            )));
        }

        let existing_by_key = existing_bindings
            .into_iter()
            .map(|binding| (binding.scene_key.clone(), binding))
            .collect::<BTreeMap<_, _>>();
        let mut mutations = Vec::with_capacity(input.scenes.len());
        let mut created_count = 0;

        for scene in input.scenes {
            if let Some(binding_record) = existing_by_key.get(&scene.scene_key) {
                let node =
                    get_node_by_id(&transaction, &binding_record.node_id)?.ok_or_else(|| {
                        CanvasError::Conflict(format!(
                            "scene binding points to a missing node: {}",
                            binding_record.node_id
                        ))
                    })?;
                let binding =
                    prompt_scene_binding_view_from_node(&transaction, binding_record, &node)?;
                mutations.push(PromptSceneMutation {
                    binding,
                    node,
                    created: false,
                });
                continue;
            }

            let timestamp = now();
            let version_id = format!("version:{}", Uuid::new_v4());
            let version_request_id = input
                .request_id
                .as_ref()
                .map(|request_id| format!("{request_id}:{}:v1", scene.scene_key));
            if let Some(request_id) = version_request_id.as_deref() {
                ensure_prompt_version_request_unused(&transaction, request_id)?;
            }
            let version = PromptVersionRecord {
                id: version_id.clone(),
                label: "v1".to_owned(),
                title: scene.title.clone(),
                text: scene.text.clone(),
                information: scene.information.clone(),
                created_at: timestamp.clone(),
                request_id: version_request_id.clone(),
                source: Some(source.clone()),
            };
            let request_id = input
                .request_id
                .as_ref()
                .map(|request_id| format!("{request_id}:{}", scene.scene_key));
            if let Some(request_id) = request_id.as_deref() {
                if get_node_by_request_id(&transaction, request_id)?.is_some() {
                    return Err(CanvasError::Conflict(format!(
                        "node request id was already used: {request_id}"
                    )));
                }
            }
            let (x, y) = next_position(&transaction, &canvas_id)?;
            let node = NodeRecord {
                id: format!("node:{}", Uuid::new_v4()),
                canvas_id: canvas_id.clone(),
                kind: "text".to_owned(),
                title: scene.title.clone(),
                content: json!({
                    "text": scene.text,
                    "information": scene.information,
                    "promptVersionNode": true,
                    "promptVersions": [version],
                    "activePromptVersionId": version_id,
                    "bestPromptVersionId": "",
                    "promptSetId": prompt_set_id,
                    "promptSetTitle": prompt_set_title,
                    "sceneKey": scene.scene_key,
                    "sceneTitle": scene.title,
                }),
                source: source.clone(),
                request_id,
                x,
                y,
                width: 360.0,
                height: 320.0,
                status: "ready".to_owned(),
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            };
            validate_node(&node)?;
            insert_node(&transaction, &node)?;
            if let Some(request_id) = version_request_id.as_deref() {
                insert_prompt_version_request(
                    &transaction,
                    request_id,
                    &node.id,
                    &version_id,
                    &timestamp,
                )?;
            }
            let binding_record = PromptSceneBindingRecord {
                prompt_set_id: prompt_set_id.to_owned(),
                prompt_set_title: prompt_set_title.clone(),
                canvas_id: canvas_id.clone(),
                scene_key: scene.scene_key,
                scene_title: scene.title,
                node_id: node.id.clone(),
                created_at: timestamp.clone(),
                updated_at: timestamp,
            };
            insert_prompt_scene_binding(&transaction, &binding_record)?;
            let binding =
                prompt_scene_binding_view_from_node(&transaction, &binding_record, &node)?;
            mutations.push(PromptSceneMutation {
                binding,
                node,
                created: true,
            });
            created_count += 1;
        }

        touch_canvas(&transaction, &canvas_id)?;
        let binding_records = list_prompt_scene_binding_records(&transaction, Some(prompt_set_id))?;
        let prompt_set = prompt_set_summaries(&transaction, &binding_records)?
            .into_iter()
            .next()
            .ok_or_else(|| {
                CanvasError::NotFound(format!("prompt set not found: {prompt_set_id}"))
            })?;
        transaction.commit()?;
        let existing_count = mutations.len() - created_count;
        Ok(CreateMissingPromptScenesResult {
            prompt_set,
            scenes: mutations,
            created_count,
            existing_count,
        })
    }

    pub fn append_prompt_version(
        &self,
        prompt_set_id: &str,
        scene_key: &str,
        input: AppendPromptVersionInput,
    ) -> CanvasResult<AppendPromptVersionResult> {
        validate_prompt_identifier("prompt set id", prompt_set_id, 128)?;
        validate_prompt_identifier("scene key", scene_key, 64)?;
        validate_prompt_text(&input.text, &input.information)?;
        validate_optional_request_id(Some(&input.request_id))?;
        let source = input
            .source
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "codex".to_owned());

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut binding_record =
            get_prompt_scene_binding_record(&transaction, prompt_set_id, scene_key)?.ok_or_else(
                || {
                    CanvasError::NotFound(format!(
                        "prompt scene not found: {prompt_set_id}/{scene_key}"
                    ))
                },
            )?;
        let mut node = get_node_by_id(&transaction, &binding_record.node_id)?.ok_or_else(|| {
            CanvasError::Conflict(format!(
                "scene binding points to a missing node: {}",
                binding_record.node_id
            ))
        })?;
        if node.kind != "text" || node.content.get("promptVersionNode") != Some(&Value::Bool(true))
        {
            return Err(CanvasError::Conflict(format!(
                "bound node is not a prompt version node: {}",
                node.id
            )));
        }

        let mut versions = prompt_versions_from_content(&node.content)?;
        if let Some((request_node_id, version_id)) =
            get_prompt_version_request(&transaction, &input.request_id)?
        {
            if request_node_id != node.id {
                return Err(CanvasError::Conflict(format!(
                    "prompt version request id was already used: {}",
                    input.request_id
                )));
            }
            let existing = versions
                .iter()
                .find(|version| version.id == version_id)
                .cloned()
                .ok_or_else(|| {
                    CanvasError::Conflict(format!(
                        "request {} was already applied, but its version was deleted",
                        input.request_id
                    ))
                })?;
            let binding =
                prompt_scene_binding_view_from_node(&transaction, &binding_record, &node)?;
            transaction.commit()?;
            return Ok(AppendPromptVersionResult {
                binding,
                node,
                version: existing,
                created: false,
            });
        }
        if let Some(expected_version_count) = input.expected_version_count {
            if versions.len() != expected_version_count {
                return Err(CanvasError::Conflict(format!(
                    "version count changed for {prompt_set_id}/{scene_key}: expected {expected_version_count}, actual {}",
                    versions.len()
                )));
            }
        }

        let version_number = versions
            .iter()
            .filter_map(|version| {
                version
                    .label
                    .strip_prefix(['v', 'V'])
                    .and_then(|value| value.parse::<usize>().ok())
            })
            .max()
            .unwrap_or(0)
            + 1;
        let timestamp = now();
        let version = PromptVersionRecord {
            id: format!("version:{}", Uuid::new_v4()),
            label: format!("v{version_number}"),
            title: input
                .title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| binding_record.scene_title.clone()),
            text: input.text,
            information: input.information,
            created_at: timestamp.clone(),
            request_id: Some(input.request_id),
            source: Some(source),
        };
        versions.push(version.clone());
        let content = node.content.as_object_mut().ok_or_else(|| {
            CanvasError::Conflict(format!("prompt node content is not an object: {}", node.id))
        })?;
        content.insert("text".to_owned(), Value::String(version.text.clone()));
        content.insert(
            "information".to_owned(),
            Value::String(version.information.clone()),
        );
        content.insert("promptVersionNode".to_owned(), Value::Bool(true));
        content.insert(
            "promptVersions".to_owned(),
            serde_json::to_value(&versions)?,
        );
        content.insert(
            "activePromptVersionId".to_owned(),
            Value::String(version.id.clone()),
        );
        content.insert(
            "promptSetId".to_owned(),
            Value::String(prompt_set_id.to_owned()),
        );
        content.insert(
            "promptSetTitle".to_owned(),
            Value::String(binding_record.prompt_set_title.clone()),
        );
        content.insert("sceneKey".to_owned(), Value::String(scene_key.to_owned()));
        content.insert(
            "sceneTitle".to_owned(),
            Value::String(binding_record.scene_title.clone()),
        );
        node.updated_at = timestamp.clone();
        validate_node(&node)?;
        write_node_update(&transaction, &node)?;
        insert_prompt_version_request(
            &transaction,
            version.request_id.as_deref().unwrap_or_default(),
            &node.id,
            &version.id,
            &timestamp,
        )?;
        binding_record.updated_at = timestamp;
        update_prompt_scene_binding(&transaction, &binding_record)?;
        touch_canvas(&transaction, &node.canvas_id)?;
        let binding = prompt_scene_binding_view_from_node(&transaction, &binding_record, &node)?;
        transaction.commit()?;

        Ok(AppendPromptVersionResult {
            binding,
            node,
            version,
            created: true,
        })
    }

    pub fn create_node(&self, input: CreateNodeInput) -> CanvasResult<CreateNodeResult> {
        validate_node_input(&input)?;
        let canvas_id = input
            .canvas_id
            .as_deref()
            .unwrap_or(DEFAULT_CANVAS_ID)
            .to_owned();
        let kind = input.kind.unwrap_or_else(|| "text".to_owned());
        let source = input.source.unwrap_or_else(|| "app".to_owned());
        let request_id = input.request_id.filter(|value| !value.trim().is_empty());
        let content_json = serde_json::to_string(&input.content)?;

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(request_id) = request_id.as_deref() {
            if let Some(node) = get_node_by_request_id(&transaction, request_id)? {
                transaction.commit()?;
                return Ok(CreateNodeResult {
                    node,
                    created: false,
                });
            }
        }

        let (auto_x, auto_y) = next_position(&transaction, &canvas_id)?;
        let node = NodeRecord {
            id: format!("node:{}", Uuid::new_v4()),
            canvas_id,
            kind,
            title: input.title,
            content: input.content,
            source,
            request_id,
            x: input.x.unwrap_or(auto_x),
            y: input.y.unwrap_or(auto_y),
            width: input.width.unwrap_or(360.0),
            height: input.height.unwrap_or(240.0),
            status: "ready".to_owned(),
            created_at: now(),
            updated_at: now(),
        };

        transaction.execute(
            "INSERT INTO nodes (
                id, canvas_id, kind, title, content_json, source, request_id,
                x, y, width, height, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                node.id,
                node.canvas_id,
                node.kind,
                node.title,
                content_json,
                node.source,
                node.request_id,
                node.x,
                node.y,
                node.width,
                node.height,
                node.status,
                node.created_at,
                node.updated_at,
            ],
        )?;
        touch_canvas(&transaction, &node.canvas_id)?;
        transaction.commit()?;

        Ok(CreateNodeResult {
            node,
            created: true,
        })
    }

    pub fn update_node(&self, input: UpdateNodeInput) -> CanvasResult<NodeRecord> {
        let connection = self.lock()?;
        let mut node = get_node_by_id(&connection, &input.id)?
            .ok_or_else(|| CanvasError::Validation(format!("node not found: {}", input.id)))?;
        apply_node_update(&mut node, input);
        validate_node(&node)?;
        node.updated_at = now();
        write_node_update(&connection, &node)?;
        touch_canvas(&connection, &node.canvas_id)?;
        Ok(node)
    }

    pub fn replace_node_and_delete_with_snapshot(
        &self,
        input: ReplaceNodeAndDeleteInput,
    ) -> CanvasResult<ReplaceNodeAndDeleteResult> {
        let unique_ids = input
            .delete_ids
            .iter()
            .filter(|id| !id.trim().is_empty())
            .cloned()
            .collect::<BTreeSet<_>>();
        if unique_ids.is_empty() {
            return Err(CanvasError::Validation(
                "at least one node is required".to_owned(),
            ));
        }
        if unique_ids.contains(&input.update.id) {
            return Err(CanvasError::Validation(
                "the replacement target cannot also be deleted".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous_node = get_node_by_id(&transaction, &input.update.id)?.ok_or_else(|| {
            CanvasError::Validation(format!("node not found: {}", input.update.id))
        })?;
        let mut node = previous_node.clone();
        apply_node_update(&mut node, input.update);
        validate_node(&node)?;
        node.updated_at = now();

        let mut deleted_nodes = Vec::new();
        let mut deleted_edges = BTreeMap::new();
        let mut deleted_prompt_scene_bindings = Vec::new();
        for id in &unique_ids {
            let deleted_node = get_node_by_id(&transaction, id)?
                .ok_or_else(|| CanvasError::Validation(format!("node not found: {id}")))?;
            if deleted_node.canvas_id != node.canvas_id {
                return Err(CanvasError::Validation(
                    "replacement and deleted nodes must belong to the same project".to_owned(),
                ));
            }
            deleted_nodes.push(deleted_node);
            let mut statement = transaction.prepare(
                "SELECT id, canvas_id, source_node_id, target_node_id, kind,
                        metadata_json, created_at
                 FROM edges WHERE source_node_id = ?1 OR target_node_id = ?1",
            )?;
            let incident_edges = statement
                .query_map([id], edge_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            for edge in incident_edges {
                deleted_edges.insert(edge.id.clone(), edge);
            }
            if let Some(binding) = get_prompt_scene_binding_by_node_id(&transaction, id)? {
                deleted_prompt_scene_bindings.push(binding);
            }
        }

        write_node_update(&transaction, &node)?;
        for id in &unique_ids {
            transaction.execute("DELETE FROM nodes WHERE id = ?1", [id])?;
        }
        touch_canvas(&transaction, &node.canvas_id)?;
        transaction.commit()?;

        Ok(ReplaceNodeAndDeleteResult {
            previous_node,
            node,
            deleted: DeletedBatch {
                nodes: deleted_nodes,
                edges: deleted_edges.into_values().collect(),
                prompt_scene_bindings: deleted_prompt_scene_bindings,
            },
        })
    }

    pub fn restore_node_replacement(
        &self,
        input: RestoreNodeReplacementInput,
    ) -> CanvasResult<RestoreNodeReplacementResult> {
        validate_node(&input.previous_node)?;
        if input.deleted.nodes.is_empty() {
            return Err(CanvasError::Validation(
                "deleted batch contains no nodes".to_owned(),
            ));
        }
        for node in &input.deleted.nodes {
            validate_node(node)?;
            if node.id == input.previous_node.id {
                return Err(CanvasError::Validation(
                    "the replacement target cannot be part of the deleted batch".to_owned(),
                ));
            }
            if node.canvas_id != input.previous_node.canvas_id {
                return Err(CanvasError::Validation(
                    "replacement and restored nodes must belong to the same project".to_owned(),
                ));
            }
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = get_node_by_id(&transaction, &input.previous_node.id)?.ok_or_else(|| {
            CanvasError::Validation(format!("node not found: {}", input.previous_node.id))
        })?;
        if current.canvas_id != input.previous_node.canvas_id {
            return Err(CanvasError::Validation(
                "replacement target project changed".to_owned(),
            ));
        }

        write_node_update(&transaction, &input.previous_node)?;
        for node in &input.deleted.nodes {
            let content_json = serde_json::to_string(&node.content)?;
            transaction.execute(
                "INSERT INTO nodes (
                    id, canvas_id, kind, title, content_json, source, request_id,
                    x, y, width, height, status, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    node.id,
                    node.canvas_id,
                    node.kind,
                    node.title,
                    content_json,
                    node.source,
                    node.request_id,
                    node.x,
                    node.y,
                    node.width,
                    node.height,
                    node.status,
                    node.created_at,
                    node.updated_at,
                ],
            )?;
            restore_prompt_version_requests_from_node(&transaction, node)?;
        }
        for binding in &input.deleted.prompt_scene_bindings {
            insert_prompt_scene_binding(&transaction, binding)?;
        }
        for edge in &input.deleted.edges {
            let metadata_json = serde_json::to_string(&edge.metadata)?;
            transaction.execute(
                "INSERT INTO edges (
                    id, canvas_id, source_node_id, target_node_id, kind,
                    metadata_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    edge.id,
                    edge.canvas_id,
                    edge.source_node_id,
                    edge.target_node_id,
                    edge.kind,
                    metadata_json,
                    edge.created_at,
                ],
            )?;
        }
        touch_canvas(&transaction, &input.previous_node.canvas_id)?;
        transaction.commit()?;

        Ok(RestoreNodeReplacementResult {
            node: input.previous_node,
            restored: input.deleted,
        })
    }

    pub fn delete_node(&self, id: &str) -> CanvasResult<()> {
        let connection = self.lock()?;
        let canvas_id = get_node_by_id(&connection, id)?
            .map(|node| node.canvas_id)
            .ok_or_else(|| CanvasError::Validation(format!("node not found: {id}")))?;
        let changed = connection.execute("DELETE FROM nodes WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!("node not found: {id}")));
        }
        touch_canvas(&connection, &canvas_id)?;
        Ok(())
    }

    pub fn delete_nodes_with_snapshot(&self, ids: &[String]) -> CanvasResult<DeletedBatch> {
        let unique_ids = ids
            .iter()
            .filter(|id| !id.trim().is_empty())
            .cloned()
            .collect::<BTreeSet<_>>();
        if unique_ids.is_empty() {
            return Err(CanvasError::Validation(
                "at least one node is required".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut nodes = Vec::new();
        let mut edges = BTreeMap::new();
        let mut prompt_scene_bindings = Vec::new();
        let mut canvas_ids = BTreeSet::new();

        for id in &unique_ids {
            let node = get_node_by_id(&transaction, id)?
                .ok_or_else(|| CanvasError::Validation(format!("node not found: {id}")))?;
            canvas_ids.insert(node.canvas_id.clone());
            nodes.push(node);

            let mut statement = transaction.prepare(
                "SELECT id, canvas_id, source_node_id, target_node_id, kind,
                        metadata_json, created_at
                 FROM edges WHERE source_node_id = ?1 OR target_node_id = ?1",
            )?;
            let incident_edges = statement
                .query_map([id], edge_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            for edge in incident_edges {
                edges.insert(edge.id.clone(), edge);
            }
            if let Some(binding) = get_prompt_scene_binding_by_node_id(&transaction, id)? {
                prompt_scene_bindings.push(binding);
            }
        }

        for id in &unique_ids {
            transaction.execute("DELETE FROM nodes WHERE id = ?1", [id])?;
        }
        for canvas_id in canvas_ids {
            touch_canvas(&transaction, &canvas_id)?;
        }
        transaction.commit()?;

        Ok(DeletedBatch {
            nodes,
            edges: edges.into_values().collect(),
            prompt_scene_bindings,
        })
    }

    pub fn restore_deleted_batch(&self, batch: DeletedBatch) -> CanvasResult<DeletedBatch> {
        if batch.nodes.is_empty() {
            return Err(CanvasError::Validation(
                "deleted batch contains no nodes".to_owned(),
            ));
        }
        for node in &batch.nodes {
            validate_node(node)?;
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut canvas_ids = BTreeSet::new();

        for node in &batch.nodes {
            let content_json = serde_json::to_string(&node.content)?;
            transaction.execute(
                "INSERT INTO nodes (
                    id, canvas_id, kind, title, content_json, source, request_id,
                    x, y, width, height, status, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    node.id,
                    node.canvas_id,
                    node.kind,
                    node.title,
                    content_json,
                    node.source,
                    node.request_id,
                    node.x,
                    node.y,
                    node.width,
                    node.height,
                    node.status,
                    node.created_at,
                    node.updated_at,
                ],
            )?;
            restore_prompt_version_requests_from_node(&transaction, node)?;
            canvas_ids.insert(node.canvas_id.clone());
        }

        for binding in &batch.prompt_scene_bindings {
            insert_prompt_scene_binding(&transaction, binding)?;
        }

        for edge in &batch.edges {
            let metadata_json = serde_json::to_string(&edge.metadata)?;
            transaction.execute(
                "INSERT INTO edges (
                    id, canvas_id, source_node_id, target_node_id, kind,
                    metadata_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    edge.id,
                    edge.canvas_id,
                    edge.source_node_id,
                    edge.target_node_id,
                    edge.kind,
                    metadata_json,
                    edge.created_at,
                ],
            )?;
        }
        for canvas_id in canvas_ids {
            touch_canvas(&transaction, &canvas_id)?;
        }
        transaction.commit()?;
        Ok(batch)
    }

    pub fn create_edge(&self, input: CreateEdgeInput) -> CanvasResult<EdgeRecord> {
        if input.source_node_id == input.target_node_id {
            return Err(CanvasError::Validation(
                "an edge cannot connect a node to itself".to_owned(),
            ));
        }
        let canvas_id = input
            .canvas_id
            .as_deref()
            .unwrap_or(DEFAULT_CANVAS_ID)
            .to_owned();
        let kind = input.kind.unwrap_or_else(|| "flow".to_owned());
        validate_kind(&kind)?;
        let metadata_json = serde_json::to_string(&input.metadata)?;
        let connection = self.lock()?;
        let source = get_node_by_id(&connection, &input.source_node_id)?
            .ok_or_else(|| CanvasError::Validation("source node not found".to_owned()))?;
        let target = get_node_by_id(&connection, &input.target_node_id)?
            .ok_or_else(|| CanvasError::Validation("target node not found".to_owned()))?;
        if source.canvas_id != canvas_id || target.canvas_id != canvas_id {
            return Err(CanvasError::Validation(
                "an edge cannot connect nodes across projects".to_owned(),
            ));
        }

        let existing = connection
            .query_row(
                "SELECT id, canvas_id, source_node_id, target_node_id, kind,
                        metadata_json, created_at
                 FROM edges
                 WHERE canvas_id = ?1 AND source_node_id = ?2
                   AND target_node_id = ?3 AND kind = ?4",
                params![canvas_id, input.source_node_id, input.target_node_id, kind],
                edge_from_row,
            )
            .optional()?;
        if let Some(edge) = existing {
            return Ok(edge);
        }

        let edge = EdgeRecord {
            id: format!("edge:{}", Uuid::new_v4()),
            canvas_id,
            source_node_id: input.source_node_id,
            target_node_id: input.target_node_id,
            kind,
            metadata: input.metadata,
            created_at: now(),
        };
        connection.execute(
            "INSERT INTO edges (
                id, canvas_id, source_node_id, target_node_id, kind,
                metadata_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                edge.id,
                edge.canvas_id,
                edge.source_node_id,
                edge.target_node_id,
                edge.kind,
                metadata_json,
                edge.created_at,
            ],
        )?;
        touch_canvas(&connection, &edge.canvas_id)?;
        Ok(edge)
    }

    pub fn delete_edge(&self, id: &str) -> CanvasResult<()> {
        let connection = self.lock()?;
        let canvas_id = connection
            .query_row("SELECT canvas_id FROM edges WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .ok_or_else(|| CanvasError::Validation(format!("edge not found: {id}")))?;
        let changed = connection.execute("DELETE FROM edges WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!("edge not found: {id}")));
        }
        touch_canvas(&connection, &canvas_id)?;
        Ok(())
    }
}

fn rewrite_asset_paths_in_value(
    value: &mut serde_json::Value,
    legacy_assets_dir: &Path,
    assets_dir: &Path,
) -> bool {
    match value {
        serde_json::Value::String(path) => {
            let candidate = Path::new(path);
            let Ok(relative) = candidate.strip_prefix(legacy_assets_dir) else {
                return false;
            };
            *path = assets_dir.join(relative).to_string_lossy().into_owned();
            true
        }
        serde_json::Value::Array(values) => {
            let mut changed = false;
            for item in values {
                changed |= rewrite_asset_paths_in_value(item, legacy_assets_dir, assets_dir);
            }
            changed
        }
        serde_json::Value::Object(values) => {
            let mut changed = false;
            for item in values.values_mut() {
                changed |= rewrite_asset_paths_in_value(item, legacy_assets_dir, assets_dir);
            }
            changed
        }
        _ => false,
    }
}

fn insert_node(connection: &Connection, node: &NodeRecord) -> CanvasResult<()> {
    let content_json = serde_json::to_string(&node.content)?;
    connection.execute(
        "INSERT INTO nodes (
            id, canvas_id, kind, title, content_json, source, request_id,
            x, y, width, height, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            node.id,
            node.canvas_id,
            node.kind,
            node.title,
            content_json,
            node.source,
            node.request_id,
            node.x,
            node.y,
            node.width,
            node.height,
            node.status,
            node.created_at,
            node.updated_at,
        ],
    )?;
    Ok(())
}

fn insert_prompt_scene_binding(
    connection: &Connection,
    binding: &PromptSceneBindingRecord,
) -> CanvasResult<()> {
    connection.execute(
        "INSERT INTO prompt_scene_bindings (
            prompt_set_id, prompt_set_title, canvas_id, scene_key, scene_title,
            node_id, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            binding.prompt_set_id,
            binding.prompt_set_title,
            binding.canvas_id,
            binding.scene_key,
            binding.scene_title,
            binding.node_id,
            binding.created_at,
            binding.updated_at,
        ],
    )?;
    Ok(())
}

fn update_prompt_scene_binding(
    connection: &Connection,
    binding: &PromptSceneBindingRecord,
) -> CanvasResult<()> {
    let changed = connection.execute(
        "UPDATE prompt_scene_bindings
         SET prompt_set_title = ?3, canvas_id = ?4, scene_title = ?5,
             node_id = ?6, updated_at = ?7
         WHERE prompt_set_id = ?1 AND scene_key = ?2",
        params![
            binding.prompt_set_id,
            binding.scene_key,
            binding.prompt_set_title,
            binding.canvas_id,
            binding.scene_title,
            binding.node_id,
            binding.updated_at,
        ],
    )?;
    if changed == 0 {
        return Err(CanvasError::NotFound(format!(
            "prompt scene not found: {}/{}",
            binding.prompt_set_id, binding.scene_key
        )));
    }
    Ok(())
}

fn prompt_scene_binding_from_row(row: &Row<'_>) -> rusqlite::Result<PromptSceneBindingRecord> {
    Ok(PromptSceneBindingRecord {
        prompt_set_id: row.get(0)?,
        prompt_set_title: row.get(1)?,
        canvas_id: row.get(2)?,
        scene_key: row.get(3)?,
        scene_title: row.get(4)?,
        node_id: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn get_prompt_scene_binding_record(
    connection: &Connection,
    prompt_set_id: &str,
    scene_key: &str,
) -> CanvasResult<Option<PromptSceneBindingRecord>> {
    Ok(connection
        .query_row(
            "SELECT prompt_set_id, prompt_set_title, canvas_id, scene_key, scene_title,
                    node_id, created_at, updated_at
             FROM prompt_scene_bindings
             WHERE prompt_set_id = ?1 AND scene_key = ?2",
            params![prompt_set_id, scene_key],
            prompt_scene_binding_from_row,
        )
        .optional()?)
}

fn get_prompt_scene_binding_by_node_id(
    connection: &Connection,
    node_id: &str,
) -> CanvasResult<Option<PromptSceneBindingRecord>> {
    Ok(connection
        .query_row(
            "SELECT prompt_set_id, prompt_set_title, canvas_id, scene_key, scene_title,
                    node_id, created_at, updated_at
             FROM prompt_scene_bindings WHERE node_id = ?1",
            [node_id],
            prompt_scene_binding_from_row,
        )
        .optional()?)
}

fn list_prompt_scene_binding_records(
    connection: &Connection,
    prompt_set_id: Option<&str>,
) -> CanvasResult<Vec<PromptSceneBindingRecord>> {
    let sql = if prompt_set_id.is_some() {
        "SELECT prompt_set_id, prompt_set_title, canvas_id, scene_key, scene_title,
                node_id, created_at, updated_at
         FROM prompt_scene_bindings WHERE prompt_set_id = ?1
         ORDER BY scene_key COLLATE NOCASE ASC"
    } else {
        "SELECT prompt_set_id, prompt_set_title, canvas_id, scene_key, scene_title,
                node_id, created_at, updated_at
         FROM prompt_scene_bindings
         ORDER BY updated_at DESC, prompt_set_id COLLATE NOCASE ASC, scene_key COLLATE NOCASE ASC"
    };
    let mut statement = connection.prepare(sql)?;
    let bindings = match prompt_set_id {
        Some(prompt_set_id) => statement
            .query_map([prompt_set_id], prompt_scene_binding_from_row)?
            .collect::<Result<Vec<_>, _>>()?,
        None => statement
            .query_map([], prompt_scene_binding_from_row)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(bindings)
}

fn prompt_versions_from_content(content: &Value) -> CanvasResult<Vec<PromptVersionRecord>> {
    let Some(values) = content.get("promptVersions").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    values
        .iter()
        .map(|value| {
            let object = value.as_object().ok_or_else(|| {
                CanvasError::Conflict("prompt version entry is not an object".to_owned())
            })?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| CanvasError::Conflict("prompt version id is missing".to_owned()))?;
            let label = object.get("label").and_then(Value::as_str).ok_or_else(|| {
                CanvasError::Conflict("prompt version label is missing".to_owned())
            })?;
            let text = object.get("text").and_then(Value::as_str).ok_or_else(|| {
                CanvasError::Conflict("prompt version text is missing".to_owned())
            })?;
            Ok(PromptVersionRecord {
                id: id.to_owned(),
                label: label.to_owned(),
                title: object
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(label)
                    .to_owned(),
                text: text.to_owned(),
                information: object
                    .get("information")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                created_at: object
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                request_id: object
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                source: object
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

fn get_prompt_version_request(
    connection: &Connection,
    request_id: &str,
) -> CanvasResult<Option<(String, String)>> {
    Ok(connection
        .query_row(
            "SELECT node_id, version_id FROM prompt_version_requests WHERE request_id = ?1",
            [request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?)
}

fn ensure_prompt_version_request_unused(
    connection: &Connection,
    request_id: &str,
) -> CanvasResult<()> {
    if get_prompt_version_request(connection, request_id)?.is_some() {
        Err(CanvasError::Conflict(format!(
            "prompt version request id was already used: {request_id}"
        )))
    } else {
        Ok(())
    }
}

fn insert_prompt_version_request(
    connection: &Connection,
    request_id: &str,
    node_id: &str,
    version_id: &str,
    created_at: &str,
) -> CanvasResult<()> {
    connection.execute(
        "INSERT INTO prompt_version_requests (request_id, node_id, version_id, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![request_id, node_id, version_id, created_at],
    )?;
    Ok(())
}

fn restore_prompt_version_requests_from_node(
    connection: &Connection,
    node: &NodeRecord,
) -> CanvasResult<()> {
    for version in prompt_versions_from_content(&node.content)? {
        if let Some(request_id) = version.request_id.as_deref() {
            insert_prompt_version_request(
                connection,
                request_id,
                &node.id,
                &version.id,
                &version.created_at,
            )?;
        }
    }
    Ok(())
}

fn prompt_scene_binding_view(
    connection: &Connection,
    binding: &PromptSceneBindingRecord,
) -> CanvasResult<PromptSceneBinding> {
    let node = get_node_by_id(connection, &binding.node_id)?.ok_or_else(|| {
        CanvasError::Conflict(format!(
            "scene binding points to a missing node: {}",
            binding.node_id
        ))
    })?;
    prompt_scene_binding_view_from_node(connection, binding, &node)
}

fn prompt_scene_binding_view_from_node(
    connection: &Connection,
    binding: &PromptSceneBindingRecord,
    node: &NodeRecord,
) -> CanvasResult<PromptSceneBinding> {
    let canvas_name = connection
        .query_row(
            "SELECT name FROM canvases WHERE id = ?1",
            [&binding.canvas_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            CanvasError::NotFound(format!("project not found: {}", binding.canvas_id))
        })?;
    let versions = prompt_versions_from_content(&node.content)?;
    let latest_version = versions.last().map(|version| version.label.clone());
    Ok(PromptSceneBinding {
        prompt_set_id: binding.prompt_set_id.clone(),
        prompt_set_title: binding.prompt_set_title.clone(),
        canvas_id: binding.canvas_id.clone(),
        canvas_name,
        scene_key: binding.scene_key.clone(),
        scene_title: binding.scene_title.clone(),
        node_id: binding.node_id.clone(),
        latest_version,
        version_count: versions.len(),
        updated_at: std::cmp::max(binding.updated_at.clone(), node.updated_at.clone()),
    })
}

fn prompt_set_summaries(
    connection: &Connection,
    bindings: &[PromptSceneBindingRecord],
) -> CanvasResult<Vec<PromptSetSummary>> {
    let mut grouped = BTreeMap::<String, Vec<&PromptSceneBindingRecord>>::new();
    for binding in bindings {
        grouped
            .entry(binding.prompt_set_id.clone())
            .or_default()
            .push(binding);
    }
    let mut summaries = Vec::with_capacity(grouped.len());
    for (prompt_set_id, records) in grouped {
        let canvas_ids = records
            .iter()
            .map(|binding| binding.canvas_id.as_str())
            .collect::<BTreeSet<_>>();
        if canvas_ids.len() != 1 {
            return Err(CanvasError::Conflict(format!(
                "prompt set spans multiple projects: {prompt_set_id}"
            )));
        }
        let first = records[0];
        let canvas_name = connection
            .query_row(
                "SELECT name FROM canvases WHERE id = ?1",
                [&first.canvas_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| {
                CanvasError::NotFound(format!("project not found: {}", first.canvas_id))
            })?;
        let updated_at = records
            .iter()
            .map(|binding| binding.updated_at.as_str())
            .max()
            .unwrap_or(first.updated_at.as_str())
            .to_owned();
        summaries.push(PromptSetSummary {
            prompt_set_id,
            title: first.prompt_set_title.clone(),
            canvas_id: first.canvas_id.clone(),
            canvas_name,
            scene_count: records.len(),
            updated_at,
        });
    }
    summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(summaries)
}

fn ensure_canvas_exists(connection: &Connection, canvas_id: &str) -> CanvasResult<()> {
    let exists = connection
        .query_row("SELECT 1 FROM canvases WHERE id = ?1", [canvas_id], |_| {
            Ok(())
        })
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(CanvasError::NotFound(format!(
            "project not found: {canvas_id}"
        )))
    }
}

fn validate_prompt_identifier(label: &str, value: &str, max_length: usize) -> CanvasResult<()> {
    if value.is_empty()
        || value.len() > max_length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(CanvasError::Validation(format!(
            "{label} must use 1-{max_length} ASCII letters, digits, dots, colons, underscores, or hyphens"
        )));
    }
    Ok(())
}

fn validate_prompt_title<'a>(label: &str, value: &'a str) -> CanvasResult<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CanvasError::Validation(format!("{label} cannot be empty")));
    }
    if value.chars().count() > 500 {
        return Err(CanvasError::Validation(format!(
            "{label} exceeds 500 characters"
        )));
    }
    Ok(value)
}

fn validate_prompt_text(text: &str, information: &str) -> CanvasResult<()> {
    if text.trim().is_empty() {
        return Err(CanvasError::Validation(
            "prompt text cannot be empty".to_owned(),
        ));
    }
    if text.len() + information.len() > 480 * 1024 {
        return Err(CanvasError::Validation(
            "prompt text and information exceed 480 KiB".to_owned(),
        ));
    }
    Ok(())
}

fn validate_optional_request_id(request_id: Option<&str>) -> CanvasResult<()> {
    if let Some(request_id) = request_id {
        if request_id.trim().is_empty() || request_id.chars().count() > 200 {
            return Err(CanvasError::Validation(
                "request id must contain 1-200 characters".to_owned(),
            ));
        }
    }
    Ok(())
}

fn load_workspace_from_connection(
    connection: &Connection,
    canvas_id: &str,
) -> CanvasResult<WorkspaceSnapshot> {
    let canvas = connection.query_row(
        "SELECT id, name, is_private, created_at, updated_at FROM canvases WHERE id = ?1",
        [canvas_id],
        |row| {
            Ok(CanvasRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                is_private: row.get::<_, i64>(2)? != 0,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )?;

    let mut node_statement = connection.prepare(
        "SELECT id, canvas_id, kind, title, content_json, source, request_id,
                x, y, width, height, status, created_at, updated_at
         FROM nodes WHERE canvas_id = ?1 ORDER BY created_at ASC",
    )?;
    let nodes = node_statement
        .query_map([canvas_id], node_from_row)?
        .collect::<Result<Vec<_>, _>>()?;

    let mut edge_statement = connection.prepare(
        "SELECT id, canvas_id, source_node_id, target_node_id, kind,
                metadata_json, created_at
         FROM edges WHERE canvas_id = ?1 ORDER BY created_at ASC",
    )?;
    let edges = edge_statement
        .query_map([canvas_id], edge_from_row)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(WorkspaceSnapshot {
        canvas,
        nodes,
        edges,
    })
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> CanvasResult<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|name| name == column))
}

fn apply_node_update(node: &mut NodeRecord, input: UpdateNodeInput) {
    if let Some(title) = input.title {
        node.title = title;
    }
    if let Some(content) = input.content {
        node.content = content;
    }
    if let Some(x) = input.x {
        node.x = x;
    }
    if let Some(y) = input.y {
        node.y = y;
    }
    if let Some(width) = input.width {
        node.width = width;
    }
    if let Some(height) = input.height {
        node.height = height;
    }
    if let Some(status) = input.status {
        node.status = status;
    }
}

fn write_node_update(connection: &Connection, node: &NodeRecord) -> CanvasResult<()> {
    let content_json = serde_json::to_string(&node.content)?;
    let changed = connection.execute(
        "UPDATE nodes SET title = ?2, content_json = ?3, x = ?4, y = ?5,
                          width = ?6, height = ?7, status = ?8, updated_at = ?9
         WHERE id = ?1",
        params![
            node.id,
            node.title,
            content_json,
            node.x,
            node.y,
            node.width,
            node.height,
            node.status,
            node.updated_at,
        ],
    )?;
    if changed == 0 {
        return Err(CanvasError::Validation(format!(
            "node not found: {}",
            node.id
        )));
    }
    Ok(())
}

fn touch_canvas(connection: &Connection, canvas_id: &str) -> CanvasResult<()> {
    connection.execute(
        "UPDATE canvases SET updated_at = ?2 WHERE id = ?1",
        params![canvas_id, now()],
    )?;
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn validate_project_name(name: &str) -> CanvasResult<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CanvasError::Validation(
            "project name cannot be empty".to_owned(),
        ));
    }
    if name.chars().count() > 120 {
        return Err(CanvasError::Validation(
            "project name exceeds 120 characters".to_owned(),
        ));
    }
    Ok(name)
}

fn next_position(connection: &Connection, canvas_id: &str) -> CanvasResult<(f64, f64)> {
    let latest = connection
        .query_row(
            "SELECT x, y, height FROM nodes
             WHERE canvas_id = ?1
             ORDER BY rowid DESC LIMIT 1",
            [canvas_id],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .optional()?;

    match latest {
        Some((x, y, height)) => Ok((x, y + height + 60.0)),
        None => Ok((80.0, 80.0)),
    }
}

fn validate_node_input(input: &CreateNodeInput) -> CanvasResult<()> {
    validate_kind(input.kind.as_deref().unwrap_or("text"))?;
    if input.title.chars().count() > 500 {
        return Err(CanvasError::Validation(
            "node title exceeds 500 characters".to_owned(),
        ));
    }
    let content_size = serde_json::to_vec(&input.content)?.len();
    if content_size > 512 * 1024 {
        return Err(CanvasError::Validation(
            "node content exceeds 512 KiB".to_owned(),
        ));
    }
    for value in [input.x, input.y, input.width, input.height]
        .into_iter()
        .flatten()
    {
        if !value.is_finite() {
            return Err(CanvasError::Validation(
                "node geometry must be finite".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_node(node: &NodeRecord) -> CanvasResult<()> {
    validate_kind(&node.kind)?;
    if node.title.chars().count() > 500 {
        return Err(CanvasError::Validation(
            "node title exceeds 500 characters".to_owned(),
        ));
    }
    if serde_json::to_vec(&node.content)?.len() > 512 * 1024 {
        return Err(CanvasError::Validation(
            "node content exceeds 512 KiB".to_owned(),
        ));
    }
    if !node.x.is_finite()
        || !node.y.is_finite()
        || !node.width.is_finite()
        || !node.height.is_finite()
    {
        return Err(CanvasError::Validation(
            "node geometry must be finite".to_owned(),
        ));
    }
    if !(220.0..=2400.0).contains(&node.width) || !(120.0..=2400.0).contains(&node.height) {
        return Err(CanvasError::Validation(
            "node size is outside the supported range".to_owned(),
        ));
    }
    Ok(())
}

fn validate_kind(kind: &str) -> CanvasResult<()> {
    if kind.is_empty()
        || kind.len() > 48
        || !kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(CanvasError::Validation(
            "node or edge kind must use lowercase letters, digits, and hyphens".to_owned(),
        ));
    }
    Ok(())
}

fn get_node_by_id(connection: &Connection, id: &str) -> CanvasResult<Option<NodeRecord>> {
    Ok(connection
        .query_row(
            "SELECT id, canvas_id, kind, title, content_json, source, request_id,
                    x, y, width, height, status, created_at, updated_at
             FROM nodes WHERE id = ?1",
            [id],
            node_from_row,
        )
        .optional()?)
}

fn get_node_by_request_id(
    connection: &Connection,
    request_id: &str,
) -> CanvasResult<Option<NodeRecord>> {
    Ok(connection
        .query_row(
            "SELECT id, canvas_id, kind, title, content_json, source, request_id,
                    x, y, width, height, status, created_at, updated_at
             FROM nodes WHERE request_id = ?1",
            [request_id],
            node_from_row,
        )
        .optional()?)
}

fn node_from_row(row: &Row<'_>) -> rusqlite::Result<NodeRecord> {
    let content_json: String = row.get(4)?;
    let content = serde_json::from_str(&content_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            content_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(NodeRecord {
        id: row.get(0)?,
        canvas_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        content,
        source: row.get(5)?,
        request_id: row.get(6)?,
        x: row.get(7)?,
        y: row.get(8)?,
        width: row.get(9)?,
        height: row.get(10)?,
        status: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn edge_from_row(row: &Row<'_>) -> rusqlite::Result<EdgeRecord> {
    let metadata_json: String = row.get(5)?;
    let metadata = serde_json::from_str(&metadata_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            metadata_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(EdgeRecord {
        id: row.get(0)?,
        canvas_id: row.get(1)?,
        source_node_id: row.get(2)?,
        target_node_id: row.get(3)?,
        kind: row.get(4)?,
        metadata,
        created_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn text_node(title: &str, request_id: &str) -> CreateNodeInput {
        CreateNodeInput {
            canvas_id: None,
            kind: Some("text".to_owned()),
            title: title.to_owned(),
            content: json!({ "text": "A generation-ready prompt" }),
            source: Some("test".to_owned()),
            request_id: Some(request_id.to_owned()),
            x: None,
            y: None,
            width: None,
            height: None,
        }
    }

    fn prompt_scene(scene_key: &str) -> crate::models::CreatePromptSceneInput {
        crate::models::CreatePromptSceneInput {
            scene_key: scene_key.to_owned(),
            title: format!("场景 {scene_key}"),
            text: format!("English prompt for {scene_key}"),
            information: format!("{scene_key} 的中文解释"),
        }
    }

    fn prompt_scene_batch(request_id: &str, scene_keys: &[&str]) -> CreateMissingPromptScenesInput {
        CreateMissingPromptScenesInput {
            canvas_id: None,
            prompt_set_title: "测试分镜".to_owned(),
            scenes: scene_keys
                .iter()
                .map(|scene_key| prompt_scene(scene_key))
                .collect(),
            source: Some("test".to_owned()),
            request_id: Some(request_id.to_owned()),
        }
    }

    #[test]
    fn creates_and_deduplicates_nodes() {
        let database = Database::in_memory().unwrap();
        let first = database
            .create_node(text_node("First", "request-1"))
            .unwrap();
        let duplicate = database
            .create_node(text_node("Ignored", "request-1"))
            .unwrap();

        assert!(first.created);
        assert!(!duplicate.created);
        assert_eq!(first.node.id, duplicate.node.id);
        assert_eq!(duplicate.node.title, "First");
    }

    #[test]
    fn stacks_new_nodes_below_the_latest_node() {
        let database = Database::in_memory().unwrap();
        let first = database
            .create_node(text_node("First", "stack-request-1"))
            .unwrap();
        database
            .update_node(UpdateNodeInput {
                id: first.node.id,
                title: None,
                content: None,
                x: Some(240.0),
                y: Some(380.0),
                width: None,
                height: Some(310.0),
                status: None,
            })
            .unwrap();

        let second = database
            .create_node(text_node("Second", "stack-request-2"))
            .unwrap();
        let third = database
            .create_node(text_node("Third", "stack-request-3"))
            .unwrap();

        assert_eq!(second.node.x, 240.0);
        assert_eq!(second.node.y, 750.0);
        assert_eq!(third.node.x, 240.0);
        assert_eq!(third.node.y, 1050.0);
    }

    #[test]
    fn updates_geometry_and_content() {
        let database = Database::in_memory().unwrap();
        let created = database
            .create_node(text_node("First", "request-2"))
            .unwrap();
        let updated = database
            .update_node(UpdateNodeInput {
                id: created.node.id,
                title: Some("Updated".to_owned()),
                content: Some(json!({ "text": "Revised" })),
                x: Some(900.0),
                y: Some(420.0),
                width: Some(480.0),
                height: Some(320.0),
                status: None,
            })
            .unwrap();

        assert_eq!(updated.title, "Updated");
        assert_eq!(updated.content["text"], "Revised");
        assert_eq!(updated.x, 900.0);
        assert_eq!(updated.width, 480.0);
    }

    #[test]
    fn rewrites_legacy_asset_paths_without_touching_other_strings() {
        let database = Database::in_memory().unwrap();
        let legacy_assets = Path::new(r"C:\Users\Raydio\AppData\Local\InfiniteCanvas\assets");
        let new_assets =
            Path::new(r"C:\Users\Raydio\AppData\Local\SuCanvas\SuCanvasData\data\assets");
        let mut input = text_node("Imported image", "asset-path-migration");
        input.kind = Some("image".to_owned());
        input.content = json!({
            "assetPath": legacy_assets.join("asset-one.png").to_string_lossy(),
            "nested": {
                "sourcePath": legacy_assets.join("asset-two.mp3").to_string_lossy(),
                "label": "C:\\unrelated\\file.txt"
            }
        });
        let created = database.create_node(input).unwrap();

        assert_eq!(
            database
                .rewrite_asset_paths(legacy_assets, new_assets)
                .unwrap(),
            1
        );
        let migrated = database
            .load_project(DEFAULT_CANVAS_ID)
            .unwrap()
            .nodes
            .into_iter()
            .find(|node| node.id == created.node.id)
            .unwrap();

        assert_eq!(
            migrated.content["assetPath"],
            json!(new_assets.join("asset-one.png").to_string_lossy())
        );
        assert_eq!(
            migrated.content["nested"]["sourcePath"],
            json!(new_assets.join("asset-two.mp3").to_string_lossy())
        );
        assert_eq!(
            migrated.content["nested"]["label"],
            "C:\\unrelated\\file.txt"
        );
        assert_eq!(
            database
                .rewrite_asset_paths(legacy_assets, new_assets)
                .unwrap(),
            0
        );
    }

    #[test]
    fn creates_a_consistent_database_backup() {
        let database = Database::in_memory().unwrap();
        database
            .create_node(text_node("Backed up", "database-backup"))
            .unwrap();
        let path =
            std::env::temp_dir().join(format!("infinite-canvas-backup-{}.sqlite3", Uuid::new_v4()));

        database.backup_to(&path).unwrap();
        let restored = Database::open(&path).unwrap();
        restored.verify_integrity().unwrap();
        assert_eq!(
            restored.load_project(DEFAULT_CANVAS_ID).unwrap().nodes[0].title,
            "Backed up"
        );
        drop(restored);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn deletes_edges_when_a_node_is_deleted() {
        let database = Database::in_memory().unwrap();
        let source = database
            .create_node(text_node("Source", "request-3"))
            .unwrap();
        let target = database
            .create_node(text_node("Target", "request-4"))
            .unwrap();
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.node.id.clone(),
                target_node_id: target.node.id,
                kind: None,
                metadata: json!({}),
            })
            .unwrap();

        database.delete_node(&source.node.id).unwrap();
        let snapshot = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert!(snapshot.edges.is_empty());
    }

    #[test]
    fn keeps_project_nodes_isolated() {
        let database = Database::in_memory().unwrap();
        let project = database.create_project("Video campaign").unwrap();
        let mut input = text_node("Project prompt", "project-request-1");
        input.canvas_id = Some(project.canvas.id.clone());
        database.create_node(input).unwrap();

        let default_project = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        let created_project = database.load_project(&project.canvas.id).unwrap();
        let projects = database.list_projects().unwrap();

        assert!(default_project.nodes.is_empty());
        assert_eq!(created_project.nodes.len(), 1);
        assert_eq!(projects.len(), 2);
    }

    #[test]
    fn rejects_edges_between_projects() {
        let database = Database::in_memory().unwrap();
        let source = database
            .create_node(text_node("Default prompt", "cross-project-source"))
            .unwrap();
        let project = database.create_project("Second project").unwrap();
        let mut target_input = text_node("Video", "cross-project-target");
        target_input.canvas_id = Some(project.canvas.id.clone());
        let target = database.create_node(target_input).unwrap();

        let error = database
            .create_edge(CreateEdgeInput {
                canvas_id: Some(project.canvas.id),
                source_node_id: source.node.id,
                target_node_id: target.node.id,
                kind: Some("input".to_owned()),
                metadata: json!({}),
            })
            .unwrap_err();

        assert!(error.to_string().contains("across projects"));
    }

    #[test]
    fn renames_a_project_and_persists_the_name() {
        let database = Database::in_memory().unwrap();
        let project = database.create_project("First name").unwrap();

        let updated = database
            .rename_project(&project.canvas.id, "  Final name  ")
            .unwrap();
        let reloaded = database.load_project(&project.canvas.id).unwrap();

        assert_eq!(updated.name, "Final name");
        assert_eq!(reloaded.canvas.name, "Final name");
    }

    #[test]
    fn marks_a_project_private_and_persists_the_flag() {
        let database = Database::in_memory().unwrap();
        let project = database.create_project("Private project").unwrap();
        assert!(!project.canvas.is_private);

        let updated = database
            .set_project_private(&project.canvas.id, true)
            .unwrap();
        let reloaded = database.load_project(&project.canvas.id).unwrap();

        assert!(updated.is_private);
        assert!(reloaded.canvas.is_private);
    }

    #[test]
    fn migrates_existing_canvas_tables_with_private_flag_defaulting_to_false() {
        let path = std::env::temp_dir().join(format!(
            "infinite-canvas-private-migration-{}.sqlite3",
            Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE canvases (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO canvases (id, name, created_at, updated_at)
                VALUES ('canvas:legacy', 'Legacy', '2026-01-01', '2026-01-01');",
            )
            .unwrap();
        drop(connection);

        let database = Database::open(&path).unwrap();
        let project = database.load_project("canvas:legacy").unwrap();
        assert!(!project.canvas.is_private);
        drop(database);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn deletes_a_project_with_its_nodes_and_edges() {
        let database = Database::in_memory().unwrap();
        let project = database.create_project("Temporary project").unwrap();
        let mut source_input = text_node("Source", "delete-project-source");
        source_input.canvas_id = Some(project.canvas.id.clone());
        let source = database.create_node(source_input).unwrap();
        let mut target_input = text_node("Target", "delete-project-target");
        target_input.canvas_id = Some(project.canvas.id.clone());
        let target = database.create_node(target_input).unwrap();
        database
            .create_edge(CreateEdgeInput {
                canvas_id: Some(project.canvas.id.clone()),
                source_node_id: source.node.id,
                target_node_id: target.node.id,
                kind: Some("input".to_owned()),
                metadata: json!({}),
            })
            .unwrap();

        database.delete_project(&project.canvas.id).unwrap();

        assert!(database.load_project(&project.canvas.id).is_err());
        assert_eq!(database.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn restores_deleted_nodes_with_their_edges() {
        let database = Database::in_memory().unwrap();
        let source = database
            .create_node(text_node("Source", "undo-source"))
            .unwrap();
        let target = database
            .create_node(text_node("Target", "undo-target"))
            .unwrap();
        let edge = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.node.id.clone(),
                target_node_id: target.node.id.clone(),
                kind: Some("input".to_owned()),
                metadata: json!({ "sourceKind": "text" }),
            })
            .unwrap();

        let batch = database
            .delete_nodes_with_snapshot(std::slice::from_ref(&source.node.id))
            .unwrap();
        let after_delete = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(batch.nodes, vec![source.node.clone()]);
        assert_eq!(batch.edges, vec![edge.clone()]);
        assert_eq!(after_delete.nodes, vec![target.node]);
        assert!(after_delete.edges.is_empty());

        database.restore_deleted_batch(batch).unwrap();
        let restored = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(restored.nodes.len(), 2);
        assert_eq!(restored.edges, vec![edge]);
    }

    #[test]
    fn replaces_prompt_node_and_deletes_source_as_one_undoable_transaction() {
        let database = Database::in_memory().unwrap();
        let source = database
            .create_node(text_node("Imported prompt", "migration-source"))
            .unwrap()
            .node;
        let target = database
            .create_node(text_node("Prompt versions", "migration-target"))
            .unwrap()
            .node;
        let consumer = database
            .create_node(text_node("Consumer", "migration-consumer"))
            .unwrap()
            .node;
        let edge = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.id.clone(),
                target_node_id: consumer.id,
                kind: Some("input".to_owned()),
                metadata: json!({ "sourceKind": "text" }),
            })
            .unwrap();
        let migrated_content = json!({
            "text": "English prompt",
            "information": "中文解释",
            "promptVersionNode": true,
            "promptVersions": [{
                "id": "version-2",
                "label": "v2",
                "title": "Imported prompt",
                "text": "English prompt",
                "information": "中文解释"
            }],
            "activePromptVersionId": "version-2"
        });

        let result = database
            .replace_node_and_delete_with_snapshot(ReplaceNodeAndDeleteInput {
                update: UpdateNodeInput {
                    id: target.id.clone(),
                    title: None,
                    content: Some(migrated_content.clone()),
                    x: None,
                    y: None,
                    width: None,
                    height: None,
                    status: None,
                },
                delete_ids: vec![source.id.clone()],
            })
            .unwrap();
        let after_migration = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(result.previous_node, target);
        assert_eq!(result.node.content, migrated_content);
        assert_eq!(result.deleted.nodes, vec![source.clone()]);
        assert_eq!(result.deleted.edges, vec![edge.clone()]);
        assert!(!after_migration
            .nodes
            .iter()
            .any(|node| node.id == source.id));
        assert!(after_migration.edges.is_empty());

        let restored = database
            .restore_node_replacement(RestoreNodeReplacementInput {
                previous_node: result.previous_node.clone(),
                deleted: result.deleted,
            })
            .unwrap();
        let after_undo = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(restored.node, result.previous_node);
        assert!(after_undo.nodes.iter().any(|node| node.id == source.id));
        assert_eq!(after_undo.edges, vec![edge]);
        assert_eq!(
            after_undo
                .nodes
                .iter()
                .find(|node| node.id == target.id)
                .unwrap()
                .content,
            target.content
        );
    }

    #[test]
    fn creates_missing_prompt_scenes_and_recovers_bindings() {
        let database = Database::in_memory().unwrap();
        let first = database
            .create_missing_prompt_scenes(
                "prompt-set-001",
                DEFAULT_CANVAS_ID,
                prompt_scene_batch("create-scenes-1-5", &["S01", "S02", "S03", "S04", "S05"]),
            )
            .unwrap();
        assert_eq!(first.created_count, 5);
        assert_eq!(first.existing_count, 0);
        assert!(first.scenes.iter().all(|scene| scene.created));
        assert!(first
            .scenes
            .iter()
            .all(|scene| scene.binding.latest_version.as_deref() == Some("v1")));

        let retry = database
            .create_missing_prompt_scenes(
                "prompt-set-001",
                DEFAULT_CANVAS_ID,
                prompt_scene_batch(
                    "create-scenes-1-5-retry",
                    &["S01", "S02", "S03", "S04", "S05"],
                ),
            )
            .unwrap();
        assert_eq!(retry.created_count, 0);
        assert_eq!(retry.existing_count, 5);
        assert!(retry.scenes.iter().all(|scene| !scene.created));

        let second = database
            .create_missing_prompt_scenes(
                "prompt-set-001",
                DEFAULT_CANVAS_ID,
                prompt_scene_batch("create-scenes-6-10", &["S06", "S07", "S08", "S09", "S10"]),
            )
            .unwrap();
        assert_eq!(second.created_count, 5);
        let recovered = database.get_prompt_set_scenes("prompt-set-001").unwrap();
        assert_eq!(recovered.prompt_set.scene_count, 10);
        assert_eq!(recovered.scenes.len(), 10);
        assert_eq!(database.list_prompt_sets().unwrap().len(), 1);
    }

    #[test]
    fn appends_versions_to_target_scenes_with_conflict_and_retry_protection() {
        let database = Database::in_memory().unwrap();
        database
            .create_missing_prompt_scenes(
                "prompt-set-002",
                DEFAULT_CANVAS_ID,
                prompt_scene_batch("create-target-scenes", &["S02", "S05"]),
            )
            .unwrap();

        let append = |scene_key: &str, request_id: &str| AppendPromptVersionInput {
            text: format!("Improved English prompt for {scene_key}"),
            information: format!("{scene_key} 改进后的中文解释"),
            title: None,
            source: Some("test".to_owned()),
            request_id: request_id.to_owned(),
            expected_version_count: Some(1),
        };
        let scene_two = database
            .append_prompt_version("prompt-set-002", "S02", append("S02", "append-scene-2-v2"))
            .unwrap();
        let scene_five = database
            .append_prompt_version("prompt-set-002", "S05", append("S05", "append-scene-5-v2"))
            .unwrap();
        assert_eq!(scene_two.version.label, "v2");
        assert_eq!(scene_five.version.label, "v2");
        assert_eq!(scene_two.binding.version_count, 2);

        let retry = database
            .append_prompt_version("prompt-set-002", "S02", append("S02", "append-scene-2-v2"))
            .unwrap();
        assert!(!retry.created);
        assert_eq!(retry.version.id, scene_two.version.id);

        let conflict = database
            .append_prompt_version(
                "prompt-set-002",
                "S02",
                AppendPromptVersionInput {
                    request_id: "append-scene-2-stale".to_owned(),
                    ..append("S02", "unused")
                },
            )
            .unwrap_err();
        assert!(matches!(conflict, CanvasError::Conflict(_)));
    }

    #[test]
    fn restoring_a_deleted_prompt_node_restores_its_binding_and_request_history() {
        let database = Database::in_memory().unwrap();
        let created = database
            .create_missing_prompt_scenes(
                "prompt-set-undo",
                DEFAULT_CANVAS_ID,
                prompt_scene_batch("create-undo-scene", &["S01"]),
            )
            .unwrap();
        let node_id = created.scenes[0].node.id.clone();
        let appended = database
            .append_prompt_version(
                "prompt-set-undo",
                "S01",
                AppendPromptVersionInput {
                    text: "Second English prompt".to_owned(),
                    information: "第二版中文解释".to_owned(),
                    title: None,
                    source: Some("test".to_owned()),
                    request_id: "append-before-delete".to_owned(),
                    expected_version_count: Some(1),
                },
            )
            .unwrap();
        let deleted = database
            .delete_nodes_with_snapshot(std::slice::from_ref(&node_id))
            .unwrap();
        assert_eq!(deleted.prompt_scene_bindings.len(), 1);
        assert!(matches!(
            database.get_prompt_set_scenes("prompt-set-undo"),
            Err(CanvasError::NotFound(_))
        ));

        database.restore_deleted_batch(deleted).unwrap();
        let recovered = database.get_prompt_set_scenes("prompt-set-undo").unwrap();
        assert_eq!(recovered.scenes[0].version_count, 2);
        let retry = database
            .append_prompt_version(
                "prompt-set-undo",
                "S01",
                AppendPromptVersionInput {
                    text: "Second English prompt".to_owned(),
                    information: "第二版中文解释".to_owned(),
                    title: None,
                    source: Some("test".to_owned()),
                    request_id: "append-before-delete".to_owned(),
                    expected_version_count: Some(2),
                },
            )
            .unwrap();
        assert!(!retry.created);
        assert_eq!(retry.version.id, appended.version.id);
    }
}
