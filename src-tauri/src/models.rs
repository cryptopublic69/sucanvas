use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const DEFAULT_CANVAS_ID: &str = "canvas:main";

fn empty_object() -> Value {
    Value::Object(Map::new())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRecord {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRecord {
    pub id: String,
    pub canvas_id: String,
    pub kind: String,
    pub title: String,
    pub content: Value,
    pub source: String,
    pub request_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRecord {
    pub id: String,
    pub canvas_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub kind: String,
    pub metadata: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedBatch {
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteNodesInput {
    pub ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub canvas: CanvasRecord,
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInput {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodeInput {
    #[serde(default)]
    pub canvas_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default = "empty_object")]
    pub content: Value,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNodeInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEdgeInput {
    #[serde(default)]
    pub canvas_id: Option<String>,
    pub source_node_id: String,
    pub target_node_id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default = "empty_object")]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodeResult {
    pub node: NodeRecord,
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub base_url: String,
    pub data_path: String,
    pub canvas_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfySubmitInput {
    pub server_url: String,
    pub workflow_path: String,
    #[serde(default)]
    pub input_root_path: String,
    pub client_id: String,
    pub prompt: String,
    pub seed_mode: String,
    pub seed: String,
    pub duration_seconds: f64,
    pub primary_resolution_megapixels: f64,
    pub secondary_resolution_megapixels: f64,
    pub secondary_sampling_enabled: bool,
    pub lora_name: String,
    #[serde(default = "default_lora_strength")]
    pub lora_strength: f64,
    #[serde(default)]
    pub image_paths: Vec<String>,
    #[serde(default)]
    pub audio_paths: Vec<String>,
    #[serde(default)]
    pub video_paths: Vec<String>,
    #[serde(default)]
    pub secondary_source: Option<ComfyOutputFile>,
}

fn default_lora_strength() -> f64 {
    1.0
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyOutputFile {
    pub filename: String,
    pub subfolder: String,
    pub file_type: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfySubmitResult {
    pub prompt_id: String,
    pub seed: String,
    pub outputs: Vec<ComfyOutputFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_elapsed_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyQueueSummary {
    pub running_count: usize,
    pub pending_count: usize,
    pub total_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyClientTaskStatus {
    pub client_id: String,
    pub prompt_id: Option<String>,
    pub status: String,
    pub seed: Option<String>,
    pub outputs: Vec<ComfyOutputFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_elapsed_seconds: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConfig {
    pub base_url: String,
    pub token: String,
    pub pid: u32,
    pub version: String,
}
