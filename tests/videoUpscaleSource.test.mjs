import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/video/videoUpscaleSource.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { comfyOutputFromContent, videoUpscaleSourceFromRecord, videoUpscaleSourceUnavailableReason } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const generated = {
  kind: "generated-video",
  content: { filename: "scene.mp4", subfolder: "H3/day1", fileType: "output", videoUrl: "/api/comfy/view?filename=scene.mp4&subfolder=H3%2Fday1&type=output" },
};

test("generated videos keep using their ComfyUI output", () => {
  const expected = { filename: "scene.mp4", subfolder: "H3/day1", fileType: "output", url: generated.content.videoUrl };
  assert.deepEqual(videoUpscaleSourceFromRecord(generated), expected);
  assert.deepEqual(comfyOutputFromContent(generated.content), expected);
  assert.equal(videoUpscaleSourceUnavailableReason(generated), "");
});

test("generated videos without output fields are not upscalable", () => {
  for (const content of [{ videoUrl: "/api/comfy/view?filename=scene.mp4" }, { filename: "scene.mp4" }, {}]) {
    const record = { kind: "generated-video", content };
    assert.equal(videoUpscaleSourceFromRecord(record), null);
    assert.equal(videoUpscaleSourceUnavailableReason(record), "当前预览缺少远程视频文件信息，无法执行超分");
  }
});

test("uploaded videos resolve to the sucanvas-imports input file", () => {
  const assetPath = "sucanvas-input://sucanvas-imports/asset-885770ff-0d24-4d4a-8e56-68aaa4eec077.mp4";
  const record = { kind: "video", content: { assetPath, mimeType: "video/mp4", originalName: "clip.mp4" } };
  assert.deepEqual(videoUpscaleSourceFromRecord(record), {
    filename: "asset-885770ff-0d24-4d4a-8e56-68aaa4eec077.mp4",
    subfolder: "sucanvas-imports",
    fileType: "input",
    url: assetPath,
  });
  assert.equal(videoUpscaleSourceUnavailableReason(record), "");
});

test("uploaded videos stored under the ComfyUI output root use type output", () => {
  const assetPath = "sucanvas-output://sucanvas-migrated/2026/clip.WEBM";
  assert.deepEqual(videoUpscaleSourceFromRecord({ kind: "video", content: { assetPath } }), {
    filename: "clip.WEBM", subfolder: "sucanvas-migrated/2026", fileType: "output", url: assetPath,
  });
});

test("uploaded videos that cannot be located return null with a reason", () => {
  const cases = [
    [{}, "缺少文件路径"],
    [{ assetPath: "" }, "缺少文件路径"],
    [{ assetPath: "sucanvas://assets/asset-legacy.mp4" }, "不在 ComfyUI 输入或输出目录中"],
    [{ assetPath: "C:\\Videos\\clip.mp4" }, "不在 ComfyUI 输入或输出目录中"],
    [{ assetPath: "https://example.com/clip.mp4" }, "不在 ComfyUI 输入或输出目录中"],
    [{ assetPath: "sucanvas-input://sucanvas-imports/../escape.mp4" }, "不在 ComfyUI 输入或输出目录中"],
    [{ assetPath: "sucanvas-input://sucanvas-imports//clip.mp4" }, "不在 ComfyUI 输入或输出目录中"],
    [{ assetPath: "sucanvas-input://sucanvas-imports/asset-1.wmv" }, "格式不支持超分"],
    [{ assetPath: "sucanvas-input://sucanvas-imports/asset-1" }, "格式不支持超分"],
  ];
  for (const [content, reason] of cases) {
    const record = { kind: "video", content };
    assert.equal(videoUpscaleSourceFromRecord(record), null, JSON.stringify(content));
    assert.match(videoUpscaleSourceUnavailableReason(record), new RegExp(reason), JSON.stringify(content));
  }
});

test("other node kinds are never upscale sources", () => {
  for (const kind of ["image", "audio", "generated-image", "text"]) {
    const record = { kind, content: { ...generated.content, assetPath: "sucanvas-input://sucanvas-imports/a.mp4" } };
    assert.equal(videoUpscaleSourceFromRecord(record), null);
    assert.notEqual(videoUpscaleSourceUnavailableReason(record), "");
  }
});
