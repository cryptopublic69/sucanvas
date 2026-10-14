import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const canvas = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const promptSource = await readFile(new URL("../src/web/imageGenerationPrompt.ts", import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { imageRegenerationPrompt } = await import(`data:text/javascript;base64,${Buffer.from(compile(promptSource)).toString("base64")}`);

// Exercise the real callbacks without rendering or automating the UI.
function callback(source, name, env, mode = "web") {
  const file = ts.createSourceFile("test.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let arrow;
  function visit(node) {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name.getText(file) === name) {
      arrow = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.getText(file) === name) arrow = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(arrow, `Missing callback ${name}`);
  const code = compile(`const run = ${arrow.getText(file).replaceAll("import.meta.env.MODE", JSON.stringify(mode))};`);
  return new Function(...Object.keys(env), `${code}; return run;`)(...Object.values(env));
}

const record = (id, kind, content = {}) => ({ id, kind, content, canvasId: "canvas", x: 0, y: 0, width: 420, height: 300 });
const flow = (record) => ({ id: record.id, data: { record } });

test("text start dispatches its own prompt to the connected image generator", async () => {
  const calls = [];
  const run = callback(canvas, "executeConnectedVideo", {
    id: "prompt-a", getEdges: () => [{ source: "prompt-a", target: "generator" }],
    getNode: () => flow(record("generator", "image-generation")),
    onActivateTextInput: (...args) => calls.push(["activate", ...args]),
    onExecuteImage: async (...args) => calls.push(["image", ...args]),
    onExecutionCheck: () => assert.fail("Unexpected validation failure"),
  });
  await run(true);
  assert.deepEqual(calls, [["activate", "generator", "prompt-a"], ["image", "generator", "prompt-a"]]);
});

test("ambiguous connections reject submission and desktop keeps its existing video route", async () => {
  for (const [mode, kinds] of [["web", ["image-generation", "video-generation"]], ["desktop", ["image-generation"]]]) {
    const notices = [];
    const run = callback(canvas, "executeConnectedVideo", {
      id: "text", getEdges: () => kinds.map((_, i) => ({ source: "text", target: String(i) })),
      getNode: (id) => flow(record(id, kinds[Number(id)])),
      onExecutionCheck: (...args) => notices.push(args),
      onExecuteImage: () => assert.fail("Unexpected image submission"),
    }, mode);
    await run();
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], false);
  }
});

function imageExecutionEnvironment() {
  const generator = record("generator", "image-generation", {
    workflowModuleId: "image", activeTextInputId: "prompt-b", negativePrompt: "current negative",
  });
  const submitted = [], completed = [], saved = [], errors = [];
  const noop = () => {};
  const env = {
    nodesSnapshot: { current: [generator, record("prompt-a", "text", { text: "prompt A" }),
      record("prompt-b", "text", { text: "prompt B" })].map(flow) },
    edgesSnapshot: { current: ["prompt-a", "prompt-b"].map((source) => ({ source, target: "generator" })) },
    flushNodePatches: async (ids) => saved.push(ids), recordAtCurrentFlowPosition: (node) => node.data.record,
    workflowModuleDefaults: {}, workflowModules: [{ id: "image", capability: "image-generation", defaults: {} }],
    isKrea2DiffusionModelName: () => false, orderedNodeRecordsFromContent: (_, __, inputs) => inputs,
    videoInputMediaKind: () => null,
    activeTextInputFromContent: (content, inputs) => inputs.find((input) => input.id === content.activeTextInputId) ?? null,
    isContentIterationContent: () => false, activePromptVersionFromContent: () => null,
    textFromContent: (content) => content.text,
    imageRecoveryGenerationSnapshot: (imageRecovery) => ({ imageRecovery }),
    createImageGenerationPlaceholder: async () => record("placeholder", "generated-image"),
    ownedComfyClients: { current: new Set() }, cancelledComfyClients: { current: new Set() },
    runningComfyClients: { current: new Map() },
    rememberComfyTask: noop, registerComfyTask: noop, changeNode: noop, setNotice: noop,
    openComfyProgressSocket: async () => null, comfyUiServerUrlRef: { current: "http://comfy" },
    updateGenerationPlaceholder: noop, comfyOutputRootRef: { current: "" }, mappedComfyOutputPath: () => "",
    invoke: async (command, { input }) => {
      assert.equal(command, "submit_comfyui_image_workflow");
      submitted.push(input);
      return { outputs: [{ filename: "result.png", url: "http://comfy/result.png" }], seed: "123" };
    },
    validExecutionElapsedSeconds: () => null,
    completeGenerationPlaceholder: async (_, __, content) => completed.push(content),
    finalizeGenerationPlaceholder: noop, reportError: (error) => errors.push(error),
    forgetComfyTask: noop, unregisterComfyTask: noop,
  };
  return { env, submitted, completed, saved, errors };
}

test("image submission uses the clicked text even when another text was active", async () => {
  const { env, submitted, completed, saved, errors } = imageExecutionEnvironment();
  await callback(app, "executeImageNode", env)("generator", undefined, { kind: "text", promptNodeId: "prompt-a" });
  assert.deepEqual(errors, []);
  assert.equal(submitted[0].prompt, "prompt A");
  assert.equal(completed[0].promptSourceNodeId, "prompt-a");
  assert.deepEqual(saved[0], ["generator", "prompt-a", "prompt-b"]);
});

test("regeneration submits and records the exact historical prompts despite changed or deleted texts", async () => {
  const { env, submitted, completed, errors } = imageExecutionEnvironment();
  env.nodesSnapshot.current = env.nodesSnapshot.current.filter((node) => node.id === "generator");
  const request = imageRegenerationPrompt({
    generationPrompt: " original\nscene ", generationNegativePrompt: "original negative", promptSourceNodeId: "deleted-text",
  });
  await callback(app, "executeImageNode", env)("generator", undefined, request);
  assert.deepEqual(errors, []);
  assert.equal(submitted[0].prompt, " original\nscene ");
  assert.equal(submitted[0].negativePrompt, "original negative");
  assert.equal(completed[0].generationPrompt, request.prompt);
  assert.equal(completed[0].promptSourceNodeId, "deleted-text");
});

test("missing historical prompt cannot silently regenerate with current text", async () => {
  const notices = [];
  const generator = record("generator", "image-generation");
  const preview = record("preview", "generated-image", { sourceGeneratorId: "generator" });
  const env = {
    nodesSnapshot: { current: [generator, preview].map(flow) }, imageRegenerationPrompt,
    setNotice: (message) => notices.push(message),
    executeImageNodeRef: { current: () => assert.fail("Unexpected submission") },
  };
  await callback(app, "regenerateGeneratedImage", env)("preview");
  assert.match(notices[0], /未记录原始提示词/);
});

test("regeneration route passes preview snapshot and preserves result placement", async () => {
  const calls = [];
  const preview = record("preview", "generated-image", {
    sourceGeneratorId: "generator", generationPrompt: "historical", generationNegativePrompt: "",
  });
  await callback(app, "regenerateGeneratedImage", {
    nodesSnapshot: { current: [record("generator", "image-generation"), preview].map(flow) },
    imageRegenerationPrompt, setNotice: () => assert.fail("Unexpected notice"),
    executeImageNodeRef: { current: async (...args) => calls.push(args) },
  })("preview");
  assert.deepEqual(calls, [["generator", "preview", imageRegenerationPrompt(preview.content)]]);
});

test("recovered image records use their saved recovery prompt and missing records reject", () => {
  assert.deepEqual(imageRegenerationPrompt({ generationSnapshot: { imageRecovery: {
    prompt: "recovered", negativePrompt: "negative", promptSourceNodeId: "text",
  } } }), { kind: "snapshot", prompt: "recovered", negativePrompt: "negative", promptSourceNodeId: "text" });
  assert.equal(imageRegenerationPrompt({}), null);
  assert.equal(imageRegenerationPrompt({ generationPrompt: "  " }), null);
});

test("only the Web text shortcut forwards the text as the placement source", async () => {
  for (const mode of ["web", "desktop"]) {
    const calls = [];
    await callback(app, "onExecuteImage", {
      executeImageNodeRef: { current: async (...args) => calls.push(args) },
    }, mode)("generator", "prompt-a");
    assert.equal(calls[0][0], "generator");
    assert.equal(calls[0][1], mode === "web" ? "prompt-a" : undefined);
    assert.deepEqual(calls[0][2], mode === "web" ? { kind: "text", promptNodeId: "prompt-a" } : undefined);
  }
});

test("Web text-generated images share the video placement rule and keep generator output edges", async () => {
  const { env, errors } = imageExecutionEnvironment();
  const prompt = env.nodesSnapshot.current.find((node) => node.id === "prompt-a").data.record;
  Object.assign(prompt, { x: 900, y: 100, height: 300 });
  const blocker = record("blocker", "image");
  Object.assign(blocker, { x: 900, y: 420, height: 250 });
  env.nodesSnapshot.current.push(flow(blocker));
  const nodes = [], edges = [];
  Object.assign(env, {
    GENERATED_IMAGE_CHROME_HEIGHT: 60,
    incomingPlacementReservations: { current: [] },
    completedGenerationPlaceholders: { current: new Set() },
    generatedPreviewPositionBelow: callback(canvas, "generatedPreviewPositionBelow", { CANVAS_GRID_SIZE: 40 }),
    generatedPreviewPosition: () => assert.fail("Expected placement below the clicked text"),
    appendUniqueById: (current, additions) => [...current, ...additions.filter((item) => !current.some((entry) => entry.id === item.id))],
    makeFlowNodeRef: { current: flow }, makeFlowNode: flow, toFlowEdge: (edge) => edge,
    setNodes: (update) => { env.nodesSnapshot.current = update(env.nodesSnapshot.current); },
    setEdges: () => {}, window: { setTimeout: () => {} },
    invoke: async (command, { input }) => {
      if (command === "create_node") {
        const node = { ...record(`image-${nodes.length}`, input.kind, input.content), ...input };
        nodes.push(node);
        return { node };
      }
      if (command === "create_edge") { const edge = { id: `edge-${edges.length}`, ...input }; edges.push(edge); return edge; }
      assert.equal(command, "submit_comfyui_image_workflow");
      return { outputs: [1, 2, 3].map((n) => ({ filename: `${n}.png`, url: `http://comfy/${n}.png` })), seed: "123" };
    },
  });
  env.createImageGenerationPlaceholder = callback(app, "createImageGenerationPlaceholder", env);
  await callback(app, "executeImageNode", env)("generator", "prompt-a", { kind: "text", promptNodeId: "prompt-a" });
  assert.deepEqual(errors, []);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].x, prompt.x);
  assert.equal(nodes[0].y, blocker.y + blocker.height + 20);
  for (let n = 1; n < nodes.length; n++) {
    assert.equal(nodes[n].x, prompt.x);
    assert.equal(nodes[n].y, nodes[n - 1].y + nodes[n - 1].height + 20);
  }
  assert.deepEqual(edges.map((edge) => edge.sourceNodeId), ["generator", "generator", "generator"]);
});
