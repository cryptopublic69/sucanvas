// Web user accounts: the signed-in user, sign-in/out and the own password change.
import { request } from "./bridge";

export type WebUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  mustChangePassword: boolean;
};
type UserResponse = { user: WebUser };
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function currentUser(): Promise<WebUser> {
  return (await request<UserResponse>("/api/auth/session")).user;
}
export async function signIn(username: string, password: string): Promise<WebUser> {
  return (await request<UserResponse>("/api/auth/login", json({ username: username.trim(), password }))).user;
}
export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<WebUser> {
  return (await request<UserResponse>("/api/auth/password", json({ currentPassword, newPassword }))).user;
}
export async function signOut() {
  await request("/api/auth/logout", { method: "POST" });
}
// Where a signed-in user lands. Used after sign-in, after a forced change and on
// reload alike, so the page shown never depends on how the session was reached.
export function stageFor(user: WebUser): "password" | "ready" {
  return user.mustChangePassword ? "password" : "ready";
}
export function userLabel(user: WebUser | null) {
  return user?.displayName || user?.username || "";
}
// Mirrors the server rule (4–128 characters) so mistakes show before a request.
export function newPasswordProblem(newPassword: string, confirmation: string) {
  const length = Array.from(newPassword).length;
  if (length < 4) return "新密码至少需要 4 个字符";
  if (length > 128) return "新密码不能超过 128 个字符";
  if (newPassword !== confirmation) return "两次输入的新密码不一致";
  return "";
}
