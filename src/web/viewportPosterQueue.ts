type Candidate = { src: string; x: number; y: number; width: number; height: number };

export function visiblePosterSources(candidates: Candidate[], width: number, height: number): string[] {
  return [...new Set(candidates
    .filter(item => item.src && item.x + item.width > 0 && item.y + item.height > 0 && item.x < width && item.y < height)
    .sort((a, b) => Math.abs(a.x + a.width / 2 - width / 2) + Math.abs(a.y + a.height / 2 - height / 2)
      - Math.abs(b.x + b.width / 2 - width / 2) - Math.abs(b.y + b.height / 2 - height / 2))
    .map(item => item.src))];
}

type Request = (src: string, complete: () => void) => () => void;
export function requestVisiblePosters(sources: string[], request: Request, complete: () => void, concurrency = 1): () => void {
  let stopped = false;
  let index = 0;
  const active = new Set<() => void>();
  const worker = async () => {
    while (index < sources.length) {
      if (stopped) return;
      const src = sources[index++];
      await new Promise<void>(resolve => {
        let settled = false;
        let cancelRequest = () => {};
        const finish = () => {
          if (settled) return;
          settled = true;
          active.delete(cancel);
          resolve();
        };
        const cancel = () => { cancelRequest(); finish(); };
        active.add(cancel);
        try { cancelRequest = request(src, finish); } catch { finish(); }
        if (settled) cancelRequest();
      });
    }
  };
  void Promise.all(Array.from({ length: Math.min(sources.length, Math.max(1, concurrency)) }, worker)).then(() => {
    if (!stopped) complete();
  }).catch(() => { if (!stopped) complete(); });
  return () => {
    stopped = true;
    for (const cancel of [...active]) cancel();
  };
}
