import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-031a: a control can be shown by how many items are connected to an input port
// (`visibleWhen: {"mediaAtLeast": {"port", "count"}}`). The node counts what it would send, with
// the same port mapping as the run request. Without counts a condition that mentions mediaAtLeast
// anywhere is treated as "shown", so a `not` around it cannot hide a control by accident.
const pkg = await loadWorkflowModule("workflowPackage");
const controlsModule = await loadWorkflowModule("WorkflowControls");

const atLeast = (count, port = "images") => ({ mediaAtLeast: { port, count } });
const off = { truthy: { control: "flag" } };
const controls = [{ id: "flag", type: "toggle", default: false }];

test("mediaAtLeast compares the counted items of its port", () => {
  for (const [counts, expected] of [[{ images: 0 }, false], [{ images: 1 }, false], [{ images: 2 }, true], [{ images: 8 }, true], [{}, false], [{ other: 5 }, false]]) {
    assert.equal(pkg.conditionHolds(atLeast(2), {}, controls, counts), expected, JSON.stringify(counts));
  }
  assert.equal(pkg.conditionHolds({ not: atLeast(2) }, {}, controls, { images: 1 }), true);
  assert.equal(pkg.conditionHolds({ not: atLeast(2) }, {}, controls, { images: 2 }), false);
  assert.equal(pkg.conditionHolds({ all: [atLeast(2), { truthy: { control: "flag" } }] }, { flag: true }, controls, { images: 3 }), true);
  assert.equal(pkg.conditionHolds({ all: [atLeast(2), { truthy: { control: "flag" } }] }, { flag: false }, controls, { images: 3 }), false);
  assert.equal(pkg.conditionHolds({ any: [atLeast(4), { truthy: { control: "flag" } }] }, { flag: false }, controls, { images: 4 }), true);
});

test("without counts, a condition mentioning mediaAtLeast anywhere is shown, however it is nested", () => {
  for (const condition of [
    atLeast(2),
    { not: atLeast(2) },
    { not: { not: atLeast(1) } },
    { all: [off, atLeast(2)] },
    { all: [off, { not: atLeast(2) }] },
    { any: [{ not: atLeast(2) }] },
    { any: [{ all: [off, { not: atLeast(3) }] }] },
    { not: { any: [off, { all: [atLeast(1), off] }] } },
  ]) {
    assert.equal(pkg.conditionHolds(condition, { flag: false }, controls), true, JSON.stringify(condition));
    assert.equal(pkg.conditionHolds(condition, { flag: false }, controls, undefined), true, JSON.stringify(condition));
  }
  // Conditions that only read control values are evaluated as before.
  assert.equal(pkg.conditionHolds(off, { flag: false }, controls), false);
  assert.equal(pkg.conditionHolds({ not: off }, { flag: false }, controls), true);
  assert.equal(pkg.conditionHolds({ all: [{ not: off }, off] }, { flag: false }, controls), false);
});

test("counts follow the run request's port mapping (same function, checked against buildOperationRequest)", () => {
  const operation = {
    inputs: [
      { id: "prompt", type: "text", min: 1, max: 1 },
      { id: "images", type: "image", min: 1, max: 8 },
      { id: "second", type: "image", min: 0, max: 8 },
      { id: "clip", type: "video", min: 0, max: 1 },
    ],
  };
  const image = (n) => Array.from({ length: n }, (_, i) => ({ path: `${i}.png` }));
  for (const connected of [
    {},
    { image: image(2) },
    { image: image(8), text: [{ text: "  fox " }] },
    { text: [{ text: "   " }], image: image(1), video: [{ path: "a.mp4" }] },
    { image: [] },
  ]) {
    const request = pkg.buildOperationRequest("generate", operation, {}, connected, { seedMode: "random", seed: "" });
    const fromRequest = Object.fromEntries(Object.entries(request.inputs).map(([port, items]) => [port, items.length]));
    const counts = pkg.connectedMediaCounts(operation, connected);
    assert.deepEqual(Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)), fromRequest, JSON.stringify(connected));
    assert.equal(counts.second ?? 0, 0, "only the first port of a type takes its connections");
  }
});

test("visibleControls and promptAnchorControl take the counts", () => {
  const operation = {
    controls: [
      { id: "always", type: "toggle" },
      { id: "twoImages", type: "toggle", visibleWhen: atLeast(2) },
      { id: "negativePrompt", type: "textarea", visibleWhen: atLeast(1) },
    ],
  };
  const ids = (counts) => pkg.visibleControls(operation, {}, counts).map((control) => control.id);
  assert.deepEqual(ids({ images: 0 }), ["always"]);
  assert.deepEqual(ids({ images: 1 }), ["always", "negativePrompt"]);
  assert.deepEqual(ids({ images: 2 }), ["always", "twoImages", "negativePrompt"]);
  assert.deepEqual(ids(undefined), ["always", "twoImages", "negativePrompt"]);
  assert.equal(pkg.promptAnchorControl(operation, {}, { images: 0 }), undefined);
  assert.equal(pkg.promptAnchorControl(operation, {}, { images: 1 })?.id, "negativePrompt");
});

const qwen = async () => (await readJson("workflow-packages/image-v2/ba6a4b31/adapter.json")).operations.generate;
const scaleIds = (operation, values, counts) => pkg.visibleControls(operation, values, counts)
  .map((control) => control.id).filter((id) => /^(scale|maxSize)\d$/.test(id));

test("the 8-image edit package shows the scale settings of connected images only", async () => {
  const operation = await qwen();
  assert.deepEqual(scaleIds(operation, {}, { images: 0 }), []);
  assert.deepEqual(scaleIds(operation, {}, { images: 2 }), ["scale1", "scale2"]);
  assert.deepEqual(scaleIds(operation, { scale2: true }, { images: 2 }), ["scale1", "scale2", "maxSize2"]);
  assert.deepEqual(scaleIds(operation, { scale5: true }, { images: 2 }), ["scale1", "scale2"]);
  assert.deepEqual(scaleIds(operation, {}, { images: 8 }), Array.from({ length: 8 }, (_, i) => `scale${i + 1}`));
  const sizeIds = (values) => pkg.visibleControls(operation, values, { images: 1 }).map((c) => c.id).filter((id) => id === "width" || id === "height");
  assert.deepEqual(sizeIds({}), []);
  assert.deepEqual(sizeIds({ customSize: true }), ["width", "height"]);
});

test("WorkflowControls draws only the counted groups", async () => {
  const operation = await qwen();
  const render = (mediaCounts, values = {}) => renderToStaticMarkup(createElement(controlsModule.WorkflowControls, {
    operation, values, mediaCounts, choicesFor: () => ({ status: "ready", values: ["Qwen2.1\\qwen_image_2.1_int8_convrot.safetensors"] }), onChange: () => {},
  }));
  const labels = (markup) => [...new Set([...markup.matchAll(/图 (\d) 缩放/g)].map((match) => Number(match[1])))];
  assert.deepEqual(labels(render({ images: 0, prompt: 1 })), []);
  assert.deepEqual(labels(render({ images: 2, prompt: 1 })), [1, 2]);
  assert.deepEqual(labels(render({ images: 8, prompt: 1 })), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotMatch(render({ images: 2 }), /最长边/);
  assert.match(render({ images: 2 }, { scale2: true }), /最长边/);
});

test("the node passes its counts to the controls and to the prompt anchor", async () => {
  const source = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
  assert.match(source, /const imageMediaCounts = imageOperation\s*\?\s*connectedMediaCounts\(imageOperation,/);
  assert.match(source, /promptAnchorControl\(imageOperation, imageControlValues, imageMediaCounts\)/);
  const block = source.slice(source.indexOf("<WorkflowControls"), source.indexOf("/>", source.indexOf("<WorkflowControls")));
  assert.match(block, /mediaCounts=\{imageMediaCounts\}/);
});
