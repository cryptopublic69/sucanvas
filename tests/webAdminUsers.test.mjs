import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
// The bridge is replaced by a recorder; adminUsers.ts only needs `request`.
const bridge = moduleUrl("export const calls = []; export let reply = {}; export function setReply(value) { reply = value; } export async function request(path, options) { calls.push({ path, options }); return reply; }");
const { calls, setReply } = await import(bridge);
const source = (await readFile(new URL("../src/web/adminUsers.ts", import.meta.url), "utf8")).replace('"./bridge"', JSON.stringify(bridge));
const admin = await import(moduleUrl(source));
const body = (call) => JSON.parse(call.options.body);
const user = (id, username, role = "user", extra = {}) => ({ id, username, displayName: null, role, mustChangePassword: false, disabled: false, createdAt: "", updatedAt: "", passwordChangedAt: null, ...extra });

test("every admin action posts to its own endpoint and returns the server result", async () => {
  calls.length = 0;
  setReply({ result: [user("u1", "admin", "admin")] });
  assert.equal((await admin.listUsers())[0].username, "admin");
  assert.equal(calls[0].path, "/api/admin/users");
  assert.equal(calls[0].options, undefined);

  setReply({ result: user("u2", "frank") });
  await admin.createUser({ username: "  frank ", displayName: "  ", role: "user", temporaryPassword: " 临时 " });
  assert.equal(calls[1].path, "/api/admin/users");
  assert.equal(calls[1].options.method, "POST");
  // Blank display name becomes null; the password is sent exactly as typed.
  assert.deepEqual(body(calls[1]), { username: "frank", displayName: null, role: "user", temporaryPassword: " 临时 " });

  await admin.resetUserPassword("a/b", "新的临时");
  await admin.setUserDisabled("u2", true);
  await admin.setUserRole("u2", "admin");
  await admin.setUserDisplayName("u2", " 弗兰克 ");
  assert.deepEqual(calls.slice(2).map((call) => [call.path, body(call)]), [
    ["/api/admin/users/a%2Fb/password", { temporaryPassword: "新的临时" }],
    ["/api/admin/users/u2/disabled", { disabled: true }],
    ["/api/admin/users/u2/role", { role: "admin" }],
    ["/api/admin/users/u2/display-name", { displayName: "弗兰克" }],
  ]);
});

test("deleting a user names who receives the canvases", async () => {
  calls.length = 0;
  setReply({ result: { id: "u2", username: "frank", transferredTo: "u1", transferredToUsername: "admin", transferredCanvases: 3 } });
  const deleted = await admin.deleteUser("u2", "u1");
  assert.equal(deleted.transferredCanvases, 3);
  assert.equal(calls[0].path, "/api/admin/users/u2/delete");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(body(calls[0]), { transferToUserId: "u1" });
});

test("canvases go to the admin account by default, or to the acting admin when admin itself is deleted", () => {
  const users = [user("a", "Admin", "admin"), user("b", "boss", "admin"), user("c", "carol")];
  assert.equal(admin.defaultTransferTarget(users, "c", "b"), "a");
  assert.equal(admin.defaultTransferTarget(users, "a", "b"), "b");
  assert.equal(admin.defaultTransferTarget([user("b", "boss", "admin"), user("c", "carol")], "c", "b"), "b");
});

test("only enabled accounts can receive a deleted user's canvases", () => {
  const users = [user("a", "admin", "admin", { disabled: true }), user("b", "boss", "admin"), user("c", "carol"), user("d", "dave", "user", { disabled: true })];
  assert.deepEqual(admin.transferCandidates(users, "c").map((u) => u.id), ["b"]);
  // A disabled "admin" account is skipped in favour of the acting admin.
  assert.equal(admin.defaultTransferTarget(users, "c", "b"), "b");
  assert.equal(admin.defaultTransferTarget([user("c", "carol"), user("d", "dave", "user", { disabled: true })], "c", "x"), "");
});

test("the Web never seeds built-in workflow modules (desktop paths, admin-only save)", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("const loadOrCreate = async () => {");
  const guard = app.indexOf('if (import.meta.env.MODE === "web") return modules;', start);
  const firstSave = app.indexOf('invoke<WorkflowModuleRecord>("save_workflow_module"', start);
  assert.ok(start > 0 && guard > start && guard < firstSave, "guard must precede the first seeding save");
});

test("temporary passwords use an unambiguous alphabet without modulo bias", () => {
  for (let round = 0; round < 50; round += 1) {
    const password = admin.generateTemporaryPassword();
    assert.equal(password.length, 12);
    assert.match(password, /^[A-HJ-NP-Za-km-np-z2-9]+$/);
  }
  // Values at or above the largest multiple of the alphabet size are skipped.
  const queue = [[0xffffffff, 0, 1, 55], [2]];
  const fill = (values) => { values.fill(0); const next = queue.shift() ?? []; next.forEach((value, index) => { values[index] = value; }); return values; };
  const password = admin.generateTemporaryPassword(4, fill);
  // 56 characters: 0 → A, 1 → B, 55 → 9, then 2 → C from the second draw.
  assert.equal(password, "AB9C");
  assert.equal(admin.generateTemporaryPassword(4).length, 4);
});

test("user times show local date and minutes, and tolerate missing values", () => {
  assert.equal(admin.formatUserTime(null), "—");
  assert.equal(admin.formatUserTime("not a date"), "not a date");
  assert.match(admin.formatUserTime("2026-10-19T08:30:00Z"), /^2026-10-(19|20) \d{2}:30$/);
});

test("only admins get the user management entry and page", async () => {
  const root = await readFile(new URL("../src/web/WebRoot.tsx", import.meta.url), "utf8");
  assert.match(root, /onManageUsers=\{user\.role === "admin" \? /);
  assert.match(root, /managingUsers && user\.role === "admin" && <UsersPage/);
  const menu = await readFile(new URL("../src/web/AccountScreens.tsx", import.meta.url), "utf8");
  assert.match(menu, /\{onManageUsers && <button[^>]*>.*用户管理<\/button>\}/);
});
