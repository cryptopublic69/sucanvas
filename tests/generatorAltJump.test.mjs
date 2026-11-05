import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// CANVAS-038: Alt+click on an image or video generator's start button submits nothing, keeps the zoom and
// moves the canvas to that generator's latest result (a running placeholder counts). "Its results" is the
// set the placement rule already uses, from one shared function. The video button's old Alt (open the
// settings) is gone; the text node's Alt into a video generator still opens them (su 11-05, B).
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const canvas = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const results = async () => import(`data:text/javascript;base64,${Buffer.from(compile(
  await readFile(new URL("../src/canvas/generatorResults.ts", import.meta.url), "utf8"),
)).toString("base64")}`);

// Run one real callback from the source without rendering (same harness as webImageGenerationPrompt.test.mjs).
function callback(source, name, env, mode = "web") {
  const file = ts.createSourceFile("test.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let arrow;
  function visit(node) {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name.getText(file) === name) {
      arrow = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(arrow, `Missing callback ${name}`);
  const code = compile(`const run = ${arrow.getText(file).replaceAll("import.meta.env.MODE", JSON.stringify(mode))};`);
  return new Function(...Object.keys(env), `${code}; return run;`)(...Object.values(env));
}
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  return text.slice(from, text.indexOf(end, from + start.length));
};

const node = (id, kind, createdAt, content = {}, extra = {}) => ({ id, kind, createdAt, title: id, content, x: 0, y: 0, width: 420, height: 300, ...extra });
const imageGen = node("gen", "image-generation", "2026-11-05T00:00:00Z");
const videoGen = node("vgen", "video-generation", "2026-11-05T00:00:00Z");

test("an image generator's latest result: newest by creation, running placeholder included, others skipped", async () => {
  const { latestGeneratorResult } = await results();
  const nodes = [
    imageGen,
    node("r1", "generated-image", "2026-11-05T01:00:00Z", { sourceGeneratorId: "gen" }),
    node("r2", "generated-image", "2026-11-05T02:00:00Z", { sourceGeneratorId: "gen", generationPlaceholder: true, status: "running" }),
    node("copy", "generated-image", "2026-11-05T03:00:00Z", { sourceGeneratorId: "gen", generatedImageCopy: true }),
    node("pasted", "generated-image", "2026-11-05T04:00:00Z", { sourceGeneratorId: "gen" }, { source: "clipboard" }),
    node("upscaled", "generated-image", "2026-11-05T05:00:00Z", { sourceGeneratorId: "gen", sourcePreviewId: "r1" }),
    node("other", "generated-image", "2026-11-05T06:00:00Z", { sourceGeneratorId: "elsewhere" }),
    node("video", "generated-video", "2026-11-05T07:00:00Z", { sourceGeneratorId: "gen" }),
  ];
  assert.equal(latestGeneratorResult(imageGen, nodes)?.id, "r2");
  assert.equal(latestGeneratorResult(imageGen, nodes.filter((n) => n.id !== "r2"))?.id, "r1");
  assert.equal(latestGeneratorResult(imageGen, [imageGen, nodes[3], nodes[5], nodes[6]]), null, "nothing of its own");
  assert.equal(latestGeneratorResult(node("t", "text", "2026-11-05T00:00:00Z"), nodes), null, "not a generator");
});

test("a video generator's latest result: its own videos only, not second-pass or upscale previews", async () => {
  const { latestGeneratorResult } = await results();
  const nodes = [
    videoGen,
    node("v1", "generated-video", "2026-11-05T01:00:00Z", { sourceGeneratorId: "vgen" }),
    node("v2", "generated-video", "2026-11-05T02:00:00Z", { sourceGeneratorId: "vgen" }),
    node("second", "generated-video", "2026-11-05T03:00:00Z", { sourceGeneratorId: "vgen", sourcePreviewId: "v1" }),
  ];
  assert.equal(latestGeneratorResult(videoGen, nodes)?.id, "v2");
});

test("the placement rule and the jump use the same result filter", () => {
  const placement = between(canvas, "function generatedPreviewPosition(", "function generatedPreviewPositionBelow(");
  assert.ok(/isGeneratorResult\(node, generator\.id, previewKind\)/.test(placement), "generatedPreviewPosition uses isGeneratorResult");
  assert.ok(/from "\.\/canvas\/generatorResults"/.test(canvas), "CanvasNode imports the shared filter");
  assert.ok(/from "\.\/canvas\/generatorResults"/.test(app), "App imports the shared filter");
});

test("start button: Alt jumps to the latest result and submits nothing; a plain click runs", async () => {
  for (const alt of [true, false]) {
    const calls = [];
    callback(canvas, "executeOrJumpToLatest", {
      id: "gen",
      onJumpToLatestResult: (...args) => calls.push(["jump", ...args]),
    })(alt, async () => { calls.push(["execute"]); });
    await Promise.resolve();
    assert.deepEqual(calls, alt ? [["jump", "gen"]] : [["execute"]], `alt=${alt}`);
  }
});

test("both generator start buttons go through it; the video button's Alt no longer opens the settings", () => {
  const image = between(canvas, "onClick={(event) => executeOrJumpToLatest(event.altKey, checkAndExecuteImage)}", "</button>");
  assert.ok(image.length > 0);
  const videoStart = canvas.indexOf("disabled={batchSubmitting || executionCancelling}");
  assert.ok(videoStart > 0, "video start button found");
  const video = canvas.slice(canvas.indexOf("onClick=", videoStart), canvas.indexOf("</button>", videoStart));
  assert.ok(/executeOrJumpToLatest\(event\.altKey, checkAndExecute\)/.test(video), "video start uses executeOrJumpToLatest");
  assert.ok(!canvas.includes("onConfigureRegenerateVideo(id, true, {})"), "the generator's Alt-to-settings entry is gone");
  // The text node's Alt into a video generator keeps opening the settings (su: B), and the dialog stays.
  assert.ok(canvas.includes("onConfigureRegenerateVideo(targets[0].id, true, { promptNodeId: id })"));
});

test("the jump keeps the zoom, centres the latest result and selects it like the locate feature", async () => {
  const { latestGeneratorResult } = await results();
  const flow = (r, position) => ({ id: r.id, position, width: r.width, height: r.height, data: { record: r } });
  const records = [
    flow(imageGen, { x: 0, y: 0 }),
    flow(node("old", "generated-image", "2026-11-05T01:00:00Z", { sourceGeneratorId: "gen" }), { x: 500, y: 0 }),
    flow(node("new", "generated-image", "2026-11-05T02:00:00Z", { sourceGeneratorId: "gen", generationPlaceholder: true }, { width: 420, height: 785 }), { x: 980, y: 40 }),
  ];
  const calls = [];
  let selected = [];
  const env = (nodes) => ({
    nodesSnapshot: { current: nodes },
    latestGeneratorResult,
    getViewport: () => ({ x: 10, y: 20, zoom: 0.2 }),
    setCenter: (...args) => { calls.push(["center", ...args]); return Promise.resolve(true); },
    setNodes: (update) => { selected = update(nodes).filter((n) => n.selected).map((n) => n.id); },
    flowStore: { setState: () => {} },
    setRelationAnchorId: () => {},
    setNotice: (message) => calls.push(["notice", message]),
    showGlobalNotice: (message) => calls.push(["toast", message]),
    invoke: () => assert.fail("nothing may be submitted"),
  });
  callback(app, "jumpToLatestGeneratedResult", env(records))("gen");
  assert.deepEqual(calls[0], ["center", 980 + 210, 40 + 392.5, { zoom: 0.2, duration: 350 }]);
  assert.deepEqual(selected, ["new"]);
  calls.length = 0;
  callback(app, "jumpToLatestGeneratedResult", env([records[0]]))("gen");
  assert.deepEqual(calls, [["toast", "还没有生成内容"]], "no result: a notice, the canvas doesn't move");
});

// CANVAS-038b (su 11-05, A): a fixed-seed image generator with a run going used to disable ▶ entirely, so
// Alt could not reach the running placeholder. Now only the plain click is blocked there.
test("fixed seed while running: Alt still jumps, a plain click submits nothing", async () => {
  for (const [alt, blocked, expected] of [
    [true, true, [["jump", "gen"]]],
    [false, true, []],
    [false, false, [["execute"]]],
    [true, false, [["jump", "gen"]]],
  ]) {
    const calls = [];
    callback(canvas, "executeOrJumpToLatest", {
      id: "gen",
      onJumpToLatestResult: (...args) => calls.push(["jump", ...args]),
    })(alt, async () => { calls.push(["execute"]); }, blocked);
    await Promise.resolve();
    assert.deepEqual(calls, expected, `alt=${alt} blocked=${blocked}`);
  }
});

test("the image ▶ stays clickable while a fixed-seed run is going, looks unavailable and says Alt still works", () => {
  const start = canvas.indexOf("executeOrJumpToLatest(event.altKey, checkAndExecuteImage");
  assert.ok(start > 0);
  const button = canvas.slice(canvas.lastIndexOf("<button", start), canvas.indexOf(">", start));
  assert.ok(/disabled=\{executionCancelling\}/.test(button), "only cancelling disables the button");
  assert.ok(!/disabled=\{executionCancelling \|\| \(seedMode === "fixed" && executionRunning\)\}/.test(button), "a fixed-seed run no longer disables it");
  assert.ok(/aria-disabled=\{fixedSeedRunning \|\| undefined\}/.test(button), "aria-disabled while a fixed-seed run is going");
  assert.ok(/executeOrJumpToLatest\(event\.altKey, checkAndExecuteImage, fixedSeedRunning\)/.test(button), "the plain click is blocked in that state");
  assert.ok(button.includes("固定种子已有任务正在执行，不能重复排队；Alt＋点击跳到最后一个生成内容"), "the tooltip says Alt still jumps");
  assert.ok(/const fixedSeedRunning = seedMode === "fixed" && executionRunning;/.test(canvas));
  // The video start button is unchanged.
  const videoStart = canvas.indexOf("disabled={batchSubmitting || executionCancelling}");
  assert.ok(/executeOrJumpToLatest\(event\.altKey, checkAndExecute\)/.test(canvas.slice(videoStart, canvas.indexOf("</button>", videoStart))));
});

test("an aria-disabled start button looks like a disabled one (both themes)", async () => {
  const css = await readFile(new URL("../src/App.css", import.meta.url), "utf8");
  assert.ok(/\.video-execute-button:disabled,\s*\.video-execute-button\[aria-disabled="true"\]\s*\{ opacity: \.65; cursor: wait; transform: none; \}/.test(css), "same look as :disabled");
  assert.ok(/\.video-execute-button\[aria-disabled="true"\]:hover \{ background: #6256bd; \}/.test(css), "no hover highlight");
  assert.ok(/:root\[data-theme="light"\] \.video-execute-button\[aria-disabled="true"\]:hover \{ background: #6f61cf; \}/.test(css), "no hover highlight (light)");
});

test("tooltips say what Alt does on both start buttons", () => {
  assert.ok(!canvas.includes("提交一个新的生成任务；Alt＋点击调整生成参数"), "old video tooltip gone");
  const count = canvas.split("Alt＋点击跳到最后一个生成内容").length - 1;
  assert.ok(count >= 2, `the Alt jump is described on the image and the video start button (${count})`);
});
