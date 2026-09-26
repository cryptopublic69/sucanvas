import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/video/submissionWait.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { withSubmissionWaitNotice } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("slow submission reports its stage once and still waits for the original request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let calls = 0;
  const notices = [];
  const pending = withSubmissionWaitNotice(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  }, "saving", (message) => notices.push(message));
  t.mock.timers.tick(4999);
  assert.deepEqual(notices, []);
  t.mock.timers.tick(1);
  assert.deepEqual(notices, ["saving"]);
  t.mock.timers.tick(30000);
  assert.equal(calls, 1);
  assert.equal(notices.length, 1);
  finish("created");
  assert.equal(await pending, "created");
});

test("completed and rejected submissions clear pending wait notices", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notices = [];
  const notify = (message) => notices.push(message);
  assert.equal(await withSubmissionWaitNotice(async () => 42, "done", notify), 42);
  await assert.rejects(withSubmissionWaitNotice(async () => {
    throw new Error("save failed");
  }, "failed", notify), /save failed/);
  t.mock.timers.tick(10000);
  assert.deepEqual(notices, []);
});
