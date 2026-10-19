import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
const react = moduleUrl("export function useSyncExternalStore(_s, snapshot) { return snapshot(); } export function createContext(value) { return { value }; } export function useContext(context) { return context.value; }");
const load = async (path) => import(moduleUrl((await readFile(new URL(path, import.meta.url), "utf8")).replace('"react"', JSON.stringify(react))));
const access = await load("../src/account/access.ts");
const readOnly = await load("../src/canvas/readOnly.ts");

const admin = { id: "u-admin", username: "admin", displayName: null, role: "admin" };
const alice = { id: "u-alice", username: "alice", displayName: "爱丽丝", role: "user" };
const canvas = (ownerUserId, isShared = false, extra = {}) => ({ ownerUserId, isShared, ownerUsername: ownerUserId?.slice(2) ?? null, ...extra });

test("deleting another user's private canvas names its owner in the confirmation", () => {
  assert.equal(access.othersPrivateDeleteWarning(canvas("u-alice", false, { ownerDisplayName: "爱丽丝" }), admin), "这是 爱丽丝 的私有画布，删除后不可恢复。");
  assert.equal(access.othersPrivateDeleteWarning(canvas("u-bob"), admin), "这是 bob 的私有画布，删除后不可恢复。");
  // Own, shared and (for regular users) any canvas: the normal confirmation.
  assert.equal(access.othersPrivateDeleteWarning(canvas("u-admin"), admin), null);
  assert.equal(access.othersPrivateDeleteWarning(canvas("u-alice", true), admin), null);
  assert.equal(access.othersPrivateDeleteWarning(canvas("u-alice"), alice), null);
});

test("only shared canvases offer copying, to every signed-in user", () => {
  assert.equal(access.canCopyProject(canvas("u-bob", true), alice), true);
  assert.equal(access.canCopyProject(canvas("u-bob", true), admin), true);
  assert.equal(access.canCopyProject(canvas("u-alice"), alice), false);
  assert.equal(access.canCopyProject(canvas("u-alice"), admin), false);
  assert.equal(access.canCopyProject(canvas("u-bob", true), null), false);
});

test("the canvas settings owner list comes from the registered Web handler", async () => {
  assert.deepEqual(await access.assignableUsers(), []);
  access.registerAssignableUsersHandler(async () => [{ id: "u-bob", username: "bob", displayName: null, role: "user" }]);
  assert.deepEqual((await access.assignableUsers()).map((user) => user.id), ["u-bob"]);
  access.registerAssignableUsersHandler(null);
});

test("read-only nodes swallow clicks on buttons except navigation ones", () => {
  // Minimal element stand-ins: closest() walks up to the first match.
  const element = (tag, attributes = {}, parent = null) => ({
    tag, attributes, parent,
    hasAttribute(name) { return name in this.attributes; },
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (selector.split(",").some((part) => part.trim() === node.tag || (part.includes('role="button"') && node.attributes.role === "button"))) return node;
      }
      return null;
    },
  });
  const save = element("button");
  const icon = element("svg", {}, save);
  const folder = element("button", { "data-read-only-safe": "" });
  const fakeButton = element("div", { role: "button" });
  const text = element("textarea");
  assert.equal(readOnly.readOnlyClickBlocked(save), true);
  assert.equal(readOnly.readOnlyClickBlocked(icon), true);
  assert.equal(readOnly.readOnlyClickBlocked(fakeButton), true);
  assert.equal(readOnly.readOnlyClickBlocked(folder), false);
  // Text stays selectable and scrollable; its changes are dropped elsewhere.
  assert.equal(readOnly.readOnlyClickBlocked(text), false);
  assert.equal(readOnly.readOnlyClickBlocked(null), false);
});

test("the folder entry is marked safe and read-only hosts intercept edits", async () => {
  const node = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
  assert.match(node, /className="nodrag folder-node-body"\s+data-read-only-safe=""/);
  const presentation = await readFile(new URL("../src/canvas/CanvasNodePresentation.tsx", import.meta.url), "utf8");
  for (const handler of ["onDoubleClickCapture", "onClickCapture", "onChangeCapture", "onBeforeInputCapture", "onPasteCapture", "onDropCapture"]) {
    assert.match(presentation, new RegExp(`is-read-only[\\s\\S]*${handler}=`), handler);
  }
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<CanvasReadOnlyContext\.Provider value=\{canvasReadOnly\}>/);
  assert.equal((app.match(/if \(canvasReadOnlyRef\.current\) return;/g) ?? []).length, 2, "both context menus are closed while read-only");
});

test("regular users confirm removing generated media nodes (files are kept)", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.equal((app.match(/if \(!canDeleteFilesRef\.current\) \{\s+return new Promise<VideoDeletionChoice>\(\(resolve\) => setNodeOnlyDeletionRequest/g) ?? []).length, 2);
  assert.match(app, /文件不会被删除。删除后可以用 Ctrl\+Z 撤销。/);
});
