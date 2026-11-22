//! Isolated, hot-pluggable Colab ComfyUI execution channel.
//!
//! Deprecation / removal switch (2 edits across the repo):
//! 1. Backend: in `src-tauri/Cargo.toml`, comment out `"colab-channel",` under `web-server`
//!    (or build with `--no-default-features --features server`).
//! 2. Frontend: in `src/colab/index.ts`, set `export const COLAB_CHANNEL_ENABLED: boolean = false;`.
//!
//! Historical `sucanvas://colab-outputs/` media reading/cleanup and existing `config.json` fields
//! remain intact even when `colab-channel` is compiled out.

/// Relative directory under `data/` holding decoded Colab outputs (`sucanvas://colab-outputs/`).
/// Kept unconditional so existing projects continue displaying and cleaning up historical renders.
#[cfg_attr(not(feature = "server"), allow(dead_code))]
pub const COLAB_OUTPUTS_DIR: &str = "colab-outputs";

/// Compile-time indicator of whether the Colab channel feature is active.
#[allow(dead_code)]
pub const ENABLED: bool = cfg!(feature = "colab-channel");

#[cfg(feature = "colab-channel")]
pub mod workflow;

#[cfg(all(feature = "server", feature = "colab-channel"))]
pub mod web;

/// Validates configured fallback Colab profile when the Colab channel feature is enabled.
#[cfg(all(feature = "server", feature = "colab-channel"))]
pub fn validate_profile(value: &str) -> Result<(), String> {
    if value.is_empty() || workflow::colab_profile_spec(value).is_some() {
        Ok(())
    } else {
        Err("Colab 档位只能为空（自动识别）、dasiwa 或 cobijada".into())
    }
}

/// Permissive validator when Colab is compiled out so existing `config.json` files still boot.
#[cfg(all(feature = "server", not(feature = "colab-channel")))]
pub fn validate_profile(_value: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "colab-channel"))]
pub mod workflow {
    use crate::{models::ComfySubmitInput, workflow_modules::WorkflowAdapter};
    use serde_json::Value;

    pub(crate) fn prepare_colab_submission_input(
        _input: &mut ComfySubmitInput,
    ) -> Result<(WorkflowAdapter, Value), String> {
        Err("当前服务端未启用 Colab 渠道模块".into())
    }

    pub(crate) fn adapt_workflow_for_colab_ss(
        _workflow: &mut Value,
        _ss_password: &str,
        _ss_compress: u8,
    ) -> Result<Vec<String>, String> {
        Err("当前服务端未启用 Colab 渠道模块".into())
    }

    pub(crate) fn collect_colab_ss_carrier_files(
        _outputs: &Value,
        _preferred_node_ids: &[String],
    ) -> Vec<(String, String, String)> {
        Vec::new()
    }
}

#[cfg(all(feature = "server", not(feature = "colab-channel")))]
pub mod web {
    use crate::{
        platform::AppHandle,
        web::{config::Config, WebState},
    };
    use axum::{http::StatusCode, Json, Router};
    use serde_json::Value;

    pub(crate) fn mount_routes(router: Router<WebState>) -> Router<WebState> {
        router
    }

    pub(crate) fn comfy_source_url(
        _value: &str,
        _public_origin: &str,
        _colab_comfy_url: &str,
    ) -> Option<String> {
        None
    }

    pub(crate) fn is_colab_comfy_url(config: &Config, value: &str) -> bool {
        let trimmed = value.trim().trim_end_matches('/');
        if trimmed == "/api/comfy-colab" || trimmed.starts_with("/api/comfy-colab/") {
            return true;
        }
        reqwest::Url::parse(trimmed).ok().is_some_and(|url| {
            config.allows_origin(&url.origin().ascii_serialization())
                && (url.path() == "/api/comfy-colab" || url.path().starts_with("/api/comfy-colab/"))
        })
    }

    pub(crate) fn targets_colab_channel(_state: &WebState, _args: &Value) -> bool {
        false
    }

    pub(crate) fn is_colab_result_url(_config: &Config, _value: &str) -> bool {
        false
    }

    pub(crate) fn resolve_server_url_arg(
        config: &Config,
        value: &str,
    ) -> Option<Result<String, String>> {
        is_colab_comfy_url(config, value).then(|| Err("当前服务端未启用 Colab 渠道模块".into()))
    }

    pub(crate) fn rewrite_result_url(_config: &Config, _text: &str) -> Option<String> {
        None
    }

    pub(crate) async fn prepare_rpc_args(
        _state: &WebState,
        _command: &str,
        _args: &mut Value,
    ) -> Result<(), (StatusCode, Json<Value>)> {
        Ok(())
    }

    pub(crate) async fn materialize_ss_outputs(
        _state: &WebState,
        _result: &mut Value,
    ) -> Result<(), String> {
        Ok(())
    }

    pub(crate) fn extra_frontend_settings(_state: &WebState) -> Option<(String, String)> {
        None
    }

    pub(crate) fn is_colab_event(_event: &str) -> bool {
        false
    }

    pub(crate) fn emit_config_changed(_handle: &AppHandle) {}
}
