import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const inline = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const realModule = (name) => pathToFileURL(require.resolve(name)).href;
const previewSource = await readFile(new URL("../src/web/previewCache.ts", import.meta.url), "utf8");
const previewModule = inline(ts.transpileModule(previewSource, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText);
const { versionedPreviewUrl } = await import(previewModule);
const source = await readFile(new URL("../src/canvas/CanvasNodePresentation.tsx", import.meta.url), "utf8");
async function presentation(mode) {
  const replacements = [
    ['"react"', JSON.stringify(realModule("react"))],
    ['"@xyflow/react"', JSON.stringify(inline('export const Handle=()=>null; export const Position={Left:"left",Right:"right"}; export const useStore=selector=>selector({transform:[0,0,globalThis.previewTestZoom],width:1000,height:800,nodeLookup:{get:()=>({hidden:false,internals:{positionAbsolute:{x:0,y:0}},measured:{width:420,height:260}})}});'))],
    ['"@tauri-apps/api/core"', JSON.stringify(inline('export const convertFileSrc=value=>value;'))],
    ['"./renderQueue"', JSON.stringify(inline('export const nodeRenderQueue={enqueue(){ throw new Error("Loaded covers must render before the mount queue advances"); }};'))],
    ['"./useBatchedNodeInternals"', JSON.stringify(inline('export const useBatchedNodeInternals=()=>()=>{};'))],
    ['"../videoPosterCache"', JSON.stringify(inline('export const posterMemoryCache={peek:src=>globalThis.previewTestCovers.get(src)}; export const requestCachedVideoPoster=()=>{ throw new Error("Loaded covers must not require asynchronous reads for the initial render"); };'))],
    ['"../web/previewCache"', JSON.stringify(previewModule)],
    ['"../web/SessionImagePreview"', JSON.stringify(inline(`import React from ${JSON.stringify(realModule("react"))}; export const SessionImagePreview=props=>React.createElement("img",{...props,src:globalThis.previewTestImages?.get(props.src)?.url});`))],
  ];
  let input = source.replaceAll('import.meta.env.MODE', JSON.stringify(mode));
  for (const [from, to] of replacements) input = input.replaceAll(from, to);
  let output = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  output = output.replaceAll('"react/jsx-runtime"', JSON.stringify(realModule("react/jsx-runtime")));
  return (await import(inline(output))).CanvasNodePresentation;
}

const WebPresentation = await presentation("web");
const DesktopPresentation = await presentation("desktop");
const origin = "https://canvas.example.com";
globalThis.window = { location: { origin } };
globalThis.previewTestCovers = new Map();
const props = (i) => ({ id: `node-${i}`, selected: false, detail: () => null, data: { activeTaskCount: 0, record: { id: `node-${i}`, kind: "generated-video", title: "Video", content: { videoUrl: `/api/comfy/view?filename=${i}.mp4&type=output`, comfyPromptId: `prompt-${i}` } } } });
for (let i = 0; i < 640; i++) {
  const record = props(i).data.record;
  previewTestCovers.set(versionedPreviewUrl(record.content.videoUrl, record.content.comfyPromptId, origin), { url: `blob:loaded-cover-${i}` });
}

test("640 loaded Web covers are visible on the first overview render and after remount", () => {
  globalThis.previewTestZoom = 0.2;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 640; i++) {
      const html = renderToStaticMarkup(React.createElement(WebPresentation, props(i)));
      assert.ok(html.includes(`src="blob:loaded-cover-${i}"`), `pass ${pass}, node ${i}`);
    }
  }
});

test("Web covers remain visible while detailed node mounting is queued", () => {
  globalThis.previewTestZoom = 1;
  const html = renderToStaticMarkup(React.createElement(WebPresentation, props(0)));
  assert.ok(html.includes('src="blob:loaded-cover-0"'));
});

test("a regenerated video cannot display the previous resident cover", () => {
  const updated = props(0);
  updated.data.record.content.comfyPromptId = "new-prompt";
  const html = renderToStaticMarkup(React.createElement(WebPresentation, updated));
  assert.ok(!html.includes('src="blob:loaded-cover-0"'));
});

test("desktop overview retains its existing initial render behavior", () => {
  globalThis.previewTestZoom = 0.2;
  const html = renderToStaticMarkup(React.createElement(DesktopPresentation, props(0)));
  assert.ok(!html.includes('src="blob:loaded-cover-0"'));
});

test("Web input overview uses its resident image preview while desktop keeps the original source", () => {
  const input = props(0);
  input.data.record.kind = "image";
  input.data.record.content = { assetPath: "sucanvas-input://sucanvas-imports/input.png" };
  globalThis.previewTestImages = new Map([[input.data.record.content.assetPath, { url: "blob:resident-input" }]]);
  const web = renderToStaticMarkup(React.createElement(WebPresentation, input));
  assert.ok(web.includes('src="blob:resident-input"'));
  const desktop = renderToStaticMarkup(React.createElement(DesktopPresentation, input));
  assert.ok(desktop.includes('src="sucanvas-input://sucanvas-imports/input.png"'));
});
