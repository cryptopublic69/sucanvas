//! Web generation results outlive the HTTP request that starts them.
use super::WebState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const RESULT_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_TASKS: usize = 1024;

struct Task {
    command: String,
    args: Value,
    result: Option<Result<Value, String>>,
    updated: Instant,
}

#[derive(Default)]
pub(super) struct Tasks(Mutex<HashMap<String, Task>>);

impl Tasks {
    /// Reserve before spawning, so duplicate starts never execute twice.
    pub fn reserve(&self, id: &str, command: &str, args: &Value) -> Result<bool, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "无效的生成任务编号".to_owned())?;
        let mut tasks = self.0.lock().map_err(|_| "生成任务状态锁已损坏")?;
        tasks.retain(|_, task| task.result.is_none() || task.updated.elapsed() < RESULT_RETENTION);
        if let Some(task) = tasks.get(id) {
            return if task.command == command && task.args == *args {
                Ok(false)
            } else {
                Err("生成任务编号已用于另一请求".into())
            };
        }
        if tasks.len() >= MAX_TASKS {
            return Err("生成任务记录已满，请稍后重试".into());
        }
        tasks.insert(
            id.to_owned(),
            Task {
                command: command.to_owned(),
                args: args.clone(),
                result: None,
                updated: Instant::now(),
            },
        );
        Ok(true)
    }

    pub fn finish(&self, id: &str, result: Result<Value, String>) {
        if let Ok(mut tasks) = self.0.lock() {
            if let Some(task) = tasks.get_mut(id) {
                task.result = Some(result);
                task.updated = Instant::now();
            }
        }
    }

    fn read(&self, id: &str) -> Result<Option<Value>, String> {
        let tasks = self.0.lock().map_err(|_| "生成任务状态锁已损坏")?;
        Ok(tasks.get(id).map(|task| match &task.result {
            None => json!({"pending": true}),
            Some(Ok(value)) => json!({"result": value}),
            Some(Err(error)) => json!({"error": error}),
        }))
    }
}

pub async fn read(State(state): State<WebState>, Path(id): Path<String>) -> Response {
    let mut response = match state.tasks.read(&id) {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "任务记录不可用，请重新进入项目恢复 ComfyUI 任务"})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error})),
        )
            .into_response(),
    };
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_start_keeps_one_worker_and_retains_the_result() {
        let tasks = Tasks::default();
        let id = uuid::Uuid::new_v4().to_string();
        let args = json!({"input": {"clientId": "client-a"}});
        assert!(tasks
            .reserve(&id, "submit_comfyui_workflow", &args)
            .unwrap());
        assert!(!tasks
            .reserve(&id, "submit_comfyui_workflow", &args)
            .unwrap());
        assert_eq!(tasks.read(&id).unwrap(), Some(json!({"pending": true})));
        tasks.finish(&id, Ok(json!({"promptId": "p", "outputs": ["clip.mp4"]})));
        let expected = Some(json!({"result": {"promptId": "p", "outputs": ["clip.mp4"]}}));
        assert_eq!(tasks.read(&id).unwrap(), expected);
        assert_eq!(tasks.read(&id).unwrap(), expected);
        assert!(!tasks
            .reserve(&id, "submit_comfyui_workflow", &args)
            .unwrap());
        assert!(tasks
            .reserve(&id, "submit_comfyui_image_workflow", &args)
            .is_err());
        assert!(tasks
            .reserve(&id, "submit_comfyui_workflow", &json!({}))
            .is_err());
    }
    #[test]
    fn errors_and_missing_tasks_are_distinct_from_pending() {
        let tasks = Tasks::default();
        assert_eq!(tasks.read("unknown").unwrap(), None);
        assert!(tasks
            .reserve("invalid", "submit_comfyui_workflow", &json!({}))
            .is_err());
        let id = uuid::Uuid::new_v4().to_string();
        tasks
            .reserve(&id, "submit_comfyui_workflow", &json!({}))
            .unwrap();
        tasks.finish(&id, Err("ComfyUI failed".into()));
        assert_eq!(
            tasks.read(&id).unwrap(),
            Some(json!({"error": "ComfyUI failed"}))
        );
    }
}
