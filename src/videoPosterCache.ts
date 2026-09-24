import { videoPreviewScheduler } from "./videoPreviewScheduler";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type VideoPoster = { src: string; blob: Blob; width: number; height: number; createdAt: number };
const MAX_POSTERS = 300;
const failedSources = new Set<string>();
const pending = new Map<string, { listeners: Set<(poster: VideoPoster | null) => void>; cancel: () => void }>();
let database: Promise<IDBDatabase | null> | undefined;

function openCache(): Promise<IDBDatabase | null> {
  if (!database) database = new Promise((resolve) => {
    try {
      const request = indexedDB.open("infinite-canvas-video-posters", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("posters", { keyPath: "src" }).createIndex("createdAt", "createdAt");
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return database;
}

async function readPoster(src: string): Promise<VideoPoster | null> {
  const db = await openCache();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction("posters").objectStore("posters").get(src);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function writePoster(poster: VideoPoster): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction("posters", "readwrite");
      transaction.oncomplete = transaction.onabort = transaction.onerror = () => resolve();
      const store = transaction.objectStore("posters");
      store.put(poster);
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_POSTERS;
        if (excess <= 0) return;
        const cursor = store.index("createdAt").openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result || excess-- <= 0) return;
          cursor.result.delete();
          cursor.result.continue();
        };
      };
    } catch { resolve(); }
  });
}

function capturePoster(src: string, signal: AbortSignal): Promise<VideoPoster | null> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const video = document.createElement("video");
    let done = false;
    const finish = (poster: VideoPoster | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      video.onloadeddata = video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      resolve(poster);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, 8000);
    signal.addEventListener("abort", abort, { once: true });
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = abort;
    video.onloadeddata = () => {
      if (!video.videoWidth || !video.videoHeight) { finish(null); return; }
      const width = video.videoWidth;
      const height = video.videoHeight;
      const scale = Math.min(1, 480 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      try {
        const context = canvas.getContext("2d");
        if (!context) { finish(null); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob ? { src, blob, width, height, createdAt: Date.now() } : null), "image/jpeg", 0.72);
      } catch { finish(null); }
    };
    video.src = src;
    video.load();
  });
}

async function extractPoster(src: string, signal: AbortSignal): Promise<VideoPoster | null> {
  // ComfyUI commonly has no CORS headers. Native extraction avoids downloading
  // entire remote videos into JS merely to capture one frame.
  if (isTauri() && /^https?:\/\//.test(src) && new URL(src).hostname !== "asset.localhost") {
    try {
      const bytes = await invoke<number[]>("capture_video_poster", { source: src });
      if (signal.aborted) return null;
      return { src, blob: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), width: 0, height: 0, createdAt: Date.now() };
    } catch {
      if (signal.aborted) return null;
      // FFmpeg is optional. Try browser extraction before leaving a placeholder.
    }
  }
  return capturePoster(src, signal);
}

// Requests are deduplicated, cancellable, and decoded serially. Only mounted
// previews request posters; unmounting the last consumer releases the decoder.
export function requestVideoPoster(src: string, listener: (poster: VideoPoster | null) => void): () => void {
  const existing = pending.get(src);
  if (existing) {
    existing.listeners.add(listener);
    return () => unsubscribe(src, existing, listener);
  }
  const entry = { listeners: new Set([listener]), cancel: () => {} };
  pending.set(src, entry);
  entry.cancel = videoPreviewScheduler.enqueue(async (signal) => {
    let poster = await readPoster(src);
    if (signal.aborted) return;
    if (!poster && !failedSources.has(src)) {
      poster = await extractPoster(src, signal);
      if (signal.aborted) return;
      if (poster) await writePoster(poster);
      else {
        failedSources.add(src);
        if (failedSources.size > MAX_POSTERS) failedSources.delete(failedSources.values().next().value!);
      }
    }
    if (signal.aborted) return;
    pending.delete(src);
    entry.listeners.forEach((callback) => callback(poster));
  });
  return () => unsubscribe(src, entry, listener);
}

function unsubscribe(src: string, entry: { listeners: Set<(poster: VideoPoster | null) => void>; cancel: () => void }, listener: (poster: VideoPoster | null) => void) {
  entry.listeners.delete(listener);
  if (entry.listeners.size === 0) {
    entry.cancel();
    if (pending.get(src) === entry) pending.delete(src);
  }
}
