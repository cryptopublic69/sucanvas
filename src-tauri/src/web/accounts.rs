// Admin user management (UI arrives in CANVAS-012c). Every operation is an
// `AdminCommand`; `execute` checks the permission the command declares before
// running it, so no handler carries its own role check.
use super::{
    auth::{Auth, Denied, Permission, Session},
    users::Role,
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
            | AdminCommand::SetDisplayName { .. } => Permission::Admin,
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
                    .create(username.trim(), display_name, role, &hash)
                    .map_err(rejected)?,
            )
        }
        AdminCommand::ResetPassword {
            id,
            temporary_password,
        } => {
            let hash = temporary_hash(temporary_password).await?;
            let user = users
                .set_password(&id, &hash, true, None)
                .map_err(rejected)?;
            auth.revoke_user(&id, None);
            to_json(user)
        }
        AdminCommand::SetDisabled { id, disabled } => {
            if disabled && id == actor.user_id {
                return Err(rejected("不能停用自己的账号".to_owned()));
            }
            let user = users.set_disabled(&id, disabled).map_err(rejected)?;
            if disabled {
                auth.revoke_user(&id, None);
            }
            to_json(user)
        }
        AdminCommand::SetRole { id, role } => {
            if role != Role::Admin && id == actor.user_id {
                return Err(rejected("不能取消自己的管理员身份".to_owned()));
            }
            let user = users.set_role(&id, role).map_err(rejected)?;
            auth.update_role(&id, role);
            to_json(user)
        }
        AdminCommand::SetDisplayName { id, display_name } => to_json(
            users
                .set_display_name(&id, display_name)
                .map_err(rejected)?,
        ),
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

#[cfg(test)]
mod tests {
    use super::super::auth::{
        tests::{add_user, headers, server},
        Access, AuthError,
    };
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
