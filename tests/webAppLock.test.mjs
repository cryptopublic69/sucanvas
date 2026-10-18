import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
const urls = moduleUrl(await readFile(new URL("../src/web/urls.ts", import.meta.url), "utf8"));
const timeout = moduleUrl(await readFile(new URL("../src/web/requestTimeout.ts", import.meta.url), "utf8"));
const generation = moduleUrl(await readFile(new URL("../src/web/generationRequest.ts", import.meta.url), "utf8"));
const localVideoMetadata = moduleUrl(await readFile(new URL("../src/web/localVideoMetadata.ts", import.meta.url), "utf8"));
const uploadedVideoMetadata = moduleUrl(await readFile(new URL("../src/media/uploadedVideoMetadata.ts", import.meta.url), "utf8"));
const source = (await readFile(new URL("../src/web/bridge.ts", import.meta.url), "utf8"))
  .replace('"./urls"', JSON.stringify(urls))
  .replace('"./requestTimeout"', JSON.stringify(timeout))
  .replace('"./generationRequest"', JSON.stringify(generation))
  .replace('"./localVideoMetadata"', JSON.stringify(localVideoMetadata))
  .replace('"../media/uploadedVideoMetadata"', JSON.stringify(uploadedVideoMetadata))
  .replace('const devBackend = import.meta.env.DEV ? import.meta.env.SUCANVAS_WEB_DEV_BACKEND ?? "" : "";', 'const devBackend = "";');
const { invoke, request, listen, closeEvents } = await import(moduleUrl(source));

function environment(t, status = 200) {
  const requests = [], events = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    requests.push({ path, options });
    return { status, ok: status === 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ error: "密码错误" }) };
  });
  const previous = globalThis.window;
  globalThis.window = { location: { origin: "http://127.0.0.1:1422" }, dispatchEvent: (event) => events.push(event.type) };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  return { requests, events };
}

test("re-entering a password checks the signed-in user's own password without a new session", async (t) => {
  const { requests, events } = environment(t);
  assert.equal(await invoke("verify_app_lock_password", { password: "应用锁密码" }), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/auth/verify-password");
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[0].options.body), { password: "应用锁密码" });
  assert.deepEqual(events, []);
});

test("a wrong re-entered password reports the error without a session-expired event", async (t) => {
  const { events } = environment(t, 400);
  await assert.rejects(invoke("verify_app_lock_password", { password: "wrong" }), /密码错误/);
  assert.deepEqual(events, []);
});

test("an account that must change its password is sent to the password page", async (t) => {
  const events = [];
  t.mock.method(globalThis, "fetch", async () => ({ status: 403, ok: false, text: async () => JSON.stringify({ error: "请先修改初始密码", code: "password_change_required" }) }));
  const previous = globalThis.window;
  globalThis.window = { location: { origin: "http://127.0.0.1:1422" }, dispatchEvent: (event) => events.push(event.type) };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  await assert.rejects(request("/api/settings"), /请先修改初始密码/);
  assert.deepEqual(events, ["sucanvas:password-change-required"]);
  // Other refusals (e.g. a regular user calling an admin endpoint) do not redirect.
  t.mock.method(globalThis, "fetch", async () => ({ status: 403, ok: false, text: async () => JSON.stringify({ error: "只有管理员可以执行此操作", code: "forbidden" }) }));
  await assert.rejects(request("/api/admin/users"), /只有管理员/);
  assert.deepEqual(events, ["sucanvas:password-change-required"]);
});

test("protected request rejection returns the Web shell to the application lock", async (t) => {
  const { events } = environment(t, 401);
  await assert.rejects(request("/api/settings"), /密码错误/);
  assert.deepEqual(events, ["sucanvas:session-expired"]);
});

test("a revoked event connection confirms expiration before locking the UI", async (t) => {
  const { events } = environment(t, 401);
  const previous = globalThis.EventSource;
  let connection;
  globalThis.EventSource = class {
    constructor() { connection = this; }
    close() {}
  };
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  t.after(() => { closeEvents(); if (previous === undefined) delete globalThis.EventSource; else globalThis.EventSource = previous; });
  const ready = listen("canvas://node-created", () => {});
  connection.onopen();
  const stop = await ready;
  connection.onerror();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["sucanvas:session-expired"]);
  stop();
});

test("LAN sessions use the current entry for API media, RPC arguments and task events", async (t) => {
  environment(t);
  const canonical = "https://canvas.example.com:8888";
  const lan = "https://192.168.5.108:18741";
  window.location.origin = lan;
  const payload = { imageUrl: canonical + "/api/comfy/view?filename=scene.png", external: "https://other.example.com/api/comfy/view?filename=other.png" };
  let outgoing;
  t.mock.method(globalThis, "fetch", async (path, options) => {
    outgoing = options;
    return { status: 200, ok: true, json: async () => path.startsWith("/api/auth/") ? { ok: true, publicUrl: canonical } : { result: payload } };
  });
  await request("/api/auth/session");
  const result = await invoke("load_workspace", { imageUrl: lan + "/api/comfy/view?filename=reference.png" });
  assert.equal(result.imageUrl, lan + "/api/comfy/view?filename=scene.png");
  assert.equal(result.external, payload.external);
  assert.equal(JSON.parse(outgoing.body).args.imageUrl, canonical + "/api/comfy/view?filename=reference.png");
  const previous = globalThis.EventSource;
  let connection, received;
  globalThis.EventSource = class { constructor() { connection = this; } close() {} };
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  t.after(() => { closeEvents(); if (previous === undefined) delete globalThis.EventSource; else globalThis.EventSource = previous; });
  const ready = listen("generation://done", (event) => { received = event.payload; });
  connection.onopen();
  const stop = await ready;
  connection.onmessage({ data: JSON.stringify({ event: "generation://done", payload }) });
  assert.equal(received.imageUrl, result.imageUrl);
  assert.equal(received.external, payload.external);
  stop();
  window.location.origin = canonical;
  await request("/api/auth/login");
  assert.equal((await invoke("load_workspace")).imageUrl, payload.imageUrl);
});
