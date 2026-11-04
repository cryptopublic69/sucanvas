import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// CANVAS-032: source checks. The LoRA reading lives in src/workflow (so the Rust generic-files
// gate scans it for workflow names and node ids), names no control id, shares the LoRA-group
// test with the old-node converter, and the image info panel shows its result.
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the LoRA reading names no control id and uses the shared LoRA-group test", async () => {
  const info = await source("src/workflow/loraInfo.ts");
  for (const id of ["loras", "on", "weight", "enabled", "strength_model", "lora_name"]) {
    assert.ok(!new RegExp(`["'\`]${id}["'\`]`).test(info), `loraInfo.ts names the control id ${id}`);
  }
  assert.ok(/isNamedRepeatGroup\(/.test(info), "info matches /isNamedRepeatGroup\(/");
  const pkg = await source("src/workflow/workflowPackage.ts");
  assert.ok(/export function isNamedRepeatGroup\(/.test(pkg), "pkg matches /export function isNamedRepeatGroup\(/");
});

test("the old-node converter uses the same LoRA-group test (its own id condition kept)", async () => {
  const legacy = await source("src/workflow/legacyImageNode.ts");
  const start = legacy.indexOf("function loraGroup(");
  const body = legacy.slice(start, legacy.indexOf("\n}", start));
  assert.ok(/isNamedRepeatGroup\(control\)/.test(body), "body matches /isNamedRepeatGroup\(control\)/");
});

test("the image info panel lists the LoRA group through LoraNameWithStrength, 无 when none", async () => {
  const node = await source("src/CanvasNode.tsx");
  assert.ok(/generatedImageLoras\(\s*record\.content,/.test(node), "node matches /generatedImageLoras\(\s*record\.content,/");
  assert.ok(!node.includes('{generatedImageLoraName || "—"}'), "the panel no longer prints only the old field");
  const start = node.indexOf("<dt>LoRA</dt>", node.indexOf('{isImageUpscalePreview ? "图片放大" : "图片生成"}'));
  assert.ok(start > 0, "the image panel's LoRA row exists");
  const row = node.slice(start, node.indexOf("</dd>", node.indexOf("<dd", start)) + 5);
  assert.ok(/<LoraNameWithStrength/.test(row), "row matches /<LoraNameWithStrength/");
  assert.ok(/"无"/.test(row), "the row says 无 when nothing took effect");
  assert.ok(/"未记录"/.test(row), "the row says 未记录 when it cannot be known");
});
