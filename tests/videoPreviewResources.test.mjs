import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function moduleUrl(path, replacements = []) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}
const schedulerUrl = await moduleUrl("../src/videoPreviewScheduler.ts");
const { VideoPreviewScheduler } = await import(schedulerUrl);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("poster jobs run serially and recover after a failure", async () => {
  const scheduler = new VideoPreviewScheduler();
  const calls = [];
  let finish;
  scheduler.enqueue(async () => { calls.push(1); await new Promise((resolve) => { finish = resolve; }); });
  scheduler.enqueue(async () => { calls.push(2); throw new Error("decode failed"); });
  scheduler.enqueue(async () => { calls.push(3); });
  await tick();
  assert.deepEqual(calls, [1]);
  finish();
  await tick();
  assert.deepEqual(calls, [1, 2, 3]);
});

test("switching players releases the previous owner without unlocking the new owner", async () => {
  const scheduler = new VideoPreviewScheduler();
  let released = 0;
  let posters = 0;
  const releaseOld = scheduler.claim(() => { released++; releaseOld(); });
  const releaseNew = scheduler.claim(() => {});
  scheduler.enqueue(async () => { posters++; });
  releaseOld();
  await tick();
  assert.equal(released, 1);
  assert.equal(posters, 0);
  releaseNew();
  await tick();
  assert.equal(posters, 1);
});

test("cancelling queued and active jobs aborts work and allows the queue to advance", async () => {
  const scheduler = new VideoPreviewScheduler();
  const calls = [];
  const cancelActive = scheduler.enqueue(async (signal) => {
    calls.push("active");
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  });
  const cancelQueued = scheduler.enqueue(async () => { calls.push("cancelled"); });
  scheduler.enqueue(async () => { calls.push("next"); });
  await tick();
  cancelQueued();
  cancelActive();
  await tick();
  assert.deepEqual(calls, ["active", "next"]);
});

const posterUrl = await moduleUrl("../src/videoPosterCache.ts", [
  ['"./videoPreviewScheduler"', JSON.stringify(schedulerUrl)],
  ['"@tauri-apps/api/core"', '"data:text/javascript,export const isTauri = () => false; export const invoke = () => Promise.reject();"'],
]);
const { requestVideoPoster } = await import(posterUrl);
const videos = [];
globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") return {
      width: 0, height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (callback) => callback(new Blob(["poster"], { type: "image/jpeg" })),
    };
    assert.equal(tag, "video");
    const video = {
      videoWidth: 1920, videoHeight: 1080, src: "", paused: false, loads: 0,
      pause() { this.paused = true; },
      load() { this.loads++; },
      removeAttribute(name) { assert.equal(name, "src"); this.src = ""; },
    };
    videos.push(video);
    return video;
  },
};

test("duplicate poster requests share one decoder and release it after capture", async () => {
  const results = [];
  const start = videos.length;
  const cancelOne = requestVideoPoster("same-video", (poster) => results.push(poster));
  const cancelTwo = requestVideoPoster("same-video", (poster) => results.push(poster));
  await tick();
  assert.equal(videos.length, start + 1);
  const video = videos.at(-1);
  video.onloadeddata();
  await tick();
  assert.equal(results.length, 2);
  assert.equal(results[0].width, 1920);
  assert.equal(results[0].height, 1080);
  assert.equal(results[0], results[1]);
  assert.equal(video.src, "");
  assert.equal(video.paused, true);
  assert.equal(video.loads, 2);
  cancelOne(); cancelTwo();
});

test("unmounting one consumer keeps shared extraction; the last unmount releases it", async () => {
  let delivered = 0;
  const cancelOne = requestVideoPoster("unmounted-video", () => delivered++);
  const cancelTwo = requestVideoPoster("unmounted-video", () => delivered++);
  await tick();
  const video = videos.at(-1);
  cancelOne();
  assert.equal(video.src, "unmounted-video");
  cancelTwo();
  await tick();
  assert.equal(video.src, "");
  assert.equal(video.paused, true);
  assert.equal(delivered, 0);
});

test("failed poster extraction does not retry endlessly or prevent the next video", async () => {
  let failure;
  requestVideoPoster("unsupported-video", (poster) => { failure = poster; });
  await tick();
  videos.at(-1).onerror();
  await tick();
  assert.equal(failure, null);
  const count = videos.length;
  requestVideoPoster("unsupported-video", () => {});
  await tick();
  assert.equal(videos.length, count);
  const cancel = requestVideoPoster("next-video", () => {});
  await tick();
  assert.equal(videos.length, count + 1);
  cancel();
  await tick();
});

const nativePosterUrl = await moduleUrl("../src/videoPosterCache.ts", [
  ['"./videoPreviewScheduler"', JSON.stringify(schedulerUrl)],
  ['"@tauri-apps/api/core"', '"data:text/javascript,export const isTauri = () => true; export const invoke = (...args) => globalThis.nativePosterInvoke(...args);"'],
]);
const nativePosters = await import(nativePosterUrl);

test("remote posters use the native extractor without creating a WebView decoder", async () => {
  const start = videos.length;
  let result;
  globalThis.nativePosterInvoke = async (command, args) => {
    assert.equal(command, "capture_video_poster");
    assert.equal(args.source, "http://example.test/video.mp4");
    return [255, 216, 255, 217];
  };
  nativePosters.requestVideoPoster("http://example.test/video.mp4", (poster) => { result = poster; });
  await tick();
  assert.equal(videos.length, start);
  assert.equal(result.blob.type, "image/jpeg");
  assert.equal(result.blob.size, 4);
  assert.equal(result.width, 0, "a scaled poster must not overwrite original video dimensions");
});

test("unmounting during native extraction discards the result", async () => {
  let complete;
  let delivered = false;
  globalThis.nativePosterInvoke = () => new Promise((resolve) => { complete = resolve; });
  const cancel = nativePosters.requestVideoPoster("http://example.test/cancel.mp4", () => { delivered = true; });
  await tick();
  cancel();
  complete([255, 216, 255, 217]);
  await tick();
  assert.equal(delivered, false);
});

test("native failure leaves a placeholder without a hidden WebView decoder", async () => {
  const start = videos.length;
  let result = "pending";
  globalThis.nativePosterInvoke = async () => { throw new Error("file not ready"); };
  nativePosters.requestVideoPoster("http://example.test/not-ready.mp4", (poster) => { result = poster; });
  await tick();
  assert.equal(result, null);
  assert.equal(videos.length, start);
});

test("temporary native failures recover after cooldown and then use the cached poster", async (t) => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const start = videos.length;
  globalThis.nativePosterInvoke = async () => {
    if (++calls === 1) throw new Error("file not ready");
    return [255, 216, 255, 217];
  };
  const src = "http://example.test/retry-ready.mp4";
  let result;
  nativePosters.requestVideoPoster(src, (poster) => { result = poster; });
  await tick();
  assert.equal(result, null);
  nativePosters.requestVideoPoster(src, () => {});
  await tick();
  assert.equal(calls, 1, "cooldown prevents repeated extraction");
  now += 2500;
  nativePosters.requestVideoPoster(src, (poster) => { result = poster; });
  await tick();
  assert.equal(calls, 2);
  assert.equal(result.blob.size, 4);
  nativePosters.requestVideoPoster(src, () => {});
  await tick();
  assert.equal(calls, 2, "successful retry is cached");
  assert.equal(videos.length, start);
});

test("oversized native posters are discarded before blob conversion", async () => {
  const start = videos.length;
  let result = "pending";
  globalThis.nativePosterInvoke = async () => new Array(1024 * 1024 + 1).fill(0);
  nativePosters.requestVideoPoster("http://example.test/oversized.mp4", (poster) => { result = poster; });
  await tick();
  assert.equal(result, null);
  assert.equal(videos.length, start);
});

test("a failing consumer does not prevent delivery to other consumers", async () => {
  let delivered = 0;
  globalThis.nativePosterInvoke = async () => [255, 216, 255, 217];
  const cancelOne = nativePosters.requestVideoPoster("http://example.test/listeners.mp4", () => { throw new Error("consumer failed"); });
  const cancelTwo = nativePosters.requestVideoPoster("http://example.test/listeners.mp4", () => { delivered++; });
  await tick();
  assert.equal(delivered, 1);
  cancelOne(); cancelTwo();
});

test("completed and cancelled jobs release their work closures while unsubscribe stays alive", async () => {
  const scheduler = new VideoPreviewScheduler();
  const releasePlayer = scheduler.claim(() => {});
  const cancelCompleted = scheduler.enqueue(async () => {});
  const completedJob = scheduler.queue[0];
  const cancelQueued = scheduler.enqueue(async () => {});
  const cancelledJob = scheduler.queue[1];
  cancelQueued();
  assert.equal(cancelledJob.run, undefined);
  releasePlayer();
  await tick();
  assert.equal(completedJob.run, undefined);
  cancelCompleted();
});


test("warm memory covers are delivered immediately while a player owns the decoder", async () => {
  const { videoPreviewScheduler } = await import(schedulerUrl);
  const release = videoPreviewScheduler.claim(() => {});
  try {
    let result;
    const before = videos.length;
    requestVideoPoster("same-video", (poster) => { result = poster; });
    assert.ok(result, "memory hits must not wait for a queue tick");
    assert.equal(videos.length, before);
  } finally { release(); }
});

test("memory cache shares URLs, evicts unused covers, and protects mounted covers", async () => {
  const { PosterMemoryCache } = await import(posterUrl);
  const cache = new PosterMemoryCache(6, 2);
  const poster = (src) => ({ src, blob: new Blob(["abc"]), width: 480, height: 270, createdAt: 0 });
  cache.put(poster("a")); cache.put(poster("b"));
  const a = cache.retain("a");
  const secondA = cache.retain("a");
  assert.equal(a.url, secondA.url);
  cache.put(poster("c"));
  assert.ok(cache.peek("a"));
  assert.equal(cache.peek("b"), undefined);
  secondA.release(); a.release(); a.release();
  cache.put(poster("d"));
  assert.equal(cache.peek("a"), undefined);
  assert.ok(cache.peek("c"));
});

test("disk cache hits bypass the decoder queue and prewarming never extracts misses", async () => {
  const { videoPreviewScheduler } = await import(schedulerUrl);
  const cached = { src: "disk-video", blob: new Blob(["jpeg"]), width: 480, height: 270, createdAt: 0 };
  globalThis.indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = { transaction: () => ({ objectStore: () => ({ get(src) {
          const read = {};
          queueMicrotask(() => { read.result = src === cached.src ? cached : undefined; read.onsuccess(); });
          return read;
        } }) }) };
        request.onsuccess();
      });
      return request;
    },
  };
  const diskPosters = await import(posterUrl + "#disk-test");
  const release = videoPreviewScheduler.claim(() => {});
  try {
    let result;
    const before = videos.length;
    diskPosters.requestVideoPoster(cached.src, (poster) => { result = poster; });
    await tick();
    assert.equal(result, cached);
    const cancelWarm = diskPosters.preloadCachedVideoPosters(["uncached-neighbor"]);
    await tick();
    cancelWarm();
    assert.equal(videos.length, before);
    assert.ok(diskPosters.posterMemoryCache.peek(cached.src));
  } finally {
    release();
    delete globalThis.indexedDB;
  }
});
