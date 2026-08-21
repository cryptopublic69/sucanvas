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
    pub is_private: bool,
    pub preview_image_path: Option<String>,
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
    #[serde(default)]
    pub prompt_scene_bindings: Vec<PromptSceneBindingRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptSceneBindingRecord {
    pub prompt_set_id: String,
    pub prompt_set_title: String,
    pub canvas_id: String,
    pub scene_key: String,
    pub scene_title: String,
    pub node_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersionRecord {
    pub id: String,
    pub label: String,
    pub title: String,
    pub text: String,
    pub information: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_selection: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_options: Option<PromptGenerationOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_override_seconds: Option<u8>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived_from: Vec<ContentVersionSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptGenerationOptions {
    pub duration_seconds: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentVersionSource {
    pub node_id: String,
    pub version_id: String,
    #[serde(default)]
    pub version_label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptSceneBinding {
    pub prompt_set_id: String,
    pub prompt_set_title: String,
    pub canvas_id: String,
    pub canvas_name: String,
    pub scene_key: String,
    pub scene_title: String,
    pub node_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub latest_version: Option<String>,
    pub version_count: usize,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptSetSummary {
    pub prompt_set_id: String,
    pub title: String,
    pub canvas_id: String,
    pub canvas_name: String,
    pub scene_count: usize,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSetScenesResult {
    pub prompt_set: PromptSetSummary,
    pub scenes: Vec<PromptSceneBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePromptSceneInput {
    pub scene_key: String,
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub information: String,
    #[serde(default)]
    pub reference_selection: Option<serde_json::Value>,
    #[serde(default)]
    pub generation_options: Option<PromptGenerationOptions>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMissingPromptScenesInput {
    #[serde(default)]
    pub canvas_id: Option<String>,
    pub prompt_set_title: String,
    pub scenes: Vec<CreatePromptSceneInput>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSceneMutation {
    pub binding: PromptSceneBinding,
    pub node: NodeRecord,
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMissingPromptScenesResult {
    pub prompt_set: PromptSetSummary,
    pub scenes: Vec<PromptSceneMutation>,
    pub created_count: usize,
    pub existing_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendPromptVersionInput {
    pub text: String,
    #[serde(default)]
    pub information: String,
    #[serde(default)]
    pub reference_selection: Option<serde_json::Value>,
    #[serde(default)]
    pub generation_options: Option<PromptGenerationOptions>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub request_id: String,
    #[serde(default)]
    pub expected_version_count: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendPromptVersionResult {
    pub binding: PromptSceneBinding,
    pub node: NodeRecord,
    pub version: PromptVersionRecord,
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendContentVersionResult {
    pub node: NodeRecord,
    pub version: PromptVersionRecord,
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateContentVersionInput {
    pub text: String,
    #[serde(default)]
    pub change_note: Option<String>,
    #[serde(default)]
    pub reformat_notes_only: bool,
    #[serde(default)]
    pub remove_change_note: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub expected_version_count: usize,
    pub expected_active_version_id: String,
    pub expected_node_updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateContentVersionResult {
    pub node: NodeRecord,
    pub version: PromptVersionRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodesBatchInput {
    pub nodes: Vec<CreateNodeInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodesBatchResult {
    pub nodes: Vec<CreateNodeResult>,
    pub created_count: usize,
    pub existing_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceNodeAndDeleteInput {
    pub update: UpdateNodeInput,
    pub delete_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceNodeAndDeleteResult {
    pub previous_node: NodeRecord,
    pub node: NodeRecord,
    pub deleted: DeletedBatch,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreNodeReplacementInput {
    pub previous_node: NodeRecord,
    pub deleted: DeletedBatch,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreNodeReplacementResult {
    pub node: NodeRecord,
    pub restored: DeletedBatch,
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
pub struct SetProjectPrivacyInput {
    pub id: String,
    pub is_private: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectPreviewImageInput {
    pub project_id: String,
    pub image_node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupNodesIntoFolderInput {
    pub canvas_id: String,
    pub node_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEmptyFolderInput {
    pub canvas_id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEmptyFolderResult {
    pub parent: WorkspaceSnapshot,
    pub child: WorkspaceSnapshot,
    pub folder_node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRelatedNodesIntoFolderInput {
    pub canvas_id: String,
    pub root_node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupNodesIntoFolderResult {
    pub parent: WorkspaceSnapshot,
    pub child: WorkspaceSnapshot,
    pub folder_node_id: String,
    pub removed_crossing_edge_count: usize,
    #[serde(default)]
    pub moved_node_count: usize,
    #[serde(default)]
    pub copied_input_node_count: usize,
    pub undo: FolderGroupingUndoRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInputDuplicateRecord {
    pub source_node_id: String,
    pub duplicate_node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGroupingUndoRecord {
    pub parent_canvas_id: String,
    pub child_canvas_id: String,
    pub folder_node_id: String,
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    #[serde(default)]
    pub prompt_scene_bindings: Vec<PromptSceneBindingRecord>,
    #[serde(default)]
    pub duplicated_input_nodes: Vec<FolderInputDuplicateRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoFolderGroupingInput {
    pub grouping: FolderGroupingUndoRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeFoldersInput {
    pub canvas_id: String,
    pub folder_node_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMergeSourceSnapshot {
    pub folder_node: NodeRecord,
    pub child_canvas: CanvasRecord,
    pub folder_link_created_at: String,
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    #[serde(default)]
    pub prompt_scene_bindings: Vec<PromptSceneBindingRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMergeDeduplicatedInputRecord {
    pub original_source_node_id: String,
    pub kept_node_id: String,
    pub removed_node_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMergeUndoRecord {
    pub parent_canvas_id: String,
    pub merged_child_canvas_id: String,
    pub merged_folder_node_id: String,
    pub sources: Vec<FolderMergeSourceSnapshot>,
    #[serde(default)]
    pub parent_edges: Vec<EdgeRecord>,
    #[serde(default)]
    pub deduplicated_input_nodes: Vec<FolderMergeDeduplicatedInputRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeFoldersResult {
    pub parent: WorkspaceSnapshot,
    pub child: WorkspaceSnapshot,
    pub folder_node_id: String,
    pub merged_node_count: usize,
    pub source_folder_count: usize,
    #[serde(default)]
    pub deduplicated_input_node_count: usize,
    pub undo: FolderMergeUndoRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoFolderMergeInput {
    pub merge: FolderMergeUndoRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderActionInput {
    pub canvas_id: String,
    pub folder_node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelFolderUndoRecord {
    pub parent_canvas_id: String,
    pub source: FolderMergeSourceSnapshot,
    #[serde(default)]
    pub parent_edges: Vec<EdgeRecord>,
    #[serde(default)]
    pub restored_source_edges: Vec<EdgeRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelFolderResult {
    pub parent: WorkspaceSnapshot,
    pub moved_node_count: usize,
    pub undo: CancelFolderUndoRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoCancelFolderInput {
    pub cancellation: CancelFolderUndoRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFolderLinkRecord {
    pub folder_node_id: String,
    pub child_canvas_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeUndoRecord {
    pub parent_canvas_id: String,
    pub root_folder_node_id: String,
    pub canvases: Vec<CanvasRecord>,
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    pub folder_links: Vec<CanvasFolderLinkRecord>,
    #[serde(default)]
    pub prompt_scene_bindings: Vec<PromptSceneBindingRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderResult {
    pub parent: WorkspaceSnapshot,
    pub deleted_content_node_count: usize,
    pub undo: FolderTreeUndoRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoDeleteFolderInput {
    pub deletion: FolderTreeUndoRecord,
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
pub struct ResizeImageResult {
    pub node: NodeRecord,
    pub edge: EdgeRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub base_url: String,
    pub data_path: String,
    pub canvas_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLockStatus {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAppLockInput {
    #[serde(default)]
    pub current_password: Option<String>,
    pub new_password: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfySubmitInput {
    pub server_url: String,
    #[serde(default)]
    pub workflow_module_id: Option<String>,
    pub workflow_path: String,
    #[serde(default)]
    pub input_root_path: String,
    pub client_id: String,
    pub prompt: String,
    pub seed_mode: String,
    pub seed: String,
    pub duration_seconds: f64,
    #[serde(default = "default_video_aspect_ratio")]
    pub aspect_ratio: String,
    pub primary_resolution_megapixels: f64,
    pub secondary_resolution_megapixels: f64,
    #[serde(default = "default_primary_video_steps")]
    pub primary_video_steps: u32,
    #[serde(default = "default_primary_audio_steps")]
    pub primary_audio_steps: u32,
    #[serde(default = "default_secondary_scheduler_steps")]
    pub secondary_scheduler_steps: u32,
    #[serde(default = "default_primary_upscale_factor")]
    pub primary_upscale_factor: f64,
    #[serde(default = "default_primary_brightness")]
    pub primary_brightness: f64,
    #[serde(default = "default_primary_contrast")]
    pub primary_contrast: f64,
    #[serde(default = "default_primary_saturation")]
    pub primary_saturation: f64,
    #[serde(default = "default_secondary_brightness")]
    pub secondary_brightness: f64,
    #[serde(default = "default_secondary_contrast")]
    pub secondary_contrast: f64,
    #[serde(default = "default_secondary_saturation")]
    pub secondary_saturation: f64,
    pub secondary_sampling_enabled: bool,
    #[serde(default = "default_diffusion_model_name")]
    pub diffusion_model_name: String,
    pub lora_name: String,
    #[serde(default = "default_lora_strength")]
    pub lora_strength: f64,
    #[serde(default)]
    pub lora_bypassed: bool,
    #[serde(default)]
    pub secondary_lora_name: Option<String>,
    #[serde(default)]
    pub secondary_lora_strength: Option<f64>,
    #[serde(default)]
    pub secondary_lora_bypassed: Option<bool>,
    #[serde(default)]
    pub style_lora_name: Option<String>,
    #[serde(default)]
    pub style_lora_strength: Option<f64>,
    #[serde(default)]
    pub style_lora_bypassed: Option<bool>,
    #[serde(default)]
    pub style_lora_apply_to_secondary: Option<bool>,
    #[serde(default = "default_ref_image_size")]
    pub ref_image_size: String,
    #[serde(default)]
    pub strict_prompt_tags: Option<bool>,
    #[serde(default)]
    pub image_paths: Vec<String>,
    #[serde(default)]
    pub image_roles: Vec<String>,
    #[serde(default)]
    pub audio_paths: Vec<String>,
    #[serde(default)]
    pub video_paths: Vec<String>,
    #[serde(default)]
    pub secondary_source: Option<ComfyOutputFile>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyImageSubmitInput {
    pub server_url: String,
    pub workflow_module_id: String,
    pub client_id: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    pub seed_mode: String,
    pub seed: String,
    pub width: u32,
    pub height: u32,
    #[serde(default = "default_image_generation_steps")]
    pub steps: u32,
    #[serde(default)]
    pub lora_name: String,
    #[serde(default)]
    pub model_name: String,
    #[serde(default)]
    pub image_paths: Vec<String>,
    #[serde(default)]
    pub upscale_enabled: bool,
    #[serde(default = "default_image_upscale_megapixels")]
    pub upscale_megapixels: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyImageUpscaleInput {
    pub server_url: String,
    pub workflow_module_id: String,
    pub client_id: String,
    pub source: ComfyOutputFile,
    pub megapixels: f64,
    #[serde(default)]
    pub model_name: String,
}

fn default_image_upscale_megapixels() -> f64 {
    8.0
}

fn default_image_generation_steps() -> u32 {
    8
}

fn default_lora_strength() -> f64 {
    1.0
}

fn default_ref_image_size() -> String {
    "match".to_owned()
}

fn default_diffusion_model_name() -> String {
    r"MinimaxH3\minimax_h3_fl2va_pruned_int8_convrot.safetensors".to_owned()
}

fn default_primary_video_steps() -> u32 {
    6
}

fn default_primary_audio_steps() -> u32 {
    8
}

fn default_secondary_scheduler_steps() -> u32 {
    4
}

fn default_primary_upscale_factor() -> f64 {
    1.0
}

fn default_primary_brightness() -> f64 {
    1.0
}

fn default_primary_contrast() -> f64 {
    0.9
}

fn default_primary_saturation() -> f64 {
    0.9
}

fn default_secondary_brightness() -> f64 {
    1.0
}

fn default_secondary_contrast() -> f64 {
    0.9
}

fn default_secondary_saturation() -> f64 {
    1.0
}

fn default_video_aspect_ratio() -> String {
    "16:9".to_owned()
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
    pub model_name: Option<String>,
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
