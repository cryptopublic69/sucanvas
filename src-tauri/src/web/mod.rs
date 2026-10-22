mod accounts;
mod auth;
mod authz;
mod backup;
mod canvases;
mod config;
mod connection;
mod dispatch;
mod files;
mod media;
mod media_cleanup;
mod ownership;
mod posters;
mod presence;
mod proxy;
mod rpc;
mod settings;
mod storage;
mod tasks;
mod thumbnails;
mod users;
mod ws_handover;

use crate::{
    api::{self, ApiState},
    app_backup,
    db::Database,
    models::{ApiConfig, RuntimeInfo, DEFAULT_CANVAS_ID},
    platform::AppHandle,
    ApplicationState, CanvasSelectionState,
};
use axum::{
    body::{to_bytes, Body},
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Extension, Json, Router,
};
use fs2::FileExt;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub(crate) struct WebState {
    core: Arc<ApplicationState>,
    config: Arc<config::Config>,
    connection: Arc<connection::Store>,
    auth: Arc<auth::Auth>,
    handle: AppHandle,
    downloads: PathBuf,
    token: String,
    client: reqwest::Client,
    settings_guard: Arc<tokio::sync::Mutex<()>>,
    media_guard: Arc<tokio::sync::Mutex<()>>,
    tasks: Arc<tasks::Tasks>,
    comfy_relays: Arc<ws_handover::Registry>,
    presence: Arc<presence::Presence>,
    media: Arc<media_cleanup::MediaRegistry>,
}

impl WebState {
    fn connection_snapshot(mut self) -> Self {
        self.config = self.connection.snapshot();
        let mut core = (*self.core).clone();
        core.assets_dir =
            PathBuf::from(&self.config.comfy_input_directory).join(storage::IMPORT_FOLDER);
        self.core = Arc::new(core);
        self
    }

    // Media folders of the current configuration (a ComfyUI folder that is
    // not configured is simply not managed).
    fn media_roots(&self) -> media_cleanup::MediaRoots {
        let configured =
            |directory: &str| (!directory.trim().is_empty()).then(|| PathBuf::from(directory));
        media_cleanup::MediaRoots {
            input: configured(&self.config.comfy_input_directory),
            output: configured(&self.config.comfy_output_directory),
            data: self.core.data_dir.clone(),
        }
    }

    // Recomputes media references in the background; `actor` is the user
    // whose deletion may have released files. Requests are merged (one pass
    // running, one queued); failures only delay cleanup.
    fn refresh_media(&self, actor: Option<String>) {
        let state = self.clone().connection_snapshot();
        state
            .media
            .schedule_refresh(state.media_roots(), actor.as_deref(), |job| {
                tokio::task::spawn_blocking(job);
            });
    }
}

pub async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let executable_root = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Missing executable root")?
        .to_owned();
    let mut config_path = executable_root.join("config.json");
    let mut set_password = false;
    let mut reset_admin_password = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                config_path = PathBuf::from(args.next().ok_or("--config requires a file path")?)
            }
            "--set-password" => set_password = true,
            "--reset-admin-password" => reset_admin_password = true,
            "--help" => {
                println!("SuCanvasServer [--config <path>] [--set-password | --reset-admin-password]\nBoth password options read one line from stdin (never from the command line) and require the server to be stopped.\n--set-password sets the application lock (app-lock.json); it creates the first admin account on the next start but does not change an existing account.\n--reset-admin-password sets the password of the \"admin\" account and makes it an enabled admin again. Paths are relative to config.json, not the current directory.");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }
    let config_path = config_path
        .canonicalize()
        .map_err(|e| format!("Cannot read config.json: {e}"))?;
    let root = config_path.parent().unwrap().to_owned();
    let mut config = config::Config::read(&config_path)?;
    let data = config::Config::directory(&root, &config.data_directory);
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let data = data.canonicalize().map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("server.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive().map_err(|_| "This deployment is already running. Stop it before changing its password or restoring a backup.".to_owned())?;
    let auth_path = data.join("app-lock.json");
    if set_password {
        let mut password = String::new();
        std::io::stdin()
            .read_line(&mut password)
            .map_err(|e| e.to_string())?;
        auth::write_password(&auth_path, password.trim_end_matches(['\r', '\n']))?;
        println!("Application lock password updated. Web sign-in uses accounts once they exist; to recover the admin account use --reset-admin-password.");
        return Ok(());
    }
    if reset_admin_password {
        // Local only (no HTTP route). server.lock above guarantees the server is
        // stopped, so no signed-in session survives: sessions live in memory.
        let mut password = String::new();
        std::io::stdin()
            .read_line(&mut password)
            .map_err(|e| e.to_string())?;
        let password = password.trim_end_matches(['\r', '\n']);
        crate::commands::validate_new_app_lock_password(password)?;
        let database_path = data.join("infinite-canvas.sqlite3");
        // A deployment that never started this version gets its accounts first.
        Database::open(&database_path).map_err(|e| e.to_string())?;
        users::migrate(&database_path, &auth_path)?;
        users::reset_admin_password(
            &database_path,
            &crate::commands::hash_app_lock_password(password)?,
        )?;
        println!("Password of the admin account reset; it is an enabled admin and no password change is required.");
        return Ok(());
    }
    auth::migrate_credentials(&data)?;
    let pending = app_backup::pending_directory(&data).map_err(|e| e.to_string())?;
    if pending.exists() {
        if !pending.join("infinite-canvas.sqlite3").is_file() {
            return Err("Pending restore is incomplete".into());
        }
        // Preserve access credentials before replacing the active directory.
        std::fs::copy(&auth_path, pending.join("app-lock.json")).map_err(|e| e.to_string())?;
        let previous = root.join(format!("data.before-restore-{}", uuid::Uuid::new_v4()));
        std::fs::rename(&data, &previous).map_err(|e| e.to_string())?;
        if let Err(error) = std::fs::rename(&pending, &data) {
            let _ = std::fs::rename(&previous, &data);
            return Err(error.to_string());
        }
    }
    auth::migrate_credentials(&data)?;
    // Restore settings before accepting requests or mounting the canvas. Web
    // clients must never have to flush imported settings while reloading.
    settings::restore_frontend_settings(&data)?;
    for directory in [
        "uploads",
        "temp/image-resize",
        "workflow-modules",
        "workflow-module-exports",
    ] {
        std::fs::create_dir_all(data.join(directory)).map_err(|e| e.to_string())?;
    }
    let downloads = config::Config::directory(&root, &config.downloads_directory);
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let downloads = downloads.canonicalize().map_err(|e| e.to_string())?;
    let web = config::Config::directory(&root, &config.web_directory);
    if !web.join("index.html").is_file() {
        return Err(format!("Web build is missing: {}", web.display()));
    }
    connection::resolve_directories(&mut config, &root)?;
    crate::portable::set_root(data.clone())?;
    let database =
        Database::open(&data.join("infinite-canvas.sqlite3")).map_err(|e| e.to_string())?;
    database.verify_integrity().map_err(|e| e.to_string())?;
    // Accounts: the first start creates "admin" from app-lock.json; a failed
    // migration stops the server before it accepts requests.
    let database_path = data.join("infinite-canvas.sqlite3");
    users::migrate(&database_path, &auth_path)?;
    let auth = Arc::new(auth::Auth::open(&database_path)?);
    let media = Arc::new(media_cleanup::MediaRegistry::open(&database_path)?);
    let active_canvas_id = Arc::new(RwLock::new(DEFAULT_CANVAS_ID.to_owned()));
    let selection = Arc::new(RwLock::new(CanvasSelectionState::default()));
    let (event_sender, _) = tokio::sync::broadcast::channel(512);
    let handle = AppHandle {
        root: root.clone(),
        events: event_sender,
    };
    let token_path = data.join("web-integration-token");
    let token = if token_path.is_file() {
        std::fs::read_to_string(&token_path).map_err(|e| e.to_string())?
    } else {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        std::fs::write(&token_path, &token).map_err(|e| e.to_string())?;
        token
    };
    api::write_config(
        &data.join("api.json"),
        &ApiConfig {
            base_url: config.origin(),
            token: token.clone(),
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
    )
    .map_err(|e| e.to_string())?;
    let api_state = ApiState {
        database: database.clone(),
        token: token.clone(),
        app_handle: Some(handle.clone()),
        active_canvas_id: active_canvas_id.clone(),
        current_canvas_selection: selection.clone(),
    };
    let core = ApplicationState {
        database,
        runtime: RuntimeInfo {
            base_url: config.origin(),
            data_path: data
                .join("infinite-canvas.sqlite3")
                .to_string_lossy()
                .into_owned(),
            canvas_id: DEFAULT_CANVAS_ID.to_owned(),
        },
        assets_dir: PathBuf::from(&config.comfy_input_directory).join(storage::IMPORT_FOLDER),
        workflow_modules_dir: data.join("workflow-modules"),
        workflow_module_exports_dir: data.join("workflow-module-exports"),
        app_lock_path: data.join("app-lock.json"),
        data_dir: data,
        app_lock_guard: Arc::new(Mutex::new(())),
        active_canvas_id,
        current_canvas_selection: selection,
        running_comfy_tasks: Arc::new(Mutex::new(HashMap::new())),
    };
    let state = WebState {
        core: Arc::new(core),
        auth,
        connection: Arc::new(connection::Store::new(config_path, config.clone())),
        config: Arc::new(config),
        presence: Arc::new(presence::Presence::new(handle.clone())),
        media,
        handle,
        downloads,
        token,
        client: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?,
        settings_guard: Arc::new(tokio::sync::Mutex::new(())),
        media_guard: Arc::new(tokio::sync::Mutex::new(())),
        tasks: Arc::new(tasks::Tasks::default()),
        comfy_relays: Arc::default(),
    };
    // Presence: tabs without a heartbeat for presence::TIMEOUT_SECONDS leave.
    let sweeper = state.presence.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(presence::SWEEP_SECONDS));
        loop {
            interval.tick().await;
            sweeper.sweep(std::time::Instant::now());
        }
    });
    if let Err(error) = storage::migrate(&state) {
        // Keep the settings UI and existing project references available for
        // correcting an unavailable mapping. Saving settings retries migration.
        eprintln!("旧素材迁移未完成，保留原数据：{error}");
    }
    // Orphan media: register stock and new references, start grace periods,
    // expire old trash; at start and every media_cleanup::REFRESH_HOURS.
    let refresher = state.clone();
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(media_cleanup::REFRESH_HOURS * 3600));
        loop {
            interval.tick().await;
            refresher.refresh_media(None);
        }
    });
    let protected = Router::new()
        .route("/api/invoke/{command}", post(rpc::invoke))
        .route("/api/generation-tasks/{id}", get(tasks::read))
        .route(
            "/api/upload",
            post(files::upload).layer(DefaultBodyLimit::max(state.config.max_upload_bytes)),
        )
        .route("/api/resource", get(files::resource))
        .route("/api/thumbnail", get(thumbnails::thumbnail))
        .route("/api/video-poster", get(posters::image))
        .route("/api/events", get(events))
        .route("/api/settings", get(read_settings).put(write_settings))
        .route(
            "/api/comfy-config",
            get(connection::read).put(connection::write),
        )
        .route("/api/comfy/ws", get(proxy::websocket))
        .route("/api/comfy/{*path}", get(proxy::http))
        .route("/api/auth/edit-mode", post(auth::edit_mode))
        .route(
            "/api/admin/users",
            get(accounts::list).post(accounts::create),
        )
        .route(
            "/api/admin/users/{id}/password",
            post(accounts::reset_password),
        )
        .route(
            "/api/admin/users/{id}/disabled",
            post(accounts::set_disabled),
        )
        .route("/api/admin/users/{id}/role", post(accounts::set_role))
        .route(
            "/api/admin/users/{id}/display-name",
            post(accounts::set_display_name),
        )
        .route("/api/admin/users/{id}/delete", post(accounts::delete))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));
    let legacy = api::router(api_state).layer(middleware::from_fn_with_state(
        state.clone(),
        legacy_adapter,
    ));
    let router = Router::new()
        .merge(protected)
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/session", get(auth::session))
        .route("/api/auth/password", post(auth::change_password))
        .fallback_service(
            ServeDir::new(&web).not_found_service(ServeFile::new(web.join("index.html"))),
        )
        .with_state(state.clone())
        .merge(legacy)
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), check_origin));
    let listener = tokio::net::TcpListener::bind(state.config.listen)
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "SuCanvas Web listening on {} (public URL: {})",
        listener.local_addr().unwrap(),
        state.config.origin()
    );
    // The peer address is needed for login rate limiting (auth::client_ip).
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .map_err(|e| e.to_string())
}

async fn require_session(
    State(state): State<WebState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    match state.auth.access(request.headers()) {
        auth::Access::Missing => {
            (StatusCode::UNAUTHORIZED, Json(json!({"error": "请登录"}))).into_response()
        }
        // Only session, logout and the password change stay reachable.
        auth::Access::PasswordChangeRequired => auth::password_change_required(),
        auth::Access::Granted(session) => {
            request.extensions_mut().insert(session);
            next.run(request).await
        }
    }
}
fn same_origin(state: &WebState, headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|origin| state.config.allows_origin(origin))
}
async fn check_origin(
    State(state): State<WebState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let websocket = request.headers().get(header::UPGRADE).is_some();
    let mutation = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    let integration = request.uri().path().starts_with("/v1/")
        && request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == format!("Bearer {}", state.token));
    if (mutation || websocket) && !integration && !same_origin(&state, request.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "same-origin".parse().unwrap());
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'".parse().unwrap());
    if response.headers().get(header::CACHE_CONTROL).is_none() {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    response
}
async fn legacy_adapter(
    State(state): State<WebState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let state = state.connection_snapshot();
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {}", state.token));
    if !bearer {
        match state.auth.access(request.headers()) {
            auth::Access::Missing => return StatusCode::UNAUTHORIZED.into_response(),
            auth::Access::PasswordChangeRequired => return auth::password_change_required(),
            // The /v1 integration interface is a global resource: the bearer
            // token counts as admin; signed-in users must be admins.
            auth::Access::Granted(session) => {
                if let Err(denied) = state.auth.authorize(&session, &auth::Permission::Admin) {
                    return denied.into_response();
                }
            }
        }
    }
    let _storage_guard = if !matches!(*request.method(), Method::GET | Method::HEAD) {
        Some(state.media_guard.clone().lock_owned().await)
    } else {
        None
    };
    let state = state.connection_snapshot();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {}", state.token).parse().unwrap(),
    );
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::DELETE
    ) {
        let (mut parts, body) = request.into_parts();
        let bytes = match to_bytes(body, 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        };
        let mut value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        if let Err(error) = rpc::normalize_args(&state, &mut value, "") {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response();
        }
        parts.headers.remove(header::CONTENT_LENGTH);
        request = Request::from_parts(parts, Body::from(serde_json::to_vec(&value).unwrap()));
    }
    let response = next.run(request).await;
    let (mut parts, body) = response.into_parts();
    let bytes = match to_bytes(body, 128 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
        rpc::normalize_result(&state, &mut value);
        parts.headers.remove(header::CONTENT_LENGTH);
        Response::from_parts(parts, Body::from(serde_json::to_vec(&value).unwrap()))
    } else {
        Response::from_parts(parts, Body::from(bytes))
    }
}
// Routing for /api/events: progress goes to the user who started it, canvas
// events to users who may read the canvas, anything else to admins only
// (canvas://resync carries no content and reaches everyone). Returns the
// message without its routing fields, or None when it must not be sent.
fn deliverable(state: &WebState, session: &auth::Session, mut message: Value) -> Option<Value> {
    deliverable_with(state.auth.ownership(), session, &message).then(|| {
        if let Some(fields) = message.as_object_mut() {
            fields.remove("canvasId");
            fields.remove("userId");
        }
        message
    })
}
fn deliverable_with(
    ownership: &ownership::Ownership,
    session: &auth::Session,
    message: &Value,
) -> bool {
    if let Some(user_id) = message.get("userId").and_then(Value::as_str) {
        return user_id == session.user_id;
    }
    if let Some(canvas_id) = message.get("canvasId").and_then(Value::as_str) {
        return authz::may_read(ownership, session, canvas_id);
    }
    message.get("event").and_then(Value::as_str) == Some("canvas://resync")
        || session.role == users::Role::Admin
}
async fn events(State(state): State<WebState>, headers: HeaderMap) -> impl IntoResponse {
    let receiver = state.handle.events.subscribe();
    let stream = futures_util::stream::unfold(
        (receiver, state, headers),
        |(mut receiver, state, headers)| async move {
            if !state.auth.authenticated(&headers) {
                return None;
            }
            match tokio::time::timeout(Duration::from_secs(15), receiver.recv()).await {
                Ok(Ok(message)) => {
                    let session = state.auth.current(&headers)?;
                    // Events the receiver may not see become a comment, so the
                    // stream stays alive without revealing anything.
                    let event = match deliverable(&state, &session, message) {
                        Some(mut value) => {
                            rpc::normalize_result(&state.clone().connection_snapshot(), &mut value);
                            Event::default().data(value.to_string())
                        }
                        None => Event::default().comment("filtered"),
                    };
                    Some((Ok::<_, Infallible>(event), (receiver, state, headers)))
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => None,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                    if !state.auth.authenticated(&headers) {
                        return None;
                    }
                    Some((
                        Ok(Event::default().data(
                            json!({"event": "canvas://resync", "payload": null}).to_string(),
                        )),
                        (receiver, state, headers),
                    ))
                }
                Err(_) => Some((
                    Ok(Event::default().comment("heartbeat")),
                    (receiver, state, headers),
                )),
            }
        },
    );
    let ready = futures_util::stream::once(async {
        Ok::<_, Infallible>(
            Event::default().data(json!({"event": "web://ready", "payload": null}).to_string()),
        )
    });
    Sse::new(ready.chain(stream)).keep_alive(KeepAlive::default())
}
async fn read_settings(State(state): State<WebState>) -> impl IntoResponse {
    let state = state.connection_snapshot();
    let _guard = state.settings_guard.lock().await;
    let path = state.core.data_dir.join("web-settings.json");
    let mut settings: BTreeMap<String, String> = std::fs::read(&path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    settings.insert(
        "infinite-canvas:comfy-server-url".to_owned(),
        format!("{}/api/comfy", state.config.origin()),
    );
    settings.insert(
        "infinite-canvas:comfy-input-root".to_owned(),
        connection::display_directory(&state.config.comfy_input_directory),
    );
    settings.insert(
        "infinite-canvas:comfy-output-root".to_owned(),
        connection::display_directory(&state.config.comfy_output_directory),
    );
    Json(settings)
}
async fn write_settings(
    State(state): State<WebState>,
    Extension(session): Extension<auth::Session>,
    Json(mut settings): Json<BTreeMap<String, String>>,
) -> Response {
    // web-settings.json is shared by everyone; other users read it only (su item 4).
    if let Err(denied) = state.auth.authorize(&session, &auth::Permission::Admin) {
        return denied.into_response();
    }
    settings.retain(|key, _| key.starts_with("infinite-canvas:"));
    let state = state.connection_snapshot();
    let _guard = state.settings_guard.lock().await;
    storage::normalize_settings(&state, &mut settings);
    match settings::write(&state.core.data_dir, &settings) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::authz::tests::world;
    use super::*;

    // /api/events routing: A's private canvas never reaches B; admins see it;
    // progress goes to its user; unrouted messages reach admins only.
    #[test]
    fn events_reach_only_receivers_who_may_read_their_canvas() {
        let world = world();
        let alices = world.project(&world.alice, false);
        let shared = world.project(&world.bob, true);
        let event = |canvas: &str| json!({"event": "canvas://node-updated", "payload": {"canvasId": canvas}, "canvasId": canvas});
        let store = world.store();
        assert!(deliverable_with(store, &world.alice, &event(&alices)));
        assert!(!deliverable_with(store, &world.bob, &event(&alices)));
        assert!(deliverable_with(store, &world.admin, &event(&alices)));
        assert!(deliverable_with(store, &world.alice, &event(&shared)));
        // Deleted canvas (or unknown id): admins only.
        assert!(!deliverable_with(
            store,
            &world.alice,
            &event("canvas:gone")
        ));
        assert!(deliverable_with(store, &world.admin, &event("canvas:gone")));
        let progress =
            json!({"event": "channel:abc", "payload": null, "userId": world.alice.user_id});
        assert!(deliverable_with(store, &world.alice, &progress));
        assert!(!deliverable_with(store, &world.bob, &progress));
        assert!(!deliverable_with(store, &world.admin, &progress));
        let unrouted = json!({"event": "canvas://node-deleted", "payload": "node:1"});
        assert!(!deliverable_with(store, &world.alice, &unrouted));
        assert!(deliverable_with(store, &world.admin, &unrouted));
        let resync = json!({"event": "canvas://resync", "payload": {}});
        assert!(deliverable_with(store, &world.bob, &resync));
    }
}
