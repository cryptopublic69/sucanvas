import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-029: the Krea2 packages offer the same LoRA group as Moss (up to 6, weight 0–2, on/off),
// drawn by the generic repeat group. Old Krea2 nodes keep their single LoRA as the first item.
const pkg = await loadWorkflowModule("workflowPackage");
const legacy = await loadWorkflowModule("legacyImageNode");
const controls = await loadWorkflowModule("WorkflowControls");
const source = async (short) => (await readJson(`workflow-packages/image-v2/${short}/adapter.json`)).operations.generate;
const loraGroup = (operation) => (operation.controls ?? []).find((control) => control.id === "loras");

const render = (operation, values) => renderToStaticMarkup(createElement(controls.WorkflowControls, {
  operation, values, choicesFor: () => ({ status: "ready", values: ["d\\a.safetensors", "d\\b.safetensors"] }), onChange: () => {},
}));

for (const short of ["0bf9145b", "52cba27b"]) {
  test(`${short}: the LoRA group is Moss's, in the Krea2 directory, right after the model`, async () => {
    const moss = loraGroup(await source("5dd20ec7"));
    const operation = await source(short);
    const group = loraGroup(operation);
    assert.ok(group, `${short} has no LoRA group`);
    const expected = structuredClone(moss);
    expected.fields.find((field) => field.id === "name").options.comfyui.dirs = ["Krea2"];
    assert.deepEqual(group, expected);
    const ids = operation.controls.map((control) => control.id);
    assert.equal(ids[ids.indexOf("loras") - 1], "modelName");
    assert.equal(ids.includes("loraName"), false, "the single LoRA control is replaced");
  });

  test(`${short}: 0, 1 and 3 LoRA items draw exactly like Moss's group`, async () => {
    const own = loraGroup(await source(short));
    assert.ok(own, `${short} has no LoRA group`);
    const krea = { controls: [own] };
    const moss = { controls: [loraGroup(await source("5dd20ec7"))] };
    for (const items of [[], [{}], [{}, { on: false, weight: 0.5 }, { weight: 1.5 }]]) {
      assert.equal(render(krea, { loras: items }), render(moss, { loras: items }), `${items.length} items`);
    }
  });
}

test("an old Krea2 text-to-image node's LoRA becomes the first item, weight 1 and on by default", async () => {
  const operation = await source("0bf9145b");
  const converted = legacy.convertLegacyImageNodeContent({
    workflowModuleId: "workflow-module-0bf9145b-ac9f-47ac-a85d-24d81612a643",
    imageLoraName: "Krea2\\PornMaster_Krea2_Realism_slider_V1.safetensors",
    width: 1280,
    height: 720,
  }, operation);
  assert.deepEqual(converted.controlValues.loras, [{ name: "Krea2\\PornMaster_Krea2_Realism_slider_V1.safetensors" }]);
  assert.equal("loraName" in converted.controlValues, false);
  const group = loraGroup(operation);
  const field = (id) => group.fields.find((item) => item.id === id);
  assert.equal(field("weight").default, 1);
  assert.equal(field("on").default, true);
  const request = pkg.buildOperationRequest("generate", operation, converted.controlValues, { text: [{ text: "fox" }] }, { seedMode: "fixed", seed: "7" });
  assert.deepEqual(request.values.loras, [{ name: "Krea2\\PornMaster_Krea2_Realism_slider_V1.safetensors" }]);
  assert.equal(pkg.operationRequestError(operation, request), "");
});

test("an existing image edit node opens with an empty LoRA group and its values unchanged", async () => {
  const operation = await source("52cba27b");
  const content = {
    workflowModuleId: "workflow-module-52cba27b-07ed-4fda-b95e-c5e90c8f3fa1",
    nodeShell: "workflow", nodeShellVersion: legacy.NODE_SHELL_VERSION, operation: "generate",
    controlValues: { width: 1024, height: 1024, steps: 8 },
  };
  const opened = legacy.convertLegacyImageNodeContent(content, operation);
  assert.equal(opened, content, "a node already on the generic shell is left alone");
  const markup = render(operation, opened.controlValues);
  assert.match(markup, /<section class="workflow-repeat" aria-label="LoRA">/);
  assert.match(markup, />0\/6</);
  assert.doesNotMatch(markup, /class="workflow-repeat-item"/);
  const request = pkg.buildOperationRequest("generate", operation, opened.controlValues, { text: [{ text: "fox" }], image: [{ path: "a.png" }] }, { seedMode: "fixed", seed: "7" });
  assert.equal("loras" in request.values, false);
  assert.equal(pkg.operationRequestError(operation, request), "");
});
