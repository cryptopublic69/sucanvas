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

test("every canvas a signed-in user can see offers copying (012c2 rework)", () => {
  assert.equal(access.canCopyProject(canvas("u-bob", true), alice), true);
  assert.equal(access.canCopyProject(canvas("u-alice"), alice), true);
  assert.equal(access.canCopyProject(canvas("u-alice"), admin), true);
  // Desktop / signed out: no copy entry.
  assert.equal(access.canCopyProject(canvas("u-bob", true), null), false);
});

test("canvas settings save through one update_canvas_settings call with only the changed fields", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /invoke\("update_canvas_settings", \{\s+id: project\.canvas\.id,\s+\.\.\.\(ownerChanged \? \{ ownerUserId: settings\.ownerUserId \} : \{\}\),\s+\.\.\.\(sharingChanged \? \{ isShared: settings\.shared \} : \{\}\),/);
  assert.doesNotMatch(app, /set_canvas_owner|"set_canvas_sharing"/);
  assert.match(app, /invoke<WorkspaceSnapshot>\("copy_project"/);
});

test("the canvas settings owner list comes from the registered Web handler", async () => {
  assert.deepEqual(await access.assignableUsers(), []);
  access.registerAssignableUsersHandler(async () => [{ id: "u-bob", username: "bob", displayName: null, role: "user" }]);
  assert.deepEqual((await access.assignableUsers()).map((user) => user.id), ["u-bob"]);
  access.registerAssignableUsersHandler(null);
});

test("read-only nodes swallow clicks on every button except explicitly allowed ones", () => {
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
  const folder = element("button", { "data-readonly-allow": "" });
  // The old marker name means nothing any more (fail-closed).
  assert.equal(readOnly.readOnlyClickBlocked(element("button", { "data-read-only-safe": "" })), true);
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

test("view-only buttons are on the explicit allowlist and read-only hosts intercept edits", async () => {
  const node = await readFile(new URL("../src/CanvasNode.tsx", import.meta.url), "utf8");
  assert.match(node, /className="nodrag folder-node-body"\s+data-readonly-allow=""/);
  // Each allowed button is identified by what it does; nothing that writes is on the list.
  // Each allowed button's markup up to its closing tag (onClick arrows contain ">").
  const allowed = node.split('<button data-readonly-allow=""').slice(1).map((rest) => rest.slice(0, rest.indexOf("</button>")));
  const expectations = [
    ["fullscreen", /onClick=\{playGeneratedVideoFullscreen\}/, 1],
    ["download", /onRevealGeneratedVideo/, 1],
    ["audio play/pause", /toggleAudioPreview/, 1],
    ["copy Markdown", /copyMarkdown\(/, 7],
    ["info popovers", /title="查看(生成信息|图片生成信息|图片信息)"/, 3],
    ["expand to view", /setExpanded\(true\)|openConnectedTextEditor\(input\)|放大查看正向提示词/, 3],
    ["Markdown preview", /MarkdownPreview\(\(preview\) => !preview\)/, 6],
    ["close expanded view", /requestClose(ExpandedEditor|ConnectedTextEditor)/, 2],
  ];
  for (const [label, pattern, count] of expectations) {
    assert.equal(allowed.filter((attributes) => pattern.test(attributes)).length, count, label);
  }
  assert.equal(allowed.length, 24, "no unexpected button on the allowlist");
  assert.equal(allowed.filter((attributes) => /save|delete|submit|execute|update|change|onChange/i.test(attributes)).length, 0);
  const presentation = await readFile(new URL("../src/canvas/CanvasNodePresentation.tsx", import.meta.url), "utf8");
  for (const handler of ["onDoubleClickCapture", "onClickCapture", "onChangeCapture", "onBeforeInputCapture", "onPasteCapture", "onDropCapture"]) {
    assert.match(presentation, new RegExp(`is-read-only[\\s\\S]*${handler}=`), handler);
  }
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<CanvasReadOnlyContext\.Provider value=\{canvasReadOnly\}>/);
  assert.match(app, /const openCanvasContextMenu = useCallback\([^]*?event\.preventDefault\(\);[^]*?if \(canvasReadOnlyRef\.current\) return;/, "canvas menu closed while read-only");
  assert.match(app, /const openNodeContextMenu = useCallback\([^]*?event\.stopPropagation\(\);\s+if \(canvasReadOnlyRef\.current\) return;/, "node menu closed while read-only");
  // Passive saves (e.g. measured media size) never reach the server while read-only.
  assert.match(app, /const persistPatch = useCallback\(\s+\(id: string, patch: NodePatch\) => \{[^]*?if \(canvasReadOnlyRef\.current\) return;\s+const previous/);
  assert.match(app, /const persistPatchImmediately = useCallback\(\s+async \(id: string, patch: NodePatch\) => \{\s+if \(canvasReadOnlyRef\.current\) return;/);
});

test("regular users confirm removing generated media nodes (files are kept)", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.equal((app.match(/if \(!canDeleteFilesRef\.current\) \{\s+return new Promise<VideoDeletionChoice>\(\(resolve\) => setNodeOnlyDeletionRequest/g) ?? []).length, 2);
  assert.match(app, /文件不会被删除。删除后可以用 Ctrl\+Z 撤销。/);
});
