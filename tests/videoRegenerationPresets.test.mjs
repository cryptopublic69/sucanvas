import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const importSource = (source) => import(`data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`);
const { loadVideoRegenerationPresets: load, saveVideoRegenerationPresets: save, matchingVideoRegenerationPreset: match } = await importSource(
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
