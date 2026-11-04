import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-031a: how many images an image-edit node accepts when connecting comes from the package:
// the `max` of the operation's first image port (the port the run request fills). A package that
// declares no max keeps the old limit of 2. The refusal names no workflow and goes to the top notice.
const pkg = await loadWorkflowModule("workflowPackage");
const generate = async (dir) => (await readJson(`workflow-packages/image-v2/${dir}/adapter.json`)).operations.generate;
const op = (...inputs) => ({ inputs });

test("the connect limit is the max of the first image port", async () => {
  assert.equal(pkg.declaredInputMax(await generate("5a9e19a3"), "image"), 8);
  assert.equal(pkg.declaredInputMax(await generate("52cba27b"), "image"), 2);
  assert.equal(pkg.declaredInputMax(op({ id: "a", type: "image", max: 3 }, { id: "b", type: "image", max: 5 }), "image"), 3);
  assert.equal(pkg.declaredInputMax(op({ id: "a", type: "image" }), "image"), undefined);
  assert.equal(pkg.declaredInputMax(op({ id: "t", type: "text", max: 1 }), "image"), undefined);
  assert.equal(pkg.declaredInputMax(undefined, "image"), undefined);
});

test("the limited port is the one the run request counts", () => {
  const operation = op({ id: "first", type: "image", max: 4 }, { id: "second", type: "image", max: 9 });
  const counted = Object.keys(pkg.connectedMediaCounts(operation, { image: [{ path: "a" }, { path: "b" }] }));
  assert.deepEqual(counted, ["first"]);
  assert.equal(pkg.declaredInputMax(operation, "image"), operation.inputs.find((port) => port.id === counted[0]).max);
});

test("connecting one more image is refused at the declared max, with a generic message", async () => {
  const qwen = await generate("5a9e19a3");
  for (let connected = 0; connected < 8; connected += 1) assert.equal(pkg.imageConnectionLimitError(qwen, connected), null, String(connected));
  assert.equal(pkg.imageConnectionLimitError(qwen, 8), "本方案最多连接 8 张图片");
  const krea = await generate("52cba27b");
  assert.equal(pkg.imageConnectionLimitError(krea, 1), null);
  assert.equal(pkg.imageConnectionLimitError(krea, 2), "本方案最多连接 2 张图片");
});

test("a package without a declared max keeps the old limit of 2", () => {
  assert.equal(pkg.LEGACY_IMAGE_CONNECTION_MAX, 2);
  assert.equal(pkg.imageConnectionLimitError(op({ id: "images", type: "image" }), 1), null);
  assert.equal(pkg.imageConnectionLimitError(op({ id: "images", type: "image" }), 2), "本方案最多连接 2 张图片");
  assert.equal(pkg.imageConnectionLimitError(undefined, 2), "本方案最多连接 2 张图片");
});

test("the refusal is recognised as a limit notice (top toast), other messages are not", () => {
  assert.equal(pkg.isImageConnectionLimitNotice("本方案最多连接 8 张图片"), true);
  assert.equal(pkg.isImageConnectionLimitNotice("当前图片方案只允许连接文本或提示词迭代节点"), false);
  assert.equal(pkg.isImageConnectionLimitNotice(null), false);
});

test("App connects image-edit nodes through the package limit and shows it as a toast", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // (The first/last-frame video mode keeps its own two-image rule; that is a mode, not a package.)
  assert.ok(!app.includes("图像编辑最多只能连接两张图片"), "the fixed two-image message is gone");
  const start = app.indexOf('if (target.kind === "image-generation") {');
  const branch = app.slice(start, app.indexOf("const sourceMediaKind = videoInputMediaKind(source);", start));
  assert.match(branch, /imageConnectionLimitError\(\s*imageModule \? workflowPackages\[imageModule\.id\]\?\.operations\.generate : undefined,\s*imageCount,?\s*\)/);
  assert.ok(!/imageCount >= \d/.test(branch), "no number written into the image-generation branch");
  // Both places that report a refused connection pick the toast for limit notices.
  const pickers = [...app.matchAll(/\((isConnectionLimitNotice|isReferenceLimitNotice)\((validationError|error)\) \? showGlobalNotice : setNotice\)/g)];
  assert.equal(pickers.length, 2);
  for (const picker of pickers) assert.equal(picker[1], "isConnectionLimitNotice");
  assert.match(app, /const isConnectionLimitNotice = \(message: string \| null \| undefined\) =>\s*isReferenceLimitNotice\(message\) \|\| isImageConnectionLimitNotice\(message\);/);
});
