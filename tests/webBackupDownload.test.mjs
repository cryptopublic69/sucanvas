import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText).toString("base64")}`;
const urls = moduleUrl(await readFile(new URL("../src/web/urls.ts", import.meta.url), "utf8"));
const { downloadFilename } = await import(urls);
const bridgeSource = (await readFile(new URL("../src/web/bridge.ts", import.meta.url), "utf8"))
  .replace('"./urls"', JSON.stringify(urls))
  .replace('const devBackend = import.meta.env.DEV ? import.meta.env.SUCANVAS_WEB_DEV_BACKEND ?? "" : "";', 'const devBackend = "";');
const { save, download } = await import(moduleUrl(bridgeSource));
const previousWindow = globalThis.window;
test.before(() => { globalThis.window = { location: { origin: "http://localhost" } }; });
test.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });

test("backup save and download keep the Chinese filename and importable extension", async (t) => {
  const name = "SuCanvas-软件备份-20261009-204114.sucanvas-backup";
  const path = await save({ defaultPath: name });
  const link = { click() {}, remove() {} };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => link, body: { appendChild() {} } };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  download(path);
  assert.equal(link.download, name);
  const url = new URL(link.href, "http://localhost");
  assert.equal(url.searchParams.get("resource"), path);
  assert.equal(url.searchParams.get("download"), "true");
  assert.equal(url.searchParams.get("filename"), name);
});

test("resource URLs resolve their encoded backup filename instead of the query string", () => {
  const name = "SuCanvas-软件备份.sucanvas-backup";
  const resource = `sucanvas-export://id/${name}`;
  assert.equal(downloadFilename(`/api/resource?resource=${encodeURIComponent(resource)}`), name);
  assert.equal(downloadFilename(`http://127.0.0.1:1422/api/resource?resource=${encodeURIComponent(resource)}&download=true`), name);
});

test("generated media and explicit names keep their extension without path components", () => {
  assert.equal(downloadFilename("/api/comfy/view?filename=scene.mp4&type=output"), "scene.mp4");
  assert.equal(downloadFilename("sucanvas://assets/id.png", "C:\\pictures\\我的图像.png"), "我的图像.png");
});

test("stored source names do not override the original Chinese name supplied for downloading", (t) => {
  const link = { click() {}, remove() {} };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => link, body: { appendChild() {} } };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  for (const name of ["我的图片.png", "背景音乐.wav", "分镜视频.mp4"]) {
    download(`/api/resource?resource=${encodeURIComponent(`sucanvas://assets/id/source.${name.split('.').pop()}`)}&filename=source.png&download=false`, name);
    const url = new URL(link.href);
    assert.equal(link.download, name);
    assert.equal(url.searchParams.get("filename"), name);
    assert.equal(url.searchParams.getAll("filename").length, 1);
    assert.equal(url.searchParams.get("download"), "true");
    assert.equal(downloadFilename(link.href), name);
  }
  download("/api/comfy/view?filename=source.mp4&type=output", "最终视频.mp4");
  const proxyUrl = new URL(link.href);
  assert.equal(proxyUrl.searchParams.get("filename"), "source.mp4");
  assert.equal(proxyUrl.searchParams.get("downloadName"), "最终视频.mp4");
});
