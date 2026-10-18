import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/video/videoDurationLabel.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { validVideoDurationSeconds, videoElapsedWithDuration, videoDurationAspectLabel } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("footer keeps the requested duration of generated videos", () => {
  assert.equal(videoElapsedWithDuration("耗时 52秒", 5), "耗时 52秒 / 5秒");
});

test("footer shows only the elapsed time when the duration is 0", () => {
  assert.equal(videoElapsedWithDuration("耗时 1分0秒", 0), "耗时 1分0秒");
});

test("footer shows only the elapsed time when the duration is missing or invalid", () => {
  for (const value of [undefined, null, "5", Number.NaN, Number.POSITIVE_INFINITY, -3]) {
    assert.equal(videoElapsedWithDuration("耗时 1分0秒", value), "耗时 1分0秒");
    assert.equal(validVideoDurationSeconds(value), null);
  }
});

test("details panel drops the duration part unless it is valid", () => {
  assert.equal(videoDurationAspectLabel(5, "16:9"), "5 秒 · 16:9");
  assert.equal(videoDurationAspectLabel(0, "16:9"), "16:9");
  assert.equal(videoDurationAspectLabel(undefined, "9:16"), "9:16");
});
