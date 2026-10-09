import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createWebDevProxy, localSessionCookie, validOrigin, webDevOriginGuard } from "../scripts/web/dev-proxy.mjs";

const source = await readFile(new URL("../src/web/urls.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { webApiUrl, webApiUrls } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const remote = "https://192.168.5.108:18741";
const local = "http://127.0.0.1:1422";
const request = (origin = local) => ({ headers: { host: "127.0.0.1:1422", origin }, socket: {} });

test("dev responses and events route only backend media/Comfy URLs through the local origin", () => {
  const result = { result: { comfyServerUrl: remote + "/api/comfy", imageUrl: remote + "/api/comfy/view?filename=a.png", asset: "sucanvas://assets/a.png", number: 4, other: remote + "/guide" } };
  const converted = webApiUrls(result, remote, local);
  assert.equal(converted.result.comfyServerUrl, local + "/api/comfy");
  assert.equal(converted.result.imageUrl, local + "/api/comfy/view?filename=a.png");
  assert.equal(converted.result.asset, "sucanvas://assets/a.png");
  assert.equal(converted.result.other, remote + "/guide");
  assert.equal(result.result.comfyServerUrl, remote + "/api/comfy");
  assert.equal(webApiUrls(result, "", local), result);
  assert.equal(webApiUrl(remote + ".attacker.invalid/api/comfy", remote, local), remote + ".attacker.invalid/api/comfy");
  assert.equal(webApiUrl(remote + "/api/comfylike", remote, local), remote + "/api/comfylike");
});

test("dev command serialization returns local URLs to the backend and preserves Channels", () => {
  const input = { output: { url: local + "/api/resource?resource=sucanvas%3A%2F%2Fassets%2Fa.png" }, onSubmitted: { toJSON: () => ({ __webChannel: "channel-id" }) } };
  const converted = JSON.parse(JSON.stringify(input, (_key, value) => typeof value === "string" ? webApiUrl(value, local, remote) : value));
  assert.equal(converted.output.url, remote + "/api/resource?resource=sucanvas%3A%2F%2Fassets%2Fa.png");
  assert.deepEqual(converted.onSubmitted, { __webChannel: "channel-id" });
});

test("local proxy cookie adaptation preserves HttpOnly/SameSite and leaves other cookies alone", () => {
  const cookie = "sucanvas_session=token; HttpOnly; SameSite=Strict; Path=/; Max-Age=10; Secure";
  assert.equal(localSessionCookie(cookie), cookie.replace("; Secure", ""));
  assert.equal(localSessionCookie("other=token; Secure"), "other=token; Secure");
});

test("local API proxy rejects foreign origins and non-loopback hostnames", () => {
  assert.equal(validOrigin(request(), true), true);
  assert.equal(validOrigin({ headers: { host: "127.0.0.1:1422" } }, true), false);
  assert.equal(validOrigin(request("https://foreign.invalid")), false);
  assert.equal(validOrigin({ headers: { host: "foreign.invalid", origin: "http://foreign.invalid" } }), false);
  let middleware;
  webDevOriginGuard().configureServer({ middlewares: { use: (value) => { middleware = value; } } });
  let next = false, ended = false;
  const response = { statusCode: 200, end: () => { ended = true; } };
  middleware({ ...request("https://foreign.invalid"), url: "/api/auth/login", method: "POST" }, response, () => { next = true; });
  assert.equal(response.statusCode, 403);
  assert.equal(ended, true);
  assert.equal(next, false);
});

test("HTTP and WebSocket proxy share verified HTTPS, origin translation and long requests", () => {
  const configuration = createWebDevProxy(remote)["/api"];
  assert.equal(configuration.secure, true);
  assert.equal(configuration.agent.options.rejectUnauthorized, true);
  assert.equal(configuration.proxyTimeout, 0);
  assert.equal(configuration.timeout, 0);
  const proxy = new EventEmitter();
  configuration.configure(proxy);
  const headers = {};
  proxy.emit("proxyReq", { setHeader: (key, value) => { headers[key] = value; } }, request());
  assert.equal(headers.origin, remote);
  proxy.emit("proxyReqWs", { setHeader: (key, value) => { headers[key] = value; } }, request(), {});
  assert.equal(headers.origin, remote);
  let aborted = false;
  proxy.emit("proxyReqWs", { destroy: () => { aborted = true; } }, request("https://foreign.invalid"), { destroy() {} });
  assert.equal(aborted, true);
  const response = { headers: { "set-cookie": ["sucanvas_session=x; Secure; HttpOnly; SameSite=Strict"] } };
  proxy.emit("proxyRes", response, request());
  assert.equal(response.headers["set-cookie"][0], "sucanvas_session=x; HttpOnly; SameSite=Strict");
  configuration.agent.destroy();
  assert.throws(() => createWebDevProxy(remote + "/path"));
});
