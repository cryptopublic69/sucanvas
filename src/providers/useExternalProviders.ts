import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelExternalVideoJob,
  confirmExternalVideoJob,
  fetchExternalProvidersStatus,
  submitExternalVideoJob,
} from "./api";
import { createFallbackProvidersMap } from "./catalog";
import type {
  ExternalProvidersController,
  ExternalProvidersNodeContext,
  ExternalVideoJobRecord,
  ExternalVideoProviderId,
  ExternalVideoSubmitPayload,
  ProviderStatusSnapshot,
} from "./types";

export function useExternalProviders({
  enabled,
  authenticated,
}: {
  enabled: boolean;
  authenticated: boolean;
}): ExternalProvidersController {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [providersById, setProvidersById] = useState<
    Record<ExternalVideoProviderId, ProviderStatusSnapshot>
  >(() => createFallbackProvidersMap());

  const refresh = useCallback(async () => {
    if (!enabled || !authenticated) return;
    setLoading(true);
    setError("");
    try {
      const list = await fetchExternalProvidersStatus();
      setProvidersById((prev) => {
        const next = { ...prev };
        for (const item of list) {
          next[item.provider] = item;
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [enabled, authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitVideo = useCallback(
    async (payload: ExternalVideoSubmitPayload): Promise<ExternalVideoJobRecord> => (
      submitExternalVideoJob(payload)
    ),
    [],
  );

  const confirmVideo = useCallback(
    async (jobId: string): Promise<ExternalVideoJobRecord> => confirmExternalVideoJob(jobId),
    [],
  );

  const cancelVideo = useCallback(
    async (jobId: string): Promise<ExternalVideoJobRecord> => cancelExternalVideoJob(jobId),
    [],
  );

  const providers = useMemo(
    () => Object.values(providersById),
    [providersById],
  );

  const nodeContext = useMemo<ExternalProvidersNodeContext>(() => ({
    enabled,
    loading,
    providersById,
    onConfirmJob: confirmVideo,
    onCancelJob: cancelVideo,
  }), [enabled, loading, providersById, confirmVideo, cancelVideo]);

  return {
    enabled,
    loading,
    error,
    providers,
    providersById,
    refresh,
    submitVideo,
    confirmVideo,
    cancelVideo,
    nodeContext,
  };
}
