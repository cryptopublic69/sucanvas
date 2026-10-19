import { request, reportWebError } from "./bridge";
import { currentAccessUser, isAdministrator } from "../account/access";

let timer: number | undefined;
let writing = Promise.resolve();
let installed = false;
let switching = false;
// Values the server derives from its own configuration; never kept from the browser.
const SERVER_KEYS = new Set(["infinite-canvas:comfy-server-url", "infinite-canvas:comfy-input-root", "infinite-canvas:comfy-output-root"]);
// web-settings.json is shared by everyone; only admins write it. Other users
// keep their changes in this browser (su item 4, CANVAS-012b-2 decision 1).
function writesToServer() {
  return isAdministrator(currentAccessUser());
}
function snapshot(): Record<string, string> {
  return Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("infinite-canvas:")).map((key) => [key, localStorage.getItem(key) ?? ""]));
}

// Per-user browser settings (CANVAS-012c5 item 1). The app reads and writes
// the live "infinite-canvas:*" keys; they always belong to the user named in
// OWNER_KEY. When someone else signs in on this browser, the live keys are put
// away under "sucanvas-user:<owner id>:" and the new user's own copy (empty for
// a first sign-in) comes back. Keys from before this change belong to nobody:
// the first user to sign in takes them over, once (LEGACY_KEY).
export const OWNER_KEY = "sucanvas:settings-owner";
export const LEGACY_KEY = "sucanvas:legacy-settings-claimed";
export const userPrefix = (userId: string) => `sucanvas-user:${userId}:`;
export function switchSettingsOwner(userId: string) {
  const owner = localStorage.getItem(OWNER_KEY);
  if (owner === null && localStorage.getItem(LEGACY_KEY) === null) {
    // First sign-in after the upgrade: the shared leftovers become this user's.
    localStorage.setItem(LEGACY_KEY, userId);
  } else if (owner !== userId) {
    const live = snapshot();
    if (owner !== null) {
      for (const key of Object.keys(localStorage)) if (key.startsWith(userPrefix(owner))) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(live)) localStorage.setItem(userPrefix(owner) + key, value);
    }
    for (const key of Object.keys(live)) localStorage.removeItem(key);
    const mine = userPrefix(userId);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(mine)) localStorage.setItem(key.slice(mine.length), localStorage.getItem(key) ?? "");
    }
  }
  localStorage.setItem(OWNER_KEY, userId);
}

export async function loadSettings() {
  const settings = await request<Record<string, string>>("/api/settings");
  const user = currentAccessUser();
  if (user) {
    // Moving keys around is not a settings change: nothing is written back.
    switching = true;
    try { switchSettingsOwner(user.id); } finally { switching = false; }
  }
  // Admins mirror the server; other users keep what they changed locally and
  // take the server's values only where they have none yet.
  const keepLocal = !writesToServer();
  if (!keepLocal) for (const key of Object.keys(localStorage)) if (key.startsWith("infinite-canvas:")) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith("infinite-canvas:")) continue;
    if (!keepLocal || SERVER_KEYS.has(key) || localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
  // Always reconnect through this deployment, including after a domain change.
  localStorage.setItem("infinite-canvas:comfy-server-url", `${window.location.origin}/api/comfy`);
  if (installed) return;
  installed = true;
  const set = Storage.prototype.setItem;
  const remove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) { set.call(this, key, value); if (this === localStorage && key.startsWith("infinite-canvas:")) schedule(); };
  Storage.prototype.removeItem = function (key) { remove.call(this, key); if (this === localStorage && key.startsWith("infinite-canvas:")) schedule(); };
  window.addEventListener("pagehide", () => {
    if (!writesToServer()) return;
    // Keepalive preserves small settings updates when navigating away.
    const body = JSON.stringify(snapshot());
    if (body.length < 60000) void fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  });
}
function schedule() { if (switching) return; window.clearTimeout(timer); timer = window.setTimeout(() => void flushSettings(), 250); }
export function flushSettings(): Promise<void> {
  window.clearTimeout(timer);
  if (!writesToServer()) return writing;
  const settings = snapshot();
  writing = writing.then(async () => { await request("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }); }).catch(reportWebError);
  return writing;
}
