import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/outputFiles.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { resolveComfyOutputPath, generatedVideoDeletionPaths } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const root = "E:\\ComfyUI\\output";
const video = { filename: "scene.mp4", subfolder: "H3/day1", videoUrl: "/api/comfy/view?filename=scene.mp4" };
const legacy = { ...video, videoUrl: "/api/resource?resource=old-video", assetPath: "sucanvas://assets/generated-123.mp4" };

test("Web and desktop videos resolve the same ComfyUI original", () => {
  const expected = root + "\\H3\\day1\\scene.mp4";
  assert.equal(resolveComfyOutputPath(root, video, true), expected);
  assert.equal(resolveComfyOutputPath(root, video), expected);
  assert.equal(resolveComfyOutputPath(root, legacy, true), expected);
  assert.deepEqual(generatedVideoDeletionPaths(root, video, true), [expected]);
});

test("missing output mapping never falls back to deleting only a legacy copy", () => {
  assert.equal(resolveComfyOutputPath("", legacy, true), null);
  assert.deepEqual(generatedVideoDeletionPaths("", legacy, true), []);
  assert.deepEqual(generatedVideoDeletionPaths(root, { assetPath: legacy.assetPath }, true), []);
});

test("explicit permanent deletion targets only the ComfyUI original", () => {
  assert.deepEqual(generatedVideoDeletionPaths(root, legacy, true), [root + "\\H3\\day1\\scene.mp4"]);
  assert.deepEqual(generatedVideoDeletionPaths(root, legacy), [root + "\\H3\\day1\\scene.mp4"]);
  assert.deepEqual(legacy, { ...video, videoUrl: "/api/resource?resource=old-video", assetPath: "sucanvas://assets/generated-123.mp4" });
});

test("unrelated assets are not treated as old generated video copies", () => {
  for (const assetPath of ["sucanvas://assets/asset-imported.mp4", "sucanvas://uploads/video.mp4", "sucanvas://assets/generated-a.png", "C:\\unrelated.mp4"]) {
    assert.deepEqual(generatedVideoDeletionPaths(root, { ...video, assetPath }, true), [root + "\\H3\\day1\\scene.mp4"]);
  }
  assert.equal(resolveComfyOutputPath(root, { filename: "image.png", assetPath: "sucanvas://assets/generated-image.png" }, true), root + "\\image.png");
});
