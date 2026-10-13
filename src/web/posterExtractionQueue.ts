export const WEB_POSTER_CONCURRENCY = 6;

export class WebPosterExtractionQueue {
  private queue: Array<{ run?: (signal: AbortSignal) => Promise<void>; controller: AbortController }> = [];
  private active = 0;
  constructor(private concurrency = WEB_POSTER_CONCURRENCY) {}
  enqueue(run: (signal: AbortSignal) => Promise<void>): () => void {
    const job = { run: run as ((signal: AbortSignal) => Promise<void>) | undefined, controller: new AbortController() };
    this.queue.push(job);
    this.drain();
    return () => { job.controller.abort(); job.run = undefined; this.queue = this.queue.filter(item => item !== job); };
  }
  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void Promise.resolve().then(() => job.controller.signal.aborted ? undefined : job.run?.(job.controller.signal))
        .catch(() => {}).finally(() => { job.run = undefined; this.active--; this.drain(); });
    }
  }
}
export const webPosterExtractionQueue = new WebPosterExtractionQueue();
