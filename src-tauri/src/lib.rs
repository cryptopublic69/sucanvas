mod api;
mod commands;
mod db;
mod models;

use std::{
    collections::HashMap,
    net::TcpListener,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex, RwLock},
};

use api::ApiState;
use db::Database;
use models::{ApiConfig, RuntimeInfo, DEFAULT_CANVAS_ID};
use tauri::Manager;
use uuid::Uuid;

pub struct RunningComfyTask {
    cancelled: AtomicBool,
    submitted: AtomicBool,
    prompt_id: Mutex<Option<String>>,
    input_root_path: String,
    upload_subfolder: String,
    cleanup_started: AtomicBool,
}

#[derive(Clone)]
pub struct ApplicationState {
    database: Database,
    runtime: RuntimeInfo,
    assets_dir: PathBuf,
    active_canvas_id: Arc<RwLock<String>>,
    running_comfy_tasks: Arc<Mutex<HashMap<String, Arc<RunningComfyTask>>>>,
}

fn local_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_local_data_dir()?);
    Ok(root.join("InfiniteCanvas"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = local_data_dir(app)?;
            std::fs::create_dir_all(&data_dir)?;
            let assets_dir = data_dir.join("assets");
            std::fs::create_dir_all(&assets_dir)?;
            let database_path = data_dir.join("infinite-canvas.sqlite3");
            let config_path = data_dir.join("api.json");
            let database = Database::open(&database_path)?;
            let active_canvas_id = Arc::new(RwLock::new(DEFAULT_CANVAS_ID.to_owned()));

            let listener = TcpListener::bind("127.0.0.1:0")?;
            let address = listener.local_addr()?;
            let base_url = format!("http://{address}");
            let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            api::write_config(
                &config_path,
                &ApiConfig {
                    base_url: base_url.clone(),
                    token: token.clone(),
                    pid: std::process::id(),
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                },
            )?;

            app.manage(ApplicationState {
                database: database.clone(),
                runtime: RuntimeInfo {
                    base_url,
                    data_path: database_path.to_string_lossy().into_owned(),
                    canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                },
                assets_dir,
                active_canvas_id: active_canvas_id.clone(),
                running_comfy_tasks: Arc::new(Mutex::new(HashMap::new())),
            });

            let api_state = ApiState {
                database,
                token,
                app_handle: Some(app.handle().clone()),
                active_canvas_id,
            };
            tauri::async_runtime::spawn(async move {
                if let Err(error) = api::serve(listener, api_state).await {
                    eprintln!("InfiniteCanvas API stopped: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_workspace,
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            commands::create_node,
            commands::import_media,
            commands::update_node,
            commands::delete_node,
            commands::delete_nodes_undoable,
            commands::restore_deleted_nodes,
            commands::create_edge,
            commands::delete_edge,
            commands::submit_comfyui_workflow,
            commands::cancel_comfyui_workflow,
            commands::get_comfyui_queue_summary,
            commands::get_comfyui_h3_loras,
            commands::get_comfyui_client_task_statuses,
            commands::get_runtime_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running InfiniteCanvas");
}
