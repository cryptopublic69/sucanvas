import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
// The bridge is replaced by a recorder; account.ts only needs `request`.
const bridge = moduleUrl("export const calls = []; export let reply = {}; export function setReply(value) { reply = value; } export async function request(path, options) { calls.push({ path, options }); return reply; }");
const { calls, setReply } = await import(bridge);
const source = (await readFile(new URL("../src/web/account.ts", import.meta.url), "utf8")).replace('"./bridge"', JSON.stringify(bridge));
const account = await import(moduleUrl(source));
const user = { id: "u1", username: "frank", displayName: null, role: "user", mustChangePassword: true };

test("sign-in sends the username and password and returns the account", async () => {
  calls.length = 0;
  setReply({ ok: true, user });
  assert.deepEqual(await account.signIn("  Frank ", "临时 密码 "), user);
  assert.equal(calls[0].path, "/api/auth/login");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { username: "Frank", password: "临时 密码 " });
});

test("the own password change sends the current and new password", async () => {
  calls.length = 0;
  setReply({ ok: true, user: { ...user, mustChangePassword: false } });
  const next = await account.changeOwnPassword("临时密码", "自己的密码");
  assert.equal(next.mustChangePassword, false);
  assert.equal(calls[0].path, "/api/auth/password");
  assert.deepEqual(JSON.parse(calls[0].options.body), { currentPassword: "临时密码", newPassword: "自己的密码" });
});

test("the session endpoint and the stage decision agree before and after a reload", async () => {
  calls.length = 0;
  setReply({ ok: true, publicUrl: "https://canvas.example.com", user });
  const reloaded = await account.currentUser();
  assert.equal(calls[0].path, "/api/auth/session");
  // Same answer whether the user just signed in or reloaded the page.
  assert.equal(account.stageFor(user), "password");
  assert.equal(account.stageFor(reloaded), "password");
  assert.equal(account.stageFor({ ...user, mustChangePassword: false }), "ready");
});

test("new password rules match the server", () => {
  assert.equal(account.newPasswordProblem("abc", "abc"), "新密码至少需要 4 个字符");
  assert.equal(account.newPasswordProblem("密码四个", "密码四个"), "");
  assert.equal(account.newPasswordProblem("密".repeat(129), "密".repeat(129)), "新密码不能超过 128 个字符");
  assert.equal(account.newPasswordProblem("abcd", "abce"), "两次输入的新密码不一致");
});

test("the user menu label prefers the display name", () => {
  assert.equal(account.userLabel({ ...user, displayName: "弗兰克" }), "弗兰克");
  assert.equal(account.userLabel(user), "frank");
  assert.equal(account.userLabel(null), "");
});
