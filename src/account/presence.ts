// "Someone else is on this canvas" (CANVAS-012c3, design §6; Web only).
// The server keeps heartbeats in memory and pushes presence://changed only to
// users who may read the canvas. Project deletions, moves and sharing changes
// arrive as canvas://access-changed, sent only to users whose access changed.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type PresentUser = { userId: string; username: string; displayName: string | null };
export type AccessChange = { canvasId: string; reason: "deleted" | "revoked" | "changed" };

// Same interval as the server's presence::HEARTBEAT_SECONDS (it expires a tab
// after presence::TIMEOUT_SECONDS without one).
export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_EVENT = "presence://changed";
export const ACCESS_EVENT = "canvas://access-changed";

// One id per page load: several tabs of one user are separate tabs on the
// server but are shown as one user.
const TAB_ID = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random()}`;

// Other users on the canvas, each once.
export function othersPresent(users: PresentUser[], selfId: string | null | undefined) {
  const seen = new Set<string>();
  return users.filter((user) => {
    if (user.userId === selfId || seen.has(user.userId)) return false;
    seen.add(user.userId);
    return true;
  });
}

export function presenceLabel(others: PresentUser[]) {
  const names = others.map((user) => user.displayName || user.username);
  if (!names.length) return "";
  if (names.length <= 3) return `${names.join("、")} 也在这张画布`;
  return `${names.slice(0, 3).join("、")} 等 ${names.length} 人也在这张画布`;
}

// An open project that was deleted or is no longer readable is left; every
// other change only refreshes lists (and the open project's ownership info).
export function accessChangeAction(change: AccessChange, openRootId: string | null): "leave" | "refresh" {
  return openRootId !== null && change.canvasId === openRootId && change.reason !== "changed" ? "leave" : "refresh";
}

export function accessChangeNotice(change: AccessChange) {
  return change.reason === "deleted" ? "这张画布已被删除，已返回项目首页" : "你已无权访问这张画布，已返回项目首页";
}

// Heartbeats for the canvas on screen; returns everyone on it (the caller included).
// Presence is best effort: failures are silent and never become a notice.
export function useCanvasPresence(canvasId: string | null, enabled: boolean) {
  const [users, setUsers] = useState<PresentUser[]>([]);
  useEffect(() => {
    if (!enabled) return;
    if (!canvasId) {
      setUsers([]);
      void invoke("presence_leave", { tabId: TAB_ID }).catch(() => undefined);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const beat = async () => {
      try {
        const reply = await invoke<{ users: PresentUser[] }>("presence_heartbeat", { canvasId, tabId: TAB_ID });
        if (!cancelled) setUsers(reply.users);
      } catch {
        // Lost access arrives as canvas://access-changed; nothing to show here.
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), PRESENCE_HEARTBEAT_MS);
    void listen<{ canvasId: string; users: PresentUser[] }>(PRESENCE_EVENT, (event) => {
      if (!cancelled && event.payload.canvasId === canvasId) setUsers(event.payload.users);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      unlisten?.();
      setUsers([]);
    };
  }, [canvasId, enabled]);
  useEffect(() => {
    if (!enabled) return;
    // Closing the tab leaves at once; without it the server times the tab out.
    const leave = () => {
      navigator.sendBeacon?.("/api/invoke/presence_leave", new Blob([JSON.stringify({ args: { tabId: TAB_ID } })], { type: "application/json" }));
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [enabled]);
  return users;
}
