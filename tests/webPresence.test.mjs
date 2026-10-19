import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
// The hook itself is exercised in the browser acceptance; here React and the bridge are stand-ins.
const stubs = {
  '"react"': moduleUrl("export const useEffect = () => {}; export const useState = (value) => [value, () => {}];"),
  '"@tauri-apps/api/core"': moduleUrl("export const invoke = async () => ({ users: [] });"),
  '"@tauri-apps/api/event"': moduleUrl("export const listen = async () => () => {};"),
};
let source = await readFile(new URL("../src/account/presence.ts", import.meta.url), "utf8");
for (const [name, url] of Object.entries(stubs)) source = source.replace(name, JSON.stringify(url));
const presence = await import(moduleUrl(source));
const user = (userId, displayName = null) => ({ userId, username: userId, displayName });

test("other users are listed once each, never the caller", () => {
  const users = [user("u-admin"), user("u-alice", "爱丽丝"), user("u-alice", "爱丽丝"), user("u-bob")];
  assert.deepEqual(presence.othersPresent(users, "u-admin").map((u) => u.userId), ["u-alice", "u-bob"]);
  assert.deepEqual(presence.othersPresent([user("u-admin")], "u-admin"), []);
});

test("the label names up to three users, then counts", () => {
  assert.equal(presence.presenceLabel([]), "");
  assert.equal(presence.presenceLabel([user("u-alice", "爱丽丝")]), "爱丽丝 也在这张画布");
  assert.equal(presence.presenceLabel([user("alice"), user("bob")]), "alice、bob 也在这张画布");
  assert.equal(presence.presenceLabel([user("a"), user("b"), user("c"), user("d")]), "a、b、c 等 4 人也在这张画布");
});

test("toolbar avatars show up to three initials, then a +N count", () => {
  assert.deepEqual(presence.presenceAvatars([]), { shown: [], extra: 0 });
  const { shown, extra } = presence.presenceAvatars([user("u-alice", "爱丽丝"), user("bob"), user("carol"), user("dora"), user("eve")]);
  assert.deepEqual(shown.map((avatar) => [avatar.initial, avatar.name]), [["爱", "爱丽丝"], ["B", "bob"], ["C", "carol"]]);
  assert.equal(extra, 2);
});

test("read-only state and presence sit in the toolbar, not over the canvas", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /canvas-top-notices|canvas-access-banner|className="canvas-presence"/);
  assert.match(app, /className="api-panel">\s+\{\(canvasReadOnly \|\| editingOthersCanvas\) && activeCanvasRecord && \(\s+<CanvasAccessChip[^]*?<CanvasPresenceAvatars others=\{presentOthers\} \/>\s+\{comfyQueueIndicator\}/);
  const chip = await readFile(new URL("../src/canvas/CanvasAccessIndicators.tsx", import.meta.url), "utf8");
  assert.match(chip, /"开启编辑模式"/);
  assert.match(chip, /"退出编辑模式"/);
});

test("an open project that was deleted or became unreadable is left; anything else refreshes", () => {
  const change = (reason, canvasId = "canvas:open") => ({ canvasId, reason });
  assert.equal(presence.accessChangeAction(change("deleted"), "canvas:open"), "leave");
  assert.equal(presence.accessChangeAction(change("revoked"), "canvas:open"), "leave");
  assert.equal(presence.accessChangeAction(change("changed"), "canvas:open"), "refresh");
  assert.equal(presence.accessChangeAction(change("deleted", "canvas:other"), "canvas:open"), "refresh");
  assert.equal(presence.accessChangeAction(change("deleted"), null), "refresh");
  assert.match(presence.accessChangeNotice(change("deleted")), /^这张画布已被删除/);
  assert.match(presence.accessChangeNotice(change("revoked")), /^你已无权访问这张画布/);
});

test("presence never reports errors and the app wires it for Web accounts only", async () => {
  // Best effort: a failed heartbeat must not become an "操作失败" notice.
  assert.doesNotMatch(source, /reportError|reportWebError|setNotice/);
  assert.match(source, /catch \{\s+\/\/ Lost access arrives/);
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /useCanvasPresence\(\s+canvasPath\.length \? canvasPath\[canvasPath\.length - 1\]\.id : null,\s+import\.meta\.env\.MODE === "web" && Boolean\(accessUser\),\s+\)/);
  // Leaving a deleted/unreadable project drops unsaved patches instead of sending them.
  assert.match(app, /returnToProjectsRef\.current\(true\)\.then\(\(\) => showGlobalNotice\(accessChangeNotice\(change\)\)\)/);
  assert.match(app, /if \(discardPending\) \{\s+saveTimers\.current\.forEach[^]*?pendingPatches\.current\.clear\(\);\s+\} else \{\s+await flushPendingPatches\(\);/);
});
