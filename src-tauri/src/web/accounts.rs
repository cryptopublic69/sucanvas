// Admin user management (UI: src/web/UsersPage.tsx). Every operation is an
// `AdminCommand`; `execute` checks the permission the command declares before
// running it, so no handler carries its own role check.
use super::{
    auth::{Auth, Denied, Permission, Session},
    users::{Actor, Role},
    WebState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug)]
pub enum AdminCommand {
    List,
    Create {
        username: String,
        display_name: Option<String>,
        role: Role,
        temporary_password: String,
    },
    ResetPassword {
        id: String,
        temporary_password: String,
    },
    SetDisabled {
        id: String,
        disabled: bool,
    },
    SetRole {
        id: String,
        role: Role,
    },
    SetDisplayName {
        id: String,
        display_name: Option<String>,
    },
    // The user's canvases (private and shared) move to `transfer_to`.
    Delete {
        id: String,
        transfer_to: String,
    },
}

impl AdminCommand {
    // Exhaustive: a new command does not compile until it names its permission.
    pub fn permission(&self) -> Permission {
        match self {
            AdminCommand::List
            | AdminCommand::Create { .. }
            | AdminCommand::ResetPassword { .. }
            | AdminCommand::SetDisabled { .. }
            | AdminCommand::SetRole { .. }
            | AdminCommand::SetDisplayName { .. }
            | AdminCommand::Delete { .. } => Permission::Admin,
        }
    }
}

#[derive(Debug)]
pub enum AdminError {
    Denied(Denied),
    Rejected(String),
}

impl From<Denied> for AdminError {
    fn from(error: Denied) -> Self {
        AdminError::Denied(error)
    }
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        match self {
            AdminError::Denied(error) => error.into_response(),
            AdminError::Rejected(error) => {
                let status = if error == "用户不存在" {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
                (status, Json(json!({"error": error}))).into_response()
            }
        }
    }
}

fn rejected(error: String) -> AdminError {
    AdminError::Rejected(error)
}

async fn temporary_hash(password: String) -> Result<String, AdminError> {
    crate::commands::validate_new_app_lock_password(&password).map_err(rejected)?;
    tokio::task::spawn_blocking(move || crate::commands::hash_app_lock_password(&password))
        .await
        .map_err(|e| rejected(e.to_string()))?
        .map_err(rejected)
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, AdminError> {
    serde_json::to_value(value).map_err(|e| rejected(e.to_string()))
}

pub async fn execute(
    auth: &Auth,
    actor: &Session,
    command: AdminCommand,
) -> Result<Value, AdminError> {
    auth.authorize(actor, &command.permission())?;
    let users = auth.users();
    // Every change is audited under the acting admin's username.
    let actor_username = users
        .by_id(&actor.user_id)
        .map_err(rejected)?
        .map(|credential| credential.user.username)
        .ok_or_else(|| rejected("用户不存在".to_owned()))?;
    let who = Actor {
        id: &actor.user_id,
        username: &actor_username,
    };
    match command {
        AdminCommand::List => to_json(users.list().map_err(rejected)?),
        AdminCommand::Create {
            username,
            display_name,
            role,
            temporary_password,
        } => {
            let hash = temporary_hash(temporary_password).await?;
            to_json(
                users
                    .create_as(&who, username.trim(), display_name, role, &hash)
                    .map_err(rejected)?,
            )
        }
        AdminCommand::ResetPassword {
            id,
            temporary_password,
        } => {
            let hash = temporary_hash(temporary_password).await?;
            let user = users
                .reset_password_as(&who, &id, &hash)
                .map_err(rejected)?;
            auth.revoke_user(&id, None);
            to_json(user)
        }
        AdminCommand::SetDisabled { id, disabled } => {
            if disabled && id == actor.user_id {
                return Err(rejected("不能停用自己的账号".to_owned()));
            }
            let user = users
                .set_disabled_as(&who, &id, disabled)
                .map_err(rejected)?;
            if disabled {
                auth.revoke_user(&id, None);
            }
            to_json(user)
        }
        AdminCommand::SetRole { id, role } => {
            if role != Role::Admin && id == actor.user_id {
                return Err(rejected("不能取消自己的管理员身份".to_owned()));
            }
            let user = users.set_role_as(&who, &id, role).map_err(rejected)?;
            auth.update_role(&id, role);
            to_json(user)
        }
        AdminCommand::SetDisplayName { id, display_name } => to_json(
            users
                .set_display_name_as(&who, &id, display_name)
                .map_err(rejected)?,
        ),
        AdminCommand::Delete { id, transfer_to } => {
            if id == actor.user_id {
                return Err(rejected("不能删除自己的账号".to_owned()));
            }
            let deleted = users.delete(&who, &id, &transfer_to).map_err(rejected)?;
            auth.revoke_user(&id, None);
            to_json(deleted)
        }
    }
}

async fn respond(state: &WebState, actor: &Session, command: AdminCommand) -> Response {
    match execute(&state.auth, actor, command).await {
        Ok(result) => Json(json!({"result": result})).into_response(),
        Err(error) => error.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    username: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default = "default_role")]
    role: Role,
    temporary_password: String,
}
fn default_role() -> Role {
    Role::User
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetInput {
    temporary_password: String,
}
#[derive(Deserialize)]
pub struct DisabledInput {
    disabled: bool,
}
#[derive(Deserialize)]
pub struct RoleInput {
    role: Role,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayNameInput {
    #[serde(default)]
    display_name: Option<String>,
}

pub async fn list(State(state): State<WebState>, Extension(actor): Extension<Session>) -> Response {
    respond(&state, &actor, AdminCommand::List).await
}
pub async fn create(
    State(state): State<WebState>,
    Extension(actor): Extension<Session>,
    Json(input): Json<CreateInput>,
) -> Response {
    let command = AdminCommand::Create {
        username: input.username,
        display_name: input.display_name,
        role: input.role,
        temporary_password: input.temporary_password,
    };
    respond(&state, &actor, command).await
}
pub async fn reset_password(
    State(state): State<WebState>,
    Extension(actor): Extension<Session>,
    Path(id): Path<String>,
    Json(input): Json<ResetInput>,
) -> Response {
    let command = AdminCommand::ResetPassword {
        id,
        temporary_password: input.temporary_password,
    };
    respond(&state, &actor, command).await
}
pub async fn set_disabled(
    State(state): State<WebState>,
    Extension(actor): Extension<Session>,
    Path(id): Path<String>,
    Json(input): Json<DisabledInput>,
) -> Response {
    let command = AdminCommand::SetDisabled {
        id,
        disabled: input.disabled,
    };
    respond(&state, &actor, command).await
}
pub async fn set_role(
    State(state): State<WebState>,
    Extension(actor): Extension<Session>,
    Path(id): Path<String>,
    Json(input): Json<RoleInput>,
) -> Response {
    respond(
        &state,
        &actor,
        AdminCommand::SetRole {
            id,
            role: input.role,
        },
    )
    .await
}
pub async fn set_display_name(
    State(state): State<WebState>,
    Extension(actor): Extension<Session>,
    Path(id): Path<String>,
    Json(input): Json<DisplayNameInput>,
) -> Response {
    let command = AdminCommand::SetDisplayName {
        id,
        display_name: input.display_name,
    };
    respond(&state, &actor, command).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteInput {
    transfer_to_user_id: String,
}
pub async fn delete(
    State(state): State<WebState>,
    Extension(actor): Extension<Session>,
    Path(id): Path<String>,
    Json(input): Json<DeleteInput>,
) -> Response {
    let command = AdminCommand::Delete {
        id,
        transfer_to: input.transfer_to_user_id,
    };
    respond(&state, &actor, command).await
}

#[cfg(test)]
mod tests {
    use super::super::auth::{
        tests::{add_user, headers, server},
        Access, AuthError,
    };
    use super::super::authz::tests::{session, world, World};
    use super::*;

    async fn signed_in(auth: &Auth, username: &str, password: &str) -> (String, Session) {
        let (token, _) = auth.login(username, password.into()).await.unwrap();
        match auth.access(&headers(&token)) {
            Access::Granted(session) => (token, session),
            _ => panic!("{username} has no usable session"),
        }
    }

    fn every_command(id: &str) -> Vec<AdminCommand> {
        vec![
            AdminCommand::List,
            AdminCommand::Create {
                username: "mallory".into(),
                display_name: None,
                role: Role::Admin,
                temporary_password: "临时密码".into(),
            },
            AdminCommand::ResetPassword {
                id: id.into(),
                temporary_password: "临时密码".into(),
            },
            AdminCommand::SetDisabled {
                id: id.into(),
                disabled: true,
            },
            AdminCommand::SetRole {
                id: id.into(),
                role: Role::User,
            },
            AdminCommand::SetDisplayName {
                id: id.into(),
                display_name: Some("x".into()),
            },
            AdminCommand::Delete {
                id: id.into(),
                transfer_to: id.into(),
            },
        ]
    }

    #[tokio::test]
    async fn regular_users_are_refused_every_admin_command() {
        let (_fixture, auth) = server();
        let erin = add_user(&auth, "erin", "初始密码");
        auth.users()
            .set_password(
                &erin.id,
                &crate::commands::hash_app_lock_password("自己的密码").unwrap(),
                false,
                None,
            )
            .unwrap();
        let (_, session) = signed_in(&auth, "erin", "自己的密码").await;
        let admin = auth.users().by_username("admin").unwrap().unwrap().user;
        for command in every_command(&admin.id) {
            assert_eq!(command.permission(), Permission::Admin);
            let label = format!("{command:?}");
            let denied = execute(&auth, &session, command).await.unwrap_err();
            assert_eq!(
                denied.into_response().status(),
                StatusCode::FORBIDDEN,
                "{label}"
            );
        }
        // Nothing changed: no new user, admin untouched.
        assert_eq!(auth.users().list().unwrap().len(), 2);
        let admin_now = auth.users().by_username("admin").unwrap().unwrap().user;
        assert!(!admin_now.disabled && admin_now.role == Role::Admin);
    }

    #[tokio::test]
    async fn created_user_must_change_password_on_first_login() {
        let (_fixture, auth) = server();
        let (_, admin) = signed_in(&auth, "admin", "管理员密码").await;
        let created = execute(
            &auth,
            &admin,
            AdminCommand::Create {
                username: "Frank".into(),
                display_name: Some("弗兰克".into()),
                role: Role::User,
                temporary_password: "临时密码".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(created["mustChangePassword"], true);
        assert!(created.get("passwordHash").is_none());
        let (token, user) = auth.login("frank", "临时密码".into()).await.unwrap();
        assert!(user.must_change_password);
        assert!(matches!(
            auth.access(&headers(&token)),
            Access::PasswordChangeRequired
        ));
        auth.change_password(&token, "临时密码".into(), "弗兰克密码".into())
            .await
            .unwrap();
        assert!(matches!(auth.access(&headers(&token)), Access::Granted(_)));
    }

    #[tokio::test]
    async fn reset_and_disable_end_the_users_sessions_immediately() {
        let (_fixture, auth) = server();
        let (_, admin) = signed_in(&auth, "admin", "管理员密码").await;
        let grace = add_user(&auth, "grace", "初始密码");
        let (token, _) = auth.login("grace", "初始密码".into()).await.unwrap();
        execute(
            &auth,
            &admin,
            AdminCommand::ResetPassword {
                id: grace.id.clone(),
                temporary_password: "重置密码".into(),
            },
        )
        .await
        .unwrap();
        assert!(!auth.authenticated(&headers(&token)));
        assert_eq!(
            auth.login("grace", "初始密码".into()).await.unwrap_err(),
            AuthError::Invalid
        );
        let (token, user) = auth.login("grace", "重置密码".into()).await.unwrap();
        assert!(user.must_change_password);
        execute(
            &auth,
            &admin,
            AdminCommand::SetDisabled {
                id: grace.id.clone(),
                disabled: true,
            },
        )
        .await
        .unwrap();
        assert!(!auth.authenticated(&headers(&token)));
        assert_eq!(
            auth.login("grace", "重置密码".into()).await.unwrap_err(),
            AuthError::Disabled
        );
        execute(
            &auth,
            &admin,
            AdminCommand::SetDisabled {
                id: grace.id,
                disabled: false,
            },
        )
        .await
        .unwrap();
        assert!(auth.login("grace", "重置密码".into()).await.is_ok());
    }

    #[tokio::test]
    async fn admins_cannot_disable_or_demote_themselves_or_the_last_admin() {
        let (_fixture, auth) = server();
        let (_, admin) = signed_in(&auth, "admin", "管理员密码").await;
        let own = |command| execute(&auth, &admin, command);
        let disable_self = own(AdminCommand::SetDisabled {
            id: admin.user_id.clone(),
            disabled: true,
        })
        .await
        .unwrap_err();
        assert_eq!(
            disable_self.into_response().status(),
            StatusCode::BAD_REQUEST
        );
        assert!(own(AdminCommand::SetRole {
            id: admin.user_id.clone(),
            role: Role::User,
        })
        .await
        .is_err());
        // A second admin may not remove the first while it is the only enabled one.
        let heidi = add_user(&auth, "heidi", "初始密码");
        own(AdminCommand::SetRole {
            id: heidi.id.clone(),
            role: Role::Admin,
        })
        .await
        .unwrap();
        own(AdminCommand::SetDisabled {
            id: heidi.id.clone(),
            disabled: true,
        })
        .await
        .unwrap();
        let heidi_session = Session {
            user_id: heidi.id.clone(),
            ..admin.clone()
        };
        let last = execute(
            &auth,
            &heidi_session,
            AdminCommand::SetDisabled {
                id: admin.user_id.clone(),
                disabled: true,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(last.into_response().status(), StatusCode::BAD_REQUEST);
        assert!(
            !auth
                .users()
                .by_id(&admin.user_id)
                .unwrap()
                .unwrap()
                .user
                .disabled
        );
    }

    fn audit_rows(world: &World) -> Vec<(String, String, Option<String>, String)> {
        let connection = rusqlite::Connection::open(world.fixture.database()).unwrap();
        let mut statement = connection
            .prepare("SELECT username, canvas_id, canvas_owner_user_id, command FROM audit_log ORDER BY id")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    // 012c1: everything carol owned (private, shared, child canvases) goes to
    // bob with sharing unchanged; her sessions end; older audit rows that
    // name her keep the username text.
    #[tokio::test]
    async fn deleting_a_user_moves_every_canvas_to_the_target_and_ends_sessions() {
        let world = world();
        let carol = add_user(&world.auth, "carol", "初始密码");
        let (token, _) = world.auth.login("carol", "初始密码".into()).await.unwrap();
        let carols = session(&carol.id, Role::User);
        let private = world.project(&carols, false);
        let child = world.folder(&private);
        let shared = world.project(&carols, true);
        let alices = world.project(&world.alice, false);
        world
            .store()
            .audit(
                &carol.id,
                "carol",
                &world.store().owner(&shared).unwrap().unwrap(),
                "earlier",
            )
            .unwrap();
        let result = execute(
            &world.auth,
            &world.admin,
            AdminCommand::Delete {
                id: carol.id.clone(),
                transfer_to: world.bob.user_id.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(result["username"], "carol");
        assert_eq!(result["transferredToUsername"], "bob");
        assert_eq!(result["transferredCanvases"], 2);
        let bob = Some(world.bob.user_id.clone());
        assert_eq!(world.columns(&private), (bob.clone(), 0));
        assert_eq!(world.columns(&child), (bob.clone(), 0));
        assert_eq!(world.columns(&shared), (bob, 1));
        assert_eq!(
            world.columns(&alices),
            (Some(world.alice.user_id.clone()), 0)
        );
        assert!(world.auth.users().by_id(&carol.id).unwrap().is_none());
        assert!(!world.auth.authenticated(&headers(&token)));
        assert_eq!(
            world
                .auth
                .login("carol", "初始密码".into())
                .await
                .unwrap_err(),
            AuthError::Invalid
        );
        let audit = audit_rows(&world);
        assert_eq!(audit[0].0, "carol");
        assert_eq!(audit[0].3, "earlier");
        let mut moved: Vec<_> = audit[1..3].iter().map(|row| row.1.clone()).collect();
        moved.sort();
        let mut expected = vec![private, shared];
        expected.sort();
        assert_eq!(moved, expected);
        for row in &audit[1..] {
            assert_eq!(row.0, "admin");
            assert_eq!(row.2.as_deref(), Some(carol.id.as_str()));
            assert!(
                row.3.contains("username=carol transfer_to=bob"),
                "{}",
                row.3
            );
        }
        assert_eq!(audit[3].1, "");
        assert!(audit[3].3.ends_with("canvases=2"));
        assert_eq!(audit.len(), 4);
    }

    #[tokio::test]
    async fn delete_refuses_self_the_last_admin_and_bad_targets_without_changes() {
        let world = world();
        let alices = world.project(&world.alice, false);
        let refused = |actor: Session, id: String, transfer_to: String| {
            let auth = &world.auth;
            async move {
                execute(auth, &actor, AdminCommand::Delete { id, transfer_to })
                    .await
                    .unwrap_err()
                    .into_response()
                    .status()
            }
        };
        let admin_id = world.admin.user_id.clone();
        let alice_id = world.alice.user_id.clone();
        // Own account, unknown or identical target, unknown user.
        assert_eq!(
            refused(world.admin.clone(), admin_id.clone(), alice_id.clone()).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            refused(world.admin.clone(), alice_id.clone(), "nobody".into()).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            refused(world.admin.clone(), alice_id.clone(), alice_id.clone()).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            refused(world.admin.clone(), "nobody".into(), admin_id.clone()).await,
            StatusCode::NOT_FOUND
        );
        // A disabled second admin cannot delete the only enabled one.
        let heidi = world
            .auth
            .users()
            .create("heidi", None, Role::Admin, "hash")
            .unwrap();
        world.auth.users().set_disabled(&heidi.id, true).unwrap();
        assert_eq!(
            refused(
                session(&heidi.id, Role::Admin),
                admin_id.clone(),
                heidi.id.clone()
            )
            .await,
            StatusCode::BAD_REQUEST
        );
        // Regular users are refused before anything is looked up.
        assert_eq!(
            refused(
                world.bob.clone(),
                alice_id.clone(),
                world.bob.user_id.clone()
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(world.auth.users().list().unwrap().len(), 4);
        assert_eq!(world.columns(&alices), (Some(alice_id), 0));
        assert!(audit_rows(&world).is_empty());
        // Once heidi is enabled, the original admin may go.
        world.auth.users().set_disabled(&heidi.id, false).unwrap();
        execute(
            &world.auth,
            &session(&heidi.id, Role::Admin),
            AdminCommand::Delete {
                id: admin_id,
                transfer_to: heidi.id.clone(),
            },
        )
        .await
        .unwrap();
    }

    // 012c1 review: canvases may only go to an enabled account.
    #[tokio::test]
    async fn delete_only_transfers_to_enabled_users() {
        let world = world();
        let alices = world.project(&world.alice, false);
        world
            .auth
            .users()
            .set_disabled(&world.bob.user_id, true)
            .unwrap();
        let delete = |transfer_to: String| {
            execute(
                &world.auth,
                &world.admin,
                AdminCommand::Delete {
                    id: world.alice.user_id.clone(),
                    transfer_to,
                },
            )
        };
        match delete(world.bob.user_id.clone()).await.unwrap_err() {
            AdminError::Rejected(error) => assert_eq!(error, "画布只能转给启用的用户"),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            world.columns(&alices),
            (Some(world.alice.user_id.clone()), 0)
        );
        assert!(world
            .auth
            .users()
            .by_id(&world.alice.user_id)
            .unwrap()
            .is_some());
        assert!(audit_rows(&world).is_empty());
        world
            .auth
            .users()
            .set_disabled(&world.bob.user_id, false)
            .unwrap();
        delete(world.bob.user_id.clone()).await.unwrap();
        assert_eq!(world.columns(&alices), (Some(world.bob.user_id.clone()), 0));
    }

    // 012c1 review: create, reset, disable/enable, role and display name are
    // audited with usernames and the action only; refused changes write nothing.
    #[tokio::test]
    async fn account_changes_are_audited_without_passwords() {
        let world = world();
        let run = |command| execute(&world.auth, &world.admin, command);
        let created = run(AdminCommand::Create {
            username: "dora".into(),
            display_name: Some("朵拉的显示名".into()),
            role: Role::User,
            temporary_password: "第一个临时密码".into(),
        })
        .await
        .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        run(AdminCommand::ResetPassword {
            id: id.clone(),
            temporary_password: "第二个临时密码".into(),
        })
        .await
        .unwrap();
        for disabled in [true, false] {
            run(AdminCommand::SetDisabled {
                id: id.clone(),
                disabled,
            })
            .await
            .unwrap();
        }
        run(AdminCommand::SetRole {
            id: id.clone(),
            role: Role::Admin,
        })
        .await
        .unwrap();
        run(AdminCommand::SetDisplayName {
            id: id.clone(),
            display_name: Some("新的显示名".into()),
        })
        .await
        .unwrap();
        // Refused: own account, too-short password, unknown user.
        assert!(run(AdminCommand::SetDisabled {
            id: world.admin.user_id.clone(),
            disabled: true,
        })
        .await
        .is_err());
        assert!(run(AdminCommand::ResetPassword {
            id: id.clone(),
            temporary_password: "ab".into(),
        })
        .await
        .is_err());
        assert!(run(AdminCommand::SetDisplayName {
            id: "nobody".into(),
            display_name: None,
        })
        .await
        .is_err());
        let audit = audit_rows(&world);
        let commands: Vec<&str> = audit.iter().map(|row| row.3.as_str()).collect();
        assert_eq!(
            commands,
            [
                "create_user username=dora role=user",
                "reset_password username=dora",
                "disable_user username=dora",
                "enable_user username=dora",
                "set_role username=dora role=admin",
                "set_display_name username=dora",
            ]
        );
        for row in &audit {
            assert_eq!(row.0, "admin");
            assert_eq!(row.1, "");
            assert_eq!(row.2, None);
            for secret in ["临时密码", "显示名"] {
                assert!(!row.3.contains(secret), "{}", row.3);
            }
        }
    }

    // A failure after the canvases moved (here: the final DELETE) rolls the
    // whole deletion back: owners, audit rows and the account stay as they were.
    #[tokio::test]
    async fn a_failed_delete_rolls_back_the_canvas_transfer() {
        let world = world();
        let alices = world.project(&world.alice, false);
        rusqlite::Connection::open(world.fixture.database())
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER block_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
            )
            .unwrap();
        let error = execute(
            &world.auth,
            &world.admin,
            AdminCommand::Delete {
                id: world.alice.user_id.clone(),
                transfer_to: world.admin.user_id.clone(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            world.columns(&alices),
            (Some(world.alice.user_id.clone()), 0)
        );
        assert!(audit_rows(&world).is_empty());
        assert!(world
            .auth
            .users()
            .by_id(&world.alice.user_id)
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn role_changes_apply_to_open_sessions() {
        let (_fixture, auth) = server();
        let (_, admin) = signed_in(&auth, "admin", "管理员密码").await;
        let ivan = add_user(&auth, "ivan", "初始密码");
        let (token, _) = auth.login("ivan", "初始密码".into()).await.unwrap();
        execute(
            &auth,
            &admin,
            AdminCommand::SetRole {
                id: ivan.id,
                role: Role::Admin,
            },
        )
        .await
        .unwrap();
        auth.change_password(&token, "初始密码".into(), "伊万的密码".into())
            .await
            .unwrap();
        assert!(matches!(
            auth.access(&headers(&token)),
            Access::Granted(session) if session.role == Role::Admin
        ));
    }
}
