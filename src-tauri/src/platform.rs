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
        pub fn emit<T: Serialize>(&self, name: &str, payload: T) -> Result<(), String> {
            let _ = self.events.send(json!({"event": name, "payload": payload}));
            Ok(())
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
}
