import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const moduleUrl = async path => {
  const input = await readFile(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
};
const { WebPosterExtractionQueue } = await import(await moduleUrl("../src/web/posterExtractionQueue.ts"));
const { requestPosterBlob } = await import(await moduleUrl("../src/web/posterRequest.ts"));
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Web runs at most six extractors and cancellation releases work for current requests", async () => {
  const queue = new WebPosterExtractionQueue();
  const calls = [];
  const finishes = new Map();
  let active = 0;
  let peak = 0;
  const enqueue = id => queue.enqueue(async signal => {
    calls.push(id); peak = Math.max(peak, ++active);
    await new Promise(resolve => { finishes.set(id, resolve); signal.addEventListener("abort", resolve, { once: true }); });
    active--;
  });
  const stopFirst = enqueue(1);
  for (let id = 2; id <= 6; id++) enqueue(id);
  const stopQueued = enqueue(7);
  enqueue(8);
  await tick();
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6]);
  stopQueued(); stopFirst(); await tick();
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 8]);
  for (const finish of finishes.values()) finish();
  await tick();
  assert.equal(peak, 6);
  assert.equal(active, 0);
  let recovered = false;
  queue.enqueue(async () => { throw new Error("bad file"); });
  queue.enqueue(async () => { recovered = true; });
  await tick();
  assert.equal(recovered, true);
});

test("Web requests binary JPEGs with authentication, abort support and no persistent HTTP cache", async t => {
  const blob = new Blob([new Uint8Array([255,216,255,217])], { type: "image/jpeg" });
  const controller = new AbortController();
  const source = "/api/comfy/view?filename=中文 clip.mp4&type=output";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url, "https://canvas.test").searchParams.get("source"), source);
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.signal, controller.signal);
    return { ok: true, blob: async () => blob };
  });
  assert.equal(await requestPosterBlob(source, controller.signal), blob);
});

test("Web rejects invalid or failed binary responses", async t => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 401 }));
  await assert.rejects(requestPosterBlob("video", signal), /401/);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, blob: async () => new Blob(["error"], { type: "text/html" }) }));
  await assert.rejects(requestPosterBlob("video", signal), /无效/);
});
