import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/mediaDownload.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { generatedMediaDownload } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("Web outputs download their retained asset instead of a stale ComfyUI URL", () => {
  assert.deepEqual(generatedMediaDownload({ assetPath: "sucanvas://assets/a.mp4", videoUrl: "http://old-server/view", filename: "scene.mp4" }, "video"), {
    resource: "sucanvas://assets/a.mp4", filename: "scene.mp4",
  });
});

test("desktop backup outputs download through the proxy without a mapped directory", () => {
  const videoUrl = "/api/comfy/view?filename=scene.mp4&type=output";
  assert.deepEqual(generatedMediaDownload({ videoUrl, filename: "scene.mp4" }, "video"), { resource: videoUrl, filename: "scene.mp4" });
  const imageUrl = "http://127.0.0.1:1422/api/comfy/view?filename=scene.png";
  assert.deepEqual(generatedMediaDownload({ assetPath: "Y:\\old\\scene.png", imageUrl, filename: "scene.png" }, "image"), { resource: imageUrl, filename: "scene.png" });
});

test("download names preserve the original extension and remove path components", () => {
  assert.equal(generatedMediaDownload({ assetPath: "sucanvas://assets/a.webp", originalName: "C:\\old\\我的图像.webp", filename: "stored.webp" }, "image").filename, "我的图像.webp");
  assert.equal(generatedMediaDownload({ imageUrl: "/api/resource?resource=a" }, "image").filename, "生成图片.png");
});

test("local drive paths and missing media do not become browser download links", () => {
  assert.equal(generatedMediaDownload({ assetPath: "Y:\\scene.mp4" }, "video"), null);
  assert.equal(generatedMediaDownload({ videoUrl: "javascript:alert(1)" }, "video"), null);
  assert.equal(generatedMediaDownload({}, "image"), null);
});
