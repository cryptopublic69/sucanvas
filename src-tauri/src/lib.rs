mod api;
mod app_backup;
mod commands;
mod db;
mod models;
mod workflow_modules;

use std::{
    collections::HashMap,
    io,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex, RwLock},
};

use api::ApiState;
use db::Database;
use models::{ApiConfig, RuntimeInfo, DEFAULT_CANVAS_ID};
use tauri::Manager;
use uuid::Uuid;

const DATA_DIR: &str = r"D:\Data\SuCanvasData\data";
const DATABASE_FILE: &str = "infinite-canvas.sqlite3";

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
    data_dir: PathBuf,
    assets_dir: PathBuf,
    workflow_modules_dir: PathBuf,
    workflow_module_exports_dir: PathBuf,
    app_lock_path: PathBuf,
    app_lock_guard: Arc<Mutex<()>>,
    active_canvas_id: Arc<RwLock<String>>,
    running_comfy_tasks: Arc<Mutex<HashMap<String, Arc<RunningComfyTask>>>>,
}

fn apply_pending_restore(data_dir: &Path) -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let pending_dir = app_backup::pending_directory(data_dir)?;
    if !pending_dir.exists() {
        return Ok(None);
    }
    if !pending_dir.join(DATABASE_FILE).is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "pending SuCanvas restore does not contain {}",
                DATABASE_FILE
            ),
        )
        .into());
    }

    let previous_dir = data_dir
        .parent()
        .unwrap()
        .join(format!("data.before-restore-{}", Uuid::new_v4().simple()));
    if data_dir.exists() {
        std::fs::rename(data_dir, &previous_dir)?;
    }
    if let Err(error) = std::fs::rename(&pending_dir, data_dir) {
        if previous_dir.exists() {
            let _ = std::fs::rename(&previous_dir, data_dir);
        }
        return Err(error.into());
    }
    Ok(previous_dir.exists().then_some(previous_dir))
}

fn legacy_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_local_data_dir()?);
    Ok(root.join("InfiniteCanvas"))
}

fn copy_directory(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            std::fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn prepare_data_dir(app: &tauri::App) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let data_dir = PathBuf::from(DATA_DIR);
    let legacy_dir = legacy_data_dir(app)?;
    if let Some(previous_dir) = apply_pending_restore(&data_dir)? {
        eprintln!(
            "Restored SuCanvas backup; previous data was preserved at {}",
            previous_dir.display()
        );
    }
    let database_path = data_dir.join(DATABASE_FILE);
    let legacy_database_path = legacy_dir.join(DATABASE_FILE);

    if database_path.is_file() || !legacy_database_path.is_file() {
        std::fs::create_dir_all(&data_dir)?;
        return Ok((data_dir, legacy_dir));
    }

    if data_dir.exists() {
        let mut entries = std::fs::read_dir(&data_dir)?;
        if entries.next().transpose()?.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "cannot migrate SuCanvas data: {} exists but does not contain {}",
                    data_dir.display(),
                    DATABASE_FILE
                ),
            )
            .into());
        }
        std::fs::remove_dir(&data_dir)?;
    }

    let parent = data_dir.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "SuCanvas data path has no parent",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let directory_name = data_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let staging_dir = parent.join(format!(
        ".{directory_name}.migrating-{}",
        Uuid::new_v4().simple()
    ));

    if let Err(error) = copy_directory(&legacy_dir, &staging_dir) {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(error.into());
    }
    if !staging_dir.join(DATABASE_FILE).is_file() {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "copied SuCanvas data does not contain its database",
        )
        .into());
    }
    if let Err(error) = std::fs::rename(&staging_dir, &data_dir) {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(error.into());
    }

    eprintln!(
        "Migrated SuCanvas data from {} to {}; the source was preserved",
        legacy_dir.display(),
        data_dir.display()
    );
    Ok((data_dir, legacy_dir))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let (data_dir, legacy_dir) = prepare_data_dir(app)?;
            let assets_dir = data_dir.join("assets");
            std::fs::create_dir_all(&assets_dir)?;
            let workflow_modules_dir = data_dir.join("workflow-modules");
            std::fs::create_dir_all(&workflow_modules_dir)?;
            let workflow_module_exports_dir = data_dir.join("workflow-module-exports");
            std::fs::create_dir_all(&workflow_module_exports_dir)?;
            let database_path = data_dir.join(DATABASE_FILE);
            let config_path = data_dir.join("api.json");
            let compatibility_config_path = legacy_dir.join("api.json");
            let app_lock_path = data_dir.join("app-lock.json");
            let database = Database::open(&database_path)?;
            let rewritten_nodes =
                database.rewrite_asset_paths(&legacy_dir.join("assets"), &assets_dir)?;
            if rewritten_nodes > 0 {
                eprintln!("Updated asset paths in {rewritten_nodes} migrated canvas nodes");
            }
            let active_canvas_id = Arc::new(RwLock::new(DEFAULT_CANVAS_ID.to_owned()));

            let listener = TcpListener::bind("127.0.0.1:0")?;
            let address = listener.local_addr()?;
            let base_url = format!("http://{address}");
            let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            let api_config = ApiConfig {
                base_url: base_url.clone(),
                token: token.clone(),
                pid: std::process::id(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
            };
            api::write_config(&config_path, &api_config)?;
            if compatibility_config_path != config_path {
                api::write_config(&compatibility_config_path, &api_config)?;
            }

            app.manage(ApplicationState {
                database: database.clone(),
                runtime: RuntimeInfo {
                    base_url,
                    data_path: database_path.to_string_lossy().into_owned(),
                    canvas_id: DEFAULT_CANVAS_ID.to_owned(),
                },
                data_dir,
                assets_dir,
                workflow_modules_dir,
                workflow_module_exports_dir,
                app_lock_path,
                app_lock_guard: Arc::new(Mutex::new(())),
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
                    eprintln!("SuCanvas API stopped: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_workspace,
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::set_project_private,
            commands::delete_project,
            commands::create_node,
            commands::import_media,
            commands::update_node,
            commands::delete_node,
            commands::delete_video_files,
            commands::delete_nodes_undoable,
            commands::restore_deleted_nodes,
            commands::create_edge,
            commands::delete_edge,
            commands::submit_comfyui_workflow,
            commands::cancel_comfyui_workflow,
            commands::get_comfyui_queue_summary,
            commands::get_comfyui_h3_loras,
            commands::get_comfyui_h3_diffusion_models,
            commands::get_comfyui_client_task_statuses,
            commands::export_app_backup,
            commands::stage_app_backup_restore,
            commands::take_restored_frontend_settings,
            commands::list_workflow_modules,
            commands::save_workflow_module,
            commands::validate_workflow_module_source,
            commands::trash_workflow_module,
            commands::restore_workflow_module,
            commands::purge_workflow_module,
            commands::restore_workflow_module_backup,
            commands::export_workflow_module,
            commands::import_workflow_module_bundle,
            commands::restore_workflow_module_bundle,
            commands::get_runtime_info,
            commands::get_app_lock_status,
            commands::verify_app_lock_password,
            commands::set_app_lock_password,
            commands::disable_app_lock,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SuCanvas");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_pending_restore_and_preserves_previous_data() {
        let root = std::env::temp_dir().join(format!(
            "sucanvas-pending-restore-test-{}",
            Uuid::new_v4().simple()
        ));
        let data_dir = root.join("data");
        let pending_dir = app_backup::pending_directory(&data_dir).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::create_dir_all(&pending_dir).unwrap();
        std::fs::write(data_dir.join(DATABASE_FILE), b"previous").unwrap();
        std::fs::write(pending_dir.join(DATABASE_FILE), b"restored").unwrap();

        let previous_dir = apply_pending_restore(&data_dir).unwrap().unwrap();

        assert_eq!(
            std::fs::read(data_dir.join(DATABASE_FILE)).unwrap(),
            b"restored"
        );
        assert_eq!(
            std::fs::read(previous_dir.join(DATABASE_FILE)).unwrap(),
            b"previous"
        );
        assert!(!pending_dir.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
