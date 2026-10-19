// Admin user management: requests behind the "用户管理" page plus the small
// rules it shows (temporary passwords, transfer target, dates). The server
// checks the admin role on every request; nothing here is a security boundary.
import { request } from "./bridge";
import type { WebUser } from "./account";

export type ManagedUser = WebUser & {
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  passwordChangedAt: string | null;
};
export type DeletedUser = {
  id: string;
  username: string;
  transferredTo: string;
  transferredToUsername: string;
  transferredCanvases: number;
};
export type NewUser = { username: string; displayName: string; role: WebUser["role"]; temporaryPassword: string };

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const userPath = (id: string, action: string) => `/api/admin/users/${encodeURIComponent(id)}/${action}`;
async function result<T>(path: string, options?: RequestInit): Promise<T> {
  return (await request<{ result: T }>(path, options)).result;
}

export function listUsers() {
  return result<ManagedUser[]>("/api/admin/users");
}
export function createUser(input: NewUser) {
  const displayName = input.displayName.trim();
  return result<ManagedUser>("/api/admin/users", post({
    username: input.username.trim(), displayName: displayName || null, role: input.role, temporaryPassword: input.temporaryPassword,
  }));
}
export function resetUserPassword(id: string, temporaryPassword: string) {
  return result<ManagedUser>(userPath(id, "password"), post({ temporaryPassword }));
}
export function setUserDisabled(id: string, disabled: boolean) {
  return result<ManagedUser>(userPath(id, "disabled"), post({ disabled }));
}
export function setUserRole(id: string, role: WebUser["role"]) {
  return result<ManagedUser>(userPath(id, "role"), post({ role }));
}
export function setUserDisplayName(id: string, displayName: string) {
  return result<ManagedUser>(userPath(id, "display-name"), post({ displayName: displayName.trim() || null }));
}
export function deleteUser(id: string, transferToUserId: string) {
  return result<DeletedUser>(userPath(id, "delete"), post({ transferToUserId }));
}

// No look-alike characters (0/O, 1/l/I), so a password read aloud or copied by hand survives.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export function generateTemporaryPassword(length = 12, fill: (values: Uint32Array) => Uint32Array = (values) => crypto.getRandomValues(values)) {
  // Rejection sampling keeps every character equally likely.
  const limit = Math.floor(2 ** 32 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let password = "";
  while (password.length < length) {
    for (const value of fill(new Uint32Array(length))) {
      if (value < limit && password.length < length) password += PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length];
    }
  }
  return password;
}

// Who may receive a deleted user's canvases: enabled accounts other than the
// one being deleted (the server refuses disabled receivers too).
export function transferCandidates(users: ManagedUser[], deletingId: string) {
  return users.filter((user) => user.id !== deletingId && !user.disabled);
}

// Canvases of a deleted user go to the "admin" account by default; when that
// is the one being deleted (or disabled), to the admin doing the deletion.
export function defaultTransferTarget(users: ManagedUser[], deletingId: string, actorId: string) {
  const candidates = transferCandidates(users, deletingId);
  const admin = candidates.find((user) => user.username.toLowerCase() === "admin");
  return admin?.id ?? candidates.find((user) => user.id === actorId)?.id ?? candidates[0]?.id ?? "";
}

export function formatUserTime(value: string | null) {
  if (!value) return "—";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  const two = (part: number) => String(part).padStart(2, "0");
  return `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
}
