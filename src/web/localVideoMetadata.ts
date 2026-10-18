import type { UploadedVideoMetadata } from "../media/uploadedVideoMetadata";

export const LOCAL_VIDEO_METADATA_TIMEOUT_MS = 3000;

// Reads a dropped video's size from the local File, so the node can be sized without waiting for the network.
export function readLocalVideoMetadata(file: File, timeoutMs = LOCAL_VIDEO_METADATA_TIMEOUT_MS): Promise<UploadedVideoMetadata | null> {
  if (!file.type.startsWith("video/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (metadata: UploadedVideoMetadata | null) => {
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(metadata);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(video.videoWidth > 0 && video.videoHeight > 0
      ? { width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : 0 }
      : null);
    video.onerror = () => finish(null);
    video.src = url;
  });
}
