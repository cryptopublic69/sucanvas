import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { loadWorkflowModule } from "./workflowTestLoader.mjs";

// CANVAS-041 (su 11-11): on the 「工作流方案」 tab the sampler is a draft like the name and the
// revision. Choosing one writes nothing; 「保存」 writes it into the selected scheme (with a
// restore point); 「另存为新方案」 creates a new scheme from the selected scheme's own settings
// plus the draft and leaves the selected scheme untouched. An unsaved draft is visible.
// (su chose lcm to make an LCM copy; the original scheme, used by ~1540 nodes, changed at once.)
const load = async (name) => loadWorkflowModule(name).catch((error) => ({ loadError: error.message }));
const setting = await load("samplerSetting");
const view = await load("WorkflowSamplerSetting");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/settings/WorkflowSettingsPanel.tsx", import.meta.url), "utf8");

const sourceDefaults = {
  primaryVideoSteps: 8, primaryAudioSteps: 8, secondarySchedulerSteps: 4, primaryUpscaleFactor: 1,
  primaryBrightness: 1, primaryContrast: 0.8, primarySaturation: 1, secondaryBrightness: 1,
  secondaryContrast: 0.9, secondarySaturation: 1, diffusionModelName: "Source\\model.safetensors",
  loraName: "Source\\scheme-lora.safetensors", loraStrength: 0.7,
};
const scheme = (extra = {}) => ({
  id: "workflow-module-source", name: "源方案", capability: "video-generation", variant: "reference-to-video",
  revision: "V3.1", adapterKind: "workflow-package", deletedAt: null, workflowPath: "F:\\store\\source\\workflow.json",
  defaults: { ...sourceDefaults, samplerName: null, ...(extra.defaults ?? {}) },
  bindings: { promptNodeId: "1", samplerSelectNodeIds: ["a", "b"] },
  adapter: { adapterId: "any-adapter", bindings: { promptNodeId: "1", samplerSelectNodeIds: ["a", "b"] } },
  uiSchema: { schemaVersion: 1, groups: [] },
  ...(extra.module ?? {}),
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

// saveWorkflowModuleDraft with the page state of a selected scheme (or none). The global video
// model settings deliberately differ from the scheme's own settings.
function saveDraft({ module, samplerDraft, saved }) {
  const calls = [];
  const notices = [];
  const errors = [];
  const env = {
    selectedWorkflowModule: module,
    workflowModuleSamplerDraft: samplerDraft,
    workflowModuleNameDraft: module ? `${module.name} LCM` : "新工作流方案",
    workflowModuleRevisionDraft: "V3.1-LCM",
    workflowModuleCapabilityDraft: module?.capability ?? "video-generation",
    workflowModuleVariantDraft: module?.variant ?? "reference-to-video",
    workflowModulePathDraft: module?.workflowPath ?? "F:\\in\\workflow.json",
    workflowModuleBindingsDraft: module ? JSON.stringify(module.bindings) : "",
    workflowBindingsFromDraft: (value) => (value.trim() ? JSON.parse(value) : undefined),
    WORKFLOW_PACKAGE_ENGINE: "workflow-package",
    h3ModelParameters: { primaryVideoSteps: 6, primaryAudioSteps: 8, secondarySchedulerSteps: 4, primaryContrast: 0.9 },
    h3DiffusionModelName: "Global\\model.safetensors",
    h3LoraPreference: { loraName: "Global\\lora.safetensors", loraStrength: 1 },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "save_workflow_module") return saved?.(args) ?? { ...args.input, id: args.input.id ?? "workflow-module-new" };
      return { id: args.workflowModuleId, defaults: args.defaults };
    },
    refreshWorkflowModules: async () => {},
    setSelectedWorkflowModuleId: () => {},
    workflowModuleFamilyKey: (value) => `${value.capability}:${value.variant}`,
    setWorkflowModuleDefaults: () => {},
    setWorkflowModuleValidation: () => {},
    setWorkflowModulesBusy: () => {},
    showGlobalNotice: (text) => notices.push(text),
    reportError: (error) => errors.push(error),
    samplerDefaults: setting.samplerDefaults,
    samplerDraftDefaults: setting.samplerDraftDefaults,
    hasSamplerSetting: setting.hasSamplerSetting,
    currentSampler: setting.currentSampler,
  };
  return { run: callback(app, "saveWorkflowModuleDraft", env), calls, notices, errors };
}

test("helpers: the draft goes into the scheme's own settings; unsaved = differs from the saved value", () => {
  assert.equal(typeof setting.samplerDraftDefaults, "function", "samplerDraftDefaults missing");
  assert.equal(typeof setting.samplerDraftDirty, "function", "samplerDraftDirty missing");
  const module = scheme();
  assert.deepEqual(setting.samplerDraftDefaults(module, "lcm"), { ...module.defaults, samplerName: "lcm" });
  assert.deepEqual(setting.samplerDraftDefaults(scheme({ defaults: { samplerName: "lcm" } }), ""), { ...module.defaults, samplerName: null });
  // A package without sampler nodes: its settings are written as they are.
  const plain = scheme({ module: { adapter: { adapterId: "x", bindings: { promptNodeId: "1" } } } });
  assert.deepEqual(setting.samplerDraftDefaults(plain, "lcm"), plain.defaults);
  assert.equal(setting.samplerDraftDirty(module, "lcm"), true);
  assert.equal(setting.samplerDraftDirty(module, ""), false);
  assert.equal(setting.samplerDraftDirty(scheme({ defaults: { samplerName: "lcm" } }), " lcm "), false);
  assert.equal(setting.samplerDraftDirty(scheme({ defaults: { samplerName: "lcm" } }), ""), true);
  assert.equal(setting.samplerDraftDirty(plain, "lcm"), false);
});

test("choosing a sampler only changes the draft: no write command from the dropdown", () => {
  assert.doesNotMatch(app, /saveWorkflowModuleSampler/, "App still saves the sampler on choice");
  assert.doesNotMatch(panel, /saveWorkflowModuleSampler|update_workflow_module_defaults|save_workflow_module/);
  const at = panel.indexOf("<WorkflowSamplerSetting");
  assert.ok(at > 0);
  const element = panel.slice(at, panel.indexOf("/>", at));
  assert.match(element, /value=\{workflowModuleSamplerDraft\}/);
  assert.match(element, /onChange=\{setWorkflowModuleSamplerDraft\}/);
});

test("switching the selected scheme resets the sampler draft like the name draft", () => {
  const at = app.indexOf("setWorkflowModuleNameDraft(selectedWorkflowModule.name);");
  assert.ok(at > 0);
  const effect = app.slice(at, app.indexOf("}, [selectedWorkflowModule]);", at));
  assert.match(effect, /setWorkflowModuleSamplerDraft\(currentSampler\(selectedWorkflowModule\)\)/);
});

test("「另存为新方案」: new scheme = the selected scheme's settings + the draft; nothing written to the source", async () => {
  const module = scheme();
  const { run, calls, errors } = saveDraft({ module, samplerDraft: "lcm" });
  await run(false);
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1, JSON.stringify(calls));
  const [command, args] = calls[0];
  assert.equal(command, "save_workflow_module");
  assert.equal(args.input.id, undefined);
  assert.deepEqual(args.input.defaults, { ...sourceDefaults, samplerName: "lcm" });
  assert.notEqual(args.input.defaults.loraName, "Global\\lora.safetensors");
});

test("「另存为新方案」 with the draft at 'unset' copies the scheme without a sampler", async () => {
  const module = scheme({ defaults: { samplerName: "euler_a" } });
  const { run, calls } = saveDraft({ module, samplerDraft: "" });
  await run(false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].input.defaults, { ...sourceDefaults, samplerName: null });
});

test("「另存为新方案」 with no scheme selected (new scheme) keeps the global settings as before", async () => {
  const { run, calls } = saveDraft({ module: null, samplerDraft: "lcm" });
  await run(false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].input.defaults, {
    primaryVideoSteps: 6, primaryAudioSteps: 8, secondarySchedulerSteps: 4, primaryContrast: 0.9,
    diffusionModelName: "Global\\model.safetensors", loraName: "Global\\lora.safetensors", loraStrength: 1,
  });
});

test("「保存」 writes the draft into the selected scheme (overwrite = restore point)", async () => {
  const module = scheme();
  const { run, calls, notices, errors } = saveDraft({ module, samplerDraft: "lcm" });
  await run(true);
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "save_workflow_module");
  assert.equal(calls[0][1].input.id, module.id);
  assert.deepEqual(calls[0][1].input.defaults, { ...sourceDefaults, samplerName: "lcm" });
  assert.match(notices.join("\n"), /恢复点/);
});

test("「保存」 back at 'unset' clears the scheme's sampler (null)", async () => {
  const module = scheme({ defaults: { samplerName: "lcm" } });
  // The store keeps the scheme's sampler when a save names none (CANVAS-039 rule), so the
  // clear has to go through the settings command afterwards.
  const { run, calls, errors } = saveDraft({
    module, samplerDraft: "",
    saved: (args) => ({ ...args.input, id: module.id, defaults: { ...args.input.defaults, samplerName: "lcm" } }),
  });
  await run(true);
  assert.deepEqual(errors, []);
  assert.equal(calls[0][0], "save_workflow_module");
  assert.equal(calls[0][1].input.defaults.samplerName, null);
  const clear = calls.find(([command]) => command === "update_workflow_module_defaults");
  assert.ok(clear, JSON.stringify(calls));
  assert.equal(clear[1].workflowModuleId, module.id);
  assert.deepEqual(clear[1].defaults, { ...sourceDefaults, samplerName: null });
});

test("「保存」 unchanged at 'unset' needs no second command", async () => {
  const { run, calls } = saveDraft({ module: scheme(), samplerDraft: "" });
  await run(true);
  assert.deepEqual(calls.map(([command]) => command), ["save_workflow_module"]);
});

// The real component with a plain select standing in for the settings page's SettingsSelect.
const Select = ({ value, options, ariaLabel, disabled }) => createElement("select", { "aria-label": ariaLabel, value, disabled, onChange: () => {} },
  options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)));
const render = (props) => renderToStaticMarkup(createElement(view.WorkflowSamplerSetting, {
  choices: { packageValue: "euler", options: ["euler", "lcm"] }, loading: false, error: "", busy: false, onChange: () => {}, Select, ...props,
}));

test("the dropdown shows the draft and says when it is not saved", () => {
  const dirty = render({ module: scheme(), value: "lcm" });
  assert.match(dirty, /<option value="lcm" selected="">lcm<\/option>/);
  assert.match(dirty, /未保存/);
  assert.match(dirty, /未设置（沿用方案包：euler）/);
  const clean = render({ module: scheme({ defaults: { samplerName: "lcm" } }), value: "lcm" });
  assert.match(clean, /<option value="lcm" selected="">lcm<\/option>/);
  assert.doesNotMatch(clean, /未保存/);
});
