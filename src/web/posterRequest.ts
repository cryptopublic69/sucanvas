import { withRequestTimeout } from "./requestTimeout";

export async function requestPosterBlob(src: string, signal: AbortSignal): Promise<Blob> {
  return withRequestTimeout(async requestSignal => {
    const query = new URLSearchParams({ source: src });
    const response = await fetch(`/api/video-poster?${query}`, { credentials: "same-origin", cache: "no-store", signal: requestSignal });
    if (!response.ok) throw new Error(`封面加载失败 (${response.status})`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || !blob.size || blob.size > 1024 * 1024) throw new Error("无效的视频封面");
    return blob;
  }, 45_000, signal);
}
