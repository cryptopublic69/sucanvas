import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// CANVAS-036: a generated image gets its node shape from the final image's real size when the result
// arrives, not from the <img> onLoad of the full node. Below zoom 0.35 the canvas only renders overview
// cards (CanvasNodePresentation), so the onLoad correction never ran and a package whose output size
// isn't known up front (image edit: the size follows the input) stayed in its square placeholder.
const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
};
const layoutModule = () => load("../src/media/generatedImageLayout.ts");
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ""} ${actual} != ${expected}`);
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  return text.slice(from, text.indexOf(end, from + start.length));
};

// The placeholder of an image-edit run is square (its size is unknown until the result); the result is portrait.
const placeholderWidth = 420;
const result = (extra = {}) => ({ imageUrl: "/api/comfy/view?filename=out_00001_.png&type=output", filename: "out_00001_.png", ...extra });
const measured = (width, height) => {
  const calls = [];
  const measure = async (url) => { calls.push(url); return { width, height }; };
  return { calls, measure };
};

test("the node height follows the real image: width / ratio + the 38 px footer, kept within 180..2400", async () => {
  const { GENERATED_IMAGE_CHROME_HEIGHT, GENERATED_IMAGE_PREVIEW_LAYOUT_VERSION, generatedImageLayout } = await layoutModule();
  assert.equal(GENERATED_IMAGE_CHROME_HEIGHT, 38);
  assert.equal(GENERATED_IMAGE_PREVIEW_LAYOUT_VERSION, 2);
  const portrait = generatedImageLayout(1088, 1920, placeholderWidth);
  assert.equal(portrait.width, placeholderWidth);
  close(portrait.height, placeholderWidth / (1088 / 1920) + 38);
  assert.deepEqual(portrait.content, { aspectRatio: 1088 / 1920, naturalWidth: 1088, naturalHeight: 1920, generatedImagePreviewLayoutVersion: 2 });
  close(generatedImageLayout(1920, 1088, placeholderWidth).height, placeholderWidth / (1920 / 1088) + 38);
  close(generatedImageLayout(1024, 1024, placeholderWidth).height, placeholderWidth + 38);
  assert.equal(generatedImageLayout(100, 4000, placeholderWidth).height, 2400);
  assert.equal(generatedImageLayout(4000, 100, placeholderWidth).height, 180);
  for (const [w, h] of [[0, 10], [10, 0], [Number.NaN, 10], [10, Number.POSITIVE_INFINITY], [-5, 10]]) {
    assert.equal(generatedImageLayout(w, h, placeholderWidth), null, `${w}x${h}`);
  }
});

test("an image-edit result in a square placeholder gets its real portrait shape when the result arrives", async () => {
  const { withGeneratedImageLayout } = await layoutModule();
  const { calls, measure } = measured(1088, 1920);
  const done = await withGeneratedImageLayout(result(), placeholderWidth, measure);
  assert.deepEqual(calls, [result().imageUrl], "the final image itself is measured, once");
  assert.equal(done.width, placeholderWidth);
  close(done.height, placeholderWidth / (1088 / 1920) + 38);
  assert.equal(done.content.filename, "out_00001_.png", "the result content is kept");
  close(done.content.aspectRatio, 1088 / 1920);
  assert.equal(done.content.naturalWidth, 1088);
  assert.equal(done.content.naturalHeight, 1920);
  assert.equal(done.content.generatedImagePreviewLayoutVersion, 2, "the on-load and layout-upgrade effects leave it alone");
});

test("a text-to-image result whose placeholder was already right keeps its shape", async () => {
  const { withGeneratedImageLayout } = await layoutModule();
  // Krea2-style 720x1280: the placeholder was sized from the requested width/height (App createImageGenerationPlaceholder).
  const placeholderHeight = Math.min(1200, Math.max(180, Math.round(placeholderWidth * 1280 / 720) + 38));
  const done = await withGeneratedImageLayout(result(), placeholderWidth, measured(720, 1280).measure);
  assert.equal(done.width, placeholderWidth);
  assert.ok(Math.abs(done.height - placeholderHeight) < 1, `${done.height} vs placeholder ${placeholderHeight}`);
  close(done.content.aspectRatio, 720 / 1280);
});

test("a node that already has a ratio (hand-resized, uploaded, re-opened) is never measured or reshaped", async () => {
  const { withGeneratedImageLayout } = await layoutModule();
  const { calls, measure } = measured(1088, 1920);
  const content = result({ aspectRatio: 1.5, naturalWidth: 1536, naturalHeight: 1024 });
  const done = await withGeneratedImageLayout(content, placeholderWidth, measure);
  assert.deepEqual(calls, []);
  assert.deepEqual(done, { content });
});

test("no image, or the size can't be read: the content is unchanged and the on-load correction stays the fallback", async () => {
  const { withGeneratedImageLayout } = await layoutModule();
  const video = { videoUrl: "/api/comfy/view?filename=v.mp4" };
  const { calls, measure } = measured(1088, 1920);
  assert.deepEqual(await withGeneratedImageLayout(video, placeholderWidth, measure), { content: video });
  assert.deepEqual(calls, []);
  const failing = async () => { throw new Error("无法读取图片尺寸"); };
  assert.deepEqual(await withGeneratedImageLayout(result(), placeholderWidth, failing), { content: result() });
  const empty = async () => ({ width: 0, height: 0 });
  assert.deepEqual(await withGeneratedImageLayout(result(), placeholderWidth, empty), { content: result() });
});

test("every image result is shaped before it is written: placeholder completion and extra outputs", async () => {
  const app = await source("src/App.tsx");
  const complete = between(app, "const completeGenerationPlaceholder = useCallback(", "const removeGenerationPlaceholder = useCallback(");
  const shaped = complete.indexOf("withGeneratedImageLayout(");
  assert.ok(shaped > 0, "completeGenerationPlaceholder shapes image results");
  assert.ok(shaped < complete.indexOf('invoke<NodeRecord>("update_node"'), "before the node is written");
  assert.ok(/width: shaped\.width/.test(complete), "the node size goes into the same update");
  assert.ok(/style: \{ \.\.\.node\.style, width: record\.width, height: record\.height \}/.test(complete), "the flow node takes the new size");
  // Extra outputs of a run (generate, upscale, recovery) are created at their real shape too.
  const extras = [...app.matchAll(/kind: "generated-image",\s*\n\s*title[^\n]*\n\s*content: ([^,\n]+),/g)].map((m) => m[1].trim())
    .filter((content) => content !== "placeholderContent");
  assert.ok(extras.length >= 3, `found ${extras.length} generated-image create_node calls`);
  for (const content of extras) assert.ok(/^shaped\w*\.content$/.test(content), `create_node content ${content}`);
});

test("the on-load fallback and the layout module share one height rule; no workflow names", async () => {
  const canvasNode = await source("src/CanvasNode.tsx");
  assert.ok(/from "\.\/media\/generatedImageLayout"/.test(canvasNode), "CanvasNode imports the layout module");
  assert.ok(!/const GENERATED_IMAGE_CHROME_HEIGHT = /.test(canvasNode), "CanvasNode has no own footer height");
  assert.ok(!/const GENERATED_IMAGE_PREVIEW_LAYOUT_VERSION = /.test(canvasNode), "CanvasNode has no own layout version");
  const fallback = between(canvasNode, "const applyNaturalMediaRatio = ", "const queueConstrainedVideoResize = ");
  assert.ok(/isGeneratedImage\s*\?\s*generatedImageNodeHeight\(fittedWidth, aspectRatio\)/.test(fallback), "the on-load fallback uses generatedImageNodeHeight");
  const layout = await source("src/media/generatedImageLayout.ts");
  assert.ok(!/qwen|krea|moss|adapterId|workflowModuleId/i.test(layout), "the layout module names no workflow");
});
