import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadTsModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { webApiUrl } = await loadTsModule("../src/web/urls.ts");
const { generatedVideoDeletionPaths } = await loadTsModule("../src/web/outputFiles.ts");
const {
  loadVideoRegenerationPresets,
  saveVideoRegenerationPresets,
} = await loadTsModule("../src/video/videoRegenerationPresets.ts");
const {
  COLAB_ALLOWED_LORAS,
  COLAB_DEFAULT_SAMPLER,
  COLAB_FALLBACK_SAMPLERS,
  COLAB_PROFILE_MODELS,
  colabGeneratedVideoWorkflowLabel,
  colabPresetNodePatch,
  colabPresetStorageKey,
  colabSamplerFromContent,
  colabSamplerFromValue,
  colabSamplerSelectOptions,
  colabSubmitInputExtras,
  colabWorkflowDefaultSettings,
  isAllowedColabLoraName,
  loadColabVideoPresets,
  normalizeVideoChannel,
  resolveColabProfileForSnapshot,
  saveColabVideoPresets,
} = await loadTsModule("../src/colab/presets.ts");

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

function parseSettings(value) {
  return value && typeof value === "object" ? value : null;
}

test("webApiUrl rewrites /api/comfy-colab origins and preserves relative or unrelated paths", () => {
  assert.equal(
    webApiUrl("http://old-host:1422/api/comfy-colab", "http://old-host:1422", "https://canvas.example"),
    "https://canvas.example/api/comfy-colab",
  );
  assert.equal(
    webApiUrl(
      "http://old-host:1422/api/comfy-colab/view?filename=carrier.png&subfolder=H3&type=output",
      "http://old-host:1422/",
      "https://canvas.example/",
    ),
    "https://canvas.example/api/comfy-colab/view?filename=carrier.png&subfolder=H3&type=output",
  );
  assert.equal(
    webApiUrl(
      "http://old-host:1422/api/resource?resource=sucanvas%3A%2F%2Fcolab-outputs%2Fclip.mp4",
      "http://old-host:1422",
      "https://canvas.example",
    ),
    "https://canvas.example/api/resource?resource=sucanvas%3A%2F%2Fcolab-outputs%2Fclip.mp4",
  );
  assert.equal(
    webApiUrl("http://old-host:1422/api/comfy-other/view", "http://old-host:1422", "https://canvas.example"),
    "http://old-host:1422/api/comfy-other/view",
  );
  assert.equal(
    webApiUrl("https://other.example/api/comfy-colab/view", "http://old-host:1422", "https://canvas.example"),
    "https://other.example/api/comfy-colab/view",
  );
});

test("generatedVideoDeletionPaths returns sucanvas://colab-outputs resource for Colab SS decoded videos", () => {
  const colabContent = {
    filename: "Minimax_H3_SS_00001_ab12cd34.mp4",
    subfolder: "2026-11-22",
    assetPath: "sucanvas://colab-outputs/2026-11-22/Minimax_H3_SS_00001_ab12cd34.mp4",
    videoUrl: "/api/resource?resource=sucanvas%3A%2F%2Fcolab-outputs%2F2026-11-22%2FMinimax_H3_SS_00001_ab12cd34.mp4",
  };
  assert.deepEqual(generatedVideoDeletionPaths("", colabContent), [colabContent.assetPath]);
  assert.deepEqual(generatedVideoDeletionPaths("E:\\ComfyUI\\output", colabContent), [colabContent.assetPath]);

  const localContent = {
    filename: "scene.mp4",
    subfolder: "H3/day1",
    assetPath: "sucanvas-output://H3/day1/scene.mp4",
  };
  assert.deepEqual(
    generatedVideoDeletionPaths("E:\\ComfyUI\\output", localContent),
    ["E:\\ComfyUI\\output\\H3\\day1\\scene.mp4"],
  );
});

test("colab video presets seed workflow defaults and isolate per-model storage from local presets", () => {
  const storage = createMemoryStorage();
  saveVideoRegenerationPresets(storage, {
    presets: [
      {
        id: "local-1",
        name: "Local方案",
        settings: {
          primaryResolutionMegapixels: 1.2,
          primaryUpscaleFactor: 1.5,
          primaryVideoSteps: 8,
          primaryAudioSteps: 10,
          loraStrength: 0.9,
          primaryBrightness: 1,
          primaryContrast: 1,
          primarySaturation: 1,
          styleLoras: [{ name: "MinimaxH3/local-only.safetensors", strength: 0.5, bypassed: false, applyToSecondary: true }],
          diffusionModelName: "MinimaxH3/local-model.safetensors",
        },
      },
    ],
    defaultPresetId: "local-1",
  });

  const dasiwa = loadColabVideoPresets(storage, "dasiwa", parseSettings);
  const cobijada = loadColabVideoPresets(storage, "cobijada", parseSettings);
  assert.equal(dasiwa.presets.length, 1);
  assert.equal(dasiwa.defaultPresetId, "colab-default-dasiwa");
  assert.equal(cobijada.defaultPresetId, "colab-default-cobijada");

  const dSettings = dasiwa.presets[0].settings;
  assert.equal(dSettings.primaryResolutionMegapixels, 0.8);
  assert.equal(dSettings.primaryUpscaleFactor, 1.0);
  assert.equal(dSettings.primaryVideoSteps, 5);
  assert.equal(dSettings.primaryAudioSteps, 5);
  assert.equal(dSettings.loraName, COLAB_ALLOWED_LORAS[0]);
  assert.equal(dSettings.loraStrength, 0.6);
  assert.equal(dSettings.primaryBrightness, 1.0);
  assert.equal(dSettings.primaryContrast, 0.8);
  assert.equal(dSettings.primarySaturation, 1.0);
  assert.equal(dSettings.diffusionModelName, COLAB_PROFILE_MODELS.dasiwa);
  assert.deepEqual(dSettings.styleLoras, [
    { name: COLAB_ALLOWED_LORAS[1], strength: 0.35, bypassed: false, applyToSecondary: false, applyToSecondPass: false },
  ]);
  assert.equal(cobijada.presets[0].settings.diffusionModelName, COLAB_PROFILE_MODELS.cobijada);

  const localLoaded = loadVideoRegenerationPresets(storage, parseSettings);
  assert.equal(localLoaded.presets.length, 1);
  assert.equal(localLoaded.presets[0].name, "Local方案");

  saveColabVideoPresets(storage, "dasiwa", {
    presets: [
      ...dasiwa.presets,
      {
        id: "dasiwa-custom",
        name: "DaSiWa自定义",
        settings: {
          ...colabWorkflowDefaultSettings("dasiwa"),
          diffusionModelName: "MinimaxH3/wrong-local-model.safetensors",
          primaryUpscaleFactor: 2.0,
          primaryVideoSteps: 6,
          primaryAudioSteps: 12,
          loraName: "MinimaxH3/foreign.safetensors",
          styleLoras: [{ name: "MinimaxH3/foreign-style.safetensors", strength: 0.4, bypassed: false, applyToSecondary: true, applyToSecondPass: true }],
        },
      },
    ],
    defaultPresetId: "dasiwa-custom",
  });

  const reloadedDasiwa = loadColabVideoPresets(storage, "dasiwa", parseSettings);
  assert.equal(reloadedDasiwa.defaultPresetId, "dasiwa-custom");
  const sanitized = reloadedDasiwa.presets[1].settings;
  assert.equal(sanitized.diffusionModelName, COLAB_PROFILE_MODELS.dasiwa);
  assert.equal(sanitized.primaryUpscaleFactor, 1.0);
  assert.equal(sanitized.primaryAudioSteps, 6);
  assert.equal(sanitized.loraName, COLAB_ALLOWED_LORAS[0]);
  assert.equal(sanitized.loraBypassed, true);
  assert.deepEqual(sanitized.styleLoras, [
    { name: COLAB_ALLOWED_LORAS[1], strength: 0.4, bypassed: true, applyToSecondary: false, applyToSecondPass: false },
  ]);

  const reloadedCobijada = loadColabVideoPresets(storage, "cobijada", parseSettings);
  assert.equal(reloadedCobijada.presets.length, 1);
  assert.equal(reloadedCobijada.defaultPresetId, "colab-default-cobijada");
  assert.notEqual(colabPresetStorageKey("dasiwa"), colabPresetStorageKey("cobijada"));
});

test("isAllowedColabLoraName and colabPresetNodePatch keep local workflow and secondary settings untouched", () => {
  assert.equal(isAllowedColabLoraName("MinimaxH3\\pika_h3_flex_fl2va_comfy_bf16.safetensors"), true);
  assert.equal(isAllowedColabLoraName("minimaxh3/mysticxxx_mmh3-v1.safetensors"), true);
  assert.equal(isAllowedColabLoraName("MinimaxH3/other.safetensors"), false);
  assert.equal(isAllowedColabLoraName(""), false);

  const nodeContent = {
    workflowModuleId: "local:custom-module",
    generationDiffusionModelOverride: "MinimaxH3/local-model.safetensors",
    generationPrimaryUpscaleFactor: 1.5,
    generationSecondaryResolution: 1.2,
    generationSecondarySchedulerSteps: 10,
    ...colabPresetNodePatch({
      ...colabWorkflowDefaultSettings("cobijada"),
      styleLoras: [{ name: COLAB_ALLOWED_LORAS[1], strength: 0.45, bypassed: false, applyToSecondary: true, applyToSecondPass: true }],
    }),
  };
  assert.equal(nodeContent.workflowModuleId, "local:custom-module");
  assert.equal(nodeContent.generationDiffusionModelOverride, "MinimaxH3/local-model.safetensors");
  assert.equal(nodeContent.generationPrimaryUpscaleFactor, 1.5);
  assert.equal(nodeContent.generationSecondaryResolution, 1.2);
  assert.equal(nodeContent.generationSecondarySchedulerSteps, 10);
  assert.equal(nodeContent.generationPrimaryContrast, 0.8);
  assert.deepEqual(nodeContent.generationStyleLoras, [
    { name: COLAB_ALLOWED_LORAS[1], strength: 0.45, bypassed: false, applyToSecondary: false, applyToSecondPass: false },
  ]);
});

test("disabling colab module cleanly falls back legacy colab nodes to local while keeping labels", () => {
  assert.equal(normalizeVideoChannel("colab", false, true), "local");
  assert.equal(normalizeVideoChannel("colab", true, true), "colab");
  assert.equal(normalizeVideoChannel("colab", true, false), "local");
  assert.equal(normalizeVideoChannel("local", true, true), "local");
  assert.equal(
    resolveColabProfileForSnapshot("cobijada", undefined, null, ""),
    "cobijada",
  );
  assert.equal(
    resolveColabProfileForSnapshot("", COLAB_PROFILE_MODELS.dasiwa, null, "cobijada"),
    "dasiwa",
  );
  assert.equal(
    colabGeneratedVideoWorkflowLabel("colab:minimax-h3-fla-v3-ss", "cobijada"),
    "Colab 专用 · Cobijada (Fla V3.1 1采 SS)",
  );
});

const SYNC_CALLBACK_ARRAY_METHODS = new Set([
  "find", "findIndex", "filter", "map", "some", "every", "reduce", "forEach", "flatMap", "sort",
]);
const SYNC_CALLBACK_REACT_HOOKS = new Set(["useMemo", "useState"]);

function collectBlockConstLetDecls(block, sf) {
  const decls = new Map();
  const addBindingName = (nameNode) => {
    if (ts.isIdentifier(nameNode)) {
      decls.set(nameNode.text, nameNode.getStart(sf));
    } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) {
        if (ts.isBindingElement(el)) addBindingName(el.name);
      }
    }
  };
  for (const stmt of block.statements) {
    if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) {
      for (const decl of stmt.declarationList.declarations) {
        addBindingName(decl.name);
      }
    }
  }
  return decls;
}

function isSynchronousCallback(fnNode) {
  const parent = fnNode.parent;
  if (!ts.isCallExpression(parent)) return false;
  if (ts.isPropertyAccessExpression(parent.expression)) {
    return SYNC_CALLBACK_ARRAY_METHODS.has(parent.expression.name.text);
  }
  if (ts.isIdentifier(parent.expression)) {
    return SYNC_CALLBACK_REACT_HOOKS.has(parent.expression.text);
  }
  return false;
}

function findSynchronousTdzReferences(relativePath, source) {
  const scriptKind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const hits = [];

  const checkBlock = (block) => {
    const decls = collectBlockConstLetDecls(block, sf);
    if (!decls.size) return;
    const visit = (node, inDeferredFn, shadowed) => {
      if (node !== block && ts.isBlock(node)) {
        const innerDecls = collectBlockConstLetDecls(node, sf);
        const nextShadow = new Set(shadowed);
        for (const name of innerDecls.keys()) nextShadow.add(name);
        ts.forEachChild(node, (child) => visit(child, inDeferredFn, nextShadow));
        return;
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isNonValueRef = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || (ts.isPropertyAssignment(parent) && parent.name === node)
          || ts.isTypeReferenceNode(parent)
          || ts.isTypeQueryNode(parent)
          || (ts.isVariableDeclaration(parent) && parent.name === node)
          || (ts.isParameter(parent) && parent.name === node)
          || (ts.isBindingElement(parent) && parent.name === node)
          || (ts.isJsxAttribute(parent) && parent.name === node)
          || (ts.isPropertySignature(parent) && parent.name === node);
        if (!isNonValueRef && !shadowed.has(node.text) && decls.has(node.text)) {
          const declPos = decls.get(node.text);
          if (node.getStart(sf) < declPos && !inDeferredFn) {
            const useLoc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const declLoc = sf.getLineAndCharacterOfPosition(declPos);
            hits.push(`${relativePath}:${useLoc.line + 1}: "${node.text}" used before line ${declLoc.line + 1}`);
          }
        }
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const nextDeferred = isSynchronousCallback(node) ? inDeferredFn : true;
        const nextShadow = new Set(shadowed);
        for (const param of node.parameters) {
          if (ts.isIdentifier(param.name)) nextShadow.add(param.name.text);
        }
        ts.forEachChild(node, (child) => visit(child, nextDeferred, nextShadow));
        return;
      }
      if (ts.isFunctionDeclaration(node)) return;
      ts.forEachChild(node, (child) => visit(child, inDeferredFn, shadowed));
    };
    for (const stmt of block.statements) {
      visit(stmt, false, new Set());
    }
  };

  const walk = (node) => {
    if (ts.isBlock(node)) checkBlock(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return hits;
}

test("canvas and colab modules have no synchronous const/let TDZ references", async () => {
  const files = [
    "../src/CanvasNode.tsx",
    "../src/App.tsx",
    "../src/ComfyStatusIndicators.tsx",
    "../src/settings/GeneralSettingsPanel.tsx",
    "../src/video/VideoRegenerationDialogs.tsx",
    "../src/colab/index.ts",
    "../src/colab/useColabChannel.ts",
    "../src/colab/ColabNodeControls.tsx",
    "../src/colab/ColabSettingsSection.tsx",
    "../src/colab/presets.ts",
    "../src/colab/api.ts",
  ];
  const hits = [];
  for (const relativePath of files) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    hits.push(...findSynchronousTdzReferences(relativePath, source));
  }
  assert.deepEqual(hits, []);
});

test("colab sampler defaults to euler, persists per profile, backfills legacy presets, and builds submit extras", () => {
  assert.equal(COLAB_DEFAULT_SAMPLER, "euler");
  assert.equal(colabSamplerFromValue(undefined), "euler");
  assert.equal(colabSamplerFromValue("  "), "euler");
  assert.equal(colabSamplerFromValue(" lcm "), "lcm");
  assert.equal(colabSamplerFromContent({}), "euler");
  assert.equal(colabSamplerFromContent({ generationColabSampler: "dpmpp_2m" }), "dpmpp_2m");

  const defaultSettings = colabWorkflowDefaultSettings("dasiwa");
  assert.equal(defaultSettings.colabSampler, "euler");

  const storage = createMemoryStorage();
  saveColabVideoPresets(storage, "dasiwa", {
    defaultPresetId: "p-lcm",
    presets: [
      {
        id: "p-lcm",
        name: "DaSiWa LCM",
        settings: { ...colabWorkflowDefaultSettings("dasiwa"), colabSampler: "lcm" },
      },
    ],
  });
  // Legacy preset stored before colabSampler existed backfills to euler without touching other fields.
  storage.setItem(colabPresetStorageKey("cobijada"), JSON.stringify({
    defaultPresetId: "legacy-cbj",
    presets: [
      {
        id: "legacy-cbj",
        name: "Old Cobijada",
        settings: {
          primaryResolutionMegapixels: 0.8,
          primaryUpscaleFactor: 1.0,
          primaryVideoSteps: 5,
          primaryAudioSteps: 5,
          loraName: COLAB_ALLOWED_LORAS[0],
          loraStrength: 0.6,
          loraBypassed: false,
          primaryBrightness: 1,
          primaryContrast: 0.8,
          primarySaturation: 1,
          styleLoras: [],
          diffusionModelName: COLAB_PROFILE_MODELS.cobijada,
        },
      },
    ],
  }));

  const loadedDasiwa = loadColabVideoPresets(storage, "dasiwa", parseSettings);
  assert.equal(loadedDasiwa.presets[0].settings.colabSampler, "lcm");
  const loadedCobijada = loadColabVideoPresets(storage, "cobijada", parseSettings);
  assert.equal(loadedCobijada.presets[0].settings.colabSampler, "euler");

  const patch = colabPresetNodePatch({ ...colabWorkflowDefaultSettings("dasiwa"), colabSampler: "res_multistep" });
  assert.equal(patch.generationColabSampler, "res_multistep");

  assert.deepEqual(colabSubmitInputExtras("local", { colabSampler: "lcm" }), {});
  assert.deepEqual(colabSubmitInputExtras("colab", {}), { colabSampler: "euler" });
  assert.deepEqual(colabSubmitInputExtras("colab", { colabSampler: "lcm" }), { colabSampler: "lcm" });

  const fallbackOpts = colabSamplerSelectOptions([], "custom_sampler");
  assert.equal(fallbackOpts[0].value, "euler");
  assert.equal(fallbackOpts[0].label, "euler（默认）");
  assert.ok(fallbackOpts.some((opt) => opt.value === COLAB_FALLBACK_SAMPLERS[1]));
  assert.ok(fallbackOpts.some((opt) => opt.value === "custom_sampler"));

  const liveOpts = colabSamplerSelectOptions(["lcm", "euler", "uni_pc"], "euler");
  assert.deepEqual(liveOpts.map((opt) => opt.value), ["euler", "lcm", "uni_pc"]);
});
