import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appTsxPath = path.join(repoRoot, "src", "App.tsx");
const canvasNodeTsxPath = path.join(repoRoot, "src", "CanvasNode.tsx");

test("App canvas://node-created preserves server placement for agent and comfyui nodes", () => {
  const source = fs.readFileSync(appTsxPath, "utf8");
  const start = source.indexOf('listen<NodeRecord>("canvas://node-created"');
  assert.notEqual(start, -1, "expected canvas://node-created listener in src/App.tsx");

  const block = source.slice(start, start + 1200);
  assert.match(block, /record\.source === "agent"/);
  assert.match(block, /record\.source === "comfyui-placeholder"/);
  assert.match(block, /record\.source === "comfyui"/);
  assert.match(block, /if \(activeProjectIdRef\.current === record\.canvasId && !preserveServerPlacement\)/);
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
