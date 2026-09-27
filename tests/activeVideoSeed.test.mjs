import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/video/activeVideoSeed.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { findDuplicateVideoRequest: duplicate } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const snapshot = { prompt: "test", workflowModuleId: "h3", workflowModuleRevision: "1", primaryVideoSteps: 20,
  styleLoras: [{ name: "style", strength: 0.5 }], imagePaths: ["a.png", "b.png"] };
const task = { generationPlaceholder: true, placeholderClientId: "active", seed: "123",
  sourceGeneratorId: "generator", generationSnapshot: snapshot };
const clients = new Set(["active"]);
const check = (content = task, next = snapshot, seed = "123") => duplicate([content], clients, seed, next, "generator");

test("only the same seed and generation parameters are duplicates", () => {
  assert.equal(check(), "active");
  assert.equal(check(task, snapshot, "000123"), "active");
  assert.equal(check(task, snapshot, "456"), null);
  for (const patch of [{ primaryVideoSteps: 21 }, { prompt: "changed" }, { durationSeconds: 8 },
    { diffusionModelName: "other" }, { refImageSize: "match" }, { primaryContrast: 0.9 },
    { workflowModuleRevision: "2" }, { imagePaths: ["b.png", "a.png"] },
    { styleLoras: [{ name: "style", strength: 0.6 }] }]) {
    assert.equal(check(task, { ...snapshot, ...patch }), null, JSON.stringify(patch));
  }
});

test("completed videos use parameter snapshots, never seed alone", () => {
  const completed = { ...task, generationPlaceholder: false, videoUrl: "video.mp4" };
  assert.equal(check(completed), "completed");
  assert.equal(check(completed, { ...snapshot, primaryVideoSteps: 21 }), null);
  assert.equal(check({ ...completed, generationSnapshot: undefined }), null);
});

test("inactive placeholders, other generators and secondary samples do not block", () => {
  assert.equal(check({ ...task, placeholderClientId: "finished" }), null);
  assert.equal(check({ ...task, sourceGeneratorId: "other" }), null);
  assert.equal(check({ ...task, sourcePreviewId: "secondary" }), null);
});

test("metadata and object property order do not affect matching", () => {
  assert.equal(check(task, { ...snapshot, promptNodeTitle: "renamed", promptVersionId: "new",
    styleLoras: [{ strength: 0.5, name: "style" }] }), "active");
});

test("64-bit seeds remain distinct", () => {
  const large = { ...task, seed: "18446744073709551615" };
  assert.equal(check(large, snapshot, "18446744073709551615"), "active");
  assert.equal(check(large, snapshot, "18446744073709551614"), null);
});
