import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-025b: real layout in a headless browser (the app's own CSS) at node widths 420 / 320 / 260
// (260 = the narrowest a node can be) and both font sizes:
// - width, ⇄ and height stay on one line inside the node, their values not cut off;
// - nothing in the controls is wider than the node (a long prompt line must not widen them);
// - 「随机」「固定」 are each one line of text, in the image node and in the video node.
// The controls are WorkflowControls' own markup; the prompt card and the two seed rows are written
// with CanvasNode's class names (checked below to still be the ones CanvasNode uses).
const BROWSERS = [
  process.env.SUCANVAS_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);
const browser = BROWSERS.find((file) => fs.existsSync(file));
const root = new URL("../", import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, root), "utf8");
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

test("CanvasNode still uses the class names this layout test builds its prompt card and seed rows with", () => {
  const source = read("src/CanvasNode.tsx");
  for (const name of [
    "video-seed-control image-generation-seed-control", "image-generation-seed-primary", "video-seed-mode", "video-seed-fixed",
    "video-seed-input", "video-seed-randomize", "video-seed-hint", "video-input-group is-text image-prompt-input-group",
    "video-input-list image-prompt-input-list", "video-input-item is-text-input", "video-input-copy", "video-text-input-preview",
    "nodrag video-node-body has-media image-generation-node-body workflow-node-body",
  ]) assert.ok(source.includes(name), name);
});

const seedRow = (image, mode) => {
  const buttons = `<div class="video-seed-mode"><button type="button" class="${mode === "random" ? "is-active" : ""}">随机</button><button type="button" class="${mode === "fixed" ? "is-active" : ""}">固定</button></div>`;
  const right = mode === "fixed"
    ? `<div class="video-seed-fixed"><input class="video-seed-input" type="text" value="123456789012345"><button type="button" class="video-seed-randomize">◇</button></div>`
    : `<span class="video-seed-hint">每次生成自动更换</span>`;
  return image
    ? `<div class="video-seed-control image-generation-seed-control"><div class="image-generation-seed-primary"><span>生成种子</span>${buttons}</div>${right}</div>`
    : `<div class="video-seed-control"><span>生成种子</span>${buttons}${right}</div>`;
};
const PROMPT = "a young woman in a red raincoat standing on a rainy city street at night, cinematic photo, 35mm, shallow depth of field";
const promptCard = `<section class="video-input-group is-text image-prompt-input-group"><div class="video-input-group-heading"><strong>提示词</strong><span>1</span></div>`
  + `<ol class="video-input-list image-prompt-input-list"><li class="video-input-item is-text-input is-active-text"><span class="video-input-index">1</span><span class="video-input-preview is-text"></span>`
  + `<span class="video-input-copy"><strong>提示词</strong><span class="video-text-input-preview">${escape(PROMPT)}</span></span><button type="button" class="nodrag video-input-expand">⤢</button><button type="button" class="nodrag video-input-remove">✕</button></li></ol></section>`;

async function page(widths) {
  const controls = await loadWorkflowModule("WorkflowControls");
  const adapter = await readJson("workflow-packages/image-v2/5dd20ec7/adapter.json");
  const operation = adapter.operations.generate;
  const loras = operation.controls.find((control) => control.type === "repeat");
  const files = ["moss\\KOOK-MOSS-SFT-observation-long-name.safetensors", "moss\\moss_detail_lora_v2.0.safetensors"];
  const values = { [loras.id]: [{ name: files[0], weight: 0.8 }, { name: files[1], weight: 0.6, on: false }, { name: files[0], weight: 1.2 }] };
  const markup = renderToStaticMarkup(createElement(controls.WorkflowControls, {
    operation, values, choicesFor: () => ({ status: "ready", values: files }), onChange: () => {},
    before: { controlId: "negativePrompt", content: createElement("div", { dangerouslySetInnerHTML: { __html: promptCard }, style: { display: "contents" } }) },
  }));
  const nodes = widths.flatMap((width) => ["random", "fixed"].map((mode) => (
    `<div class="canvas-node kind-image-generation" data-case="image/${width}/${mode}" style="width:${width}px">`
    + `<div class="nodrag video-node-body has-media image-generation-node-body workflow-node-body">${seedRow(true, mode)}${markup}</div></div>`
    + `<div class="canvas-node kind-video-generation" data-case="video/${width}/${mode}" style="width:${width}px"><div class="nodrag video-node-body has-media">${seedRow(false, mode)}</div></div>`
  ))).join("");
  const css = read("node_modules/@xyflow/react/dist/style.css") + "\n" + read("src/App.css");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>body{margin:0;display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;width:4000px}.canvas-node{position:relative;height:auto}</style></head><body>${nodes}</body></html>`;
}

const MEASURE = `(() => {
  const box = (e) => e.getBoundingClientRect();
  const lines = (e) => { const t = [...e.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim()); const r = document.createRange(); r.selectNodeContents(t); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; };
  return [...document.querySelectorAll('[data-case]')].map((n) => {
    const out = { case: n.dataset.case, right: Math.round(box(n).right) };
    out.seedButtons = [...n.querySelectorAll('.video-seed-mode button')].map((b) => ({ text: b.textContent, lines: lines(b), clipped: b.scrollWidth > b.clientWidth + 1, right: Math.round(box(b).right) }));
    const w = n.querySelector('input[aria-label="宽度"]'), swap = n.querySelector('.image-generation-swap-size'), h = n.querySelector('input[aria-label="高度"]');
    if (w) {
      const [a, s, b] = [w, swap, h].map(box);
      const overlap = (x, y) => Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 0;
      // The value plus the number input's own spin button must fit: scrollWidth counts both.
      const clipped = (input) => input.scrollWidth > input.clientWidth;
      out.size = { oneLine: overlap(a, s) && overlap(s, b) && overlap(a, b), right: Math.round(Math.max(a.right, s.right, b.right)), tops: [a, s, b].map((r) => Math.round(r.top)),
        clippedValues: [w, h].filter(clipped).map((input) => input.getAttribute('aria-label') + '=' + input.value + ' (' + input.scrollWidth + '>' + input.clientWidth + ')') };
      const c = n.querySelector('.workflow-controls');
      out.controls = { right: Math.round(box(c).right), widest: Math.round(Math.max(...[...c.querySelectorAll('*')].map((e) => box(e).right))) };
    }
    return out;
  });
})()`;

/** Measurements per font size ("" = default), one browser for all. */
async function measure(html, fontSizes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c025b-layout-"));
  const file = path.join(dir, "page.html");
  fs.writeFileSync(file, html);
  const port = await new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(browser, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, "profile")}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=4200,3000", "about:blank"], { stdio: "ignore" });
  try {
    let target;
    for (let i = 0; i < 150 && !target; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    }
    assert.ok(target, "browser did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0; const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send("Page.enable");
    await send("Page.navigate", { url: `file:///${file.replace(/\\/g, "/")}` });
    for (let i = 0; i < 100 && (await evaluate("document.readyState")) !== "complete"; i++) await new Promise((r) => setTimeout(r, 50));
    await evaluate("document.fonts.ready.then(() => true)");
    const result = {};
    for (const fontSize of fontSizes) {
      await evaluate(`(() => { if (${JSON.stringify(fontSize)}) document.documentElement.dataset.fontSize = ${JSON.stringify(fontSize)}; else delete document.documentElement.dataset.fontSize; return document.body.offsetHeight; })()`);
      result[fontSize] = await evaluate(MEASURE);
    }
    ws.close();
    return result;
  } finally {
    // Ask the browser to quit (its helper processes are not children of the one started here), then make
    // sure nothing that uses this profile is left, then remove the folder.
    const exited = new Promise((r) => child.once("exit", r));
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const socket = new WebSocket(webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (process.platform === "win32") {
      const left = spawnSync("powershell", ["-NoProfile", "-Command",
        `$p = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(dir)}*' }); $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count`], { encoding: "utf8" });
      if (Number(left.stdout.trim()) > 0) console.warn(`layout test: ended ${left.stdout.trim()} browser processes left after Browser.close`);
    } else child.kill();
    // Its files stay locked for a moment after the processes end.
    for (let attempt = 0; ; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (error) {
        if (attempt >= 40) { console.warn(`layout test: could not remove ${dir}: ${error.code}`); break; }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
}

test("narrow nodes: width ⇄ height on one line, controls no wider than the node, seed buttons one line each", { skip: browser ? false : "no Edge/Chrome found (set SUCANVAS_TEST_BROWSER)" }, async () => {
  const html = await page([420, 320, 260]);
  const problems = [];
  const measured = await measure(html, ["", "medium"]);
  for (const [fontSize, all] of Object.entries(measured)) {
    for (const m of all) {
      const at = `${m.case}${fontSize ? " (medium font)" : ""}`;
      if (m.seedButtons.length !== 2) problems.push(`${at}: seed buttons ${m.seedButtons.length}`);
      for (const b of m.seedButtons) {
        if (b.lines !== 1) problems.push(`${at}: 「${b.text}」 on ${b.lines} lines`);
        if (b.clipped) problems.push(`${at}: 「${b.text}」 clipped`);
        if (b.right > m.right) problems.push(`${at}: 「${b.text}」 outside the node`);
      }
      if (m.case.startsWith("image/")) {
        if (!m.size?.oneLine) problems.push(`${at}: width/⇄/height not on one line (tops ${m.size?.tops})`);
        if (m.size && m.size.right > m.right) problems.push(`${at}: size row ends at ${m.size.right}, node at ${m.right}`);
        if (m.size?.clippedValues.length) problems.push(`${at}: value cut off in ${m.size.clippedValues.join(", ")}`);
        if (m.controls.widest > m.controls.right + 1) problems.push(`${at}: controls content reaches ${m.controls.widest}, controls end at ${m.controls.right}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
