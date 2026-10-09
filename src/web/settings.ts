import { request, reportWebError } from "./bridge";

let timer: number | undefined;
let writing = Promise.resolve();
let installed = false;
function snapshot(): Record<string, string> {
  return Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("infinite-canvas:")).map((key) => [key, localStorage.getItem(key) ?? ""]));
}
export async function loadSettings() {
  const settings = await request<Record<string, string>>("/api/settings");
  for (const key of Object.keys(localStorage)) if (key.startsWith("infinite-canvas:")) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(settings)) if (key.startsWith("infinite-canvas:")) localStorage.setItem(key, value);
  // Always reconnect through this deployment, including after a domain change.
  localStorage.setItem("infinite-canvas:comfy-server-url", `${window.location.origin}/api/comfy`);
  if (installed) return;
  installed = true;
  const set = Storage.prototype.setItem;
  const remove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) { set.call(this, key, value); if (this === localStorage && key.startsWith("infinite-canvas:")) schedule(); };
  Storage.prototype.removeItem = function (key) { remove.call(this, key); if (this === localStorage && key.startsWith("infinite-canvas:")) schedule(); };
  window.addEventListener("pagehide", () => {
    // Keepalive preserves small settings updates when navigating away.
    const body = JSON.stringify(snapshot());
    if (body.length < 60000) void fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  });
}
function schedule() { window.clearTimeout(timer); timer = window.setTimeout(() => void flushSettings(), 250); }
export function flushSettings(): Promise<void> {
  window.clearTimeout(timer);
  const settings = snapshot();
  writing = writing.then(async () => { await request("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }); }).catch(reportWebError);
  return writing;
}
