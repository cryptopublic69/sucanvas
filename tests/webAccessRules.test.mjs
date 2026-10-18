import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
// The React hook is not exercised here; a stub keeps the module loadable in Node.
const react = moduleUrl("export function useSyncExternalStore(_subscribe, snapshot) { return snapshot(); }");
const source = (await readFile(new URL("../src/account/access.ts", import.meta.url), "utf8")).replace('"react"', JSON.stringify(react));
const access = await import(moduleUrl(source));

const admin = { id: "u-admin", username: "admin", displayName: null, role: "admin" };
const alice = { id: "u-alice", username: "alice", displayName: "爱丽丝", role: "user" };
const canvas = (ownerUserId, isShared = false, extra = {}) => ({ ownerUserId, isShared, ownerUsername: ownerUserId?.slice(2) ?? null, ...extra });
const project = (id, owner, shared) => ({ canvas: { id, ...canvas(owner, shared) } });

test("home page sections: mine, shared, and (admin) other users by owner", () => {
  const projects = [project("a1", "u-alice"), project("s1", "u-bob", true), project("b1", "u-bob"), project("o1", null), project("m1", "u-admin")];
  const forAlice = access.groupProjects(projects.filter((p) => p.canvas.ownerUserId === "u-alice" || p.canvas.isShared), alice);
  assert.deepEqual(forAlice.mine.map((p) => p.canvas.id), ["a1"]);
  assert.deepEqual(forAlice.shared.map((p) => p.canvas.id), ["s1"]);
  assert.deepEqual(forAlice.others, []);
  const forAdmin = access.groupProjects(projects, admin);
  assert.deepEqual(forAdmin.mine.map((p) => p.canvas.id), ["m1"]);
  assert.deepEqual(forAdmin.others.map((group) => [group.label, group.projects.map((p) => p.canvas.id)]), [["alice", ["a1"]], ["bob", ["b1"]], ["无主画布", ["o1"]]]);
  // Desktop (no user): everything is "mine", as before.
  assert.equal(access.groupProjects(projects, null).mine.length, 4);
});

test("delete buttons: shared canvases only for admins, never for other users' private canvases", () => {
  assert.equal(access.canDeleteProject(canvas("u-alice"), alice), true);
  assert.equal(access.canDeleteProject(canvas("u-alice", true), alice), false);
  assert.equal(access.canDeleteProject(canvas("u-alice", true), admin), true);
  assert.equal(access.canDeleteProject(canvas("u-alice"), admin), false);
  assert.equal(access.canDeleteProject(canvas(null), admin), true);
  assert.equal(access.canDeleteProject(canvas("u-bob", true), null), true);
});

test("an admin reads other users' private canvases until edit mode is on", () => {
  assert.equal(access.readOnlyCanvas(canvas("u-alice"), admin, false), true);
  assert.equal(access.readOnlyCanvas(canvas("u-alice"), admin, true), false);
  assert.equal(access.readOnlyCanvas(canvas("u-alice", true), admin, false), false);
  assert.equal(access.readOnlyCanvas(canvas("u-admin"), admin, false), false);
  assert.equal(access.readOnlyCanvas(canvas(null), admin, false), false);
  assert.equal(access.readOnlyCanvas(canvas("u-bob"), alice, false), false);
  assert.equal(access.readOnlyCanvas(canvas("u-alice"), null, false), false);
});

test("cross-canvas paste: private content stays out of shared and other users' canvases", () => {
  const mine = canvas("u-alice", false, { rootCanvasId: "r1" });
  assert.equal(access.pasteAllowed(mine, canvas("u-alice", false, { rootCanvasId: "r2" })), true);
  assert.equal(access.pasteAllowed(mine, canvas("u-alice", false, { rootCanvasId: "r1" })), true);
  assert.equal(access.pasteAllowed(mine, canvas("u-alice", true, { rootCanvasId: "r3" })), false);
  assert.equal(access.pasteAllowed(mine, canvas("u-bob", false, { rootCanvasId: "r4" })), false);
  assert.equal(access.pasteAllowed(canvas("u-bob", true), canvas("u-alice")), true);
  assert.equal(access.pasteAllowed(canvas(null), canvas("u-alice")), false);
  // Desktop records carry no ownership: always allowed.
  assert.equal(access.pasteAllowed({}, {}), true);
});

test("signed-in role and edit mode come from one store; edit mode switches itself off", async () => {
  assert.equal(access.isAdministrator(null), true);
  access.setAccessUser(alice);
  assert.equal(access.isAdministrator(access.currentAccessUser()), false);
  access.setAccessUser(admin, 1800);
  assert.equal(access.editModeActive(), true);
  assert.equal(access.editModeActive(Date.now() + 1801 * 1000), false);
  const calls = [];
  access.registerEditModeHandler(async (enabled) => { calls.push(enabled); return enabled ? 1800 : null; });
  await access.requestEditMode(false);
  assert.equal(access.editModeActive(), false);
  await access.requestEditMode(true);
  assert.deepEqual(calls, [false, true]);
  assert.equal(access.editModeActive(), true);
  access.setAccessUser(null);
  assert.equal(access.editModeActive(), false);
});
