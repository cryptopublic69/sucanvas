// Whole-canvas operations for the Web (CANVAS-012c2): admin delete, canvas
// settings (owner and sharing) and copying a readable canvas into the caller's
// own canvases. Each runs
// in one IMMEDIATE transaction on the ownership connection with foreign keys
// on, so the change and its audit row land together or not at all.
use super::ownership::{
    insert_audit, normalize_tree, owner_of, root_of, Actor, CanvasOwner, Ownership,
    ROOT_DEPTH_LIMIT,
};
use super::users::{Role, UserRecord};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

const OWNERLESS: &str = "(无主)";

// Pushed to each affected user after a project was deleted, moved or its
// sharing changed (CANVAS-012c3): payload {canvasId, reason}.
pub const ACCESS_EVENT: &str = "canvas://access-changed";

// Who may read a project: its owner, everyone when shared, admins always.
#[derive(Clone, Copy, Debug)]
pub struct Readers<'a> {
    pub owner: Option<&'a str>,
    pub shared: bool,
}

impl Readers<'_> {
    fn reads(&self, user: &UserRecord) -> bool {
        user.role == Role::Admin || self.shared || self.owner == Some(user.id.as_str())
    }
}

// Users to tell about a change, with the reason: "deleted" / "revoked" for
// those who could read the project and no longer can (an open view must
// close), "changed" for those who still or newly can (lists refresh).
// Users who could not read it before and cannot now hear nothing about it;
// disabled accounts have no sessions and are skipped.
pub fn access_changes(
    before: Readers<'_>,
    after: Option<Readers<'_>>,
    users: &[UserRecord],
) -> Vec<(String, &'static str)> {
    users
        .iter()
        .filter(|user| !user.disabled)
        .filter_map(|user| {
            let could = before.reads(user);
            let can = after.is_some_and(|after| after.reads(user));
            let reason = match (could, can, after.is_some()) {
                (true, false, false) => "deleted",
                (true, false, true) => "revoked",
                (_, true, _) => "changed",
                (false, false, _) => return None,
            };
            Some((user.id.clone(), reason))
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedCanvas {
    pub id: String,
    pub name: String,
    pub owner_username: Option<String>,
}

fn error(error: impl ToString) -> String {
    error.to_string()
}

fn begin(connection: &mut Connection) -> Result<Transaction<'_>, String> {
    connection
        .execute_batch("PRAGMA foreign_keys = ON")
        .map_err(error)?;
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)
}

struct RootInfo {
    name: String,
    owner_id: Option<String>,
    owner_username: Option<String>,
    is_shared: bool,
}

fn root_info(connection: &Connection, root_id: &str) -> Result<RootInfo, String> {
    connection
        .query_row(
            "SELECT canvases.name, canvases.owner_user_id, users.username, canvases.is_shared
             FROM canvases LEFT JOIN users ON users.id = canvases.owner_user_id
             WHERE canvases.id = ?1",
            [root_id],
            |row| {
                Ok(RootInfo {
                    name: row.get(0)?,
                    owner_id: row.get(1)?,
                    owner_username: row.get(2)?,
                    is_shared: row.get::<_, i64>(3)? != 0,
                })
            },
        )
        .optional()
        .map_err(error)?
        .ok_or_else(|| "画布不存在".to_owned())
}

// Delete and owner change act on a whole project: folders follow their root.
fn project_root(connection: &Connection, canvas_id: &str) -> Result<String, String> {
    let root = root_of(connection, canvas_id)?.ok_or_else(|| "画布不存在".to_owned())?;
    if root != canvas_id {
        return Err("只能对整个画布项目执行此操作".to_owned());
    }
    Ok(root)
}

// Admin delete of any project, other users' private ones included, without
// edit mode (architect, 012c2 item 1). Only canvas records go: unlike the
// desktop delete_project this does not touch media files (left to c4).
pub fn admin_delete(
    store: &Ownership,
    actor: &Actor<'_>,
    canvas_id: &str,
) -> Result<DeletedCanvas, String> {
    let mut connection = store.connection();
    let transaction = begin(&mut connection)?;
    let root = project_root(&transaction, canvas_id)?;
    let info = root_info(&transaction, &root)?;
    crate::db::delete_canvas_tree(&transaction, &root).map_err(error)?;
    let command = format!(
        "admin_delete_project name={} owner={}",
        info.name,
        info.owner_username.as_deref().unwrap_or(OWNERLESS)
    );
    insert_audit(
        &transaction,
        actor.id,
        actor.username,
        &root,
        info.owner_id.as_deref(),
        &command,
    )?;
    transaction.commit().map_err(error)?;
    Ok(DeletedCanvas {
        id: root,
        name: info.name,
        owner_username: info.owner_username,
    })
}

fn visibility(shared: bool) -> &'static str {
    if shared {
        "shared"
    } else {
        "private"
    }
}

// Admin "画布设置" (012c2 rework): sharing and/or owner of a project (with its
// folders) in one transaction, each change audited in that transaction.
// Sharing is applied first, so a refused owner change (unknown or disabled
// account) rolls it back too. Values equal to the current ones change nothing
// and write no audit row.
pub fn update_settings(
    store: &Ownership,
    actor: &Actor<'_>,
    canvas_id: &str,
    owner_user_id: Option<&str>,
    shared: Option<bool>,
) -> Result<CanvasOwner, String> {
    if owner_user_id.is_none() && shared.is_none() {
        return Err("没有要修改的画布设置".to_owned());
    }
    let mut connection = store.connection();
    let transaction = begin(&mut connection)?;
    let root = project_root(&transaction, canvas_id)?;
    let info = root_info(&transaction, &root)?;
    let audit = |command: String| {
        insert_audit(
            &transaction,
            actor.id,
            actor.username,
            &root,
            info.owner_id.as_deref(),
            &command,
        )
    };
    if let Some(shared) = shared.filter(|shared| *shared != info.is_shared) {
        transaction
            .execute(
                "UPDATE canvases SET is_shared = ?2 WHERE id = ?1",
                params![root, shared as i64],
            )
            .map_err(error)?;
        audit(format!(
            "set_canvas_sharing name={} from={} to={}",
            info.name,
            visibility(info.is_shared),
            visibility(shared)
        ))?;
    }
    if let Some(user_id) =
        owner_user_id.filter(|user_id| info.owner_id.as_deref() != Some(*user_id))
    {
        let target: Option<(String, bool)> = transaction
            .query_row(
                "SELECT username, disabled FROM users WHERE id = ?1",
                [user_id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(error)?;
        let Some((target_username, disabled)) = target else {
            return Err("用户不存在".to_owned());
        };
        if disabled {
            return Err("画布只能转给启用的用户".to_owned());
        }
        transaction
            .execute(
                "UPDATE canvases SET owner_user_id = ?2 WHERE id = ?1",
                params![root, user_id],
            )
            .map_err(error)?;
        audit(format!(
            "set_canvas_owner name={} from={} to={target_username}",
            info.name,
            info.owner_username.as_deref().unwrap_or(OWNERLESS)
        ))?;
    }
    normalize_tree(&transaction, &root)?;
    let owner = owner_of(&transaction, &root)?.ok_or_else(|| "画布不存在".to_owned())?;
    transaction.commit().map_err(error)?;
    Ok(owner)
}

// Unfinished generations (running / queued / cancelling) cannot continue in a
// copy: the copy's node is marked cancelled and loses its task references;
// the node itself and any finished result stay.
const UNFINISHED: &[&str] = &["running", "pending", "queued", "cancelling", "submitting"];
fn cancel_unfinished(content: &mut Value) {
    let Some(map) = content.as_object_mut() else {
        return;
    };
    let unfinished = map
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| UNFINISHED.contains(&status));
    if !unfinished {
        return;
    }
    map.insert("status".to_owned(), Value::String("cancelled".to_owned()));
    map.insert("executionProgress".to_owned(), Value::Null);
    map.insert(
        "validationMessage".to_owned(),
        Value::String("复制画布时任务尚未完成，副本中已取消".to_owned()),
    );
    for key in ["placeholderClientId", "comfyPromptId"] {
        map.remove(key);
    }
}

// Ids inside node content and edge metadata (childCanvasId, promptNodeId, ...)
// are rewritten wherever a string equals a copied canvas, node or edge id;
// prompt set ids only under "promptSetId". Media paths are left untouched, so
// the copy references the same files.
fn remap(
    value: &mut Value,
    ids: &HashMap<String, String>,
    prompt_sets: &mut HashMap<String, String>,
) {
    match value {
        Value::String(text) => {
            if let Some(new) = ids.get(text.as_str()) {
                *text = new.clone();
            }
        }
        Value::Array(items) => {
            for item in items {
                remap(item, ids, prompt_sets);
            }
        }
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                match item {
                    Value::String(text) if key == "promptSetId" && !text.is_empty() => {
                        *text = prompt_set(prompt_sets, text);
                    }
                    _ => remap(item, ids, prompt_sets),
                }
            }
        }
        _ => {}
    }
}

fn prompt_set(prompt_sets: &mut HashMap<String, String>, old: &str) -> String {
    prompt_sets
        .entry(old.to_owned())
        .or_insert_with(|| Uuid::new_v4().to_string())
        .clone()
}

fn remapped_json(
    text: &str,
    ids: &HashMap<String, String>,
    prompt_sets: &mut HashMap<String, String>,
    node_content: bool,
) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(text).map_err(error)?;
    remap(&mut value, ids, prompt_sets);
    if node_content {
        cancel_unfinished(&mut value);
    }
    serde_json::to_string(&value).map_err(error)
}

fn mapped<'a>(ids: &'a HashMap<String, String>, id: &str) -> Result<&'a str, String> {
    ids.get(id)
        .map(String::as_str)
        .ok_or_else(|| format!("画布数据不一致，找不到 {id}"))
}

struct NodeRow {
    id: String,
    canvas_id: String,
    kind: String,
    title: String,
    content: String,
    source: String,
    geometry: (f64, f64, f64, f64),
    status: String,
}

struct EdgeRow {
    id: String,
    canvas_id: String,
    source: String,
    target: String,
    kind: String,
    metadata: String,
}

// Copies a project (whole folder tree) into `owner_user_id`'s private
// canvases. Whoever may read the project may copy it (the caller checks
// CanvasRead on the root, 012c2 rework). Returns the new root canvas id; the
// source is not modified.
pub fn copy_project(
    store: &Ownership,
    owner_user_id: &str,
    canvas_id: &str,
) -> Result<String, String> {
    let mut connection = store.connection();
    let transaction = begin(&mut connection)?;
    let root = root_of(&transaction, canvas_id)?.ok_or_else(|| "画布不存在".to_owned())?;
    // Parent canvases first, so folder links always find both ends.
    let tree: Vec<String> = {
        let mut statement = transaction
            .prepare(
                "WITH RECURSIVE tree(id, depth) AS (
                     SELECT ?1, 0
                     UNION
                     SELECT canvas_folders.child_canvas_id, tree.depth + 1 FROM tree
                     JOIN nodes ON nodes.canvas_id = tree.id
                     JOIN canvas_folders ON canvas_folders.folder_node_id = nodes.id
                     WHERE tree.depth < ?2
                 )
                 SELECT id FROM tree GROUP BY id ORDER BY MIN(depth)",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![root, ROOT_DEPTH_LIMIT as i64], |row| row.get(0))
            .map_err(error)?;
        rows.collect::<Result<_, _>>().map_err(error)?
    };
    let mut ids: HashMap<String, String> = tree
        .iter()
        .map(|id| (id.clone(), format!("canvas:{}", Uuid::new_v4())))
        .collect();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut folders = Vec::new();
    let mut bindings = Vec::new();
    for canvas in &tree {
        let mut statement = transaction
            .prepare(
                "SELECT id, canvas_id, kind, title, content_json, source, x, y, width, height, status
                 FROM nodes WHERE canvas_id = ?1 ORDER BY created_at, id",
            )
            .map_err(error)?;
        let rows = statement
            .query_map([canvas], |row| {
                Ok(NodeRow {
                    id: row.get(0)?,
                    canvas_id: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    content: row.get(4)?,
                    source: row.get(5)?,
                    geometry: (row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?),
                    status: row.get(10)?,
                })
            })
            .map_err(error)?;
        nodes.extend(rows.collect::<Result<Vec<_>, _>>().map_err(error)?);
        let mut statement = transaction
            .prepare(
                "SELECT id, canvas_id, source_node_id, target_node_id, kind, metadata_json
                 FROM edges WHERE canvas_id = ?1 ORDER BY created_at, id",
            )
            .map_err(error)?;
        let rows = statement
            .query_map([canvas], |row| {
                Ok(EdgeRow {
                    id: row.get(0)?,
                    canvas_id: row.get(1)?,
                    source: row.get(2)?,
                    target: row.get(3)?,
                    kind: row.get(4)?,
                    metadata: row.get(5)?,
                })
            })
            .map_err(error)?;
        edges.extend(rows.collect::<Result<Vec<_>, _>>().map_err(error)?);
        let mut statement = transaction
            .prepare(
                "SELECT canvas_folders.folder_node_id, canvas_folders.child_canvas_id
                 FROM canvas_folders JOIN nodes ON nodes.id = canvas_folders.folder_node_id
                 WHERE nodes.canvas_id = ?1",
            )
            .map_err(error)?;
        let rows = statement
            .query_map([canvas], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?;
        folders.extend(rows.collect::<Result<Vec<_>, _>>().map_err(error)?);
        let mut statement = transaction
            .prepare(
                "SELECT prompt_set_id, prompt_set_title, scene_key, scene_title, node_id
                 FROM prompt_scene_bindings WHERE canvas_id = ?1",
            )
            .map_err(error)?;
        let rows = statement
            .query_map([canvas], |row| {
                Ok((
                    canvas.clone(),
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(error)?;
        bindings.extend(rows.collect::<Result<Vec<_>, _>>().map_err(error)?);
    }
    for node in &nodes {
        ids.insert(node.id.clone(), format!("node:{}", Uuid::new_v4()));
    }
    for edge in &edges {
        ids.insert(edge.id.clone(), format!("edge:{}", Uuid::new_v4()));
    }
    let mut prompt_sets = HashMap::new();
    let now = chrono::Utc::now().to_rfc3339();
    for canvas in &tree {
        let (name, is_private, preview): (String, i64, Option<String>) = transaction
            .query_row(
                "SELECT name, is_private, preview_image_path FROM canvases WHERE id = ?1",
                [canvas],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(error)?;
        let name = if *canvas == root {
            format!("{name} 副本")
        } else {
            name
        };
        transaction
            .execute(
                "INSERT INTO canvases (id, name, is_private, preview_image_path, created_at, updated_at, is_shared, owner_user_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, ?6)",
                params![mapped(&ids, canvas)?, name, is_private, preview, now, owner_user_id],
            )
            .map_err(error)?;
    }
    for node in &nodes {
        let (x, y, width, height) = node.geometry;
        // request_id is unique per generation request and stays with the source.
        transaction
            .execute(
                "INSERT INTO nodes (id, canvas_id, kind, title, content_json, source, request_id, x, y, width, height, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    mapped(&ids, &node.id)?,
                    mapped(&ids, &node.canvas_id)?,
                    node.kind,
                    node.title,
                    remapped_json(&node.content, &ids, &mut prompt_sets, true)?,
                    node.source,
                    x,
                    y,
                    width,
                    height,
                    node.status,
                    now
                ],
            )
            .map_err(error)?;
    }
    for edge in &edges {
        transaction
            .execute(
                "INSERT INTO edges (id, canvas_id, source_node_id, target_node_id, kind, metadata_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    mapped(&ids, &edge.id)?,
                    mapped(&ids, &edge.canvas_id)?,
                    mapped(&ids, &edge.source)?,
                    mapped(&ids, &edge.target)?,
                    edge.kind,
                    remapped_json(&edge.metadata, &ids, &mut prompt_sets, false)?,
                    now
                ],
            )
            .map_err(error)?;
    }
    for (folder_node, child_canvas) in &folders {
        transaction
            .execute(
                "INSERT INTO canvas_folders (folder_node_id, child_canvas_id, created_at) VALUES (?1, ?2, ?3)",
                params![mapped(&ids, folder_node)?, mapped(&ids, child_canvas)?, now],
            )
            .map_err(error)?;
    }
    for (canvas, prompt_set_id, prompt_set_title, scene_key, scene_title, node) in &bindings {
        transaction
            .execute(
                "INSERT INTO prompt_scene_bindings (prompt_set_id, prompt_set_title, canvas_id, scene_key, scene_title, node_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    prompt_set(&mut prompt_sets, prompt_set_id),
                    prompt_set_title,
                    mapped(&ids, canvas)?,
                    scene_key,
                    scene_title,
                    mapped(&ids, node)?,
                    now
                ],
            )
            .map_err(error)?;
    }
    let new_root = mapped(&ids, &root)?.to_owned();
    normalize_tree(&transaction, &new_root)?;
    transaction.commit().map_err(error)?;
    Ok(new_root)
}

#[cfg(test)]
mod tests {
    use super::super::auth::Permission;
    use super::super::authz::{
        check,
        tests::{world, World},
        Denied,
    };
    use super::*;
    use serde_json::json;

    fn admin(world: &World) -> Actor<'_> {
        Actor {
            id: &world.admin.user_id,
            username: "admin",
        }
    }
    fn db(world: &World) -> Connection {
        Connection::open(world.fixture.database()).unwrap()
    }
    fn count(world: &World, sql: &str, id: &str) -> i64 {
        db(world).query_row(sql, [id], |row| row.get(0)).unwrap()
    }
    fn audit(world: &World) -> Vec<(String, Option<String>, String)> {
        let connection = db(world);
        let mut statement = connection
            .prepare("SELECT canvas_id, canvas_owner_user_id, command FROM audit_log ORDER BY id")
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    #[test]
    fn access_change_events_reach_exactly_the_users_whose_access_changed() {
        let account = |id: &str, role: Role, disabled: bool| UserRecord {
            id: id.to_owned(),
            username: id.to_owned(),
            display_name: None,
            role,
            disabled,
            must_change_password: false,
            created_at: String::new(),
            updated_at: String::new(),
            password_changed_at: None,
        };
        let users = [
            account("admin", Role::Admin, false),
            account("alice", Role::User, false),
            account("bob", Role::User, false),
            account("carol", Role::User, true),
        ];
        let private = |owner| Readers {
            owner: Some(owner),
            shared: false,
        };
        let shared = |owner| Readers {
            owner: Some(owner),
            shared: true,
        };
        let changes = |before, after| access_changes(before, after, &users);
        let pairs = |list: &[(&str, &'static str)]| -> Vec<(String, &'static str)> {
            list.iter()
                .map(|(user, reason)| (user.to_string(), *reason))
                .collect()
        };
        // Deleting alice's private canvas: bob never saw it and hears nothing.
        assert_eq!(
            changes(private("alice"), None),
            pairs(&[("admin", "deleted"), ("alice", "deleted")])
        );
        assert_eq!(
            changes(shared("alice"), None),
            pairs(&[
                ("admin", "deleted"),
                ("alice", "deleted"),
                ("bob", "deleted")
            ])
        );
        // Moving it to bob: alice loses it, bob gains it.
        assert_eq!(
            changes(private("alice"), Some(private("bob"))),
            pairs(&[
                ("admin", "changed"),
                ("alice", "revoked"),
                ("bob", "changed")
            ])
        );
        // Private -> shared: everyone may read it now; shared -> private: bob loses it.
        assert_eq!(
            changes(private("alice"), Some(shared("alice"))),
            pairs(&[
                ("admin", "changed"),
                ("alice", "changed"),
                ("bob", "changed")
            ])
        );
        assert_eq!(
            changes(shared("alice"), Some(private("alice"))),
            pairs(&[
                ("admin", "changed"),
                ("alice", "changed"),
                ("bob", "revoked")
            ])
        );
    }

    #[test]
    fn admins_delete_other_users_private_projects_without_edit_mode_and_audit_it() {
        let world = world();
        let alices = world.project(&world.alice, false);
        let child = world.folder(&alices);
        // Regular users are refused the admin category; admins need no edit mode.
        assert!(matches!(
            check(world.store(), &world.alice, &Permission::Admin),
            Err(Denied::Forbidden(_))
        ));
        assert!(world.admin.admin_edit_until.is_none());
        assert!(check(world.store(), &world.admin, &Permission::Admin).is_ok());
        // A folder canvas is not a project; nothing is deleted.
        assert_eq!(
            admin_delete(world.store(), &admin(&world), &child).unwrap_err(),
            "只能对整个画布项目执行此操作"
        );
        assert!(admin_delete(world.store(), &admin(&world), "canvas:missing").is_err());
        assert!(audit(&world).is_empty());
        let deleted = admin_delete(world.store(), &admin(&world), &alices).unwrap();
        assert_eq!(deleted.owner_username.as_deref(), Some("alice"));
        for canvas in [&alices, &child] {
            assert_eq!(
                count(
                    &world,
                    "SELECT COUNT(*) FROM canvases WHERE id = ?1",
                    canvas
                ),
                0
            );
            assert_eq!(
                count(
                    &world,
                    "SELECT COUNT(*) FROM nodes WHERE canvas_id = ?1",
                    canvas
                ),
                0
            );
        }
        assert_eq!(
            audit(&world),
            vec![(
                alices.clone(),
                Some(world.alice.user_id.clone()),
                "admin_delete_project name=project owner=alice".to_owned()
            )]
        );
    }

    #[test]
    fn canvas_settings_change_owner_and_sharing_in_one_audited_transaction() {
        let world = world();
        let alices = world.project(&world.alice, false);
        let child = world.folder(&alices);
        let shared = world.project(&world.alice, true);
        let settings = |id: &str, owner: Option<&str>, shared: Option<bool>| {
            update_settings(world.store(), &admin(&world), id, owner, shared)
        };
        world
            .auth
            .users()
            .set_disabled(&world.bob.user_id, true)
            .unwrap();
        assert_eq!(
            settings(&alices, Some(&world.bob.user_id), None).unwrap_err(),
            "画布只能转给启用的用户"
        );
        // Both at once, the owner part refused: the sharing part is rolled back too.
        assert_eq!(
            settings(&alices, Some(&world.bob.user_id), Some(true)).unwrap_err(),
            "画布只能转给启用的用户"
        );
        assert!(settings(&alices, Some("nobody"), Some(true)).is_err());
        assert_eq!(
            world.columns(&alices),
            (Some(world.alice.user_id.clone()), 0)
        );
        assert_eq!(
            world.columns(&child),
            (Some(world.alice.user_id.clone()), 0)
        );
        assert!(settings(&child, Some(&world.alice.user_id), None).is_err());
        assert!(settings(&alices, None, None).is_err());
        assert!(audit(&world).is_empty());
        world
            .auth
            .users()
            .set_disabled(&world.bob.user_id, false)
            .unwrap();
        let owner = settings(&alices, Some(&world.bob.user_id), Some(true)).unwrap();
        assert_eq!(
            owner.owner_user_id.as_deref(),
            Some(world.bob.user_id.as_str())
        );
        assert!(owner.is_shared);
        let bob = Some(world.bob.user_id.clone());
        assert_eq!(world.columns(&alices), (bob.clone(), 1));
        assert_eq!(world.columns(&child), (bob.clone(), 1));
        // Owner only: sharing unchanged. Same values again: nothing written.
        settings(&shared, Some(&world.bob.user_id), None).unwrap();
        assert_eq!(world.columns(&shared), (bob, 1));
        settings(&shared, Some(&world.bob.user_id), Some(true)).unwrap();
        let rows: Vec<String> = audit(&world).into_iter().map(|row| row.2).collect();
        assert_eq!(
            rows,
            [
                "set_canvas_sharing name=project from=private to=shared",
                "set_canvas_owner name=project from=alice to=bob",
                "set_canvas_owner name=project from=alice to=bob",
            ]
        );
        assert_eq!(
            audit(&world)[0].1.as_deref(),
            Some(world.alice.user_id.as_str())
        );
    }

    #[test]
    fn copying_a_readable_project_gives_the_caller_a_private_copy_with_new_ids() {
        let world = world();
        let bobs = world.project(&world.bob, true);
        let child = world.folder(&bobs);
        let first = world.node(&bobs).id;
        let second = world.node(&bobs).id;
        world
            .db
            .create_edge(
                serde_json::from_value(json!({"canvasId": bobs, "sourceNodeId": first, "targetNodeId": second, "metadata": {"from": first}}))
                    .unwrap(),
            )
            .unwrap();
        // `first` is still generating; `second` has a finished result.
        let content = json!({"assetPath": "sucanvas-output://2026-10-19/clip.mp4", "promptNodeId": second, "promptSetId": "set-1",
            "status": "running", "executionProgress": 0.4, "placeholderClientId": "client-1", "comfyPromptId": "prompt-1"});
        let finished =
            json!({"status": "succeeded", "comfyPromptId": "prompt-2", "videoUrl": "result.mp4"});
        let connection = db(&world);
        for (node, content) in [(&first, content), (&second, finished)] {
            connection
                .execute(
                    "UPDATE nodes SET content_json = ?2 WHERE id = ?1",
                    params![node, content.to_string()],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO prompt_scene_bindings (prompt_set_id, prompt_set_title, canvas_id, scene_key, scene_title, node_id, created_at, updated_at)
                 VALUES ('set-1', 'T', ?1, 's1', 'S', ?2, 'now', 'now')",
                params![bobs, first],
            )
            .unwrap();
        let source_ids: Vec<String> = {
            let mut statement = connection
                .prepare(
                    "SELECT id FROM nodes UNION SELECT id FROM edges UNION SELECT id FROM canvases",
                )
                .unwrap();
            let rows = statement.query_map([], |row| row.get(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        let source_nodes = count(
            &world,
            "SELECT COUNT(*) FROM nodes WHERE canvas_id IN (?1)",
            &bobs,
        ) + count(
            &world,
            "SELECT COUNT(*) FROM nodes WHERE canvas_id = ?1",
            &child,
        );

        // Copying needs read access to the root: bob cannot read alice's private
        // canvas (so the command never runs for him); alice copies her own.
        let alices = world.project(&world.alice, false);
        assert!(matches!(
            check(
                world.store(),
                &world.bob,
                &Permission::CanvasRead(alices.clone())
            ),
            Err(Denied::NotFound)
        ));
        let own = copy_project(world.store(), &world.alice.user_id, &alices).unwrap();
        assert_eq!(world.columns(&own), (Some(world.alice.user_id.clone()), 0));

        let copy = copy_project(world.store(), &world.alice.user_id, &bobs).unwrap();
        let alice = Some(world.alice.user_id.clone());
        assert_eq!(world.columns(&copy), (alice.clone(), 0));
        let name: String = connection
            .query_row("SELECT name FROM canvases WHERE id = ?1", [&copy], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "project 副本");
        let copied_child: String = connection
            .query_row(
                "SELECT canvas_folders.child_canvas_id FROM canvas_folders JOIN nodes ON nodes.id = canvas_folders.folder_node_id WHERE nodes.canvas_id = ?1",
                [&copy],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(copied_child, child);
        assert_eq!(world.columns(&copied_child), (alice, 0));
        assert_eq!(
            count(
                &world,
                "SELECT COUNT(*) FROM nodes WHERE canvas_id = ?1",
                &copy
            ) + count(
                &world,
                "SELECT COUNT(*) FROM nodes WHERE canvas_id = ?1",
                &copied_child
            ),
            source_nodes
        );
        assert_eq!(
            count(
                &world,
                "SELECT COUNT(*) FROM edges WHERE canvas_id = ?1",
                &copy
            ),
            1
        );
        // No copied record points back at the source: every id was remapped.
        let mut texts: Vec<String> = Vec::new();
        for sql in [
            "SELECT content_json FROM nodes WHERE canvas_id IN (?1, ?2)",
            "SELECT metadata_json FROM edges WHERE canvas_id IN (?1, ?2)",
            "SELECT node_id || ' ' || prompt_set_id FROM prompt_scene_bindings WHERE canvas_id IN (?1, ?2)",
        ] {
            let mut statement = connection.prepare(sql).unwrap();
            let rows = statement
                .query_map(params![copy, copied_child], |row| row.get::<_, String>(0))
                .unwrap();
            texts.extend(rows.map(Result::unwrap));
        }
        for id in &source_ids {
            for text in &texts {
                assert!(!text.contains(id.as_str()), "{id} still in {text}");
            }
        }
        // Media references are identical; the prompt set got a new id in both places.
        let (copied_content, binding_set): (String, String) = connection
            .query_row(
                "SELECT nodes.content_json, prompt_scene_bindings.prompt_set_id FROM nodes
                 JOIN prompt_scene_bindings ON prompt_scene_bindings.node_id = nodes.id WHERE nodes.canvas_id = ?1",
                [&copy],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let copied_content: Value = serde_json::from_str(&copied_content).unwrap();
        assert_eq!(
            copied_content["assetPath"],
            "sucanvas-output://2026-10-19/clip.mp4"
        );
        assert_eq!(copied_content["promptSetId"], binding_set.as_str());
        assert_ne!(binding_set, "set-1");
        // The unfinished generation is cancelled in the copy, without task references.
        assert_eq!(copied_content["status"], "cancelled");
        assert_eq!(copied_content["executionProgress"], Value::Null);
        assert!(copied_content.get("placeholderClientId").is_none());
        assert!(copied_content.get("comfyPromptId").is_none());
        // A finished result keeps its status and prompt id (preview versioning).
        let finished: Value = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT content_json FROM nodes WHERE canvas_id = ?1 AND content_json LIKE '%result.mp4%'",
                    [&copy],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(finished["status"], "succeeded");
        assert_eq!(finished["comfyPromptId"], "prompt-2");
        // The source is unchanged (its generation is still running).
        let source: String = connection
            .query_row(
                "SELECT content_json FROM nodes WHERE id = ?1",
                [&first],
                |row| row.get(0),
            )
            .unwrap();
        assert!(source.contains("\"running\"") && source.contains("client-1"));
        assert_eq!(world.columns(&bobs), (Some(world.bob.user_id.clone()), 1));
        assert_eq!(
            count(
                &world,
                "SELECT COUNT(*) FROM nodes WHERE canvas_id = ?1",
                &bobs
            ) + count(
                &world,
                "SELECT COUNT(*) FROM nodes WHERE canvas_id = ?1",
                &child
            ),
            source_nodes
        );
        assert_eq!(
            count(
                &world,
                "SELECT COUNT(*) FROM prompt_scene_bindings WHERE prompt_set_id = ?1",
                "set-1"
            ),
            1
        );
    }
}
