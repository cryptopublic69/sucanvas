import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { loadWorkflowModule } from "./workflowTestLoader.mjs";

// CANVAS-039 (su 11-11): an H3 scheme's sampler is chosen per scheme on the settings page's
// 「工作流方案」 tab. Only packages that declare sampler nodes (adapter bindings
// samplerSelectNodeIds) get the dropdown; the value is the module setting samplerName
// (manifest defaults), saved with the scheme (CANVAS-041: a draft until 「保存」); unset = the package's own value. Options come from
// ComfyUI through the server; without ComfyUI the dropdown still shows the current value.
// Nodes and regeneration presets get no sampler.
// A missing module fails each test on its own instead of the whole file.
const load = async (name) => loadWorkflowModule(name).catch((error) => ({ loadError: error.message }));
const setting = await load("samplerSetting");
const view = await load("WorkflowSamplerSetting");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/settings/WorkflowSettingsPanel.tsx", import.meta.url), "utf8");
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const defaults = {
  primaryVideoSteps: 6, primaryAudioSteps: 8, secondarySchedulerSteps: 4, primaryUpscaleFactor: 1,
  primaryBrightness: 1, primaryContrast: 0.9, primarySaturation: 0.9, secondaryBrightness: 1,
  secondaryContrast: 0.9, secondarySaturation: 1, diffusionModelName: "MinimaxH3\\model.safetensors",
  loraName: "MinimaxH3\\lora.safetensors", loraStrength: 1,
};
const scheme = (ids, extra = {}) => ({
  id: "workflow-module-test", name: "方案", capability: "video-generation", variant: "reference-to-video",
  revision: "r", deletedAt: null, defaults: { ...defaults, ...(extra.defaults ?? {}) },
  bindings: { promptNodeId: "1" },
  adapter: { adapterId: "any-adapter", bindings: ids === undefined ? { promptNodeId: "1" } : { promptNodeId: "1", samplerSelectNodeIds: ids } },
  ...extra.module,
});

test("only a package that declares sampler nodes has a sampler setting", () => {
  assert.deepEqual(setting.samplerNodeIds(scheme(["a", "b"])), ["a", "b"]);
  assert.deepEqual(setting.samplerNodeIds(scheme(undefined)), []);
  assert.deepEqual(setting.samplerNodeIds(scheme([])), []);
  assert.equal(setting.hasSamplerSetting(scheme(["a"])), true);
  assert.equal(setting.hasSamplerSetting(scheme(undefined)), false);
  assert.equal(setting.hasSamplerSetting(scheme(["a"], { module: { deletedAt: "2026-11-11" } })), false);
  assert.equal(setting.currentSampler(scheme(["a"], { defaults: { samplerName: " res_multistep " } })), "res_multistep");
  assert.equal(setting.currentSampler(scheme(["a"])), "");
});

test("the options are ComfyUI's list after 'unset (package value)', and keep the current value", () => {
  const choices = { packageValue: "euler", options: ["euler", "res_multistep", "dpmpp_2m"] };
  assert.deepEqual(setting.samplerOptions(choices, ""), [
    { value: "", label: "未设置（沿用方案包：euler）" },
    { value: "euler", label: "euler" },
    { value: "res_multistep", label: "res_multistep" },
    { value: "dpmpp_2m", label: "dpmpp_2m" },
  ]);
  // ComfyUI unreachable: no list, the current value is still offered (and shown).
  assert.deepEqual(setting.samplerOptions(null, "res_multistep"), [
    { value: "", label: "未设置（沿用方案包）" },
    { value: "res_multistep", label: "res_multistep" },
  ]);
  // A saved value ComfyUI no longer lists stays selectable.
  assert.deepEqual(setting.samplerOptions({ packageValue: "euler", options: ["euler"] }, "gone").map((o) => o.value), ["", "euler", "gone"]);
});

test("saving keeps every other setting and clears with null", () => {
  const module = scheme(["a"], { defaults: { samplerName: "euler" } });
  assert.deepEqual(setting.samplerDefaults(module.defaults, "res_multistep"), { ...module.defaults, samplerName: "res_multistep" });
  assert.deepEqual(setting.samplerDefaults(module.defaults, ""), { ...module.defaults, samplerName: null });
  assert.deepEqual(setting.samplerDefaults(module.defaults, "  "), { ...module.defaults, samplerName: null });
});

// The real component with a plain select standing in for the settings page's SettingsSelect.
const Select = ({ value, options, ariaLabel, disabled }) => createElement("select", { "aria-label": ariaLabel, value, disabled, onChange: () => {} },
  options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)));
const render = (props) => renderToStaticMarkup(createElement(view.WorkflowSamplerSetting, {
  choices: null, loading: false, error: "", busy: false, onChange: () => {}, Select, ...props,
}));

test("the settings page draws the dropdown only for a declaring scheme", () => {
  const html = render({
    module: scheme(["a", "b"], { defaults: { samplerName: "res_multistep" } }),
    choices: { packageValue: "euler", options: ["euler", "res_multistep"] },
  });
  assert.match(html, /采样器/);
  assert.match(html, /aria-label="方案采样器"/);
  assert.match(html, /<option value="res_multistep" selected="">res_multistep<\/option>/);
  assert.match(html, /未设置（沿用方案包：euler）/);
  assert.match(html, /1采和二段精修共用/);
  assert.equal(render({ module: scheme(undefined) }), "");
  assert.equal(render({ module: scheme([], {}) }), "");
  assert.equal(render({ module: scheme(["a"], { module: { deletedAt: "x" } }) }), "");
});

test("without ComfyUI the dropdown shows the current value and a quiet note, not an error", () => {
  const html = render({ module: scheme(["a"], { defaults: { samplerName: "res_multistep" } }), error: "connect ECONNREFUSED" });
  assert.match(html, /<option value="res_multistep" selected="">res_multistep<\/option>/);
  assert.match(html, /暂时读不到 ComfyUI 的采样器列表/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /ECONNREFUSED/);
});

// Run one real callback from App.tsx without rendering (harness of generatorAltJump.test.mjs).
function callback(source, name, env) {
  const file = ts.createSourceFile("test.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let arrow;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) {
      arrow = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(arrow, `Missing callback ${name}`);
  const code = ts.transpileModule(`const run = ${arrow.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(env), `${code}; return run;`)(...Object.values(env));
}

// CANVAS-041: choosing a sampler no longer saves; it is a draft saved by 「保存」/「另存为新方案」
// (tests/workflowSamplerDraft.test.mjs).

test("the 「工作流方案」 tab loads the choices from the server and draws the setting", () => {
  assert.match(panel, /<WorkflowSamplerSetting\b/);
  assert.match(panel, /"get_workflow_sampler_choices"/);
  assert.match(panel, /workflowModuleId: selectedWorkflowModule\.id/);
});

test("the video model settings save keeps the module's other settings (the sampler included)", () => {
  const start = app.indexOf("const savedModelParameters = {");
  assert.ok(start > 0);
  const save = app.slice(start, app.indexOf("});", app.indexOf("\"save_workflow_module\"", start)));
  assert.match(save, /defaults: \{\s*\.\.\.module\.defaults,/);
});

test("nodes, regeneration presets and the submissions carry no sampler", async () => {
  for (const path of ["src/CanvasNode.tsx", "src/video/VideoRegenerationDialogs.tsx", "src/video/videoRegenerationPresets.ts", "src/settings/VideoModelSettingsPanel.tsx"]) {
    const source = await read(path);
    assert.doesNotMatch(source, /samplerName|采样器/, path);
  }
  for (const at of [...app.matchAll(/invoke<ComfySubmitResult>\("submit_comfyui_workflow", \{/g)].map((m) => m.index)) {
    assert.doesNotMatch(app.slice(at, app.indexOf("});", at)), /sampler/i);
  }
});

test("the new setting code names no scheme, adapter, node or ComfyUI class", async () => {
  for (const path of ["src/workflow/samplerSetting.ts", "src/workflow/WorkflowSamplerSetting.tsx"]) {
    const source = await read(path);
    assert.doesNotMatch(source, /minimax|\bH3\b|\bFla|KSamplerSelect|"123"|"389"|euler|res_multistep/i, path);
  }
});
