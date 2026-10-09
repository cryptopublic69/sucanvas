mod auth;
mod config;
mod connection;
mod dispatch;
mod files;
mod media;
mod proxy;
mod rpc;
mod settings;

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
    Json, Router,
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
}

impl WebState {
    fn connection_snapshot(mut self) -> Self {
        self.config = self.connection.snapshot();
        self
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
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                config_path = PathBuf::from(args.next().ok_or("--config requires a file path")?)
            }
            "--set-password" => set_password = true,
            "--help" => {
                println!("SuCanvasServer [--config <path>] [--set-password]\nPassword initialization reads one line from stdin. Paths are relative to config.json, not the current directory.");
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
    let auth_path = data.join("web-auth.json");
    if set_password {
        let mut password = String::new();
        std::io::stdin()
            .read_line(&mut password)
            .map_err(|e| e.to_string())?;
        auth::write_password(&auth_path, password.trim_end_matches(['\r', '\n']))?;
        println!("Login password updated.");
        return Ok(());
    }
    let auth = Arc::new(auth::Auth::read(&auth_path)?);
    let pending = app_backup::pending_directory(&data).map_err(|e| e.to_string())?;
    if pending.exists() {
        if !pending.join("infinite-canvas.sqlite3").is_file() {
            return Err("Pending restore is incomplete".into());
        }
        let previous = root.join(format!("data.before-restore-{}", uuid::Uuid::new_v4()));
        std::fs::rename(&data, &previous).map_err(|e| e.to_string())?;
        if let Err(error) = std::fs::rename(&pending, &data) {
            let _ = std::fs::rename(&previous, &data);
            return Err(error.to_string());
        }
        // Server login credentials are independent of imported desktop backups.
        std::fs::copy(previous.join("web-auth.json"), &auth_path).map_err(|e| e.to_string())?;
    }
    // Restore settings before accepting requests or mounting the canvas. Web
    // clients must never have to flush imported settings while reloading.
    settings::restore_frontend_settings(&data)?;
    for directory in [
        "assets",
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
        assets_dir: data.join("assets"),
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
    };
    let protected = Router::new()
        .route("/api/invoke/{command}", post(rpc::invoke))
        .route(
            "/api/upload",
            post(files::upload).layer(DefaultBodyLimit::max(state.config.max_upload_bytes)),
        )
        .route("/api/resource", get(files::resource))
        .route("/api/events", get(events))
        .route("/api/settings", get(read_settings).put(write_settings))
        .route(
            "/api/comfy-config",
            get(connection::read).put(connection::write),
        )
        .route("/api/comfy/ws", get(proxy::websocket))
        .route("/api/comfy/{*path}", get(proxy::http))
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
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())
}

async fn require_session(
    State(state): State<WebState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !state.auth.authenticated(request.headers()) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "请登录"}))).into_response();
    }
    next.run(request).await
}
fn same_origin(state: &WebState, headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|origin| origin == state.config.origin())
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
    if !bearer && !state.auth.authenticated(request.headers()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
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
async fn events(State(state): State<WebState>, headers: HeaderMap) -> impl IntoResponse {
    let receiver = state.handle.events.subscribe();
    let stream = futures_util::stream::unfold(
        (receiver, state, headers),
        |(mut receiver, state, headers)| async move {
            loop {
                if !state.auth.authenticated(&headers) {
                    return None;
                }
                match tokio::time::timeout(Duration::from_secs(15), receiver.recv()).await {
                    Ok(Ok(mut value)) => {
                        rpc::normalize_result(&state.clone().connection_snapshot(), &mut value);
                        return Some((
                            Ok::<_, Infallible>(Event::default().data(value.to_string())),
                            (receiver, state, headers),
                        ));
                    }
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return None,
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                        return Some((
                            Ok(Event::default().data(
                                json!({"event": "canvas://resync", "payload": null}).to_string(),
                            )),
                            (receiver, state, headers),
                        ))
                    }
                    Err(_) => {
                        return Some((
                            Ok(Event::default().comment("heartbeat")),
                            (receiver, state, headers),
                        ))
                    }
                }
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
        state.config.comfy_input_directory.clone(),
    );
    settings.insert(
        "infinite-canvas:comfy-output-root".to_owned(),
        state.config.comfy_output_directory.clone(),
    );
    Json(settings)
}
async fn write_settings(
    State(state): State<WebState>,
    Json(mut settings): Json<BTreeMap<String, String>>,
) -> Response {
    settings.retain(|key, _| key.starts_with("infinite-canvas:"));
    let _guard = state.settings_guard.lock().await;
    match settings::write(&state.core.data_dir, &settings) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
