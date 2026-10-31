import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-024c: the generic workflow node. Its look comes from the package description, its
// request is built from the node's values and connections, old image nodes convert in place.
const pkg = await loadWorkflowModule("workflowPackage");
const legacy = await loadWorkflowModule("legacyImageNode");
const choices = await loadWorkflowModule("choiceCache");
const controls = await loadWorkflowModule("WorkflowControls");
const fixture = await readJson("src-tauri/testdata/workflow_v2/generic-requests.json");
const described = async (short) => readJson(`src-tauri/testdata/workflow_v2/described/${short}.json`);

test("every image golden: node values + connections build exactly the request the engine reproduces", async () => {
  assert.equal(fixture.cases.length, 12);
  for (const item of fixture.cases) {
    const description = await described(item.module);
    const operation = description.operations[item.operation];
    assert.ok(operation, `${item.case}: no operation ${item.operation}`);
    const connected = item.operation === "upscaleImage"
      ? { image: item.request.inputs.source }
      : {
        text: [{ text: item.node.prompt }],
        ...(item.node.imagePaths.length ? { image: item.node.imagePaths.map((path) => ({ path })) } : {}),
      };
    const request = pkg.buildOperationRequest(item.operation, operation, item.node.values, connected, {
      seedMode: item.request.seedMode,
      seed: item.request.seed,
    });
    assert.deepEqual(request, item.request, item.case);
  }
});

test("a request the package would refuse is caught before submitting, with the port or control named", async () => {
  const description = await described("0bf9145b");
  const generate = description.operations.generate;
  const request = (values, connected) => pkg.buildOperationRequest("generate", generate, values, connected, { seedMode: "random", seed: "" });
  assert.equal(pkg.operationRequestError(generate, request({}, {})), "提示词不能为空");
  assert.equal(pkg.operationRequestError(generate, request({}, { text: [{ text: "   " }] })), "提示词不能为空");
  assert.equal(pkg.operationRequestError(generate, request({}, { text: [{ text: "fox" }] })), "");
  assert.match(pkg.operationRequestError(generate, request({ width: 10 }, { text: [{ text: "fox" }] })), /^宽度.*64.*4096/);
  const edit = (await described("52cba27b")).operations.generate;
  const editRequest = (images) => pkg.buildOperationRequest("generate", edit, {}, { text: [{ text: "fox" }], image: images }, { seedMode: "random", seed: "" });
  assert.match(pkg.operationRequestError(edit, editRequest([])), /编辑图片.*1.*2/);
  assert.match(pkg.operationRequestError(edit, editRequest([{ path: "a" }, { path: "b" }, { path: "c" }])), /编辑图片.*1.*2/);
  assert.equal(pkg.operationRequestError(edit, editRequest([{ path: "a" }])), "");
});

test("switching packages keeps what the new one declares and lets untouched defaults follow", async () => {
  const krea2 = (await described("0bf9145b")).operations.generate;
  const moss = (await described("5dd20ec7")).operations.generate;
  // Steps still at Krea2's default (8) move to Moss's default; a typed value stays.
  assert.deepEqual(pkg.switchedControlValues({ steps: 8, width: 900, loraName: "x" }, krea2, moss), { width: 900 });
  assert.deepEqual(pkg.switchedControlValues({ steps: 12 }, krea2, moss), { steps: 12 });
  assert.deepEqual(pkg.switchedControlValues({ loraName: "x", upscaleEnabled: true }, krea2, krea2), { loraName: "x", upscaleEnabled: true });
});

test("visibility follows the package's conditions", () => {
  const operation = { controls: [
    { id: "advanced", type: "toggle", label: "高级", default: false },
    { id: "cfg", type: "number", label: "CFG", default: 1, visibleWhen: { truthy: { control: "advanced" } } },
  ] };
  assert.deepEqual(pkg.visibleControls(operation, {}).map((c) => c.id), ["advanced"]);
  assert.deepEqual(pkg.visibleControls(operation, { advanced: true }).map((c) => c.id), ["advanced", "cfg"]);
});

// ---- old image nodes become generic nodes in place ----

const oldKrea2 = {
  status: "idle", workflowModuleId: "workflow-module-krea2", workflowModuleRevision: "v1", activeTextInputId: "t1",
  textInputOrder: ["t1"], imageLoraName: "Krea2\\a.safetensors", imageEditLayout: false, width: 1000, height: 600,
  steps: 12, upscaleEnabled: true, upscaleMegapixels: 4, seedMode: "fixed", seed: "5", negativePrompt: " ugly ",
};

test("an old image node keeps its module, its shell fields and every parameter", async () => {
  const generate = (await described("0bf9145b")).operations.generate;
  assert.equal(legacy.needsLegacyImageConversion(oldKrea2), true);
  const converted = legacy.convertLegacyImageNodeContent(oldKrea2, generate);
  assert.equal(converted.nodeShell, pkg.WORKFLOW_NODE_SHELL);
  assert.equal(converted.operation, "generate");
  assert.equal(converted.workflowModuleId, "workflow-module-krea2");
  assert.equal(converted.activeTextInputId, "t1");
  assert.equal(converted.seedMode, "fixed");
  assert.equal(converted.seed, "5");
  assert.deepEqual(converted.controlValues, {
    negativePrompt: " ugly ", width: 1000, height: 600, steps: 12,
    loraName: "Krea2\\a.safetensors", upscaleEnabled: true, upscaleMegapixels: 4,
  });
  // Converted once: a converted node is left alone.
  assert.equal(legacy.needsLegacyImageConversion(converted), false);
  assert.equal(legacy.convertLegacyImageNodeContent(converted, generate), converted);
});

test("the single old LoRA becomes the first slot when the package has a LoRA group", () => {
  const operation = { controls: [
    { id: "loras", type: "repeat", max: 6, fields: [
      { id: "name", type: "select", default: "" }, { id: "weight", type: "slider", default: 1 }, { id: "on", type: "toggle", default: true },
    ] },
  ] };
  const converted = legacy.convertLegacyImageNodeContent(oldKrea2, operation);
  assert.deepEqual(converted.controlValues.loras, [{ name: "Krea2\\a.safetensors" }]);
  assert.equal("loraName" in converted.controlValues, false);
  const none = legacy.convertLegacyImageNodeContent({ ...oldKrea2, imageLoraName: "" }, operation);
  assert.equal("loras" in none.controlValues, false);
});

test("values the old node never set stay unset, so the package and settings defaults apply", async () => {
  const moss = (await described("5dd20ec7")).operations.generate;
  const converted = legacy.convertLegacyImageNodeContent(
    { status: "idle", workflowModuleId: "m", imageLoraName: "", upscaleEnabled: false, width: 0 },
    moss,
  );
  // Moss declares neither LoRA nor upscale; a zero width was "use the default" before.
  assert.deepEqual(converted.controlValues, {});
});

// ---- choice lists: "加载中" until the list is in, never a flash of "未找到" ----

const modelControl = (dirs) => ({
  id: "modelName", type: "select", label: "模型", default: "", allowEmpty: true,
  options: { comfyui: { classType: "UNETLoader", input: "unet_name", dirs } },
});

const selectMarkup = (markup, label) => {
  const at = markup.indexOf(`aria-label="${label}"`);
  assert.ok(at >= 0, `no control labelled ${label} in ${markup}`);
  const start = markup.lastIndexOf("<select", at);
  const end = markup.indexOf("</select>", at);
  return markup.slice(start, end + "</select>".length);
};

const renderField = (control, value, state) => renderToStaticMarkup(createElement(controls.WorkflowControlField, {
  control, value, choices: state, onChange: () => {},
}));

test("a node just created shows the list as loading", () => {
  const store = choices.createChoiceStore();
  const control = { ...modelControl(["Krea2"]), preset: "Krea2\\base.safetensors" };
  const select = selectMarkup(renderField(control, undefined, store.get(choices.choiceKey(control))), "模型");
  assert.match(select, /加载中/);
  assert.doesNotMatch(select, /未找到/);
});

test("a node that just switched package shows the new list as loading, not the old one", () => {
  const store = choices.createChoiceStore();
  const before = modelControl(["Krea2"]);
  store.set(choices.choiceKey(before), ["Krea2\\a.safetensors"]);
  const after = modelControl(["Moss"]);
  assert.notEqual(choices.choiceKey(before), choices.choiceKey(after));
  const select = selectMarkup(renderField(after, "Krea2\\a.safetensors", store.get(choices.choiceKey(after))), "模型");
  assert.match(select, /加载中/);
  assert.doesNotMatch(select, /未找到/);
  assert.doesNotMatch(select, /Krea2\\a\.safetensors"[^>]*>a\.safetensors/);
});

test("a canvas just opened shows a saved choice as loading, then found or not found", () => {
  const store = choices.createChoiceStore();
  const control = modelControl(["Krea2"]);
  const key = choices.choiceKey(control);
  const opened = selectMarkup(renderField(control, "Krea2\\saved.safetensors", store.get(key)), "模型");
  assert.match(opened, /加载中/);
  assert.doesNotMatch(opened, /未找到/);
  store.set(key, ["Krea2\\other.safetensors"]);
  const missing = selectMarkup(renderField(control, "Krea2\\saved.safetensors", store.get(key)), "模型");
  assert.match(missing, /未找到/);
  assert.match(missing, /saved\.safetensors/);
  store.set(key, ["Krea2\\saved.safetensors"]);
  const found = selectMarkup(renderField(control, "Krea2\\saved.safetensors", store.get(key)), "模型");
  assert.doesNotMatch(found, /未找到|加载中/);
  assert.match(found, /<option value="Krea2\\saved\.safetensors" selected="">saved\.safetensors<\/option>/);
});

test("an empty choice says what empty means: the preset, else the workflow's own", () => {
  const store = choices.createChoiceStore();
  const plain = modelControl(["Krea2"]);
  store.set(choices.choiceKey(plain), ["Krea2\\a.safetensors"]);
  const withPreset = { ...plain, preset: "Krea2\\a.safetensors" };
  assert.match(selectMarkup(renderField(withPreset, undefined, store.get(choices.choiceKey(plain))), "模型"), /<option value="" selected="">默认（a\.safetensors）<\/option>/);
  assert.match(selectMarkup(renderField(plain, "", store.get(choices.choiceKey(plain))), "模型"), /<option value="" selected="">工作流自带<\/option>/);
  // The package may name the empty choice itself.
  const lora = { ...plain, id: "loraName", label: "LoRA", emptyLabel: "不使用 LoRA" };
  assert.match(selectMarkup(renderField(lora, "", store.get(choices.choiceKey(plain))), "LoRA"), /<option value="" selected="">不使用 LoRA<\/option>/);
});

test("the converted image packages name their empty LoRA choice like the old node", async () => {
  const generate = (await described("0bf9145b")).operations.generate;
  assert.equal(generate.controls.find((c) => c.id === "loraName").emptyLabel, "不使用 LoRA");
});

test("the controls of a package render with its labels, units and the size swap", async () => {
  const generate = (await described("0bf9145b")).operations.generate;
  const markup = renderToStaticMarkup(createElement(controls.WorkflowControls, {
    operation: generate, values: { width: 1000 }, choicesFor: () => ({ status: "loading" }), onChange: () => {},
  }));
  for (const label of ["负向提示词", "宽度", "高度", "生图步数", "LoRA", "模型", "输出放大"]) {
    assert.match(markup, new RegExp(`aria-label="${label}`), label);
  }
  assert.match(markup, /aria-label="宽度"[^>]*value="1000"/);
  assert.match(markup, /aria-label="高度"[^>]*value="720"/);
  assert.match(markup, /互换/);
  // The seed is drawn by the node shell, not as a plain control.
  assert.doesNotMatch(markup, /aria-label="种子"/);
});
