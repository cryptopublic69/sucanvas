import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/generationQueuePositions.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { generationQueuePositions: positions } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const record = (id, second, kind = "generated-video") => ({
  id, kind, createdAt: `2026-09-27T00:00:0${second}Z`,
  content: { generationPlaceholder: true, status: "running" },
});

test("images and videos share submission order independent of canvas array order", () => {
  const first = record("a", 1), second = record("b", 2, "generated-image");
  assert.deepEqual([...positions([first])], [["a", 1]]);
  assert.deepEqual([...positions([second, first])], [["a", 1], ["b", 2]]);
});

test("completion, cancellation, failure and deletion close gaps; new tasks join the end", () => {
  const a = record("a", 1), b = record("b", 2), c = record("c", 3);
  a.content.generationPlaceholder = false;
  assert.deepEqual([...positions([a, b, c])], [["b", 1], ["c", 2]]);
  b.content.status = "cancelled";
  assert.deepEqual([...positions([a, b, c])], [["c", 1]]);
  b.content.status = "invalid";
  assert.deepEqual([...positions([a, b, c, record("d", 4)])], [["c", 1], ["d", 2]]);
  assert.deepEqual([...positions([record("d", 4)])], [["d", 1]]);
});
