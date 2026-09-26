import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/projects/projectSummaries.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { summarizeProject } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("project summaries preserve covers and workflow usage without retaining prompt payloads", () => {
  const project = { canvas: { id: "canvas" }, nodes: [{ id: "node", content: {
    assetPath: "cover.png", workflowModuleId: "module", generationMode: "reference-to-video",
    generationSnapshot: { workflowModuleId: "previous", prompt: "large prompt" }, versions: [{ text: "secret" }],
  } }], edges: [{ id: "edge", metadata: { large: "payload" } }] };
  const summary = summarizeProject(project);
  assert.deepEqual(summary.nodes[0].content, { assetPath: "cover.png", workflowModuleId: "module",
    generationMode: "reference-to-video", generationSnapshot: { workflowModuleId: "previous" } });
  assert.deepEqual(summary.edges[0].metadata, {});
  assert.equal(project.nodes[0].content.generationSnapshot.prompt, "large prompt");
  assert.equal(summarizeProject(project), summary);
  assert.equal(summarizeProject(summary), summary);
});

test("legacy snapshot without a module ID still counts toward the default workflow", () => {
  const summary = summarizeProject({ canvas: {}, edges: [], nodes: [{ content: { generationSnapshot: { prompt: "old" } } }] });
  assert.deepEqual(summary.nodes[0].content.generationSnapshot, {});
});
