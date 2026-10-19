import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
// The bridge is replaced by a recorder; adminMedia.ts only needs `invoke`.
const bridge = moduleUrl("export const calls = []; export async function invoke(command, args) { calls.push({ command, args }); return { done: [], bytes: 0, skipped: [] }; }");
const { calls } = await import(bridge);
const source = (await readFile(new URL("../src/web/adminMedia.ts", import.meta.url), "utf8")).replace('"./bridge"', JSON.stringify(bridge));
const media = await import(moduleUrl(source));
const item = (name, extra = {}) => ({
  reference: `sucanvas-input://sucanvas-imports/${name}`, name, category: "upload", size: 1, unreferencedSince: "2026-10-01T00:00:00.000000Z",
  releasedBy: null, createdBy: null, trashedAt: null, canvasName: null, ...extra,
});

test("each action is its own admin command and names the files only", async () => {
  calls.length = 0;
  await media.listMediaCleanup();
  await media.trashMediaFiles(["a"]);
  await media.restoreMediaFiles(["b"]);
  await media.purgeMediaFiles(["c"]);
  assert.deepEqual(calls, [
    { command: "list_media_cleanup", args: undefined },
    { command: "trash_media_files", args: { references: ["a"] } },
    { command: "restore_media_files", args: { references: ["b"] } },
    { command: "purge_media_files", args: { references: ["c"] } },
  ]);
});

test("sizes, categories and preview kinds read naturally", () => {
  assert.equal(media.formatBytes(512), "512 B");
  assert.equal(media.formatBytes(1536), "1.5 KB");
  assert.equal(media.formatBytes(5 * 1024 ** 3), "5.0 GB");
  assert.equal(media.formatBytes(300 * 1024 ** 2), "300 MB");
  assert.equal(media.categoryLabel("task-temp"), "任务临时副本");
  assert.equal(media.categoryLabel("unknown"), "unknown");
  assert.deepEqual(["a.PNG", "b.mp4", "c.wav", "d.json"].map(media.previewKind), ["image", "video", "audio", "file"]);
});

test("trashed files get no preview; files in place are served by reference", () => {
  assert.equal(media.previewUrl(item("a.png")), "/api/resource?resource=sucanvas-input%3A%2F%2Fsucanvas-imports%2Fa.png");
  assert.equal(media.previewUrl(item("a.png", { trashedAt: "2026-10-01T00:00:00Z" })), null);
});

test("days left in the trash count down to zero", () => {
  const trashed = "2026-10-01T00:00:00Z";
  const day = 86400000;
  assert.equal(media.daysLeft(trashed, 30, Date.parse(trashed)), 30);
  assert.equal(media.daysLeft(trashed, 30, Date.parse(trashed) + 29.5 * day), 1);
  assert.equal(media.daysLeft(trashed, 30, Date.parse(trashed) + 40 * day), 0);
});

test("filter by category and user, sort by size, time or name", () => {
  const items = [
    item("big.mp4", { category: "generated", size: 300, createdBy: "alice", unreferencedSince: "2026-10-03T00:00:00.000000Z" }),
    item("small.png", { size: 10, releasedBy: "Bob", unreferencedSince: "2026-10-01T00:00:00.000000Z" }),
    item("mid.png", { size: 50, unreferencedSince: "2026-10-02T00:00:00.000000Z" }),
  ];
  const names = (filter) => media.filterMedia([...items], { category: "", user: "", sort: "size", ...filter }).map((entry) => entry.name);
  assert.deepEqual(names({}), ["big.mp4", "mid.png", "small.png"]);
  assert.deepEqual(names({ sort: "time" }), ["small.png", "mid.png", "big.mp4"]);
  assert.deepEqual(names({ sort: "name" }), ["big.mp4", "mid.png", "small.png"]);
  assert.deepEqual(names({ category: "upload" }), ["mid.png", "small.png"]);
  assert.deepEqual(names({ user: " bob " }), ["small.png"]);
  assert.deepEqual(names({ user: "ALICE" }), ["big.mp4"]);
});

test("only admins get the media cleanup entry and page", async () => {
  const root = await readFile(new URL("../src/web/WebRoot.tsx", import.meta.url), "utf8");
  assert.match(root, /onCleanMedia=\{user\.role === "admin" \? /);
  assert.match(root, /adminPage === "media" && user\.role === "admin" && <MediaCleanupPage/);
  // "#media" reopens the page after a reload for admins only.
  assert.match(root, /if \(next\.role === "admin"\) setAdminPage\(page\); else showAdminHash\(null\);/);
  const menu = await readFile(new URL("../src/web/AccountScreens.tsx", import.meta.url), "utf8");
  assert.match(menu, /\{onCleanMedia && <button[^>]*>.*素材清理/);
});

test("the outcome names every skipped file and why", () => {
  const names = new Map([["sucanvas-input://sucanvas-imports/a.png", "a.png"]]);
  assert.equal(media.outcomeMessage("移入回收区", { done: ["x"], bytes: 2048, skipped: [] }, names), "已移入回收区 1 个（2.0 KB）");
  assert.equal(
    media.outcomeMessage("移入回收区", { done: [], bytes: 0, skipped: [
      { reference: "sucanvas-input://sucanvas-imports/a.png", reason: "仍被画布引用" },
      { reference: "C:\\comfy\\input\\b.png", reason: "仍在宽限期内" },
    ] }, names),
    "已移入回收区 0 个（0 B），跳过 2 个：a.png 仍被画布引用；b.png 仍在宽限期内",
  );
});
