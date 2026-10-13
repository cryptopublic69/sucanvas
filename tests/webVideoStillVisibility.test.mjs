import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/useVideoStill.ts", import.meta.url), "utf8");
const inline = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const react = inline("export const useState=()=>[globalThis.stillHookState,(value)=>{globalThis.stillHookState=value;}]; export const useLayoutEffect=effect=>{globalThis.stillHookEffect=effect;};");
const cache = inline("export const webVideoStills={watch:(...args)=>globalThis.stillHookWatch(...args),peek:()=>globalThis.stillHookPeek};");
async function hook(mode) {
  const input = source.replaceAll("import.meta.env.MODE", JSON.stringify(mode))
    .replace('"react"', JSON.stringify(react)).replace('"./videoStillCache"', JSON.stringify(cache));
  return (await import(inline(ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText))).useVideoStill;
}
const web = await hook("web"), desktop = await hook("desktop");

function fixture(t) {
  const calls = [], root = {}, element = { closest: selector => { assert.equal(selector, ".react-flow"); return root; } };
  let callback, options, refresh;
  globalThis.stillHookState = null;
  globalThis.stillHookPeek = "";
  globalThis.stillHookWatch = (src, update) => {
    calls.push(["watch", src]);
    update("blob:still");
    return { setVisible: visible => calls.push(["visible", visible]), release: () => calls.push(["release"]) };
  };
  globalThis.document = { hidden: false,
    addEventListener(name, listener) { assert.equal(name, "visibilitychange"); refresh = listener; },
    removeEventListener(name, listener) { assert.equal(name, "visibilitychange"); assert.equal(listener, refresh); calls.push(["remove-event"]); },
  };
  globalThis.IntersectionObserver = class {
    constructor(handler, value) { callback = handler; options = value; }
    observe(value) { assert.equal(value, element); calls.push(["observe"]); }
    disconnect() { calls.push(["disconnect"]); }
  };
  t.after(() => {
    for (const key of ["stillHookState", "stillHookPeek", "stillHookWatch", "stillHookEffect", "document", "IntersectionObserver"]) delete globalThis[key];
  });
  return { calls, root, host: { current: element },
    intersection: visible => callback([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]),
    refresh: () => refresh(), options: () => options };
}

test("Web visibility tracks the canvas clipping root and stops owning frames outside it", t => {
  const f = fixture(t);
  web("video", f.host);
  const cleanup = stillHookEffect();
  assert.deepEqual(f.options(), { root: f.root, threshold: 0 });
  assert.deepEqual(f.calls.at(-1), ["visible", true]);
  f.intersection(false);
  assert.deepEqual(f.calls.at(-1), ["visible", false]);
  f.intersection(true);
  assert.deepEqual(f.calls.at(-1), ["visible", true]);
  document.hidden = true; f.refresh();
  assert.deepEqual(f.calls.at(-1), ["visible", false]);
  document.hidden = false; f.refresh();
  assert.deepEqual(f.calls.at(-1), ["visible", true]);
  cleanup();
  assert.deepEqual(f.calls.slice(-3), [["disconnect"], ["remove-event"], ["release"]]);
});

test("desktop never subscribes to Web frames or installs observers", t => {
  const f = fixture(t);
  stillHookPeek = "blob:web-frame";
  assert.equal(desktop("video", f.host), "");
  assert.equal(stillHookEffect(), undefined);
  assert.deepEqual(f.calls, []);
});

test("source changes cannot briefly display the previous video's frame", t => {
  const f = fixture(t);
  stillHookState = { src: "old", url: "blob:old-frame" };
  stillHookPeek = "blob:new-frame";
  assert.equal(web("new", f.host), "blob:new-frame");
});
