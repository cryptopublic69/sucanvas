import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/inputImageCache.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { requestInputImagePreview, peekInputImagePreview } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
let fetches = 0;
let decodes = 0;
let encodingFails = false;
let mime = "image/png";
let fetchFails = false;
const canvases = [];
globalThis.fetch = async (_src, options) => {
  fetches++;
  assert.equal(options.credentials, "same-origin");
  return { ok: !fetchFails, status: fetchFails ? 503 : 200, blob: async () => new Blob(["original"], { type: mime }) };
};
globalThis.Image = class {
  naturalWidth = 4096;
  naturalHeight = 2048;
  set src(value) { this.source = value; decodes++; queueMicrotask(() => this.onload()); }
};
globalThis.document = { createElement(tag) {
  assert.equal(tag, "canvas");
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob(callback, format) { assert.equal(format, "image/webp"); callback(encodingFails ? null : new Blob(["preview"], { type: format })); } };
  canvases.push(canvas);
  return canvas;
} };

test("input views share one fetch and preserve original dimensions with a bounded preview", async () => {
  const start = fetches;
  const src = "/api/resource?resource=input-a";
  const first = requestInputImagePreview(src);
  assert.equal(requestInputImagePreview(src), first);
  const preview = await first;
  assert.equal(fetches, start + 1);
  assert.equal(preview.width, 4096);
  assert.equal(preview.height, 2048);
  assert.equal(canvases.at(-1).width, 1280);
  assert.equal(canvases.at(-1).height, 640);
  assert.equal(peekInputImagePreview(src), preview);
  assert.equal(await requestInputImagePreview(src), preview);
  assert.equal(fetches, start + 1);
});

test("640 input previews stay resident and returning does not fetch or decode them again", async () => {
  const inputs = await Promise.all(Array.from({ length: 640 }, (_, i) => requestInputImagePreview(`/api/resource?resource=input-many-${i}`)));
  const loadedFetches = fetches;
  const loadedDecodes = decodes;
  for (const preview of inputs) {
    assert.equal(peekInputImagePreview(preview.src), preview);
    assert.equal(await requestInputImagePreview(preview.src), preview);
  }
  assert.equal(fetches, loadedFetches);
  assert.equal(decodes, loadedDecodes);
});

test("leaving the viewport during a request still populates the session cache", async () => {
  const src = "/api/resource?resource=input-left-viewport";
  requestInputImagePreview(src);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(peekInputImagePreview(src));
});

test("large input sets limit simultaneous fetch and decode work", async (t) => {
  const waiting = [];
  let started = 0;
  t.mock.method(globalThis, "fetch", () => { started++; return new Promise(resolve => waiting.push(resolve)); });
  const requests = Array.from({ length: 12 }, (_, i) => requestInputImagePreview(`/api/resource?resource=input-bounded-${i}`));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 4);
  for (let batch = 0; batch < 3; batch++) {
    assert.equal(waiting.length, 4);
    waiting.splice(0).forEach(resolve => resolve({ ok: true, blob: async () => new Blob(["source"], { type: "image/png" }) }));
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal((await Promise.all(requests)).length, 12);
});

test("failed image requests can retry without poisoning the cache", async () => {
  const src = "/api/resource?resource=input-retry";
  fetchFails = true;
  await assert.rejects(requestInputImagePreview(src), /503/);
  assert.equal(peekInputImagePreview(src), undefined);
  fetchFails = false;
  assert.ok(await requestInputImagePreview(src));
});

test("an updated asset uses a new preview without replacing an existing cached image", async () => {
  const before = await requestInputImagePreview("/api/resource?resource=input-before");
  const after = await requestInputImagePreview("/api/resource?resource=input-after");
  assert.notEqual(before.url, after.url);
  assert.equal(peekInputImagePreview(before.src), before);
});

test("GIFs keep their animation bytes and thumbnail encoder failure keeps the source usable", async () => {
  mime = "image/gif";
  const count = canvases.length;
  const animated = await requestInputImagePreview("/api/resource?resource=input-animated");
  assert.equal(canvases.length, count);
  assert.equal((await fetchOriginalBlob(animated.url)).type, "image/gif");
  mime = "image/png";
  encodingFails = true;
  const fallback = await requestInputImagePreview("/api/resource?resource=input-fallback");
  assert.equal((await fetchOriginalBlob(fallback.url)).type, "image/png");
  encodingFails = false;
});

// Use Node's original Blob URL reader independently of the source request stub.
import { resolveObjectURL } from "node:buffer";
async function fetchOriginalBlob(url) { return resolveObjectURL(url); }
