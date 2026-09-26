import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const importSource = (source) => import(`data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`);
const { loadVideoRegenerationPresets: load, saveVideoRegenerationPresets: save, matchingVideoRegenerationPreset: match,
  videoPresetNodePatch, videoNodeExtraParameters, videoNodeSecondaryColors } = await importSource(
  await readFile(new URL("../src/video/videoRegenerationPresets.ts", import.meta.url), "utf8"),
);
const style = await importSource(await readFile(new URL("../src/styleLoras.ts", import.meta.url), "utf8"));
const canvas = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
function statement(source, predicate) {
  const ast = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.find(predicate).getText(ast);
}
const config = statement(canvas, (node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((entry) => entry.name.getText() === "VIDEO_REGENERATION_NUMBER_CONFIG"));
const parser = statement(app, (node) => ts.isFunctionDeclaration(node) && node.name.text === "videoRegenerationSettingsFromValue");
const parse = new Function("h3StyleLorasFromContent", "styleLoraValidationError",
  transpile(config + "\n" + parser) + "\nreturn videoRegenerationSettingsFromValue;",
)(style.h3StyleLorasFromContent, style.styleLoraValidationError);
const legacyKey = "infinite-canvas:video-regeneration-settings:v1";
const key = "infinite-canvas:video-regeneration-presets:v1";
const settings = {
  durationSeconds: 8, primaryResolutionMegapixels: 0.4, primaryUpscaleFactor: 1,
  loraStrength: 1, primaryVideoSteps: 20, primaryAudioSteps: 20,
  primaryBrightness: 1, primaryContrast: 1, primarySaturation: 1,
  styleLoras: [], refImageSize: "max",
};
function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

const secondarySettings = {
  secondaryResolutionMegapixels: 1.2, secondarySchedulerSteps: 12,
  secondaryLoraName: "MinimaxH3/secondary.safetensors", secondaryLoraStrength: 0.65, secondaryLoraBypassed: false,
  secondaryBrightness: 1.1, secondaryContrast: 0.85, secondarySaturation: 0.9,
};

test("secondary parameters survive preset reload and apply to node and generation colors", () => {
  const db = storage();
  const full = { ...settings, ...secondarySettings };
  save(db, { presets: [{ id: "both", name: "1采和2采", settings: full }], defaultPresetId: "both" });
  const loaded = load(db, parse);
  assert.deepEqual(loaded.presets[0].settings, full);
  const patch = videoPresetNodePatch(loaded.presets[0].settings, false);
  assert.equal(patch.generationSecondaryResolution, 1.2);
  assert.equal(patch.generationSecondarySchedulerSteps, 12);
  assert.equal(patch.generationSecondaryLoraName, secondarySettings.secondaryLoraName);
  assert.equal(patch.generationSecondaryLoraStrength, 0.65);
  assert.equal(patch.generationSecondaryLoraBypassed, false);
  assert.deepEqual(videoNodeSecondaryColors(patch, secondarySettings), {
    secondaryBrightness: 1.1, secondaryContrast: 0.85, secondarySaturation: 0.9,
  });
  assert.equal(match(loaded, full)?.id, "both");
  for (const [field, changed] of Object.entries({ secondaryResolutionMegapixels: 1.3,
    secondarySchedulerSteps: 13, secondaryLoraName: "other", secondaryLoraStrength: 0.8,
    secondaryLoraBypassed: true, secondaryBrightness: 1.3, secondaryContrast: 1.2, secondarySaturation: 1.1 })) {
    assert.equal(match(loaded, { ...full, [field]: changed }), undefined, field);
  }
});

test("legacy presets leave secondary node parameters unchanged and still match", () => {
  assert.deepEqual(parse(settings), settings);
  assert.equal(Object.keys(videoPresetNodePatch(settings, false)).some((key) => key.startsWith("generationSecondary")), false);
  assert.equal(match({ presets: [{ id: "old", name: "old", settings }], defaultPresetId: "old" },
    { ...settings, ...secondarySettings })?.id, "old");
});

test("invalid secondary preset fields are rejected", () => {
  for (const patch of [{ secondaryResolutionMegapixels: 0.1 }, { secondarySchedulerSteps: 1.5 },
    { secondaryLoraStrength: 11 }, { secondaryLoraName: 123 }, { secondaryLoraBypassed: "false" },
    { secondaryBrightness: 4 }, { secondaryContrast: -1 }, { secondarySaturation: NaN }]) {
    assert.equal(parse({ ...settings, ...patch }), null);
  }
});

test("shared preset updates node generation parameters without changing seed, inputs or workflow", () => {
  const preset = { ...settings, diffusionModelName: "MinimaxH3/model.safetensors",
    primaryAudioSteps: 30, primaryBrightness: 1.2, primaryContrast: 0.8, primarySaturation: 0.7,
    styleLoras: [{ name: "style.safetensors", strength: 0.5, bypassed: false, applyToSecondary: true, applyToSecondPass: false }] };
  const original = { generationSeed: "123", seedMode: "fixed", workflowModuleId: "workflow",
    activeTextInputId: "prompt", generationAspectRatio: "9:16", generationSecondaryResolution: 1.2 };
  const content = { ...original, ...videoPresetNodePatch(preset, false) };
  for (const [key, value] of Object.entries(original)) assert.equal(content[key], value);
  assert.equal(content.generationDuration, preset.durationSeconds);
  assert.equal(content.generationDiffusionModelOverride, preset.diffusionModelName);
  assert.equal(content.generationPrimaryResolution, preset.primaryResolutionMegapixels);
  assert.equal(content.generationPrimaryUpscaleFactor, preset.primaryUpscaleFactor);
  assert.equal(content.generationLoraStrength, preset.loraStrength);
  assert.equal(content.generationRefImageSize, preset.refImageSize);
  assert.deepEqual(videoNodeExtraParameters(content, settings, preset.primaryVideoSteps, false), {
    primaryAudioSteps: 30, primaryBrightness: 1.2, primaryContrast: 0.8, primarySaturation: 0.7,
  });
  content.generationStyleLoras[0].strength = 2;
  assert.equal(preset.styleLoras[0].strength, 0.5);
});

test("shared sampler steps stay synchronized and old presets preserve the node model", () => {
  const patch = videoPresetNodePatch({ ...settings, primaryAudioSteps: 40 }, true);
  assert.equal(patch.generationPrimaryAudioSteps, settings.primaryVideoSteps);
  assert.equal(Object.hasOwn(patch, "generationDiffusionModelOverride"), false);
  assert.equal(videoNodeExtraParameters(patch, settings, 25, true).primaryAudioSteps, 25);
});

test("nodes without preset overrides keep workflow defaults and invalid overrides fall back", () => {
  const defaults = { primaryAudioSteps: 30, primaryBrightness: 1.1, primaryContrast: 0.9, primarySaturation: 0.8 };
  assert.deepEqual(videoNodeExtraParameters({}, defaults, 20, false), defaults);
  assert.deepEqual(videoNodeExtraParameters({ generationPrimaryAudioSteps: -1,
    generationPrimaryBrightness: NaN, generationPrimaryContrast: 4, generationPrimarySaturation: "bad" }, defaults, 20, false), defaults);
});

test("old saved settings migrate into a default preset without saving prompt or seed", () => {
  const db = storage({ [legacyKey]: JSON.stringify({ ...settings, seed: "123", selectedPromptKey: "private" }) });
  const result = load(db, parse);
  assert.equal(result.defaultPresetId, "legacy");
  assert.equal(result.presets.length, 1);
  assert.deepEqual(result.presets[0].settings, settings);
});

test("multiple presets and chosen default survive reload with independent parameters", () => {
  const db = storage();
  const presets = [{ id: "one", name: "快速", settings },
    { id: "two", name: "高质量", settings: { ...settings, primaryVideoSteps: 40, primaryAudioSteps: 40 } }];
  save(db, { presets, defaultPresetId: "two" });
  const loaded = load(db, parse);
  assert.deepEqual(loaded, { presets, defaultPresetId: "two" });
  loaded.presets[1].settings.primaryVideoSteps = 60;
  assert.equal(load(db, parse).presets[1].settings.primaryVideoSteps, 40);
  assert.equal(loaded.presets[0].settings.primaryVideoSteps, 20);
});

test("H3 model selection survives saving and distinguishes otherwise identical presets", () => {
  const db = storage();
  const first = { ...settings, diffusionModelName: "MinimaxH3/model-a.safetensors" };
  const second = { ...settings, diffusionModelName: "MinimaxH3/model-b.safetensors" };
  save(db, { presets: [
    { id: "a", name: "A", settings: first },
    { id: "b", name: "B", settings: second },
  ], defaultPresetId: "a" });
  const loaded = load(db, parse);
  assert.deepEqual(loaded.presets[1].settings, second);
  assert.equal(match(loaded, second)?.id, "b");
});

test("deleting every preset does not resurrect legacy saved settings", () => {
  const db = storage({ [legacyKey]: JSON.stringify(settings) });
  save(db, { presets: [], defaultPresetId: "" });
  assert.deepEqual(load(db, parse), { presets: [], defaultPresetId: "" });
});

test("invalid settings and duplicate IDs are filtered; missing defaults are cleared", () => {
  const db = storage({ [key]: JSON.stringify({ defaultPresetId: "bad", presets: [
    { id: "good", name: "Good", settings },
    { id: "good", name: "Duplicate", settings },
    { id: "bad", name: "Bad", settings: { ...settings, primaryAudioSteps: 1 } },
  ] }) });
  const loaded = load(db, parse);
  assert.equal(loaded.presets.length, 1);
  assert.equal(loaded.defaultPresetId, "");
});

test("storage failure is reported to caller; malformed storage is safe to load", () => {
  assert.throws(() => save({ setItem() { throw new Error("quota"); } }, { presets: [], defaultPresetId: "" }), /quota/);
  assert.deepEqual(load(storage({ [key]: "broken json" }), parse), { presets: [], defaultPresetId: "" });
});


test("snapshot matching identifies equal parameters and prefers matching default", () => {
  const collection = { presets: [
    { id: "one", name: "First", settings },
    { id: "two", name: "Default", settings: { ...settings } },
  ], defaultPresetId: "two" };
  const snapshot = { ...settings, seed: "456", selectedPromptKey: "other" };
  assert.equal(match(collection, parse(snapshot))?.id, "two");
  assert.equal(match({ ...collection, defaultPresetId: "" }, parse(snapshot))?.id, "one");
  assert.equal(snapshot.seed, "456");
  for (const key of Object.keys(settings).filter((key) => typeof settings[key] === "number")) {
    assert.equal(match(collection, { ...settings, [key]: settings[key] + 0.1 }), undefined, key);
  }
  assert.equal(match(collection, { ...settings, refImageSize: "match" }), undefined);
  assert.equal(match(collection, null), undefined);
});

test("snapshot matching compares all style LoRA fields and their order", () => {
  const slot = { name: "MinimaxH3/style.safetensors", strength: 0.7, bypassed: false,
    applyToSecondary: true, applyToSecondPass: false };
  const styled = { ...settings, styleLoras: [slot] };
  const collection = { presets: [{ id: "style", name: "Style", settings: styled }], defaultPresetId: "" };
  assert.equal(match(collection, { ...styled, styleLoras: [{ ...slot }] })?.id, "style");
  for (const key of Object.keys(slot)) {
    const value = typeof slot[key] === "boolean" ? !slot[key]
      : typeof slot[key] === "number" ? 0.8 : "different.safetensors";
    assert.equal(match(collection, { ...styled, styleLoras: [{ ...slot, [key]: value }] }), undefined, key);
  }
  assert.equal(match(collection, settings), undefined);
  assert.equal(match(collection, { ...styled, styleLoras: [slot, slot] }), undefined);
});


test("primary LoRA selection and bypass survive save, reload and node application", () => {
  const full = { ...settings, loraName: "MinimaxH3/primary.safetensors", loraBypassed: false };
  const db = storage();
  save(db, { presets: [{ id: "primary", name: "Primary", settings: full }], defaultPresetId: "primary" });
  const loaded = load(db, parse);
  assert.deepEqual(loaded.presets[0].settings, full);
  const patch = videoPresetNodePatch(loaded.presets[0].settings, false);
  assert.equal(patch.generationLoraName, full.loraName);
  assert.equal(patch.generationLoraBypassed, false);
  assert.equal(match(loaded, full)?.id, "primary");
  assert.equal(match(loaded, { ...full, loraName: "another" }), undefined);
  assert.equal(match(loaded, { ...full, loraBypassed: true }), undefined);
  assert.equal(videoPresetNodePatch({ ...full, loraBypassed: true }, false).generationLoraBypassed, true);
  assert.equal(parse({ ...full, loraName: 123 }), null);
  assert.equal(parse({ ...full, loraBypassed: "false" }), null);
  const legacy = { presets: [{ id: "legacy", name: "Legacy", settings }], defaultPresetId: "legacy" };
  assert.equal(match(legacy, full)?.id, "legacy");
  assert.equal(Object.hasOwn(videoPresetNodePatch(settings, false), "generationLoraName"), false);
  assert.equal(Object.hasOwn(videoPresetNodePatch(settings, false), "generationLoraBypassed"), false);
});
