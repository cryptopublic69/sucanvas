import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
async function moduleAt(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { GraphRelations } = await moduleAt("../src/canvas/graphRelations.ts");
const { RenderQueue } = await moduleAt("../src/canvas/renderQueue.ts");
const { readCanvasViewport, saveCanvasViewport, initialCanvasViewport } = await moduleAt("../src/canvas/viewport.ts");

test("editing one source preserves unrelated dependency arrays on a large graph", () => {
  const records = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), content: { text: "prompt" } }));
  const edges = Array.from({ length: 2500 }, (_, i) => ({ id: `e${i}`, source: String(i), target: String(i + 2500) }));
  const graph = new GraphRelations();
  graph.update(records, edges);
  const previous = new Map(graph.inputs);
  const edited = records.map((record, i) => i === 23 ? { ...record, content: { text: "edited" } } : record);
  graph.update(edited, edges.map((edge) => ({ ...edge })));
  assert.equal([...graph.inputs].filter(([id, list]) => list !== previous.get(id)).length, 1);
  assert.equal(graph.inputs.get("2523")[0], edited[23]);
  graph.update(edited, edges);
  assert.equal(graph.inputs.get("2524"), previous.get("2524"));
});

test("connect, disconnect, order and content-parent changes update only affected targets", () => {
  const records = ["a", "b", "c", "x", "y"].map((id) => ({ id }));
  const edges = [{ id: "ax", source: "a", target: "x" }, { id: "by", source: "b", target: "y" }];
  const graph = new GraphRelations();
  graph.update(records, edges);
  const untouched = graph.inputs.get("y");
  const added = { id: "cx", source: "c", target: "x", kind: "content-derivation" };
  graph.update(records, [...edges, added]);
  assert.equal(graph.inputs.get("y"), untouched);
  assert.deepEqual(graph.inputs.get("x").map((r) => r.id), ["a", "c"]);
  assert.deepEqual(graph.parents.get("x").map((r) => r.id), ["c"]);
  graph.update(records, [added, ...edges]);
  assert.deepEqual(graph.inputs.get("x").map((r) => r.id), ["c", "a"]);
  graph.update(records.filter((r) => r.id !== "c"), [added, ...edges]);
  assert.deepEqual(graph.inputs.get("x").map((r) => r.id), ["a"]);
  assert.equal(graph.parents.has("x"), false);
  graph.update(records, [edges[1]]);
  assert.equal(graph.inputs.has("x"), false);
  assert.equal(graph.outputCounts.has("a"), false);
  assert.equal(graph.inputs.get("y"), untouched);
  graph.update([], []);
  assert.equal(graph.inputs.size, 0);
  assert.equal(graph.records.size, 0);
});

test("viewport survives reopening and invalid or unavailable storage is harmless", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  saveCanvasViewport(storage, "a", { x: -500, y: 88, zoom: 0.7 });
  saveCanvasViewport(storage, "b", { x: 5, y: 9, zoom: 1 });
  assert.deepEqual(readCanvasViewport(storage, "a"), { x: -500, y: 88, zoom: 0.7 });
  assert.equal(readCanvasViewport(storage, "missing"), null);
  for (const bad of ["{", "null", '{"x":0,"y":0,"zoom":0}', '{"x":"5","y":0,"zoom":1}']) {
    assert.equal(readCanvasViewport({ getItem: () => bad }, "a"), null);
  }
  assert.doesNotThrow(() => saveCanvasViewport({ setItem: () => { throw Error("quota"); } }, "a", { x: 0, y: 0, zoom: 1 }));
  const first = { x: 10000, y: 20000, width: 500, height: 400 };
  const viewport = initialCanvasViewport([first, { x: -999999, y: -999999, width: 100, height: 100 }], 1200, 800);
  assert.equal(viewport.x + (first.x + first.width / 2) * viewport.zoom, 600);
  assert.equal(viewport.y + (first.y + first.height / 2) * viewport.zoom, 400);
});

test("node mounts are prioritized, spread over frames, and canceled when no longer visible", () => {
  let id = 0;
  const frames = new Map();
  const queue = new RenderQueue((callback) => { frames.set(++id, callback); return id; }, (id) => frames.delete(id), 2);
  const ran = [];
  const frame = () => { const [key, callback] = frames.entries().next().value; frames.delete(key); callback(); };
  queue.enqueue(() => ran.push("far"), () => 100);
  const cancel = queue.enqueue(() => ran.push("removed"), () => 0);
  queue.enqueue(() => ran.push("near"), () => 1);
  queue.enqueue(() => ran.push("middle"), () => 50);
  cancel();
  frame();
  assert.deepEqual(ran, ["near", "middle"]);
  frame();
  assert.deepEqual(ran, ["near", "middle", "far"]);
  assert.equal(frames.size, 0);
  const cancelLast = queue.enqueue(() => ran.push("cancelled"));
  cancelLast();
  assert.equal(frames.size, 0);
});

test("node geometry updates share one batch and skip nodes removed before the frame", async () => {
  let source = await readFile(new URL("../src/canvas/useBatchedNodeInternals.ts", import.meta.url), "utf8");
  source = source.replace('import { useCallback } from "react";', 'const useCallback = (callback) => callback;');
  source = source.replace('import { useStoreApi, useUpdateNodeInternals } from "@xyflow/react";', `
    export const calls = [];
    export const lookup = new Map(Array.from({ length: 300 }, (_, i) => [String(i), {}]));
    const store = { getState: () => ({ nodeLookup: lookup }) };
    const useStoreApi = () => store;
    const useUpdateNodeInternals = () => (ids) => calls.push(ids);
    export const frames = [];
    const requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  `);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
  const { useBatchedNodeInternals, frames, calls, lookup } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  for (let i = 0; i < 300; i++) {
    const update = useBatchedNodeInternals();
    update(String(i));
    update(String(i));
  }
  lookup.delete("17");
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 299);
  assert.equal(calls[0].includes("17"), false);
});
