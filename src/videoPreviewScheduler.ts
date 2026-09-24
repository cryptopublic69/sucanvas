// Shared by node previews and input thumbnails. Never retain inactive players.
export class VideoPreviewScheduler {
  private owner: (() => void) | undefined;
  private queue: Array<{ run: (signal: AbortSignal) => Promise<void>; controller: AbortController }> = [];
  private running = false;

  claim(release: () => void): () => void {
    const previous = this.owner;
    this.owner = release;
    if (previous !== release) previous?.();
    return () => {
      if (this.owner !== release) return;
      this.owner = undefined;
      this.drain();
    };
  }

  enqueue(run: (signal: AbortSignal) => Promise<void>): () => void {
    const job = { run, controller: new AbortController() };
    this.queue.push(job);
    this.drain();
    return () => {
      job.controller.abort();
      this.queue = this.queue.filter((entry) => entry !== job);
    };
  }

  private drain(): void {
    if (this.running || this.owner) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    void Promise.resolve().then(() => {
      if (!job.controller.signal.aborted) return job.run(job.controller.signal);
    }).catch(() => {
      // Failed posters must not block later videos or surface as unhandled rejections.
    }).finally(() => {
      this.running = false;
      this.drain();
    });
  }
}

export const videoPreviewScheduler = new VideoPreviewScheduler();
