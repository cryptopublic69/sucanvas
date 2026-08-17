use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST_FILE: &str = "manifest.json";
const WORKFLOW_FILE: &str = "workflow.json";
const ADAPTER_FILE: &str = "adapter.json";
const UI_SCHEMA_FILE: &str = "ui-schema.json";
pub const WORKFLOW_PACKAGE_ENGINE: &str = "workflow-package-v1";
pub const WORKFLOW_PACKAGE_SCHEMA_VERSION: u32 = 1;
pub const WORKFLOW_ENGINE_API_VERSION: &str = "1.0";
pub const H3_MULTI_REFERENCE_ADAPTER: &str = "minimax-h3-multi-reference-v1";
pub const H3_FIRST_LAST_FRAME_ADAPTER: &str = "minimax-h3-first-last-frame-v1";
pub const H3_IMAGE_TO_VIDEO_ADAPTER: &str = "minimax-h3-image-to-video-v1";
pub const H3_LAST_FRAME_TO_VIDEO_ADAPTER: &str = "minimax-h3-last-frame-to-video-v1";
pub const KREA2_TEXT_TO_IMAGE_ADAPTER: &str = "krea2-text-to-image-v1";
pub const KREA2_IMAGE_EDIT_ADAPTER: &str = "krea2-image-edit-v1";
const MAX_PACKAGE_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

fn default_diffusion_model_node_id() -> String {
    "358".to_owned()
}

fn default_diffusion_model_class_type() -> String {
    "UNETLoader".to_owned()
}

fn default_diffusion_model_directory() -> String {
    "MinimaxH3".to_owned()
}

fn default_diffusion_model_name() -> String {
    r"MinimaxH3\minimax_h3_fl2va_pruned_int8_convrot.safetensors".to_owned()
}

fn default_secondary_guider_node_id() -> String {
    "393".to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBindings {
    pub prompt_node_id: String,
    pub seed_node_id: String,
    pub duration_node_id: String,
    pub primary_resolution_node_id: String,
    pub secondary_resolution_node_id: String,
    pub primary_lora_node_id: String,
    pub secondary_lora_node_id: String,
    pub primary_sampler_node_id: String,
    pub secondary_scheduler_node_id: String,
    #[serde(default = "default_secondary_guider_node_id")]
    pub secondary_guider_node_id: String,
    pub primary_output_node_id: String,
    pub secondary_output_node_id: String,
    pub primary_color_node_id: String,
    pub secondary_color_node_id: String,
    pub clean_video_node_id: String,
    pub clean_save_node_id: String,
    pub secondary_video_input_node_id: String,
    pub conditioning_node_id: String,
    pub audio_node_ids: Vec<String>,
    pub image_node_ids: Vec<String>,
    pub primary_audio_output_node_id: String,
    pub primary_audio_output_index: u32,
    pub secondary_audio_output_node_id: String,
    pub secondary_audio_output_index: u32,
    pub secondary_resize_node_id: String,
    pub secondary_audio_encode_node_id: String,
    #[serde(default = "default_diffusion_model_node_id")]
    pub diffusion_model_node_id: String,
    #[serde(default = "default_diffusion_model_class_type")]
    pub diffusion_model_class_type: String,
    #[serde(default = "default_diffusion_model_directory")]
    pub diffusion_model_directory: String,
    pub lora_class_type: String,
    pub lora_directory: String,
    #[serde(default)]
    pub secondary_prompt_node_id: String,
    #[serde(default)]
    pub secondary_conditioning_node_id: String,
    #[serde(default)]
    pub single_image_input_node_id: String,
    #[serde(default)]
    pub secondary_image_input_node_id: String,
}

impl Default for WorkflowBindings {
    fn default() -> Self {
        Self {
            prompt_node_id: "339".to_owned(),
            seed_node_id: "348".to_owned(),
            duration_node_id: "350".to_owned(),
            primary_resolution_node_id: "340".to_owned(),
            secondary_resolution_node_id: "398".to_owned(),
            primary_lora_node_id: "354".to_owned(),
            secondary_lora_node_id: "401".to_owned(),
            primary_sampler_node_id: "357".to_owned(),
            secondary_scheduler_node_id: "391".to_owned(),
            secondary_guider_node_id: default_secondary_guider_node_id(),
            primary_output_node_id: "360".to_owned(),
            secondary_output_node_id: "397".to_owned(),
            primary_color_node_id: "405".to_owned(),
            secondary_color_node_id: "403".to_owned(),
            clean_video_node_id: "9000".to_owned(),
            clean_save_node_id: "9001".to_owned(),
            secondary_video_input_node_id: "9002".to_owned(),
            conditioning_node_id: "363".to_owned(),
            audio_node_ids: vec!["374".to_owned(), "416".to_owned()],
            image_node_ids: [
                "362", "364", "365", "367", "368", "369", "370", "371", "372",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            primary_audio_output_node_id: "356".to_owned(),
            primary_audio_output_index: 1,
            secondary_audio_output_node_id: "382".to_owned(),
            secondary_audio_output_index: 0,
            secondary_resize_node_id: "383".to_owned(),
            secondary_audio_encode_node_id: "388".to_owned(),
            diffusion_model_node_id: default_diffusion_model_node_id(),
            diffusion_model_class_type: default_diffusion_model_class_type(),
            diffusion_model_directory: default_diffusion_model_directory(),
            lora_class_type: "LoraLoaderModelOnly".to_owned(),
            lora_directory: "MinimaxH3".to_owned(),
            secondary_prompt_node_id: String::new(),
            secondary_conditioning_node_id: String::new(),
            single_image_input_node_id: String::new(),
            secondary_image_input_node_id: String::new(),
        }
    }
}

impl WorkflowBindings {
    pub fn image_generation() -> Self {
        Self {
            prompt_node_id: "90".to_owned(),
            seed_node_id: "63".to_owned(),
            duration_node_id: String::new(),
            primary_resolution_node_id: "29".to_owned(),
            secondary_resolution_node_id: String::new(),
            primary_lora_node_id: "159".to_owned(),
            secondary_lora_node_id: String::new(),
            primary_sampler_node_id: "160".to_owned(),
            secondary_scheduler_node_id: String::new(),
            secondary_guider_node_id: String::new(),
            primary_output_node_id: "157".to_owned(),
            secondary_output_node_id: String::new(),
            primary_color_node_id: String::new(),
            secondary_color_node_id: String::new(),
            clean_video_node_id: String::new(),
            clean_save_node_id: String::new(),
            secondary_video_input_node_id: String::new(),
            conditioning_node_id: "153".to_owned(),
            audio_node_ids: Vec::new(),
            image_node_ids: Vec::new(),
            primary_audio_output_node_id: String::new(),
            primary_audio_output_index: 0,
            secondary_audio_output_node_id: String::new(),
            secondary_audio_output_index: 0,
            secondary_resize_node_id: "161".to_owned(),
            secondary_audio_encode_node_id: "162".to_owned(),
            diffusion_model_node_id: "98".to_owned(),
            diffusion_model_class_type: "UNETLoader".to_owned(),
            diffusion_model_directory: "Krea2".to_owned(),
            lora_class_type: "Power Lora Loader (rgthree)".to_owned(),
            lora_directory: "Krea2".to_owned(),
            secondary_prompt_node_id: String::new(),
            secondary_conditioning_node_id: String::new(),
            single_image_input_node_id: String::new(),
            secondary_image_input_node_id: String::new(),
        }
    }

    pub fn image_edit() -> Self {
        Self {
            prompt_node_id: "37".to_owned(),
            seed_node_id: "30".to_owned(),
            duration_node_id: String::new(),
            primary_resolution_node_id: "28".to_owned(),
            secondary_resolution_node_id: "4".to_owned(),
            primary_lora_node_id: String::new(),
            secondary_lora_node_id: String::new(),
            primary_sampler_node_id: "7".to_owned(),
            secondary_scheduler_node_id: String::new(),
            secondary_guider_node_id: String::new(),
            primary_output_node_id: "500".to_owned(),
            secondary_output_node_id: String::new(),
            primary_color_node_id: String::new(),
            secondary_color_node_id: String::new(),
            clean_video_node_id: String::new(),
            clean_save_node_id: String::new(),
            secondary_video_input_node_id: String::new(),
            conditioning_node_id: "34".to_owned(),
            audio_node_ids: Vec::new(),
            image_node_ids: vec!["21".to_owned(), "9".to_owned()],
            primary_audio_output_node_id: String::new(),
            primary_audio_output_index: 0,
            secondary_audio_output_node_id: String::new(),
            secondary_audio_output_index: 0,
            secondary_resize_node_id: String::new(),
            secondary_audio_encode_node_id: String::new(),
            diffusion_model_node_id: "43".to_owned(),
            diffusion_model_class_type: "UNETLoader".to_owned(),
            diffusion_model_directory: "Krea2".to_owned(),
            lora_class_type: "LoraLoaderModelOnly".to_owned(),
            lora_directory: "Krea2-功能".to_owned(),
            secondary_prompt_node_id: "20".to_owned(),
            secondary_conditioning_node_id: "3".to_owned(),
            single_image_input_node_id: "45".to_owned(),
            secondary_image_input_node_id: "9".to_owned(),
        }
    }
    pub fn first_last_frame() -> Self {
        Self {
            prompt_node_id: "312".to_owned(),
            seed_node_id: "321".to_owned(),
            duration_node_id: "323".to_owned(),
            primary_resolution_node_id: "313".to_owned(),
            secondary_resolution_node_id: "398".to_owned(),
            primary_lora_node_id: "327".to_owned(),
            secondary_lora_node_id: "401".to_owned(),
            primary_sampler_node_id: "331".to_owned(),
            secondary_scheduler_node_id: "391".to_owned(),
            secondary_guider_node_id: "393".to_owned(),
            primary_output_node_id: "328".to_owned(),
            secondary_output_node_id: "397".to_owned(),
            primary_color_node_id: "405".to_owned(),
            secondary_color_node_id: "403".to_owned(),
            clean_video_node_id: "9000".to_owned(),
            clean_save_node_id: "9001".to_owned(),
            secondary_video_input_node_id: "9002".to_owned(),
            conditioning_node_id: "333".to_owned(),
            audio_node_ids: Vec::new(),
            image_node_ids: vec!["335".to_owned(), "417".to_owned()],
            primary_audio_output_node_id: "330".to_owned(),
            primary_audio_output_index: 1,
            secondary_audio_output_node_id: "382".to_owned(),
            secondary_audio_output_index: 0,
            secondary_resize_node_id: "383".to_owned(),
            secondary_audio_encode_node_id: "388".to_owned(),
            diffusion_model_node_id: "332".to_owned(),
            diffusion_model_class_type: default_diffusion_model_class_type(),
            diffusion_model_directory: default_diffusion_model_directory(),
            lora_class_type: "LoraLoaderModelOnly".to_owned(),
            lora_directory: "MinimaxH3".to_owned(),
            secondary_prompt_node_id: String::new(),
            secondary_conditioning_node_id: String::new(),
            single_image_input_node_id: String::new(),
            secondary_image_input_node_id: String::new(),
        }
    }

    pub fn image_to_video() -> Self {
        let mut bindings = Self::first_last_frame();
        bindings.image_node_ids = vec!["335".to_owned()];
        bindings
    }

    pub fn last_frame_to_video() -> Self {
        let mut bindings = Self::first_last_frame();
        bindings.image_node_ids = vec!["417".to_owned()];
        bindings
    }

    pub fn for_variant(variant: &str) -> Self {
        match variant {
            "image-generation" => Self::image_generation(),
            "image-edit" => Self::image_edit(),
            "first-last-frame" => Self::first_last_frame(),
            "image-to-video" => Self::image_to_video(),
            "last-frame-to-video" => Self::last_frame_to_video(),
            _ => Self::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInputContract {
    pub prompt_required: bool,
    pub image_min: usize,
    pub image_max: usize,
    pub audio_min: usize,
    pub audio_max: usize,
    pub video_min: usize,
    pub video_max: usize,
}

impl Default for WorkflowInputContract {
    fn default() -> Self {
        Self {
            prompt_required: true,
            image_min: 0,
            image_max: 9,
            audio_min: 0,
            audio_max: 2,
            video_min: 0,
            video_max: 1,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAdapter {
    pub schema_version: u32,
    pub engine_api_version: String,
    pub adapter_id: String,
    pub capability: String,
    pub variant: String,
    #[serde(default)]
    pub input_contract: WorkflowInputContract,
    pub bindings: WorkflowBindings,
}

impl WorkflowAdapter {
    pub fn image_generation(bindings: WorkflowBindings) -> Self {
        Self {
            schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
            engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
            adapter_id: KREA2_TEXT_TO_IMAGE_ADAPTER.to_owned(),
            capability: "image-generation".to_owned(),
            variant: "image-generation".to_owned(),
            input_contract: WorkflowInputContract {
                prompt_required: true,
                image_min: 0,
                image_max: 0,
                audio_min: 0,
                audio_max: 0,
                video_min: 0,
                video_max: 0,
            },
            bindings,
        }
    }

    pub fn image_edit(bindings: WorkflowBindings) -> Self {
        Self {
            schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
            engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
            adapter_id: KREA2_IMAGE_EDIT_ADAPTER.to_owned(),
            capability: "image-generation".to_owned(),
            variant: "image-edit".to_owned(),
            input_contract: WorkflowInputContract {
                prompt_required: true,
                image_min: 1,
                image_max: 2,
                audio_min: 0,
                audio_max: 0,
                video_min: 0,
                video_max: 0,
            },
            bindings,
        }
    }
    pub fn current_h3(bindings: WorkflowBindings) -> Self {
        Self {
            schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
            engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
            adapter_id: H3_MULTI_REFERENCE_ADAPTER.to_owned(),
            capability: "video-generation".to_owned(),
            variant: "reference-to-video".to_owned(),
            input_contract: WorkflowInputContract::default(),
            bindings,
        }
    }

    pub fn first_last_frame(bindings: WorkflowBindings) -> Self {
        Self {
            schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
            engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
            adapter_id: H3_FIRST_LAST_FRAME_ADAPTER.to_owned(),
            capability: "video-generation".to_owned(),
            variant: "first-last-frame".to_owned(),
            input_contract: WorkflowInputContract {
                prompt_required: true,
                image_min: 2,
                image_max: 2,
                audio_min: 0,
                audio_max: 0,
                video_min: 0,
                video_max: 0,
            },
            bindings,
        }
    }

    pub fn image_to_video(bindings: WorkflowBindings) -> Self {
        Self {
            schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
            engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
            adapter_id: H3_IMAGE_TO_VIDEO_ADAPTER.to_owned(),
            capability: "video-generation".to_owned(),
            variant: "image-to-video".to_owned(),
            input_contract: WorkflowInputContract {
                prompt_required: true,
                image_min: 1,
                image_max: 1,
                audio_min: 0,
                audio_max: 0,
                video_min: 0,
                video_max: 0,
            },
            bindings,
        }
    }

    pub fn last_frame_to_video(bindings: WorkflowBindings) -> Self {
        Self {
            schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
            engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
            adapter_id: H3_LAST_FRAME_TO_VIDEO_ADAPTER.to_owned(),
            capability: "video-generation".to_owned(),
            variant: "last-frame-to-video".to_owned(),
            input_contract: WorkflowInputContract {
                prompt_required: true,
                image_min: 1,
                image_max: 1,
                audio_min: 0,
                audio_max: 0,
                video_min: 0,
                video_max: 0,
            },
            bindings,
        }
    }

    fn for_variant(variant: &str, bindings: WorkflowBindings) -> Self {
        match variant {
            "image-generation" => Self::image_generation(bindings),
            "image-edit" => Self::image_edit(bindings),
            "first-last-frame" => Self::first_last_frame(bindings),
            "image-to-video" => Self::image_to_video(bindings),
            "last-frame-to-video" => Self::last_frame_to_video(bindings),
            _ => Self::current_h3(bindings),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowUiField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub default: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowUiGroup {
    pub id: String,
    pub title: String,
    pub fields: Vec<WorkflowUiField>,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowUiSchema {
    pub schema_version: u32,
    pub groups: Vec<WorkflowUiGroup>,
}

impl Default for WorkflowUiSchema {
    fn default() -> Self {
        let field =
            |key: &str, label: &str, min: f64, max: f64, step: f64, default: f64| WorkflowUiField {
                key: key.to_owned(),
                label: label.to_owned(),
                field_type: "number".to_owned(),
                min,
                max,
                step,
                default,
                min_key: None,
            };
        Self {
            schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
            groups: vec![
                WorkflowUiGroup {
                    id: "sampling-steps".to_owned(),
                    title: "采样步数".to_owned(),
                    fields: vec![
                        field(
                            "primaryVideoSteps",
                            "一采 Video Steps",
                            1.0,
                            1000.0,
                            1.0,
                            6.0,
                        ),
                        WorkflowUiField {
                            min_key: Some("primaryVideoSteps".to_owned()),
                            ..field(
                                "primaryAudioSteps",
                                "一采 Audio Steps",
                                1.0,
                                1000.0,
                                1.0,
                                8.0,
                            )
                        },
                        field(
                            "secondarySchedulerSteps",
                            "二采基本调度 Steps",
                            1.0,
                            10000.0,
                            1.0,
                            4.0,
                        ),
                    ],
                    note: "Audio Steps 不能小于 Video Steps；默认值分别为 6、8、4。".to_owned(),
                },
                WorkflowUiGroup {
                    id: "primary-color".to_owned(),
                    title: "一采画面调整".to_owned(),
                    fields: vec![
                        field("primaryBrightness", "亮度", 0.0, 3.0, 0.01, 1.0),
                        field("primaryContrast", "对比度", 0.0, 3.0, 0.01, 0.9),
                        field("primarySaturation", "饱和度", 0.0, 3.0, 0.01, 0.9),
                    ],
                    note: "默认值：1.00、0.90、0.90。".to_owned(),
                },
                WorkflowUiGroup {
                    id: "secondary-color".to_owned(),
                    title: "二采画面调整".to_owned(),
                    fields: vec![
                        field("secondaryBrightness", "亮度", 0.0, 3.0, 0.01, 1.0),
                        field("secondaryContrast", "对比度", 0.0, 3.0, 0.01, 0.9),
                        field("secondarySaturation", "饱和度", 0.0, 3.0, 0.01, 1.0),
                    ],
                    note: "默认值：1.00、0.90、1.00；六项范围均为 0.00–3.00。".to_owned(),
                },
            ],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowModuleDefaults {
    pub primary_video_steps: u32,
    pub primary_audio_steps: u32,
    pub secondary_scheduler_steps: u32,
    pub primary_brightness: f64,
    pub primary_contrast: f64,
    pub primary_saturation: f64,
    pub secondary_brightness: f64,
    pub secondary_contrast: f64,
    pub secondary_saturation: f64,
    #[serde(default = "default_diffusion_model_name")]
    pub diffusion_model_name: String,
    pub lora_name: String,
    pub lora_strength: f64,
}

impl Default for WorkflowModuleDefaults {
    fn default() -> Self {
        Self {
            primary_video_steps: 6,
            primary_audio_steps: 8,
            secondary_scheduler_steps: 4,
            primary_brightness: 1.0,
            primary_contrast: 0.9,
            primary_saturation: 0.9,
            secondary_brightness: 1.0,
            secondary_contrast: 0.9,
            secondary_saturation: 1.0,
            diffusion_model_name: default_diffusion_model_name(),
            lora_name: "MinimaxH3\\minimax_h3_turbo_4STEPS_comfyui.safetensors".to_owned(),
            lora_strength: 1.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowModuleManifest {
    pub id: String,
    pub name: String,
    pub capability: String,
    #[serde(default)]
    pub variant: String,
    pub revision: String,
    #[serde(default = "default_package_schema_version")]
    pub package_schema_version: u32,
    #[serde(default = "default_engine_api_version")]
    pub engine_api_version: String,
    pub adapter_kind: String,
    #[serde(default = "default_adapter_entry")]
    pub adapter_entry: String,
    #[serde(default = "default_ui_schema_entry")]
    pub ui_schema_entry: String,
    pub source_workflow_name: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "bindings")]
    pub legacy_bindings: Option<WorkflowBindings>,
    #[serde(default)]
    pub defaults: WorkflowModuleDefaults,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowModuleRecord {
    #[serde(flatten)]
    pub manifest: WorkflowModuleManifest,
    pub workflow_path: String,
    pub adapter_path: String,
    pub ui_schema_path: String,
    pub bindings: WorkflowBindings,
    pub adapter: WorkflowAdapter,
    pub ui_schema: WorkflowUiSchema,
    pub backup_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkflowModuleInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub capability: String,
    #[serde(default)]
    pub variant: String,
    #[serde(default)]
    pub revision: String,
    #[serde(default = "default_adapter_kind")]
    pub adapter_kind: String,
    pub source_workflow_path: String,
    #[serde(default)]
    pub bindings: Option<WorkflowBindings>,
    #[serde(default)]
    pub adapter: Option<WorkflowAdapter>,
    #[serde(default)]
    pub ui_schema: Option<WorkflowUiSchema>,
    #[serde(default)]
    pub defaults: Option<WorkflowModuleDefaults>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowModuleValidation {
    pub compatible: bool,
    pub issues: Vec<String>,
}

fn default_adapter_kind() -> String {
    WORKFLOW_PACKAGE_ENGINE.to_owned()
}

fn default_package_schema_version() -> u32 {
    WORKFLOW_PACKAGE_SCHEMA_VERSION
}

fn default_engine_api_version() -> String {
    WORKFLOW_ENGINE_API_VERSION.to_owned()
}

fn default_adapter_entry() -> String {
    ADAPTER_FILE.to_owned()
}

fn default_ui_schema_entry() -> String {
    UI_SCHEMA_FILE.to_owned()
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn validate_label(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if value.chars().count() > 80 {
        return Err(format!("{label}不能超过80个字符"));
    }
    Ok(value.to_owned())
}

fn module_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

fn manifest_path(root: &Path, id: &str) -> PathBuf {
    module_dir(root, id).join(MANIFEST_FILE)
}

fn workflow_path(root: &Path, id: &str) -> PathBuf {
    module_dir(root, id).join(WORKFLOW_FILE)
}

fn adapter_path(root: &Path, id: &str) -> PathBuf {
    module_dir(root, id).join(ADAPTER_FILE)
}

fn ui_schema_path(root: &Path, id: &str) -> PathBuf {
    module_dir(root, id).join(UI_SCHEMA_FILE)
}

fn read_manifest(root: &Path, id: &str) -> Result<WorkflowModuleManifest, String> {
    let bytes = fs::read(manifest_path(root, id))
        .map_err(|error| format!("读取工作流方案 {id} 失败：{error}"))?;
    let mut manifest: WorkflowModuleManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析工作流方案 {id} 失败：{error}"))?;
    let (capability, variant) = normalize_classification(&manifest.capability, &manifest.variant)?;
    manifest.capability = capability;
    manifest.variant = variant;
    Ok(manifest)
}

fn write_manifest(root: &Path, manifest: &WorkflowModuleManifest) -> Result<(), String> {
    let directory = module_dir(root, &manifest.id);
    fs::create_dir_all(&directory).map_err(|error| format!("创建工作流方案目录失败：{error}"))?;
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("序列化工作流方案失败：{error}"))?;
    fs::write(directory.join(MANIFEST_FILE), bytes)
        .map_err(|error| format!("保存工作流方案失败：{error}"))
}

fn write_json_file<T: Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("序列化{label}失败：{error}"))?;
    fs::write(path, bytes).map_err(|error| format!("保存{label}失败：{error}"))
}

fn validate_adapter_contract(
    adapter: &WorkflowAdapter,
    capability: &str,
    variant: &str,
) -> Result<(), String> {
    if adapter.schema_version != WORKFLOW_PACKAGE_SCHEMA_VERSION {
        return Err(format!(
            "方案适配器 schemaVersion {} 不受支持，当前只支持 {}",
            adapter.schema_version, WORKFLOW_PACKAGE_SCHEMA_VERSION
        ));
    }
    if adapter.engine_api_version != WORKFLOW_ENGINE_API_VERSION {
        return Err(format!(
            "方案适配器需要引擎 API {}，当前程序提供 {}",
            adapter.engine_api_version, WORKFLOW_ENGINE_API_VERSION
        ));
    }
    if adapter.capability != capability || adapter.variant != variant {
        return Err("方案适配器的功能类型与 manifest 不一致".to_owned());
    }
    if adapter.adapter_id.trim().is_empty() {
        return Err("方案适配器 adapterId 不能为空".to_owned());
    }
    if capability == "image-generation" && variant == "image-generation" {
        if adapter.adapter_id != KREA2_TEXT_TO_IMAGE_ADAPTER {
            return Err("图片生成方案必须使用 Krea2 文生图适配器".to_owned());
        }
        return Ok(());
    }
    if capability == "image-generation" && variant == "image-edit" {
        if adapter.adapter_id != KREA2_IMAGE_EDIT_ADAPTER {
            return Err("图片编辑方案必须使用 Krea2 图像编辑适配器".to_owned());
        }
        if !adapter.input_contract.prompt_required
            || adapter.input_contract.image_min != 1
            || adapter.input_contract.image_max != 2
            || adapter.input_contract.audio_max != 0
            || adapter.input_contract.video_max != 0
        {
            return Err(
                "Krea2 图像编辑适配器必须要求提示词、支持 1–2 张图片，并禁止音频和视频输入"
                    .to_owned(),
            );
        }
        return Ok(());
    }
    if capability != "video-generation"
        || !matches!(
            variant,
            "reference-to-video" | "first-last-frame" | "image-to-video" | "last-frame-to-video"
        )
    {
        return Err(
            "当前 v1 通用引擎只实现了多参生视频、首尾帧、图生视频和尾帧生视频接口".to_owned(),
        );
    }
    if adapter.input_contract.image_max > adapter.bindings.image_node_ids.len() {
        return Err("适配器声明的最大图片数量超过图片输入节点数量".to_owned());
    }
    if adapter.input_contract.audio_max > adapter.bindings.audio_node_ids.len() {
        return Err("适配器声明的最大音频数量超过音频输入节点数量".to_owned());
    }
    if !adapter.input_contract.prompt_required || adapter.input_contract.video_max > 1 {
        return Err("当前 v1 通用引擎要求提示词，且最多支持一个参考视频".to_owned());
    }
    if adapter.input_contract.image_min > adapter.input_contract.image_max
        || adapter.input_contract.audio_min > adapter.input_contract.audio_max
        || adapter.input_contract.video_min > adapter.input_contract.video_max
    {
        return Err("适配器素材数量范围无效".to_owned());
    }
    if variant == "first-last-frame"
        && (adapter.input_contract.image_min != 2
            || adapter.input_contract.image_max != 2
            || adapter.input_contract.audio_max != 0
            || adapter.input_contract.video_max != 0)
    {
        return Err("首尾帧适配器必须要求恰好2张图片，并禁止音频和视频输入".to_owned());
    }
    if variant == "image-to-video"
        && (adapter.input_contract.image_min != 1
            || adapter.input_contract.image_max != 1
            || adapter.input_contract.audio_max != 0
            || adapter.input_contract.video_max != 0)
    {
        return Err("图生视频适配器必须要求恰好1张图片，并禁止音频和视频输入".to_owned());
    }
    if variant == "last-frame-to-video"
        && (adapter.input_contract.image_min != 1
            || adapter.input_contract.image_max != 1
            || adapter.input_contract.audio_max != 0
            || adapter.input_contract.video_max != 0)
    {
        return Err("尾帧生视频适配器必须要求恰好1张图片，并禁止音频和视频输入".to_owned());
    }
    Ok(())
}

fn validate_ui_schema(schema: &WorkflowUiSchema) -> Result<(), String> {
    if schema.schema_version != WORKFLOW_PACKAGE_SCHEMA_VERSION {
        return Err(format!(
            "方案界面 schemaVersion {} 不受支持",
            schema.schema_version
        ));
    }
    let allowed_keys = [
        "primaryVideoSteps",
        "primaryAudioSteps",
        "secondarySchedulerSteps",
        "primaryBrightness",
        "primaryContrast",
        "primarySaturation",
        "secondaryBrightness",
        "secondaryContrast",
        "secondarySaturation",
    ];
    let mut seen = HashSet::new();
    for group in &schema.groups {
        if group.id.trim().is_empty() || group.title.trim().is_empty() {
            return Err("方案界面分组必须包含 id 和标题".to_owned());
        }
        for field in &group.fields {
            if field.field_type != "number" || !allowed_keys.contains(&field.key.as_str()) {
                return Err(format!("方案界面包含不受支持的参数 {}", field.key));
            }
            if !seen.insert(field.key.as_str()) {
                return Err(format!("方案界面参数 {} 重复定义", field.key));
            }
            if !field.min.is_finite()
                || !field.max.is_finite()
                || !field.step.is_finite()
                || !field.default.is_finite()
                || field.min > field.default
                || field.default > field.max
                || field.step <= 0.0
            {
                return Err(format!("方案界面参数 {} 的范围或默认值无效", field.key));
            }
            if let Some(min_key) = field.min_key.as_deref() {
                if !allowed_keys.contains(&min_key) {
                    return Err(format!("方案界面参数 {} 的动态最小值引用无效", field.key));
                }
            }
        }
    }
    Ok(())
}

fn read_or_migrate_package(
    root: &Path,
    mut manifest: WorkflowModuleManifest,
) -> Result<WorkflowModuleRecord, String> {
    let adapter_file = adapter_path(root, &manifest.id);
    let ui_schema_file = ui_schema_path(root, &manifest.id);
    let legacy_bindings = manifest
        .legacy_bindings
        .clone()
        .unwrap_or_else(|| WorkflowBindings::for_variant(&manifest.variant));
    let adapter = if adapter_file.is_file() {
        let bytes =
            fs::read(&adapter_file).map_err(|error| format!("读取方案适配器失败：{error}"))?;
        serde_json::from_slice::<WorkflowAdapter>(&bytes)
            .map_err(|error| format!("解析方案适配器失败：{error}"))?
    } else {
        let adapter = WorkflowAdapter::for_variant(&manifest.variant, legacy_bindings);
        write_json_file(&adapter_file, &adapter, "方案适配器")?;
        adapter
    };
    validate_adapter_contract(&adapter, &manifest.capability, &manifest.variant)?;
    let ui_schema = if ui_schema_file.is_file() {
        let bytes =
            fs::read(&ui_schema_file).map_err(|error| format!("读取方案界面定义失败：{error}"))?;
        serde_json::from_slice::<WorkflowUiSchema>(&bytes)
            .map_err(|error| format!("解析方案界面定义失败：{error}"))?
    } else {
        let schema = WorkflowUiSchema::default();
        write_json_file(&ui_schema_file, &schema, "方案界面定义")?;
        schema
    };
    validate_ui_schema(&ui_schema)?;

    let manifest_needs_migration = manifest.adapter_kind != WORKFLOW_PACKAGE_ENGINE
        || manifest.package_schema_version != WORKFLOW_PACKAGE_SCHEMA_VERSION
        || manifest.engine_api_version != WORKFLOW_ENGINE_API_VERSION
        || manifest.adapter_entry != ADAPTER_FILE
        || manifest.ui_schema_entry != UI_SCHEMA_FILE
        || manifest.legacy_bindings.is_some();
    if manifest_needs_migration {
        manifest.adapter_kind = WORKFLOW_PACKAGE_ENGINE.to_owned();
        manifest.package_schema_version = WORKFLOW_PACKAGE_SCHEMA_VERSION;
        manifest.engine_api_version = WORKFLOW_ENGINE_API_VERSION.to_owned();
        manifest.adapter_entry = ADAPTER_FILE.to_owned();
        manifest.ui_schema_entry = UI_SCHEMA_FILE.to_owned();
        manifest.legacy_bindings = None;
        write_manifest(root, &manifest)?;
    }

    Ok(WorkflowModuleRecord {
        workflow_path: workflow_path(root, &manifest.id)
            .to_string_lossy()
            .into_owned(),
        adapter_path: adapter_file.to_string_lossy().into_owned(),
        ui_schema_path: ui_schema_file.to_string_lossy().into_owned(),
        bindings: adapter.bindings.clone(),
        adapter,
        ui_schema,
        backup_count: backup_count(root, &manifest.id),
        manifest,
    })
}

fn backup_current(root: &Path, id: &str) -> Result<(), String> {
    let current = read_or_migrate_package(root, read_manifest(root, id)?)?;
    let directory = module_dir(root, id);
    let manifest = directory.join(MANIFEST_FILE);
    let workflow = directory.join(WORKFLOW_FILE);
    if !manifest.is_file() || !workflow.is_file() {
        return Ok(());
    }
    let backup = directory.join("backups").join(format!(
        "{}-{}",
        Utc::now().timestamp_millis(),
        Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&backup).map_err(|error| format!("创建方案恢复点失败：{error}"))?;
    fs::copy(manifest, backup.join(MANIFEST_FILE))
        .map_err(|error| format!("备份方案描述失败：{error}"))?;
    fs::copy(workflow, backup.join(WORKFLOW_FILE))
        .map_err(|error| format!("备份工作流失败：{error}"))?;
    fs::copy(&current.adapter_path, backup.join(ADAPTER_FILE))
        .map_err(|error| format!("备份方案适配器失败：{error}"))?;
    fs::copy(&current.ui_schema_path, backup.join(UI_SCHEMA_FILE))
        .map_err(|error| format!("备份方案界面定义失败：{error}"))?;
    Ok(())
}

fn backup_count(root: &Path, id: &str) -> usize {
    fs::read_dir(module_dir(root, id).join("backups"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .count()
}

fn normalize_classification(capability: &str, variant: &str) -> Result<(String, String), String> {
    let capability = capability.trim();
    let variant = variant.trim();
    match capability {
        "multi-reference-video" => Ok((
            "video-generation".to_owned(),
            "reference-to-video".to_owned(),
        )),
        "first-last-frame-video" => {
            Ok(("video-generation".to_owned(), "first-last-frame".to_owned()))
        }
        "image-to-video" => Ok(("video-generation".to_owned(), "image-to-video".to_owned())),
        "last-frame-to-video" => Ok((
            "video-generation".to_owned(),
            "last-frame-to-video".to_owned(),
        )),
        "text-to-video" => Ok(("video-generation".to_owned(), "text-to-video".to_owned())),
        "video-generation"
            if matches!(
                variant,
                "reference-to-video"
                    | "first-last-frame"
                    | "image-to-video"
                    | "last-frame-to-video"
                    | "text-to-video"
            ) =>
        {
            Ok((capability.to_owned(), variant.to_owned()))
        }
        "video-generation" => Err(
            "视频生成方案必须选择多参生视频、首尾帧、图生视频、尾帧生视频或文生视频子类型"
                .to_owned(),
        ),
        "image-generation" if matches!(variant, "image-generation" | "image-edit") => {
            Ok((capability.to_owned(), variant.to_owned()))
        }
        "image-generation" => Err("图片生成方案必须选择文生图或图像编辑子类型".to_owned()),
        _ => Err(format!("不支持的工作流方案类型：{capability}")),
    }
}

pub fn list(root: &Path, include_deleted: bool) -> Result<Vec<WorkflowModuleRecord>, String> {
    fs::create_dir_all(root).map_err(|error| format!("创建工作流方案仓库失败：{error}"))?;
    let mut modules = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| format!("读取工作流方案仓库失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取工作流方案目录失败：{error}"))?;
        if !entry.path().is_dir() || !entry.path().join(MANIFEST_FILE).is_file() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let manifest = read_manifest(root, &id)?;
        if include_deleted || manifest.deleted_at.is_none() {
            modules.push(read_or_migrate_package(root, manifest)?);
        }
    }
    modules.sort_by(|left, right| {
        left.manifest
            .capability
            .cmp(&right.manifest.capability)
            .then_with(|| {
                left.manifest
                    .name
                    .to_lowercase()
                    .cmp(&right.manifest.name.to_lowercase())
            })
    });
    Ok(modules)
}

pub fn get(root: &Path, id: &str) -> Result<WorkflowModuleRecord, String> {
    let manifest = read_manifest(root, id)?;
    if manifest.deleted_at.is_some() {
        return Err(format!("工作流方案 {id} 已在回收站中"));
    }
    read_or_migrate_package(root, manifest)
}

fn require_input(workflow: &Value, node_id: &str, input_name: &str, issues: &mut Vec<String>) {
    if workflow
        .get(node_id)
        .and_then(|node| node.get("inputs"))
        .and_then(|inputs| inputs.get(input_name))
        .is_none()
    {
        issues.push(format!("节点 {node_id} 缺少 inputs.{input_name}"));
    }
}

fn validate_input_connections(
    workflow: &serde_json::Map<String, Value>,
    node_id: &str,
    input_name: &str,
    value: &Value,
    issues: &mut Vec<String>,
) {
    if let Some(connection) = value.as_array() {
        if connection.len() == 2 && connection[1].as_u64().is_some() {
            if let Some(linked_node_id) = connection[0].as_str() {
                if !workflow.contains_key(linked_node_id) {
                    issues.push(format!(
                        "节点 {node_id} 的 inputs.{input_name} 引用了不存在的节点 {linked_node_id}"
                    ));
                }
                return;
            }
            if connection[0].is_number() {
                issues.push(format!(
                    "节点 {node_id} 的 inputs.{input_name} 连接 ID 必须是字符串，不能是数字 {}",
                    connection[0]
                ));
                return;
            }
        }
        for nested in connection {
            validate_input_connections(workflow, node_id, input_name, nested, issues);
        }
        return;
    }
    if let Some(nested) = value.as_object() {
        for nested_value in nested.values() {
            validate_input_connections(workflow, node_id, input_name, nested_value, issues);
        }
    }
}

pub fn validate_workflow_bytes(
    bytes: &[u8],
    adapter: &WorkflowAdapter,
) -> WorkflowModuleValidation {
    let bindings = &adapter.bindings;
    let mut issues = Vec::new();
    let workflow: Value = match serde_json::from_slice(bytes) {
        Ok(workflow) => workflow,
        Err(error) => {
            return WorkflowModuleValidation {
                compatible: false,
                issues: vec![format!("JSON 解析失败：{error}")],
            }
        }
    };
    let Some(object) = workflow.as_object() else {
        return WorkflowModuleValidation {
            compatible: false,
            issues: vec!["API 工作流顶层必须是 JSON 对象".to_owned()],
        };
    };
    if object.contains_key("nodes") || object.contains_key("links") {
        issues.push("这是普通 UI 工作流，不是 API 格式工作流".to_owned());
    }
    for (node_id, node) in object {
        if let Some(inputs) = node.get("inputs").and_then(Value::as_object) {
            for (input_name, value) in inputs {
                validate_input_connections(object, node_id, input_name, value, &mut issues);
            }
        }
    }
    if adapter.capability == "image-generation" && adapter.variant == "image-generation" {
        for (node_id, input_name) in [
            (&bindings.prompt_node_id, "text"),
            (&bindings.conditioning_node_id, "text"),
            (&bindings.seed_node_id, "noise_seed"),
            (&bindings.primary_resolution_node_id, "width"),
            (&bindings.primary_resolution_node_id, "height"),
            (&bindings.primary_output_node_id, "images"),
            (&bindings.secondary_resize_node_id, "image"),
            (&bindings.secondary_audio_encode_node_id, "pixels"),
            (&bindings.primary_sampler_node_id, "latent_image"),
        ] {
            require_input(&workflow, node_id, input_name, &mut issues);
        }
        return WorkflowModuleValidation {
            compatible: issues.is_empty(),
            issues,
        };
    }
    if adapter.capability == "image-generation" && adapter.variant == "image-edit" {
        for (node_id, input_name) in [
            (&bindings.prompt_node_id, "value"),
            (&bindings.secondary_prompt_node_id, "value"),
            (&bindings.single_image_input_node_id, "image"),
            (&bindings.image_node_ids[0], "image"),
            (&bindings.secondary_image_input_node_id, "image"),
            (&bindings.conditioning_node_id, "prompt"),
            (&bindings.secondary_conditioning_node_id, "prompt"),
            (&bindings.seed_node_id, "noise_seed"),
            (&bindings.primary_sampler_node_id, "noise_seed"),
            (&bindings.primary_resolution_node_id, "width"),
            (&bindings.primary_resolution_node_id, "height"),
            (&bindings.secondary_resolution_node_id, "width"),
            (&bindings.secondary_resolution_node_id, "height"),
            (&bindings.primary_output_node_id, "images"),
        ] {
            require_input(&workflow, node_id, input_name, &mut issues);
        }
        return WorkflowModuleValidation {
            compatible: issues.is_empty(),
            issues,
        };
    }
    for (node_id, input_name) in [
        (&bindings.prompt_node_id, "value"),
        (&bindings.seed_node_id, "noise_seed"),
        (&bindings.duration_node_id, "value"),
        (&bindings.primary_resolution_node_id, "aspect_ratio"),
        (&bindings.primary_resolution_node_id, "megapixels"),
        (&bindings.secondary_resolution_node_id, "aspect_ratio"),
        (&bindings.secondary_resolution_node_id, "megapixels"),
        (&bindings.primary_sampler_node_id, "video_steps"),
        (&bindings.primary_sampler_node_id, "audio_steps"),
        (&bindings.secondary_scheduler_node_id, "steps"),
        (&bindings.secondary_guider_node_id, "model"),
        (&bindings.primary_color_node_id, "brightness"),
        (&bindings.primary_color_node_id, "contrast"),
        (&bindings.primary_color_node_id, "saturation"),
        (&bindings.secondary_color_node_id, "brightness"),
        (&bindings.secondary_color_node_id, "contrast"),
        (&bindings.secondary_color_node_id, "saturation"),
        (&bindings.diffusion_model_node_id, "unet_name"),
    ] {
        require_input(&workflow, node_id, input_name, &mut issues);
    }
    let diffusion_model_class_type = workflow
        .get(&bindings.diffusion_model_node_id)
        .and_then(|node| node.get("class_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if diffusion_model_class_type != bindings.diffusion_model_class_type {
        issues.push(format!(
            "节点 {} 类型应为 {}，实际为 {}",
            bindings.diffusion_model_node_id,
            bindings.diffusion_model_class_type,
            if diffusion_model_class_type.is_empty() {
                "<缺失>"
            } else {
                diffusion_model_class_type
            }
        ));
    }
    for node_id in [
        &bindings.primary_lora_node_id,
        &bindings.secondary_lora_node_id,
    ] {
        require_input(&workflow, node_id, "model", &mut issues);
        require_input(&workflow, node_id, "lora_name", &mut issues);
        require_input(&workflow, node_id, "strength_model", &mut issues);
        let class_type = workflow
            .get(node_id)
            .and_then(|node| node.get("class_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if class_type != bindings.lora_class_type {
            issues.push(format!(
                "节点 {node_id} 类型应为 {}，实际为 {}",
                bindings.lora_class_type,
                if class_type.is_empty() {
                    "<缺失>"
                } else {
                    class_type
                }
            ));
        }
    }
    for node_id in bindings
        .image_node_ids
        .iter()
        .chain(bindings.audio_node_ids.iter())
    {
        if !object.contains_key(node_id) {
            issues.push(format!("缺少素材输入节点 {node_id}"));
        }
    }
    if adapter.variant == "first-last-frame" {
        require_input(
            &workflow,
            &bindings.conditioning_node_id,
            "first_frame",
            &mut issues,
        );
        require_input(
            &workflow,
            &bindings.conditioning_node_id,
            "last_frame",
            &mut issues,
        );
        let task_type = workflow
            .get(&bindings.conditioning_node_id)
            .and_then(|node| node.get("inputs"))
            .and_then(|inputs| inputs.get("task_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if task_type != "FL2VA" {
            issues.push(format!(
                "节点 {} 的 inputs.task_type 必须是 FL2VA",
                bindings.conditioning_node_id
            ));
        }
    }
    if adapter.variant == "image-to-video" {
        require_input(
            &workflow,
            &bindings.conditioning_node_id,
            "first_frame",
            &mut issues,
        );
        let task_type = workflow
            .get(&bindings.conditioning_node_id)
            .and_then(|node| node.get("inputs"))
            .and_then(|inputs| inputs.get("task_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if task_type != "I2VA" {
            issues.push(format!(
                "节点 {} 的 inputs.task_type 必须是 I2VA",
                bindings.conditioning_node_id
            ));
        }
    }
    if adapter.variant == "last-frame-to-video" {
        require_input(
            &workflow,
            &bindings.conditioning_node_id,
            "last_frame",
            &mut issues,
        );
        let task_type = workflow
            .get(&bindings.conditioning_node_id)
            .and_then(|node| node.get("inputs"))
            .and_then(|inputs| inputs.get("task_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if task_type != "L2VA" {
            issues.push(format!(
                "节点 {} 的 inputs.task_type 必须是 L2VA",
                bindings.conditioning_node_id
            ));
        }
    }
    for node_id in [
        &bindings.primary_output_node_id,
        &bindings.secondary_output_node_id,
    ] {
        if !object.contains_key(node_id) {
            issues.push(format!("缺少输出节点 {node_id}"));
        }
    }
    WorkflowModuleValidation {
        compatible: issues.is_empty(),
        issues,
    }
}

pub fn validate_source(
    source_path: &Path,
    variant: &str,
    bindings: &WorkflowBindings,
) -> Result<WorkflowModuleValidation, String> {
    let bytes = fs::read(source_path)
        .map_err(|error| format!("读取工作流文件失败（{}）：{error}", source_path.display()))?;
    let adapter = WorkflowAdapter::for_variant(variant, bindings.clone());
    Ok(validate_workflow_bytes(&bytes, &adapter))
}

pub fn save(root: &Path, input: SaveWorkflowModuleInput) -> Result<WorkflowModuleRecord, String> {
    fs::create_dir_all(root).map_err(|error| format!("创建工作流方案仓库失败：{error}"))?;
    let name = validate_label(&input.name, "方案名称")?;
    let requested_capability = validate_label(&input.capability, "功能类型")?;
    let (capability, variant) = normalize_classification(&requested_capability, &input.variant)?;
    let revision = if input.revision.trim().is_empty() {
        "当前".to_owned()
    } else {
        validate_label(&input.revision, "修订名称")?
    };
    let requested_engine = validate_label(&input.adapter_kind, "方案引擎类型")?;
    if requested_engine != WORKFLOW_PACKAGE_ENGINE
        && requested_engine != H3_MULTI_REFERENCE_ADAPTER
        && requested_engine != H3_FIRST_LAST_FRAME_ADAPTER
        && requested_engine != H3_IMAGE_TO_VIDEO_ADAPTER
        && requested_engine != H3_LAST_FRAME_TO_VIDEO_ADAPTER
    {
        return Err(format!("当前程序尚不支持方案引擎 {requested_engine}"));
    }
    let bindings = input
        .bindings
        .unwrap_or_else(|| WorkflowBindings::for_variant(&variant));
    let adapter = input
        .adapter
        .unwrap_or_else(|| WorkflowAdapter::for_variant(&variant, bindings));
    validate_adapter_contract(&adapter, &capability, &variant)?;
    let ui_schema = input.ui_schema.unwrap_or_default();
    validate_ui_schema(&ui_schema)?;
    let defaults = input.defaults.unwrap_or_default();
    let source = PathBuf::from(input.source_workflow_path.trim().trim_matches('"'));
    if !source.is_absolute() || !source.is_file() {
        return Err("工作流文件必须是存在的绝对路径".to_owned());
    }
    let workflow_bytes = fs::read(&source)
        .map_err(|error| format!("读取工作流文件失败（{}）：{error}", source.display()))?;
    let validation = validate_workflow_bytes(&workflow_bytes, &adapter);
    if !validation.compatible {
        return Err(format!(
            "工作流与方案不兼容：{}",
            validation.issues.join("；")
        ));
    }

    let timestamp = now();
    let (id, created_at) = if let Some(id) = input.id.as_deref() {
        let previous = read_manifest(root, id)?;
        backup_current(root, id)?;
        (id.to_owned(), previous.created_at)
    } else {
        (
            format!("workflow-module-{}", Uuid::new_v4()),
            timestamp.clone(),
        )
    };
    let manifest = WorkflowModuleManifest {
        id: id.clone(),
        name,
        capability,
        variant,
        revision,
        package_schema_version: WORKFLOW_PACKAGE_SCHEMA_VERSION,
        engine_api_version: WORKFLOW_ENGINE_API_VERSION.to_owned(),
        adapter_kind: WORKFLOW_PACKAGE_ENGINE.to_owned(),
        adapter_entry: ADAPTER_FILE.to_owned(),
        ui_schema_entry: UI_SCHEMA_FILE.to_owned(),
        source_workflow_name: source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(WORKFLOW_FILE)
            .to_owned(),
        created_at,
        updated_at: timestamp,
        deleted_at: None,
        legacy_bindings: None,
        defaults,
    };
    let directory = module_dir(root, &id);
    fs::create_dir_all(&directory).map_err(|error| format!("创建工作流方案目录失败：{error}"))?;
    fs::write(directory.join(WORKFLOW_FILE), workflow_bytes)
        .map_err(|error| format!("保存方案工作流失败：{error}"))?;
    write_json_file(&directory.join(ADAPTER_FILE), &adapter, "方案适配器")?;
    write_json_file(&directory.join(UI_SCHEMA_FILE), &ui_schema, "方案界面定义")?;
    write_manifest(root, &manifest)?;
    read_or_migrate_package(root, manifest)
}

pub fn trash(root: &Path, id: &str) -> Result<WorkflowModuleRecord, String> {
    let mut manifest = read_manifest(root, id)?;
    if manifest.deleted_at.is_none() {
        manifest.deleted_at = Some(now());
        manifest.updated_at = now();
        write_manifest(root, &manifest)?;
    }
    read_or_migrate_package(root, manifest)
}

pub fn restore_from_trash(root: &Path, id: &str) -> Result<WorkflowModuleRecord, String> {
    let mut manifest = read_manifest(root, id)?;
    manifest.deleted_at = None;
    manifest.updated_at = now();
    write_manifest(root, &manifest)?;
    read_or_migrate_package(root, manifest)
}

pub fn purge(root: &Path, id: &str) -> Result<(), String> {
    let manifest = read_manifest(root, id)?;
    if manifest.deleted_at.is_none() {
        return Err("只能彻底删除回收站中的方案".to_owned());
    }
    fs::remove_dir_all(module_dir(root, id)).map_err(|error| format!("彻底删除方案失败：{error}"))
}

pub fn restore_latest_backup(root: &Path, id: &str) -> Result<WorkflowModuleRecord, String> {
    let backups = module_dir(root, id).join("backups");
    let mut candidates = fs::read_dir(&backups)
        .map_err(|_| "当前方案没有覆盖前恢复点".to_owned())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.path().join(MANIFEST_FILE).is_file() && entry.path().join(WORKFLOW_FILE).is_file()
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| entry.file_name());
    let backup = candidates
        .last()
        .ok_or_else(|| "当前方案没有覆盖前恢复点".to_owned())?;
    backup_current(root, id)?;
    let manifest_bytes = fs::read(backup.path().join(MANIFEST_FILE))
        .map_err(|error| format!("读取方案恢复点失败：{error}"))?;
    let mut manifest: WorkflowModuleManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("解析方案恢复点失败：{error}"))?;
    manifest.id = id.to_owned();
    manifest.deleted_at = None;
    manifest.updated_at = now();
    fs::copy(backup.path().join(WORKFLOW_FILE), workflow_path(root, id))
        .map_err(|error| format!("恢复工作流失败：{error}"))?;
    for (file_name, destination, label) in [
        (ADAPTER_FILE, adapter_path(root, id), "方案适配器"),
        (UI_SCHEMA_FILE, ui_schema_path(root, id), "方案界面定义"),
    ] {
        let source = backup.path().join(file_name);
        if source.is_file() {
            fs::copy(source, &destination).map_err(|error| format!("恢复{label}失败：{error}"))?;
        } else if destination.is_file() {
            fs::remove_file(destination).map_err(|error| format!("清理旧{label}失败：{error}"))?;
        }
    }
    write_manifest(root, &manifest)?;
    read_or_migrate_package(root, manifest)
}

pub fn export(root: &Path, export_root: &Path, id: &str) -> Result<String, String> {
    let current = get(root, id)?;
    fs::create_dir_all(export_root).map_err(|error| format!("创建方案导出目录失败：{error}"))?;
    let safe_name = current
        .manifest
        .name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let destination = export_root.join(format!(
        "{}-{}-{}.zip",
        safe_name,
        Utc::now().format("%Y%m%d-%H%M%S"),
        Uuid::new_v4().simple()
    ));
    let export_result = (|| -> Result<(), String> {
        let file =
            fs::File::create(&destination).map_err(|error| format!("创建方案备份失败：{error}"))?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (file_name, source, label) in [
            (MANIFEST_FILE, manifest_path(root, id), "方案描述"),
            (WORKFLOW_FILE, workflow_path(root, id), "工作流"),
            (
                ADAPTER_FILE,
                PathBuf::from(&current.adapter_path),
                "方案适配器",
            ),
            (
                UI_SCHEMA_FILE,
                PathBuf::from(&current.ui_schema_path),
                "方案界面定义",
            ),
        ] {
            let bytes = fs::read(source).map_err(|error| format!("读取{label}失败：{error}"))?;
            archive
                .start_file(file_name, options)
                .map_err(|error| format!("写入{label}到备份失败：{error}"))?;
            archive
                .write_all(&bytes)
                .map_err(|error| format!("写入{label}到备份失败：{error}"))?;
        }
        archive
            .finish()
            .map_err(|error| format!("完成方案备份失败：{error}"))?;
        Ok(())
    })();
    if let Err(error) = export_result {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(destination.to_string_lossy().into_owned())
}

pub fn import_bundle(root: &Path, bundle_path: &Path) -> Result<WorkflowModuleRecord, String> {
    import_bundle_with_target(root, bundle_path, None)
}

pub fn restore_bundle(
    root: &Path,
    id: &str,
    bundle_path: &Path,
) -> Result<WorkflowModuleRecord, String> {
    let current = get(root, id)?;
    if current.manifest.deleted_at.is_some() {
        return Err("回收站中的方案不能从备份恢复，请先恢复该方案".to_owned());
    }
    import_bundle_with_target(root, bundle_path, Some(id.to_owned()))
}

fn import_bundle_with_target(
    root: &Path,
    bundle_path: &Path,
    target_id: Option<String>,
) -> Result<WorkflowModuleRecord, String> {
    if !bundle_path.is_absolute() || !bundle_path.exists() {
        return Err("方案备份路径必须是存在的绝对路径".to_owned());
    }
    if bundle_path.is_dir() {
        return import_directory_bundle(root, bundle_path, target_id);
    }
    if bundle_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
    {
        return import_zip_bundle(root, bundle_path, target_id);
    }
    Err("请选择有效的方案备份文件；旧版备份也可以选择其目录导入".to_owned())
}

fn import_directory_bundle(
    root: &Path,
    bundle_path: &Path,
    target_id: Option<String>,
) -> Result<WorkflowModuleRecord, String> {
    let manifest_bytes = fs::read(bundle_path.join(MANIFEST_FILE))
        .map_err(|error| format!("读取方案备份描述失败：{error}"))?;
    let workflow_bytes = fs::read(bundle_path.join(WORKFLOW_FILE))
        .map_err(|error| format!("读取方案备份工作流失败：{error}"))?;
    let adapter_file = bundle_path.join(ADAPTER_FILE);
    let adapter_bytes = if adapter_file.is_file() {
        Some(fs::read(adapter_file).map_err(|error| format!("读取方案备份适配器失败：{error}"))?)
    } else {
        None
    };
    let ui_schema_file = bundle_path.join(UI_SCHEMA_FILE);
    let ui_schema_bytes = if ui_schema_file.is_file() {
        Some(
            fs::read(ui_schema_file)
                .map_err(|error| format!("读取方案备份界面定义失败：{error}"))?,
        )
    } else {
        None
    };
    import_package_bytes(
        root,
        &manifest_bytes,
        &workflow_bytes,
        adapter_bytes.as_deref(),
        ui_schema_bytes.as_deref(),
        target_id,
    )
}

fn read_zip_entry(
    archive: &mut ZipArchive<fs::File>,
    file_name: &str,
    required: bool,
) -> Result<Option<Vec<u8>>, String> {
    let mut entry = match archive.by_name(file_name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) if !required => return Ok(None),
        Err(zip::result::ZipError::FileNotFound) => {
            return Err(format!("备份文件缺少 {file_name}"));
        }
        Err(error) => return Err(format!("读取备份中的 {file_name} 失败：{error}")),
    };
    if entry.is_dir() {
        return Err(format!("备份中的 {file_name} 不是文件"));
    }
    if entry.size() > MAX_PACKAGE_ENTRY_BYTES {
        return Err(format!("备份中的 {file_name} 超过 64 MB 限制"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取备份中的 {file_name} 失败：{error}"))?;
    Ok(Some(bytes))
}

fn import_zip_bundle(
    root: &Path,
    bundle_path: &Path,
    target_id: Option<String>,
) -> Result<WorkflowModuleRecord, String> {
    let file = fs::File::open(bundle_path).map_err(|error| format!("打开方案备份失败：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("解析方案备份失败：{error}"))?;
    let manifest_bytes = read_zip_entry(&mut archive, MANIFEST_FILE, true)?.unwrap();
    let workflow_bytes = read_zip_entry(&mut archive, WORKFLOW_FILE, true)?.unwrap();
    let adapter_bytes = read_zip_entry(&mut archive, ADAPTER_FILE, false)?;
    let ui_schema_bytes = read_zip_entry(&mut archive, UI_SCHEMA_FILE, false)?;
    import_package_bytes(
        root,
        &manifest_bytes,
        &workflow_bytes,
        adapter_bytes.as_deref(),
        ui_schema_bytes.as_deref(),
        target_id,
    )
}

fn import_package_bytes(
    root: &Path,
    manifest_bytes: &[u8],
    workflow_bytes: &[u8],
    adapter_bytes: Option<&[u8]>,
    ui_schema_bytes: Option<&[u8]>,
    target_id: Option<String>,
) -> Result<WorkflowModuleRecord, String> {
    let source_manifest: WorkflowModuleManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|error| format!("解析方案备份描述失败：{error}"))?;
    let adapter = if let Some(bytes) = adapter_bytes {
        serde_json::from_slice::<WorkflowAdapter>(bytes)
            .map_err(|error| format!("解析方案备份适配器失败：{error}"))?
    } else {
        WorkflowAdapter::for_variant(
            &source_manifest.variant,
            source_manifest
                .legacy_bindings
                .clone()
                .unwrap_or_else(|| WorkflowBindings::for_variant(&source_manifest.variant)),
        )
    };
    let ui_schema = if let Some(bytes) = ui_schema_bytes {
        serde_json::from_slice::<WorkflowUiSchema>(bytes)
            .map_err(|error| format!("解析方案备份界面定义失败：{error}"))?
    } else {
        WorkflowUiSchema::default()
    };
    let staging_dir = root.join(".imports");
    fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("创建方案导入临时目录失败：{error}"))?;
    let source_workflow = staging_dir.join(format!("workflow-{}.json", Uuid::new_v4().simple()));
    fs::write(&source_workflow, workflow_bytes)
        .map_err(|error| format!("准备方案备份工作流失败：{error}"))?;
    let result = save(
        root,
        SaveWorkflowModuleInput {
            id: target_id,
            name: source_manifest.name,
            capability: source_manifest.capability,
            variant: source_manifest.variant,
            revision: source_manifest.revision,
            adapter_kind: source_manifest.adapter_kind,
            source_workflow_path: source_workflow.to_string_lossy().into_owned(),
            bindings: None,
            adapter: Some(adapter),
            ui_schema: Some(ui_schema),
            defaults: Some(source_manifest.defaults),
        },
    );
    let _ = fs::remove_file(source_workflow);
    result
}

#[cfg(test)]
mod tests {
    use super::{
        export, import_bundle, list, restore_bundle, restore_from_trash, restore_latest_backup,
        save, trash, validate_source, validate_workflow_bytes, SaveWorkflowModuleInput,
        WorkflowAdapter, WorkflowBindings, WorkflowModuleDefaults, ADAPTER_FILE,
        H3_FIRST_LAST_FRAME_ADAPTER, H3_IMAGE_TO_VIDEO_ADAPTER, H3_LAST_FRAME_TO_VIDEO_ADAPTER,
        H3_MULTI_REFERENCE_ADAPTER, UI_SCHEMA_FILE, WORKFLOW_FILE, WORKFLOW_PACKAGE_ENGINE,
    };
    use serde_json::json;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "infinite-canvas-workflow-modules-{}",
            Uuid::new_v4()
        ))
    }

    fn test_workflow() -> serde_json::Value {
        let mut workflow = json!({
            "339": { "inputs": { "value": "prompt" } },
            "348": { "inputs": { "noise_seed": 1 } },
            "350": { "inputs": { "value": 6.0 } },
            "340": { "inputs": { "aspect_ratio": "16:9", "megapixels": 0.4 } },
            "398": { "inputs": { "aspect_ratio": "16:9", "megapixels": 0.5 } },
            "358": { "class_type": "UNETLoader", "inputs": { "unet_name": "MinimaxH3\\model.safetensors" } },
            "353": { "inputs": { "model": ["358", 0] } },
            "354": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["353", 0], "lora_name": "MinimaxH3\\a.safetensors", "strength_model": 1.0 } },
            "401": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["353", 0], "lora_name": "MinimaxH3\\a.safetensors", "strength_model": 1.0 } },
            "357": { "inputs": { "video_steps": 6, "audio_steps": 8, "model": ["354", 0] } },
            "391": { "inputs": { "steps": 4, "model": ["401", 0] } },
            "393": { "class_type": "BasicGuider", "inputs": { "model": ["401", 0] } },
            "405": { "inputs": { "brightness": 1.0, "contrast": 0.9, "saturation": 0.9 } },
            "403": { "inputs": { "brightness": 1.0, "contrast": 0.9, "saturation": 1.0 } },
            "360": { "inputs": { "filename_prefix": "primary" } },
            "397": { "inputs": { "filename_prefix": "secondary" } }
        });
        let object = workflow.as_object_mut().unwrap();
        for id in [
            "362", "364", "365", "367", "368", "369", "370", "371", "372",
        ] {
            object.insert(
                id.to_owned(),
                json!({ "inputs": { "image": "example.png" } }),
            );
        }
        for id in ["374", "416"] {
            object.insert(
                id.to_owned(),
                json!({ "inputs": { "audio": "example.wav" } }),
            );
        }
        workflow
    }

    fn save_input(source: &std::path::Path) -> SaveWorkflowModuleInput {
        SaveWorkflowModuleInput {
            id: None,
            name: "H3 reference".to_owned(),
            capability: "multi-reference-video".to_owned(),
            variant: String::new(),
            revision: "v1".to_owned(),
            adapter_kind: H3_MULTI_REFERENCE_ADAPTER.to_owned(),
            source_workflow_path: source.to_string_lossy().into_owned(),
            bindings: Some(WorkflowBindings::default()),
            adapter: None,
            ui_schema: None,
            defaults: Some(WorkflowModuleDefaults::default()),
        }
    }

    #[test]
    fn saves_trashes_and_restores_modules() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.json");
        fs::write(
            &source,
            serde_json::to_vec_pretty(&test_workflow()).unwrap(),
        )
        .unwrap();

        let first = save(&root, save_input(&source)).unwrap();
        assert_eq!(first.manifest.capability, "video-generation");
        assert_eq!(first.manifest.variant, "reference-to-video");
        assert_eq!(first.manifest.adapter_kind, WORKFLOW_PACKAGE_ENGINE);
        assert!(root.join(&first.manifest.id).join(ADAPTER_FILE).is_file());
        assert!(root.join(&first.manifest.id).join(UI_SCHEMA_FILE).is_file());
        trash(&root, &first.manifest.id).unwrap();
        assert_eq!(list(&root, false).unwrap().len(), 0);
        assert_eq!(list(&root, true).unwrap().len(), 1);
        restore_from_trash(&root, &first.manifest.id).unwrap();
        assert_eq!(list(&root, false).unwrap().len(), 1);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn exported_package_carries_adapter_and_ui_schema_and_can_be_reimported() {
        let root = test_root();
        let export_root = root.join("exports");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.json");
        fs::write(
            &source,
            serde_json::to_vec_pretty(&test_workflow()).unwrap(),
        )
        .unwrap();

        let saved = save(&root, save_input(&source)).unwrap();
        let exported = PathBuf::from(export(&root, &export_root, &saved.manifest.id).unwrap());
        assert!(exported.is_file());
        assert_eq!(
            exported.extension().and_then(|value| value.to_str()),
            Some("zip")
        );
        let file = fs::File::open(&exported).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        for file_name in ["manifest.json", WORKFLOW_FILE, ADAPTER_FILE, UI_SCHEMA_FILE] {
            assert!(archive.by_name(file_name).is_ok(), "missing {file_name}");
        }
        let imported = import_bundle(&root, &exported).unwrap();
        assert_ne!(saved.manifest.id, imported.manifest.id);
        assert_eq!(saved.adapter.adapter_id, imported.adapter.adapter_id);
        assert_eq!(
            saved.ui_schema.groups.len(),
            imported.ui_schema.groups.len()
        );
        let restored = restore_bundle(&root, &saved.manifest.id, &exported).unwrap();
        assert_eq!(saved.manifest.id, restored.manifest.id);
        assert_eq!(restored.backup_count, 1);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn overwrite_creates_a_recoverable_snapshot() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.json");
        fs::write(
            &source,
            serde_json::to_vec_pretty(&test_workflow()).unwrap(),
        )
        .unwrap();

        let first = save(&root, save_input(&source)).unwrap();
        let mut overwrite = save_input(&source);
        overwrite.id = Some(first.manifest.id.clone());
        overwrite.name = "H3 updated".to_owned();
        let updated = save(&root, overwrite).unwrap();
        assert_eq!(updated.backup_count, 1);
        assert_eq!(updated.manifest.name, "H3 updated");

        let restored = restore_latest_backup(&root, &first.manifest.id).unwrap();
        assert_eq!(restored.manifest.name, "H3 reference");
        assert!(restored.backup_count >= 2);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn current_h3_workflow_matches_the_builtin_adapter() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3全能参考工作流.json");
        let validation =
            validate_source(&path, "reference-to-video", &WorkflowBindings::default()).unwrap();
        assert!(validation.compatible, "{}", validation.issues.join("; "));
    }

    #[test]
    fn current_h3_first_last_workflow_matches_the_builtin_adapter() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3首尾帧工作流.json");
        let validation = validate_source(
            &path,
            "first-last-frame",
            &WorkflowBindings::first_last_frame(),
        )
        .unwrap();
        assert!(validation.compatible, "{}", validation.issues.join("; "));
    }

    #[test]
    fn current_h3_image_to_video_workflow_matches_the_builtin_adapter() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3图生视频工作流.json");
        let validation =
            validate_source(&path, "image-to-video", &WorkflowBindings::image_to_video()).unwrap();
        assert!(validation.compatible, "{}", validation.issues.join("; "));
    }

    #[test]
    fn current_h3_last_frame_to_video_workflow_matches_the_builtin_adapter() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3尾帧生视频工作流.json");
        let validation = validate_source(
            &path,
            "last-frame-to-video",
            &WorkflowBindings::last_frame_to_video(),
        )
        .unwrap();
        assert!(validation.compatible, "{}", validation.issues.join("; "));
    }

    #[test]
    fn rejects_numeric_connection_node_ids_before_comfyui_submission() {
        let mut workflow = test_workflow();
        workflow["405"]["inputs"]["image"] = json!([330, 0]);
        let adapter =
            WorkflowAdapter::for_variant("reference-to-video", WorkflowBindings::default());
        let validation = validate_workflow_bytes(&serde_json::to_vec(&workflow).unwrap(), &adapter);
        assert!(!validation.compatible);
        assert!(validation.issues.iter().any(|issue| {
            issue.contains("节点 405")
                && issue.contains("inputs.image")
                && issue.contains("必须是字符串")
        }));
    }

    #[test]
    fn saves_first_last_workflow_with_its_own_adapter() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3首尾帧工作流.json");
        let mut input = save_input(&path);
        input.name = "H3 first and last frame".to_owned();
        input.capability = "video-generation".to_owned();
        input.variant = "first-last-frame".to_owned();
        input.bindings = None;
        input.adapter = None;
        let saved = save(&root, input).unwrap();
        assert_eq!(saved.adapter.adapter_id, H3_FIRST_LAST_FRAME_ADAPTER);
        assert_eq!(saved.adapter.input_contract.image_min, 2);
        assert_eq!(saved.adapter.input_contract.image_max, 2);
        assert_eq!(saved.bindings.image_node_ids, ["335", "417"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn saves_image_to_video_workflow_with_its_own_adapter() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3图生视频工作流.json");
        let mut input = save_input(&path);
        input.name = "H3 image to video".to_owned();
        input.capability = "video-generation".to_owned();
        input.variant = "image-to-video".to_owned();
        input.bindings = None;
        input.adapter = None;
        let saved = save(&root, input).unwrap();
        assert_eq!(saved.adapter.adapter_id, H3_IMAGE_TO_VIDEO_ADAPTER);
        assert_eq!(saved.adapter.input_contract.image_min, 1);
        assert_eq!(saved.adapter.input_contract.image_max, 1);
        assert_eq!(saved.bindings.image_node_ids, ["335"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn saves_last_frame_to_video_workflow_with_its_own_adapter() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("workflows")
            .join("MiniMax+H3尾帧生视频工作流.json");
        let mut input = save_input(&path);
        input.name = "H3 last frame to video".to_owned();
        input.capability = "video-generation".to_owned();
        input.variant = "last-frame-to-video".to_owned();
        input.bindings = None;
        input.adapter = None;
        let saved = save(&root, input).unwrap();
        assert_eq!(saved.adapter.adapter_id, H3_LAST_FRAME_TO_VIDEO_ADAPTER);
        assert_eq!(saved.adapter.input_contract.image_min, 1);
        assert_eq!(saved.adapter.input_contract.image_max, 1);
        assert_eq!(saved.bindings.image_node_ids, ["417"]);
        fs::remove_dir_all(&root).unwrap();
    }
}
