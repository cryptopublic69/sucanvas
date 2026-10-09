import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceBackend } from "../scripts/web/dev-files.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sucanvas-dev-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = { compiled: path.join(directory, "new.exe"), running: path.join(directory, "running.exe"), previous: path.join(directory, "previous.exe") };
  await writeFile(files.compiled, "new");
  await writeFile(files.running, "old");
  return files;
}

test("development update retains the previous executable until the new one starts", async (t) => {
  const files = await fixture(t), starts = [];
  const result = await replaceBackend({ ...files, retainPrevious: true, stop: async () => {}, start: async () => starts.push(await readFile(files.running, "utf8")) });
  assert.equal(result, null);
  assert.deepEqual(starts, ["new"]);
  assert.equal(await readFile(files.previous, "utf8"), "old");
});

test("failed startup restores and starts the previous executable", async (t) => {
  const files = await fixture(t), starts = [];
  const failure = new Error("new backend failed");
  const result = await replaceBackend({ ...files, retainPrevious: true, stop: async () => {}, start: async () => {
    const version = await readFile(files.running, "utf8");
    starts.push(version);
    if (version === "new") throw failure;
  } });
  assert.equal(result, failure);
  assert.deepEqual(starts, ["new", "old"]);
  assert.equal(await readFile(files.running, "utf8"), "old");
});

test("missing compiled executable restores the stopped backend instead of leaving it offline", async (t) => {
  const files = await fixture(t);
  let started = "";
  const result = await replaceBackend({ ...files, compiled: files.compiled + ".missing", retainPrevious: true, stop: async () => {}, start: async () => { started = await readFile(files.running, "utf8"); } });
  assert.equal(result.code, "ENOENT");
  assert.equal(started, "old");
});

test("initial startup failure remains an error when no previous backend exists", async (t) => {
  const files = await fixture(t);
  const failure = new Error("initial failure");
  await assert.rejects(replaceBackend({ ...files, retainPrevious: false, stop: async () => {}, start: async () => { throw failure; } }), (error) => error === failure);
});
