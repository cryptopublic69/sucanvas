import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// CANVAS-023: Moss takes up to 6 model-only LoRAs and a per-node Moss base model.
// Krea2 keeps its single LoRA; the H3 style LoRA editor renders as before.
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const source = await readFile(new URL("../src/image/imageWorkflowAdapter.ts", import.meta.url), "utf8");
const adapter = await import(`data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`);
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const canvas = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const editor = await readFile(new URL("../src/StyleLoraEditor.tsx", import.meta.url), "utf8");

const module = (id, adapterId, variant = "image-generation", diffusionModelName = "") => ({
  id, capability: "image-generation", variant, revision: "v1", deletedAt: null,
  adapter: { adapterId }, defaults: { diffusionModelName },
});
const krea2 = module("krea2", "krea2-text-to-image-v1", "image-generation", "Krea2\\base.safetensors");
const edit = module("edit", "krea2-image-edit-v1", "image-edit");
const moss = module("moss", "moss-text-to-image-v1", "image-generation", "Moss\\pornmasterMoss_v1.safetensors");
const A = "moss\\KOOK-MOSS-SFT-观澜.safetensors";
const B = "moss\\moss_pussy_lora_v2.0.safetensors";

test("only Moss offers the multi-LoRA list, at most 6; Krea2 keeps its single LoRA", () => {
  assert.equal(adapter.MAX_MOSS_LORAS, 6);
  assert.equal(adapter.imageModuleSupportsMultiLora(moss), true);
  assert.equal(adapter.imageModuleSupportsMultiLora(krea2), false);
  assert.equal(adapter.imageModuleSupportsMultiLora(edit), false);
  assert.equal(adapter.imageModuleSupportsMultiLora(undefined), false);
  // 022 rules for the Krea2 single LoRA and the upscale stay as they were.
  assert.equal(adapter.imageModuleSupportsLora(krea2), true);
  assert.equal(adapter.imageModuleSupportsLora(moss), false);
  assert.equal(adapter.imageModuleSupportsUpscale(moss), false);
});

test("Moss LoRA slots are read from the node content in the shared editor's shape", () => {
  assert.deepEqual(adapter.mossLorasFromContent({}), []);
  assert.deepEqual(adapter.mossLorasFromContent({ mossLoras: "x" }), []);
  assert.deepEqual(adapter.mossLorasFromContent({ mossLoras: [
    { name: A, strength: 0.5, bypassed: false },
    { name: "", strength: "x" },
    { name: B },
    null,
  ] }), [
    { name: A, strength: 0.5, bypassed: false, applyToSecondary: false, applyToSecondPass: false },
    { name: "", strength: 1, bypassed: true, applyToSecondary: false, applyToSecondPass: false },
    { name: B, strength: 1, bypassed: false, applyToSecondary: false, applyToSecondPass: false },
    { name: "", strength: 1, bypassed: true, applyToSecondary: false, applyToSecondPass: false },
  ]);
});

test("a Moss submission carries every slot; other modules carry no LoRA list at all", () => {
  const content = { mossLoras: [{ name: ` ${A} `, strength: 0.5, bypassed: false, applyToSecondPass: true }, { name: B, strength: 1, bypassed: true }] };
  assert.deepEqual(adapter.effectiveMossLoras(content, moss), [
    { name: A, strength: 0.5, bypassed: false },
    { name: B, strength: 1, bypassed: true },
  ]);
  assert.equal(adapter.effectiveMossLoras(content, krea2), null);
  assert.equal(adapter.effectiveMossLoras(content, edit), null);
  assert.equal(adapter.effectiveMossLoras(content, undefined), null);
});

test("the Moss list is checked before submitting, with the H3 weight rule", () => {
  const slot = (name, strength = 1, bypassed = false) => ({ name, strength, bypassed, applyToSecondary: false, applyToSecondPass: false });
  assert.equal(adapter.mossLoraValidationError([]), null);
  assert.equal(adapter.mossLoraValidationError([slot(A, 10), slot(B, 0), slot("", 1, true)]), null);
  assert.match(adapter.mossLoraValidationError(Array.from({ length: 7 }, () => slot(A))), /6/);
  assert.match(adapter.mossLoraValidationError([slot(A, 10.5)]), /Moss LoRA 1 权重/);
  assert.match(adapter.mossLoraValidationError([slot(A), slot(B, -1)]), /Moss LoRA 2 权重/);
  assert.match(adapter.mossLoraValidationError([slot("", 1, false)]), /Moss LoRA 1/);
});

test("the node's own Moss model wins over the settings default; Krea2 still uses the default", () => {
  const sft = "Moss\\moss-image-sft-dit-int8-convrot.safetensors";
  assert.equal(adapter.effectiveImageModelName({ mossModelName: sft }, moss), sft);
  assert.equal(adapter.effectiveImageModelName({}, moss), "Moss\\pornmasterMoss_v1.safetensors");
  assert.equal(adapter.effectiveImageModelName({ mossModelName: "Krea2\\x.safetensors" }, moss), "Moss\\pornmasterMoss_v1.safetensors");
  assert.equal(adapter.effectiveImageModelName({ mossModelName: sft }, krea2), "Krea2\\base.safetensors");
  assert.equal(adapter.effectiveImageModelName({}, module("bad", "moss-text-to-image-v1", "image-generation", "Krea2\\x")), "");
  assert.equal(adapter.effectiveImageModelName({}, undefined), "");
});

test("switching to Krea2 hides the Moss settings without losing them; back on Moss they return", () => {
  const mossContent = { workflowModuleId: "moss", steps: 25, imageLoraName: "", upscaleEnabled: false,
    mossLoras: [{ name: A, strength: 0.5, bypassed: false }], mossModelName: "Moss\\moss-image-sft-dit-int8-convrot.safetensors" };
  const toKrea2 = adapter.imageModuleSwitchContent(mossContent, krea2, moss);
  assert.equal(toKrea2.imageLoraName, "");
  assert.deepEqual(toKrea2.mossLoras, mossContent.mossLoras);
  assert.equal(toKrea2.mossModelName, mossContent.mossModelName);
  assert.equal(adapter.effectiveMossLoras(toKrea2, krea2), null);
  assert.equal(adapter.effectiveImageModelName(toKrea2, krea2), "Krea2\\base.safetensors");
  const back = adapter.imageModuleSwitchContent({ ...toKrea2, imageLoraName: "Krea2\\l.safetensors" }, moss, krea2);
  assert.deepEqual(back.mossLoras, mossContent.mossLoras);
  assert.equal(back.mossModelName, mossContent.mossModelName);
  // The Krea2 single LoRA never goes to Moss.
  assert.equal(back.imageLoraName, "");
});

test("the node shows the shared LoRA editor and a Moss model picker for Moss only", () => {
  assert.match(canvas, /imageModuleSupportsMultiLora\(selectedImageWorkflowModule\)/);
  assert.match(canvas, /<StyleLoraEditor[^>]*slots=\{mossLoraSlots\}[^>]*options=\{mossLoraOptions\}/s);
  assert.match(canvas, /mossLoras: slots/);
  assert.match(canvas, /className="image-generation-select image-generation-moss-model-select"/);
  assert.match(canvas, /mossModelName: event\.currentTarget\.value/);
  // No copy of the editor: one component, the H3 call is untouched.
  assert.match(canvas, /<StyleLoraEditor slots=\{styleLoras\} options=\{selectableH3Loras\} hasSecondStage=\{styleLoraSecondaryTargetLabel === "二段"\}/);
  assert.match(editor, /label = "风格 LoRA"/);
  assert.match(editor, /showSecondPass = true/);
  assert.match(editor, /menuLabel = "MiniMax H3 风格 LoRA"/);
});

test("App loads the Moss lists and submits the node's LoRA list and model", () => {
  assert.match(app, /invoke<string\[\]>\("get_comfyui_moss_loras"/);
  assert.match(app, /mossLoraOptions/);
  assert.match(app, /mossModelOptions/);
  assert.match(app, /effectiveImageModelName\(target\.content, selectedImageModule\)/);
  assert.match(app, /const mossLoras = effectiveMossLoras\(target\.content, selectedImageModule\)/);
  assert.match(app, /\.\.\.\(mossLoras \? \{ loras: mossLoras \} : \{\}\)/);
  assert.match(app, /mossLoraValidationError\(/);
});
