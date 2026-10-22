import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const source = await readFile(new URL("../src/video/referenceLimits.ts", import.meta.url), "utf8");
const limits = await import(`data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`);

const module = (audioMax, imageMax = 9, extra = {}) => ({
  id: `m-${audioMax}`,
  capability: "video-generation",
  variant: "reference-to-video",
  deletedAt: null,
  adapter: { inputContract: { imageMax, audioMax } },
  ...extra,
});
const three = limits.referenceLimits(module(3));
const two = limits.referenceLimits(module(2));
const audios = (count) => ({ images: 0, audios: count });

test("limits come from the module's adapter; without a module audio stays at the legacy two", () => {
  assert.deepEqual(three, { images: 9, audios: 3 });
  assert.deepEqual(two, { images: 9, audios: 2 });
  assert.deepEqual(limits.referenceLimits(undefined), { images: 9, audios: 2 });
  assert.deepEqual(limits.referenceLimits({ ...module(3), adapter: {} }), { images: 9, audios: 2 });
});

test("the node's module is its own choice, else the reference slot default; trashed modules do not count", () => {
  const modules = [module(3), module(2), module(3, 9, { id: "gone", deletedAt: "2026-10-01" })];
  const defaults = { "video-generation:reference-to-video": "m-2" };
  assert.equal(limits.referenceModuleFor({ workflowModuleId: "m-3" }, modules, defaults)?.id, "m-3");
  assert.equal(limits.referenceModuleFor({}, modules, defaults)?.id, "m-2");
  assert.equal(limits.referenceModuleFor({ workflowModuleId: "gone" }, modules, defaults), undefined);
});

test("plain node: the third audio connects, the fourth is refused", () => {
  assert.equal(limits.referenceConnectionError(audios(2), ["audio"], three), null);
  assert.equal(limits.referenceConnectionError(audios(3), ["audio"], three), "全能参考最多连接 3 个音频");
});

test("a package still at audioMax=2 refuses the third audio", () => {
  assert.equal(limits.referenceConnectionError(audios(2), ["audio"], two), "全能参考最多连接 2 个音频");
});

test("the tenth image is refused", () => {
  assert.equal(limits.referenceConnectionError({ images: 8, audios: 0 }, ["image"], three), null);
  assert.equal(limits.referenceConnectionError({ images: 9, audios: 0 }, ["image"], three), "全能参考最多连接 9 张图片");
});

test("smart (storyboard) nodes are not limited when connecting", () => {
  const plain = { kind: "video-generation", content: {} };
  const smart = { kind: "video-generation", content: { storyboardReferenceCompiler: true } };
  assert.equal(limits.referenceConnectionLimitApplies(plain, "reference-to-video"), true);
  assert.equal(limits.referenceConnectionLimitApplies(smart, "reference-to-video"), false);
  assert.equal(limits.referenceConnectionLimitApplies(plain, "first-last-frame"), false);
});

const node = (id, mediaKind, selected = false) => ({ id, selected, kind: mediaKind ?? "text", mediaKind });
const into = (...ids) => ids.map((id) => ({ source: id, target: "gen" }));

test("2 connected + 2 selected audios is refused as a whole batch", () => {
  const nodes = [node("a1", "audio"), node("a2", "audio"), node("b1", "audio", true), node("b2", "audio", true)];
  const error = limits.referenceBatchConnectionError("b1", "gen", nodes, into("a1", "a2"), three);
  assert.equal(error, "全能参考最多连接 3 个音频（已连 2 个，这次选了 2 个），整批未连接");
  // 1 + 2 fits.
  assert.equal(limits.referenceBatchConnectionError("b1", "gen", nodes, into("a1"), three), null);
});

test("hovering an already-connected selected source cannot sneak an oversized selection in", () => {
  const nodes = [node("a1", "audio", true), node("a2", "audio"), node("b1", "audio", true), node("b2", "audio", true)];
  assert.match(limits.referenceBatchConnectionError("a1", "gen", nodes, into("a1", "a2"), three), /整批未连接/);
  // An unselected source is a single connection; connectionValidationError judges it.
  assert.equal(limits.referenceBatchConnectionError("a2", "gen", nodes, into("a1"), three), null);
});

test("submission messages carry the real limit", () => {
  assert.equal(limits.referenceSubmitError(audios(3), three, "node"), null);
  assert.equal(limits.referenceSubmitError(audios(4), three, "node"), "当前参考工作流最多支持 3 个音频");
  assert.equal(limits.referenceSubmitError(audios(3), two, "storyboard"), "当前分镜选中了 3 个音频，单次最多 2 个");
  assert.equal(limits.referenceSubmitError({ images: 10, audios: 0 }, three, "node"), "当前参考工作流最多支持 9 张图片");
});

test("connecting, the node check and submission all read the shared limits", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const node = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
  for (const [name, text] of [["App.tsx", app], ["CanvasNode.tsx", node]]) {
    assert.doesNotMatch(text, /最多支持2个音频|单次最多 2 个|单次最多提交 2 个音频|audioCount > 2|audios\.length > 2|audioPaths\.length > 2/, name);
  }
  const hover = app.slice(app.indexOf("const isValidConnection = useCallback("));
  assert.ok(hover.indexOf("referenceBatchError(") < hover.indexOf("connectionValidationError(connection)"), "hover checks the batch first");
  const connect = app.slice(app.indexOf("const connectNodes = useCallback("));
  assert.ok(connect.indexOf("referenceBatchError(") < connect.indexOf("for (const source of sourcesToConnect)"), "batch refused before any edge is created");
  assert.match(app, /referenceConnectionLimitApplies\(target, mode\)/);
  // The V3 source workflow gained LoadAudio 9607; the auto-created module must bind it.
  assert.match(app, /audioNodeIds: \["268", "270", "9607"\]/);
});
