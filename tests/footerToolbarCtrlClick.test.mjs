import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// CANVAS-042: Ctrl+click on an uploaded image's Resize button must open the "longest edge" dialog. Two layers
// used to stop it: while Ctrl is held App.css turned pointer events off for everything inside a node except
// the generated nodes' footer buttons, and the node's Ctrl multi-select capture swallowed the click unless
// it came from a generated node's footer button. Ctrl+click anywhere else on a node still toggles selection.
const canvas = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/App.css", import.meta.url), "utf8");
const file = ts.createSourceFile("CanvasNode.tsx", canvas, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const run = (expression, env) => {
  const code = compile(`const run = ${expression};`);
  return new Function(...Object.keys(env), `${code}; return run;`)(...Object.values(env));
};

// The JSX attribute `name` of the first element whose opening tag passes `pick`.
function jsxAttribute(pick, name) {
  let found;
  function visit(node) {
    if (found) return;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && pick(node)) {
      const attribute = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(file) === name);
      if (attribute) found = attribute.initializer.expression.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, `missing ${name}`);
  return found;
}
const classOf = (node) => node.attributes.properties
  .find((p) => ts.isJsxAttribute(p) && p.name.getText(file) === "className")?.initializer?.getText(file) ?? "";
const isNodeArticle = (node) => node.tagName.getText(file) === "article" && classOf(node).includes("canvas-node kind-");
const isResizeButton = (node) => node.tagName.getText(file) === "button" && classOf(node).includes("media-footer-resize");

// A tiny DOM: an element is its chain up to the node article, e.g. [svg, button.x, footer.y, article.canvas-node].
const parseCompound = (text) => {
  const [tag, ...classes] = text.split(".");
  return { tag: tag || null, classes };
};
const matchesCompound = (element, compound) => (!compound.tag || compound.tag === element.tag)
  && compound.classes.every((name) => element.classes.includes(name));
// Descendant selectors and comma lists only (all the rules here use).
function matchesAt(chain, index, selector) {
  return selector.split(",").some((one) => {
    const parts = one.trim().split(/\s+/).map((part) => (part === "*" ? { tag: null, classes: [] } : parseCompound(part)));
    if (!matchesCompound(chain[index], parts.at(-1))) return false;
    let at = index + 1;
    for (let p = parts.length - 2; p >= 0; p -= 1) {
      while (at < chain.length && !matchesCompound(chain[at], parts[p])) at += 1;
      if (at >= chain.length) return false;
      at += 1;
    }
    return true;
  });
}
class FakeElement {
  constructor(chain, index = 0) { this.chain = chain; this.index = index; }
  closest(selector) {
    for (let i = this.index; i < this.chain.length; i += 1) {
      if (matchesAt(this.chain, i, selector)) return new FakeElement(this.chain, i);
    }
    return null;
  }
}
const el = (text) => parseCompound(text);
const article = (kind) => el(`article.canvas-node.kind-${kind}`);
const uploadResizeIcon = [el("svg"), el("button.nodrag.node-action.media-footer-resize"), el("footer.node-footer"), article("image")];
const uploadResizeButton = uploadResizeIcon.slice(1);
const uploadInfoButton = [el("button.node-action.generated-video-info-button"), el("div.nodrag.generated-video-info-control"), el("div.generated-video-actions"), el("footer.node-footer"), article("image")];
const uploadBody = [el("img"), el("div.image-preview"), article("image")];
const uploadFooterText = [el("span.image-dimension-label"), el("footer.node-footer"), article("image")];
const generatedImageButton = [el("svg"), el("button.nodrag.node-action.generated-video-regenerate-action"), el("div.generated-video-actions"), el("footer.generated-video-footer.generated-image-footer"), article("generated-image")];
const generatedImageBody = [el("img"), el("div.generated-image-preview"), article("generated-image")];

const kinds = {
  image: { isImage: true, isGeneratedImage: false, isGeneratedVideo: false },
  "generated-image": { isImage: false, isGeneratedImage: true, isGeneratedVideo: false },
};

// The article's real capture handlers, run against one node with selected=false.
function nodeHandlers(kind) {
  const pointerDown = jsxAttribute(isNodeArticle, "onPointerDownCapture");
  const helperName = /if \((\w+)\(event\.target\)\)/.exec(pointerDown)?.[1];
  assert.ok(helperName, "the Ctrl capture asks a helper whether to leave the target alone");
  let helper;
  ts.forEachChild(file, function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === helperName) helper = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  });
  assert.ok(helper, `missing ${helperName}`);
  const preserves = run(helper, { ...kinds[kind], Element: FakeElement });
  const state = { nodes: [{ id: "n", selected: false }], setNodesCalls: 0 };
  const env = {
    [helperName]: preserves,
    ctrlSelectionPointerId: { current: null },
    setNodes: (update) => { state.setNodesCalls += 1; state.nodes = update(state.nodes); },
    id: "n",
  };
  return {
    state,
    pointerDown: run(pointerDown, env),
    click: run(jsxAttribute(isNodeArticle, "onClickCapture"), env),
  };
}
function fakeEvent(chain, extra = {}) {
  const event = { target: new FakeElement(chain), button: 0, ctrlKey: true, pointerId: 7, altKey: false, prevented: false, stopped: false, ...extra };
  event.preventDefault = () => { event.prevented = true; };
  event.stopPropagation = () => { event.stopped = true; };
  return event;
}
// One Ctrl+click through the node capture; returns what reached the target (if anything).
function ctrlClick(kind, chain, extra) {
  const handlers = nodeHandlers(kind);
  const down = fakeEvent(chain, extra);
  handlers.pointerDown(down);
  const click = fakeEvent(chain, extra);
  handlers.click(click);
  return { handlers, down, click };
}

// React Flow selects (with Ctrl: toggles) a node from its wrapper's onClick, so the Ctrl+click that opens the
// dialog must not bubble there; a plain click keeps bubbling (it selects the node as before).
function resizeButtonClick(ctrlKey) {
  const calls = [];
  run(jsxAttribute(isResizeButton, "onClick"), {
    imageResizeDefaultFromStorage: () => 1536,
    setImageResizeDraft: (value) => calls.push(["draft", value]),
    setImageResizeError: (value) => calls.push(["error", value]),
    setImageResizeDialogOpen: (value) => calls.push(["dialog", value]),
    runImageResize: (...args) => calls.push(["resize", ...args]),
  })({ ctrlKey, stopPropagation: () => calls.push(["stopPropagation"]) });
  return calls;
}

test("uploaded image: Ctrl+click on Resize reaches the button, opens the longest-edge dialog, selection unchanged", () => {
  for (const chain of [uploadResizeIcon, uploadResizeButton]) {
    const { handlers, down, click } = ctrlClick("image", chain);
    assert.equal(down.prevented || down.stopped, false, `pointerdown not swallowed (${chain[0].tag})`);
    assert.equal(click.prevented || click.stopped, false, `click not swallowed (${chain[0].tag})`);
    assert.equal(handlers.state.setNodesCalls, 0, "selection not toggled");
    assert.equal(handlers.state.nodes[0].selected, false);
  }
  assert.deepEqual(resizeButtonClick(true), [["stopPropagation"], ["draft", "1536"], ["error", ""], ["dialog", true]], "Ctrl opens the dialog without reaching React Flow's node click, no resize yet");
  assert.deepEqual(resizeButtonClick(false), [["resize", 1536, false]], "a plain click still resizes to the saved default");
});

test("uploaded image: Ctrl+click on the node body or footer text still toggles selection and is swallowed", () => {
  for (const chain of [uploadBody, uploadFooterText]) {
    const { handlers, down, click } = ctrlClick("image", chain);
    assert.equal(down.prevented && down.stopped, true, `pointerdown swallowed (${chain[0].tag})`);
    assert.equal(click.prevented && click.stopped, true, `click swallowed (${chain[0].tag})`);
    assert.equal(handlers.state.setNodesCalls, 1);
    assert.equal(handlers.state.nodes[0].selected, true, "toggled on");
  }
  // A second Ctrl+click toggles back off.
  const handlers = nodeHandlers("image");
  handlers.pointerDown(fakeEvent(uploadBody));
  handlers.pointerDown(fakeEvent(uploadBody));
  assert.equal(handlers.state.nodes[0].selected, false);
});

test("uploaded image: a plain click and a right/middle button are left alone", () => {
  for (const extra of [{ ctrlKey: false }, { button: 2 }, { button: 1 }]) {
    const handlers = nodeHandlers("image");
    const down = fakeEvent(uploadBody, extra);
    handlers.pointerDown(down);
    assert.equal(down.prevented || down.stopped, false, JSON.stringify(extra));
    assert.equal(handlers.state.setNodesCalls, 0);
  }
});

test("generated image unchanged: footer buttons pass Ctrl through, the body toggles selection", () => {
  const button = ctrlClick("generated-image", generatedImageButton);
  assert.equal(button.down.prevented || button.down.stopped || button.click.prevented || button.click.stopped, false);
  assert.equal(button.handlers.state.setNodesCalls, 0);
  const body = ctrlClick("generated-image", generatedImageBody);
  assert.equal(body.down.prevented && body.click.stopped, true);
  assert.equal(body.handlers.state.nodes[0].selected, true);
});

// While Ctrl is held (.is-ctrl-node-selection) the target must be able to receive the pointer at all.
function ctrlModePointerEvents(chain) {
  const shell = el("div.app-shell.is-ctrl-node-selection");
  const full = [...chain, el("div.react-flow__node"), shell];
  let result = "auto";
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selectorText, body] of css.matchAll(rule)) {
    const value = /pointer-events:\s*(none|auto)\s*!important/.exec(body)?.[1];
    if (!value) continue;
    const selectors = selectorText.split(",").map((s) => s.trim()).filter((s) => s.startsWith(".app-shell.is-ctrl-node-selection "));
    if (selectors.length && selectors.some((s) => matchesAt(full, 0, s))) result = value; // later rules win (same specificity order)
  }
  return result;
}

test("while Ctrl is held the uploaded image's Resize button still receives the pointer; the node body does not", () => {
  assert.equal(ctrlModePointerEvents(uploadResizeButton), "auto", "Resize button");
  assert.equal(ctrlModePointerEvents(uploadResizeIcon), "auto", "its icon");
  assert.equal(ctrlModePointerEvents(generatedImageButton), "auto", "generated footer button unchanged");
  assert.equal(ctrlModePointerEvents(uploadBody), "none", "body still off (Ctrl+click selects the node)");
  assert.equal(ctrlModePointerEvents(uploadFooterText), "none", "footer text still off");
  assert.equal(ctrlModePointerEvents(generatedImageBody), "none");
});

test("the info button in the uploaded image footer behaves like the generated footers' buttons", () => {
  const { handlers, click } = ctrlClick("image", uploadInfoButton);
  assert.equal(click.prevented || click.stopped, false);
  assert.equal(handlers.state.setNodesCalls, 0);
  assert.equal(ctrlModePointerEvents(uploadInfoButton), "auto");
});
