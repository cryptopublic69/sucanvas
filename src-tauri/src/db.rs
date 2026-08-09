use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use thiserror::Error;
use uuid::Uuid;

use crate::models::{
    CanvasRecord, CreateEdgeInput, CreateNodeInput, CreateNodeResult, DeletedBatch, EdgeRecord,
    NodeRecord, UpdateNodeInput, WorkspaceSnapshot, DEFAULT_CANVAS_ID,
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
        validate_node(&node)?;
        node.updated_at = now();
        let content_json = serde_json::to_string(&node.content)?;

        connection.execute(
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
        touch_canvas(&connection, &node.canvas_id)?;
        Ok(node)
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
            canvas_ids.insert(node.canvas_id.clone());
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
        let new_assets = Path::new(r"D:\Data\SuCanvasData\data\assets");
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
}
