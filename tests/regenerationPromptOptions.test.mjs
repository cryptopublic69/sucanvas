import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/video/regenerationPromptOptions.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { deduplicateRegenerationPromptOptions: dedupe } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const option = (key, overrides = {}) => ({
  key, label: key, prompt: "scene\naction", information: "note", referenceSelection: null,
  promptNodeId: "node", promptNodeTitle: "prompt", promptNodeIdSource: "captured",
  promptVersionId: key, promptVersionLabel: key, ...overrides,
});

test("duplicate snapshot merges into named version while preserving selected snapshot payload", () => {
  const snapshot = option("snapshot", { prompt: " scene\r\naction\n", information: " note " });
  const result = dedupe([snapshot, option("v2")], "snapshot");
  assert.equal(result.options.length, 1);
  assert.equal(result.selectedKey, "v2");
  assert.equal(result.options[0].label, "v2（当前视频）");
  assert.equal(result.options[0].prompt, snapshot.prompt);
});

test("identical versions collapse and selection remains valid", () => {
  const result = dedupe([option("v3"), option("v2"), option("v1", { prompt: "different" })], "v2");
  assert.deepEqual(result.options.map((entry) => entry.key), ["v3", "v1"]);
  assert.equal(result.selectedKey, "v3");
  assert.equal(result.options[0].promptVersionId, "v2");
});

test("different prompt text remains available", () => {
  const options = [option("snapshot", { prompt: "historical" }), option("v3"),
    option("v2", { information: "different note" }),
    option("v1", { referenceSelection: { sceneKey: "s1", assets: [] } })];
  const result = dedupe(options, "snapshot");
  assert.equal(result.options.length, 2);
  assert.equal(result.selectedKey, "snapshot");
});

test("plain text and historical snapshot merge despite whitespace, notes and reference differences", () => {
  const snapshot = option("snapshot", {
    label: "新文本（历史快照）", prompt: "scene\r\n  action",
    information: "historical note", referenceSelection: null,
  });
  const current = option("text:node", {
    label: "新文本", prompt: "scene action", information: "edited note",
    referenceSelection: { sceneKey: "s1", assets: [] },
  });
  const result = dedupe([snapshot, current], "snapshot");
  assert.equal(result.options.length, 1);
  assert.equal(result.selectedKey, "text:node");
  assert.equal(result.options[0].label, "新文本（当前视频）");
  assert.equal(result.options[0].prompt, snapshot.prompt);
  assert.equal(result.options[0].information, snapshot.information);
  assert.equal(result.options[0].referenceSelection, null);
});
