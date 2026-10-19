// "Someone else is on this canvas" (CANVAS-012c3, design §6). Each browser
// tab sends a heartbeat for the canvas it shows; entries live in memory only
// (never stored) and expire without heartbeats. Every change to the set of
// users on a canvas is pushed as `presence://changed` routed to that canvas,
// so the event stream only delivers it to users who may read the canvas.
use crate::platform::AppHandle;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Mutex,
    time::{Duration, Instant},
};

// Browser heartbeat interval (the client reads it from the heartbeat reply).
pub const HEARTBEAT_SECONDS: u64 = 20;
// A tab without a heartbeat for this long has left.
pub const TIMEOUT_SECONDS: u64 = 60;
// How often the server looks for expired tabs.
pub const SWEEP_SECONDS: u64 = 5;
pub const PRESENCE_EVENT: &str = "presence://changed";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentUser {
    pub user_id: String,
    pub username: String,
    pub display_name: Option<String>,
}

struct Tab {
    canvas_id: String,
    user: PresentUser,
    last_seen: Instant,
}

// Tabs are keyed by (user, tab id): a tab id sent by another user never
// touches someone else's entry.
type Tabs = HashMap<(String, String), Tab>;

pub struct Presence {
    tabs: Mutex<Tabs>,
    handle: AppHandle,
}

// Users per canvas, each user once however many tabs they have open.
fn users_by_canvas(tabs: &Tabs) -> BTreeMap<String, Vec<PresentUser>> {
    let mut canvases: BTreeMap<String, Vec<PresentUser>> = BTreeMap::new();
    for tab in tabs.values() {
        let users = canvases.entry(tab.canvas_id.clone()).or_default();
        if !users.iter().any(|user| user.user_id == tab.user.user_id) {
            users.push(tab.user.clone());
        }
    }
    for users in canvases.values_mut() {
        users.sort();
    }
    canvases
}

impl Presence {
    pub fn new(handle: AppHandle) -> Self {
        Self {
            tabs: Mutex::new(HashMap::new()),
            handle,
        }
    }

    // Applies a change and pushes the new user list of every canvas whose
    // set of users changed (an empty list when the last one left).
    fn change<R>(&self, apply: impl FnOnce(&mut Tabs) -> R) -> R {
        let mut tabs = self.tabs.lock().unwrap();
        let before = users_by_canvas(&tabs);
        let result = apply(&mut tabs);
        let after = users_by_canvas(&tabs);
        drop(tabs);
        let empty = Vec::new();
        let canvases: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
        for canvas in canvases {
            let (old, new) = (
                before.get(canvas).unwrap_or(&empty),
                after.get(canvas).unwrap_or(&empty),
            );
            if old != new {
                let _ = self.handle.emit_in_canvas(
                    PRESENCE_EVENT,
                    canvas,
                    json!({"canvasId": canvas, "users": new}),
                );
            }
        }
        result
    }

    // The tab is on `canvas_id` now (a tab shows one canvas at a time).
    // Returns everyone on that canvas, the caller included.
    pub fn heartbeat(
        &self,
        canvas_id: &str,
        tab_id: &str,
        user: PresentUser,
        now: Instant,
    ) -> Vec<PresentUser> {
        self.change(|tabs| {
            tabs.insert(
                (user.user_id.clone(), tab_id.to_owned()),
                Tab {
                    canvas_id: canvas_id.to_owned(),
                    user,
                    last_seen: now,
                },
            );
            users_by_canvas(tabs).remove(canvas_id).unwrap_or_default()
        })
    }

    // The tab closed or went back to the project list.
    pub fn leave(&self, user_id: &str, tab_id: &str) {
        self.change(|tabs| {
            tabs.remove(&(user_id.to_owned(), tab_id.to_owned()));
        });
    }

    // Tabs without a heartbeat for TIMEOUT_SECONDS have left.
    pub fn sweep(&self, now: Instant) {
        let timeout = Duration::from_secs(TIMEOUT_SECONDS);
        self.change(|tabs| tabs.retain(|_, tab| now.duration_since(tab.last_seen) < timeout));
    }

    // A deleted or disabled account disappears at once from every canvas.
    pub fn remove_user(&self, user_id: &str) {
        self.change(|tabs| tabs.retain(|(owner, _), _| owner != user_id));
    }

    #[cfg(test)]
    pub fn users(&self, canvas_id: &str) -> Vec<PresentUser> {
        users_by_canvas(&self.tabs.lock().unwrap())
            .remove(canvas_id)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tokio::sync::broadcast;

    fn presence() -> (Presence, broadcast::Receiver<Value>) {
        let (events, receiver) = broadcast::channel(64);
        let handle = AppHandle {
            root: std::path::PathBuf::new(),
            events,
        };
        (Presence::new(handle), receiver)
    }
    fn user(id: &str) -> PresentUser {
        PresentUser {
            user_id: id.to_owned(),
            username: id.to_owned(),
            display_name: None,
        }
    }
    fn ids(users: &[PresentUser]) -> Vec<&str> {
        users.iter().map(|user| user.user_id.as_str()).collect()
    }
    // (canvas routing field, user ids in the payload) of every pushed event.
    fn pushed(receiver: &mut broadcast::Receiver<Value>) -> Vec<(String, Vec<String>)> {
        let mut events = Vec::new();
        while let Ok(message) = receiver.try_recv() {
            assert_eq!(message["event"], PRESENCE_EVENT);
            assert_eq!(message["canvasId"], message["payload"]["canvasId"]);
            let users = message["payload"]["users"]
                .as_array()
                .unwrap()
                .iter()
                .map(|user| user["userId"].as_str().unwrap().to_owned())
                .collect();
            events.push((message["canvasId"].as_str().unwrap().to_owned(), users));
        }
        events
    }

    #[test]
    fn heartbeats_list_each_user_once_and_push_only_changes_routed_to_the_canvas() {
        let (presence, mut events) = presence();
        let start = Instant::now();
        assert_eq!(
            ids(&presence.heartbeat("c1", "tab-a1", user("alice"), start)),
            ["alice"]
        );
        // A second tab of alice and repeated heartbeats change nothing visible.
        presence.heartbeat("c1", "tab-a2", user("alice"), start);
        presence.heartbeat("c1", "tab-a1", user("alice"), start);
        let both = presence.heartbeat("c1", "tab-x", user("admin"), start);
        assert_eq!(ids(&both), ["admin", "alice"]);
        assert_eq!(
            pushed(&mut events),
            [
                ("c1".to_owned(), vec!["alice".to_owned()]),
                (
                    "c1".to_owned(),
                    vec!["admin".to_owned(), "alice".to_owned()]
                ),
            ]
        );
        // Moving a tab to another canvas updates both canvases.
        presence.heartbeat("c2", "tab-x", user("admin"), start);
        let mut moved = pushed(&mut events);
        moved.sort();
        assert_eq!(
            moved,
            [
                ("c1".to_owned(), vec!["alice".to_owned()]),
                ("c2".to_owned(), vec!["admin".to_owned()]),
            ]
        );
        // Another user's leave with alice's tab id removes nothing.
        presence.leave("bob", "tab-a1");
        assert_eq!(ids(&presence.users("c1")), ["alice"]);
        assert!(pushed(&mut events).is_empty());
        // alice is shown until her last tab leaves.
        presence.leave("alice", "tab-a1");
        assert_eq!(ids(&presence.users("c1")), ["alice"]);
        presence.leave("alice", "tab-a2");
        assert!(presence.users("c1").is_empty());
        assert_eq!(pushed(&mut events), [("c1".to_owned(), vec![])]);
    }

    #[test]
    fn tabs_expire_after_the_timeout_without_heartbeats() {
        let (presence, mut events) = presence();
        let start = Instant::now();
        presence.heartbeat("c1", "tab-a", user("alice"), start);
        presence.heartbeat("c1", "tab-b", user("bob"), start);
        let later = |seconds| start + Duration::from_secs(seconds);
        presence.heartbeat("c1", "tab-b", user("bob"), later(HEARTBEAT_SECONDS * 2));
        pushed(&mut events);
        presence.sweep(later(TIMEOUT_SECONDS - 1));
        assert_eq!(ids(&presence.users("c1")), ["alice", "bob"]);
        assert!(pushed(&mut events).is_empty());
        presence.sweep(later(TIMEOUT_SECONDS));
        assert_eq!(ids(&presence.users("c1")), ["bob"]);
        assert_eq!(
            pushed(&mut events),
            [("c1".to_owned(), vec!["bob".to_owned()])]
        );
    }

    #[test]
    fn removed_users_disappear_from_every_canvas_at_once() {
        let (presence, mut events) = presence();
        let now = Instant::now();
        presence.heartbeat("c1", "tab-1", user("carol"), now);
        presence.heartbeat("c2", "tab-2", user("carol"), now);
        presence.heartbeat("c2", "tab-3", user("alice"), now);
        pushed(&mut events);
        presence.remove_user("carol");
        assert!(presence.users("c1").is_empty());
        assert_eq!(ids(&presence.users("c2")), ["alice"]);
        let mut changes = pushed(&mut events);
        changes.sort();
        assert_eq!(
            changes,
            [
                ("c1".to_owned(), vec![]),
                ("c2".to_owned(), vec!["alice".to_owned()]),
            ]
        );
    }
}
