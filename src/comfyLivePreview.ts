// Bound optional live previews before JSON/base64 decoding. Final outputs use a separate path.
export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_TEXT_LENGTH = Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 4096;
const MAX_STATUS_TEXT_LENGTH = 1024 * 1024;

export function comfyStatusMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string" || data.length > MAX_STATUS_TEXT_LENGTH
    || data.includes('"kj_preview_override"')) return null;
  try {
    const message: unknown = JSON.parse(data);
    return message && typeof message === "object" && !Array.isArray(message)
      ? message as Record<string, unknown> : null;
  } catch { return null; }
}

function isComfyPreviewSocketData(data: unknown): boolean {
  if (typeof data === "string") {
    return data.length <= MAX_PREVIEW_TEXT_LENGTH && data.includes('"kj_preview_override"');
  }
  if (data instanceof Blob) return data.size <= MAX_PREVIEW_BYTES + 8;
  return data instanceof ArrayBuffer && data.byteLength <= MAX_PREVIEW_BYTES + 8;
}

function blobFromBase64(base64: string, mimeType: string): Blob | null {
  try {
    if (base64.length > MAX_PREVIEW_TEXT_LENGTH) return null;
    const decoded = atob(base64);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

export async function comfyPreviewImageBlobFromSocketData(
  data: unknown,
  expectedNodeId = "",
): Promise<Blob | null> {
  if (!isComfyPreviewSocketData(data)) return null;
  if (typeof data === "string") {
    try {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.type !== "kj_preview_override" || !message.data || typeof message.data !== "object") {
        return null;
      }
      const previewData = message.data as Record<string, unknown>;
      const rawNodeId = previewData.node_id ?? previewData.node;
      const nodeId = typeof rawNodeId === "string" || typeof rawNodeId === "number"
        ? String(rawNodeId)
        : "";
      // ModelPreviewOverrideKJ versions differ on whether they include an ID,
      // whether it is numeric, and whether it is named `node` or `node_id`.
      // The socket is already scoped to the active ComfyUI client, so a preview
      // event without an ID remains safe to display for this generation.
      if (expectedNodeId && nodeId && nodeId !== expectedNodeId) return null;
      const base64 = typeof previewData.image === "string" ? previewData.image : "";
      const mimeType = typeof previewData.mime === "string"
        ? previewData.mime.toLowerCase()
        : "image/jpeg";
      if (!base64 || !["image/jpeg", "image/png", "image/webp", "video/mp4"].includes(mimeType)) {
        return null;
      }
      return blobFromBase64(base64, mimeType);
    } catch {
      return null;
    }
  }
  const buffer = data instanceof ArrayBuffer
    ? data
    : data instanceof Blob
      ? await data.arrayBuffer()
      : null;
  if (!buffer || buffer.byteLength <= 8) return null;
  const header = new DataView(buffer, 0, 8);
  if (header.getUint32(0, false) !== 1) return null;
  const imageType = header.getUint32(4, false);
  const mimeType = imageType === 2 ? "image/png" : "image/jpeg";
  return new Blob([new Uint8Array(buffer, 8)], { type: mimeType });
}

let previewDecodeBusy = false;

// Drop superseded frames instead of accumulating asynchronous decode work per socket.
export function createComfyPreviewReceiver(
  nodeId: string,
  isActive: () => boolean,
  onPreview: (preview: Blob) => void,
): (data: unknown) => void {
  let busy = false;
  let lastAccepted = -Infinity;
  return (data) => {
    if (!isActive() || busy || previewDecodeBusy || !isComfyPreviewSocketData(data)) return;
    const now = performance.now();
    if (now - lastAccepted < 250) return;
    lastAccepted = now;
    busy = true;
    previewDecodeBusy = true;
    void comfyPreviewImageBlobFromSocketData(data, nodeId).then((preview) => {
      if (preview && isActive()) onPreview(preview);
    }).catch(() => {}).finally(() => { busy = false; previewDecodeBusy = false; });
  };
}

// A displayed (including paused) preview keeps its URL. Superseded, undisplayed
// previews are retired after a short React commit grace period, not at task end.
export class LivePreviewResourcePool {
  private retainedBytes = 0;
  private entries = new Map<string, { bytes: number; users: number; retired: boolean; timer?: ReturnType<typeof setTimeout> }>();
  constructor(
    private urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
    private graceMs = 1000,
    private maxBytes = 64 * 1024 * 1024,
  ) {}

  create(blob: Blob): string | null {
    if (this.retainedBytes + blob.size > this.maxBytes) return null;
    const url = this.urls.createObjectURL(blob);
    this.entries.set(url, { bytes: blob.size, users: 0, retired: false });
    this.retainedBytes += blob.size;
    return url;
  }

  retain(url: string | undefined): () => void {
    const entry = url ? this.entries.get(url) : undefined;
    if (!entry || !url) return () => {};
    entry.users++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.users--;
      this.collect(url);
    };
  }

  retire(url: string): void {
    const entry = this.entries.get(url);
    if (!entry || entry.retired) return;
    entry.retired = true;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.collect(url);
    }, this.graceMs);
  }

  private collect(url: string): void {
    const entry = this.entries.get(url);
    if (!entry || !entry.retired || entry.timer !== undefined || entry.users) return;
    this.urls.revokeObjectURL(url);
    this.entries.delete(url);
    this.retainedBytes -= entry.bytes;
  }

  clear(): void {
    for (const [url, entry] of this.entries) {
      clearTimeout(entry.timer);
      this.urls.revokeObjectURL(url);
    }
    this.entries.clear();
    this.retainedBytes = 0;
  }
}

export const livePreviewResources = new LivePreviewResourcePool();
