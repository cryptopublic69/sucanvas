import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/web/comfySocket.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const url = "wss://canvas.example/api/comfy/ws?clientId=original-task";

function harness(fetchResponse = async () => ({ status: 200 })) {
  let now = 0, nextId = 0;
  const timers = new Map(), sockets = [], requests = [], warnings = [];
  class Surface extends EventTarget {
    hidden = false;
    subscriptions = new Set();
    addEventListener(type, fn, options) { super.addEventListener(type, fn, options); this.subscriptions.add(fn); }
    removeEventListener(type, fn, options) { super.removeEventListener(type, fn, options); this.subscriptions.delete(fn); }
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; }
    clearTimeout(id) { timers.delete(id); }
  }
  class Close extends Event {
    constructor(type, { code = 1006, reason = "" } = {}) { super(type); this.code = code; this.reason = reason; }
  }
  class Socket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; closeCalls = 0; binaryType = "blob";
    constructor(address) { super(); this.url = address; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    message(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
    drop() { this.readyState = 3; this.dispatchEvent(new Close("close")); }
    close() { this.closeCalls++; this.drop(); }
  }
  const window = new Surface(), document = new Surface(), exports = {};
  vm.runInNewContext(js, { exports, window, document, WebSocket: Socket, EventTarget, Event, MessageEvent, CloseEvent: Close,
    AbortController, Date: { now: () => now }, console: { warn: (...args) => warnings.push(args) },
    fetch: (...args) => { requests.push(args); return fetchResponse(...args); } });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = end; await flush();
  };
  return { ...exports, sockets, requests, warnings, timers, window, document, advance, flush };
}

test("a generation socket reconnects with its task ID and retains preview/progress listeners", async () => {
  const h = harness();
  const pending = h.openWebComfySocket(url);
  h.sockets[0].open();
  const socket = await pending, received = [];
  let closes = 0;
  socket.addEventListener("message", e => received.push(e.data));
  socket.addEventListener("close", () => closes++);
  h.sockets[0].message('{"type":"progress","data":{"value":1,"max":2}}');
  h.sockets[0].drop();
  assert.equal(socket.readyState, 0);
  await h.advance(1000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].url, url);
  assert.equal(h.sockets[1].binaryType, "blob");
  h.sockets[1].open();
  const preview = new Blob(["video bytes"], { type: "video/mp4" });
  h.sockets[1].message(preview);
  assert.equal(received[1], preview);
  assert.equal(closes, 0, "transient closures must not create a second managed socket in callers");
  assert.ok(h.requests.every(([path]) => path === "/api/auth/session"), "reconnect must never resubmit a generation");
  socket.close();
  await h.advance(60_000);
  assert.equal(closes, 1);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.timers.size, 0);
  assert.equal(h.window.subscriptions.size, 0);
  assert.equal(h.document.subscriptions.size, 0);
});

test("a stalled first connection releases generation submission after four seconds and keeps retrying", async () => {
  const h = harness();
  let settled = false;
  const pending = h.openWebComfySocket(url).then(socket => { settled = true; return socket; });
  await h.advance(3999);
  assert.equal(settled, false);
  await h.advance(1);
  const socket = await pending;
  assert.equal(socket.readyState, 0);
  await h.advance(8000);
  assert.equal(h.sockets[0].closeCalls, 1);
  await h.advance(1000);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open();
  assert.equal(socket.readyState, 1);
  socket.close();
});

test("an initial close resolves immediately; repeated failures use bounded backoff", async () => {
  const h = harness();
  const pending = h.openWebComfySocket(url);
  h.sockets[0].drop();
  const socket = await pending;
  for (const delay of [1000, 2000, 4000, 8000, 10_000, 10_000]) {
    const before = h.sockets.length;
    await h.advance(delay - 1);
    assert.equal(h.sockets.length, before);
    await h.advance(1);
    assert.equal(h.sockets.length, before + 1);
    h.sockets.at(-1).drop();
  }
  socket.close();
});

test("a silent open connection is replaced and late frames from the old socket are discarded", async () => {
  const h = harness();
  const pending = h.openWebComfySocket(url);
  h.sockets[0].open();
  const socket = await pending, received = [];
  socket.addEventListener("message", e => received.push(e.data));
  await h.advance(35_000);
  assert.equal(h.sockets[0].closeCalls, 1);
  await h.advance(1000);
  h.sockets[1].open();
  h.sockets[0].message("obsolete preview");
  h.sockets[1].message("current preview");
  assert.deepEqual(received, ["current preview"]);
  assert.match(h.warnings[0][1].reason, /heartbeat timeout/);
  socket.close();
});

test("server heartbeats keep idle tasks alive without reaching preview/status parsers", async () => {
  const h = harness();
  const pending = h.openWebComfySocket(url);
  h.sockets[0].open();
  const socket = await pending;
  let messages = 0;
  socket.addEventListener("message", () => messages++);
  for (let i = 0; i < 12; i++) {
    await h.advance(10_000);
    h.sockets[0].message(h.COMFY_SOCKET_HEARTBEAT);
  }
  assert.equal(h.sockets.length, 1);
  assert.equal(messages, 0);
  socket.close();
});

test("returning from the background or restoring the network reconnects without duplicate attempts", async () => {
  const h = harness();
  const pending = h.openWebComfySocket(url);
  h.sockets[0].open();
  const socket = await pending;
  h.document.hidden = true;
  await h.advance(60_000);
  assert.equal(h.sockets.length, 1);
  h.document.hidden = false;
  h.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.sockets.length, 2);
  h.window.dispatchEvent(new Event("focus"));
  assert.equal(h.sockets.length, 2);
  h.sockets[1].drop();
  h.window.dispatchEvent(new Event("online"));
  assert.equal(h.sockets.length, 3);
  h.sockets[2].open();
  await h.advance(1000);
  assert.equal(h.sockets.length, 3);
  socket.close();
});

test("only confirmed 401 expires the session and closes every managed socket", async () => {
  const h = harness(async () => ({ status: 401 }));
  let expired = 0;
  h.window.addEventListener("sucanvas:session-expired", () => expired++);
  const first = h.openWebComfySocket(url), second = h.openWebComfySocket(url + "-monitor");
  h.sockets[0].open(); h.sockets[1].open();
  const sockets = await Promise.all([first, second]);
  h.sockets[0].drop(); h.sockets[1].drop();
  await h.flush();
  assert.equal(h.requests.length, 1, "concurrent failures share one session check");
  assert.equal(expired, 1);
  assert.ok(sockets.every(s => s.readyState === 3));
  await h.advance(60_000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.timers.size, 0);
});

test("failed session probes keep reconnecting and never lock out a valid offline session", async () => {
  const h = harness(async () => { throw new TypeError("offline"); });
  let expired = 0;
  h.window.addEventListener("sucanvas:session-expired", () => expired++);
  const pending = h.openWebComfySocket(url);
  h.sockets[0].dispatchEvent(new Event("error"));
  h.sockets[0].drop();
  const socket = await pending;
  await h.advance(1000);
  assert.equal(expired, 0);
  assert.equal(h.sockets.length, 2);
  socket.close();
});

test("locking during the initial connection cancels its timers and resolves the waiting caller", async () => {
  const h = harness();
  const pending = h.openWebComfySocket(url);
  h.window.dispatchEvent(new Event("sucanvas:session-expired"));
  const socket = await pending;
  assert.equal(socket.readyState, 3);
  await h.advance(60_000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timers.size, 0);
});
