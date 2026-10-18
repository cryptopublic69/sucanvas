// Transport-specific types. Core commands are shared by desktop and server.
#[cfg(feature = "desktop")]
pub use tauri::async_runtime as runtime;
#[cfg(feature = "desktop")]
pub use tauri::{ipc::Channel, AppHandle, State};

#[cfg(not(feature = "desktop"))]
pub mod runtime {
    pub use tokio::{spawn, task::spawn_blocking};
}
#[cfg(not(feature = "desktop"))]
pub use server::*;

#[cfg(not(feature = "desktop"))]
mod server {
    use serde::Serialize;
    use serde_json::{json, Value};
    use std::{ops::Deref, path::PathBuf, sync::Arc};
    use tokio::sync::broadcast;

    pub struct State<'a, T>(pub &'a T);
    impl<T> Deref for State<'_, T> {
        type Target = T;
        fn deref(&self) -> &T {
            self.0
        }
    }

    #[derive(Clone)]
    pub struct AppHandle {
        pub root: PathBuf,
        pub events: broadcast::Sender<Value>,
    }
    impl AppHandle {
        pub fn path(&self) -> &Self {
            self
        }
        pub fn resource_dir(&self) -> Result<PathBuf, String> {
            Ok(self.root.clone())
        }
        // Canvas events carry the canvas of their records; the Web event stream
        // only forwards them to users who may read that canvas. Messages without
        // a route reach admins only (except canvas://resync, which has no content).
        pub fn emit<T: Serialize>(&self, name: &str, payload: T) -> Result<(), String> {
            let payload = serde_json::to_value(payload).map_err(|e| e.to_string())?;
            let canvas_id = payload_canvas(&payload);
            self.send(name, payload, canvas_id.as_deref(), None);
            Ok(())
        }
        pub fn emit_in_canvas<T: Serialize>(
            &self,
            name: &str,
            canvas_id: &str,
            payload: T,
        ) -> Result<(), String> {
            let payload = serde_json::to_value(payload).map_err(|e| e.to_string())?;
            self.send(name, payload, Some(canvas_id), None);
            Ok(())
        }
        // Generation progress belongs to the user who started it (all of their tabs).
        pub fn emit_to_user<T: Serialize>(
            &self,
            name: &str,
            user_id: &str,
            payload: T,
        ) -> Result<(), String> {
            let payload = serde_json::to_value(payload).map_err(|e| e.to_string())?;
            self.send(name, payload, None, Some(user_id));
            Ok(())
        }
        fn send(&self, name: &str, payload: Value, canvas_id: Option<&str>, user_id: Option<&str>) {
            let mut message = json!({"event": name, "payload": payload});
            if let Some(canvas_id) = canvas_id {
                message["canvasId"] = json!(canvas_id);
            }
            if let Some(user_id) = user_id {
                message["userId"] = json!(user_id);
            }
            let _ = self.events.send(message);
        }
    }

    // A record (or list of records from one canvas) names its canvas.
    fn payload_canvas(payload: &Value) -> Option<String> {
        let canvas = |value: &Value| {
            value
                .get("canvasId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        match payload {
            Value::Array(items) => {
                let first = canvas(items.first()?)?;
                items
                    .iter()
                    .all(|item| canvas(item).as_deref() == Some(first.as_str()))
                    .then_some(first)
            }
            value => canvas(value),
        }
    }

    pub struct Channel<T>(Arc<dyn Fn(T) + Send + Sync>);
    impl<T> Channel<T> {
        pub fn new(callback: impl Fn(T) + Send + Sync + 'static) -> Self {
            Self(Arc::new(callback))
        }
        pub fn send(&self, value: T) -> Result<(), String> {
            (self.0)(value);
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn canvas_events_carry_their_canvas_and_progress_its_user() {
            let (events, mut receiver) = broadcast::channel(8);
            let handle = AppHandle {
                root: PathBuf::new(),
                events,
            };
            handle
                .emit(
                    "canvas://node-updated",
                    json!({"id": "n", "canvasId": "c1"}),
                )
                .unwrap();
            assert_eq!(receiver.try_recv().unwrap()["canvasId"], "c1");
            handle
                .emit(
                    "canvas://nodes-created",
                    json!([{"canvasId": "c1"}, {"canvasId": "c2"}]),
                )
                .unwrap();
            assert!(receiver.try_recv().unwrap().get("canvasId").is_none());
            handle
                .emit_in_canvas("canvas://node-deleted", "c3", "n")
                .unwrap();
            let deleted = receiver.try_recv().unwrap();
            assert_eq!(
                (deleted["canvasId"].as_str(), deleted["payload"].as_str()),
                (Some("c3"), Some("n"))
            );
            handle.emit_to_user("channel:x", "u1", Value::Null).unwrap();
            assert_eq!(receiver.try_recv().unwrap()["userId"], "u1");
        }
    }
}
