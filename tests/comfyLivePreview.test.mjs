import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/comfyLivePreview.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { LivePreviewResourcePool, comfyStatusMessage, comfyPreviewImageBlobFromSocketData: decode,
  createComfyPreviewReceiver, MAX_PREVIEW_BYTES, MAX_PREVIEW_TEXT_LENGTH } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`,
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const packet = (extra = {}) => JSON.stringify({ type: "kj_preview_override",
  data: { node_id: "42", image: btoa("test frame"), mime: "video/mp4", ...extra } });

test("oversized previews and preview/status cross-routing are rejected before JSON parsing", async () => {
  const oversized = '"kj_preview_override"' + " ".repeat(MAX_PREVIEW_TEXT_LENGTH);
  const normalPreview = packet();
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = (...args) => { calls++; return original(...args); };
  try {
    assert.equal(await decode(oversized), null);
    assert.equal(comfyStatusMessage(oversized), null);
    assert.equal(comfyStatusMessage(normalPreview), null);
    assert.equal(await decode('{"type":"progress","data":{"value":1,"max":2}}'), null);
    assert.equal(calls, 0);
  } finally { JSON.parse = original; }
});

test("valid live previews retain MIME and node filtering; ordinary status still works", async () => {
  const preview = await decode(packet(), "42");
  assert.equal(preview.type, "video/mp4");
  assert.equal(await preview.text(), "test frame");
  assert.equal(await decode(packet(), "different"), null);
  assert.equal(await decode(packet({ mime: "text/html" })), null);
  assert.equal(comfyStatusMessage('{"type":"progress","data":{"value":1,"max":2}}').data.max, 2);
});

test("binary preview limit is checked before reading a blob", async () => {
  const oversized = new Blob([new Uint8Array(MAX_PREVIEW_BYTES + 9)]);
  oversized.arrayBuffer = () => { throw new Error("must not read oversized payload"); };
  assert.equal(await decode(oversized), null);
  const bytes = new Uint8Array(12);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 1); header.setUint32(4, 2);
  bytes.set([1, 2, 3, 4], 8);
  const preview = await decode(bytes.buffer);
  assert.equal(preview.type, "image/png");
  assert.deepEqual([...new Uint8Array(await preview.arrayBuffer())], [1, 2, 3, 4]);
});

test("preview bursts decode once; inactive and completed consumers receive nothing", async () => {
  let delivered = 0;
  let active = true;
  const receive = createComfyPreviewReceiver("42", () => active, () => delivered++);
  for (let i = 0; i < 100; i++) receive(packet());
  await tick();
  assert.equal(delivered, 1);
  active = false;
  receive(packet());
  await tick();
  assert.equal(delivered, 1);
  active = true;
  const cancelled = createComfyPreviewReceiver("42", () => active, () => delivered++);
  cancelled(packet()); active = false;
  await tick();
  assert.equal(delivered, 1);
});

function resourcePool() {
  const alive = new Set();
  let next = 0;
  const pool = new LivePreviewResourcePool({
    createObjectURL() { const url = `blob:${++next}`; alive.add(url); return url; },
    revokeObjectURL(url) { assert.ok(alive.delete(url), "a URL must be revoked only once"); },
  }, 0);
  return { pool, alive };
}

test("hundreds of superseded frames are released while current and paused frames remain usable", async () => {
  const { pool, alive } = resourcePool();
  const paused = pool.create(new Blob(["paused"]));
  const release = pool.retain(paused);
  pool.retire(paused);
  for (let i = 0; i < 500; i++) pool.retire(pool.create(new Blob(["old frame"])));
  const current = pool.create(new Blob(["current"]));
  await tick();
  assert.deepEqual([...alive], [paused, current]);
  release(); release();
  assert.deepEqual([...alive], [current]);
  pool.clear();
  assert.equal(alive.size, 0);
});

test("commit grace allows a displayed frame to acquire ownership; unmount cleans timers", async () => {
  const { pool, alive } = resourcePool();
  const url = pool.create(new Blob(["frame"]));
  pool.retire(url);
  const releaseOne = pool.retain(url);
  const releaseTwo = pool.retain(url);
  await tick();
  releaseOne();
  assert.equal(alive.size, 1);
  pool.clear();
  releaseTwo();
  await tick();
  assert.equal(alive.size, 0);
});


test("preview decoding is single-flight across different generation tasks", async () => {
  let delivered = 0;
  const first = createComfyPreviewReceiver("42", () => true, () => delivered++);
  const second = createComfyPreviewReceiver("42", () => true, () => delivered++);
  first(packet()); second(packet());
  await tick();
  assert.equal(delivered, 1);
  second(packet());
  await tick();
  assert.equal(delivered, 2);
});

test("resource budget includes paused and retiring frames and recovers after release", async () => {
  const alive = new Set();
  let next = 0;
  const pool = new LivePreviewResourcePool({
    createObjectURL() { const url = `blob:budget-${++next}`; alive.add(url); return url; },
    revokeObjectURL(url) { alive.delete(url); },
  }, 0, 8);
  const url = pool.create(new Blob(["12345678"]));
  const release = pool.retain(url);
  pool.retire(url);
  await tick();
  assert.equal(pool.create(new Blob(["x"])), null);
  assert.equal(alive.size, 1);
  release();
  assert.ok(pool.create(new Blob(["12345678"])));
  pool.clear();
  assert.ok(pool.create(new Blob(["12345678"])));
  pool.clear();
});
