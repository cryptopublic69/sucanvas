import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/web/generationRequest.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { generationRequest, WebHttpError, recoverableWebGenerationFailure } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const taskId = "test-task";
const options = { taskId, sleep: async () => {} };

test("old gateway-failed placeholders can recover without retrying real execution failures", () => {
  const content = { generationPlaceholder: true, status: "invalid", placeholderClientId: "c", validationMessage: "生成失败：<html><head><title>504 Gateway Time-out</title></head>" };
  assert.equal(recoverableWebGenerationFailure(content), true);
  assert.equal(recoverableWebGenerationFailure({ ...content, validationMessage: "生成失败：服务器请求失败（HTTP 504）" }), true);
  assert.equal(recoverableWebGenerationFailure({ ...content, placeholderClientId: "" }), false);
  assert.equal(recoverableWebGenerationFailure({ ...content, generationPlaceholder: false }), false);
  assert.equal(recoverableWebGenerationFailure({ ...content, validationMessage: "生成失败：ComfyUI 生成失败：node 504 execution error" }), false);
  assert.equal(recoverableWebGenerationFailure({ ...content, validationMessage: "恢复失败：任务不在 ComfyUI 队列或最近历史记录中" }), false);
});

test("a 504 on submission still retrieves the finished video without submitting twice", async () => {
  const calls = [];
  let polls = 0;
  const output = { promptId: "prompt-1", outputs: [{ filename: "clip.mp4" }] };
  const request = async (path, init, timeout) => {
    calls.push({ path, init, timeout });
    if (init?.method === "POST") {
      assert.equal(JSON.parse(init.body).webTaskId, taskId);
      throw new WebHttpError(504, "Gateway Time-out");
    }
    if (++polls === 1) throw new TypeError("network unavailable");
    if (polls === 2) throw new WebHttpError(504, "Gateway Time-out");
    if (polls === 3) return { pending: true };
    return { result: output };
  };
  assert.deepEqual(await generationRequest(request, "submit_comfyui_workflow", '{"args":{"input":{"clientId":"c"}}}', options), output);
  assert.equal(calls.filter(call => call.init?.method === "POST").length, 1);
  assert.ok(calls.every(call => call.timeout === 20_000));
  assert.ok(calls.slice(1).every(call => call.path === `/api/generation-tasks/${taskId}`));
});

test("server task failures and authentication failures still reach the caller", async () => {
  let calls = 0;
  await assert.rejects(generationRequest(async () => ++calls === 1 ? { taskId } : { error: "ComfyUI execution failed" }, "submit_comfyui_workflow", "{}", options), /ComfyUI execution failed/);
  calls = 0;
  await assert.rejects(generationRequest(async () => { calls++; throw new WebHttpError(401, "请重新登录"); }, "submit_comfyui_workflow", "{}", options), /请重新登录/);
  assert.equal(calls, 1);
});

test("a lost task record keeps recovery available and only reports the interruption once", async () => {
  let calls = 0, notices = 0;
  const result = await generationRequest(async () => {
    if (++calls === 1) return { taskId };
    if (calls < 4) throw new WebHttpError(404, "missing");
    return { result: { promptId: "p" } };
  }, "submit_comfyui_image_workflow", "{}", { ...options, onUnavailable: () => notices++ });
  assert.deepEqual(result, { promptId: "p" });
  assert.equal(notices, 1);
});
