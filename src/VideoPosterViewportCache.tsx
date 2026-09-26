import { useEffect } from "react";
import { useStore } from "@xyflow/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { preloadCachedVideoPosters } from "./videoPosterCache";
import type { CanvasFlowNode } from "./CanvasNode";

// Prewarm covers 320 screen pixels beyond the viewport. Keep React Flow's
// node virtualization; moving the canvas must not mount distant players.
export function VideoPosterViewportCache() {
  const sources = useStore((state) => {
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
    return [...new Set(candidates.sort((a, b) => a.distance - b.distance).map((item) => item.src))].slice(0, 100).sort();
  }, (a, b) => a.length === b.length && a.every((src, index) => src === b[index]));
  useEffect(() => preloadCachedVideoPosters(sources), [sources]);
  return null;
}
