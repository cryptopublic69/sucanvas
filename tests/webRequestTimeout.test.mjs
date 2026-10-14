import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/requestTimeout.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { withRequestTimeout, WebRequestTimeoutError, rpcTimeoutMs } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("a hung request aborts and releases its action lock instead of waiting until page reload", async () => {
  let locked = false, signal;
  const action = async () => {
    locked = true;
    try { await withRequestTimeout(value => { signal = value; return new Promise(() => {}); }, 10); }
    finally { locked = false; }
  };
  await assert.rejects(action(), WebRequestTimeoutError);
  assert.equal(signal.aborted, true);
  assert.equal(locked, false);
  assert.equal(await withRequestTimeout(async () => "retry", 10), "retry");
});

test("the timeout covers stalled response bodies after headers have arrived", async () => {
  await assert.rejects(withRequestTimeout(async () => {
    const response = { json: () => new Promise(() => {}) };
    return response.json();
  }, 10), WebRequestTimeoutError);
});

test("caller cancellation propagates to active media work and pre-aborted work never starts", async () => {
  const parent = new AbortController();
  let signal;
  const result = withRequestTimeout(value => { signal = value; return new Promise(() => {}); }, 1000, parent.signal);
  await Promise.resolve();
  parent.abort();
  await assert.rejects(result, error => error.name === "AbortError");
  assert.equal(signal.aborted, true);
  let started = false;
  await assert.rejects(withRequestTimeout(async () => { started = true; }, 10, parent.signal), error => error.name === "AbortError");
  assert.equal(started, false);
});

test("generation and large file operations do not receive the ordinary mutation deadline", async t => {
  let timers = 0;
  t.mock.method(globalThis, "setTimeout", () => { timers++; throw new Error("unexpected deadline"); });
  for (const command of ["submit_comfyui_workflow", "submit_comfyui_image_workflow", "submit_comfyui_video_upscale", "export_app_backup", "restore_app_backup"]) {
    assert.equal(rpcTimeoutMs(command), 0);
    assert.equal(await withRequestTimeout(async () => "completed", rpcTimeoutMs(command)), "completed");
  }
  assert.equal(timers, 0);
  assert.equal(rpcTimeoutMs("delete_nodes_undoable"), 60_000);
  assert.equal(rpcTimeoutMs("update_node"), 60_000);
  assert.equal(rpcTimeoutMs("restore_deleted_nodes"), 60_000);
});
