import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const badgeSource = await readFile(new URL("../src/canvas/CanvasIdBadge.tsx", import.meta.url), "utf8");
const projectHomeSource = await readFile(new URL("../src/projects/ProjectHome.tsx", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../src/App.css", import.meta.url), "utf8");

function loadCopyHelper() {
  // Compile CanvasIdBadge without JSX/React imports to execute copyCanvasIdText directly in Node.
  const stripped = badgeSource
    .replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, "")
    .replace(/export function CanvasIdBadge[\s\S]*$/, "");
  const compiled = ts.transpileModule(stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  const fn = new Function("exports", "module", compiled);
  fn(mod.exports, mod);
  return mod.exports.copyCanvasIdText;
}

test("copyCanvasIdText uses navigator.clipboard, falls back to execCommand, and reports manual fallback", async () => {
  const copyCanvasIdText = loadCopyHelper();

  const copiedTexts = [];
  const res1 = await copyCanvasIdText("canvas:alpha", {
    writeClipboardText: async (text) => {
      copiedTexts.push(text);
    },
    execCopyCommand: () => {
      throw new Error("should not call execCommand when clipboard succeeds");
    },
  });
  assert.deepEqual(res1, { ok: true, method: "clipboard" });
  assert.deepEqual(copiedTexts, ["canvas:alpha"]);

  const execTexts = [];
  const res2 = await copyCanvasIdText("canvas:lan", {
    writeClipboardText: async () => {
      throw new Error("NotAllowedError on HTTP origin");
    },
    execCopyCommand: (text) => {
      execTexts.push(text);
      return true;
    },
  });
  assert.deepEqual(res2, { ok: true, method: "execCommand" });
  assert.deepEqual(execTexts, ["canvas:lan"]);

  const res3 = await copyCanvasIdText("canvas:locked", {
    writeClipboardText: async () => {
      throw new Error("denied");
    },
    execCopyCommand: () => false,
  });
  assert.deepEqual(res3, { ok: false, method: "manual" });
});

test("CanvasIdBadge is wired into ProjectHome cards and open canvas header with safe SVG CSS", () => {
  assert.match(projectHomeSource, /<CanvasIdBadge\s+canvasId=\{project\.canvas\.id\}\s+variant="card"/);
  assert.match(appSource, /<CanvasIdBadge[\s\S]*canvasId=\{activeProjectId\}[\s\S]*variant="header"/);
  assert.match(badgeSource, /event\.stopPropagation\(\)/);
  assert.match(badgeSource, /event\.preventDefault\(\)/);
  // Direct child selector prevents thumbnail SVG rules from stretching the Info/Check icon.
  assert.match(cssSource, /\.project-thumbnail\s*>\s*svg\s*\{/);
  assert.doesNotMatch(cssSource, /\.project-thumbnail\s+svg\s*\{/);
  assert.match(cssSource, /\.canvas-id-info-button\s+svg\s*\{[^}]*position:\s*static/);
});
