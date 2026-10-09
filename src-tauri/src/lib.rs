mod api;
#[cfg(all(feature = "desktop", feature = "server"))]
compile_error!(
    "Build desktop and server separately. For Web use --no-default-features --features server."
);
mod app_backup;
mod commands;
mod db;
#[cfg(feature = "desktop")]
mod desktop;
mod models;
mod platform;
mod portable;
mod video_posters;
mod video_upscale;
mod workflow_modules;
#[cfg(feature = "desktop")]
pub use desktop::run;
#[cfg(feature = "server")]
pub mod web;

use db::Database;
use models::RuntimeInfo;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex, RwLock},
};
pub struct RunningComfyTask {
    cancelled: AtomicBool,
    submitted: AtomicBool,
    prompt_id: Mutex<Option<String>>,
    input_root_path: String,
    upload_subfolder: String,
    cleanup_started: AtomicBool,
}

#[derive(Clone, Default)]
pub struct CanvasSelectionState {
    pub canvas_id: Option<String>,
    pub node_ids: Vec<String>,
    pub updated_at: String,
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
    current_canvas_selection: Arc<RwLock<CanvasSelectionState>>,
    running_comfy_tasks: Arc<Mutex<HashMap<String, Arc<RunningComfyTask>>>>,
}
