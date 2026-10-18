import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
};
const { MATERIAL_NODE_LAYOUT_VERSION, mediaNodeHeightForAspectRatio, videoAssetLayout } = await load("../src/media/videoAssetLayout.ts");
const { rememberUploadedVideoMetadata, takeUploadedVideoMetadata } = await load("../src/media/uploadedVideoMetadata.ts");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const canvasNode = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const bridge = await readFile(new URL("../src/web/bridge.ts", import.meta.url), "utf8");

test("portrait upload gets its final size before the node is placed", () => {
  const layout = videoAssetLayout(420, 1080, 1920);
  assert.equal(layout.width, 420);
  assert.equal(layout.height, mediaNodeHeightForAspectRatio(420, 1080 / 1920));
  assert.ok(Math.abs(layout.height - 856.6666666666666) < 1e-9);
  assert.deepEqual(layout.content, {
    aspectRatio: 0.5625,
    naturalWidth: 1080,
    naturalHeight: 1920,
    materialNodeLayoutVersion: MATERIAL_NODE_LAYOUT_VERSION,
  });
});

test("landscape upload keeps the node width and fits the height", () => {
  const layout = videoAssetLayout(420, 1920, 1080);
  assert.equal(layout.width, 420);
  assert.ok(Math.abs(layout.height - (420 / (16 / 9) + 110)) < 1e-9);
  assert.equal(layout.content.aspectRatio, 16 / 9);
});

test("unreadable metadata falls back to the current on-load correction", () => {
  for (const [w, h] of [[0, 1080], [1920, 0], [Number.NaN, 1080], [1920, Number.POSITIVE_INFINITY], [-1, 5]]) {
    assert.equal(videoAssetLayout(420, w, h), null);
  }
});

test("uploaded metadata is handed over once per upload path", () => {
  rememberUploadedVideoMetadata("sucanvas://uploads/a/clip.mp4", { width: 1080, height: 1920, duration: 40 });
  assert.deepEqual(takeUploadedVideoMetadata("sucanvas://uploads/a/clip.mp4"), { width: 1080, height: 1920, duration: 40 });
  assert.equal(takeUploadedVideoMetadata("sucanvas://uploads/a/clip.mp4"), undefined);
  assert.equal(takeUploadedVideoMetadata("sucanvas://uploads/b/other.mp4"), undefined);
});

test("importMedia sizes videos from local metadata and the node reuses the same formula", () => {
  const importMedia = app.slice(app.indexOf("const importMedia = useCallback("), app.indexOf("const dropEventHandlers = useRef("));
  const sizing = importMedia.indexOf("takeUploadedVideoMetadata(path)");
  assert.ok(sizing > 0, "importMedia reads the uploaded video metadata");
  assert.ok(importMedia.indexOf("videoAssetLayout(", sizing) > sizing);
  assert.ok(sizing < importMedia.indexOf("reserveNodePlacement("), "the final size is written before placement is reserved");
  assert.match(bridge, /rememberUploadedVideoMetadata\(/);
  assert.doesNotMatch(canvasNode, /function mediaNodeHeightForAspectRatio\(/);
  assert.match(canvasNode, /from "\.\/media\/videoAssetLayout"/);
});
