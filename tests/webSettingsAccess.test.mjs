import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
const react = moduleUrl("export function useSyncExternalStore(_subscribe, snapshot) { return snapshot(); }");
const accessUrl = moduleUrl((await readFile(new URL("../src/account/access.ts", import.meta.url), "utf8")).replace('"react"', JSON.stringify(react)));
// Recorder in place of the bridge: GET /api/settings answers with the server copy.
const bridge = moduleUrl(`export const calls = []; export let server = {};
export function setServer(value) { server = value; }
export async function request(path, options) { calls.push({ path, method: options?.method ?? "GET", body: options?.body }); return server; }
export function reportWebError(error) { calls.push({ error: String(error) }); }`);
const bridgeModule = await import(bridge);
const access = await import(accessUrl);
// Fresh copy per run so the one-time Storage patch does not leak between tests.
async function settingsModule() {
  const source = (await readFile(new URL("../src/web/settings.ts", import.meta.url), "utf8"))
    .replace('"./bridge"', JSON.stringify(bridge))
    .replace('"../account/access"', JSON.stringify(accessUrl));
  return import(moduleUrl(source + `\n// ${Math.random()}`));
}
function browser(t, initial = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    get length() { return store.size; },
  };
  // Object.keys(localStorage) lists the stored keys, like the browser.
  const proxy = new Proxy(localStorage, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: (_target, key) => (store.has(key) ? { enumerable: true, configurable: true, value: store.get(key) } : undefined) });
  const previous = { localStorage: globalThis.localStorage, window: globalThis.window, Storage: globalThis.Storage };
  globalThis.localStorage = proxy;
  globalThis.Storage = function Storage() {};
  globalThis.window = { location: { origin: "https://canvas.example.com" }, addEventListener: () => {}, setTimeout, clearTimeout };
  t.after(() => { Object.assign(globalThis, previous); access.setAccessUser(null); bridgeModule.calls.length = 0; });
  return store;
}

test("regular users keep settings in the browser and never write them back", async (t) => {
  const store = browser(t, { "infinite-canvas:theme": "light", "infinite-canvas:comfy-input-root": "stale" });
  access.setAccessUser({ id: "u1", username: "alice", displayName: null, role: "user" });
  bridgeModule.setServer({ "infinite-canvas:theme": "dark", "infinite-canvas:video-defaults": "{}", "infinite-canvas:comfy-input-root": "E:\\input" });
  const settings = await settingsModule();
  await settings.loadSettings();
  assert.equal(store.get("infinite-canvas:theme"), "light", "local choice kept");
  assert.equal(store.get("infinite-canvas:video-defaults"), "{}", "server value fills a missing key");
  assert.equal(store.get("infinite-canvas:comfy-input-root"), "E:\\input", "server-managed key always follows the server");
  await settings.flushSettings();
  assert.deepEqual(bridgeModule.calls.filter((call) => call.method === "PUT"), []);
  assert.deepEqual(bridgeModule.calls.filter((call) => call.error), []);
});

// CANVAS-012c5 item 1: settings in one browser are kept per user.
test("users on one browser keep separate settings; old shared keys go to the first sign-in only", async (t) => {
  const store = browser(t, { "infinite-canvas:theme": "light", "infinite-canvas:project-columns": "5" });
  bridgeModule.setServer({ "infinite-canvas:theme": "dark" });
  const settings = await settingsModule();
  const alice = { id: "u-alice", username: "alice", displayName: null, role: "user" };
  const bob = { id: "u-bob", username: "bob", displayName: null, role: "user" };
  access.setAccessUser(alice);
  await settings.loadSettings();
  assert.equal(store.get("infinite-canvas:theme"), "light", "first sign-in takes over the old keys");
  assert.equal(store.get(settings.LEGACY_KEY), "u-alice");
  access.setAccessUser(bob);
  await settings.loadSettings();
  assert.equal(store.get("infinite-canvas:theme"), "dark", "bob does not get alice's theme");
  assert.equal(store.has("infinite-canvas:project-columns"), false);
  assert.equal(store.get("sucanvas-user:u-alice:infinite-canvas:theme"), "light", "alice's copy is put away");
  store.set("infinite-canvas:project-columns", "2"); // bob changes something
  access.setAccessUser(alice);
  await settings.loadSettings();
  assert.equal(store.get("infinite-canvas:theme"), "light");
  assert.equal(store.get("infinite-canvas:project-columns"), "5", "alice gets her own value back");
  access.setAccessUser(bob);
  await settings.loadSettings();
  assert.equal(store.get("infinite-canvas:project-columns"), "2", "bob's change survived");
  assert.equal(store.get(settings.OWNER_KEY), "u-bob");
  // The migration happens once: a later browser state without an owner is not handed over again.
  assert.equal(store.get(settings.LEGACY_KEY), "u-alice");
  assert.deepEqual(bridgeModule.calls.filter((call) => call.method === "PUT"), []);
});

test("admins mirror the server and write changes back", async (t) => {
  const store = browser(t, { "infinite-canvas:theme": "light", "infinite-canvas:leftover": "x" });
  access.setAccessUser({ id: "u0", username: "admin", displayName: null, role: "admin" });
  bridgeModule.setServer({ "infinite-canvas:theme": "dark" });
  const settings = await settingsModule();
  await settings.loadSettings();
  assert.equal(store.get("infinite-canvas:theme"), "dark");
  assert.equal(store.has("infinite-canvas:leftover"), false);
  await settings.flushSettings();
  const puts = bridgeModule.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(JSON.parse(puts[0].body)["infinite-canvas:theme"], "dark");
});
