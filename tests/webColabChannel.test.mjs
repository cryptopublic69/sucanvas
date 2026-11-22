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
  COLAB_PROFILE_MODELS,
  colabGeneratedVideoWorkflowLabel,
  colabPresetNodePatch,
  colabPresetStorageKey,
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
