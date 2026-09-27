export interface CanvasViewport { x: number; y: number; zoom: number }
const key = (id: string) => `infinite-canvas:viewport:${id}`;
export function readCanvasViewport(storage: Pick<Storage, "getItem">, id: string): CanvasViewport | null {
  try {
    const value = JSON.parse(storage.getItem(key(id)) ?? "null");
    return value && [value.x, value.y, value.zoom].every((part) => typeof part === "number" && Number.isFinite(part))
      && value.zoom >= 0.12 && value.zoom <= 2.2 ? { x: value.x, y: value.y, zoom: value.zoom } : null;
  } catch { return null; }
}
export function saveCanvasViewport(storage: Pick<Storage, "setItem">, id: string, viewport: CanvasViewport) {
  try { storage.setItem(key(id), JSON.stringify(viewport)); } catch { /* Storage must not block navigation. */ }
}
export function initialCanvasViewport(nodes: { x: number; y: number; width: number; height: number }[], width: number, height: number): CanvasViewport {
  const first = nodes[0];
  if (!first) return { x: 0, y: 0, zoom: 1 };
  const zoom = Math.max(0.12, Math.min(0.8, (width - 80) / Math.max(first.width, 1), (height - 140) / Math.max(first.height, 1)));
  return { x: width / 2 - (first.x + first.width / 2) * zoom, y: height / 2 - (first.y + first.height / 2) * zoom, zoom };
}
