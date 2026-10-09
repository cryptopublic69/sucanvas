use super::WebState;
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
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
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const COOKIE: &str = "sucanvas_session";
const SESSION_SECONDS: u64 = 12 * 60 * 60;
#[derive(Serialize, Deserialize)]
pub struct Credentials {
    pub password_hash: String,
}
pub struct Auth {
    hash: String,
    sessions: Mutex<HashMap<String, Instant>>,
    attempts: Mutex<Vec<Instant>>,
}
impl Auth {
    pub fn read(path: &Path) -> Result<Self, String> {
        let data: Credentials = serde_json::from_slice(&std::fs::read(path).map_err(|_| {
            "Login password is not configured. Run scripts/Set-Password.ps1 first.".to_owned()
        })?)
        .map_err(|e| e.to_string())?;
        PasswordHash::new(&data.password_hash).map_err(|e| e.to_string())?;
        Ok(Self {
            hash: data.password_hash,
            sessions: Mutex::new(HashMap::new()),
            attempts: Mutex::new(Vec::new()),
        })
    }
    pub fn authenticated(&self, headers: &HeaderMap) -> bool {
        let Some(token) = cookie_token(headers) else {
            return false;
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, expiry| *expiry > Instant::now());
        sessions.contains_key(token)
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
    if !(12..=256).contains(&password.chars().count()) {
        return Err("Password must contain 12 to 256 characters".into());
    }
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|e| e.to_string())?;
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| e.to_string())?
        .to_string();
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
    let hash = state.auth.hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|hash| {
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
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut sessions = state.auth.sessions.lock().unwrap();
    sessions.retain(|_, expiry| *expiry > Instant::now());
    if sessions.len() >= 128 {
        sessions.clear();
    }
    sessions.insert(
        token.clone(),
        Instant::now() + Duration::from_secs(SESSION_SECONDS),
    );
    let cookie = format!(
        "{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}{}",
        if state.config.secure_cookie() {
            "; Secure"
        } else {
            ""
        }
    );
    ([(header::SET_COOKIE, cookie)], Json(json!({"ok": true}))).into_response()
}
pub async fn logout(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_token(&headers) {
        state.auth.sessions.lock().unwrap().remove(token);
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
    Json(json!({"ok": true, "comfyConfigured": !state.config.comfy_url.is_empty()})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sessions_require_exact_cookie_and_expire() {
        let auth = Auth {
            hash: String::new(),
            sessions: Mutex::new(HashMap::from([
                ("valid".to_owned(), Instant::now() + Duration::from_secs(10)),
                ("old".to_owned(), Instant::now() - Duration::from_secs(1)),
            ])),
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
