import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// CANVAS-022: Krea2 and Moss text-to-image modules share the image generation node.
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const source = await readFile(new URL("../src/image/imageWorkflowAdapter.ts", import.meta.url), "utf8");
const adapter = await import(`data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`);
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const canvas = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");

const module = (id, adapterId, variant = "image-generation", extra = {}) => ({
  id,
  capability: "image-generation",
  variant,
  revision: "v1",
  deletedAt: null,
  adapter: { adapterId },
  defaults: { diffusionModelName: "" },
  ...extra,
});
const krea2 = module("krea2", "krea2-text-to-image-v1");
const edit = module("edit", "krea2-image-edit-v1", "image-edit");
const moss = module("moss", "moss-text-to-image-v1");

test("only the Krea2 text-to-image module offers LoRA and output upscale", () => {
  assert.equal(adapter.isMossImageModule(moss), true);
  assert.equal(adapter.isMossImageModule(krea2), false);
  assert.equal(adapter.isMossImageModule(undefined), false);
  assert.equal(adapter.imageModuleSupportsLora(krea2), true);
  assert.equal(adapter.imageModuleSupportsLora(edit), false);
  assert.equal(adapter.imageModuleSupportsLora(moss), false);
  assert.equal(adapter.imageModuleSupportsUpscale(krea2), true);
  assert.equal(adapter.imageModuleSupportsUpscale(edit), false);
  assert.equal(adapter.imageModuleSupportsUpscale(moss), false);
  // Old nodes without a resolvable module keep the Krea2 controls.
  assert.equal(adapter.imageModuleSupportsLora(undefined), true);
});

test("default steps follow the module: Moss 25, Krea2 stays 8", () => {
  assert.equal(adapter.defaultImageSteps(moss), 25);
  assert.equal(adapter.defaultImageSteps(krea2), 8);
  assert.equal(adapter.defaultImageSteps(edit), 8);
  assert.equal(adapter.defaultImageSteps(undefined), 8);
});

test("base model names are checked against the module's own directory", () => {
  assert.equal(adapter.isImageModelNameForModule("Krea2\\a.safetensors", krea2), true);
  assert.equal(adapter.isImageModelNameForModule("Kera2\\a.safetensors", krea2), true);
  assert.equal(adapter.isImageModelNameForModule("Moss\\a.safetensors", krea2), false);
  assert.equal(adapter.isImageModelNameForModule("Moss\\pornmasterMoss_v1.safetensors", moss), true);
  assert.equal(adapter.isImageModelNameForModule("Moss/pornmasterMoss_v1.safetensors", moss), true);
  assert.equal(adapter.isImageModelNameForModule("Krea2\\a.safetensors", moss), false);
  assert.equal(adapter.isImageModelNameForModule("Moss\\", moss), false);
  assert.equal(adapter.imageModelDirectoryLabel(moss), "Moss");
  assert.equal(adapter.imageModelDirectoryLabel(krea2), "Krea2");
});

test("switching module clears what the new module cannot use and moves untouched steps", () => {
  const content = { workflowModuleId: "krea2", imageLoraName: "Krea2\\l.safetensors", upscaleEnabled: true, steps: 8, status: "invalid", validationMessage: "x" };
  const toMoss = adapter.imageModuleSwitchContent(content, moss, krea2);
  assert.equal(toMoss.workflowModuleId, "moss");
  assert.equal(toMoss.workflowModuleRevision, "v1");
  assert.equal(toMoss.imageEditLayout, false);
  assert.equal(toMoss.imageLoraName, "");
  assert.equal(toMoss.upscaleEnabled, false);
  assert.equal(toMoss.steps, 25);
  assert.equal(toMoss.status, "idle");
  assert.equal(toMoss.validationMessage, "");
  const back = adapter.imageModuleSwitchContent(toMoss, krea2, moss);
  assert.equal(back.steps, 8);
  assert.equal(back.imageLoraName, "");
  assert.equal(back.upscaleEnabled, false);
  // Steps the user typed are kept.
  assert.equal(adapter.imageModuleSwitchContent({ ...content, steps: 12 }, moss, krea2).steps, 12);
  // Krea2 -> Krea2 revision keeps LoRA and upscale.
  const same = adapter.imageModuleSwitchContent(content, module("krea2b", "krea2-text-to-image-v1"), krea2);
  assert.equal(same.imageLoraName, "Krea2\\l.safetensors");
  assert.equal(same.upscaleEnabled, true);
  const toEdit = adapter.imageModuleSwitchContent(content, edit, krea2);
  assert.equal(toEdit.imageEditLayout, true);
  assert.equal(toEdit.imageLoraName, "");
  assert.equal(toEdit.upscaleEnabled, false);
});

test("a submission never carries LoRA or upscale for a module that cannot use them", () => {
  const stale = { imageLoraName: " Krea2\\l.safetensors ", upscaleEnabled: true };
  assert.deepEqual(adapter.effectiveImageOptions(stale, moss), { loraName: "", upscaleEnabled: false });
  assert.deepEqual(adapter.effectiveImageOptions(stale, edit), { loraName: "", upscaleEnabled: false });
  assert.deepEqual(adapter.effectiveImageOptions(stale, krea2), { loraName: "Krea2\\l.safetensors", upscaleEnabled: true });
});

test("image upscale always uses a Krea2 text-to-image module, even when Moss is the default", () => {
  const modules = [moss, edit, krea2];
  assert.equal(adapter.imageUpscaleModule(modules, "moss")?.id, "krea2");
  assert.equal(adapter.imageUpscaleModule(modules, "krea2")?.id, "krea2");
  const second = module("krea2-v2", "krea2-text-to-image-v1");
  assert.equal(adapter.imageUpscaleModule([krea2, second], "krea2-v2")?.id, "krea2-v2");
  assert.equal(adapter.imageUpscaleModule([moss, { ...krea2, deletedAt: "2026-10-01" }], "moss"), undefined);
});

test("images made by Moss do not offer the toolbar upscale", () => {
  const modules = [moss, krea2];
  assert.equal(adapter.generatedImageUpscaleSupported({ generationWorkflowModuleId: "moss" }, modules), false);
  assert.equal(adapter.generatedImageUpscaleSupported({ generationWorkflowModuleId: "krea2" }, modules), true);
  // Imported or older images without a recorded module keep the button.
  assert.equal(adapter.generatedImageUpscaleSupported({}, modules), true);
  assert.equal(adapter.generatedImageUpscaleSupported({ generationWorkflowModuleId: "gone" }, modules), true);
});

test("the node, the submission and the toolbar use these rules", () => {
  assert.match(canvas, /imageModuleSupportsLora\(selectedImageWorkflowModule\)/);
  assert.match(canvas, /imageModuleSupportsUpscale\(selectedImageWorkflowModule\)/);
  assert.match(canvas, /imageModuleSwitchContent\(/);
  assert.match(canvas, /generatedImageUpscaleSupported\(/);
  assert.match(app, /effectiveImageOptions\(target\.content, selectedImageModule\)/);
  assert.match(app, /imageUpscaleModule\(workflowModules, /);
  assert.match(app, /defaultImageSteps\(module\)/);
  assert.match(app, /isImageModelNameForModule\(/);
});
