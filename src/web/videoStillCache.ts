type Listener = { visible: boolean; update: (url: string) => void };
type Entry = { url: string; revision: number; time?: number; listeners: Set<Listener> };

// Only visible consumers own frames. There is no history or persistent storage.
export class VideoStillCache {
  private entries = new Map<string, Entry>();

  peek(src: string): string { return this.entries.get(src)?.url ?? ""; }

  watch(src: string, update: (url: string) => void) {
    let entry = this.entries.get(src);
    if (!entry) {
      entry = { url: "", revision: 0, listeners: new Set() };
      this.entries.set(src, entry);
    }
    const current = entry;
    const listener: Listener = { visible: true, update };
    let released = false;
    current.listeners.add(listener);
    update(current.url);
    const trim = () => {
      if (![...current.listeners].some(item => item.visible)) this.clear(current);
      if (!current.listeners.size) this.entries.delete(src);
    };
    return {
      setVisible: (visible: boolean) => {
        if (released) return;
        listener.visible = visible;
        update(visible ? current.url : "");
        trim();
      },
      release: () => {
        if (released) return;
        released = true;
        current.listeners.delete(listener);
        trim();
      },
    };
  }

  capture(src: string, video: HTMLVideoElement): void {
    const entry = this.entries.get(src);
    if (!entry || ![...entry.listeners].some(item => item.visible)
      || video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight
      || entry.time === video.currentTime) return;
    entry.time = video.currentTime;
    const revision = ++entry.revision;
    const canvas = document.createElement("canvas");
    // Fit every aspect ratio inside 640 x 360; portrait height also stays at 360.
    const scale = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const valid = () => this.entries.get(src) === entry && entry.revision === revision
      && [...entry.listeners].some(item => item.visible);
    try {
      const context = canvas.getContext("2d");
      if (!context) { this.clear(entry); return; }
      // Copy before the player clears its src; encoding never retains the video.
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (!valid()) return;
        if (!blob) { this.clear(entry); return; }
        const previous = entry.url;
        entry.url = URL.createObjectURL(blob);
        for (const listener of entry.listeners) listener.update(listener.visible ? entry.url : "");
        if (previous) URL.revokeObjectURL(previous);
      }, "image/jpeg", 0.82);
    } catch {
      // Cross-origin or unavailable frames fall back to the original cover.
      if (valid()) this.clear(entry);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  private clear(entry: Entry) {
    ++entry.revision;
    entry.time = undefined;
    const previous = entry.url;
    entry.url = "";
    for (const listener of entry.listeners) listener.update("");
    if (previous) URL.revokeObjectURL(previous);
  }
}

export const webVideoStills = new VideoStillCache();
