import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appTsxPath = path.join(repoRoot, "src", "App.tsx");
const canvasNodeTsxPath = path.join(repoRoot, "src", "CanvasNode.tsx");
const bridgeTsPath = path.join(repoRoot, "src", "web", "bridge.ts");

test("App canvas://node-created and canvas://nodes-created preserve server placement for agent and comfyui nodes", () => {
  const source = fs.readFileSync(appTsxPath, "utf8");
  const start = source.indexOf('listen<NodeRecord>("canvas://node-created"');
  assert.notEqual(start, -1, "expected canvas://node-created listener in src/App.tsx");

  const block = source.slice(start, start + 1200);
  assert.match(block, /record\.source === "agent"/);
  assert.match(block, /record\.source === "comfyui-placeholder"/);
  assert.match(block, /record\.source === "comfyui"/);
  assert.match(block, /record\.source === "external-provider-placeholder"/);
  assert.match(block, /if \(activeProjectIdRef\.current === record\.canvasId && !preserveServerPlacement\)/);

  const batchStart = source.indexOf('listen<NodeRecord[]>("canvas://nodes-created"');
  assert.notEqual(batchStart, -1, "expected canvas://nodes-created listener in src/App.tsx");
  const batchBlock = source.slice(batchStart, batchStart + 1200);
  assert.match(batchBlock, /preserveServerBatchPlacement/);
  assert.match(batchBlock, /external-provider-placeholder/);
  assert.match(batchBlock, /&& !preserveServerBatchPlacement/);

  const importStart = source.indexOf("const importMedia = useCallback(");
  assert.notEqual(importStart, -1, "expected importMedia in src/App.tsx");
  const importBlock = source.slice(importStart, importStart + 4500);
  assert.match(importBlock, /const rowY = basePosition\.y;/);
  assert.match(importBlock, /nextX = placement\.position\.x \+ importedNode\.width \+ CANVAS_GRID_SIZE;/);
});

test("Web bridge SSE client sends build assetVersion so stale tabs resync after deploy", () => {
  const source = fs.readFileSync(bridgeTsPath, "utf8");
  assert.match(source, /__SUCANVAS_WEB_ASSET_VERSION__/);
  assert.match(source, /\/api\/events\?assetVersion=/);
});

test("CanvasNode generated video info popover prompt heading shows version label only", () => {
  const source = fs.readFileSync(canvasNodeTsxPath, "utf8");
  const start = source.indexOf('<section className="generated-video-prompt-info">');
  assert.notEqual(start, -1, "expected generated-video-prompt-info section in src/CanvasNode.tsx");

  const block = source.slice(start, start + 320);
  assert.match(block, /generatedVideoPromptVersionLabel/);
  assert.doesNotMatch(block, /generatedVideoPromptTitle/);
});

test("CanvasNode generatedPreviewPosition defaults continuationDirection to right and aligns top edge", () => {
  const source = fs.readFileSync(canvasNodeTsxPath, "utf8");
  const start = source.indexOf("function generatedPreviewPosition(");
  assert.notEqual(start, -1, "expected generatedPreviewPosition in src/CanvasNode.tsx");

  const end = source.indexOf("function generatedPreviewPositionBelow(", start);
  const block = source.slice(start, end !== -1 ? end : start + 3000);
  assert.match(block, /continuationDirection:\s*"below"\s*\|\s*"right"\s*=\s*"right"/);
  assert.match(block, /availableXRight\(startX,\s*generator\.y\),\s*y:\s*generator\.y/);
});
