// Who is signed in (Web only) and what the canvas UI may offer them. The
// server enforces every rule; these helpers only keep the interface honest.
// On the desktop no user is ever set and everything stays available.
import { useSyncExternalStore } from "react";

export type AccessUser = { id: string; username: string; displayName: string | null; role: "admin" | "user" };
// Root-canvas ownership the server adds to project records (CANVAS-012b).
export type CanvasOwnership = {
  rootCanvasId?: string;
  ownerUserId?: string | null;
  ownerUsername?: string | null;
  ownerDisplayName?: string | null;
  isShared?: boolean;
};
export type ProjectSection = "mine" | "shared" | "others";

type AccessState = { user: AccessUser | null; editModeUntil: number };
let state: AccessState = { user: null, editModeUntil: 0 };
const listeners = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let editModeHandler: ((enabled: boolean) => Promise<number | null>) | null = null;

function publish(next: AccessState) {
  state = next;
  clearTimeout(expiryTimer);
  const left = next.editModeUntil - Date.now();
  // Re-render when edit mode switches itself off.
  if (left > 0) expiryTimer = setTimeout(() => publish({ ...state }), left + 50);
  listeners.forEach((listener) => listener());
}
export function setAccessUser(user: AccessUser | null, editModeSeconds: number | null = null) {
  publish({ user, editModeUntil: editModeSeconds ? Date.now() + editModeSeconds * 1000 : 0 });
}
export function currentAccessUser() {
  return state.user;
}
// WebRoot provides the request; App only asks for edit mode on or off.
export function registerEditModeHandler(handler: typeof editModeHandler) {
  editModeHandler = handler;
}
export async function requestEditMode(enabled: boolean) {
  if (!editModeHandler) return;
  const seconds = await editModeHandler(enabled);
  publish({ ...state, editModeUntil: seconds ? Date.now() + seconds * 1000 : 0 });
}
export function editModeActive(now = Date.now()) {
  return state.editModeUntil > now;
}
export function useAccess() {
  const snapshot = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => state,
  );
  return { user: snapshot.user, editModeActive: snapshot.editModeUntil > Date.now() };
}

// Accounts an admin may hand a canvas to (enabled only). WebRoot provides the
// request so shared code never imports the Web API.
export type AssignableUser = { id: string; username: string; displayName: string | null; role: "admin" | "user" };
let assignableUsersHandler: (() => Promise<AssignableUser[]>) | null = null;
export function registerAssignableUsersHandler(handler: typeof assignableUsersHandler) {
  assignableUsersHandler = handler;
}
export async function assignableUsers(): Promise<AssignableUser[]> {
  return assignableUsersHandler ? assignableUsersHandler() : [];
}

// No user means the desktop (or the Web before sign-in): nothing is restricted.
export function isAdministrator(user: AccessUser | null) {
  return !user || user.role === "admin";
}
export function projectSection(canvas: CanvasOwnership, user: AccessUser | null): ProjectSection {
  if (canvas.isShared) return "shared";
  if (!user || canvas.ownerUserId === user.id) return "mine";
  return "others";
}
export type ProjectGroups<T> = {
  mine: T[];
  shared: T[];
  // Admin only: other users' private canvases by owner; ownerless ones last.
  others: { key: string; label: string; projects: T[] }[];
};
export function groupProjects<T extends { canvas: CanvasOwnership }>(projects: T[], user: AccessUser | null): ProjectGroups<T> {
  const groups: ProjectGroups<T> = { mine: [], shared: [], others: [] };
  const owners = new Map<string, { key: string; label: string; projects: T[] }>();
  for (const project of projects) {
    const section = projectSection(project.canvas, user);
    if (section !== "others") { groups[section].push(project); continue; }
    const key = project.canvas.ownerUserId ?? "";
    const label = key
      ? project.canvas.ownerDisplayName || project.canvas.ownerUsername || "未知用户"
      : "无主画布";
    if (!owners.has(key)) owners.set(key, { key, label, projects: [] });
    owners.get(key)!.projects.push(project);
  }
  groups.others = [...owners.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.label.localeCompare(b.label, "zh-CN"));
  return groups;
}
// Delete button on the home page. Admins may delete any project; other users'
// private ones go through the separate, audited admin delete (CANVAS-012c2).
export function canDeleteProject(canvas: CanvasOwnership, user: AccessUser | null) {
  if (!user) return true;
  if (user.role === "admin") return true;
  return !canvas.isShared && canvas.ownerUserId === user.id;
}
// Confirmation text for deleting another user's private canvas, else null.
export function othersPrivateDeleteWarning(canvas: CanvasOwnership, user: AccessUser | null) {
  if (!user || user.role !== "admin" || projectSection(canvas, user) !== "others") return null;
  return `这是 ${ownerLabel(canvas) || "其他用户"} 的私有画布，删除后不可恢复。`;
}
// Anyone may copy a shared project into their own canvases.
export function canCopyProject(canvas: CanvasOwnership, user: AccessUser | null) {
  return Boolean(user && canvas.isShared);
}
// An admin looking at someone else's private canvas reads it until edit mode is on.
export function readOnlyCanvas(canvas: CanvasOwnership | null | undefined, user: AccessUser | null, editMode: boolean) {
  if (!user || !canvas || user.role !== "admin" || editMode) return false;
  return !canvas.isShared && Boolean(canvas.ownerUserId) && canvas.ownerUserId !== user.id;
}
export function ownerLabel(canvas: CanvasOwnership) {
  return canvas.ownerDisplayName || canvas.ownerUsername || "";
}
// Private content may only be pasted into a canvas of the same owner that is
// not shared; shared content may go anywhere (decision 1, front-end only).
export function pasteAllowed(source: CanvasOwnership | null | undefined, target: CanvasOwnership | null | undefined) {
  if (!source || !target) return true;
  if (source.rootCanvasId && source.rootCanvasId === target.rootCanvasId) return true;
  if (source.isShared) return true;
  return !target.isShared && (target.ownerUserId ?? null) === (source.ownerUserId ?? null);
}
