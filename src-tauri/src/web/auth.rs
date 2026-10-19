use super::{
    ownership::Ownership,
    users::{Role, UserRecord, Users},
    WebState,
};
use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

const COOKIE: &str = "sucanvas_session";
const SESSION_SECONDS: u64 = 12 * 60 * 60;
const SESSION_LIMIT: usize = 1024;
// Login attempts per minute: per username, and for the whole site so random
// usernames cannot turn the limiter into an unbounded Argon2 workload.
pub const LOGIN_LIMIT_PER_USERNAME: usize = 5;
pub const LOGIN_LIMIT_TOTAL: usize = 60;
// Per source address (c5 item 3), well below the site-wide cap: one address
// alone cannot use up the site's attempts and lock everybody else out. An
// address over its limit is refused before it counts against the site.
pub const LOGIN_LIMIT_PER_IP: usize = 15;
const _: () = assert!(LOGIN_LIMIT_PER_IP < LOGIN_LIMIT_TOTAL);
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const INVALID_LOGIN: &str = "用户名或密码错误";
pub const PASSWORD_CHANGE_REQUIRED: &str = "password_change_required";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    #[serde(alias = "password_hash")]
    pub password_hash: String,
}

// Admin edit mode on another user's private canvas lasts this long per session.
pub const EDIT_MODE_SECONDS: u64 = 30 * 60;

#[derive(Clone, Debug)]
pub struct Session {
    pub user_id: String,
    pub role: Role,
    pub must_change_password: bool,
    pub(super) expires_at: Instant,
    pub admin_edit_until: Option<Instant>,
}

pub enum Access {
    Missing,
    PasswordChangeRequired,
    Granted(Session),
}

// The permission categories (012a's Permission, extended with canvas
// categories in 012b) and their check live in `authz`.
pub use super::authz::{Denied, Grant, Permission};

#[derive(Debug, PartialEq)]
pub enum AuthError {
    Invalid,
    RateLimited,
    Disabled,
    Rejected(String),
    Internal(String),
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            AuthError::Invalid => (StatusCode::UNAUTHORIZED, json!({"error": INVALID_LOGIN})),
            AuthError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": "尝试次数过多，请稍后再试"}),
            ),
            AuthError::Disabled => (
                StatusCode::FORBIDDEN,
                json!({"error": "账号已停用，请联系管理员", "code": "account_disabled"}),
            ),
            AuthError::Rejected(error) => (StatusCode::BAD_REQUEST, json!({"error": error})),
            AuthError::Internal(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error}))
            }
        };
        (status, Json(body)).into_response()
    }
}

#[derive(Default)]
struct Limiter {
    total: Vec<Instant>,
    by_username: HashMap<String, Vec<Instant>>,
    by_ip: HashMap<IpAddr, Vec<Instant>>,
}

impl Limiter {
    // `ip`: the client address (None for checks that have no request, such
    // as a password change by a signed-in session).
    fn acquire(&mut self, key: &str, ip: Option<IpAddr>, now: Instant) -> bool {
        let recent = |time: &Instant| now.saturating_duration_since(*time) < LOGIN_WINDOW;
        self.total.retain(recent);
        self.by_username.retain(|_, times| {
            times.retain(recent);
            !times.is_empty()
        });
        self.by_ip.retain(|_, times| {
            times.retain(recent);
            !times.is_empty()
        });
        if ip.is_some_and(|ip| self.by_ip.get(&ip).map_or(0, Vec::len) >= LOGIN_LIMIT_PER_IP) {
            return false;
        }
        let used = self.by_username.get(key).map_or(0, Vec::len);
        if self.total.len() >= LOGIN_LIMIT_TOTAL || used >= LOGIN_LIMIT_PER_USERNAME {
            return false;
        }
        self.total.push(now);
        self.by_username
            .entry(key.to_owned())
            .or_default()
            .push(now);
        if let Some(ip) = ip {
            self.by_ip.entry(ip).or_default().push(now);
        }
        true
    }
    fn clear(&mut self, key: &str) {
        self.by_username.remove(key);
    }
}

pub struct Auth {
    users: Users,
    sessions: Mutex<HashMap<String, Session>>,
    limiter: Mutex<Limiter>,
    // Verified against when the username does not exist, so the response time
    // does not reveal which usernames are registered.
    dummy_hash: String,
    ownership: Arc<Ownership>,
    // Argon2 verifications performed (tests assert unknown users cost one too).
    #[cfg(test)]
    verifications: std::sync::atomic::AtomicUsize,
}

pub(super) fn read_hash(path: &Path) -> Result<String, String> {
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
    pub fn open(database: &Path) -> Result<Self, String> {
        Ok(Self {
            users: Users::open(database)?,
            ownership: Arc::new(Ownership::open(database)?),
            sessions: Mutex::new(HashMap::new()),
            limiter: Mutex::new(Limiter::default()),
            dummy_hash: crate::commands::hash_app_lock_password(&Uuid::new_v4().to_string())?,
            #[cfg(test)]
            verifications: std::sync::atomic::AtomicUsize::new(0),
        })
    }
    pub fn users(&self) -> &Users {
        &self.users
    }
    pub fn ownership(&self) -> &Arc<Ownership> {
        &self.ownership
    }
    // The one permission check for every Web operation (design §5).
    pub fn authorize(&self, session: &Session, permission: &Permission) -> Result<Grant, Denied> {
        super::authz::check(&self.ownership, session, permission)
    }
    async fn verify(&self, password: String, hash: String) -> bool {
        #[cfg(test)]
        self.verifications
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        tokio::task::spawn_blocking(move || {
            PasswordHash::new(&hash).is_ok_and(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .is_ok()
            })
        })
        .await
        .unwrap_or(false)
    }
    pub(super) fn current(&self, headers: &HeaderMap) -> Option<Session> {
        let token = cookie_token(headers)?;
        let mut sessions = self.sessions.lock().unwrap();
        let now = Instant::now();
        sessions.retain(|_, session| session.expires_at > now);
        sessions.get(token).cloned()
    }
    pub fn authenticated(&self, headers: &HeaderMap) -> bool {
        self.current(headers).is_some()
    }
    // Admin edit mode is kept per session and switches itself off after
    // EDIT_MODE_SECONDS. Returns the new end time, or None for a missing session.
    pub fn set_edit_mode(&self, headers: &HeaderMap, enabled: bool) -> Option<Option<Instant>> {
        let token = cookie_token(headers)?;
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(token)?;
        session.admin_edit_until =
            enabled.then(|| Instant::now() + Duration::from_secs(EDIT_MODE_SECONDS));
        Some(session.admin_edit_until)
    }
    pub fn access(&self, headers: &HeaderMap) -> Access {
        match self.current(headers) {
            None => Access::Missing,
            Some(session) if session.must_change_password => Access::PasswordChangeRequired,
            Some(session) => Access::Granted(session),
        }
    }
    fn issue_session(&self, user: &UserRecord) -> String {
        let mut sessions = self.sessions.lock().unwrap();
        let now = Instant::now();
        sessions.retain(|_, session| session.expires_at > now);
        if sessions.len() >= SESSION_LIMIT {
            // Drop the oldest session instead of signing everybody out.
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, session)| session.expires_at)
                .map(|(token, _)| token.clone())
            {
                sessions.remove(&oldest);
            }
        }
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sessions.insert(
            token.clone(),
            Session {
                user_id: user.id.clone(),
                role: user.role,
                must_change_password: user.must_change_password,
                expires_at: now + Duration::from_secs(SESSION_SECONDS),
                admin_edit_until: None,
            },
        );
        token
    }
    pub fn revoke_user(&self, user_id: &str, keep: Option<&str>) {
        self.sessions
            .lock()
            .unwrap()
            .retain(|token, session| session.user_id != user_id || Some(token.as_str()) == keep);
    }
    pub fn update_role(&self, user_id: &str, role: Role) {
        for session in self.sessions.lock().unwrap().values_mut() {
            if session.user_id == user_id {
                session.role = role;
            }
        }
    }
    fn acquire(&self, key: &str, ip: Option<IpAddr>) -> Result<(), AuthError> {
        if self
            .limiter
            .lock()
            .unwrap()
            .acquire(key, ip, Instant::now())
        {
            Ok(())
        } else {
            Err(AuthError::RateLimited)
        }
    }

    #[cfg(test)]
    pub async fn login(
        &self,
        username: &str,
        password: String,
    ) -> Result<(String, UserRecord), AuthError> {
        self.login_from(username, password, None).await
    }

    // `ip`: the client address the request came from (see client_ip).
    pub async fn login_from(
        &self,
        username: &str,
        password: String,
        ip: Option<IpAddr>,
    ) -> Result<(String, UserRecord), AuthError> {
        let username = username.trim();
        let key = username.to_ascii_lowercase();
        self.acquire(&key, ip)?;
        if username.len() > 64 || password.len() > 1024 {
            return Err(AuthError::Invalid);
        }
        let found = self
            .users
            .by_username(username)
            .map_err(AuthError::Internal)?;
        let hash = found.as_ref().map_or_else(
            || self.dummy_hash.clone(),
            |found| found.password_hash.clone(),
        );
        let valid = self.verify(password, hash.clone()).await;
        let Some(found) = found.filter(|_| valid) else {
            return Err(AuthError::Invalid);
        };
        if found.user.disabled {
            return Err(AuthError::Disabled);
        }
        // A reset or disable while Argon2 was running must not yield a session.
        let current = self
            .users
            .by_id(&found.user.id)
            .map_err(AuthError::Internal)?
            .filter(|current| current.password_hash == hash && !current.user.disabled)
            .ok_or(AuthError::Invalid)?;
        self.limiter.lock().unwrap().clear(&key);
        Ok((self.issue_session(&current.user), current.user))
    }

    // Changing one's own password keeps the calling session and ends the others.
    pub async fn change_password(
        &self,
        token: &str,
        current_password: String,
        new_password: String,
    ) -> Result<UserRecord, AuthError> {
        crate::commands::validate_new_app_lock_password(&new_password)
            .map_err(AuthError::Rejected)?;
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(token)
            .cloned()
            .ok_or(AuthError::Invalid)?;
        let credential = self
            .users
            .by_id(&session.user_id)
            .map_err(AuthError::Internal)?
            .ok_or(AuthError::Invalid)?;
        let key = credential.user.username.to_ascii_lowercase();
        self.acquire(&key, None)?;
        let same = current_password == new_password;
        if !self
            .verify(current_password, credential.password_hash.clone())
            .await
        {
            return Err(AuthError::Rejected("当前密码错误".to_owned()));
        }
        if same {
            return Err(AuthError::Rejected("新密码不能与当前密码相同".to_owned()));
        }
        let hash = tokio::task::spawn_blocking(move || {
            crate::commands::hash_app_lock_password(&new_password)
        })
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?
        .map_err(AuthError::Internal)?;
        let user = self
            .users
            .set_password(
                &credential.user.id,
                &hash,
                false,
                Some(&credential.password_hash),
            )
            .map_err(AuthError::Rejected)?;
        self.limiter.lock().unwrap().clear(&key);
        self.revoke_user(&user.id, Some(token));
        if let Some(session) = self.sessions.lock().unwrap().get_mut(token) {
            session.must_change_password = false;
        }
        Ok(user)
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
pub fn password_change_required() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "请先修改初始密码", "code": PASSWORD_CHANGE_REQUIRED})),
    )
        .into_response()
}
fn user_json(user: &UserRecord) -> serde_json::Value {
    json!({
        "id": user.id,
        "username": user.username,
        "displayName": user.display_name,
        "role": user.role,
        "mustChangePassword": user.must_change_password,
    })
}
#[derive(Deserialize)]
pub struct Login {
    #[serde(default)]
    username: String,
    password: String,
}
// The address a login attempt is counted against. X-Forwarded-For is only
// believed when the connection comes from a configured trusted proxy (the
// local Caddy, config `trustedProxies`); its last entry is the address that
// proxy saw. Anything else, or a malformed header, counts as the peer itself.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[IpAddr]) -> IpAddr {
    let peer = peer.to_canonical();
    if !trusted.iter().any(|proxy| proxy.to_canonical() == peer) {
        return peer;
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .last()
        .and_then(|last| last.trim().parse::<IpAddr>().ok())
        .map_or(peer, |ip| ip.to_canonical())
}

pub async fn login(
    State(state): State<WebState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> Response {
    let ip = client_ip(peer.ip(), &headers, &state.config.trusted_proxies);
    match state
        .auth
        .login_from(&input.username, input.password, Some(ip))
        .await
    {
        Ok((token, user)) => unlocked_response(
            &state,
            token,
            json!({"ok": true, "publicUrl": state.config.origin(), "user": user_json(&user)}),
        ),
        Err(error) => error.into_response(),
    }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}
// Reachable while must_change_password is set, unlike the protected routes.
pub async fn change_password(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(input): Json<PasswordChange>,
) -> Response {
    let Some(token) = cookie_token(&headers).filter(|_| state.auth.authenticated(&headers)) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "请登录"}))).into_response();
    };
    match state
        .auth
        .change_password(token, input.current_password, input.new_password)
        .await
    {
        Ok(user) => Json(json!({"ok": true, "user": user_json(&user)})).into_response(),
        Err(error) => error.into_response(),
    }
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
    let Some(session) = state.auth.current(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(Some(user)) = state.auth.users.by_id(&session.user_id) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    Json(json!({"ok": true, "publicUrl": state.config.origin(), "comfyConfigured": !state.connection.snapshot().comfy_url.is_empty(), "user": user_json(&user.user), "editModeRemainingSeconds": edit_mode_remaining(&session)}))
        .into_response()
}
fn edit_mode_remaining(session: &Session) -> Option<u64> {
    session
        .admin_edit_until
        .and_then(|until| until.checked_duration_since(Instant::now()))
        .map(|left| left.as_secs())
}
#[derive(Deserialize)]
pub struct EditMode {
    enabled: bool,
}
// Admin only: allow writes to other users' private canvases for EDIT_MODE_SECONDS.
pub async fn edit_mode(
    State(state): State<WebState>,
    Extension(session): Extension<Session>,
    headers: HeaderMap,
    Json(input): Json<EditMode>,
) -> Response {
    if let Err(denied) = state.auth.authorize(&session, &Permission::Admin) {
        return denied.into_response();
    }
    match state.auth.set_edit_mode(&headers, input.enabled) {
        Some(until) => {
            let session = Session {
                admin_edit_until: until,
                ..session
            };
            Json(json!({"ok": true, "editModeRemainingSeconds": edit_mode_remaining(&session)}))
                .into_response()
        }
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::users::{self, tests::Fixture};
    use super::*;

    pub(crate) fn headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("{COOKIE}={token}").parse().unwrap());
        headers
    }

    // Server with the migrated admin ("admin" / "管理员密码").
    pub(crate) fn server() -> (Fixture, Auth) {
        let fixture = Fixture::new();
        write_password(&fixture.app_lock(), "管理员密码").unwrap();
        users::migrate(&fixture.database(), &fixture.app_lock()).unwrap();
        let auth = Auth::open(&fixture.database()).unwrap();
        (fixture, auth)
    }

    pub(crate) fn add_user(auth: &Auth, username: &str, password: &str) -> UserRecord {
        auth.users
            .create(
                username,
                None,
                Role::User,
                &crate::commands::hash_app_lock_password(password).unwrap(),
            )
            .unwrap()
    }

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

    #[tokio::test]
    async fn password_change_revokes_sessions_and_rejects_verification_of_old_hash() {
        let (_fixture, auth) = server();
        let (current, _) = auth.login("admin", "管理员密码".into()).await.unwrap();
        let (other, _) = auth.login("admin", "管理员密码".into()).await.unwrap();
        assert_eq!(
            auth.change_password(&current, "错误密码".into(), "新的密码".into())
                .await
                .unwrap_err(),
            AuthError::Rejected("当前密码错误".into())
        );
        assert!(auth.authenticated(&headers(&other)));
        auth.change_password(&current, "管理员密码".into(), "新的密码".into())
            .await
            .unwrap();
        assert!(auth.authenticated(&headers(&current)));
        assert!(!auth.authenticated(&headers(&other)));
        assert_eq!(
            auth.login("admin", "管理员密码".into()).await.unwrap_err(),
            AuthError::Invalid
        );
        assert!(auth.login("admin", "新的密码".into()).await.is_ok());
    }

    #[test]
    fn missing_credentials_fail_closed_and_cli_uses_application_lock_limits() {
        let root = std::env::temp_dir().join(format!("web-lock-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        assert!(migrate_credentials(&root).is_err());
        assert!(users::migrate(&root.join("db.sqlite3"), &root.join("app-lock.json")).is_err());
        assert!(write_password(&root.join("app-lock.json"), "短密码").is_err());
        assert!(write_password(&root.join("app-lock.json"), &"密".repeat(129)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sessions_require_exact_cookie_and_expire() {
        let (_fixture, auth) = server();
        let session = |expires_at| Session {
            user_id: "user".into(),
            role: Role::User,
            must_change_password: false,
            expires_at,
            admin_edit_until: None,
        };
        auth.sessions.lock().unwrap().extend([
            (
                "valid".to_owned(),
                session(Instant::now() + Duration::from_secs(10)),
            ),
            (
                "old".to_owned(),
                session(Instant::now() - Duration::from_secs(1)),
            ),
        ]);
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

    #[tokio::test]
    async fn admin_logs_in_with_the_original_password_and_any_username_case() {
        let (_fixture, auth) = server();
        let (token, user) = auth.login("admin", "管理员密码".into()).await.unwrap();
        assert_eq!(user.role, Role::Admin);
        assert!(
            matches!(auth.access(&headers(&token)), Access::Granted(s) if s.role == Role::Admin)
        );
        assert!(auth.login(" ADMIN ", "管理员密码".into()).await.is_ok());
        assert!(auth.login("Admin", "管理员密码".into()).await.is_ok());
    }

    #[tokio::test]
    async fn wrong_password_and_unknown_user_get_the_same_error() {
        let (_fixture, auth) = server();
        let wrong = auth.login("admin", "错误密码".into()).await.unwrap_err();
        let unknown = auth.login("nobody", "管理员密码".into()).await.unwrap_err();
        assert_eq!(wrong, AuthError::Invalid);
        assert_eq!(unknown, AuthError::Invalid);
        assert_eq!(
            wrong.into_response().status(),
            unknown.into_response().status()
        );
        // Deterministic: an unknown username runs exactly one Argon2
        // verification, like a wrong password does.
        let count = || auth.verifications.load(std::sync::atomic::Ordering::SeqCst);
        let before = count();
        let _ = auth.login("nobody2", "x".into()).await;
        assert_eq!(count() - before, 1, "unknown user");
        let before = count();
        let _ = auth.login("admin", "x".into()).await;
        assert_eq!(count() - before, 1, "wrong password");
        assert!(PasswordHash::new(&auth.dummy_hash).is_ok());
    }

    #[tokio::test]
    async fn one_username_locked_out_does_not_block_another() {
        let (_fixture, auth) = server();
        add_user(&auth, "bob", "鲍勃的密码");
        for _ in 0..LOGIN_LIMIT_PER_USERNAME {
            assert_eq!(
                auth.login("admin", "错误密码".into()).await.unwrap_err(),
                AuthError::Invalid
            );
        }
        assert_eq!(
            auth.login("ADMIN", "管理员密码".into()).await.unwrap_err(),
            AuthError::RateLimited
        );
        assert!(auth.login("bob", "鲍勃的密码".into()).await.is_ok());
    }

    #[test]
    fn limiter_window_and_site_wide_cap() {
        let mut limiter = Limiter::default();
        let start = Instant::now();
        for _ in 0..LOGIN_LIMIT_PER_USERNAME {
            assert!(limiter.acquire("a", None, start));
        }
        assert!(!limiter.acquire("a", None, start));
        assert!(limiter.acquire("a", None, start + LOGIN_WINDOW));
        let mut limiter = Limiter::default();
        for index in 0..LOGIN_LIMIT_TOTAL {
            assert!(limiter.acquire(&format!("user{index}"), None, start));
        }
        assert!(!limiter.acquire("fresh", None, start));
    }

    // c5 item 3: one address spraying random usernames is stopped at
    // LOGIN_LIMIT_PER_IP without using up the site-wide budget, so a user
    // from another address still gets in.
    #[test]
    fn one_address_cannot_use_up_the_site_wide_limit() {
        let mut limiter = Limiter::default();
        let start = Instant::now();
        let attacker: IpAddr = "203.0.113.7".parse().unwrap();
        let mut accepted = 0;
        for index in 0..LOGIN_LIMIT_TOTAL * 2 {
            if limiter.acquire(&format!("random{index}"), Some(attacker), start) {
                accepted += 1;
            }
        }
        assert_eq!(accepted, LOGIN_LIMIT_PER_IP);
        let colleague: IpAddr = "198.51.100.20".parse().unwrap();
        assert!(limiter.acquire("alice", Some(colleague), start));
        assert!(limiter.acquire("random0", Some(attacker), start + LOGIN_WINDOW));
    }

    // X-Forwarded-For is believed only from a trusted proxy, and then its
    // last entry (what the proxy saw); a client cannot spoof its address.
    #[test]
    fn forwarded_addresses_are_trusted_only_from_the_proxy() {
        let caddy: IpAddr = "127.0.0.1".parse().unwrap();
        let trusted = [caddy, "::1".parse().unwrap()];
        let forwarded = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("x-forwarded-for", value.parse().unwrap());
            headers
        };
        let ip = |text: &str| text.parse::<IpAddr>().unwrap();
        assert_eq!(
            client_ip(caddy, &forwarded("203.0.113.7"), &trusted),
            ip("203.0.113.7")
        );
        // A spoofed first entry is ignored: the proxy appended the real one.
        assert_eq!(
            client_ip(caddy, &forwarded("1.2.3.4, 203.0.113.7"), &trusted),
            ip("203.0.113.7")
        );
        assert_eq!(
            client_ip(ip("::1"), &forwarded("198.51.100.20"), &trusted),
            ip("198.51.100.20")
        );
        assert_eq!(
            client_ip(
                ip("::ffff:127.0.0.1"),
                &forwarded("198.51.100.20"),
                &trusted
            ),
            ip("198.51.100.20")
        );
        // Directly connected clients cannot choose their address.
        let direct = ip("192.168.5.50");
        assert_eq!(client_ip(direct, &forwarded("10.9.9.9"), &trusted), direct);
        // Malformed or missing headers fall back to the peer.
        assert_eq!(client_ip(caddy, &forwarded("not-an-ip"), &trusted), caddy);
        assert_eq!(client_ip(caddy, &HeaderMap::new(), &trusted), caddy);
        // Without trusted proxies nobody's header counts.
        assert_eq!(client_ip(caddy, &forwarded("203.0.113.7"), &[]), caddy);
    }

    #[tokio::test]
    async fn must_change_password_blocks_access_until_changed() {
        let (_fixture, auth) = server();
        add_user(&auth, "carol", "初始密码");
        let (token, user) = auth.login("carol", "初始密码".into()).await.unwrap();
        assert!(user.must_change_password);
        assert!(matches!(
            auth.access(&headers(&token)),
            Access::PasswordChangeRequired
        ));
        assert!(auth.authenticated(&headers(&token)));
        assert_eq!(
            auth.change_password(&token, "初始密码".into(), "初始密码".into())
                .await
                .unwrap_err(),
            AuthError::Rejected("新密码不能与当前密码相同".into())
        );
        let user = auth
            .change_password(&token, "初始密码".into(), "自己的密码".into())
            .await
            .unwrap();
        assert!(!user.must_change_password);
        assert!(matches!(auth.access(&headers(&token)), Access::Granted(_)));
        let (_, user) = auth.login("carol", "自己的密码".into()).await.unwrap();
        assert!(!user.must_change_password);
    }

    #[tokio::test]
    async fn disabled_accounts_cannot_log_in() {
        let (_fixture, auth) = server();
        let dave = add_user(&auth, "dave", "初始密码");
        auth.users.set_disabled(&dave.id, true).unwrap();
        assert_eq!(
            auth.login("dave", "错误密码".into()).await.unwrap_err(),
            AuthError::Invalid
        );
        assert_eq!(
            auth.login("dave", "初始密码".into()).await.unwrap_err(),
            AuthError::Disabled
        );
    }

    #[test]
    fn only_admins_pass_the_admin_permission() {
        let (_fixture, auth) = server();
        let session = |role| Session {
            user_id: "id".into(),
            role,
            must_change_password: false,
            expires_at: Instant::now(),
            admin_edit_until: None,
        };
        assert!(auth
            .authorize(&session(Role::Admin), &Permission::Admin)
            .is_ok());
        let denied = auth
            .authorize(&session(Role::User), &Permission::Admin)
            .unwrap_err();
        assert!(matches!(denied, Denied::Forbidden(_)));
        assert_eq!(denied.into_response().status(), StatusCode::FORBIDDEN);
    }
}
