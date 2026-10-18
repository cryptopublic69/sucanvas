import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
};
const {
  GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH,
  GENERATED_VIDEO_PREVIEW_WIDTH,
  MATERIAL_NODE_LAYOUT_VERSION,
  MEDIA_NODE_CHROME_HEIGHT,
  generatedVideoPreviewWidthForRatio,
  videoAssetLayout,
} = await load("../src/media/videoAssetLayout.ts");
const { rememberUploadedVideoMetadata, takeUploadedVideoMetadata } = await load("../src/media/uploadedVideoMetadata.ts");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const canvasNode = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const bridge = await readFile(new URL("../src/web/bridge.ts", import.meta.url), "utf8");
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("uploaded videos use the generated-video preview widths, not their pixel size", () => {
  assert.equal(GENERATED_VIDEO_PREVIEW_WIDTH, 420);
  assert.equal(GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH, 300);
  assert.equal(MEDIA_NODE_CHROME_HEIGHT, 110);
  const cases = [
    ["9:16", 1080, 1920, 300, 300 / (9 / 16) + 110],
    ["16:9", 1920, 1080, 420, 420 / (16 / 9) + 110],
    ["1:1", 1080, 1080, 420, 420 + 110],
  ];
  for (const [label, naturalWidth, naturalHeight, width, height] of cases) {
    const layout = videoAssetLayout(naturalWidth, naturalHeight);
    assert.equal(layout.width, width, label);
    assert.equal(layout.width, generatedVideoPreviewWidthForRatio(naturalWidth / naturalHeight), label);
    close(layout.height, height);
    assert.deepEqual(layout.content, {
      aspectRatio: naturalWidth / naturalHeight,
      naturalWidth,
      naturalHeight,
      materialNodeLayoutVersion: MATERIAL_NODE_LAYOUT_VERSION,
    }, label);
  }
});

test("the size depends only on the ratio", () => {
  assert.deepEqual(videoAssetLayout(480, 854).width, videoAssetLayout(1080, 1920).width);
  close(videoAssetLayout(3840, 2160).height, videoAssetLayout(854, 480.375).height);
});

test("unreadable metadata falls back to the current on-load correction", () => {
  for (const [w, h] of [[0, 1080], [1920, 0], [Number.NaN, 1080], [1920, Number.POSITIVE_INFINITY], [-1, 5]]) {
    assert.equal(videoAssetLayout(w, h), null);
  }
});

test("uploaded metadata is handed over once per upload path", () => {
  rememberUploadedVideoMetadata("sucanvas://uploads/a/clip.mp4", { width: 1080, height: 1920, duration: 40 });
  assert.deepEqual(takeUploadedVideoMetadata("sucanvas://uploads/a/clip.mp4"), { width: 1080, height: 1920, duration: 40 });
  assert.equal(takeUploadedVideoMetadata("sucanvas://uploads/a/clip.mp4"), undefined);
  assert.equal(takeUploadedVideoMetadata("sucanvas://uploads/b/other.mp4"), undefined);
});

test("importMedia sizes videos from local metadata before placement", () => {
  const importMedia = app.slice(app.indexOf("const importMedia = useCallback("), app.indexOf("const dropEventHandlers = useRef("));
  const sizing = importMedia.indexOf("takeUploadedVideoMetadata(path)");
  assert.ok(sizing > 0, "importMedia reads the uploaded video metadata");
  assert.match(importMedia.slice(sizing), /videoAssetLayout\(metadata\.width, metadata\.height\)/);
  assert.ok(sizing < importMedia.indexOf("reserveNodePlacement("), "the final size is written before placement is reserved");
  assert.match(bridge, /rememberUploadedVideoMetadata\(/);
});

test("generated and uploaded videos share one width rule and the on-load fallback uses it too", () => {
  for (const local of [
    /function generatedVideoPreviewWidthForRatio\(/,
    /const GENERATED_VIDEO_PREVIEW_WIDTH = /,
    /const GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH = /,
    /function mediaNodeHeightForAspectRatio\(/,
  ]) assert.doesNotMatch(canvasNode, local);
  assert.match(canvasNode, /from "\.\/media\/videoAssetLayout"/);
  const fallback = canvasNode.slice(canvasNode.indexOf("const applyNaturalMediaRatio = "), canvasNode.indexOf("const queueConstrainedVideoResize = "));
  assert.match(fallback, /if \(savedAspectRatio \|\|/, "nodes that already saved a ratio are left alone");
  assert.match(fallback, /isVideoAsset \? videoAssetLayout\(naturalWidth, naturalHeight\)/);
});
