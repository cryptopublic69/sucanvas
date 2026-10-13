import { useEffect } from "react";
import { useStore, useStoreApi } from "@xyflow/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { posterMemoryCache, requestVideoPoster } from "../videoPosterCache";
import type { CanvasFlowNode } from "../CanvasNode";
import { versionedPreviewUrl } from "./previewCache";
import { requestVisiblePosters, visiblePosterSources } from "./viewportPosterQueue";
import { WEB_POSTER_CONCURRENCY } from "./posterExtractionQueue";

export function WebViewportPosters() {
  const store = useStoreApi();
  const changes = useStore(state => [state.nodes, state.transform, state.width, state.height] as const,
    (a, b) => a.every((value, index) => value === b[index]));
  useEffect(() => {
    let stopped = false;
    let cancel: (() => void) | undefined;
    let retries = 0;
    const run = () => {
      if (stopped) return;
      const state = store.getState();
      const [tx, ty, zoom] = state.transform;
      const candidates = [];
      for (const node of state.nodeLookup.values()) {
        const record = (node as unknown as CanvasFlowNode).data.record;
        if (!record || node.hidden || record.content.generationPlaceholder === true) continue;
        const src = record.kind === "generated-video" && typeof record.content.videoUrl === "string"
          ? versionedPreviewUrl(record.content.videoUrl, typeof record.content.comfyPromptId === "string" ? record.content.comfyPromptId : "")
          : record.kind === "video" && typeof record.content.assetPath === "string"
            ? convertFileSrc(record.content.assetPath) : "";
        const position = node.internals.positionAbsolute;
        candidates.push({ src, x: position.x * zoom + tx, y: position.y * zoom + ty,
          width: (node.measured.width ?? record.width) * zoom, height: (node.measured.height ?? record.height) * zoom });
      }
      const missing = visiblePosterSources(candidates, state.width, state.height).filter(src => !posterMemoryCache.peek(src));
      cancel = requestVisiblePosters(missing, (src, complete) => requestVideoPoster(src, () => complete()), () => {
        if (!stopped && retries < 2 && missing.some(src => !posterMemoryCache.peek(src))) {
          timer = window.setTimeout(run, [2500, 10000][retries++]);
        }
      }, WEB_POSTER_CONCURRENCY);
    };
    let timer = window.setTimeout(run, 160);
    return () => { stopped = true; window.clearTimeout(timer); cancel?.(); };
  }, [changes, store]);
  return null;
}
