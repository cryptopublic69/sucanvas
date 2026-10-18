//! Serializes ComfyUI websocket relays that share a clientId.
//!
//! ComfyUI's `websocket_handler` unconditionally runs `sockets.pop(clientId)` in its
//! `finally`. If an old upstream connection finishes after a new one with the same
//! clientId has registered, the new connection silently stops receiving messages.
//! Each new relay therefore waits until the previous one has fully released the
//! clientId upstream before opening its own upstream connection.

use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{watch, Notify};

// Retiring plus connecting upstream must fit inside the browser's 12 s connect timeout.
const RETIRE_TIMEOUT: Duration = Duration::from_secs(8);

pub(super) fn log(client_id: &str, message: impl std::fmt::Display) {
    // The trailing characters are unique; the GPU monitor id shares a fixed prefix.
    let short = client_id
        .char_indices()
        .rev()
        .nth(7)
        .map_or(client_id, |(start, _)| &client_id[start..]);
    eprintln!(
        "{} [comfy-ws] [{}] {message}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        if short.is_empty() { "-" } else { short }
    );
}

#[derive(Default)]
pub(crate) struct Registry {
    slots: Mutex<HashMap<String, Slot>>,
    next_generation: AtomicU64,
}

#[derive(Default)]
struct Slot {
    // Held across retire + connect + register, so handovers per clientId are serial.
    lock: Arc<tokio::sync::Mutex<()>>,
    entry: Option<Entry>,
}

struct Entry {
    generation: u64,
    stop: Arc<Notify>,
    done: watch::Receiver<bool>,
}

/// Owned by a running relay. Dropping it removes the relay's own registry entry and
/// signals `done`, so it must outlive the upstream shutdown.
pub(super) struct RelayTicket {
    registry: Arc<Registry>,
    client_id: String,
    generation: u64,
    stop: Arc<Notify>,
    done: watch::Sender<bool>,
}

impl RelayTicket {
    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn stop_signal(&self) -> Arc<Notify> {
        self.stop.clone()
    }
}

impl Drop for RelayTicket {
    fn drop(&mut self) {
        {
            let mut slots = self.registry.slots.lock().unwrap();
            if let Some(slot) = slots.get_mut(&self.client_id) {
                // A newer relay may already own the clientId; only remove our own entry.
                if slot
                    .entry
                    .as_ref()
                    .is_some_and(|entry| entry.generation == self.generation)
                {
                    slot.entry = None;
                }
                if slot.entry.is_none() && Arc::strong_count(&slot.lock) == 1 {
                    slots.remove(&self.client_id);
                }
            }
        }
        self.done.send_replace(true);
    }
}

impl Registry {
    /// Retires the relay currently registered for `client_id`, then connects and
    /// registers a new one. Nothing is registered when `connect` fails.
    pub(super) async fn handover<T, E, F, Fut>(
        self: &Arc<Self>,
        client_id: &str,
        connect: F,
    ) -> Result<(T, RelayTicket), E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        self.handover_within(client_id, RETIRE_TIMEOUT, connect)
            .await
    }

    async fn handover_within<T, E, F, Fut>(
        self: &Arc<Self>,
        client_id: &str,
        retire_timeout: Duration,
        connect: F,
    ) -> Result<(T, RelayTicket), E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let lock = self
            .slots
            .lock()
            .unwrap()
            .entry(client_id.to_owned())
            .or_default()
            .lock
            .clone();
        let serial = lock.lock_owned().await;
        let previous = self
            .slots
            .lock()
            .unwrap()
            .get(client_id)
            .and_then(|slot| slot.entry.as_ref())
            .map(|entry| (entry.generation, entry.stop.clone(), entry.done.clone()));
        if let Some((generation, stop, mut done)) = previous {
            log(client_id, format!("retiring relay #{generation}"));
            stop.notify_one();
            // A dropped sender also means the previous relay has finished.
            let finished = tokio::time::timeout(retire_timeout, async {
                let _ = done.wait_for(|done| *done).await;
            })
            .await;
            if finished.is_err() {
                log(
                    client_id,
                    format!(
                        "relay #{generation} did not finish within {}s; connecting anyway",
                        retire_timeout.as_secs_f32()
                    ),
                );
            }
        }
        let result = connect().await;
        let result = result.map(|upstream| (upstream, self.register(client_id)));
        drop(serial);
        if result.is_err() {
            self.prune(client_id);
        }
        result
    }

    fn register(self: &Arc<Self>, client_id: &str) -> RelayTicket {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let stop = Arc::new(Notify::new());
        let (done, receiver) = watch::channel(false);
        self.slots
            .lock()
            .unwrap()
            .entry(client_id.to_owned())
            .or_default()
            .entry = Some(Entry {
            generation,
            stop: stop.clone(),
            done: receiver,
        });
        RelayTicket {
            registry: self.clone(),
            client_id: client_id.to_owned(),
            generation,
            stop,
            done,
        }
    }

    fn prune(&self, client_id: &str) {
        let mut slots = self.slots.lock().unwrap();
        if slots
            .get(client_id)
            .is_some_and(|slot| slot.entry.is_none() && Arc::strong_count(&slot.lock) == 1)
        {
            slots.remove(client_id);
        }
    }

    #[cfg(test)]
    fn current_generation(&self, client_id: &str) -> Option<u64> {
        self.slots
            .lock()
            .unwrap()
            .get(client_id)
            .and_then(|slot| slot.entry.as_ref())
            .map(|entry| entry.generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> std::future::Ready<Result<(), ()>> {
        std::future::ready(Ok(()))
    }

    #[tokio::test]
    async fn handover_waits_for_previous_relay_to_finish() {
        let registry = Arc::new(Registry::default());
        let ((), first) = registry.handover("client-a", ok).await.unwrap();
        let stop = first.stop_signal();
        let retired = tokio::spawn(async move {
            stop.notified().await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let at = tokio::time::Instant::now();
            drop(first);
            at
        });
        let ((), second) = registry.handover("client-a", ok).await.unwrap();
        let connected = tokio::time::Instant::now();
        assert!(retired.await.unwrap() <= connected);
        assert_eq!(
            registry.current_generation("client-a"),
            Some(second.generation())
        );
    }

    #[tokio::test]
    async fn late_old_relay_does_not_remove_newer_entry() {
        let registry = Arc::new(Registry::default());
        let ((), stale) = registry.handover("client-a", ok).await.unwrap();
        // The old relay ignores the stop request, so the handover times out.
        let ((), current) = registry
            .handover_within("client-a", Duration::from_millis(50), ok)
            .await
            .unwrap();
        drop(stale);
        assert_eq!(
            registry.current_generation("client-a"),
            Some(current.generation())
        );
        drop(current);
        assert!(registry.slots.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_connect_registers_nothing() {
        let registry = Arc::new(Registry::default());
        let result = registry
            .handover("client-a", || std::future::ready(Err::<(), _>("refused")))
            .await;
        assert!(result.is_err());
        assert!(registry.slots.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn different_client_ids_do_not_wait_for_each_other() {
        let registry = Arc::new(Registry::default());
        let ((), _busy) = registry.handover("client-a", ok).await.unwrap();
        let other =
            tokio::time::timeout(Duration::from_secs(1), registry.handover("client-b", ok)).await;
        assert!(other.is_ok());
    }
}
