import { useEffect, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import { NODE_HANDLE_BASE_SIZE_PX, NODE_HANDLE_MIN_SCREEN_SIZE_PX } from "../CanvasNode";

// Writes --node-handle-screen-scale straight onto the .react-flow element.
// Subscribing to zoom through useStore in App re-rendered the whole app on every zoom frame.
export function NodeHandleScaleSync() {
  const store = useStoreApi();
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const target = marker.current?.closest<HTMLElement>(".react-flow");
    if (!target) return;
    let applied = Number.NaN;
    const apply = (zoom: number) => {
      const scale = Math.max(1, NODE_HANDLE_MIN_SCREEN_SIZE_PX / (NODE_HANDLE_BASE_SIZE_PX * Math.max(zoom, 0.01)));
      if (scale === applied) return;
      applied = scale;
      target.style.setProperty("--node-handle-screen-scale", String(scale));
    };
    apply(store.getState().transform[2]);
    return store.subscribe((state) => apply(state.transform[2]));
  }, [store]);
  return <span ref={marker} hidden />;
}
