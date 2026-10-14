import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const inline = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
let source = (await readFile(new URL("../src/LazyVideoPreview.tsx", import.meta.url), "utf8"))
  .replaceAll('import.meta.env.MODE', '"web"');
for (const [name, code] of [
  ["react", 'export const forwardRef=fn=>fn; export const useRef=value=>globalThis.playbackHooks.ref(value); export const useState=value=>globalThis.playbackHooks.state(value); export const useLayoutEffect=fn=>{globalThis.playbackHooks.effect=fn;}; export const useImperativeHandle=()=>{};'],
  ["react-dom", 'export const flushSync=fn=>{fn();globalThis.playbackHooks.render();};'],
  ["lucide-react", 'export const Film=()=>null;'],
  ["./videoPosterCache", 'export const posterMemoryCache={peek:()=>null}; export const requestVideoPoster=()=>()=>{};'],
  ["./videoPreviewScheduler", 'export const videoPreviewScheduler={claim:()=>()=>{}};'],
  ["./web/useVideoStill", 'export const useVideoStill=()=>"";'],
  ["./web/videoStillCache", 'export const webVideoStills={capture:()=>{}};'],
]) source = source.replace(JSON.stringify(name), JSON.stringify(inline(code)));
let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
js = js.replace('"react/jsx-runtime"', JSON.stringify(inline('export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;')));
const { LazyVideoPreview } = await import(inline(js));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  let now = 0, nextId = 0, cursor = 0, tree, currentRef;
  const timers = new Map(), slots = [], plays = [], frames = new Map();
  t.mock.method(globalThis, "setTimeout", (run, delay) => { const id = ++nextId; timers.set(id, { run, at: now + delay }); return id; });
  t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
  const video = { src: "", loads: 0, readyState: 0, seeking: false, currentTime: 1,
    ended: false, videoWidth: 1280, videoHeight: 720,
    getAttribute: () => video.src || null, hasAttribute: () => Boolean(video.src),
    removeAttribute: () => { video.src = ""; }, pause() {}, load() { video.loads++; },
    play: () => new Promise((resolve, reject) => plays.push({ resolve, reject })),
    requestVideoFrameCallback: run => { const id = ++nextId; frames.set(id, run); return id; },
    cancelVideoFrameCallback: id => frames.delete(id),
  };
  globalThis.document = { hidden: false, fullscreenElement: null, addEventListener() {}, removeEventListener() {} };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const hooks = globalThis.playbackHooks = {
    ref(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    state(value) { const index = cursor++; if (!(index in slots)) slots[index] = typeof value === "function" ? value() : value;
      return [slots[index], update => { slots[index] = typeof update === "function" ? update(slots[index]) : update; }]; },
    render() {
      cursor = 0;
      tree = LazyVideoPreview({ src: "video.mp4" }, null);
      const element = tree.props.children.find(child => child?.type === "video");
      if (element) { currentRef = element.props.ref; currentRef.current = video; }
      else if (currentRef) currentRef.current = null;
    },
  };
  hooks.render();
  const cleanup = hooks.effect();
  t.after(() => { cleanup(); delete globalThis.playbackHooks; delete globalThis.window; delete globalThis.document; });
  const advance = ms => {
    const target = now + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a,b) => a[1].at-b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].run();
    }
    now = target;
  };
  return { video, plays, frames, advance,
    enter: () => { hooks.render(); tree.props.onMouseEnter(); advance(250); },
    leave: () => tree.props.onMouseLeave(),
  };
}

test("an old rejected play attempt cannot release a newer hover playback", async t => {
  const f = fixture(t);
  f.enter(); f.leave(); f.enter();
  assert.equal(f.plays.length, 2);
  f.plays[0].reject(new DOMException("previous playback interrupted", "AbortError"));
  await tick();
  assert.equal(f.video.src, "video.mp4");
  assert.equal(f.video.loads, 0);
  f.plays[1].reject(new Error("current playback failed"));
  await tick();
  assert.equal(f.video.src, "");
  assert.equal(f.video.loads, 1);
});

test("a stalled player is released and the next hover can retry", t => {
  const f = fixture(t);
  f.enter(); f.advance(15_000);
  assert.equal(f.video.src, "");
  assert.equal(f.video.loads, 1);
  f.enter();
  assert.equal(f.video.src, "video.mp4");
  assert.equal(f.plays.length, 2);
});

test("a decoded frame cancels the stall timer", t => {
  const f = fixture(t);
  f.enter();
  [...f.frames.values()][0]();
  f.advance(15_000);
  assert.equal(f.video.src, "video.mp4");
  assert.equal(f.video.loads, 0);
});
