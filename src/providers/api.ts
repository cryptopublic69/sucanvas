import { request } from "../web/bridge";
import type {
  ExternalVideoJobRecord,
  ExternalVideoSubmitPayload,
  ProviderStatusSnapshot,
} from "./types";

export async function fetchExternalProvidersStatus(): Promise<ProviderStatusSnapshot[]> {
  const data = await request<{ providers?: ProviderStatusSnapshot[] }>(
    "/api/external-providers/status",
    undefined,
    25_000,
  );
  return Array.isArray(data.providers) ? data.providers : [];
}

export async function submitExternalVideoJob(
  payload: ExternalVideoSubmitPayload,
): Promise<ExternalVideoJobRecord> {
  return request<ExternalVideoJobRecord>("/api/external-providers/video/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function confirmExternalVideoJob(
  jobId: string,
): Promise<ExternalVideoJobRecord> {
  return request<ExternalVideoJobRecord>(
    `/api/external-providers/video/${encodeURIComponent(jobId)}/confirm`,
    { method: "POST" },
  );
}

export async function cancelExternalVideoJob(
  jobId: string,
): Promise<ExternalVideoJobRecord> {
  return request<ExternalVideoJobRecord>(
    `/api/external-providers/video/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}
