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
    AppendContentVersionResult, AppendPromptVersionInput, AppendPromptVersionResult,
    CancelFolderResult, CancelFolderUndoRecord, CanvasFolderLinkRecord, CanvasRecord,
    ContentVersionSource, CreateEdgeInput, CreateEmptyFolderInput, CreateEmptyFolderResult,
    CreateMissingPromptScenesInput, CreateMissingPromptScenesResult, CreateNodeInput,
    CreateNodeResult, DeleteFolderResult, DeletedBatch, EdgeRecord, FolderActionInput,
    FolderGroupingUndoRecord, FolderInputDuplicateRecord, FolderMergeDeduplicatedInputRecord,
    FolderMergeSourceSnapshot, FolderMergeUndoRecord, FolderTreeUndoRecord,
    GroupNodesIntoFolderInput, GroupNodesIntoFolderResult, GroupRelatedNodesIntoFolderInput,
    MergeFoldersInput, MergeFoldersResult, NodeRecord, PromptGenerationOptions, PromptSceneBinding,
    PromptSceneBindingRecord, PromptSceneMutation, PromptSetScenesResult, PromptSetSummary,
    PromptVersionRecord, ReplaceNodeAndDeleteInput, ReplaceNodeAndDeleteResult,
    RestoreNodeReplacementInput, RestoreNodeReplacementResult, UndoCancelFolderInput,
    UndoDeleteFolderInput, UndoFolderGroupingInput, UndoFolderMergeInput, UpdateNodeInput,
    WorkspaceSnapshot, DEFAULT_CANVAS_ID,
};

const FOLDER_NODE_WIDTH: f64 = 420.0;
const FOLDER_NODE_HEIGHT: f64 = 274.25;

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
                preview_image_path TEXT,
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

            CREATE TABLE IF NOT EXISTS canvas_folders (
                folder_node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
                child_canvas_id TEXT NOT NULL UNIQUE REFERENCES canvases(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_canvas_folders_child
                ON canvas_folders(child_canvas_id);

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

        if !table_has_column(&connection, "canvases", "preview_image_path")? {
            connection.execute(
                "ALTER TABLE canvases ADD COLUMN preview_image_path TEXT",
                [],
            )?;
        }

        migrate_legacy_storyboard_reference_data(&connection)?;
        migrate_content_iteration_nodes(&connection)?;
        migrate_legacy_content_version_provenance(&connection)?;

        connection.execute(
            "UPDATE nodes SET width = ?1, height = ?2 WHERE kind = 'folder'",
            params![FOLDER_NODE_WIDTH, FOLDER_NODE_HEIGHT],
        )?;

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

        let preview_rows = {
            let mut statement = transaction.prepare(
                "SELECT id, preview_image_path FROM canvases WHERE preview_image_path IS NOT NULL",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (id, preview_image_path) in preview_rows {
            let mut value = Value::String(preview_image_path);
            if rewrite_asset_paths_in_value(&mut value, legacy_assets_dir, assets_dir) {
                let Value::String(rewritten_path) = value else {
                    unreachable!("rewriting a string path must preserve its JSON type");
                };
                transaction.execute(
                    "UPDATE canvases SET preview_image_path = ?2 WHERE id = ?1",
                    params![id, rewritten_path],
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
        let mut statement = connection.prepare(
            "SELECT canvases.id
                 FROM canvases
                 LEFT JOIN canvas_folders ON canvas_folders.child_canvas_id = canvases.id
                 WHERE canvas_folders.child_canvas_id IS NULL
                 ORDER BY canvases.updated_at DESC, canvases.created_at DESC",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| load_workspace_from_connection(&connection, &id))
            .collect()
    }

    pub fn list_all_projects(&self) -> CanvasResult<Vec<WorkspaceSnapshot>> {
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
        let mut name = validate_project_name(name)?.to_owned();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let folder_parent = transaction
            .query_row(
                "SELECT nodes.id, nodes.canvas_id
                 FROM canvas_folders
                 JOIN nodes ON nodes.id = canvas_folders.folder_node_id
                 WHERE canvas_folders.child_canvas_id = ?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((folder_node_id, parent_canvas_id)) = folder_parent.as_ref() {
            name =
                unique_folder_title(&transaction, parent_canvas_id, &name, Some(folder_node_id))?;
        }
        let timestamp = now();
        let changed = transaction.execute(
            "UPDATE canvases SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, timestamp],
        )?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!("project not found: {id}")));
        }
        transaction.execute(
            "UPDATE nodes
             SET title = ?2, updated_at = ?3
             WHERE id = (SELECT folder_node_id FROM canvas_folders WHERE child_canvas_id = ?1)",
            params![id, name, timestamp],
        )?;
        let record = transaction.query_row(
            "SELECT id, name, is_private, preview_image_path, created_at, updated_at FROM canvases WHERE id = ?1",
            [id],
            |row| {
                Ok(CanvasRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    is_private: row.get::<_, i64>(2)? != 0,
                    preview_image_path: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )?;
        transaction.commit()?;
        Ok(record)
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
                "SELECT id, name, is_private, preview_image_path, created_at, updated_at FROM canvases WHERE id = ?1",
                [id],
                |row| {
                    Ok(CanvasRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        is_private: row.get::<_, i64>(2)? != 0,
                        preview_image_path: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .map_err(CanvasError::Database)
    }

    pub fn set_project_preview_image(
        &self,
        project_id: &str,
        image_node_id: &str,
    ) -> CanvasResult<CanvasRecord> {
        if project_id.trim().is_empty() || image_node_id.trim().is_empty() {
            return Err(CanvasError::Validation(
                "project id and image node id cannot be empty".to_owned(),
            ));
        }

        let connection = self.lock()?;
        let (node_canvas_id, kind, content_json) = connection
            .query_row(
                "SELECT canvas_id, kind, content_json FROM nodes WHERE id = ?1",
                [image_node_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                CanvasError::Validation(format!("image node not found: {image_node_id}"))
            })?;
        if kind != "image" {
            return Err(CanvasError::Validation(
                "only image assets can be used as a project preview".to_owned(),
            ));
        }

        let belongs_to_project = connection.query_row(
            "WITH RECURSIVE project_canvases(id) AS (
                 SELECT ?1
                 UNION ALL
                 SELECT canvas_folders.child_canvas_id
                 FROM canvas_folders
                 JOIN nodes AS folder_nodes ON folder_nodes.id = canvas_folders.folder_node_id
                 JOIN project_canvases ON project_canvases.id = folder_nodes.canvas_id
             )
             SELECT EXISTS(SELECT 1 FROM project_canvases WHERE id = ?2)",
            params![project_id, node_canvas_id],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if !belongs_to_project {
            return Err(CanvasError::Validation(
                "the selected image does not belong to this project".to_owned(),
            ));
        }

        let content: Value = serde_json::from_str(&content_json)?;
        let asset_path = content
            .get("assetPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                CanvasError::Validation("the selected image has no asset path".to_owned())
            })?;
        let timestamp = now();
        let changed = connection.execute(
            "UPDATE canvases
             SET preview_image_path = ?2, updated_at = ?3
             WHERE id = ?1",
            params![project_id, asset_path, timestamp],
        )?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!(
                "project not found: {project_id}"
            )));
        }
        load_workspace_from_connection(&connection, project_id).map(|snapshot| snapshot.canvas)
    }

    pub fn delete_project(&self, id: &str) -> CanvasResult<()> {
        if id.trim().is_empty() {
            return Err(CanvasError::Validation(
                "project id cannot be empty".to_owned(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists = transaction
            .query_row("SELECT 1 FROM canvases WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(CanvasError::Validation(format!("project not found: {id}")));
        }
        delete_canvas_tree(&transaction, id)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn group_nodes_into_folder(
        &self,
        input: GroupNodesIntoFolderInput,
    ) -> CanvasResult<GroupNodesIntoFolderResult> {
        self.group_nodes_into_folder_with_plan(&input.canvas_id, input.node_ids, None)
    }

    pub fn create_empty_folder(
        &self,
        input: CreateEmptyFolderInput,
    ) -> CanvasResult<CreateEmptyFolderResult> {
        let canvas_id = input.canvas_id.trim();
        if canvas_id.is_empty() {
            return Err(CanvasError::Validation(
                "canvas id cannot be empty".to_owned(),
            ));
        }
        if !input.x.is_finite() || !input.y.is_finite() {
            return Err(CanvasError::Validation(
                "folder position must be finite".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        load_workspace_from_connection(&transaction, canvas_id)?;

        let folder_title = next_folder_title(&transaction, canvas_id)?;
        let timestamp = now();
        let child_canvas_id = format!("canvas:{}", Uuid::new_v4());
        let folder_node_id = format!("node:{}", Uuid::new_v4());
        let folder_content = json!({
            "childCanvasId": child_canvas_id,
            "nodeCount": 0,
        });

        transaction.execute(
            "INSERT INTO canvases (id, name, is_private, created_at, updated_at)
             SELECT ?1, ?2, is_private, ?3, ?3 FROM canvases WHERE id = ?4",
            params![child_canvas_id, folder_title, timestamp, canvas_id],
        )?;
        transaction.execute(
            "INSERT INTO nodes (
                id, canvas_id, kind, title, content_json, source, request_id,
                x, y, width, height, status, created_at, updated_at
             ) VALUES (?1, ?2, 'folder', ?3, ?4, 'manual', NULL,
                       ?5, ?6, ?7, ?8, 'ready', ?9, ?9)",
            params![
                folder_node_id,
                canvas_id,
                folder_title,
                serde_json::to_string(&folder_content)?,
                input.x,
                input.y,
                FOLDER_NODE_WIDTH,
                FOLDER_NODE_HEIGHT,
                timestamp,
            ],
        )?;
        transaction.execute(
            "INSERT INTO canvas_folders (folder_node_id, child_canvas_id, created_at)
             VALUES (?1, ?2, ?3)",
            params![folder_node_id, child_canvas_id, timestamp],
        )?;

        touch_canvas(&transaction, canvas_id)?;
        touch_canvas(&transaction, &child_canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, canvas_id)?;
        let child = load_workspace_from_connection(&transaction, &child_canvas_id)?;
        transaction.commit()?;

        Ok(CreateEmptyFolderResult {
            parent,
            child,
            folder_node_id,
        })
    }

    pub fn group_related_nodes_into_folder(
        &self,
        input: GroupRelatedNodesIntoFolderInput,
    ) -> CanvasResult<GroupNodesIntoFolderResult> {
        let root_node_id = input.root_node_id.trim().to_owned();
        self.group_nodes_into_folder_with_plan(
            &input.canvas_id,
            vec![root_node_id.clone()],
            Some(root_node_id),
        )
    }

    fn group_nodes_into_folder_with_plan(
        &self,
        requested_canvas_id: &str,
        requested_node_ids: Vec<String>,
        related_root_node_id: Option<String>,
    ) -> CanvasResult<GroupNodesIntoFolderResult> {
        let canvas_id = requested_canvas_id.trim();
        if canvas_id.is_empty() {
            return Err(CanvasError::Validation(
                "canvas id cannot be empty".to_owned(),
            ));
        }
        let mut node_ids = requested_node_ids
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .collect::<BTreeSet<_>>();
        if node_ids.is_empty() {
            return Err(CanvasError::Validation(
                "at least one node is required".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let workspace = load_workspace_from_connection(&transaction, canvas_id)?;
        let node_kinds = workspace
            .nodes
            .iter()
            .map(|node| (node.id.clone(), node.kind.clone()))
            .collect::<BTreeMap<_, _>>();
        let canvas_edges = workspace.edges;
        let mut duplicated_source_ids = BTreeSet::new();

        if let Some(root_node_id) = related_root_node_id.as_deref() {
            if node_kinds.get(root_node_id).map(String::as_str) != Some("video-generation") {
                return Err(CanvasError::Validation(
                    "the related-node root must be a video-generation node on the active canvas"
                        .to_owned(),
                ));
            }

            let mut adjacency = BTreeMap::<String, Vec<String>>::new();
            for edge in &canvas_edges {
                adjacency
                    .entry(edge.source_node_id.clone())
                    .or_default()
                    .push(edge.target_node_id.clone());
            }
            node_ids.clear();
            let mut pending = vec![root_node_id.to_owned()];
            while let Some(node_id) = pending.pop() {
                if !node_ids.insert(node_id.clone()) {
                    continue;
                }
                if let Some(targets) = adjacency.get(&node_id) {
                    pending.extend(targets.iter().cloned());
                }
            }

            let generation_chain_node_ids = node_ids.clone();
            let input_source_ids = canvas_edges
                .iter()
                .filter(|edge| {
                    edge.kind == "input"
                        && generation_chain_node_ids.contains(&edge.target_node_id)
                        && node_kinds.get(&edge.target_node_id).map(String::as_str)
                            == Some("video-generation")
                        && matches!(
                            node_kinds.get(&edge.source_node_id).map(String::as_str),
                            Some("text" | "image" | "audio" | "video")
                        )
                        && !generation_chain_node_ids.contains(&edge.source_node_id)
                })
                .map(|edge| edge.source_node_id.clone())
                .collect::<BTreeSet<_>>();

            for source_node_id in input_source_ids {
                let shared_with_outside_generator = canvas_edges.iter().any(|edge| {
                    edge.kind == "input"
                        && edge.source_node_id == source_node_id
                        && !generation_chain_node_ids.contains(&edge.target_node_id)
                        && node_kinds.get(&edge.target_node_id).map(String::as_str)
                            == Some("video-generation")
                });
                if shared_with_outside_generator {
                    duplicated_source_ids.insert(source_node_id);
                } else {
                    node_ids.insert(source_node_id);
                }
            }
        }

        let mut moved_nodes = Vec::with_capacity(node_ids.len());
        for node_id in &node_ids {
            let node = get_node_by_id(&transaction, node_id)?
                .ok_or_else(|| CanvasError::Validation(format!("node not found: {node_id}")))?;
            if node.canvas_id != canvas_id {
                return Err(CanvasError::Validation(
                    "all grouped nodes must belong to the active canvas".to_owned(),
                ));
            }
            moved_nodes.push(node);
        }
        let mut duplicated_source_nodes = Vec::with_capacity(duplicated_source_ids.len());
        for source_node_id in &duplicated_source_ids {
            let source = get_node_by_id(&transaction, source_node_id)?.ok_or_else(|| {
                CanvasError::Validation(format!("input node not found: {source_node_id}"))
            })?;
            if source.canvas_id != canvas_id
                || !matches!(source.kind.as_str(), "text" | "image" | "audio" | "video")
            {
                return Err(CanvasError::Validation(
                    "all copied inputs must be supported nodes on the active canvas".to_owned(),
                ));
            }
            duplicated_source_nodes.push(source);
        }
        let original_nodes = moved_nodes.clone();
        let mut original_prompt_scene_bindings = Vec::new();
        for node in &original_nodes {
            if let Some(binding) = get_prompt_scene_binding_by_node_id(&transaction, &node.id)? {
                original_prompt_scene_bindings.push(binding);
            }
        }

        let folder_title = next_folder_title(&transaction, canvas_id)?;
        let timestamp = now();
        let child_canvas_id = format!("canvas:{}", Uuid::new_v4());
        let folder_node_id = format!("node:{}", Uuid::new_v4());
        let min_x = moved_nodes
            .iter()
            .chain(duplicated_source_nodes.iter())
            .map(|node| node.x)
            .fold(f64::INFINITY, f64::min);
        let min_y = moved_nodes
            .iter()
            .chain(duplicated_source_nodes.iter())
            .map(|node| node.y)
            .fold(f64::INFINITY, f64::min);
        let (folder_x, folder_y) = related_root_node_id
            .as_deref()
            .and_then(|root_node_id| {
                original_nodes
                    .iter()
                    .find(|node| node.id == root_node_id)
                    .map(|node| (node.x, node.y))
            })
            .unwrap_or((min_x, min_y));
        let folder_content = json!({
            "childCanvasId": child_canvas_id,
            "nodeCount": moved_nodes.len() + duplicated_source_nodes.len(),
        });

        transaction.execute(
            "INSERT INTO canvases (id, name, is_private, created_at, updated_at)
             SELECT ?1, ?2, is_private, ?3, ?3 FROM canvases WHERE id = ?4",
            params![child_canvas_id, folder_title, timestamp, canvas_id],
        )?;
        transaction.execute(
            "INSERT INTO nodes (
                id, canvas_id, kind, title, content_json, source, request_id,
                x, y, width, height, status, created_at, updated_at
             ) VALUES (?1, ?2, 'folder', ?3, ?4, 'manual', NULL,
                       ?5, ?6, ?7, ?8, 'ready', ?9, ?9)",
            params![
                folder_node_id,
                canvas_id,
                folder_title,
                serde_json::to_string(&folder_content)?,
                folder_x,
                folder_y,
                FOLDER_NODE_WIDTH,
                FOLDER_NODE_HEIGHT,
                timestamp,
            ],
        )?;
        transaction.execute(
            "INSERT INTO canvas_folders (folder_node_id, child_canvas_id, created_at)
             VALUES (?1, ?2, ?3)",
            params![folder_node_id, child_canvas_id, timestamp],
        )?;

        let mut duplicate_node_id_map = BTreeMap::new();
        let mut duplicated_input_nodes = Vec::with_capacity(duplicated_source_nodes.len());
        let mut duplicated_nodes = Vec::with_capacity(duplicated_source_nodes.len());
        for source in &duplicated_source_nodes {
            let duplicate_node_id = format!("node:{}", Uuid::new_v4());
            duplicate_node_id_map.insert(source.id.clone(), duplicate_node_id.clone());
            duplicated_input_nodes.push(FolderInputDuplicateRecord {
                source_node_id: source.id.clone(),
                duplicate_node_id: duplicate_node_id.clone(),
            });
            let mut content = source.content.clone();
            if let Some(object) = content.as_object_mut() {
                object.insert(
                    "folderInputCopySourceId".to_owned(),
                    Value::String(source.id.clone()),
                );
            }
            duplicated_nodes.push(NodeRecord {
                id: duplicate_node_id,
                canvas_id: child_canvas_id.clone(),
                kind: source.kind.clone(),
                title: source.title.clone(),
                content,
                source: "folder-copy".to_owned(),
                request_id: None,
                x: source.x - min_x + 80.0,
                y: source.y - min_y + 80.0,
                width: source.width,
                height: source.height,
                status: source.status.clone(),
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            });
        }

        for node in &moved_nodes {
            let remapped_content =
                remap_folder_input_references(&node.content, &duplicate_node_id_map);
            transaction.execute(
                "UPDATE nodes
                 SET canvas_id = ?2, content_json = ?3, x = ?4, y = ?5, updated_at = ?6
                 WHERE id = ?1",
                params![
                    node.id,
                    child_canvas_id,
                    serde_json::to_string(&remapped_content)?,
                    node.x - min_x + 80.0,
                    node.y - min_y + 80.0,
                    timestamp,
                ],
            )?;
            transaction.execute(
                "UPDATE prompt_scene_bindings SET canvas_id = ?2, updated_at = ?3 WHERE node_id = ?1",
                params![node.id, child_canvas_id, timestamp],
            )?;
        }
        for duplicate in &duplicated_nodes {
            insert_node(&transaction, duplicate)?;
        }

        let original_edges = canvas_edges
            .iter()
            .filter(|edge| {
                node_ids.contains(&edge.source_node_id) || node_ids.contains(&edge.target_node_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut removed_crossing_edge_count = 0usize;
        for edge in canvas_edges {
            let source_moved = node_ids.contains(&edge.source_node_id);
            let target_moved = node_ids.contains(&edge.target_node_id);
            if source_moved && target_moved {
                transaction.execute(
                    "UPDATE edges SET canvas_id = ?2 WHERE id = ?1",
                    params![edge.id, child_canvas_id],
                )?;
            } else if target_moved {
                if let Some(duplicate_node_id) = duplicate_node_id_map.get(&edge.source_node_id) {
                    insert_edge(
                        &transaction,
                        &EdgeRecord {
                            id: format!("edge:{}", Uuid::new_v4()),
                            canvas_id: child_canvas_id.clone(),
                            source_node_id: duplicate_node_id.clone(),
                            target_node_id: edge.target_node_id.clone(),
                            kind: edge.kind.clone(),
                            metadata: edge.metadata.clone(),
                            created_at: timestamp.clone(),
                        },
                    )?;
                    transaction.execute("DELETE FROM edges WHERE id = ?1", [edge.id])?;
                    continue;
                }
                if is_protected_generation_edge(&transaction, &edge)? {
                    return Err(CanvasError::Conflict(
                        "generated video ownership links cannot cross folder boundaries".to_owned(),
                    ));
                }
                transaction.execute("DELETE FROM edges WHERE id = ?1", [edge.id])?;
                removed_crossing_edge_count += 1;
            } else if source_moved || target_moved {
                if is_protected_generation_edge(&transaction, &edge)? {
                    return Err(CanvasError::Conflict(
                        "generated video ownership links cannot cross folder boundaries".to_owned(),
                    ));
                }
                transaction.execute("DELETE FROM edges WHERE id = ?1", [edge.id])?;
                removed_crossing_edge_count += 1;
            }
        }

        touch_canvas(&transaction, canvas_id)?;
        touch_canvas(&transaction, &child_canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, canvas_id)?;
        let child = load_workspace_from_connection(&transaction, &child_canvas_id)?;
        transaction.commit()?;

        Ok(GroupNodesIntoFolderResult {
            parent,
            child,
            folder_node_id: folder_node_id.clone(),
            removed_crossing_edge_count,
            moved_node_count: original_nodes.len(),
            copied_input_node_count: duplicated_input_nodes.len(),
            undo: FolderGroupingUndoRecord {
                parent_canvas_id: canvas_id.to_owned(),
                child_canvas_id,
                folder_node_id,
                nodes: original_nodes,
                edges: original_edges,
                prompt_scene_bindings: original_prompt_scene_bindings,
                duplicated_input_nodes,
            },
        })
    }

    pub fn undo_folder_grouping(
        &self,
        input: UndoFolderGroupingInput,
    ) -> CanvasResult<WorkspaceSnapshot> {
        let grouping = input.grouping;
        if grouping.nodes.is_empty() {
            return Err(CanvasError::Validation(
                "folder grouping contains no nodes".to_owned(),
            ));
        }
        let mut expected_node_ids = grouping
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<BTreeSet<_>>();
        for duplicate in &grouping.duplicated_input_nodes {
            if !expected_node_ids.insert(duplicate.duplicate_node_id.clone()) {
                return Err(CanvasError::Validation(
                    "folder grouping snapshot contains duplicate node ids".to_owned(),
                ));
            }
        }
        if grouping
            .nodes
            .iter()
            .any(|node| node.canvas_id != grouping.parent_canvas_id)
        {
            return Err(CanvasError::Validation(
                "folder grouping snapshot has inconsistent parent canvas ids".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let linked_child_canvas_id = transaction
            .query_row(
                "SELECT child_canvas_id FROM canvas_folders WHERE folder_node_id = ?1",
                [&grouping.folder_node_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| CanvasError::Conflict("folder grouping no longer exists".to_owned()))?;
        if linked_child_canvas_id != grouping.child_canvas_id {
            return Err(CanvasError::Conflict(
                "folder now points to a different child canvas".to_owned(),
            ));
        }

        let mut child_node_statement =
            transaction.prepare("SELECT id FROM nodes WHERE canvas_id = ?1")?;
        let current_child_node_ids = child_node_statement
            .query_map([&grouping.child_canvas_id], |row| row.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?;
        drop(child_node_statement);
        if current_child_node_ids != expected_node_ids {
            return Err(CanvasError::Conflict(
                "child canvas changed after grouping; undo would discard newer nodes".to_owned(),
            ));
        }

        for duplicate in &grouping.duplicated_input_nodes {
            let source =
                get_node_by_id(&transaction, &duplicate.source_node_id)?.ok_or_else(|| {
                    CanvasError::Conflict(
                        "the original shared input was deleted after grouping".to_owned(),
                    )
                })?;
            let copied =
                get_node_by_id(&transaction, &duplicate.duplicate_node_id)?.ok_or_else(|| {
                    CanvasError::Conflict(
                        "the shared input copy was deleted after grouping".to_owned(),
                    )
                })?;
            let copied_source_id = copied
                .content
                .get("folderInputCopySourceId")
                .and_then(Value::as_str);
            if source.canvas_id != grouping.parent_canvas_id
                || copied.canvas_id != grouping.child_canvas_id
                || copied_source_id != Some(duplicate.source_node_id.as_str())
            {
                return Err(CanvasError::Conflict(
                    "a shared input copy no longer matches its original node".to_owned(),
                ));
            }
        }

        for duplicate in &grouping.duplicated_input_nodes {
            transaction.execute(
                "DELETE FROM nodes WHERE id = ?1 AND canvas_id = ?2",
                params![duplicate.duplicate_node_id, grouping.child_canvas_id],
            )?;
        }

        for node in &grouping.nodes {
            transaction.execute(
                "DELETE FROM edges WHERE source_node_id = ?1 OR target_node_id = ?1",
                [&node.id],
            )?;
        }
        for node in &grouping.nodes {
            transaction.execute(
                "UPDATE nodes SET canvas_id = ?2 WHERE id = ?1",
                params![node.id, grouping.parent_canvas_id],
            )?;
            write_node_update(&transaction, node)?;
        }
        for binding in &grouping.prompt_scene_bindings {
            update_prompt_scene_binding(&transaction, binding)?;
        }
        for edge in &grouping.edges {
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

        transaction.execute(
            "DELETE FROM canvases WHERE id = ?1",
            [&grouping.child_canvas_id],
        )?;
        transaction.execute(
            "DELETE FROM nodes WHERE id = ?1 AND kind = 'folder'",
            [&grouping.folder_node_id],
        )?;
        touch_canvas(&transaction, &grouping.parent_canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, &grouping.parent_canvas_id)?;
        transaction.commit()?;
        Ok(parent)
    }

    pub fn merge_folders(&self, input: MergeFoldersInput) -> CanvasResult<MergeFoldersResult> {
        let canvas_id = input.canvas_id.trim();
        if canvas_id.is_empty() {
            return Err(CanvasError::Validation(
                "canvas id cannot be empty".to_owned(),
            ));
        }
        let folder_node_ids = input
            .folder_node_ids
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .collect::<BTreeSet<_>>();
        if folder_node_ids.len() < 2 {
            return Err(CanvasError::Validation(
                "at least two folders are required".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut sources = Vec::with_capacity(folder_node_ids.len());
        for folder_node_id in &folder_node_ids {
            let folder_node = get_node_by_id(&transaction, folder_node_id)?.ok_or_else(|| {
                CanvasError::Validation(format!("node not found: {folder_node_id}"))
            })?;
            if folder_node.canvas_id != canvas_id || folder_node.kind != "folder" {
                return Err(CanvasError::Validation(
                    "all merged nodes must be folders on the active canvas".to_owned(),
                ));
            }
            let (child_canvas_id, folder_link_created_at) = transaction
                .query_row(
                    "SELECT child_canvas_id, created_at FROM canvas_folders WHERE folder_node_id = ?1",
                    [folder_node_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| CanvasError::Validation(format!(
                    "folder has no child canvas: {folder_node_id}"
                )))?;
            let child = load_workspace_from_connection(&transaction, &child_canvas_id)?;
            let mut prompt_scene_bindings = Vec::new();
            for node in &child.nodes {
                if let Some(binding) = get_prompt_scene_binding_by_node_id(&transaction, &node.id)?
                {
                    prompt_scene_bindings.push(binding);
                }
            }
            sources.push(FolderMergeSourceSnapshot {
                folder_node,
                child_canvas: child.canvas,
                folder_link_created_at,
                nodes: child.nodes,
                edges: child.edges,
                prompt_scene_bindings,
            });
        }

        sources.sort_by(|left, right| {
            left.folder_node
                .x
                .total_cmp(&right.folder_node.x)
                .then_with(|| left.folder_node.y.total_cmp(&right.folder_node.y))
                .then_with(|| left.folder_node.id.cmp(&right.folder_node.id))
        });
        let mut input_candidates = BTreeMap::<(String, String), BTreeMap<String, usize>>::new();
        for (source_index, source) in sources.iter().enumerate() {
            let nodes_by_id = source
                .nodes
                .iter()
                .map(|node| (node.id.as_str(), node))
                .collect::<BTreeMap<_, _>>();
            for edge in &source.edges {
                if edge.kind != "input" {
                    continue;
                }
                let Some(input_node) = nodes_by_id.get(edge.source_node_id.as_str()) else {
                    continue;
                };
                let Some(target_node) = nodes_by_id.get(edge.target_node_id.as_str()) else {
                    continue;
                };
                if target_node.kind != "video-generation"
                    || !matches!(
                        input_node.kind.as_str(),
                        "text" | "image" | "audio" | "video"
                    )
                {
                    continue;
                }
                let original_source_node_id =
                    folder_input_original_source_id(&transaction, input_node)?;
                input_candidates
                    .entry((input_node.kind.clone(), original_source_node_id))
                    .or_default()
                    .insert(input_node.id.clone(), source_index);
            }
        }

        let mut input_node_replacements = BTreeMap::<String, String>::new();
        let mut deduplicated_input_nodes = Vec::new();
        for ((_, original_source_node_id), candidates) in input_candidates {
            let source_indexes = candidates.values().copied().collect::<BTreeSet<_>>();
            if source_indexes.len() < 2 || candidates.len() < 2 {
                continue;
            }
            let mut candidates = candidates.into_iter().collect::<Vec<_>>();
            candidates.sort_by(|(left_id, left_source), (right_id, right_source)| {
                left_source
                    .cmp(right_source)
                    .then_with(|| left_id.cmp(right_id))
            });
            let kept_node_id = candidates
                .iter()
                .find(|(node_id, _)| node_id == &original_source_node_id)
                .or_else(|| candidates.first())
                .map(|(node_id, _)| node_id.clone())
                .expect("duplicate input candidates are non-empty");
            let removed_node_ids = candidates
                .into_iter()
                .map(|(node_id, _)| node_id)
                .filter(|node_id| node_id != &kept_node_id)
                .collect::<Vec<_>>();
            for removed_node_id in &removed_node_ids {
                input_node_replacements.insert(removed_node_id.clone(), kept_node_id.clone());
            }
            deduplicated_input_nodes.push(FolderMergeDeduplicatedInputRecord {
                original_source_node_id,
                kept_node_id,
                removed_node_ids,
            });
        }
        let removed_input_node_ids = input_node_replacements
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut parent_edge_statement = transaction.prepare(
            "SELECT id, canvas_id, source_node_id, target_node_id, kind,
                    metadata_json, created_at
             FROM edges WHERE canvas_id = ?1",
        )?;
        let parent_edges = parent_edge_statement
            .query_map([canvas_id], edge_from_row)?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|edge| {
                folder_node_ids.contains(&edge.source_node_id)
                    || folder_node_ids.contains(&edge.target_node_id)
            })
            .collect::<Vec<_>>();
        drop(parent_edge_statement);

        let folder_title = next_folder_title(&transaction, canvas_id)?;
        let timestamp = now();
        let merged_child_canvas_id = format!("canvas:{}", Uuid::new_v4());
        let merged_folder_node_id = format!("node:{}", Uuid::new_v4());
        let folder_x = sources
            .iter()
            .map(|source| source.folder_node.x)
            .fold(f64::INFINITY, f64::min);
        let folder_y = sources
            .iter()
            .map(|source| source.folder_node.y)
            .fold(f64::INFINITY, f64::min);
        let merged_node_count = sources
            .iter()
            .map(|source| source.nodes.len())
            .sum::<usize>()
            .saturating_sub(removed_input_node_ids.len());
        let folder_content = json!({
            "childCanvasId": merged_child_canvas_id,
            "nodeCount": merged_node_count,
        });

        transaction.execute(
            "INSERT INTO canvases (id, name, is_private, created_at, updated_at)
             SELECT ?1, ?2, is_private, ?3, ?3 FROM canvases WHERE id = ?4",
            params![merged_child_canvas_id, folder_title, timestamp, canvas_id],
        )?;
        transaction.execute(
            "INSERT INTO nodes (
                id, canvas_id, kind, title, content_json, source, request_id,
                x, y, width, height, status, created_at, updated_at
             ) VALUES (?1, ?2, 'folder', ?3, ?4, 'manual', NULL,
                       ?5, ?6, ?7, ?8, 'ready', ?9, ?9)",
            params![
                merged_folder_node_id,
                canvas_id,
                folder_title,
                serde_json::to_string(&folder_content)?,
                folder_x,
                folder_y,
                FOLDER_NODE_WIDTH,
                FOLDER_NODE_HEIGHT,
                timestamp,
            ],
        )?;
        transaction.execute(
            "INSERT INTO canvas_folders (folder_node_id, child_canvas_id, created_at)
             VALUES (?1, ?2, ?3)",
            params![merged_folder_node_id, merged_child_canvas_id, timestamp],
        )?;

        let mut next_group_x = 80.0;
        for source in &sources {
            let (min_x, min_y, group_width) = if source.nodes.is_empty() {
                (0.0, 0.0, FOLDER_NODE_WIDTH)
            } else {
                let min_x = source
                    .nodes
                    .iter()
                    .map(|node| node.x)
                    .fold(f64::INFINITY, f64::min);
                let min_y = source
                    .nodes
                    .iter()
                    .map(|node| node.y)
                    .fold(f64::INFINITY, f64::min);
                let max_right = source
                    .nodes
                    .iter()
                    .map(|node| node.x + node.width)
                    .fold(f64::NEG_INFINITY, f64::max);
                (min_x, min_y, (max_right - min_x).max(FOLDER_NODE_WIDTH))
            };
            for node in &source.nodes {
                if removed_input_node_ids.contains(&node.id) {
                    continue;
                }
                let remapped_content =
                    remap_folder_input_references(&node.content, &input_node_replacements);
                transaction.execute(
                    "UPDATE nodes
                     SET canvas_id = ?2, content_json = ?3, x = ?4, y = ?5, updated_at = ?6
                     WHERE id = ?1",
                    params![
                        node.id,
                        merged_child_canvas_id,
                        serde_json::to_string(&remapped_content)?,
                        node.x - min_x + next_group_x,
                        node.y - min_y + 80.0,
                        timestamp,
                    ],
                )?;
                transaction.execute(
                    "UPDATE prompt_scene_bindings SET canvas_id = ?2, updated_at = ?3 WHERE node_id = ?1",
                    params![node.id, merged_child_canvas_id, timestamp],
                )?;
            }
            for edge in &source.edges {
                let source_node_id = input_node_replacements
                    .get(&edge.source_node_id)
                    .unwrap_or(&edge.source_node_id);
                let target_node_id = input_node_replacements
                    .get(&edge.target_node_id)
                    .unwrap_or(&edge.target_node_id);
                transaction.execute("DELETE FROM edges WHERE id = ?1", [&edge.id])?;
                transaction.execute(
                    "INSERT INTO edges (
                        id, canvas_id, source_node_id, target_node_id, kind,
                        metadata_json, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(canvas_id, source_node_id, target_node_id, kind) DO NOTHING",
                    params![
                        edge.id,
                        merged_child_canvas_id,
                        source_node_id,
                        target_node_id,
                        edge.kind,
                        serde_json::to_string(&edge.metadata)?,
                        edge.created_at,
                    ],
                )?;
            }
            next_group_x += group_width + 160.0;
        }

        for source in &sources {
            transaction.execute(
                "DELETE FROM canvases WHERE id = ?1",
                [&source.child_canvas.id],
            )?;
            transaction.execute(
                "DELETE FROM nodes WHERE id = ?1 AND canvas_id = ?2 AND kind = 'folder'",
                params![source.folder_node.id, canvas_id],
            )?;
        }

        touch_canvas(&transaction, canvas_id)?;
        touch_canvas(&transaction, &merged_child_canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, canvas_id)?;
        let child = load_workspace_from_connection(&transaction, &merged_child_canvas_id)?;
        transaction.commit()?;

        Ok(MergeFoldersResult {
            parent,
            child,
            folder_node_id: merged_folder_node_id.clone(),
            merged_node_count,
            source_folder_count: sources.len(),
            deduplicated_input_node_count: removed_input_node_ids.len(),
            undo: FolderMergeUndoRecord {
                parent_canvas_id: canvas_id.to_owned(),
                merged_child_canvas_id,
                merged_folder_node_id,
                sources,
                parent_edges,
                deduplicated_input_nodes,
            },
        })
    }

    pub fn undo_folder_merge(
        &self,
        input: UndoFolderMergeInput,
    ) -> CanvasResult<WorkspaceSnapshot> {
        let merge = input.merge;
        if merge.sources.len() < 2 {
            return Err(CanvasError::Validation(
                "folder merge contains fewer than two source folders".to_owned(),
            ));
        }
        let all_source_node_ids = merge
            .sources
            .iter()
            .flat_map(|source| source.nodes.iter().map(|node| node.id.clone()))
            .collect::<BTreeSet<_>>();
        let mut removed_input_node_ids = BTreeSet::new();
        for deduplicated in &merge.deduplicated_input_nodes {
            if !all_source_node_ids.contains(&deduplicated.kept_node_id)
                || deduplicated.removed_node_ids.is_empty()
                || deduplicated.removed_node_ids.iter().any(|node_id| {
                    node_id == &deduplicated.kept_node_id
                        || !all_source_node_ids.contains(node_id)
                        || !removed_input_node_ids.insert(node_id.clone())
                })
            {
                return Err(CanvasError::Validation(
                    "folder merge deduplication snapshot is inconsistent".to_owned(),
                ));
            }
        }
        let expected_node_ids = all_source_node_ids
            .difference(&removed_input_node_ids)
            .cloned()
            .collect::<BTreeSet<_>>();
        if merge.sources.iter().any(|source| {
            source.folder_node.canvas_id != merge.parent_canvas_id
                || source.folder_node.kind != "folder"
                || source
                    .nodes
                    .iter()
                    .any(|node| node.canvas_id != source.child_canvas.id)
        }) {
            return Err(CanvasError::Validation(
                "folder merge snapshot is inconsistent".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let linked_child_canvas_id = transaction
            .query_row(
                "SELECT child_canvas_id FROM canvas_folders WHERE folder_node_id = ?1",
                [&merge.merged_folder_node_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| CanvasError::Conflict("merged folder no longer exists".to_owned()))?;
        if linked_child_canvas_id != merge.merged_child_canvas_id {
            return Err(CanvasError::Conflict(
                "merged folder now points to a different child canvas".to_owned(),
            ));
        }
        let mut merged_node_statement =
            transaction.prepare("SELECT id FROM nodes WHERE canvas_id = ?1")?;
        let current_node_ids = merged_node_statement
            .query_map([&merge.merged_child_canvas_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<BTreeSet<_>, _>>()?;
        drop(merged_node_statement);
        if current_node_ids != expected_node_ids {
            return Err(CanvasError::Conflict(
                "merged folder changed after merging; undo would discard newer nodes".to_owned(),
            ));
        }

        transaction.execute(
            "DELETE FROM edges WHERE canvas_id = ?1",
            [&merge.merged_child_canvas_id],
        )?;
        for source in &merge.sources {
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM canvases WHERE id = ?1",
                    [&source.child_canvas.id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if exists {
                return Err(CanvasError::Conflict(
                    "a source folder canvas already exists".to_owned(),
                ));
            }
            transaction.execute(
                "INSERT INTO canvases (id, name, is_private, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    source.child_canvas.id,
                    source.child_canvas.name,
                    i64::from(source.child_canvas.is_private),
                    source.child_canvas.created_at,
                    source.child_canvas.updated_at,
                ],
            )?;
        }

        for source in &merge.sources {
            for node in &source.nodes {
                if removed_input_node_ids.contains(&node.id) {
                    insert_node(&transaction, node)?;
                } else {
                    transaction.execute(
                        "UPDATE nodes SET canvas_id = ?2 WHERE id = ?1",
                        params![node.id, source.child_canvas.id],
                    )?;
                    write_node_update(&transaction, node)?;
                }
            }
            for binding in &source.prompt_scene_bindings {
                if removed_input_node_ids.contains(&binding.node_id) {
                    insert_prompt_scene_binding(&transaction, binding)?;
                } else {
                    update_prompt_scene_binding(&transaction, binding)?;
                }
            }
            for edge in &source.edges {
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
        }

        transaction.execute(
            "DELETE FROM canvases WHERE id = ?1",
            [&merge.merged_child_canvas_id],
        )?;
        transaction.execute(
            "DELETE FROM nodes WHERE id = ?1 AND kind = 'folder'",
            [&merge.merged_folder_node_id],
        )?;
        for source in &merge.sources {
            insert_node(&transaction, &source.folder_node)?;
            transaction.execute(
                "INSERT INTO canvas_folders (folder_node_id, child_canvas_id, created_at)
                 VALUES (?1, ?2, ?3)",
                params![
                    source.folder_node.id,
                    source.child_canvas.id,
                    source.folder_link_created_at,
                ],
            )?;
        }
        for edge in &merge.parent_edges {
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

        touch_canvas(&transaction, &merge.parent_canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, &merge.parent_canvas_id)?;
        transaction.commit()?;
        Ok(parent)
    }

    pub fn cancel_folder(&self, input: FolderActionInput) -> CanvasResult<CancelFolderResult> {
        let canvas_id = input.canvas_id.trim();
        let folder_node_id = input.folder_node_id.trim();
        if canvas_id.is_empty() || folder_node_id.is_empty() {
            return Err(CanvasError::Validation(
                "canvas id and folder node id are required".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let source = folder_source_snapshot(&transaction, canvas_id, folder_node_id)?;
        let folder_ids = BTreeSet::from([source.folder_node.id.clone()]);
        let parent_edges = incident_edges_for_nodes(&transaction, canvas_id, &folder_ids)?;
        let timestamp = now();

        for node in &source.nodes {
            transaction.execute(
                "UPDATE nodes
                 SET canvas_id = ?2, x = ?3, y = ?4, updated_at = ?5
                 WHERE id = ?1",
                params![
                    node.id,
                    canvas_id,
                    source.folder_node.x + node.x - 80.0,
                    source.folder_node.y + node.y - 80.0,
                    timestamp,
                ],
            )?;
            transaction.execute(
                "UPDATE prompt_scene_bindings SET canvas_id = ?2, updated_at = ?3 WHERE node_id = ?1",
                params![node.id, canvas_id, timestamp],
            )?;
        }
        transaction.execute(
            "UPDATE edges SET canvas_id = ?2 WHERE canvas_id = ?1",
            params![source.child_canvas.id, canvas_id],
        )?;
        let restored_source_edges =
            restore_generated_video_source_edges(&transaction, canvas_id, &source.nodes)?;
        transaction.execute(
            "DELETE FROM canvases WHERE id = ?1",
            [&source.child_canvas.id],
        )?;
        transaction.execute(
            "DELETE FROM nodes WHERE id = ?1 AND canvas_id = ?2 AND kind = 'folder'",
            params![source.folder_node.id, canvas_id],
        )?;

        touch_canvas(&transaction, canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, canvas_id)?;
        transaction.commit()?;
        Ok(CancelFolderResult {
            moved_node_count: source.nodes.len(),
            parent,
            undo: CancelFolderUndoRecord {
                parent_canvas_id: canvas_id.to_owned(),
                source,
                parent_edges,
                restored_source_edges,
            },
        })
    }

    pub fn undo_cancel_folder(
        &self,
        input: UndoCancelFolderInput,
    ) -> CanvasResult<WorkspaceSnapshot> {
        let cancellation = input.cancellation;
        let source = &cancellation.source;
        if source.folder_node.canvas_id != cancellation.parent_canvas_id
            || source.folder_node.kind != "folder"
            || source
                .nodes
                .iter()
                .any(|node| node.canvas_id != source.child_canvas.id)
        {
            return Err(CanvasError::Validation(
                "folder cancellation snapshot is inconsistent".to_owned(),
            ));
        }
        let moved_node_ids = source
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<BTreeSet<_>>();

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if get_node_by_id(&transaction, &source.folder_node.id)?.is_some()
            || transaction
                .query_row(
                    "SELECT 1 FROM canvases WHERE id = ?1",
                    [&source.child_canvas.id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
        {
            return Err(CanvasError::Conflict(
                "the cancelled folder has already been recreated".to_owned(),
            ));
        }
        for node_id in &moved_node_ids {
            let node = get_node_by_id(&transaction, node_id)?.ok_or_else(|| {
                CanvasError::Conflict("a moved folder node was deleted".to_owned())
            })?;
            if node.canvas_id != cancellation.parent_canvas_id {
                return Err(CanvasError::Conflict(
                    "a moved folder node is no longer on the parent canvas".to_owned(),
                ));
            }
        }
        let current_incident_edges = incident_edges_for_nodes(
            &transaction,
            &cancellation.parent_canvas_id,
            &moved_node_ids,
        )?;
        let current_edge_ids = current_incident_edges
            .iter()
            .map(|edge| edge.id.clone())
            .collect::<BTreeSet<_>>();
        let expected_edge_ids = source
            .edges
            .iter()
            .chain(cancellation.restored_source_edges.iter())
            .map(|edge| edge.id.clone())
            .collect::<BTreeSet<_>>();
        if current_edge_ids != expected_edge_ids {
            return Err(CanvasError::Conflict(
                "moved folder contents changed after cancellation".to_owned(),
            ));
        }

        for edge in current_incident_edges {
            transaction.execute("DELETE FROM edges WHERE id = ?1", [edge.id])?;
        }
        transaction.execute(
            "INSERT INTO canvases (id, name, is_private, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                source.child_canvas.id,
                source.child_canvas.name,
                if source.child_canvas.is_private { 1 } else { 0 },
                source.child_canvas.created_at,
                source.child_canvas.updated_at,
            ],
        )?;
        for node in &source.nodes {
            transaction.execute(
                "UPDATE nodes SET canvas_id = ?2 WHERE id = ?1",
                params![node.id, source.child_canvas.id],
            )?;
            write_node_update(&transaction, node)?;
        }
        for binding in &source.prompt_scene_bindings {
            update_prompt_scene_binding(&transaction, binding)?;
        }
        for edge in &source.edges {
            insert_edge(&transaction, edge)?;
        }
        insert_node(&transaction, &source.folder_node)?;
        transaction.execute(
            "INSERT INTO canvas_folders (folder_node_id, child_canvas_id, created_at)
             VALUES (?1, ?2, ?3)",
            params![
                source.folder_node.id,
                source.child_canvas.id,
                source.folder_link_created_at,
            ],
        )?;
        for edge in &cancellation.parent_edges {
            insert_edge(&transaction, edge)?;
        }

        touch_canvas(&transaction, &cancellation.parent_canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, &cancellation.parent_canvas_id)?;
        transaction.commit()?;
        Ok(parent)
    }

    pub fn delete_folder_tree(&self, input: FolderActionInput) -> CanvasResult<DeleteFolderResult> {
        let canvas_id = input.canvas_id.trim();
        let folder_node_id = input.folder_node_id.trim();
        if canvas_id.is_empty() || folder_node_id.is_empty() {
            return Err(CanvasError::Validation(
                "canvas id and folder node id are required".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let root_folder = get_node_by_id(&transaction, folder_node_id)?
            .ok_or_else(|| CanvasError::Validation(format!("node not found: {folder_node_id}")))?;
        if root_folder.canvas_id != canvas_id || root_folder.kind != "folder" {
            return Err(CanvasError::Validation(
                "the selected node is not a folder on the active canvas".to_owned(),
            ));
        }
        let root_link = get_folder_link(&transaction, folder_node_id)?
            .ok_or_else(|| CanvasError::Validation("folder has no child canvas".to_owned()))?;
        let mut canvases = Vec::new();
        let mut nodes = vec![root_folder];
        let mut edges = incident_edges_for_nodes(
            &transaction,
            canvas_id,
            &BTreeSet::from([folder_node_id.to_owned()]),
        )?;
        let mut folder_links = vec![root_link.clone()];
        let mut prompt_scene_bindings = Vec::new();
        let mut visited_canvas_ids = BTreeSet::new();
        collect_canvas_tree_snapshot(
            &transaction,
            &root_link.child_canvas_id,
            &mut visited_canvas_ids,
            &mut canvases,
            &mut nodes,
            &mut edges,
            &mut folder_links,
            &mut prompt_scene_bindings,
        )?;
        let deleted_content_node_count = nodes.len().saturating_sub(1);
        let undo = FolderTreeUndoRecord {
            parent_canvas_id: canvas_id.to_owned(),
            root_folder_node_id: folder_node_id.to_owned(),
            canvases,
            nodes,
            edges,
            folder_links,
            prompt_scene_bindings,
        };

        delete_canvas_tree(&transaction, &root_link.child_canvas_id)?;
        transaction.execute(
            "DELETE FROM nodes WHERE id = ?1 AND canvas_id = ?2 AND kind = 'folder'",
            params![folder_node_id, canvas_id],
        )?;
        touch_canvas(&transaction, canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, canvas_id)?;
        transaction.commit()?;
        Ok(DeleteFolderResult {
            parent,
            deleted_content_node_count,
            undo,
        })
    }

    pub fn undo_delete_folder_tree(
        &self,
        input: UndoDeleteFolderInput,
    ) -> CanvasResult<WorkspaceSnapshot> {
        let deletion = input.deletion;
        if deletion.canvases.is_empty()
            || deletion.nodes.is_empty()
            || deletion.folder_links.is_empty()
            || deletion
                .nodes
                .iter()
                .find(|node| node.id == deletion.root_folder_node_id)
                .is_none_or(|node| {
                    node.canvas_id != deletion.parent_canvas_id || node.kind != "folder"
                })
        {
            return Err(CanvasError::Validation(
                "folder deletion snapshot is inconsistent".to_owned(),
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for canvas in &deletion.canvases {
            if transaction
                .query_row("SELECT 1 FROM canvases WHERE id = ?1", [&canvas.id], |_| {
                    Ok(())
                })
                .optional()?
                .is_some()
            {
                return Err(CanvasError::Conflict(
                    "a deleted folder canvas already exists".to_owned(),
                ));
            }
        }
        for node in &deletion.nodes {
            if get_node_by_id(&transaction, &node.id)?.is_some() {
                return Err(CanvasError::Conflict(
                    "a deleted folder node already exists".to_owned(),
                ));
            }
        }

        for canvas in &deletion.canvases {
            transaction.execute(
                "INSERT INTO canvases (id, name, is_private, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    canvas.id,
                    canvas.name,
                    if canvas.is_private { 1 } else { 0 },
                    canvas.created_at,
                    canvas.updated_at,
                ],
            )?;
        }
        for node in &deletion.nodes {
            insert_node(&transaction, node)?;
            restore_prompt_version_requests_from_node(&transaction, node)?;
        }
        for link in &deletion.folder_links {
            transaction.execute(
                "INSERT INTO canvas_folders (folder_node_id, child_canvas_id, created_at)
                 VALUES (?1, ?2, ?3)",
                params![link.folder_node_id, link.child_canvas_id, link.created_at],
            )?;
        }
        for binding in &deletion.prompt_scene_bindings {
            insert_prompt_scene_binding(&transaction, binding)?;
        }
        for edge in &deletion.edges {
            insert_edge(&transaction, edge)?;
        }

        touch_canvas(&transaction, &deletion.parent_canvas_id)?;
        let parent = load_workspace_from_connection(&transaction, &deletion.parent_canvas_id)?;
        transaction.commit()?;
        Ok(parent)
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

    pub fn list_prompt_sets_for_canvas(
        &self,
        canvas_id: &str,
    ) -> CanvasResult<Vec<PromptSetSummary>> {
        let connection = self.lock()?;
        let bindings = list_prompt_scene_binding_records(&connection, None)?;
        let active_bindings = bindings
            .into_iter()
            .filter(|binding| binding.canvas_id == canvas_id)
            .collect::<Vec<_>>();
        prompt_set_summaries(&connection, &active_bindings)
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
            validate_reference_selection(scene.reference_selection.as_ref())?;
            validate_generation_options(scene.generation_options.as_ref())?;
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
        let missing_scene_count = input
            .scenes
            .iter()
            .filter(|scene| !existing_by_key.contains_key(&scene.scene_key))
            .count();
        let mut missing_scene_positions = prompt_scene_batch_positions(
            &transaction,
            &canvas_id,
            existing_by_key.values(),
            missing_scene_count,
        )?
        .into_iter();
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
                reference_selection: scene.reference_selection.clone(),
                generation_options: scene.generation_options.clone(),
                duration_override_seconds: None,
                created_at: timestamp.clone(),
                request_id: version_request_id.clone(),
                source: Some(source.clone()),
                derived_from: Vec::new(),
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
            let (x, y) = missing_scene_positions.next().ok_or_else(|| {
                CanvasError::Conflict("prompt scene batch placement was incomplete".to_owned())
            })?;
            let node = NodeRecord {
                id: format!("node:{}", Uuid::new_v4()),
                canvas_id: canvas_id.clone(),
                kind: "text".to_owned(),
                title: scene.title.clone(),
                content: json!({
                    "text": scene.text,
                    "information": scene.information,
                    "referenceSelection": scene.reference_selection,
                    "generationOptions": scene.generation_options,
                    "contentNode": true,
                    "contentType": "prompt",
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
        validate_reference_selection(input.reference_selection.as_ref())?;
        validate_generation_options(input.generation_options.as_ref())?;
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
        if node.kind != "text" || !is_content_iteration_node(&node.content) {
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
            reference_selection: input.reference_selection,
            generation_options: input.generation_options,
            duration_override_seconds: None,
            created_at: timestamp.clone(),
            request_id: Some(input.request_id),
            source: Some(source),
            derived_from: Vec::new(),
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
        content.insert(
            "referenceSelection".to_owned(),
            version.reference_selection.clone().unwrap_or(Value::Null),
        );
        content.insert(
            "generationOptions".to_owned(),
            serde_json::to_value(&version.generation_options)?,
        );
        content.insert("contentNode".to_owned(), Value::Bool(true));
        content
            .entry("contentType".to_owned())
            .or_insert_with(|| Value::String("prompt".to_owned()));
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

    pub fn append_content_version(
        &self,
        node_id: &str,
        input: AppendPromptVersionInput,
    ) -> CanvasResult<AppendContentVersionResult> {
        validate_prompt_identifier("node id", node_id, 160)?;
        validate_prompt_text(&input.text, &input.information)?;
        validate_reference_selection(input.reference_selection.as_ref())?;
        validate_generation_options(input.generation_options.as_ref())?;
        validate_optional_request_id(Some(&input.request_id))?;
        let source = input
            .source
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "codex".to_owned());

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut node = get_node_by_id(&transaction, node_id)?
            .ok_or_else(|| CanvasError::NotFound(format!("content node not found: {node_id}")))?;
        if node.kind != "text" || !is_content_iteration_node(&node.content) {
            return Err(CanvasError::Conflict(format!(
                "node is not a content iteration node: {}",
                node.id
            )));
        }

        let mut versions = prompt_versions_from_content(&node.content)?;
        if let Some((request_node_id, version_id)) =
            get_prompt_version_request(&transaction, &input.request_id)?
        {
            if request_node_id != node.id {
                return Err(CanvasError::Conflict(format!(
                    "content version request id was already used: {}",
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
            transaction.commit()?;
            return Ok(AppendContentVersionResult {
                node,
                version: existing,
                created: false,
            });
        }
        if let Some(expected_version_count) = input.expected_version_count {
            if versions.len() != expected_version_count {
                return Err(CanvasError::Conflict(format!(
                    "version count changed for content node {node_id}: expected {expected_version_count}, actual {}",
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
        let derived_from = content_version_sources(&transaction, &node.id)?;
        let version = PromptVersionRecord {
            id: format!("version:{}", Uuid::new_v4()),
            label: format!("v{version_number}"),
            title: input
                .title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| node.title.clone()),
            text: input.text,
            information: input.information,
            reference_selection: input.reference_selection,
            generation_options: input.generation_options,
            duration_override_seconds: None,
            created_at: timestamp.clone(),
            request_id: Some(input.request_id),
            source: Some(source),
            derived_from,
        };
        versions.push(version.clone());
        let content = node.content.as_object_mut().ok_or_else(|| {
            CanvasError::Conflict(format!(
                "content node payload is not an object: {}",
                node.id
            ))
        })?;
        content.insert("text".to_owned(), Value::String(version.text.clone()));
        content.insert(
            "information".to_owned(),
            Value::String(version.information.clone()),
        );
        content.insert(
            "referenceSelection".to_owned(),
            version.reference_selection.clone().unwrap_or(Value::Null),
        );
        content.insert("contentNode".to_owned(), Value::Bool(true));
        content
            .entry("contentType".to_owned())
            .or_insert_with(|| Value::String("prompt".to_owned()));
        content.insert(
            "promptVersions".to_owned(),
            serde_json::to_value(&versions)?,
        );
        content.insert(
            "activePromptVersionId".to_owned(),
            Value::String(version.id.clone()),
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
        touch_canvas(&transaction, &node.canvas_id)?;
        transaction.commit()?;

        Ok(AppendContentVersionResult {
            node,
            version,
            created: true,
        })
    }

    pub fn delete_content_version(
        &self,
        node_id: &str,
        version_id: &str,
    ) -> CanvasResult<NodeRecord> {
        validate_prompt_identifier("node id", node_id, 160)?;
        validate_prompt_identifier("version id", version_id, 160)?;

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut node = get_node_by_id(&transaction, node_id)?
            .ok_or_else(|| CanvasError::NotFound(format!("content node not found: {node_id}")))?;
        if node.kind != "text" || !is_content_iteration_node(&node.content) {
            return Err(CanvasError::Conflict(format!(
                "node is not a content iteration node: {}",
                node.id
            )));
        }

        let mut versions = prompt_versions_from_content(&node.content)?;
        if versions.len() <= 1 {
            return Err(CanvasError::Conflict(
                "the only content version cannot be deleted".to_owned(),
            ));
        }
        let removed_index = versions
            .iter()
            .position(|version| version.id == version_id)
            .ok_or_else(|| {
                CanvasError::NotFound(format!("content version not found: {version_id}"))
            })?;
        versions.remove(removed_index);

        let active_version_id = node
            .content
            .get("activePromptVersionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let active_version = versions
            .iter()
            .find(|version| version.id == active_version_id)
            .or_else(|| versions.get(removed_index.saturating_sub(1)))
            .or_else(|| versions.last())
            .cloned()
            .ok_or_else(|| {
                CanvasError::Conflict("content node has no remaining version".to_owned())
            })?;

        let content = node.content.as_object_mut().ok_or_else(|| {
            CanvasError::Conflict(format!(
                "content node payload is not an object: {}",
                node.id
            ))
        })?;
        content.insert(
            "text".to_owned(),
            Value::String(active_version.text.clone()),
        );
        content.insert(
            "information".to_owned(),
            Value::String(active_version.information.clone()),
        );
        content.insert(
            "referenceSelection".to_owned(),
            active_version
                .reference_selection
                .clone()
                .unwrap_or(Value::Null),
        );
        content.insert(
            "promptVersions".to_owned(),
            serde_json::to_value(&versions)?,
        );
        content.insert(
            "activePromptVersionId".to_owned(),
            Value::String(active_version.id.clone()),
        );
        node.updated_at = now();
        validate_node(&node)?;
        write_node_update(&transaction, &node)?;
        transaction.execute(
            "DELETE FROM prompt_version_requests WHERE node_id = ?1 AND version_id = ?2",
            params![node_id, version_id],
        )?;
        touch_canvas(&transaction, &node.canvas_id)?;
        transaction.commit()?;
        Ok(node)
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
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut node = get_node_by_id(&transaction, &input.id)?
            .ok_or_else(|| CanvasError::Validation(format!("node not found: {}", input.id)))?;
        apply_node_update(&mut node, input);
        if node.kind == "folder" {
            node.title =
                unique_folder_title(&transaction, &node.canvas_id, &node.title, Some(&node.id))?;
        }
        validate_node(&node)?;
        node.updated_at = now();
        write_node_update(&transaction, &node)?;
        if node.kind == "folder" {
            transaction.execute(
                "UPDATE canvases
                 SET name = ?2, updated_at = ?3
                 WHERE id = (SELECT child_canvas_id FROM canvas_folders WHERE folder_node_id = ?1)",
                params![node.id, node.title, node.updated_at],
            )?;
        }
        touch_canvas(&transaction, &node.canvas_id)?;
        transaction.commit()?;
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
        let node = get_node_by_id(&connection, id)?
            .ok_or_else(|| CanvasError::Validation(format!("node not found: {id}")))?;
        if node.kind == "folder" {
            return Err(CanvasError::Validation(
                "folder nodes cannot be deleted with ordinary node deletion".to_owned(),
            ));
        }
        let canvas_id = node.canvas_id;
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
            if node.kind == "folder" {
                return Err(CanvasError::Validation(
                    "folder nodes cannot be deleted with ordinary node deletion".to_owned(),
                ));
            }
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
        self.create_edge_with_status(input).map(|(edge, _)| edge)
    }

    pub fn create_edge_with_status(
        &self,
        input: CreateEdgeInput,
    ) -> CanvasResult<(EdgeRecord, bool)> {
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
        let mut kind = input.kind.unwrap_or_else(|| "flow".to_owned());
        if kind == "scene-branch" {
            kind = "content-derivation".to_owned();
        }
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
        if kind == "content-derivation" || kind == "scene-branch" {
            let source_is_content =
                source.kind == "text" && is_content_iteration_node(&source.content);
            let target_is_content =
                target.kind == "text" && is_content_iteration_node(&target.content);
            if !source_is_content || !target_is_content {
                return Err(CanvasError::Validation(
                    "a content-derivation edge must connect two content iteration nodes".to_owned(),
                ));
            }
            let creates_cycle: Option<i64> = connection
                .query_row(
                    "WITH RECURSIVE descendants(node_id) AS (
                       SELECT target_node_id FROM edges
                       WHERE canvas_id = ?1 AND source_node_id = ?2
                         AND kind IN ('content-derivation', 'scene-branch')
                       UNION
                       SELECT edges.target_node_id FROM edges
                       JOIN descendants ON edges.source_node_id = descendants.node_id
                       WHERE edges.canvas_id = ?1
                         AND edges.kind IN ('content-derivation', 'scene-branch')
                     )
                     SELECT 1 FROM descendants WHERE node_id = ?3 LIMIT 1",
                    params![canvas_id, input.target_node_id, input.source_node_id],
                    |row| row.get(0),
                )
                .optional()?;
            if creates_cycle.is_some() {
                return Err(CanvasError::Validation(
                    "a content-derivation edge cannot create a cycle".to_owned(),
                ));
            }
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
            return Ok((edge, false));
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
        Ok((edge, true))
    }

    pub fn place_node_to_the_right_of(
        &self,
        source_node_id: &str,
        target_node_id: &str,
    ) -> CanvasResult<NodeRecord> {
        const CONTENT_DERIVATION_GAP: f64 = 60.0;
        let source = {
            let connection = self.lock()?;
            get_node_by_id(&connection, source_node_id)?
                .ok_or_else(|| CanvasError::Validation("source node not found".to_owned()))?
        };

        self.update_node(UpdateNodeInput {
            id: target_node_id.to_owned(),
            title: None,
            content: None,
            x: Some(source.x + source.width + CONTENT_DERIVATION_GAP),
            y: Some(source.y),
            width: None,
            height: None,
            status: None,
        })
    }

    pub fn capture_active_version_sources(&self, target_node_id: &str) -> CanvasResult<NodeRecord> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut target = get_node_by_id(&transaction, target_node_id)?
            .ok_or_else(|| CanvasError::Validation("target node not found".to_owned()))?;
        let sources = content_version_sources(&transaction, target_node_id)?;
        let active_version_id = target
            .content
            .get("activePromptVersionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(active_version_id) = active_version_id else {
            transaction.commit()?;
            return Ok(target);
        };
        let Some(versions) = target
            .content
            .get_mut("promptVersions")
            .and_then(Value::as_array_mut)
        else {
            transaction.commit()?;
            return Ok(target);
        };
        let Some(active_version) = versions.iter_mut().find(|version| {
            version.get("id").and_then(Value::as_str) == Some(active_version_id.as_str())
        }) else {
            transaction.commit()?;
            return Ok(target);
        };
        let Some(active_version) = active_version.as_object_mut() else {
            transaction.commit()?;
            return Ok(target);
        };
        let mut existing_sources = active_version
            .get("derivedFrom")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut changed = false;
        for source in sources {
            let source_is_recorded = existing_sources.iter().any(|entry| {
                entry.get("nodeId").and_then(Value::as_str) == Some(source.node_id.as_str())
            });
            if !source_is_recorded {
                existing_sources.push(serde_json::to_value(source)?);
                changed = true;
            }
        }
        if changed {
            active_version.insert("derivedFrom".to_owned(), Value::Array(existing_sources));
            validate_node(&target)?;
            target.updated_at = now();
            write_node_update(&transaction, &target)?;
            touch_canvas(&transaction, &target.canvas_id)?;
        }
        transaction.commit()?;
        Ok(target)
    }

    pub fn delete_edge(&self, id: &str) -> CanvasResult<()> {
        let connection = self.lock()?;
        let edge = connection
            .query_row(
                "SELECT canvas_id, source_node_id, target_node_id, kind
                 FROM edges WHERE id = ?1",
                [id],
                |row| {
                    Ok(EdgeRecord {
                        id: id.to_owned(),
                        canvas_id: row.get(0)?,
                        source_node_id: row.get(1)?,
                        target_node_id: row.get(2)?,
                        kind: row.get(3)?,
                        metadata: Value::Null,
                        created_at: String::new(),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| CanvasError::Validation(format!("edge not found: {id}")))?;
        if is_protected_generation_edge(&connection, &edge)? {
            return Err(CanvasError::Conflict(
                "generated video ownership links cannot be disconnected".to_owned(),
            ));
        }
        let changed = connection.execute("DELETE FROM edges WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(CanvasError::Validation(format!("edge not found: {id}")));
        }
        touch_canvas(&connection, &edge.canvas_id)?;
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
                reference_selection: object
                    .get("referenceSelection")
                    .filter(|value| !value.is_null())
                    .cloned(),
                generation_options: object
                    .get("generationOptions")
                    .filter(|value| !value.is_null())
                    .map(|value| serde_json::from_value(value.clone()))
                    .transpose()
                    .map_err(|_| {
                        CanvasError::Conflict(
                            "prompt version generationOptions is invalid".to_owned(),
                        )
                    })?,
                duration_override_seconds: object
                    .get("durationOverrideSeconds")
                    .filter(|value| !value.is_null())
                    .map(|value| serde_json::from_value(value.clone()))
                    .transpose()
                    .map_err(|_| {
                        CanvasError::Conflict(
                            "prompt version durationOverrideSeconds is invalid".to_owned(),
                        )
                    })?,
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
                derived_from: object
                    .get("derivedFrom")
                    .and_then(Value::as_array)
                    .map(|sources| {
                        sources
                            .iter()
                            .filter_map(|source| serde_json::from_value(source.clone()).ok())
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn content_version_sources(
    connection: &Connection,
    target_node_id: &str,
) -> CanvasResult<Vec<ContentVersionSource>> {
    let mut statement = connection.prepare(
        "SELECT source_node_id
         FROM edges
         WHERE target_node_id = ?1
           AND kind IN ('content-derivation', 'scene-branch')
         ORDER BY created_at ASC, id ASC",
    )?;
    let source_ids = statement
        .query_map([target_node_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut sources = Vec::new();
    for source_id in source_ids {
        let Some(source_node) = get_node_by_id(connection, &source_id)? else {
            continue;
        };
        if source_node.kind != "text" || !is_content_iteration_node(&source_node.content) {
            continue;
        }
        let versions = prompt_versions_from_content(&source_node.content)?;
        let active_version_id = source_node
            .content
            .get("activePromptVersionId")
            .and_then(Value::as_str);
        let active_version = active_version_id
            .and_then(|version_id| versions.iter().find(|version| version.id == version_id))
            .or_else(|| versions.last());
        if let Some(version) = active_version {
            sources.push(ContentVersionSource {
                node_id: source_node.id,
                version_id: version.id.clone(),
                version_label: version.label.clone(),
            });
        }
    }
    Ok(sources)
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
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
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

fn validate_reference_selection(selection: Option<&Value>) -> CanvasResult<()> {
    let Some(selection) = selection else {
        return Ok(());
    };
    let object = selection.as_object().ok_or_else(|| {
        CanvasError::Validation("referenceSelection must be an object".to_owned())
    })?;
    let scene_key = object
        .get("sceneKey")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_prompt_identifier("reference selection scene key", scene_key, 64)?;
    let assets = object
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CanvasError::Validation("referenceSelection assets must be an array".to_owned())
        })?;
    if assets.len() > 100 {
        return Err(CanvasError::Validation(
            "referenceSelection cannot exceed 100 assets".to_owned(),
        ));
    }
    for asset in assets {
        let asset = asset.as_object().ok_or_else(|| {
            CanvasError::Validation("referenceSelection asset must be an object".to_owned())
        })?;
        for field in ["sourceId", "kind", "label", "role"] {
            if asset
                .get(field)
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
            {
                return Err(CanvasError::Validation(format!(
                    "referenceSelection asset {field} is required"
                )));
            }
        }
    }
    Ok(())
}

fn validate_generation_options(options: Option<&PromptGenerationOptions>) -> CanvasResult<()> {
    let Some(options) = options else {
        return Ok(());
    };
    if !(2..=15).contains(&options.duration_seconds) {
        return Err(CanvasError::Validation(
            "generationOptions durationSeconds must be an integer from 2 to 15".to_owned(),
        ));
    }
    Ok(())
}

fn is_content_iteration_node(content: &Value) -> bool {
    content.get("contentNode") == Some(&Value::Bool(true))
        || content.get("promptVersionNode") == Some(&Value::Bool(true))
        || content.get("storySceneNode") == Some(&Value::Bool(true))
}

fn migrate_content_iteration_nodes(connection: &Connection) -> CanvasResult<()> {
    let rows = {
        let mut statement = connection.prepare(
            "SELECT id, title, content_json, created_at FROM nodes
             WHERE kind = 'text' AND (
               content_json LIKE '%\"contentNode\":true%'
               OR content_json LIKE '%\"promptVersionNode\":true%'
               OR content_json LIKE '%\"storySceneNode\":true%'
             )",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    for (id, title, content_json, created_at) in rows {
        let mut content: Value = serde_json::from_str(&content_json)?;
        let Some(object) = content.as_object_mut() else {
            continue;
        };
        let was_story_scene = object.get("storySceneNode") == Some(&Value::Bool(true));
        let content_type = object
            .get("contentType")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "plot" | "script" | "storyboard" | "prompt"))
            .unwrap_or(if was_story_scene {
                "storyboard"
            } else {
                "prompt"
            })
            .to_owned();
        object.insert("contentNode".to_owned(), Value::Bool(true));
        object.insert("contentType".to_owned(), Value::String(content_type));
        object.remove("storySceneNode");
        object.remove("promptVersionNode");

        let has_versions = object
            .get("promptVersions")
            .and_then(Value::as_array)
            .is_some_and(|versions| !versions.is_empty());
        let text = object
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let information = object
            .get("information")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if !has_versions && (!text.is_empty() || !information.is_empty()) {
            let version_id = format!("version:{}", Uuid::new_v4());
            object.insert(
                "promptVersions".to_owned(),
                json!([{
                    "id": version_id.clone(),
                    "label": "v1",
                    "title": title,
                    "text": text,
                    "information": information,
                    "createdAt": created_at,
                    "source": "migration"
                }]),
            );
            object.insert(
                "activePromptVersionId".to_owned(),
                Value::String(version_id),
            );
            object
                .entry("bestPromptVersionId".to_owned())
                .or_insert_with(|| Value::String(String::new()));
        }

        connection.execute(
            "UPDATE nodes SET content_json = ?2,
               title = CASE WHEN title IN ('提示词版本', '提示词迭代') THEN '内容迭代' ELSE title END
             WHERE id = ?1",
            params![id, serde_json::to_string(&content)?],
        )?;
    }

    connection.execute(
        "UPDATE OR IGNORE edges
         SET kind = 'content-derivation',
             metadata_json = '{\"relation\":\"content-derivation\"}'
         WHERE kind = 'scene-branch'",
        [],
    )?;
    connection.execute("DELETE FROM edges WHERE kind = 'scene-branch'", [])?;
    Ok(())
}

fn migrate_legacy_content_version_provenance(connection: &Connection) -> CanvasResult<()> {
    let target_ids = {
        let mut statement = connection.prepare(
            "SELECT DISTINCT target_node_id
             FROM edges
             WHERE kind = 'content-derivation'",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };

    for target_id in target_ids {
        let Some(mut target) = get_node_by_id(connection, &target_id)? else {
            continue;
        };
        if target.kind != "text" || !is_content_iteration_node(&target.content) {
            continue;
        }

        let source_ids = {
            let mut statement = connection.prepare(
                "SELECT source_node_id FROM edges
                 WHERE target_node_id = ?1 AND kind = 'content-derivation'
                 ORDER BY created_at ASC, id ASC",
            )?;
            let ids = statement
                .query_map([&target_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        let mut sources = Vec::new();
        let mut can_infer_legacy_provenance = !source_ids.is_empty();
        for source_id in source_ids {
            let Some(source) = get_node_by_id(connection, &source_id)? else {
                can_infer_legacy_provenance = false;
                break;
            };
            if source.kind != "text" || !is_content_iteration_node(&source.content) {
                can_infer_legacy_provenance = false;
                break;
            }
            let versions = prompt_versions_from_content(&source.content)?;
            if versions.len() != 1 {
                can_infer_legacy_provenance = false;
                break;
            }
            sources.push(ContentVersionSource {
                node_id: source.id,
                version_id: versions[0].id.clone(),
                version_label: versions[0].label.clone(),
            });
        }
        if !can_infer_legacy_provenance {
            continue;
        }
        let sources_json = serde_json::to_value(&sources)?;

        let Some(versions) = target
            .content
            .get_mut("promptVersions")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        let mut changed = false;
        for version in versions {
            let has_sources = version
                .get("derivedFrom")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty());
            if !has_sources {
                version.as_object_mut().map(|object| {
                    object.insert("derivedFrom".to_owned(), sources_json.clone());
                });
                changed = true;
            }
        }
        if changed {
            connection.execute(
                "UPDATE nodes SET content_json = ?2 WHERE id = ?1",
                params![target.id, serde_json::to_string(&target.content)?],
            )?;
        }
    }
    Ok(())
}

fn legacy_storyboard_reference_selection(information: &str) -> Option<(String, Value)> {
    const START: &str = "[[INFINITE_CANVAS_H3_REFERENCE_MANIFEST_V1]]";
    const END: &str = "[[/INFINITE_CANVAS_H3_REFERENCE_MANIFEST_V1]]";
    let start = information.find(START)?;
    let end = information.find(END)?;
    if end <= start || information[start + START.len()..].contains(START) {
        return None;
    }
    let mut selection: Value =
        serde_json::from_str(information[start + START.len()..end].trim()).ok()?;
    let object = selection.as_object_mut()?;
    object.remove("schema");
    validate_reference_selection(Some(&selection)).ok()?;
    let before = information[..start].trim_end();
    let after = information[end + END.len()..].trim_start();
    let cleaned = match (before.is_empty(), after.is_empty()) {
        (true, true) => String::new(),
        (false, true) => before.to_owned(),
        (true, false) => after.to_owned(),
        (false, false) => format!("{before}\n\n{after}"),
    };
    Some((cleaned, selection))
}

fn migrate_legacy_storyboard_reference_data(connection: &Connection) -> CanvasResult<()> {
    let rows = {
        let mut statement = connection.prepare(
            "SELECT id, content_json FROM nodes
             WHERE content_json LIKE '%INFINITE_CANVAS_H3_REFERENCE_MANIFEST_V1%'
                OR content_json LIKE '%referenceManifest%'",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    for (id, content_json) in rows {
        let mut content: Value = serde_json::from_str(&content_json)?;
        let Some(content_object) = content.as_object_mut() else {
            continue;
        };
        let mut changed = false;

        if let Some(information) = content_object
            .get("information")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            if let Some((cleaned, selection)) = legacy_storyboard_reference_selection(&information)
            {
                content_object.insert("information".to_owned(), Value::String(cleaned));
                content_object.insert("referenceSelection".to_owned(), selection);
                changed = true;
            }
        }

        if let Some(versions) = content_object
            .get_mut("promptVersions")
            .and_then(Value::as_array_mut)
        {
            for version in versions {
                let Some(version_object) = version.as_object_mut() else {
                    continue;
                };
                let Some(information) = version_object
                    .get("information")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                if let Some((cleaned, selection)) =
                    legacy_storyboard_reference_selection(&information)
                {
                    version_object.insert("information".to_owned(), Value::String(cleaned));
                    version_object.insert("referenceSelection".to_owned(), selection);
                    changed = true;
                }
            }
        }

        if let Some(snapshot) = content_object
            .get_mut("generationSnapshot")
            .and_then(Value::as_object_mut)
        {
            if let Some(information) = snapshot
                .get("promptInformation")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                if let Some((cleaned, selection)) =
                    legacy_storyboard_reference_selection(&information)
                {
                    snapshot.insert("promptInformation".to_owned(), Value::String(cleaned));
                    snapshot.insert("referenceSelection".to_owned(), selection);
                    changed = true;
                }
            }
            if let Some(mut selection) = snapshot.remove("referenceManifest") {
                if let Some(object) = selection.as_object_mut() {
                    object.remove("schema");
                }
                snapshot.insert("referenceSelection".to_owned(), selection);
                changed = true;
            }
            if let Some(error) = snapshot.remove("referenceManifestError") {
                snapshot.insert("referenceSelectionError".to_owned(), error);
                changed = true;
            }
        }

        if changed {
            connection.execute(
                "UPDATE nodes SET content_json = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(&content)?],
            )?;
        }
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

fn next_folder_title(connection: &Connection, canvas_id: &str) -> CanvasResult<String> {
    unique_folder_title(connection, canvas_id, "新建目录", None)
}

fn get_folder_link(
    connection: &Connection,
    folder_node_id: &str,
) -> CanvasResult<Option<CanvasFolderLinkRecord>> {
    connection
        .query_row(
            "SELECT folder_node_id, child_canvas_id, created_at
             FROM canvas_folders WHERE folder_node_id = ?1",
            [folder_node_id],
            |row| {
                Ok(CanvasFolderLinkRecord {
                    folder_node_id: row.get(0)?,
                    child_canvas_id: row.get(1)?,
                    created_at: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(CanvasError::Database)
}

fn incident_edges_for_nodes(
    connection: &Connection,
    canvas_id: &str,
    node_ids: &BTreeSet<String>,
) -> CanvasResult<Vec<EdgeRecord>> {
    if node_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "SELECT id, canvas_id, source_node_id, target_node_id, kind,
                metadata_json, created_at
         FROM edges WHERE canvas_id = ?1",
    )?;
    let edges = statement
        .query_map([canvas_id], edge_from_row)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|edge| {
            node_ids.contains(&edge.source_node_id) || node_ids.contains(&edge.target_node_id)
        })
        .collect();
    Ok(edges)
}

fn folder_source_snapshot(
    connection: &Connection,
    parent_canvas_id: &str,
    folder_node_id: &str,
) -> CanvasResult<FolderMergeSourceSnapshot> {
    let folder_node = get_node_by_id(connection, folder_node_id)?
        .ok_or_else(|| CanvasError::Validation(format!("node not found: {folder_node_id}")))?;
    if folder_node.canvas_id != parent_canvas_id || folder_node.kind != "folder" {
        return Err(CanvasError::Validation(
            "the selected node is not a folder on the active canvas".to_owned(),
        ));
    }
    let link = get_folder_link(connection, folder_node_id)?
        .ok_or_else(|| CanvasError::Validation("folder has no child canvas".to_owned()))?;
    let child = load_workspace_from_connection(connection, &link.child_canvas_id)?;
    let mut prompt_scene_bindings = Vec::new();
    for node in &child.nodes {
        if let Some(binding) = get_prompt_scene_binding_by_node_id(connection, &node.id)? {
            prompt_scene_bindings.push(binding);
        }
    }
    Ok(FolderMergeSourceSnapshot {
        folder_node,
        child_canvas: child.canvas,
        folder_link_created_at: link.created_at,
        nodes: child.nodes,
        edges: child.edges,
        prompt_scene_bindings,
    })
}

#[allow(clippy::too_many_arguments)]
fn collect_canvas_tree_snapshot(
    connection: &Connection,
    canvas_id: &str,
    visited_canvas_ids: &mut BTreeSet<String>,
    canvases: &mut Vec<CanvasRecord>,
    nodes: &mut Vec<NodeRecord>,
    edges: &mut Vec<EdgeRecord>,
    folder_links: &mut Vec<CanvasFolderLinkRecord>,
    prompt_scene_bindings: &mut Vec<PromptSceneBindingRecord>,
) -> CanvasResult<()> {
    if !visited_canvas_ids.insert(canvas_id.to_owned()) {
        return Err(CanvasError::Conflict(
            "folder canvas hierarchy contains a cycle".to_owned(),
        ));
    }
    let workspace = load_workspace_from_connection(connection, canvas_id)?;
    canvases.push(workspace.canvas.clone());
    edges.extend(workspace.edges.iter().cloned());
    for node in &workspace.nodes {
        if let Some(binding) = get_prompt_scene_binding_by_node_id(connection, &node.id)? {
            prompt_scene_bindings.push(binding);
        }
        if node.kind == "folder" {
            let link = get_folder_link(connection, &node.id)?.ok_or_else(|| {
                CanvasError::Conflict(format!("nested folder has no child canvas: {}", node.id))
            })?;
            folder_links.push(link.clone());
            collect_canvas_tree_snapshot(
                connection,
                &link.child_canvas_id,
                visited_canvas_ids,
                canvases,
                nodes,
                edges,
                folder_links,
                prompt_scene_bindings,
            )?;
        }
    }
    nodes.extend(workspace.nodes);
    Ok(())
}

fn insert_edge(connection: &Connection, edge: &EdgeRecord) -> CanvasResult<()> {
    let metadata_json = serde_json::to_string(&edge.metadata)?;
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
    Ok(())
}

fn folder_input_original_source_id(
    connection: &Connection,
    node: &NodeRecord,
) -> CanvasResult<String> {
    let mut resolved_source_id = node.id.clone();
    let mut next_source_id = node
        .content
        .get("folderInputCopySourceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|source_node_id| !source_node_id.is_empty())
        .map(str::to_owned);
    let mut visited = BTreeSet::from([node.id.clone()]);

    while let Some(source_node_id) = next_source_id {
        if !visited.insert(source_node_id.clone()) {
            return Err(CanvasError::Conflict(
                "folder input copy provenance contains a cycle".to_owned(),
            ));
        }
        resolved_source_id = source_node_id.clone();
        next_source_id = get_node_by_id(connection, &source_node_id)?.and_then(|source| {
            source
                .content
                .get("folderInputCopySourceId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|source_node_id| !source_node_id.is_empty())
                .map(str::to_owned)
        });
    }

    Ok(resolved_source_id)
}

fn remap_folder_input_references(
    content: &Value,
    duplicate_node_id_map: &BTreeMap<String, String>,
) -> Value {
    if duplicate_node_id_map.is_empty() {
        return content.clone();
    }
    let mut remapped = content.clone();
    let Some(object) = remapped.as_object_mut() else {
        return remapped;
    };

    for key in ["mediaInputOrder", "textInputOrder"] {
        let Some(values) = object.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        for value in values {
            let Some(node_id) = value.as_str() else {
                continue;
            };
            if let Some(duplicate_node_id) = duplicate_node_id_map.get(node_id) {
                *value = Value::String(duplicate_node_id.clone());
            }
        }
    }

    if let Some(active_text_input_id) = object
        .get_mut("activeTextInputId")
        .and_then(|value| value.as_str())
        .and_then(|node_id| duplicate_node_id_map.get(node_id))
        .cloned()
    {
        object.insert(
            "activeTextInputId".to_owned(),
            Value::String(active_text_input_id),
        );
    }

    if let Some(frame_roles) = object.get_mut("frameRoles").and_then(Value::as_object_mut) {
        for (source_node_id, duplicate_node_id) in duplicate_node_id_map {
            if let Some(role) = frame_roles.remove(source_node_id) {
                frame_roles.insert(duplicate_node_id.clone(), role);
            }
        }
    }

    if let Some(snapshot) = object
        .get_mut("generationSnapshot")
        .and_then(Value::as_object_mut)
    {
        if let Some(prompt_node_id) = snapshot
            .get("promptNodeId")
            .and_then(Value::as_str)
            .and_then(|node_id| duplicate_node_id_map.get(node_id))
            .cloned()
        {
            snapshot.insert("promptNodeId".to_owned(), Value::String(prompt_node_id));
        }
    }

    remapped
}

fn restore_generated_video_source_edges(
    connection: &Connection,
    canvas_id: &str,
    moved_nodes: &[NodeRecord],
) -> CanvasResult<Vec<EdgeRecord>> {
    let mut restored = Vec::new();
    for node in moved_nodes
        .iter()
        .filter(|node| node.kind == "generated-video")
    {
        let source_preview_id = node
            .content
            .get("sourcePreviewId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let source_generator_id = node
            .content
            .get("sourceGeneratorId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let candidates = [
            source_preview_id.map(|id| (id, "generated-video", "secondary-output")),
            source_generator_id.map(|id| (id, "video-generation", "output")),
        ];
        let mut selected_source = None;
        for candidate in candidates.into_iter().flatten() {
            if candidate.0 == node.id {
                continue;
            }
            let Some(source) = get_node_by_id(connection, candidate.0)? else {
                continue;
            };
            if source.canvas_id == canvas_id && source.kind == candidate.1 {
                selected_source = Some((source.id, candidate.2));
                break;
            }
        }
        let Some((source_node_id, kind)) = selected_source else {
            continue;
        };
        let existing = connection
            .query_row(
                "SELECT id, canvas_id, source_node_id, target_node_id, kind,
                        metadata_json, created_at
                 FROM edges
                 WHERE canvas_id = ?1 AND source_node_id = ?2
                   AND target_node_id = ?3 AND kind = ?4",
                params![canvas_id, source_node_id, node.id, kind],
                edge_from_row,
            )
            .optional()?;
        if existing.is_some() {
            continue;
        }
        let metadata = json!({
            "seed": node.content.get("seed").cloned().unwrap_or(Value::Null),
            "promptId": node.content.get("comfyPromptId").cloned().unwrap_or(Value::Null),
            "outputIndex": node.content.get("outputIndex").cloned().unwrap_or(Value::Null),
            "restoredFromFolder": true,
        });
        let edge = EdgeRecord {
            id: format!("edge:{}", Uuid::new_v4()),
            canvas_id: canvas_id.to_owned(),
            source_node_id,
            target_node_id: node.id.clone(),
            kind: kind.to_owned(),
            metadata,
            created_at: now(),
        };
        insert_edge(connection, &edge)?;
        restored.push(edge);
    }
    Ok(restored)
}

fn unique_folder_title(
    connection: &Connection,
    canvas_id: &str,
    requested_title: &str,
    excluding_node_id: Option<&str>,
) -> CanvasResult<String> {
    let mut statement = connection
        .prepare("SELECT id, title FROM nodes WHERE canvas_id = ?1 AND kind = 'folder'")?;
    let existing = statement
        .query_map([canvas_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(node_id, _)| excluding_node_id != Some(node_id.as_str()))
        .map(|(_, title)| title)
        .collect::<BTreeSet<_>>();
    let base_title = requested_title.trim();
    let base_title = if base_title.is_empty() {
        "新建目录"
    } else {
        base_title
    };
    if !existing.contains(base_title) {
        return Ok(base_title.to_owned());
    }
    for suffix in 2usize.. {
        let candidate = format!("{base_title} {suffix}");
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
    }
    unreachable!("folder suffix search is unbounded")
}

fn delete_canvas_tree(connection: &Connection, canvas_id: &str) -> CanvasResult<()> {
    let mut statement = connection.prepare(
        "SELECT canvas_folders.child_canvas_id
         FROM canvas_folders
         JOIN nodes ON nodes.id = canvas_folders.folder_node_id
         WHERE nodes.canvas_id = ?1",
    )?;
    let child_ids = statement
        .query_map([canvas_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for child_id in child_ids {
        delete_canvas_tree(connection, &child_id)?;
    }
    connection.execute("DELETE FROM canvases WHERE id = ?1", [canvas_id])?;
    Ok(())
}

fn load_workspace_from_connection(
    connection: &Connection,
    canvas_id: &str,
) -> CanvasResult<WorkspaceSnapshot> {
    let canvas = connection.query_row(
        "SELECT id, name, is_private, preview_image_path, created_at, updated_at FROM canvases WHERE id = ?1",
        [canvas_id],
        |row| {
            Ok(CanvasRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                is_private: row.get::<_, i64>(2)? != 0,
                preview_image_path: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )?;

    let mut node_statement = connection.prepare(
        "SELECT id, canvas_id, kind, title, content_json, source, request_id,
                x, y, width, height, status, created_at, updated_at
         FROM nodes WHERE canvas_id = ?1 ORDER BY created_at ASC",
    )?;
    let mut nodes = node_statement
        .query_map([canvas_id], node_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    for node in nodes.iter_mut().filter(|node| node.kind == "folder") {
        let folder_summary = connection
            .query_row(
                "SELECT canvas_folders.child_canvas_id, COUNT(child_nodes.id)
                 FROM canvas_folders
                 LEFT JOIN nodes AS child_nodes
                   ON child_nodes.canvas_id = canvas_folders.child_canvas_id
                 WHERE canvas_folders.folder_node_id = ?1
                 GROUP BY canvas_folders.child_canvas_id",
                [&node.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        if let Some((child_canvas_id, node_count)) = folder_summary {
            if let Value::Object(content) = &mut node.content {
                content.insert("childCanvasId".to_owned(), json!(child_canvas_id));
                content.insert("nodeCount".to_owned(), json!(node_count.max(0) as usize));
            }
        }
    }

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

fn prompt_scene_batch_positions<'a>(
    connection: &Connection,
    canvas_id: &str,
    existing_bindings: impl Iterator<Item = &'a PromptSceneBindingRecord>,
    count: usize,
) -> CanvasResult<Vec<(f64, f64)>> {
    if count == 0 {
        return Ok(Vec::new());
    }

    const NODE_WIDTH: f64 = 360.0;
    const GAP: f64 = 60.0;

    let existing_nodes = existing_bindings
        .map(|binding| {
            get_node_by_id(connection, &binding.node_id)?.ok_or_else(|| {
                CanvasError::Conflict(format!(
                    "scene binding points to a missing node: {}",
                    binding.node_id
                ))
            })
        })
        .collect::<CanvasResult<Vec<_>>>()?;

    let (start_x, row_y) = if let Some(first) = existing_nodes.first() {
        let right_edge = existing_nodes
            .iter()
            .map(|node| node.x + node.width)
            .fold(first.x + first.width, f64::max);
        (right_edge + GAP, first.y)
    } else {
        let (min_x, max_bottom) = connection.query_row(
            "SELECT MIN(x), MAX(y + height) FROM nodes WHERE canvas_id = ?1",
            [canvas_id],
            |row| Ok((row.get::<_, Option<f64>>(0)?, row.get::<_, Option<f64>>(1)?)),
        )?;
        match (min_x, max_bottom) {
            (Some(x), Some(bottom)) => (x, bottom + GAP),
            _ => (80.0, 80.0),
        }
    };

    Ok((0..count)
        .map(|index| (start_x + index as f64 * (NODE_WIDTH + GAP), row_y))
        .collect())
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
    if node.kind == "text"
        && is_content_iteration_node(&node.content)
        && node.content.get("contentType").and_then(Value::as_str) == Some("prompt")
    {
        for version in prompt_versions_from_content(&node.content)? {
            validate_generation_options(version.generation_options.as_ref())?;
            if let Some(duration_override_seconds) = version.duration_override_seconds {
                if !(2..=15).contains(&duration_override_seconds) {
                    return Err(CanvasError::Validation(
                        "prompt version durationOverrideSeconds must be an integer from 2 to 15"
                            .to_owned(),
                    ));
                }
            }
        }
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

fn is_protected_generation_edge(connection: &Connection, edge: &EdgeRecord) -> CanvasResult<bool> {
    if edge.kind != "output" {
        return Ok(false);
    }
    let kinds = connection
        .query_row(
            "SELECT source.kind, target.kind
             FROM nodes source
             JOIN nodes target ON target.id = ?2
             WHERE source.id = ?1",
            params![edge.source_node_id, edge.target_node_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    Ok(matches!(
        kinds,
        Some((source_kind, target_kind))
            if source_kind == "video-generation" && target_kind == "generated-video"
    ))
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

    fn node_with_kind(kind: &str, title: &str, request_id: &str) -> CreateNodeInput {
        let mut input = text_node(title, request_id);
        input.kind = Some(kind.to_owned());
        input
    }

    fn prompt_scene(scene_key: &str) -> crate::models::CreatePromptSceneInput {
        crate::models::CreatePromptSceneInput {
            scene_key: scene_key.to_owned(),
            title: format!("场景 {scene_key}"),
            text: format!("English prompt for {scene_key}"),
            information: format!("{scene_key} 的中文解释"),
            reference_selection: None,
            generation_options: None,
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
    fn creates_an_empty_folder_at_the_requested_position() {
        let database = Database::in_memory().unwrap();

        let result = database
            .create_empty_folder(CreateEmptyFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                x: 240.0,
                y: 360.0,
            })
            .unwrap();

        let folder = result
            .parent
            .nodes
            .iter()
            .find(|node| node.id == result.folder_node_id)
            .unwrap();
        assert_eq!(folder.kind, "folder");
        assert_eq!(folder.x, 240.0);
        assert_eq!(folder.y, 360.0);
        assert_eq!(folder.content["nodeCount"], json!(0));
        assert_eq!(result.child.canvas.name, folder.title);
        assert!(result.child.nodes.is_empty());
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
    fn stores_an_image_asset_as_the_project_preview() {
        let database = Database::in_memory().unwrap();
        let preview_path = r"C:\assets\project-preview.png";
        let mut image = node_with_kind("image", "Preview", "project-preview-image");
        image.content = json!({ "assetPath": preview_path });
        let created = database.create_node(image).unwrap();

        let canvas = database
            .set_project_preview_image(DEFAULT_CANVAS_ID, &created.node.id)
            .unwrap();

        assert_eq!(canvas.preview_image_path.as_deref(), Some(preview_path));
        assert_eq!(
            database
                .load_project(DEFAULT_CANVAS_ID)
                .unwrap()
                .canvas
                .preview_image_path
                .as_deref(),
            Some(preview_path)
        );
    }

    #[test]
    fn rejects_a_non_image_as_the_project_preview() {
        let database = Database::in_memory().unwrap();
        let created = database
            .create_node(text_node("Not an image", "not-project-preview"))
            .unwrap();

        assert!(database
            .set_project_preview_image(DEFAULT_CANVAS_ID, &created.node.id)
            .is_err());
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
    fn backfills_legacy_content_version_provenance_only_for_single_version_sources() {
        let database = Database::in_memory().unwrap();
        let mut source_input = text_node("隔壁房", "legacy-provenance-source");
        source_input.content = json!({
            "text": "剧情概念",
            "contentNode": true,
            "contentType": "plot",
            "promptVersions": [{
                "id": "plot-v1",
                "label": "v1",
                "title": "隔壁房",
                "text": "剧情概念",
                "information": ""
            }],
            "activePromptVersionId": "plot-v1"
        });
        let source = database.create_node(source_input).unwrap().node;
        let mut target_input = text_node("隔壁房", "legacy-provenance-target");
        target_input.content = json!({
            "text": "剧本",
            "contentNode": true,
            "contentType": "script",
            "promptVersions": [{
                "id": "script-v1",
                "label": "v1",
                "title": "隔壁房",
                "text": "剧本",
                "information": ""
            }],
            "activePromptVersionId": "script-v1"
        });
        let target = database.create_node(target_input).unwrap().node;
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.id.clone(),
                target_node_id: target.id.clone(),
                kind: Some("content-derivation".to_owned()),
                metadata: json!({ "relation": "content-derivation" }),
            })
            .unwrap();

        let connection = database.lock().unwrap();
        migrate_legacy_content_version_provenance(&connection).unwrap();
        drop(connection);

        let migrated = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        let migrated_target = migrated
            .nodes
            .into_iter()
            .find(|node| node.id == target.id)
            .unwrap();
        let version = prompt_versions_from_content(&migrated_target.content)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(version.derived_from.len(), 1);
        assert_eq!(version.derived_from[0].node_id, source.id);
        assert_eq!(version.derived_from[0].version_id, "plot-v1");
    }

    #[test]
    fn places_a_new_content_derivation_target_to_the_right_of_its_source() {
        let database = Database::in_memory().unwrap();
        let mut source_input = text_node("剧情概念", "right-of-source-parent");
        source_input.content = json!({
            "text": "故事概念",
            "contentNode": true,
            "contentType": "plot"
        });
        source_input.x = Some(120.0);
        source_input.y = Some(180.0);
        source_input.width = Some(360.0);
        let source = database.create_node(source_input).unwrap().node;

        let mut target_input = text_node("剧本", "right-of-source-child");
        target_input.content = json!({
            "text": "剧本内容",
            "contentNode": true,
            "contentType": "script"
        });
        let target = database.create_node(target_input).unwrap().node;

        let (edge, created) = database
            .create_edge_with_status(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.id.clone(),
                target_node_id: target.id.clone(),
                kind: Some("content-derivation".to_owned()),
                metadata: json!({
                    "relation": "content-derivation",
                    "layoutPlacement": "right-of-source"
                }),
            })
            .unwrap();
        assert!(created);
        assert_eq!(edge.kind, "content-derivation");

        let positioned = database
            .place_node_to_the_right_of(&source.id, &target.id)
            .unwrap();
        assert_eq!(positioned.x, 540.0);
        assert_eq!(positioned.y, 180.0);

        let (_, retried) = database
            .create_edge_with_status(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.id,
                target_node_id: target.id,
                kind: Some("content-derivation".to_owned()),
                metadata: json!({ "relation": "content-derivation" }),
            })
            .unwrap();
        assert!(!retried);
    }

    #[test]
    fn persists_content_derivations_with_multiple_parents_and_rejects_cycles() {
        let database = Database::in_memory().unwrap();
        let mut first_scene_input = text_node("场景1", "scene-branch-source-1");
        first_scene_input.content = json!({
            "text": "完整场景一",
            "contentNode": true,
            "contentType": "script"
        });
        let first_scene = database.create_node(first_scene_input).unwrap().node;

        let mut second_scene_input = text_node("场景2", "scene-branch-source-2");
        second_scene_input.content = json!({
            "text": "完整场景二",
            "contentNode": true,
            "contentType": "script"
        });
        let second_scene = database.create_node(second_scene_input).unwrap().node;

        let mut prompt_input = text_node("S1", "scene-branch-target");
        prompt_input.content = json!({
            "text": "H3 prompt",
            "contentNode": true,
            "contentType": "storyboard",
            "promptVersions": []
        });
        let prompt = database.create_node(prompt_input).unwrap().node;

        let edge = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: first_scene.id.clone(),
                target_node_id: prompt.id.clone(),
                kind: Some("content-derivation".to_owned()),
                metadata: json!({ "relation": "content-derivation" }),
            })
            .unwrap();
        let second_edge = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: second_scene.id.clone(),
                target_node_id: prompt.id.clone(),
                kind: Some("content-derivation".to_owned()),
                metadata: json!({ "relation": "content-derivation" }),
            })
            .unwrap();
        let snapshot = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(snapshot.edges, vec![edge, second_edge]);

        let error = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: prompt.id,
                target_node_id: first_scene.id,
                kind: Some("content-derivation".to_owned()),
                metadata: json!({ "relation": "content-derivation" }),
            })
            .unwrap_err();
        assert!(error.to_string().contains("cannot create a cycle"));
    }

    #[test]
    fn appends_content_versions_with_exact_upstream_version_provenance() {
        let database = Database::in_memory().unwrap();
        let mut story_input = text_node("故事脚本", "content-version-source");
        story_input.content = json!({
            "text": "故事 v1",
            "contentNode": true,
            "contentType": "plot",
            "promptVersions": [{
                "id": "story-version-1",
                "label": "v1",
                "title": "故事脚本",
                "text": "故事 v1",
                "information": ""
            }],
            "activePromptVersionId": "story-version-1"
        });
        let story = database.create_node(story_input).unwrap().node;
        let mut storyboard_input = text_node("场景1", "content-version-target");
        storyboard_input.content = json!({
            "text": "分镜 v1",
            "contentNode": true,
            "contentType": "storyboard",
            "promptVersions": [{
                "id": "storyboard-version-1",
                "label": "v1",
                "title": "场景1",
                "text": "分镜 v1",
                "information": ""
            }],
            "activePromptVersionId": "storyboard-version-1"
        });
        let storyboard = database.create_node(storyboard_input).unwrap().node;
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: story.id.clone(),
                target_node_id: storyboard.id.clone(),
                kind: Some("content-derivation".to_owned()),
                metadata: json!({ "relation": "content-derivation" }),
            })
            .unwrap();

        let captured = database
            .capture_active_version_sources(&storyboard.id)
            .unwrap();
        let initial_version = prompt_versions_from_content(&captured.content)
            .unwrap()
            .into_iter()
            .find(|version| version.id == "storyboard-version-1")
            .unwrap();
        assert_eq!(initial_version.derived_from.len(), 1);
        assert_eq!(initial_version.derived_from[0].node_id, story.id);
        assert_eq!(
            initial_version.derived_from[0].version_id,
            "story-version-1"
        );

        let appended = database
            .append_content_version(
                &storyboard.id,
                AppendPromptVersionInput {
                    text: "分镜 v2".to_owned(),
                    information: "根据故事 v1 修改".to_owned(),
                    reference_selection: None,
                    generation_options: None,
                    title: None,
                    source: Some("test".to_owned()),
                    request_id: "append-content-version-v2".to_owned(),
                    expected_version_count: Some(1),
                },
            )
            .unwrap();

        assert!(appended.created);
        assert_eq!(appended.version.label, "v2");
        assert_eq!(appended.version.derived_from.len(), 1);
        assert_eq!(appended.version.derived_from[0].node_id, story.id);
        assert_eq!(
            appended.version.derived_from[0].version_id,
            "story-version-1"
        );
        assert_eq!(appended.version.derived_from[0].version_label, "v1");

        let retry = database
            .append_content_version(
                &storyboard.id,
                AppendPromptVersionInput {
                    text: "分镜 v2".to_owned(),
                    information: "根据故事 v1 修改".to_owned(),
                    reference_selection: None,
                    generation_options: None,
                    title: None,
                    source: Some("test".to_owned()),
                    request_id: "append-content-version-v2".to_owned(),
                    expected_version_count: Some(1),
                },
            )
            .unwrap();
        assert!(!retry.created);
        assert_eq!(retry.version.id, appended.version.id);
    }

    #[test]
    fn rejects_content_derivation_edges_with_the_wrong_node_roles() {
        let database = Database::in_memory().unwrap();
        let ordinary_text = database
            .create_node(text_node("普通文本", "scene-branch-invalid-source"))
            .unwrap()
            .node;
        let prompt = database
            .create_node(text_node("普通目标", "scene-branch-invalid-target"))
            .unwrap()
            .node;

        let error = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: ordinary_text.id,
                target_node_id: prompt.id,
                kind: Some("content-derivation".to_owned()),
                metadata: json!({}),
            })
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("must connect two content iteration nodes"));
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
    fn groups_nodes_and_internal_edges_into_an_auto_named_child_canvas() {
        let database = Database::in_memory().unwrap();
        let source = database
            .create_node(text_node("Generator", "folder-source"))
            .unwrap()
            .node;
        let target = database
            .create_node(text_node("Preview", "folder-target"))
            .unwrap()
            .node;
        let outside = database
            .create_node(text_node("Outside", "folder-outside"))
            .unwrap()
            .node;
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.id.clone(),
                target_node_id: target.id.clone(),
                kind: Some("output".to_owned()),
                metadata: json!({}),
            })
            .unwrap();
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: target.id.clone(),
                target_node_id: outside.id.clone(),
                kind: Some("flow".to_owned()),
                metadata: json!({}),
            })
            .unwrap();

        let result = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![source.id.clone(), target.id.clone()],
            })
            .unwrap();

        assert_eq!(result.removed_crossing_edge_count, 1);
        assert_eq!(result.parent.nodes.len(), 2);
        let folder_node = result
            .parent
            .nodes
            .iter()
            .find(|node| node.kind == "folder")
            .unwrap();
        assert_eq!(folder_node.width, FOLDER_NODE_WIDTH);
        assert_eq!(folder_node.height, FOLDER_NODE_HEIGHT);
        assert!(result.parent.nodes.iter().any(|node| node.id == outside.id));
        assert_eq!(result.child.canvas.name, "新建目录");
        assert_eq!(result.child.nodes.len(), 2);
        assert_eq!(result.child.edges.len(), 1);
        assert_eq!(result.child.edges[0].canvas_id, result.child.canvas.id);
        assert_eq!(database.list_projects().unwrap().len(), 1);
        assert_eq!(database.list_all_projects().unwrap().len(), 2);

        let child_canvas_id = result.child.canvas.id.clone();
        let restored = database
            .undo_folder_grouping(UndoFolderGroupingInput {
                grouping: result.undo,
            })
            .unwrap();

        assert_eq!(restored.nodes.len(), 3);
        assert!(restored.nodes.iter().all(|node| node.kind != "folder"));
        assert!(restored.nodes.iter().any(|node| node.id == source.id));
        assert!(restored.nodes.iter().any(|node| node.id == target.id));
        assert!(restored.nodes.iter().any(|node| node.id == outside.id));
        assert_eq!(restored.edges.len(), 2);
        assert!(restored
            .edges
            .iter()
            .any(|edge| edge.source_node_id == source.id && edge.target_node_id == target.id));
        assert!(restored
            .edges
            .iter()
            .any(|edge| edge.source_node_id == target.id && edge.target_node_id == outside.id));
        assert!(database.load_project(&child_canvas_id).is_err());
        assert_eq!(database.list_all_projects().unwrap().len(), 1);
    }

    #[test]
    fn groups_generation_inputs_and_discards_shared_input_copies_on_undo() {
        let database = Database::in_memory().unwrap();
        let shared_prompt = database
            .create_node(text_node("Shared prompt", "folder-related-shared-prompt"))
            .unwrap()
            .node;
        let shared_image = database
            .create_node(node_with_kind(
                "image",
                "Shared image",
                "folder-related-shared-image",
            ))
            .unwrap()
            .node;
        let audio = database
            .create_node(node_with_kind(
                "audio",
                "Exclusive audio",
                "folder-related-audio",
            ))
            .unwrap()
            .node;

        let mut generator_input =
            node_with_kind("video-generation", "Generator", "folder-related-generator");
        generator_input.x = Some(720.0);
        generator_input.y = Some(480.0);
        generator_input.content = json!({
            "mediaInputOrder": [shared_image.id.clone(), audio.id.clone()],
            "textInputOrder": [shared_prompt.id.clone()],
            "activeTextInputId": shared_prompt.id.clone(),
            "frameRoles": { shared_image.id.clone(): "reference" },
        });
        let generator = database.create_node(generator_input).unwrap().node;
        let outside_generator = database
            .create_node(node_with_kind(
                "video-generation",
                "Outside generator",
                "folder-related-outside-generator",
            ))
            .unwrap()
            .node;
        let preview = database
            .create_node(node_with_kind(
                "generated-video",
                "Preview",
                "folder-related-preview",
            ))
            .unwrap()
            .node;

        for (source_node_id, target_node_id, kind) in [
            (shared_prompt.id.clone(), generator.id.clone(), "input"),
            (
                shared_prompt.id.clone(),
                outside_generator.id.clone(),
                "input",
            ),
            (shared_image.id.clone(), generator.id.clone(), "input"),
            (
                shared_image.id.clone(),
                outside_generator.id.clone(),
                "input",
            ),
            (audio.id.clone(), generator.id.clone(), "input"),
            (generator.id.clone(), preview.id.clone(), "output"),
        ] {
            database
                .create_edge(CreateEdgeInput {
                    canvas_id: None,
                    source_node_id,
                    target_node_id,
                    kind: Some(kind.to_owned()),
                    metadata: json!({}),
                })
                .unwrap();
        }

        let grouped = database
            .group_related_nodes_into_folder(GroupRelatedNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                root_node_id: generator.id.clone(),
            })
            .unwrap();

        assert_eq!(grouped.moved_node_count, 3);
        assert_eq!(grouped.copied_input_node_count, 2);
        assert_eq!(grouped.removed_crossing_edge_count, 0);
        assert_eq!(grouped.parent.nodes.len(), 4);
        assert_eq!(grouped.parent.edges.len(), 2);
        assert_eq!(grouped.child.nodes.len(), 5);
        assert_eq!(grouped.child.edges.len(), 4);
        let folder_node = grouped
            .parent
            .nodes
            .iter()
            .find(|node| node.id == grouped.folder_node_id)
            .unwrap();
        assert_eq!((folder_node.x, folder_node.y), (generator.x, generator.y));

        let prompt_copy = grouped
            .child
            .nodes
            .iter()
            .find(|node| {
                node.content
                    .get("folderInputCopySourceId")
                    .and_then(Value::as_str)
                    == Some(shared_prompt.id.as_str())
            })
            .unwrap();
        let image_copy = grouped
            .child
            .nodes
            .iter()
            .find(|node| {
                node.content
                    .get("folderInputCopySourceId")
                    .and_then(Value::as_str)
                    == Some(shared_image.id.as_str())
            })
            .unwrap();
        let moved_generator = grouped
            .child
            .nodes
            .iter()
            .find(|node| node.id == generator.id)
            .unwrap();
        assert_eq!(
            moved_generator.content["textInputOrder"],
            json!([prompt_copy.id.clone()])
        );
        assert_eq!(
            moved_generator.content["mediaInputOrder"],
            json!([image_copy.id.clone(), audio.id.clone()])
        );
        assert_eq!(
            moved_generator.content["activeTextInputId"],
            json!(prompt_copy.id.clone())
        );
        assert_eq!(
            moved_generator.content["frameRoles"][&image_copy.id],
            json!("reference")
        );
        assert!(grouped.child.edges.iter().any(|edge| {
            edge.source_node_id == prompt_copy.id && edge.target_node_id == generator.id
        }));
        assert!(grouped.child.edges.iter().any(|edge| {
            edge.source_node_id == image_copy.id && edge.target_node_id == generator.id
        }));

        let restored = database
            .undo_folder_grouping(UndoFolderGroupingInput {
                grouping: grouped.undo,
            })
            .unwrap();

        assert_eq!(restored.nodes.len(), 6);
        assert_eq!(restored.edges.len(), 6);
        assert!(restored
            .nodes
            .iter()
            .all(|node| { node.content.get("folderInputCopySourceId").is_none() }));
        let restored_generator = restored
            .nodes
            .iter()
            .find(|node| node.id == generator.id)
            .unwrap();
        assert_eq!(
            restored_generator.content["textInputOrder"],
            json!([shared_prompt.id])
        );
        assert_eq!(
            restored_generator.content["mediaInputOrder"],
            json!([shared_image.id, audio.id])
        );
    }

    #[test]
    fn deduplicates_persisted_shared_inputs_when_separately_grouped_folders_are_merged() {
        let path = std::env::temp_dir().join(format!(
            "infinite-canvas-folder-merge-dedup-{}.sqlite3",
            Uuid::new_v4()
        ));
        let database = Database::open(&path).unwrap();
        let shared_prompt = database
            .create_node(text_node("Shared prompt", "merge-dedup-prompt"))
            .unwrap()
            .node;
        let shared_image = database
            .create_node(node_with_kind("image", "Shared image", "merge-dedup-image"))
            .unwrap()
            .node;
        let shared_audio = database
            .create_node(node_with_kind("audio", "Shared audio", "merge-dedup-audio"))
            .unwrap()
            .node;
        let shared_video = database
            .create_node(node_with_kind("video", "Shared video", "merge-dedup-video"))
            .unwrap()
            .node;
        let exclusive_image = database
            .create_node(node_with_kind(
                "image",
                "Generator B image",
                "merge-dedup-exclusive-image",
            ))
            .unwrap()
            .node;

        let mut generator_a_input =
            node_with_kind("video-generation", "Generator A", "merge-dedup-generator-a");
        generator_a_input.content = json!({
            "mediaInputOrder": [
                shared_image.id.clone(),
                shared_audio.id.clone(),
                shared_video.id.clone()
            ],
            "textInputOrder": [shared_prompt.id.clone()],
            "activeTextInputId": shared_prompt.id.clone(),
            "frameRoles": { shared_image.id.clone(): "reference" },
        });
        let generator_a = database.create_node(generator_a_input).unwrap().node;
        let mut generator_b_input =
            node_with_kind("video-generation", "Generator B", "merge-dedup-generator-b");
        generator_b_input.content = json!({
            "mediaInputOrder": [
                shared_image.id.clone(),
                exclusive_image.id.clone(),
                shared_audio.id.clone(),
                shared_video.id.clone()
            ],
            "textInputOrder": [shared_prompt.id.clone()],
            "activeTextInputId": shared_prompt.id.clone(),
            "frameRoles": {
                shared_image.id.clone(): "reference",
                exclusive_image.id.clone(): "first-frame"
            },
        });
        let generator_b = database.create_node(generator_b_input).unwrap().node;
        let preview_a = database
            .create_node(node_with_kind(
                "generated-video",
                "Preview A",
                "merge-dedup-preview-a",
            ))
            .unwrap()
            .node;
        let preview_b = database
            .create_node(node_with_kind(
                "generated-video",
                "Preview B",
                "merge-dedup-preview-b",
            ))
            .unwrap()
            .node;

        for source in [&shared_prompt, &shared_image, &shared_audio, &shared_video] {
            for target in [&generator_a, &generator_b] {
                database
                    .create_edge(CreateEdgeInput {
                        canvas_id: None,
                        source_node_id: source.id.clone(),
                        target_node_id: target.id.clone(),
                        kind: Some("input".to_owned()),
                        metadata: json!({ "sourceKind": source.kind.clone() }),
                    })
                    .unwrap();
            }
        }
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: exclusive_image.id.clone(),
                target_node_id: generator_b.id.clone(),
                kind: Some("input".to_owned()),
                metadata: json!({ "sourceKind": "image" }),
            })
            .unwrap();
        for (generator, preview) in [(&generator_a, &preview_a), (&generator_b, &preview_b)] {
            database
                .create_edge(CreateEdgeInput {
                    canvas_id: None,
                    source_node_id: generator.id.clone(),
                    target_node_id: preview.id.clone(),
                    kind: Some("output".to_owned()),
                    metadata: json!({}),
                })
                .unwrap();
        }

        let folder_a = database
            .group_related_nodes_into_folder(GroupRelatedNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                root_node_id: generator_a.id.clone(),
            })
            .unwrap();
        let folder_b = database
            .group_related_nodes_into_folder(GroupRelatedNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                root_node_id: generator_b.id.clone(),
            })
            .unwrap();
        let folder_ids = vec![
            folder_a.folder_node_id.clone(),
            folder_b.folder_node_id.clone(),
        ];
        let child_a_id = folder_a.child.canvas.id.clone();
        let child_b_id = folder_b.child.canvas.id.clone();
        drop(database);

        let database = Database::open(&path).unwrap();
        let merged = database
            .merge_folders(MergeFoldersInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                folder_node_ids: folder_ids,
            })
            .unwrap();

        assert_eq!(merged.deduplicated_input_node_count, 4);
        assert_eq!(merged.merged_node_count, 9);
        assert_eq!(merged.child.nodes.len(), 9);
        assert_eq!(merged.child.edges.len(), 11);
        for shared in [&shared_prompt, &shared_image, &shared_audio, &shared_video] {
            let targets = merged
                .child
                .edges
                .iter()
                .filter(|edge| edge.source_node_id == shared.id && edge.kind == "input")
                .map(|edge| edge.target_node_id.as_str())
                .collect::<BTreeSet<_>>();
            assert_eq!(
                targets,
                BTreeSet::from([generator_a.id.as_str(), generator_b.id.as_str()])
            );
        }
        let exclusive_targets = merged
            .child
            .edges
            .iter()
            .filter(|edge| edge.source_node_id == exclusive_image.id && edge.kind == "input")
            .map(|edge| edge.target_node_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(exclusive_targets, vec![generator_b.id.as_str()]);

        let merged_generator_a = merged
            .child
            .nodes
            .iter()
            .find(|node| node.id == generator_a.id)
            .unwrap();
        let merged_generator_b = merged
            .child
            .nodes
            .iter()
            .find(|node| node.id == generator_b.id)
            .unwrap();
        assert_eq!(
            merged_generator_a.content["mediaInputOrder"],
            json!([
                shared_image.id.clone(),
                shared_audio.id.clone(),
                shared_video.id.clone()
            ])
        );
        assert_eq!(
            merged_generator_a.content["textInputOrder"],
            json!([shared_prompt.id.clone()])
        );
        assert_eq!(
            merged_generator_b.content["mediaInputOrder"],
            json!([
                shared_image.id.clone(),
                exclusive_image.id.clone(),
                shared_audio.id.clone(),
                shared_video.id.clone()
            ])
        );
        assert_eq!(
            merged_generator_b.content["frameRoles"][&exclusive_image.id],
            json!("first-frame")
        );

        let restored_parent = database
            .undo_folder_merge(UndoFolderMergeInput { merge: merged.undo })
            .unwrap();
        assert_eq!(
            restored_parent
                .nodes
                .iter()
                .filter(|node| node.kind == "folder")
                .count(),
            2
        );
        let restored_a = database.load_project(&child_a_id).unwrap();
        let restored_b = database.load_project(&child_b_id).unwrap();
        assert_eq!(restored_a.nodes.len(), 6);
        assert_eq!(restored_a.edges.len(), 5);
        assert_eq!(restored_b.nodes.len(), 7);
        assert_eq!(restored_b.edges.len(), 6);
        let restored_generator_a = restored_a
            .nodes
            .iter()
            .find(|node| node.id == generator_a.id)
            .unwrap();
        let restored_prompt_copy_id = restored_generator_a.content["textInputOrder"][0]
            .as_str()
            .unwrap();
        assert_ne!(restored_prompt_copy_id, shared_prompt.id);
        assert!(restored_a.nodes.iter().any(|node| {
            node.id == restored_prompt_copy_id
                && node
                    .content
                    .get("folderInputCopySourceId")
                    .and_then(Value::as_str)
                    == Some(shared_prompt.id.as_str())
        }));
        let restored_generator_b = restored_b
            .nodes
            .iter()
            .find(|node| node.id == generator_b.id)
            .unwrap();
        assert_eq!(
            restored_generator_b.content["textInputOrder"],
            json!([shared_prompt.id.clone()])
        );
        assert_eq!(
            restored_generator_b.content["mediaInputOrder"],
            json!([
                shared_image.id.clone(),
                exclusive_image.id.clone(),
                shared_audio.id.clone(),
                shared_video.id.clone()
            ])
        );
        drop(database);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn keeps_all_shared_images_and_audio_connected_when_folders_are_merged() {
        let database = Database::in_memory().unwrap();
        let shared_images = (0..4)
            .map(|index| {
                database
                    .create_node(node_with_kind(
                        "image",
                        &format!("Shared image {}", index + 1),
                        &format!("merge-five-input-image-{index}"),
                    ))
                    .unwrap()
                    .node
            })
            .collect::<Vec<_>>();
        let shared_audio = database
            .create_node(node_with_kind(
                "audio",
                "Shared audio",
                "merge-five-input-audio",
            ))
            .unwrap()
            .node;
        let shared_input_ids = shared_images
            .iter()
            .map(|node| node.id.clone())
            .chain(std::iter::once(shared_audio.id.clone()))
            .collect::<Vec<_>>();

        let create_generator = |title: &str, request_id: &str| {
            let mut input = node_with_kind("video-generation", title, request_id);
            input.content = json!({ "mediaInputOrder": shared_input_ids.clone() });
            database.create_node(input).unwrap().node
        };
        let generator_a = create_generator("Generator A", "merge-five-input-generator-a");
        let generator_b = create_generator("Generator B", "merge-five-input-generator-b");
        for source in shared_images.iter().chain(std::iter::once(&shared_audio)) {
            for target in [&generator_a, &generator_b] {
                database
                    .create_edge(CreateEdgeInput {
                        canvas_id: None,
                        source_node_id: source.id.clone(),
                        target_node_id: target.id.clone(),
                        kind: Some("input".to_owned()),
                        metadata: json!({ "sourceKind": source.kind.clone() }),
                    })
                    .unwrap();
            }
        }

        let folder_a = database
            .group_related_nodes_into_folder(GroupRelatedNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                root_node_id: generator_a.id.clone(),
            })
            .unwrap();
        let folder_b = database
            .group_related_nodes_into_folder(GroupRelatedNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                root_node_id: generator_b.id.clone(),
            })
            .unwrap();
        let merged = database
            .merge_folders(MergeFoldersInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                folder_node_ids: vec![folder_a.folder_node_id, folder_b.folder_node_id],
            })
            .unwrap();

        assert_eq!(merged.deduplicated_input_node_count, 5);
        assert_eq!(merged.child.nodes.len(), 7);
        assert_eq!(merged.child.edges.len(), 10);
        for generator in [&generator_a, &generator_b] {
            let connected_input_ids = merged
                .child
                .edges
                .iter()
                .filter(|edge| edge.kind == "input" && edge.target_node_id == generator.id)
                .map(|edge| edge.source_node_id.as_str())
                .collect::<BTreeSet<_>>();
            assert_eq!(connected_input_ids.len(), 5);
            assert_eq!(
                connected_input_ids,
                shared_input_ids.iter().map(String::as_str).collect()
            );
            let merged_generator = merged
                .child
                .nodes
                .iter()
                .find(|node| node.id == generator.id)
                .unwrap();
            assert_eq!(
                merged_generator.content["mediaInputOrder"],
                json!(shared_input_ids)
            );
        }
    }

    #[test]
    fn resolves_nested_folder_copy_sources_before_deduplicating_inputs() {
        let database = Database::in_memory().unwrap();
        let kinds = ["image", "image", "image", "image", "audio"];
        let mut first_inputs = Vec::new();
        let mut second_inputs = Vec::new();
        for (index, kind) in kinds.into_iter().enumerate() {
            let mut first_input = node_with_kind(
                kind,
                &format!("First {kind} {index}"),
                &format!("nested-copy-first-{index}"),
            );
            first_input.content = json!({
                "folderInputCopySourceId": format!("missing-original-{index}")
            });
            let first = database.create_node(first_input).unwrap().node;
            let mut second_input = node_with_kind(
                kind,
                &format!("Second {kind} {index}"),
                &format!("nested-copy-second-{index}"),
            );
            second_input.content = json!({
                "folderInputCopySourceId": first.id.clone()
            });
            let second = database.create_node(second_input).unwrap().node;
            first_inputs.push(first);
            second_inputs.push(second);
        }

        let mut generator_a_input =
            node_with_kind("video-generation", "Generator A", "nested-copy-generator-a");
        generator_a_input.content = json!({
            "mediaInputOrder": first_inputs.iter().map(|node| node.id.clone()).collect::<Vec<_>>()
        });
        let generator_a = database.create_node(generator_a_input).unwrap().node;
        let mut generator_b_input =
            node_with_kind("video-generation", "Generator B", "nested-copy-generator-b");
        generator_b_input.content = json!({
            "mediaInputOrder": second_inputs.iter().map(|node| node.id.clone()).collect::<Vec<_>>()
        });
        let generator_b = database.create_node(generator_b_input).unwrap().node;

        for (inputs, generator) in [
            (&first_inputs, &generator_a),
            (&second_inputs, &generator_b),
        ] {
            for source in inputs {
                database
                    .create_edge(CreateEdgeInput {
                        canvas_id: None,
                        source_node_id: source.id.clone(),
                        target_node_id: generator.id.clone(),
                        kind: Some("input".to_owned()),
                        metadata: json!({ "sourceKind": source.kind.clone() }),
                    })
                    .unwrap();
            }
        }

        let folder_a = database
            .group_related_nodes_into_folder(GroupRelatedNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                root_node_id: generator_a.id.clone(),
            })
            .unwrap();
        let folder_b = database
            .group_related_nodes_into_folder(GroupRelatedNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                root_node_id: generator_b.id.clone(),
            })
            .unwrap();
        let merged = database
            .merge_folders(MergeFoldersInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                folder_node_ids: vec![folder_a.folder_node_id, folder_b.folder_node_id],
            })
            .unwrap();

        assert_eq!(merged.deduplicated_input_node_count, 5);
        assert_eq!(merged.child.nodes.len(), 7);
        assert_eq!(merged.child.edges.len(), 10);
        for generator in [&generator_a, &generator_b] {
            let connected_input_ids = merged
                .child
                .edges
                .iter()
                .filter(|edge| edge.kind == "input" && edge.target_node_id == generator.id)
                .map(|edge| edge.source_node_id.as_str())
                .collect::<BTreeSet<_>>();
            assert_eq!(connected_input_ids.len(), 5);
            let merged_generator = merged
                .child
                .nodes
                .iter()
                .find(|node| node.id == generator.id)
                .unwrap();
            let ordered_input_ids = merged_generator.content["mediaInputOrder"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>();
            assert_eq!(ordered_input_ids, connected_input_ids);
        }
    }

    #[test]
    fn merges_sibling_folders_and_restores_them_with_nested_content_on_undo() {
        let database = Database::in_memory().unwrap();
        let first_source = database
            .create_node(text_node("First source", "merge-first-source"))
            .unwrap()
            .node;
        let first_target = database
            .create_node(text_node("First target", "merge-first-target"))
            .unwrap()
            .node;
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: first_source.id.clone(),
                target_node_id: first_target.id.clone(),
                kind: Some("flow".to_owned()),
                metadata: json!({}),
            })
            .unwrap();
        let first_folder = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![first_source.id.clone(), first_target.id.clone()],
            })
            .unwrap();

        let mut nested_input = text_node("Nested", "merge-nested");
        nested_input.canvas_id = Some(first_folder.child.canvas.id.clone());
        let nested_node = database.create_node(nested_input).unwrap().node;
        let nested_folder = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: first_folder.child.canvas.id.clone(),
                node_ids: vec![nested_node.id.clone()],
            })
            .unwrap();

        let second_source = database
            .create_node(text_node("Second source", "merge-second-source"))
            .unwrap()
            .node;
        let second_target = database
            .create_node(text_node("Second target", "merge-second-target"))
            .unwrap()
            .node;
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: second_source.id.clone(),
                target_node_id: second_target.id.clone(),
                kind: Some("flow".to_owned()),
                metadata: json!({}),
            })
            .unwrap();
        let second_folder = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![second_source.id.clone(), second_target.id.clone()],
            })
            .unwrap();
        let parent_folder_edge = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: first_folder.folder_node_id.clone(),
                target_node_id: second_folder.folder_node_id.clone(),
                kind: Some("flow".to_owned()),
                metadata: json!({}),
            })
            .unwrap();

        let merged = database
            .merge_folders(MergeFoldersInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                folder_node_ids: vec![
                    first_folder.folder_node_id.clone(),
                    second_folder.folder_node_id.clone(),
                ],
            })
            .unwrap();

        assert_eq!(merged.source_folder_count, 2);
        assert_eq!(merged.merged_node_count, 5);
        assert_eq!(merged.parent.nodes.len(), 1);
        assert_eq!(merged.parent.nodes[0].id, merged.folder_node_id);
        assert_eq!(merged.parent.nodes[0].width, FOLDER_NODE_WIDTH);
        assert_eq!(merged.parent.nodes[0].height, FOLDER_NODE_HEIGHT);
        assert!(merged.parent.edges.is_empty());
        assert_eq!(merged.child.nodes.len(), 5);
        assert_eq!(merged.child.edges.len(), 2);
        assert!(merged
            .child
            .nodes
            .iter()
            .any(|node| node.id == nested_folder.folder_node_id));
        assert_eq!(
            database
                .load_project(&nested_folder.child.canvas.id)
                .unwrap()
                .nodes
                .len(),
            1
        );

        let merged_canvas_id = merged.child.canvas.id.clone();
        let restored = database
            .undo_folder_merge(UndoFolderMergeInput { merge: merged.undo })
            .unwrap();

        assert_eq!(restored.nodes.len(), 2);
        assert!(restored.nodes.iter().all(|node| node.kind == "folder"));
        assert_eq!(restored.edges.len(), 1);
        assert_eq!(restored.edges[0].id, parent_folder_edge.id);
        let restored_first = database
            .load_project(&first_folder.child.canvas.id)
            .unwrap();
        let restored_second = database
            .load_project(&second_folder.child.canvas.id)
            .unwrap();
        assert_eq!(restored_first.nodes.len(), 3);
        assert_eq!(restored_first.edges.len(), 1);
        assert_eq!(restored_second.nodes.len(), 2);
        assert_eq!(restored_second.edges.len(), 1);
        assert_eq!(
            database
                .load_project(&nested_folder.child.canvas.id)
                .unwrap()
                .nodes
                .len(),
            1
        );
        assert!(database.load_project(&merged_canvas_id).is_err());
    }

    #[test]
    fn cancels_or_recursively_deletes_a_folder_and_restores_both_actions() {
        let database = Database::in_memory().unwrap();
        let source = database
            .create_node(text_node("Source", "folder-action-source"))
            .unwrap()
            .node;
        let target = database
            .create_node(text_node("Target", "folder-action-target"))
            .unwrap()
            .node;
        database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: source.id.clone(),
                target_node_id: target.id.clone(),
                kind: Some("flow".to_owned()),
                metadata: json!({}),
            })
            .unwrap();
        let root_folder = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![source.id.clone(), target.id.clone()],
            })
            .unwrap();

        let mut nested_input = text_node("Nested content", "folder-action-nested");
        nested_input.canvas_id = Some(root_folder.child.canvas.id.clone());
        let nested_node = database.create_node(nested_input).unwrap().node;
        let nested_folder = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: root_folder.child.canvas.id.clone(),
                node_ids: vec![nested_node.id.clone()],
            })
            .unwrap();
        let outside = database
            .create_node(text_node("Outside", "folder-action-outside"))
            .unwrap()
            .node;
        let parent_edge = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: root_folder.folder_node_id.clone(),
                target_node_id: outside.id.clone(),
                kind: Some("flow".to_owned()),
                metadata: json!({}),
            })
            .unwrap();

        let cancelled = database
            .cancel_folder(FolderActionInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                folder_node_id: root_folder.folder_node_id.clone(),
            })
            .unwrap();
        assert_eq!(cancelled.moved_node_count, 3);
        assert_eq!(cancelled.parent.nodes.len(), 4);
        assert!(cancelled
            .parent
            .nodes
            .iter()
            .any(|node| node.id == nested_folder.folder_node_id));
        assert_eq!(cancelled.parent.edges.len(), 1);
        assert!(database.load_project(&root_folder.child.canvas.id).is_err());
        assert_eq!(
            database
                .load_project(&nested_folder.child.canvas.id)
                .unwrap()
                .nodes
                .len(),
            1
        );

        let restored_after_cancel = database
            .undo_cancel_folder(UndoCancelFolderInput {
                cancellation: cancelled.undo,
            })
            .unwrap();
        assert_eq!(restored_after_cancel.nodes.len(), 2);
        assert_eq!(restored_after_cancel.edges.len(), 1);
        assert_eq!(restored_after_cancel.edges[0].id, parent_edge.id);
        assert_eq!(
            database
                .load_project(&root_folder.child.canvas.id)
                .unwrap()
                .nodes
                .len(),
            3
        );

        let deleted = database
            .delete_folder_tree(FolderActionInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                folder_node_id: root_folder.folder_node_id.clone(),
            })
            .unwrap();
        assert_eq!(deleted.deleted_content_node_count, 4);
        assert_eq!(deleted.parent.nodes, vec![outside.clone()]);
        assert!(deleted.parent.edges.is_empty());
        assert!(database.load_project(&root_folder.child.canvas.id).is_err());
        assert!(database
            .load_project(&nested_folder.child.canvas.id)
            .is_err());

        let restored_after_delete = database
            .undo_delete_folder_tree(UndoDeleteFolderInput {
                deletion: deleted.undo,
            })
            .unwrap();
        assert_eq!(restored_after_delete.nodes.len(), 2);
        assert_eq!(restored_after_delete.edges.len(), 1);
        assert_eq!(restored_after_delete.edges[0].id, parent_edge.id);
        let restored_root_child = database.load_project(&root_folder.child.canvas.id).unwrap();
        assert_eq!(restored_root_child.nodes.len(), 3);
        assert_eq!(restored_root_child.edges.len(), 1);
        assert_eq!(
            database
                .load_project(&nested_folder.child.canvas.id)
                .unwrap()
                .nodes
                .len(),
            1
        );
    }

    #[test]
    fn cancelling_a_folder_restores_generated_video_ownership_connection() {
        let database = Database::in_memory().unwrap();
        let generator = database
            .create_node(node_with_kind(
                "video-generation",
                "Generator",
                "folder-restore-generator",
            ))
            .unwrap()
            .node;
        let mut preview_input = node_with_kind(
            "generated-video",
            "Generated preview",
            "folder-restore-preview",
        );
        preview_input.content = json!({
            "sourceGeneratorId": generator.id.clone(),
            "seed": "123",
            "comfyPromptId": "prompt-folder-restore",
            "outputIndex": 0,
        });
        let preview = database.create_node(preview_input).unwrap().node;
        let folder = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![preview.id.clone()],
            })
            .unwrap();

        let cancelled = database
            .cancel_folder(FolderActionInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                folder_node_id: folder.folder_node_id.clone(),
            })
            .unwrap();

        assert_eq!(cancelled.undo.restored_source_edges.len(), 1);
        assert_eq!(cancelled.parent.edges.len(), 1);
        let ownership_edge = &cancelled.parent.edges[0];
        assert_eq!(ownership_edge.source_node_id, generator.id);
        assert_eq!(ownership_edge.target_node_id, preview.id);
        assert_eq!(ownership_edge.kind, "output");
        assert!(matches!(
            database.delete_edge(&ownership_edge.id),
            Err(CanvasError::Conflict(_))
        ));

        let restored = database
            .undo_cancel_folder(UndoCancelFolderInput {
                cancellation: cancelled.undo,
            })
            .unwrap();
        assert_eq!(restored.nodes.len(), 2);
        assert!(restored.edges.is_empty());
        let restored_child = database.load_project(&folder.child.canvas.id).unwrap();
        assert_eq!(restored_child.nodes.len(), 1);
        assert_eq!(restored_child.nodes[0].id, preview.id);
        assert!(restored_child.edges.is_empty());
    }

    #[test]
    fn protects_generated_video_ownership_edges_from_deletion_and_folder_splitting() {
        let database = Database::in_memory().unwrap();
        let generator = database
            .create_node(node_with_kind(
                "video-generation",
                "Generator",
                "protected-generator",
            ))
            .unwrap()
            .node;
        let preview = database
            .create_node(node_with_kind(
                "generated-video",
                "Preview",
                "protected-preview",
            ))
            .unwrap()
            .node;
        let edge = database
            .create_edge(CreateEdgeInput {
                canvas_id: None,
                source_node_id: generator.id.clone(),
                target_node_id: preview.id.clone(),
                kind: Some("output".to_owned()),
                metadata: json!({}),
            })
            .unwrap();

        assert!(matches!(
            database.delete_edge(&edge.id),
            Err(CanvasError::Conflict(_))
        ));
        assert!(matches!(
            database.group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![generator.id.clone()],
            }),
            Err(CanvasError::Conflict(_))
        ));

        let unchanged = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(unchanged.nodes.len(), 2);
        assert_eq!(unchanged.edges.len(), 1);
        assert_eq!(database.list_all_projects().unwrap().len(), 1);

        let grouped = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![generator.id, preview.id],
            })
            .unwrap();
        assert_eq!(grouped.child.nodes.len(), 2);
        assert_eq!(grouped.child.edges.len(), 1);
    }

    #[test]
    fn numbers_sibling_folders_and_keeps_folder_and_child_names_in_sync() {
        let database = Database::in_memory().unwrap();
        let first_node = database
            .create_node(text_node("First", "folder-name-first"))
            .unwrap()
            .node;
        let first = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![first_node.id],
            })
            .unwrap();
        let second_node = database
            .create_node(text_node("Second", "folder-name-second"))
            .unwrap()
            .node;
        let second = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                node_ids: vec![second_node.id],
            })
            .unwrap();

        assert_eq!(first.child.canvas.name, "新建目录");
        assert_eq!(second.child.canvas.name, "新建目录 2");

        let renamed_folder = database
            .update_node(UpdateNodeInput {
                id: first.folder_node_id.clone(),
                title: Some("成片".to_owned()),
                content: None,
                x: None,
                y: None,
                width: None,
                height: None,
                status: None,
            })
            .unwrap();
        assert_eq!(renamed_folder.title, "成片");
        assert_eq!(
            database
                .load_project(&first.child.canvas.id)
                .unwrap()
                .canvas
                .name,
            "成片"
        );

        database
            .rename_project(&first.child.canvas.id, "分镜")
            .unwrap();
        let parent = database.load_project(DEFAULT_CANVAS_ID).unwrap();
        assert_eq!(
            parent
                .nodes
                .iter()
                .find(|node| node.id == first.folder_node_id)
                .unwrap()
                .title,
            "分镜"
        );

        let deduplicated = database
            .update_node(UpdateNodeInput {
                id: second.folder_node_id,
                title: Some("分镜".to_owned()),
                content: None,
                x: None,
                y: None,
                width: None,
                height: None,
                status: None,
            })
            .unwrap();
        assert_eq!(deduplicated.title, "分镜 2");
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
    fn migrates_legacy_privacy_and_folder_dimensions() {
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
                CREATE TABLE nodes (
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
                INSERT INTO canvases (id, name, created_at, updated_at)
                VALUES ('canvas:legacy', 'Legacy', '2026-01-01', '2026-01-01');
                INSERT INTO nodes (
                    id, canvas_id, kind, title, content_json, source, request_id,
                    x, y, width, height, status, created_at, updated_at
                ) VALUES (
                    'node:legacy-folder', 'canvas:legacy', 'folder', 'Legacy folder', '{}',
                    'manual', NULL, 0, 0, 280, 180, 'ready', '2026-01-01', '2026-01-01'
                );",
            )
            .unwrap();
        drop(connection);

        let database = Database::open(&path).unwrap();
        let project = database.load_project("canvas:legacy").unwrap();
        assert!(!project.canvas.is_private);
        assert_eq!(project.nodes[0].width, FOLDER_NODE_WIDTH);
        assert_eq!(project.nodes[0].height, FOLDER_NODE_HEIGHT);
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
    fn deleting_a_root_project_removes_its_nested_canvas_tree() {
        let database = Database::in_memory().unwrap();
        let project = database.create_project("Nested project").unwrap();
        let mut input = text_node("Nested source", "nested-project-source");
        input.canvas_id = Some(project.canvas.id.clone());
        let source = database.create_node(input).unwrap().node;
        let grouped = database
            .group_nodes_into_folder(GroupNodesIntoFolderInput {
                canvas_id: project.canvas.id.clone(),
                node_ids: vec![source.id],
            })
            .unwrap();

        database.delete_project(&project.canvas.id).unwrap();

        assert!(database.load_project(&project.canvas.id).is_err());
        assert!(database.load_project(&grouped.child.canvas.id).is_err());
        assert_eq!(database.list_all_projects().unwrap().len(), 1);
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
        let first_row_y = first.scenes[0].node.y;
        assert!(first
            .scenes
            .iter()
            .all(|scene| (scene.node.y - first_row_y).abs() < f64::EPSILON));
        assert!(first.scenes.windows(2).all(|pair| {
            (pair[1].node.x - pair[0].node.x - pair[0].node.width - 60.0).abs() < f64::EPSILON
        }));

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
        assert!(second
            .scenes
            .iter()
            .all(|scene| (scene.node.y - first_row_y).abs() < f64::EPSILON));
        assert!(second.scenes[0].node.x > first.scenes[4].node.x + first.scenes[4].node.width);
        assert!(second.scenes.windows(2).all(|pair| {
            (pair[1].node.x - pair[0].node.x - pair[0].node.width - 60.0).abs() < f64::EPSILON
        }));
        let recovered = database.get_prompt_set_scenes("prompt-set-001").unwrap();
        assert_eq!(recovered.prompt_set.scene_count, 10);
        assert_eq!(recovered.scenes.len(), 10);
        assert!(recovered
            .scenes
            .iter()
            .all(|scene| (scene.y - first_row_y).abs() < f64::EPSILON));
        assert_eq!(database.list_prompt_sets().unwrap().len(), 1);
    }

    #[test]
    fn persists_prompt_scene_generation_duration() {
        let database = Database::in_memory().unwrap();
        let mut scene = prompt_scene("S01");
        scene.generation_options = Some(crate::models::PromptGenerationOptions {
            duration_seconds: 12,
        });
        let created = database
            .create_missing_prompt_scenes(
                "prompt-set-duration",
                DEFAULT_CANVAS_ID,
                CreateMissingPromptScenesInput {
                    canvas_id: None,
                    prompt_set_title: "Duration".to_owned(),
                    scenes: vec![scene],
                    source: Some("test".to_owned()),
                    request_id: Some("create-duration".to_owned()),
                },
            )
            .unwrap();
        let version = prompt_versions_from_content(&created.scenes[0].node.content)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(version.generation_options.unwrap().duration_seconds, 12);

        let appended = database
            .append_prompt_version(
                "prompt-set-duration",
                "S01",
                AppendPromptVersionInput {
                    text: "Updated English prompt".to_owned(),
                    information: "更新后的中文解释".to_owned(),
                    reference_selection: None,
                    generation_options: Some(crate::models::PromptGenerationOptions {
                        duration_seconds: 15,
                    }),
                    title: None,
                    source: Some("test".to_owned()),
                    request_id: "append-duration".to_owned(),
                    expected_version_count: Some(1),
                },
            )
            .unwrap();
        assert_eq!(
            appended
                .version
                .generation_options
                .unwrap()
                .duration_seconds,
            15
        );
    }

    #[test]
    fn stores_reference_selection_separately_from_prompt_information() {
        let database = Database::in_memory().unwrap();
        let reference_selection = json!({
            "sceneKey": "S01",
            "assets": [
                {
                    "sourceId": "image-node-1",
                    "kind": "image",
                    "label": "Picture 1",
                    "role": "main character"
                }
            ]
        });
        let mut scene = prompt_scene("S01");
        scene.reference_selection = Some(reference_selection.clone());

        let created = database
            .create_missing_prompt_scenes(
                "prompt-set-reference-selection",
                DEFAULT_CANVAS_ID,
                CreateMissingPromptScenesInput {
                    canvas_id: None,
                    prompt_set_title: "素材选择测试".to_owned(),
                    scenes: vec![scene],
                    source: Some("test".to_owned()),
                    request_id: Some("create-reference-selection".to_owned()),
                },
            )
            .unwrap();

        let content = &created.scenes[0].node.content;
        assert_eq!(content["information"], json!("S01 的中文解释"));
        assert_eq!(content["referenceSelection"], reference_selection);
        assert_eq!(
            content["promptVersions"][0]["referenceSelection"],
            content["referenceSelection"]
        );
        assert!(!content["information"]
            .as_str()
            .unwrap()
            .contains("referenceSelection"));
    }

    #[test]
    fn extracts_legacy_reference_data_without_leaving_it_in_information() {
        let information = concat!(
            "这是给用户查看的中文说明。\n\n",
            "[[INFINITE_CANVAS_H3_REFERENCE_MANIFEST_V1]]\n",
            "{\"schema\":\"infinite-canvas-h3-reference/v1\",\"sceneKey\":\"S02\",",
            "\"assets\":[{\"sourceId\":\"image-node-3\",\"kind\":\"image\",",
            "\"label\":\"Picture 1\",\"role\":\"location\"}]}\n",
            "[[/INFINITE_CANVAS_H3_REFERENCE_MANIFEST_V1]]"
        );

        let (cleaned, selection) = legacy_storyboard_reference_selection(information).unwrap();

        assert_eq!(cleaned, "这是给用户查看的中文说明。");
        assert_eq!(selection["sceneKey"], json!("S02"));
        assert!(selection.get("schema").is_none());
    }

    #[test]
    fn lists_prompt_sets_for_one_canvas_only() {
        let database = Database::in_memory().unwrap();
        database
            .create_missing_prompt_scenes(
                "default-canvas-prompt-set",
                DEFAULT_CANVAS_ID,
                prompt_scene_batch("default-canvas-scenes", &["S01"]),
            )
            .unwrap();
        let second_canvas = database.create_project("Second canvas").unwrap().canvas;
        database
            .create_missing_prompt_scenes(
                "second-canvas-prompt-set",
                &second_canvas.id,
                prompt_scene_batch("second-canvas-scenes", &["S01"]),
            )
            .unwrap();

        let prompt_sets = database
            .list_prompt_sets_for_canvas(&second_canvas.id)
            .unwrap();

        assert_eq!(prompt_sets.len(), 1);
        assert_eq!(prompt_sets[0].prompt_set_id, "second-canvas-prompt-set");
        assert_eq!(prompt_sets[0].canvas_id, second_canvas.id);
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
            reference_selection: None,
            generation_options: None,
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
                    reference_selection: None,
                    generation_options: None,
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
                    reference_selection: None,
                    generation_options: None,
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
