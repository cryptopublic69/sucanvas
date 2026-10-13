import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/videoStillCache.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { VideoStillCache } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

function fixture(t) {
  const captures = [], created = [], revoked = [];
  t.mock.method(URL, "createObjectURL", blob => {
    const url = `blob:still-${created.length}`;
    created.push({ url, blob });
    return url;
  });
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas", "capture must reuse the existing player");
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({ drawImage(video, x, y, width, height) {
          captures.push({ video, width, height, canvas });
        } }),
        toBlob(callback) { captures.at(-1).complete = (blob = new Blob(["frame"])) => callback(blob); },
      };
      return canvas;
    },
  };
  t.after(() => { delete globalThis.document; });
  const video = { readyState: 2, seeking: false, videoWidth: 1920, videoHeight: 1080, currentTime: 1 };
  return { cache: new VideoStillCache(), video, captures, created, revoked };
}

test("captures landscape and portrait frames within the agreed dimensions without upscaling", t => {
  const { cache, video, captures } = fixture(t);
  const owner = cache.watch("video", () => {});
  for (const [width, height, expectedWidth, expectedHeight] of [
    [1920, 1080, 640, 360], [1080, 1920, 203, 360], [1920, 2160, 320, 360],
    [1440, 1080, 480, 360], [1080, 1080, 360, 360], [2560, 1080, 640, 270],
    [100, 50, 100, 50],
  ]) {
    video.videoWidth = width; video.videoHeight = height; video.currentTime++;
    cache.capture("video", video);
    const capture = captures.at(-1);
    assert.deepEqual([capture.width, capture.height], [expectedWidth, expectedHeight]);
    assert.deepEqual([capture.canvas.width, capture.canvas.height], [0, 0]);
    capture.complete();
  }
  owner.release();
});

test("visible frames have no fixed count limit and all are freed when their owners leave", t => {
  const { cache, video, captures, revoked } = fixture(t);
  const owners = [];
  for (let i = 0; i < 40; i++) {
    const src = `video-${i}`;
    owners.push(cache.watch(src, () => {}));
    cache.capture(src, video); captures.at(-1).complete();
  }
  for (let i = 0; i < 40; i++) assert.equal(cache.peek(`video-${i}`), `blob:still-${i}`);
  owners.forEach(owner => owner.release());
  assert.equal(revoked.length, 40);
  for (let i = 0; i < 40; i++) assert.equal(cache.peek(`video-${i}`), "");
});

test("repeated exits at the same playback position do not encode again; newer frames replace older ones", t => {
  const { cache, video, captures, revoked } = fixture(t);
  const updates = [];
  const owner = cache.watch("video", url => updates.push(url));
  cache.capture("video", video); captures[0].complete();
  cache.capture("video", video);
  assert.equal(captures.length, 1);
  video.currentTime = 2;
  cache.capture("video", video); captures[1].complete();
  assert.equal(cache.peek("video"), "blob:still-1");
  assert.deepEqual(revoked, ["blob:still-0"]);
  assert.equal(updates.at(-1), "blob:still-1");
  owner.release();
  assert.deepEqual(revoked, ["blob:still-0", "blob:still-1"]);
});

test("last visible consumer leaving clears its image and rejects pending encoding results", t => {
  const { cache, video, captures, created, revoked } = fixture(t);
  const updates = [];
  const owner = cache.watch("video", url => updates.push(url));
  cache.capture("video", video); captures[0].complete();
  video.currentTime = 2;
  cache.capture("video", video);
  owner.setVisible(false);
  assert.equal(updates.at(-1), "");
  assert.equal(cache.peek("video"), "");
  captures[1].complete();
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, ["blob:still-0"]);
  owner.setVisible(true);
  assert.equal(updates.at(-1), "", "returning to the viewport starts with the original poster");
  cache.capture("video", video); captures[2].complete();
  assert.equal(cache.peek("video"), "blob:still-1");
  owner.release();
});

test("overview ownership preserves frames across detail unmount; deletion of the last owner frees them", t => {
  const { cache, video, captures, revoked } = fixture(t);
  const overview = cache.watch("video", () => {});
  const detail = cache.watch("video", () => {});
  cache.capture("video", video); captures[0].complete();
  detail.release();
  assert.equal(cache.peek("video"), "blob:still-0");
  overview.release();
  assert.equal(cache.peek("video"), "");
  assert.deepEqual(revoked, ["blob:still-0"]);
});

test("late frames cannot overwrite newer stops or frames from a remounted source", t => {
  const { cache, video, captures, created } = fixture(t);
  const old = cache.watch("video", () => {});
  cache.capture("video", video);
  video.currentTime = 2;
  cache.capture("video", video);
  captures[1].complete(); captures[0].complete();
  assert.equal(created.length, 1);
  video.currentTime = 3;
  cache.capture("video", video);
  old.release();
  const current = cache.watch("video", () => {});
  old.release(); old.setVisible(false);
  cache.capture("video", video);
  captures[2].complete(); captures[3].complete();
  assert.equal(created.length, 2);
  assert.equal(cache.peek("video"), "blob:still-1");
  current.release();
});

test("failed or unavailable frames fall back without retaining a canvas or starting another decoder", t => {
  const { cache, video, captures } = fixture(t);
  const owner = cache.watch("video", () => {});
  video.readyState = 1;
  cache.capture("video", video);
  assert.equal(captures.length, 0);
  video.readyState = 2; video.seeking = true;
  cache.capture("video", video);
  assert.equal(captures.length, 0);
  video.seeking = false;
  cache.capture("video", video); captures[0].complete(null);
  assert.equal(cache.peek("video"), "");
  document.createElement = () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage() { throw new Error("tainted canvas"); } }) });
  assert.doesNotThrow(() => cache.capture("video", video));
  assert.equal(cache.peek("video"), "");
  owner.release();
});
