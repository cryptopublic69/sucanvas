import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(await readFile(new URL("../src/video/videoUpscale.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { videoUpscaleModule, videoUpscaleDefaults, videoUpscaleParameterError, videoUpscaleGenerationSnapshot, videoUpscaleFromValue } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const uiSchema = JSON.parse(await readFile(new URL("../workflows/video-upscale/topaz-starlight-2.6/ui-schema.json", import.meta.url), "utf8"));
const module = { id: "topaz", capability: "video-upscale", deletedAt: null, uiSchema };

test("ordinary execution reads the exported workflow's defaults and dialog edits are isolated", () => {
  const defaults = videoUpscaleDefaults(module);
  assert.deepEqual(defaults, { softness: 3, upscaleFactor: 1 });
  defaults.softness = 1;
  assert.equal(videoUpscaleDefaults(module).softness, 3);
});

test("module selection respects enabled modules and does not resurrect deleted defaults", () => {
  const other = { ...module, id: "other" };
  assert.equal(videoUpscaleModule([module, other], { "video-upscale": "other" }, ["topaz", "other"]), other);
  assert.equal(videoUpscaleModule([module, other], { "video-upscale": "other" }, ["topaz"]), module);
  assert.equal(videoUpscaleModule([{ ...module, deletedAt: "2026-10-07" }], { "video-upscale": "topaz" }, ["topaz"]), undefined);
});

test("integer ranges from the module reject unsupported parameter values", () => {
  for (const values of [{ softness: 0, upscaleFactor: 1 }, { softness: 2.5, upscaleFactor: 1 }, { softness: 3, upscaleFactor: 5 }, { softness: 3, upscaleFactor: 1.5 }]) {
    assert.ok(videoUpscaleParameterError(module, values));
  }
  assert.equal(videoUpscaleParameterError(module, { softness: 1, upscaleFactor: 4 }), null);
});

test("processing can be recovered without prompt or Seed and keeps arbitrary source aspect ratios", () => {
  const processing = { workflowModuleId: "topaz", workflowModuleName: "Topaz", workflowModuleRevision: "2.6", outputNodeId: "output", parameters: { softness: 3, upscaleFactor: 1 }, parameterLabels: { softness: "Softness" }, sourceVideoUrl: "http://server/video.mp4", aspectRatio: 2.39 };
  const snapshot = videoUpscaleGenerationSnapshot(null, processing);
  assert.equal(snapshot.prompt, "");
  assert.deepEqual(videoUpscaleFromValue(snapshot.videoUpscale), processing);
  const inherited = videoUpscaleGenerationSnapshot({ ...snapshot, prompt: "original", workflowModuleId: "h3", workflowModuleRevision: "V3" }, processing);
  assert.equal(inherited.workflowModuleId, "h3");
  assert.equal(inherited.prompt, "original");
  assert.equal(inherited.videoUpscale.workflowModuleId, "topaz");
});

test("corrupted processing snapshots do not enter recovery", () => {
  assert.equal(videoUpscaleFromValue({ parameters: { softness: Number.NaN } }), undefined);
});
