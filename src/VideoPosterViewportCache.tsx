import { useEffect } from "react";
import { useStore, useStoreApi } from "@xyflow/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { preloadCachedVideoPosters } from "./videoPosterCache";
import type { CanvasFlowNode } from "./CanvasNode";

// Prewarm covers 320 screen pixels beyond the viewport. Keep React Flow's
// node virtualization; moving the canvas must not mount distant players.
export function VideoPosterViewportCache() {
  const store = useStoreApi();
  const changes = useStore((state) => [state.nodes, state.transform, state.width, state.height] as const,
    (a, b) => a.every((value, index) => value === b[index]));
  useEffect(() => {
    let release: (() => void) | undefined;
    const timer = window.setTimeout(() => {
    const state = store.getState();
    const [tx, ty, zoom] = state.transform;
    const candidates: { src: string; distance: number }[] = [];
    for (const node of state.nodeLookup.values()) {
      const record = (node as unknown as CanvasFlowNode).data.record;
      if (!record || node.hidden) continue;
      const position = node.internals.positionAbsolute;
      const x = position.x * zoom + tx;
      const y = position.y * zoom + ty;
      const w = (node.measured.width ?? record.width) * zoom;
      const h = (node.measured.height ?? record.height) * zoom;
      if (x + w < -320 || y + h < -320 || x > state.width + 320 || y > state.height + 320) continue;
      const src = record.kind === "generated-video" && typeof record.content.videoUrl === "string"
        ? record.content.videoUrl
        : record.kind === "video" && typeof record.content.assetPath === "string"
          ? convertFileSrc(record.content.assetPath) : "";
      if (src) candidates.push({ src, distance: Math.abs(x + w / 2 - state.width / 2) + Math.abs(y + h / 2 - state.height / 2) });
    }
    const sources = [...new Set(candidates.sort((a, b) => a.distance - b.distance).map((item) => item.src))].slice(0, 100);
    release = preloadCachedVideoPosters(sources);
    }, 160);
    return () => { window.clearTimeout(timer); release?.(); };
  }, [changes, store]);
  return null;
}
