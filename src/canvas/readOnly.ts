// An admin looking at another user's private canvas without edit mode
// (CANVAS-012c2 item 4): nodes are truly read-only instead of failing on save.
// The node host intercepts edits in the capture phase, so no node component
// needs its own checks: double-click (title/version editing) never arrives,
// changes to controlled fields are dropped (React restores their value), and
// buttons do nothing unless explicitly allowed (fail-closed).
import { createContext, useContext } from "react";

export const CanvasReadOnlyContext = createContext(false);
export function useCanvasReadOnly() {
  return useContext(CanvasReadOnlyContext);
}

// Explicit allowlist of buttons that only show or navigate and stay usable
// while read-only: enter folder, play/pause audio, fullscreen, download,
// info popovers, expand-to-view (and its close), Markdown preview, copy text.
// Every other button is swallowed by default.
export const READ_ONLY_ALLOW_ATTRIBUTE = "data-readonly-allow";

type ElementLike = { closest(selector: string): ElementLike | null; hasAttribute(name: string): boolean };

// Whether a click on `target` must be swallowed while read-only.
export function readOnlyClickBlocked(target: unknown) {
  const element = target as ElementLike | null;
  if (!element || typeof element.closest !== "function") return false;
  const control = element.closest('button, [role="button"]');
  return Boolean(control && !control.hasAttribute(READ_ONLY_ALLOW_ATTRIBUTE));
}
