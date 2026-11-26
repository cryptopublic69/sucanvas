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

const {
  EXTERNAL_VIDEO_PROVIDER_IDS,
  buildVideoChannelSelectOptions,
  clampExternalDuration,
  isExternalVideoChannel,
  normalizeVideoExecutionChannel,
  resolveExternalModelSpec,
} = await loadTsModule("../src/providers/catalog.ts");
const { generatedVideoDeletionPaths } = await loadTsModule("../src/web/outputFiles.ts");

test("buildVideoChannelSelectOptions disables Colab when unavailable and keeps all other channels selectable", () => {
  const offlineOptions = buildVideoChannelSelectOptions({
    colabEnabled: true,
    colabAvailable: false,
    colabConfigured: false,
    colabError: "not configured",
  });

  assert.equal(offlineOptions[0].value, "local");
  assert.equal(offlineOptions[0].disabled, undefined);

  const colabOption = offlineOptions.find((item) => item.value === "colab");
  assert.ok(colabOption);
  assert.equal(colabOption.disabled, true);

  for (const id of EXTERNAL_VIDEO_PROVIDER_IDS) {
    const providerOption = offlineOptions.find((item) => item.value === id);
    assert.ok(providerOption, `missing provider option ${id}`);
    assert.notEqual(providerOption.disabled, true);
  }

  const onlineOptions = buildVideoChannelSelectOptions({
    colabEnabled: true,
    colabAvailable: true,
    colabConfigured: true,
    colabStatusLabel: "NVME-24G",
  });
  const colabOnline = onlineOptions.find((item) => item.value === "colab");
  assert.ok(colabOnline);
  assert.equal(colabOnline.disabled, false);
});

test("Seedance 2.0 and 2.5 catalog lookup and duration clamping", () => {
  for (const id of EXTERNAL_VIDEO_PROVIDER_IDS) {
    assert.equal(isExternalVideoChannel(id), true);
    const defaultSpec = resolveExternalModelSpec(id, undefined);
    assert.equal(defaultSpec.series, "2.5");
    assert.equal(clampExternalDuration(2, defaultSpec), defaultSpec.minDuration);
    assert.equal(clampExternalDuration(99, defaultSpec), defaultSpec.maxDuration);
  }
  assert.equal(isExternalVideoChannel("local"), false);
  assert.equal(isExternalVideoChannel("colab"), false);
});

test("normalizeVideoExecutionChannel preserves external providers in web mode and falls back on desktop", () => {
  assert.equal(normalizeVideoExecutionChannel("jimeng-cn", true, true), "jimeng-cn");
  assert.equal(normalizeVideoExecutionChannel("dreamina-jp", true, true), "dreamina-jp");
  assert.equal(normalizeVideoExecutionChannel("libtv", true, true), "libtv");
  assert.equal(normalizeVideoExecutionChannel("lovart", true, true), "lovart");
  assert.equal(normalizeVideoExecutionChannel("colab", false, true), "local");
  assert.equal(normalizeVideoExecutionChannel("libtv", true, false), "local");
});

test("generatedVideoDeletionPaths preserves sucanvas://provider-outputs resource paths", () => {
  const content = {
    assetPath: "sucanvas://provider-outputs/libtv/2026-11-26/clip_1234.mp4",
    filename: "clip_1234.mp4",
    subfolder: "libtv/2026-11-26",
  };
  assert.deepEqual(generatedVideoDeletionPaths("", content), [content.assetPath]);
  assert.deepEqual(generatedVideoDeletionPaths("E:\\ComfyUI\\output", content), [content.assetPath]);
});

test("providers.css keeps channel and external provider dropdown menus above lower controls", async () => {
  const css = await readFile(new URL("../src/providers/providers.css", import.meta.url), "utf8");
  assert.match(css, /\.external-provider-fields\s*\{[\s\S]*order:\s*-6;/);
  assert.match(css, /\.external-provider-fields\s*>\s*\.video-workflow-module-select:has\(\.settings-custom-select-toggle\[aria-expanded="true"\]\)\s*\{[\s\S]*z-index:\s*50;/);
  assert.match(css, /\.kind-video-generation\s+\.video-node-body:has\([^\n]+\)\s*\{[\s\S]*overflow:\s*visible;/);
});

test("SettingsSelect closes other open dropdowns even inside stopPropagation containers", async () => {
  const source = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
  assert.match(source, /window\.addEventListener\("pointerdown",\s*closeOnOutsidePointer,\s*true\)/);
  assert.match(source, /window\.dispatchEvent\(new CustomEvent\("sucanvas:settings-select-open"/);
  assert.match(source, /window\.addEventListener\("sucanvas:settings-select-open",\s*closeOnOtherSelectOpen\)/);
});
