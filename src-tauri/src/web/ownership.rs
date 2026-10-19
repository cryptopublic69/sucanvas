// Canvas ownership for the Web. The columns live on `canvases`, but only the
// server migration adds them; desktop databases never get them.
//
// Fail-closed: a root canvas is private to `owner_user_id` unless `is_shared`
// is 1. A root without an owner that is not shared is visible to admins only,
// so a write path that forgets ownership (shared db.rs code, an older program
// after a rollback) hides the canvas instead of publishing it. Access is always
// decided by the root canvas; child canvases copy the root's values for
// consistency only.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    sync::Mutex,
};

// Folder nesting deeper than this is treated as corrupt (and stops cycles).
pub const ROOT_DEPTH_LIMIT: usize = 64;

const TRIGGERS: &str = "
CREATE TRIGGER IF NOT EXISTS canvas_folders_inherit_ownership
AFTER INSERT ON canvas_folders
BEGIN
    UPDATE canvases SET
        owner_user_id = (SELECT parent.owner_user_id FROM nodes JOIN canvases AS parent ON parent.id = nodes.canvas_id WHERE nodes.id = NEW.folder_node_id),
        is_shared = COALESCE((SELECT parent.is_shared FROM nodes JOIN canvases AS parent ON parent.id = nodes.canvas_id WHERE nodes.id = NEW.folder_node_id), 0)
    WHERE id = NEW.child_canvas_id;
END;
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    canvas_id TEXT NOT NULL,
    canvas_owner_user_id TEXT,
    command TEXT NOT NULL
);
";

pub(super) fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
        .map_err(|e| e.to_string())
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let mut rows = statement.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if row.get::<_, String>(1).map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

// Runs inside the account migration transaction. The first run (when the
// owner column is added) makes every existing canvas the admin's private canvas.
pub(super) fn migrate(connection: &Connection, admin_id: &str) -> Result<(), String> {
    if !table_exists(connection, "canvases")? {
        return Ok(());
    }
    if !has_column(connection, "canvases", "is_shared")? {
        connection
            .execute_batch("ALTER TABLE canvases ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0")
            .map_err(|e| e.to_string())?;
    }
    if !has_column(connection, "canvases", "owner_user_id")? {
        connection
            .execute_batch(
                "ALTER TABLE canvases ADD COLUMN owner_user_id TEXT REFERENCES users(id)",
            )
            .map_err(|e| e.to_string())?;
        connection
            .execute(
                "UPDATE canvases SET owner_user_id = ?1, is_shared = 0",
                [admin_id],
            )
            .map_err(|e| e.to_string())?;
    }
    connection
        .execute_batch(TRIGGERS)
        .map_err(|e| e.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanvasOwner {
    pub root_id: String,
    pub owner_user_id: Option<String>,
    pub is_shared: bool,
}

pub(super) fn root_of(connection: &Connection, canvas_id: &str) -> Result<Option<String>, String> {
    let exists = connection
        .query_row("SELECT 1 FROM canvases WHERE id = ?1", [canvas_id], |_| {
            Ok(())
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Ok(None);
    }
    let mut current = canvas_id.to_owned();
    let mut seen = HashSet::from([current.clone()]);
    for _ in 0..ROOT_DEPTH_LIMIT {
        let parent: Option<String> = connection
            .query_row(
                "SELECT nodes.canvas_id FROM canvas_folders JOIN nodes ON nodes.id = canvas_folders.folder_node_id
                 WHERE canvas_folders.child_canvas_id = ?1",
                [&current],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match parent {
            None => return Ok(Some(current)),
            Some(parent) if !seen.insert(parent.clone()) => return Err("画布层级成环".to_owned()),
            Some(parent) => current = parent,
        }
    }
    Err("画布层级过深".to_owned())
}

pub(super) fn owner_of(
    connection: &Connection,
    canvas_id: &str,
) -> Result<Option<CanvasOwner>, String> {
    let Some(root_id) = root_of(connection, canvas_id)? else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT owner_user_id, is_shared FROM canvases WHERE id = ?1",
            [&root_id],
            |row| {
                Ok(CanvasOwner {
                    root_id: root_id.clone(),
                    owner_user_id: row.get(0)?,
                    is_shared: row.get::<_, i64>(1)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

// Children copy the root's owner and sharing; covers subtrees re-created by
// undo, where the insert trigger only sees one level at a time.
pub(super) fn normalize_tree(connection: &Connection, root_id: &str) -> Result<(), String> {
    connection
        .execute(
            "WITH RECURSIVE tree(id, depth) AS (
                 SELECT ?1, 0
                 UNION
                 SELECT canvas_folders.child_canvas_id, tree.depth + 1 FROM tree
                 JOIN nodes ON nodes.canvas_id = tree.id
                 JOIN canvas_folders ON canvas_folders.folder_node_id = nodes.id
                 WHERE tree.depth < ?2
             )
             UPDATE canvases SET
                 owner_user_id = (SELECT owner_user_id FROM canvases WHERE id = ?1),
                 is_shared = (SELECT is_shared FROM canvases WHERE id = ?1)
             WHERE id IN (SELECT id FROM tree) AND id <> ?1",
            params![root_id, ROOT_DEPTH_LIMIT as i64],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub(super) fn insert_audit(
    connection: &Connection,
    user_id: &str,
    username: &str,
    canvas_id: &str,
    canvas_owner_user_id: Option<&str>,
    command: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO audit_log (created_at, user_id, username, canvas_id, canvas_owner_user_id, command)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                chrono::Utc::now().to_rfc3339(),
                user_id,
                username,
                canvas_id,
                canvas_owner_user_id,
                command
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// The admin doing an account change (012c1).
pub struct Actor<'a> {
    pub id: &'a str,
    pub username: &'a str,
}

// Account changes (create, reset, disable/enable, role, display name) are
// audited inside the caller's transaction. Only usernames and the action are
// written, never passwords or the new display name. audit_log.canvas_id is
// NOT NULL (012b-1 schema) and these rows concern no canvas, so they use ''
// instead of rebuilding the table. Without audit_log (a database the canvas
// migration never ran on, e.g. account-only test fixtures) nothing is written.
pub(super) fn audit_account(
    connection: &Connection,
    actor: &Actor<'_>,
    command: &str,
) -> Result<(), String> {
    if !table_exists(connection, "audit_log")? {
        return Ok(());
    }
    insert_audit(connection, actor.id, actor.username, "", None, command)
}

pub(super) struct UserDeletion<'a> {
    pub actor_id: &'a str,
    pub actor_username: &'a str,
    pub user_id: &'a str,
    pub username: &'a str,
    pub target_id: &'a str,
    pub target_username: &'a str,
}

// Deleting a user (012c1), inside the deletion transaction: every canvas they
// own, private or shared, moves to the target with its sharing unchanged. The
// audit log gets one row per moved root plus one for the deletion itself, with
// usernames as text so the rows outlive the account. The deletion row has
// canvas_id '' because audit_log.canvas_id is NOT NULL and the table is not
// rebuilt for it (architect, 012c1 review).
// Returns the moved root canvases.
pub(super) fn transfer_on_delete(
    connection: &Connection,
    deletion: &UserDeletion<'_>,
) -> Result<Vec<String>, String> {
    if !table_exists(connection, "canvases")? {
        return Ok(Vec::new());
    }
    let roots = {
        let mut statement = connection
            .prepare(
                "SELECT id FROM canvases WHERE owner_user_id = ?1
                 AND id NOT IN (SELECT child_canvas_id FROM canvas_folders) ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([deletion.user_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    connection
        .execute(
            "UPDATE canvases SET owner_user_id = ?2 WHERE owner_user_id = ?1",
            params![deletion.user_id, deletion.target_id],
        )
        .map_err(|e| e.to_string())?;
    let detail = format!(
        "username={} transfer_to={}",
        deletion.username, deletion.target_username
    );
    for root in &roots {
        normalize_tree(connection, root)?;
        insert_audit(
            connection,
            deletion.actor_id,
            deletion.actor_username,
            root,
            Some(deletion.user_id),
            &format!("delete_user:transfer {detail}"),
        )?;
    }
    insert_audit(
        connection,
        deletion.actor_id,
        deletion.actor_username,
        "",
        Some(deletion.user_id),
        &format!("delete_user {detail} canvases={}", roots.len()),
    )?;
    Ok(roots)
}

// Who started which generation, per ComfyUI client id. Stored (c5 item 2) so
// the starter can still cancel after a server restart; beyond the limit the
// oldest entries are dropped one by one instead of forgetting everyone.
// Web-only table: desktop databases never get it.
const TASK_OWNER_LIMIT: usize = 20_000;
const TASK_OWNERS: &str = "CREATE TABLE IF NOT EXISTS web_task_owners (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
)";

pub struct Ownership {
    connection: Mutex<Connection>,
}

impl Ownership {
    pub fn open(database: &Path) -> Result<Self, String> {
        let connection = Connection::open(database).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch(TASK_OWNERS)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    // The ownership connection, for whole-tree operations that must run in
    // one transaction (web/canvases.rs: admin delete, owner change, copy).
    pub(super) fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection.lock().unwrap()
    }

    // Records who started a generation. A client id already claimed by
    // another user is refused (false), so nobody can take over someone else's task.
    pub fn remember_task(&self, client_id: &str, user_id: &str) -> Result<bool, String> {
        self.remember_task_within(client_id, user_id, TASK_OWNER_LIMIT)
    }
    fn remember_task_within(
        &self,
        client_id: &str,
        user_id: &str,
        limit: usize,
    ) -> Result<bool, String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let owner: Option<String> = transaction
            .query_row(
                "SELECT user_id FROM web_task_owners WHERE client_id = ?1",
                [client_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(owner) = owner {
            return Ok(owner == user_id);
        }
        // Keep the newest limit - 1, then add this one.
        transaction
            .execute(
                "DELETE FROM web_task_owners WHERE seq IN
                 (SELECT seq FROM web_task_owners ORDER BY seq DESC LIMIT -1 OFFSET ?1)",
                [limit.saturating_sub(1) as i64],
            )
            .map_err(|e| e.to_string())?;
        transaction
            .execute(
                "INSERT INTO web_task_owners (client_id, user_id, created_at) VALUES (?1, ?2, ?3)",
                params![client_id, user_id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }
    // None also when the lookup fails: cancelling is then refused (fail-closed).
    pub fn task_owner(&self, client_id: &str) -> Option<String> {
        self.connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT user_id FROM web_task_owners WHERE client_id = ?1",
                [client_id],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    // Owner and sharing of the root above `canvas_id`; None when the canvas does not exist.
    pub fn owner(&self, canvas_id: &str) -> Result<Option<CanvasOwner>, String> {
        owner_of(&self.connection.lock().unwrap(), canvas_id)
    }

    fn lookup(&self, sql: &str, id: &str) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .unwrap()
            .query_row(sql, [id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn node_canvas(&self, node_id: &str) -> Result<Option<String>, String> {
        self.lookup("SELECT canvas_id FROM nodes WHERE id = ?1", node_id)
    }
    pub fn edge_canvas(&self, edge_id: &str) -> Result<Option<String>, String> {
        self.lookup("SELECT canvas_id FROM edges WHERE id = ?1", edge_id)
    }

    // A project created through the Web: owner and sharing are written right
    // after the shared db.rs insert. Until then the canvas is ownerless and
    // therefore admin-only, never public.
    pub fn assign(&self, canvas_id: &str, owner_user_id: &str, shared: bool) -> Result<(), String> {
        let connection = self.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE canvases SET owner_user_id = ?2, is_shared = ?3 WHERE id = ?1",
                params![canvas_id, owner_user_id, shared as i64],
            )
            .map_err(|e| e.to_string())?;
        normalize_tree(&connection, canvas_id)
    }

    // Private <-> shared, applied to the whole tree. Returns the root.
    // Tests only: the Web goes through canvases::update_settings (audited).
    #[cfg(test)]
    pub fn set_shared(&self, canvas_id: &str, shared: bool) -> Result<Option<CanvasOwner>, String> {
        let connection = self.connection.lock().unwrap();
        let Some(root_id) = root_of(&connection, canvas_id)? else {
            return Ok(None);
        };
        connection
            .execute(
                "UPDATE canvases SET is_shared = ?2 WHERE id = ?1",
                params![root_id, shared as i64],
            )
            .map_err(|e| e.to_string())?;
        normalize_tree(&connection, &root_id)?;
        owner_of(&connection, &root_id)
    }

    pub fn normalize(&self, root_id: &str) -> Result<(), String> {
        normalize_tree(&self.connection.lock().unwrap(), root_id)
    }

    // Adds the root's owner to every `canvas` record in a snapshot or a list
    // of snapshots, so the Web can group projects without a second request.
    pub fn annotate(&self, value: &mut Value) -> Result<(), String> {
        let connection = self.connection.lock().unwrap();
        let mut cache: BTreeMap<String, Value> = BTreeMap::new();
        let canvases: Vec<&mut serde_json::Map<String, Value>> =
            if let Some(items) = value.as_array_mut() {
                items
                    .iter_mut()
                    .filter_map(|item| item.get_mut("canvas").and_then(Value::as_object_mut))
                    .collect()
            } else {
                value
                    .get_mut("canvas")
                    .and_then(Value::as_object_mut)
                    .into_iter()
                    .collect()
            };
        for canvas in canvases {
            let Some(id) = canvas.get("id").and_then(Value::as_str).map(str::to_owned) else {
                continue;
            };
            if !cache.contains_key(&id) {
                let info = match owner_of(&connection, &id)? {
                    Some(owner) => {
                        let user = match owner.owner_user_id.as_deref() {
                            Some(user_id) => connection
                                .query_row(
                                    "SELECT username, display_name FROM users WHERE id = ?1",
                                    [user_id],
                                    |row| {
                                        Ok((
                                            row.get::<_, String>(0)?,
                                            row.get::<_, Option<String>>(1)?,
                                        ))
                                    },
                                )
                                .optional()
                                .map_err(|e| e.to_string())?,
                            None => None,
                        };
                        serde_json::json!({
                            "rootCanvasId": owner.root_id,
                            "ownerUserId": owner.owner_user_id,
                            "ownerUsername": user.as_ref().map(|user| user.0.clone()),
                            "ownerDisplayName": user.and_then(|user| user.1),
                            "isShared": owner.is_shared,
                        })
                    }
                    None => Value::Null,
                };
                cache.insert(id.clone(), info);
            }
            if let Some(Value::Object(info)) = cache.get(&id) {
                for (key, field) in info {
                    canvas.insert(key.clone(), field.clone());
                }
            }
        }
        Ok(())
    }

    pub fn audit(
        &self,
        user_id: &str,
        username: &str,
        canvas: &CanvasOwner,
        command: &str,
    ) -> Result<(), String> {
        insert_audit(
            &self.connection.lock().unwrap(),
            user_id,
            username,
            &canvas.root_id,
            canvas.owner_user_id.as_deref(),
            command,
        )
    }

    // Root canvases a regular user may list (SQL layer): their own and shared ones.
    pub fn list_condition(actor_user_id: &str) -> (&'static str, Vec<String>) {
        (
            "(canvases.owner_user_id = ?1 OR canvases.is_shared = 1)",
            vec![actor_user_id.to_owned()],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::users::tests::Fixture;
    use super::*;

    // c5 item 2: the starter of a generation is still known after a restart
    // (a new Ownership on the same database), and nobody else can claim it.
    #[test]
    fn task_owners_survive_a_restart() {
        let fixture = Fixture::new();
        let before = Ownership::open(&fixture.database()).unwrap();
        assert!(before.remember_task("client-1", "alice").unwrap());
        drop(before);
        let after = Ownership::open(&fixture.database()).unwrap();
        assert_eq!(after.task_owner("client-1").as_deref(), Some("alice"));
        assert!(!after.remember_task("client-1", "bob").unwrap());
        assert!(after.remember_task("client-1", "alice").unwrap());
        assert_eq!(after.task_owner("client-unknown"), None);
    }

    // At the limit only the oldest entry goes; the old code forgot everyone.
    #[test]
    fn a_full_task_table_drops_only_the_oldest() {
        let fixture = Fixture::new();
        let ownership = Ownership::open(&fixture.database()).unwrap();
        for n in 1..=3 {
            assert!(ownership
                .remember_task_within(&format!("client-{n}"), "alice", 3)
                .unwrap());
        }
        assert!(ownership
            .remember_task_within("client-4", "bob", 3)
            .unwrap());
        assert_eq!(ownership.task_owner("client-1"), None);
        for (client, owner) in [
            ("client-2", "alice"),
            ("client-3", "alice"),
            ("client-4", "bob"),
        ] {
            assert_eq!(
                ownership.task_owner(client).as_deref(),
                Some(owner),
                "{client}"
            );
        }
        // A known id is answered without evicting anything.
        assert!(ownership
            .remember_task_within("client-2", "alice", 3)
            .unwrap());
        assert_eq!(ownership.task_owner("client-3").as_deref(), Some("alice"));
        let rows: i64 = ownership
            .connection()
            .query_row("SELECT COUNT(*) FROM web_task_owners", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 3);
    }
}
