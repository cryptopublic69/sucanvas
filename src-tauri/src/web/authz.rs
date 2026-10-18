// Permission categories and the single check every Web operation goes
// through (design §4/§5). Access to canvas content is decided by the root
// canvas: its owner, its sharing flag and the actor's role.
use super::{
    auth::Session,
    ownership::{CanvasOwner, Ownership},
    users::Role,
};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeScope {
    // Every node sits directly on the named canvas (grouping, folder actions).
    SameCanvas,
    // Every node sits somewhere in the named canvas's tree (preview image, resize source).
    SameTree,
}

// Ids found in a client-supplied undo/restore payload. `anchor` is the canvas
// the payload writes to; every other id that exists must belong to the same
// root tree. Ids that do not exist yet are created inside that tree by the
// command (or fail its foreign keys), so they cannot reach another tree.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecordRefs {
    pub anchor: String,
    pub canvases: Vec<String>,
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Permission {
    // Global resources: workflow modules, settings, backups, user management.
    Admin,
    // Any signed-in user: listing (filtered in SQL), ComfyUI, generated files (rule 4).
    Authenticated,
    // Not offered on the Web (application lock commands).
    Unavailable,
    CanvasRead(String),
    CanvasWrite(String),
    CanvasDelete(String),
    // Write access to the tree holding these nodes; all of them in one tree.
    Nodes {
        canvas: Option<String>,
        nodes: Vec<String>,
        scope: NodeScope,
    },
    EdgeWrite(String),
    Records(RecordRefs),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Read,
    Write,
    Delete,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Denied {
    // Someone else's private canvas looks exactly like a missing one.
    NotFound,
    Forbidden(String),
    EditModeRequired,
    Unavailable,
    Invalid(String),
    Internal(String),
}

impl IntoResponse for Denied {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Denied::NotFound => (
                StatusCode::NOT_FOUND,
                json!({"error": "画布不存在", "code": "not_found"}),
            ),
            Denied::Forbidden(error) => (
                StatusCode::FORBIDDEN,
                json!({"error": error, "code": "forbidden"}),
            ),
            Denied::EditModeRequired => (
                StatusCode::FORBIDDEN,
                json!({"error": "这是其他用户的私有画布，请先开启编辑模式", "code": "edit_mode_required"}),
            ),
            Denied::Unavailable => (
                StatusCode::FORBIDDEN,
                json!({"error": "Web 版已改为用户登录，请在用户菜单中修改密码。", "code": "app_lock_unavailable"}),
            ),
            Denied::Invalid(error) => (StatusCode::BAD_REQUEST, json!({"error": error})),
            Denied::Internal(error) => (StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
        };
        (status, Json(body)).into_response()
    }
}

// What a successful check allows: admin writes on other users' private
// canvases (for the audit log) and every root that may be written to.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Grant {
    pub audit: Vec<CanvasOwner>,
    pub written_roots: Vec<String>,
}

impl Grant {
    fn add(&mut self, owner: &CanvasOwner, level: Level, audited: bool) {
        if audited && !self.audit.contains(owner) {
            self.audit.push(owner.clone());
        }
        if level != Level::Read && !self.written_roots.contains(&owner.root_id) {
            self.written_roots.push(owner.root_id.clone());
        }
    }
}

pub fn edit_mode_active(session: &Session) -> bool {
    session
        .admin_edit_until
        .is_some_and(|until| until > Instant::now())
}

// The permission matrix. Ok(true) means "allowed, and must be audited".
pub fn canvas_level(session: &Session, owner: &CanvasOwner, level: Level) -> Result<bool, Denied> {
    let mine = owner.owner_user_id.as_deref() == Some(session.user_id.as_str());
    if session.role == Role::Admin {
        // Ownerless roots (owner unset, not shared) are the admin's to manage.
        let others_private = !mine && !owner.is_shared && owner.owner_user_id.is_some();
        return match level {
            _ if !others_private => Ok(false),
            Level::Read => Ok(false),
            _ if edit_mode_active(session) => Ok(true),
            _ => Err(Denied::EditModeRequired),
        };
    }
    // Shared canvases: everyone edits, only admins delete (rule 2), including
    // the user who created them.
    if owner.is_shared {
        match level {
            Level::Delete => Err(Denied::Forbidden("共享画布只有管理员可以删除".to_owned())),
            _ => Ok(false),
        }
    } else if mine {
        Ok(false)
    } else {
        Err(Denied::NotFound)
    }
}

fn owner(store: &Ownership, canvas_id: &str) -> Result<CanvasOwner, Denied> {
    store
        .owner(canvas_id)
        .map_err(Denied::Internal)?
        .ok_or(Denied::NotFound)
}

fn canvas(
    store: &Ownership,
    session: &Session,
    canvas_id: &str,
    level: Level,
    grant: &mut Grant,
) -> Result<CanvasOwner, Denied> {
    let owner = owner(store, canvas_id)?;
    let audited = canvas_level(session, &owner, level)?;
    grant.add(&owner, level, audited);
    Ok(owner)
}

pub fn may_read(store: &Ownership, session: &Session, canvas_id: &str) -> bool {
    match store.owner(canvas_id) {
        Ok(Some(owner)) => canvas_level(session, &owner, Level::Read).is_ok(),
        // A canvas that is gone (or unreadable) only reaches admins.
        _ => session.role == Role::Admin,
    }
}

pub fn check(
    store: &Ownership,
    session: &Session,
    permission: &Permission,
) -> Result<Grant, Denied> {
    let mut grant = Grant::default();
    match permission {
        Permission::Authenticated => {}
        Permission::Admin if session.role == Role::Admin => {}
        Permission::Admin => {
            return Err(Denied::Forbidden("只有管理员可以执行此操作".to_owned()));
        }
        Permission::Unavailable => return Err(Denied::Unavailable),
        Permission::CanvasRead(id) => {
            canvas(store, session, id, Level::Read, &mut grant)?;
        }
        Permission::CanvasWrite(id) => {
            canvas(store, session, id, Level::Write, &mut grant)?;
        }
        Permission::CanvasDelete(id) => {
            canvas(store, session, id, Level::Delete, &mut grant)?;
        }
        Permission::EdgeWrite(id) => {
            let canvas_id = store
                .edge_canvas(id)
                .map_err(Denied::Internal)?
                .ok_or(Denied::NotFound)?;
            canvas(store, session, &canvas_id, Level::Write, &mut grant)?;
        }
        Permission::Nodes {
            canvas: target,
            nodes,
            scope,
        } => {
            if target.is_none() && nodes.is_empty() {
                return Err(Denied::Invalid("缺少要操作的节点".to_owned()));
            }
            let mut root: Option<String> = None;
            if let Some(target) = target {
                root = Some(canvas(store, session, target, Level::Write, &mut grant)?.root_id);
            }
            for node in nodes {
                let node_canvas = store
                    .node_canvas(node)
                    .map_err(Denied::Internal)?
                    .ok_or(Denied::NotFound)?;
                if *scope == NodeScope::SameCanvas
                    && target
                        .as_deref()
                        .is_some_and(|target| target != node_canvas)
                {
                    return Err(Denied::NotFound);
                }
                let owner = canvas(store, session, &node_canvas, Level::Write, &mut grant)?;
                match &root {
                    Some(root) if *root != owner.root_id => return Err(Denied::NotFound),
                    Some(_) => {}
                    None => root = Some(owner.root_id),
                }
            }
        }
        Permission::Records(refs) => {
            let root = canvas(store, session, &refs.anchor, Level::Write, &mut grant)?.root_id;
            // Any id that exists must already live in the anchor's tree; one
            // mismatch rejects the whole payload.
            let belongs = |canvas_id: Option<String>| -> Result<(), Denied> {
                match canvas_id {
                    None => Ok(()),
                    Some(canvas_id) => match store.owner(&canvas_id).map_err(Denied::Internal)? {
                        Some(owner) if owner.root_id == root => Ok(()),
                        Some(_) => Err(Denied::NotFound),
                        None => Ok(()),
                    },
                }
            };
            for id in &refs.canvases {
                belongs(Some(id.clone()))?;
            }
            for id in &refs.nodes {
                belongs(store.node_canvas(id).map_err(Denied::Internal)?)?;
            }
            for id in &refs.edges {
                belongs(store.edge_canvas(id).map_err(Denied::Internal)?)?;
            }
        }
    }
    Ok(grant)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::{
        auth::{write_password, Auth, Session},
        dispatch,
        ownership::Ownership,
        users::{self, tests::Fixture, Role},
    };
    use super::*;
    use crate::db::Database;
    use serde_json::{json, Value};
    use std::time::Duration;

    pub(crate) struct World {
        pub fixture: Fixture,
        pub db: Database,
        pub auth: Auth,
        pub admin: Session,
        pub alice: Session,
        pub bob: Session,
    }

    pub(crate) fn session(user_id: &str, role: Role) -> Session {
        Session {
            user_id: user_id.to_owned(),
            role,
            must_change_password: false,
            expires_at: Instant::now() + Duration::from_secs(3600),
            admin_edit_until: None,
        }
    }

    // An existing deployment: canvases first, then the account/ownership migration.
    pub(crate) fn world() -> World {
        let fixture = Fixture::new();
        write_password(&fixture.app_lock(), "管理员密码").unwrap();
        let db = Database::open(&fixture.database()).unwrap();
        users::migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        let auth = Auth::open(&fixture.database()).unwrap();
        let admin_id = auth.users().by_username("admin").unwrap().unwrap().user.id;
        let alice = auth
            .users()
            .create("alice", None, Role::User, "hash")
            .unwrap();
        let bob = auth
            .users()
            .create("bob", None, Role::User, "hash")
            .unwrap();
        World {
            admin: session(&admin_id, Role::Admin),
            alice: session(&alice.id, Role::User),
            bob: session(&bob.id, Role::User),
            fixture,
            db,
            auth,
        }
    }

    impl World {
        pub(crate) fn store(&self) -> &Ownership {
            self.auth.ownership()
        }
        pub(crate) fn project(&self, owner: &Session, shared: bool) -> String {
            let id = self.db.create_project("project").unwrap().canvas.id;
            self.store().assign(&id, &owner.user_id, shared).unwrap();
            id
        }
        pub(crate) fn node(&self, canvas: &str) -> crate::models::NodeRecord {
            self.db
                .create_node(
                    serde_json::from_value(
                        json!({"canvasId": canvas, "kind": "text", "title": "n"}),
                    )
                    .unwrap(),
                )
                .unwrap()
                .node
        }
        fn check(&self, session: &Session, permission: Permission) -> Result<Grant, Denied> {
            check(self.store(), session, &permission)
        }
        // Child canvas created by grouping two nodes into a folder (shared db.rs code).
        fn folder(&self, canvas: &str) -> String {
            let first = self.node(canvas).id;
            let second = self.node(canvas).id;
            self.db
                .group_nodes_into_folder(
                    serde_json::from_value(json!({"canvasId": canvas, "nodeIds": [first, second]}))
                        .unwrap(),
                )
                .unwrap();
            rusqlite::Connection::open(self.fixture.database())
                .unwrap()
                .query_row(
                    "SELECT canvas_folders.child_canvas_id FROM canvas_folders JOIN nodes ON nodes.id = canvas_folders.folder_node_id WHERE nodes.canvas_id = ?1",
                    [canvas],
                    |row| row.get(0),
                )
                .unwrap()
        }
        fn columns(&self, canvas: &str) -> (Option<String>, i64) {
            rusqlite::Connection::open(self.fixture.database())
                .unwrap()
                .query_row(
                    "SELECT owner_user_id, is_shared FROM canvases WHERE id = ?1",
                    [canvas],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap()
        }
    }

    #[test]
    fn regular_users_cannot_see_or_touch_other_users_private_canvases() {
        let world = world();
        let bobs = world.project(&world.bob, false);
        for permission in [
            Permission::CanvasRead(bobs.clone()),
            Permission::CanvasWrite(bobs.clone()),
            Permission::CanvasDelete(bobs.clone()),
        ] {
            assert_eq!(world.check(&world.alice, permission), Err(Denied::NotFound));
        }
        // A missing canvas answers exactly the same.
        assert_eq!(
            world.check(
                &world.alice,
                Permission::CanvasRead("canvas:missing".into())
            ),
            Err(Denied::NotFound)
        );
        assert!(world
            .check(&world.bob, Permission::CanvasDelete(bobs))
            .is_ok());
    }

    #[test]
    fn shared_canvases_are_editable_by_everyone_but_deletable_by_admins_only() {
        let world = world();
        let shared = world.project(&world.bob, true);
        assert!(world
            .check(&world.alice, Permission::CanvasRead(shared.clone()))
            .is_ok());
        assert!(world
            .check(&world.alice, Permission::CanvasWrite(shared.clone()))
            .is_ok());
        for user in [&world.alice, &world.bob] {
            assert!(matches!(
                world.check(user, Permission::CanvasDelete(shared.clone())),
                Err(Denied::Forbidden(_))
            ));
        }
        assert!(world
            .check(&world.admin, Permission::CanvasDelete(shared))
            .is_ok());
    }

    #[test]
    fn regular_users_cannot_use_admin_commands_or_global_writes() {
        let world = world();
        assert!(matches!(
            world.check(&world.alice, Permission::Admin),
            Err(Denied::Forbidden(_))
        ));
        assert_eq!(
            world.check(&world.alice, Permission::Unavailable),
            Err(Denied::Unavailable)
        );
        assert_eq!(
            world.check(&world.admin, Permission::Unavailable),
            Err(Denied::Unavailable)
        );
        assert!(world.check(&world.admin, Permission::Admin).is_ok());
    }

    #[test]
    fn admins_need_edit_mode_for_other_users_private_canvases_and_get_audited() {
        let world = world();
        let alices = world.project(&world.alice, false);
        let mut admin = world.admin.clone();
        assert_eq!(
            world
                .check(&admin, Permission::CanvasRead(alices.clone()))
                .unwrap(),
            Grant::default()
        );
        assert_eq!(
            world.check(&admin, Permission::CanvasWrite(alices.clone())),
            Err(Denied::EditModeRequired)
        );
        admin.admin_edit_until = Some(Instant::now() + Duration::from_secs(60));
        let grant = world
            .check(&admin, Permission::CanvasWrite(alices.clone()))
            .unwrap();
        assert_eq!(grant.audit.len(), 1);
        assert_eq!(
            grant.audit[0].owner_user_id.as_deref(),
            Some(world.alice.user_id.as_str())
        );
        world
            .store()
            .audit(&admin.user_id, "admin", &grant.audit[0], "update_node")
            .unwrap();
        let logged: (String, String, String) = rusqlite::Connection::open(world.fixture.database())
            .unwrap()
            .query_row(
                "SELECT user_id, canvas_id, command FROM audit_log",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            logged,
            (admin.user_id.clone(), alices.clone(), "update_node".into())
        );
        // Edit mode expires (30 minutes after it was switched on).
        admin.admin_edit_until = Some(Instant::now() - Duration::from_secs(1));
        assert_eq!(
            world.check(&admin, Permission::CanvasDelete(alices)),
            Err(Denied::EditModeRequired)
        );
        // Own and shared canvases need no edit mode and are not audited.
        let shared = world.project(&world.alice, true);
        assert_eq!(
            world
                .check(&world.admin, Permission::CanvasWrite(shared))
                .unwrap()
                .audit,
            vec![]
        );
    }

    #[test]
    fn canvases_created_around_the_web_layer_stay_admin_only() {
        let world = world();
        // Straight through shared db.rs code: no owner, not shared.
        let orphan = world.db.create_project("bypass").unwrap().canvas.id;
        assert_eq!(world.columns(&orphan), (None, 0));
        assert_eq!(
            world.check(&world.alice, Permission::CanvasRead(orphan.clone())),
            Err(Denied::NotFound)
        );
        assert!(world
            .check(&world.admin, Permission::CanvasWrite(orphan.clone()))
            .unwrap()
            .audit
            .is_empty());
        let (condition, parameters) = Ownership::list_condition(&world.alice.user_id);
        let listed = world
            .db
            .list_projects_where(condition, &parameters, true)
            .unwrap();
        assert!(listed.iter().all(|project| project.canvas.id != orphan));
    }

    #[test]
    fn lists_contain_only_own_and_shared_root_canvases() {
        let world = world();
        let own = world.project(&world.alice, false);
        let shared = world.project(&world.bob, true);
        let bobs = world.project(&world.bob, false);
        world.folder(&own);
        let (condition, parameters) = Ownership::list_condition(&world.alice.user_id);
        let mut ids = world
            .db
            .list_projects_where(condition, &parameters, false)
            .unwrap()
            .into_iter()
            .map(|project| project.canvas.id)
            .collect::<Vec<_>>();
        ids.sort();
        let mut expected = vec![own, shared];
        expected.sort();
        assert_eq!(ids, expected);
        let all = world.db.list_project_summaries().unwrap();
        assert!(all.iter().any(|project| project.canvas.id == bobs));
    }

    #[test]
    fn migration_gives_existing_canvases_to_admin_once_and_children_follow_their_root() {
        let world = world();
        // DEFAULT canvas existed before the migration.
        let default = crate::models::DEFAULT_CANVAS_ID;
        assert_eq!(
            world.columns(default),
            (Some(world.admin.user_id.clone()), 0)
        );
        world.store().set_shared(default, true).unwrap();
        users::migrate(&world.fixture.database(), &world.fixture.app_lock()).unwrap();
        assert_eq!(
            world.columns(default),
            (Some(world.admin.user_id.clone()), 1)
        );
        // A folder created by db.rs inherits the root's owner through the trigger.
        let alices = world.project(&world.alice, false);
        let child = world.folder(&alices);
        assert_eq!(
            world.columns(&child),
            (Some(world.alice.user_id.clone()), 0)
        );
        let grandchild = world.folder(&child);
        assert_eq!(
            world.columns(&grandchild),
            (Some(world.alice.user_id.clone()), 0)
        );
        assert_eq!(
            world.store().owner(&grandchild).unwrap().unwrap().root_id,
            alices
        );
        // Sharing applies to the whole tree; access is decided by the root anyway.
        world.store().set_shared(&grandchild, true).unwrap();
        assert_eq!(world.columns(&grandchild).1, 1);
        assert_eq!(world.columns(&alices).1, 1);
        assert!(world
            .check(&world.bob, Permission::CanvasWrite(grandchild))
            .is_ok());
    }

    #[test]
    fn node_and_edge_commands_resolve_their_canvas_first() {
        let world = world();
        let alices = world.project(&world.alice, false);
        let bobs = world.project(&world.bob, false);
        let mine = world.node(&alices);
        let theirs = world.node(&bobs);
        let nodes = |nodes: Vec<String>| Permission::Nodes {
            canvas: None,
            nodes,
            scope: NodeScope::SameTree,
        };
        assert!(world
            .check(&world.alice, nodes(vec![mine.id.clone()]))
            .is_ok());
        assert_eq!(
            world.check(&world.alice, nodes(vec![theirs.id.clone()])),
            Err(Denied::NotFound)
        );
        // Mixing trees is refused even for an admin in edit mode.
        let mut admin = world.admin.clone();
        admin.admin_edit_until = Some(Instant::now() + Duration::from_secs(60));
        assert_eq!(
            world.check(&admin, nodes(vec![mine.id.clone(), theirs.id.clone()])),
            Err(Denied::NotFound)
        );
        // Grouping on my canvas with a node from elsewhere.
        assert_eq!(
            world.check(
                &world.alice,
                Permission::Nodes {
                    canvas: Some(alices.clone()),
                    nodes: vec![theirs.id.clone()],
                    scope: NodeScope::SameCanvas
                }
            ),
            Err(Denied::NotFound)
        );
        let child = world.folder(&alices);
        let inner = world.node(&child);
        assert_eq!(
            world.check(
                &world.alice,
                Permission::Nodes {
                    canvas: Some(alices.clone()),
                    nodes: vec![inner.id.clone()],
                    scope: NodeScope::SameCanvas
                }
            ),
            Err(Denied::NotFound)
        );
        assert!(world
            .check(
                &world.alice,
                Permission::Nodes {
                    canvas: Some(alices.clone()),
                    nodes: vec![inner.id],
                    scope: NodeScope::SameTree
                }
            )
            .is_ok());
        let edge = world
            .db
            .create_edge(serde_json::from_value(json!({"canvasId": bobs, "sourceNodeId": theirs.id, "targetNodeId": world.node(&bobs).id, "metadata": {}})).unwrap())
            .unwrap();
        assert_eq!(
            world.check(&world.alice, Permission::EdgeWrite(edge.id.clone())),
            Err(Denied::NotFound)
        );
        assert!(world
            .check(&world.bob, Permission::EdgeWrite(edge.id))
            .is_ok());
    }

    pub(crate) fn node_json(id: &str, canvas: &str) -> Value {
        json!({"id": id, "canvasId": canvas, "kind": "text", "title": "t", "content": {}, "source": "test",
               "requestId": null, "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0, "status": "ready",
               "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"})
    }
    fn edge_json(id: &str, canvas: &str, source: &str, target: &str) -> Value {
        json!({"id": id, "canvasId": canvas, "sourceNodeId": source, "targetNodeId": target, "kind": "reference",
               "metadata": {}, "createdAt": "2026-01-01T00:00:00Z"})
    }
    pub(crate) fn canvas_json(id: &str) -> Value {
        json!({"id": id, "name": "c", "isPrivate": false, "previewImagePath": null,
               "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"})
    }
    pub(crate) fn source_json(folder: Value, child: &str, nodes: Vec<Value>) -> Value {
        json!({"folderNode": folder, "childCanvas": canvas_json(child), "folderLinkCreatedAt": "2026-01-01T00:00:00Z",
               "nodes": nodes, "edges": [], "promptSceneBindings": []})
    }

    // Each payload shape: a clean version passes, the same payload with one id
    // from someone else's canvas is refused as a whole.
    #[test]
    fn undo_and_restore_payloads_are_checked_id_by_id() {
        let world = world();
        let alices = world.project(&world.alice, false);
        let bobs = world.project(&world.bob, false);
        let theirs = world.node(&bobs);
        let foreign_edge = world
            .db
            .create_edge(serde_json::from_value(json!({"canvasId": bobs, "sourceNodeId": theirs.id, "targetNodeId": world.node(&bobs).id, "metadata": {}})).unwrap())
            .unwrap();
        let mine = world.node(&alices);
        let fresh = "node:restored";
        let records = |refs: RecordRefs| world.check(&world.alice, Permission::Records(refs));

        // DeletedBatch (restore_deleted_nodes)
        let batch = |extra: Value| -> crate::models::DeletedBatch {
            serde_json::from_value(json!({"nodes": [node_json(fresh, &alices), extra], "edges": [], "promptSceneBindings": []})).unwrap()
        };
        assert!(
            records(dispatch::batch_refs(&batch(node_json("node:other", &alices))).unwrap())
                .is_ok()
        );
        assert_eq!(
            records(dispatch::batch_refs(&batch(node_json("node:other", &bobs))).unwrap()),
            Err(Denied::NotFound)
        );
        assert_eq!(
            records(dispatch::batch_refs(&batch(node_json(&theirs.id, &alices))).unwrap()),
            Err(Denied::NotFound)
        );
        let with_edge: crate::models::DeletedBatch = serde_json::from_value(json!({
            "nodes": [node_json(fresh, &alices)], "edges": [edge_json(&foreign_edge.id, &alices, fresh, &mine.id)], "promptSceneBindings": []})).unwrap();
        assert_eq!(
            records(dispatch::batch_refs(&with_edge).unwrap()),
            Err(Denied::NotFound)
        );
        let to_their_node: crate::models::DeletedBatch = serde_json::from_value(json!({
            "nodes": [node_json(fresh, &alices)], "edges": [edge_json("edge:new", &alices, fresh, &theirs.id)], "promptSceneBindings": []})).unwrap();
        assert_eq!(
            records(dispatch::batch_refs(&to_their_node).unwrap()),
            Err(Denied::NotFound)
        );

        // RestoreNodeReplacementInput
        let replacement = |previous: Value| -> crate::models::RestoreNodeReplacementInput {
            serde_json::from_value(json!({"previousNode": previous, "deleted": {"nodes": [node_json(fresh, &alices)], "edges": []}})).unwrap()
        };
        assert!(records(dispatch::replacement_refs(&replacement(node_json(
            &mine.id, &alices
        ))))
        .is_ok());
        assert_eq!(
            records(dispatch::replacement_refs(&replacement(node_json(
                &theirs.id, &alices
            )))),
            Err(Denied::NotFound)
        );

        // FolderGroupingUndoRecord
        let grouping = |child: &str| -> crate::models::FolderGroupingUndoRecord {
            serde_json::from_value(json!({"parentCanvasId": alices, "childCanvasId": child, "folderNodeId": "node:folder",
                "nodes": [node_json(&mine.id, &alices)], "edges": [], "promptSceneBindings": [], "duplicatedInputNodes": []})).unwrap()
        };
        assert!(records(dispatch::grouping_refs(&grouping("canvas:gone"))).is_ok());
        assert_eq!(
            records(dispatch::grouping_refs(&grouping(&bobs))),
            Err(Denied::NotFound)
        );

        // FolderMergeUndoRecord
        let merge = |child: &str| -> crate::models::FolderMergeUndoRecord {
            serde_json::from_value(json!({"parentCanvasId": alices, "mergedChildCanvasId": "canvas:merged", "mergedFolderNodeId": "node:merged",
                "sources": [source_json(node_json("node:f1", &alices), child, vec![])], "parentEdges": [], "deduplicatedInputNodes": []})).unwrap()
        };
        assert!(records(dispatch::merge_refs(&merge("canvas:new-child"))).is_ok());
        assert_eq!(
            records(dispatch::merge_refs(&merge(&bobs))),
            Err(Denied::NotFound)
        );

        // CancelFolderUndoRecord
        let cancel = |nodes: Vec<Value>| -> crate::models::CancelFolderUndoRecord {
            serde_json::from_value(json!({"parentCanvasId": alices, "source": source_json(node_json("node:f2", &alices), "canvas:new-child", nodes),
                "parentEdges": [], "restoredSourceEdges": []})).unwrap()
        };
        assert!(records(dispatch::cancel_refs(&cancel(vec![node_json(
            "node:n2",
            "canvas:new-child"
        )])))
        .is_ok());
        assert_eq!(
            records(dispatch::cancel_refs(&cancel(vec![node_json(
                "node:n2", &bobs
            )]))),
            Err(Denied::NotFound)
        );

        // FolderTreeUndoRecord
        let tree = |linked: &str| -> crate::models::FolderTreeUndoRecord {
            serde_json::from_value(json!({"parentCanvasId": alices, "rootFolderNodeId": "node:root-folder", "canvases": [canvas_json("canvas:subtree")],
                "nodes": [node_json("node:root-folder", &alices)], "edges": [],
                "folderLinks": [{"folderNodeId": "node:root-folder", "childCanvasId": linked, "createdAt": "2026-01-01T00:00:00Z"}],
                "promptSceneBindings": []})).unwrap()
        };
        assert!(records(dispatch::tree_refs(&tree("canvas:subtree"))).is_ok());
        assert_eq!(
            records(dispatch::tree_refs(&tree(&bobs))),
            Err(Denied::NotFound)
        );

        // The anchor itself must be writable.
        assert_eq!(
            world.check(
                &world.bob,
                Permission::Records(dispatch::tree_refs(&tree("canvas:subtree")))
            ),
            Err(Denied::NotFound)
        );
    }
}
