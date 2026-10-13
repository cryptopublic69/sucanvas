import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/viewportPosterQueue.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { visiblePosterSources, requestVisiblePosters } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const tick = () => new Promise(resolve => setImmediate(resolve));

test("all 640 visible videos are eligible, with the viewport center first and offscreen files excluded", () => {
  const candidates = Array.from({ length: 640 }, (_, i) => ({ src: `video-${i}`, x: (i % 32) * 30, y: Math.floor(i / 32) * 30, width: 10, height: 10 }));
  candidates.push({ src: "center", x: 495, y: 395, width: 10, height: 10 });
  candidates.push({ src: "offscreen", x: -300, y: 100, width: 10, height: 10 });
  const sources = visiblePosterSources(candidates, 1000, 800);
  assert.equal(sources.length, 641);
  assert.equal(sources[0], "center");
  assert.ok(!sources.includes("offscreen"));
});

test("missing simplified covers are generated serially in visible priority order", async () => {
  const calls = [];
  const finish = [];
  let done = 0;
  requestVisiblePosters(["near", "middle", "edge"], (src, complete) => {
    calls.push(src); finish.push(complete); return () => {};
  }, () => done++);
  assert.deepEqual(calls, ["near"]);
  finish.shift()(); await tick();
  assert.deepEqual(calls, ["near", "middle"]);
  finish.shift()(); await tick();
  assert.deepEqual(calls, ["near", "middle", "edge"]);
  finish.shift()(); await tick();
  assert.equal(done, 1);
});

test("moving to another region cancels old viewport work before generating the new visible region", async () => {
  const calls = [];
  let cancelled = 0;
  let staleComplete;
  const stop = requestVisiblePosters(["old-active", "old-queued"], (src, complete) => {
    calls.push(src); staleComplete = complete; return () => cancelled++;
  }, () => { throw new Error("cancelled viewport must not finish"); });
  stop();
  requestVisiblePosters(["new-visible"], (src, complete) => { calls.push(src); complete(); return () => {}; }, () => {});
  staleComplete(); await tick();
  assert.equal(cancelled, 1);
  assert.deepEqual(calls, ["old-active", "new-visible"]);
});

test("640 warm session hits finish without recursion or extraction work", async () => {
  let delivered = 0;
  let done = 0;
  requestVisiblePosters(Array.from({ length: 640 }, (_, i) => `warm-${i}`), (_src, complete) => {
    delivered++; complete(); return () => {};
  }, () => done++);
  await tick();
  assert.equal(delivered, 640);
  assert.equal(done, 1);
});

test("visible work uses three parallel slots while preserving start order and cancelling all old requests", async () => {
  const calls = [];
  const finishes = [];
  const cancelled = [];
  let completed = 0;
  const stop = requestVisiblePosters(["a", "b", "c", "d", "e", "f"], (src, complete) => {
    calls.push(src); finishes.push(complete); return () => cancelled.push(src);
  }, () => completed++, 3);
  assert.deepEqual(calls, ["a", "b", "c"]);
  finishes[1](); await tick();
  assert.deepEqual(calls, ["a", "b", "c", "d"]);
  stop(); await tick();
  assert.deepEqual(cancelled.sort(), ["a", "c", "d"]);
  assert.ok(!calls.includes("e"));
  assert.equal(completed, 0);
});
