import { useCallback } from "react";
import { useStoreApi, useUpdateNodeInternals } from "@xyflow/react";

const pending = new WeakMap<object, { ids: Set<string>; frame: number }>();

// One React Flow update per frame instead of one global store update per node.
export function useBatchedNodeInternals() {
  const store = useStoreApi();
  const update = useUpdateNodeInternals();
  return useCallback((id: string) => {
    const queued = pending.get(store);
    if (queued) { queued.ids.add(id); return; }
    const ids = new Set([id]);
    const frame = requestAnimationFrame(() => {
      pending.delete(store);
      const liveIds = [...ids].filter((nodeId) => store.getState().nodeLookup.has(nodeId));
      if (liveIds.length) update(liveIds);
    });
    pending.set(store, { ids, frame });
  }, [store, update]);
}
