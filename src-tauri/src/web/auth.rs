use super::WebState;
use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const COOKIE: &str = "sucanvas_session";
const SESSION_SECONDS: u64 = 12 * 60 * 60;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    #[serde(alias = "password_hash")]
    pub password_hash: String,
}
pub struct Auth {
    path: PathBuf,
    access: Mutex<Access>,
    attempts: Mutex<Vec<Instant>>,
}
struct Access {
    hash: String,
    sessions: HashMap<String, Instant>,
}
fn read_hash(path: &Path) -> Result<String, String> {
    let data: Credentials = serde_json::from_slice(
        &std::fs::read(path)
            .map_err(|_| "应用锁密码尚未配置，请先运行 scripts/Set-Password.ps1。".to_owned())?,
    )
    .map_err(|e| e.to_string())?;
    PasswordHash::new(&data.password_hash).map_err(|e| e.to_string())?;
    Ok(data.password_hash)
}

// An existing application lock takes priority; otherwise keep the old Web
// password. Archive legacy credentials so there is only one active password.
pub fn migrate_credentials(data: &Path) -> Result<(), String> {
    let path = data.join("app-lock.json");
    let legacy = data.join("web-auth.json");
    if !path.exists() {
        let hash = read_hash(&legacy)?;
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&Credentials {
                password_hash: hash,
            })
            .unwrap(),
        )
        .map_err(|e| e.to_string())?;
    }
    let hash = read_hash(&path)?;
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if stored.get("passwordHash").is_none() {
        // Development launchers may already have copied legacy credentials to
        // app-lock.json. Normalize them to the shared application-lock format.
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&Credentials {
                password_hash: hash,
            })
            .unwrap(),
        )
        .map_err(|e| e.to_string())?;
    }
    if legacy.exists() {
        std::fs::rename(
            &legacy,
            data.join(format!("web-auth.before-app-lock-{}.json", Uuid::new_v4())),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
impl Auth {
    pub fn read(path: &Path) -> Result<Self, String> {
        Ok(Self {
            path: path.to_owned(),
            access: Mutex::new(Access {
                hash: read_hash(path)?,
                sessions: HashMap::new(),
            }),
            attempts: Mutex::new(Vec::new()),
        })
    }
    pub fn authenticated(&self, headers: &HeaderMap) -> bool {
        let Some(token) = cookie_token(headers) else {
            return false;
        };
        let mut access = self.access.lock().unwrap();
        access.sessions.retain(|_, expiry| *expiry > Instant::now());
        access.sessions.contains_key(token)
    }
    fn issue_session(&self, expected_hash: &str) -> Option<String> {
        let mut access = self.access.lock().unwrap();
        // Do not issue a session using a password changed during verification.
        if access.hash != expected_hash {
            return None;
        }
        access.sessions.retain(|_, expiry| *expiry > Instant::now());
        if access.sessions.len() >= 128 {
            access.sessions.clear();
        }
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        access.sessions.insert(
            token.clone(),
            Instant::now() + Duration::from_secs(SESSION_SECONDS),
        );
        Some(token)
    }
    fn reload_password(&self) -> Result<String, String> {
        let hash = read_hash(&self.path)?;
        let mut access = self.access.lock().unwrap();
        access.hash = hash.clone();
        access.sessions.clear();
        Ok(hash)
    }
}
fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| pair.trim().strip_prefix(&format!("{COOKIE}=")))
}
pub fn write_password(path: &Path, password: &str) -> Result<(), String> {
    crate::commands::validate_new_app_lock_password(password)?;
    let hash = crate::commands::hash_app_lock_password(password)?;
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&Credentials {
            password_hash: hash,
        })
        .unwrap(),
    )
    .map_err(|e| e.to_string())
}
#[derive(Deserialize)]
pub struct Login {
    password: String,
}
pub async fn login(State(state): State<WebState>, Json(input): Json<Login>) -> Response {
    {
        let mut attempts = state.auth.attempts.lock().unwrap();
        attempts.retain(|time| time.elapsed() < Duration::from_secs(60));
        if attempts.len() >= 5 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error": "尝试次数过多，请稍后再试"})),
            )
                .into_response();
        }
        attempts.push(Instant::now());
    }
    if input.password.len() > 1024 {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let hash = state.auth.access.lock().unwrap().hash.clone();
    let verifying_hash = hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&verifying_hash).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !valid {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "密码错误"}))).into_response();
    }
    let Some(token) = state.auth.issue_session(&hash) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "密码已修改，请重新解锁"})),
        )
            .into_response();
    };
    unlocked_response(
        &state,
        token,
        json!({"ok": true, "publicUrl": state.config.origin()}),
    )
}

fn unlocked_response(state: &WebState, token: String, body: serde_json::Value) -> Response {
    let cookie = format!(
        "{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}{}",
        if state.config.secure_cookie() {
            "; Secure"
        } else {
            ""
        }
    );
    ([(header::SET_COOKIE, cookie)], Json(body)).into_response()
}

pub async fn change_password(state: WebState, input: crate::models::SetAppLockInput) -> Response {
    // Serialize disk updates and session invalidation; concurrent changes must
    // never leave a browser holding a session for an outdated password.
    let _guard = state.settings_guard.lock().await;
    if let Err(error) =
        crate::commands::set_app_lock_password(input, crate::platform::State(&state.core)).await
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response();
    }
    match state.auth.reload_password() {
        Ok(hash) => match state.auth.issue_session(&hash) {
            Some(token) => unlocked_response(&state, token, json!({"result": null})),
            None => StatusCode::UNAUTHORIZED.into_response(),
        },
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error})),
        )
            .into_response(),
    }
}
pub async fn logout(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_token(&headers) {
        state.auth.access.lock().unwrap().sessions.remove(token);
    }
    (
        [(
            header::SET_COOKIE,
            format!(
                "{COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{}",
                if state.config.secure_cookie() {
                    "; Secure"
                } else {
                    ""
                }
            ),
        )],
        Json(json!({"ok": true})),
    )
        .into_response()
}
pub async fn session(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if !state.auth.authenticated(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({"ok": true, "publicUrl": state.config.origin(), "comfyConfigured": !state.connection.snapshot().comfy_url.is_empty()}))
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_web_password_migrates_once_without_changing_the_password() {
        let root = std::env::temp_dir().join(format!("web-lock-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let hash = crate::commands::hash_app_lock_password("旧密码测试").unwrap();
        std::fs::write(
            root.join("web-auth.json"),
            serde_json::to_vec(&json!({"password_hash": hash})).unwrap(),
        )
        .unwrap();
        migrate_credentials(&root).unwrap();
        assert_eq!(read_hash(&root.join("app-lock.json")).unwrap(), hash);
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("app-lock.json")).unwrap()).unwrap();
        assert_eq!(stored["passwordHash"], hash);
        assert!(!root.join("web-auth.json").exists());
        migrate_credentials(&root).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copied_legacy_credentials_use_the_shared_application_lock_format() {
        let root = std::env::temp_dir().join(format!("web-lock-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let hash = crate::commands::hash_app_lock_password("旧密码测试").unwrap();
        std::fs::write(
            root.join("app-lock.json"),
            serde_json::to_vec(&json!({"password_hash": hash})).unwrap(),
        )
        .unwrap();
        migrate_credentials(&root).unwrap();
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("app-lock.json")).unwrap()).unwrap();
        assert_eq!(stored["passwordHash"], hash);
        assert!(stored.get("password_hash").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_application_lock_takes_priority_and_invalid_lock_is_not_replaced() {
        let root = std::env::temp_dir().join(format!("web-lock-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        write_password(&root.join("app-lock.json"), "应用密码").unwrap();
        write_password(&root.join("web-auth.json"), "网页密码").unwrap();
        let original = std::fs::read(root.join("app-lock.json")).unwrap();
        migrate_credentials(&root).unwrap();
        assert_eq!(std::fs::read(root.join("app-lock.json")).unwrap(), original);
        std::fs::write(root.join("app-lock.json"), b"broken").unwrap();
        write_password(&root.join("web-auth.json"), "网页密码").unwrap();
        assert!(migrate_credentials(&root).is_err());
        assert_eq!(
            std::fs::read(root.join("app-lock.json")).unwrap(),
            b"broken"
        );
        assert!(root.join("web-auth.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn password_change_revokes_sessions_and_rejects_verification_of_old_hash() {
        let root = std::env::temp_dir().join(format!("web-lock-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("app-lock.json");
        write_password(&path, "原始密码").unwrap();
        let auth = Auth::read(&path).unwrap();
        let hash = read_hash(&path).unwrap();
        let old_token = auth.issue_session(&hash).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("{COOKIE}={old_token}").parse().unwrap(),
        );
        assert!(auth.authenticated(&headers));
        write_password(&path, "新的密码").unwrap();
        let next_hash = auth.reload_password().unwrap();
        assert!(!auth.authenticated(&headers));
        assert!(auth.issue_session(&hash).is_none());
        assert!(auth.issue_session(&next_hash).is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_credentials_fail_closed_and_cli_uses_application_lock_limits() {
        let root = std::env::temp_dir().join(format!("web-lock-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        assert!(migrate_credentials(&root).is_err());
        assert!(Auth::read(&root.join("app-lock.json")).is_err());
        assert!(write_password(&root.join("app-lock.json"), "短密码").is_err());
        assert!(write_password(&root.join("app-lock.json"), &"密".repeat(129)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sessions_require_exact_cookie_and_expire() {
        let auth = Auth {
            path: PathBuf::new(),
            access: Mutex::new(Access {
                hash: String::new(),
                sessions: HashMap::from([
                    ("valid".to_owned(), Instant::now() + Duration::from_secs(10)),
                    ("old".to_owned(), Instant::now() - Duration::from_secs(1)),
                ]),
            }),
            attempts: Mutex::new(vec![]),
        };
        let mut headers = HeaderMap::new();
        assert!(!auth.authenticated(&headers));
        headers.insert(
            header::COOKIE,
            "other=valid; sucanvas_session=valid".parse().unwrap(),
        );
        assert!(auth.authenticated(&headers));
        headers.insert(header::COOKIE, "sucanvas_session=old".parse().unwrap());
        assert!(!auth.authenticated(&headers));
    }
}
