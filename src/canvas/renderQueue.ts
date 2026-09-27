// Spread expensive node mounts over animation frames; canceled/offscreen jobs are removed.
export class RenderQueue {
  private jobs = new Map<number, { run: () => void; priority: () => number }>();
  private nextId = 0;
  private frame: number | null = null;
  constructor(private request: (callback: () => void) => number, private cancel: (id: number) => void, private batchSize = 4) {}
  enqueue(run: () => void, priority: () => number = () => 0) {
    const id = ++this.nextId;
    this.jobs.set(id, { run, priority });
    this.schedule();
    return () => {
      this.jobs.delete(id);
      if (!this.jobs.size && this.frame !== null) { this.cancel(this.frame); this.frame = null; }
    };
  }
  private schedule() {
    if (this.frame !== null || !this.jobs.size) return;
    this.frame = this.request(() => {
      this.frame = null;
      const next = [...this.jobs].sort((a, b) => a[1].priority() - b[1].priority()).slice(0, this.batchSize);
      for (const [id, job] of next) {
        if (!this.jobs.delete(id)) continue;
        job.run();
      }
      this.schedule();
    });
  }
}
export const nodeRenderQueue = new RenderQueue((callback) => requestAnimationFrame(callback), (id) => cancelAnimationFrame(id));
