import { videoPreviewScheduler } from "./videoPreviewScheduler";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type VideoPoster = { src: string; blob: Blob; width: number; height: number; createdAt: number };
const MAX_POSTERS = 300;
const MAX_POSTER_BYTES = 1024 * 1024;
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
      if (signal.aborted || !bytes.length || bytes.length > MAX_POSTER_BYTES) return null;
      return { src, blob: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), width: 0, height: 0, createdAt: Date.now() };
    } catch {
      // Never decode a remote source in a hidden WebView player after native
      // extraction fails. Newly generated files may not be readable yet.
      return null;
    }
  }
  return capturePoster(src, signal);
}

// Keep compressed posters and stable URLs across node unmounts. Active images
// are pinned; only unused entries participate in eviction.
export class PosterMemoryCache {
  private entries = new Map<string, { poster: VideoPoster; url: string; users: number }>();
  private bytes = 0;
  constructor(private maxBytes = 16 * 1024 * 1024, private maxEntries = 300) {}

  peek(src: string) { return this.entries.get(src); }

  put(poster: VideoPoster): void {
    if (this.entries.has(poster.src)) return;
    this.entries.set(poster.src, { poster, url: URL.createObjectURL(poster.blob), users: 0 });
    this.bytes += poster.blob.size;
    // Allow the requesting component to pin the new cover before eviction.
    this.trim(poster.src);
    queueMicrotask(() => this.trim());
  }

  retain(src: string) {
    const entry = this.entries.get(src);
    if (!entry) return null;
    this.entries.delete(src);
    this.entries.set(src, entry);
    entry.users++;
    let released = false;
    return { poster: entry.poster, url: entry.url, release: () => {
      if (released) return;
      released = true;
      entry.users--;
      this.trim();
    } };
  }

  private trim(protectedSrc?: string) {
    for (const [src, entry] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      if (entry.users || src === protectedSrc) continue;
      URL.revokeObjectURL(entry.url);
      this.entries.delete(src);
      this.bytes -= entry.poster.blob.size;
    }
  }
}

export const posterMemoryCache = new PosterMemoryCache();

// Cached reads never wait for the video decoder. Only cache misses enter the
// serial extraction queue, so playing a video cannot block existing covers.
export function requestVideoPoster(src: string, listener: (poster: VideoPoster | null) => void): () => void {
  const cached = posterMemoryCache.peek(src);
  if (cached) {
    listener(cached.poster);
    return () => {};
  }
  const existing = pending.get(src);
  if (existing) {
    existing.listeners.add(listener);
    return () => unsubscribe(src, existing, listener);
  }
  const controller = new AbortController();
  let cancelDecode = () => {};
  const entry = { listeners: new Set([listener]), cancel: () => {
    controller.abort(); cancelDecode();
  } };
  pending.set(src, entry);
  const finish = (poster: VideoPoster | null) => {
    if (controller.signal.aborted) return;
    if (pending.get(src) === entry) pending.delete(src);
    if (poster) posterMemoryCache.put(poster);
    const listeners = [...entry.listeners];
    entry.listeners.clear();
    entry.cancel = () => {};
    cancelDecode = () => {};
    for (const callback of listeners) {
      try { callback(poster); } catch { /* Keep other consumers working. */ }
    }
  };
  void readPoster(src).then((poster) => {
    if (controller.signal.aborted) return;
    if (poster || failedSources.has(src)) { finish(poster); return; }
    cancelDecode = videoPreviewScheduler.enqueue(async (signal) => {
      const poster = await extractPoster(src, signal);
      if (signal.aborted || controller.signal.aborted) return;
      if (poster) await writePoster(poster);
      else {
        failedSources.add(src);
        if (failedSources.size > MAX_POSTERS) failedSources.delete(failedSources.values().next().value!);
      }
      if (!signal.aborted) finish(poster);
    });
  }).catch(() => finish(null));
  return () => unsubscribe(src, entry, listener);
}

function unsubscribe(src: string, entry: { listeners: Set<(poster: VideoPoster | null) => void>; cancel: () => void }, listener: (poster: VideoPoster | null) => void) {
  entry.listeners.delete(listener);
  if (entry.listeners.size === 0) {
    entry.cancel();
    if (pending.get(src) === entry) pending.delete(src);
  }
}

// Warm disk hits near the viewport, with bounded I/O and no video extraction.
export function preloadCachedVideoPosters(sources: string[]): () => void {
  let cancelled = false;
  let index = 0;
  const worker = async () => {
    while (!cancelled && index < sources.length) {
      const src = sources[index++];
      if (posterMemoryCache.peek(src)) continue;
      const poster = await readPoster(src);
      if (!cancelled && poster) posterMemoryCache.put(poster);
    }
  };
  void Promise.all([worker(), worker()]).catch(() => {});
  return () => { cancelled = true; };
}
