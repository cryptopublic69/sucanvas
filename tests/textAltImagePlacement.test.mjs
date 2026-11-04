import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// CANVAS-037: the text node's ▶ connected to an image generator. A plain click keeps placing the result
// below the text; Alt+click places it like the generator's own ▶ (right of the generator, continuing
// right). The prompt source is the text node either way: "where the result goes" and "which text is the
// prompt" are two separate fields of the image request, not one argument doing both jobs.
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const canvas = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;

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

const record = (id, kind) => ({ id, kind, content: {}, canvasId: "canvas", x: 0, y: 0, width: 420, height: 300 });
const flow = (r) => ({ id: r.id, data: { record: r } });
const textStart = (targetKinds, extra = {}) => {
  const calls = [];
  const run = callback(canvas, "executeConnectedVideo", {
    id: "prompt-a",
    getEdges: () => targetKinds.map((_, i) => ({ source: "prompt-a", target: `g${i}` })),
    getNode: (id) => flow(record(id, targetKinds[Number(id.slice(1))])),
    onActivateTextInput: (...args) => calls.push(["activate", ...args]),
    onExecuteImage: async (...args) => calls.push(["image", ...args]),
    onConfigureRegenerateVideo: (...args) => calls.push(["configure", ...args]),
    checkAndExecuteVideo: async (data, options) => calls.push(["video", data.record.id, options]),
    onExecutionCheck: (...args) => calls.push(["check", ...args]),
    ...extra,
  });
  return { run, calls };
};

test("plain click on an image generator: prompt and placement are both the text node (unchanged)", async () => {
  const { run, calls } = textStart(["image-generation"]);
  await run(false);
  assert.deepEqual(calls, [
    ["activate", "g0", "prompt-a"],
    ["image", "g0", { promptNodeId: "prompt-a", placementSourceId: "prompt-a" }],
  ]);
});

test("Alt+click on an image generator: the prompt is still the text node, no placement source", async () => {
  const { run, calls } = textStart(["image-generation"]);
  await run(true);
  assert.deepEqual(calls, [["activate", "g0", "prompt-a"], ["image", "g0", { promptNodeId: "prompt-a" }]]);
  assert.ok(!("placementSourceId" in calls[1][2]), "no placement source key at all");
});

test("a video generator keeps its routes: Alt opens the settings, a plain click runs below the text", async () => {
  const alt = textStart(["video-generation"]);
  await alt.run(true);
  assert.deepEqual(alt.calls, [["configure", "g0", true, { promptNodeId: "prompt-a" }]]);
  const plain = textStart(["video-generation"]);
  await plain.run(false);
  assert.deepEqual(plain.calls, [["video", "g0", { placementSourceNodeId: "prompt-a" }]]);
});

test("two connected generators: the same error for a plain and an Alt click, nothing submitted", async () => {
  for (const alt of [false, true]) {
    const { run, calls } = textStart(["image-generation", "image-generation"]);
    await run(alt);
    assert.deepEqual(calls, [["check", "当前文本连接了多个生成节点，请只保留一个后再开始", false]], `alt=${alt}`);
  }
});

test("App maps the request: prompt source and placement source travel separately (Web); desktop ignores both", async () => {
  const cases = [
    [{ promptNodeId: "t", placementSourceId: "t" }, ["g", "t", { kind: "text", promptNodeId: "t" }]],
    [{ promptNodeId: "t" }, ["g", undefined, { kind: "text", promptNodeId: "t" }]],
    [undefined, ["g", undefined, undefined]],
  ];
  for (const [request, expected] of cases) {
    const calls = [];
    await callback(app, "onExecuteImage", { executeImageNodeRef: { current: async (...args) => calls.push(args) } })("g", request);
    assert.deepEqual(calls, [expected], JSON.stringify(request));
    const desktop = [];
    await callback(app, "onExecuteImage", { executeImageNodeRef: { current: async (...args) => desktop.push(args) } }, "desktop")("g", request);
    assert.deepEqual(desktop, [["g", undefined, undefined]], `desktop ${JSON.stringify(request)}`);
  }
});

test("the text ▶ explains the image Alt placement", () => {
  const start = canvas.indexOf("void executeConnectedVideo(event.altKey);");
  assert.ok(start > 0);
  const button = canvas.slice(start, canvas.indexOf("</button>", start));
  assert.ok(button.includes("图片：Alt＋点击时新结果放在生成节点旁"), "title mentions the image Alt placement");
});
