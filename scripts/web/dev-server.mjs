import { spawn } from "node:child_process";
import { readdir, stat, readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceBackend } from "./dev-files.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const devRoot = path.join(repo, ".web-dev");
const config = JSON.parse((await readFile(path.join(devRoot, "dev-config.json"), "utf8")).replace(/^\uFEFF/, ""));
const statusPath = path.join(devRoot, "dev-status.json");
const stopPath = path.join(devRoot, "dev-stop.request");
const children = new Set();
let backend, building = false, stopping = false, started = false, timer;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let statusWrites = Promise.resolve();
const status = (state, message = "") => statusWrites = statusWrites.then(async () => {
  const value = { state, message, url: config.frontendUrl, supervisorPid: process.pid, at: new Date().toISOString() };
  await writeFile(statusPath + ".tmp", JSON.stringify(value));
  await rename(statusPath + ".tmp", statusPath);
  console.log(`[${value.at}] ${state}: ${message}`);
});
function launch(executable, args, env = process.env) {
  if (stopping) throw new Error("Development is stopping.");
  const child = spawn(executable, args, { cwd: repo, env, windowsHide: true, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.on("error", (error) => console.error(error.message));
  child.once("error", () => children.delete(child));
  return child;
}
function completion(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = completion(child);
  if (process.platform === "win32") {
    // Cargo launches rustc/link.exe; stop only this owned child tree.
    const killer = spawn(path.join(process.env.SystemRoot || "C:/Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await completion(killer);
  } else child.kill();
  await done;
}
async function ready(child, url) {
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Process exited before ready: ${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.status === 200 || response.status === 401) return;
    } catch { /* startup */ }
    await sleep(250);
  }
  throw new Error(`Startup timeout: ${url}`);
}
async function checkPort(port, host) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function fingerprint() {
  const entries = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(location);
      else if (entry.isFile()) { const info = await stat(location); entries.push(`${location}:${info.size}:${info.mtimeMs}`); }
    }
  }
  await scan(path.join(repo, "src-tauri/src"));
  for (const name of ["Cargo.toml", "Cargo.lock", "build.rs"]) {
    const location = path.join(repo, "src-tauri", name), info = await stat(location);
    entries.push(`${location}:${info.size}:${info.mtimeMs}`);
  }
  return entries.sort().join("\n");
}
async function startBackend() {
  backend = launch(path.join(config.runtime, "SuCanvasServer.exe"), ["--config", path.join(config.runtime, "config.json")], {
    ...process.env, PATH: `${config.tools}${path.delimiter}${process.env.PATH || process.env.Path || ""}`,
  });
  await ready(backend, `http://127.0.0.1:${config.backendPort}/api/auth/session`);
}
async function rebuild(initial = false) {
  building = true;
  try {
    await status("building", "Compiling local Rust; existing backend remains running.");
    const build = launch(config.cargo, ["build", "--manifest-path", "src-tauri/Cargo.toml", "--no-default-features", "--features", "server", "--bin", "SuCanvasServer", "--locked"], { ...process.env, CARGO_TARGET_DIR: config.target });
    const result = await completion(build);
    if (stopping) return;
    if (result !== 0) {
      await status("build-failed", "Fix the Rust error and save again. The previous backend is retained.");
      if (initial) throw new Error("Initial Rust build failed.");
      return;
    }
    // The running EXE is a separate copy, so Cargo can rebuild without a Windows file lock.
    const runningExe = path.join(config.runtime, "SuCanvasServer.exe");
    const previousExe = path.join(config.runtime, "SuCanvasServer.previous.exe");
    const hadBackend = !!backend && backend.exitCode === null && backend.signalCode === null;
    await status("restarting", "Rust build succeeded; restarting development backend.");
    const error = await replaceBackend({
      compiled: path.join(config.target, "debug/SuCanvasServer.exe"), running: runningExe,
      previous: previousExe, retainPrevious: hadBackend,
      stop: () => stopChild(backend), start: startBackend,
    });
    if (error) {
      await status("restart-failed", `Previous executable restarted: ${error.message}`);
      return;
    }
    await status(initial ? "starting" : "ready", "Rust backend updated. Refresh the page and sign in again if needed.");
  } finally { building = false; }
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await status("stopping");
  await Promise.all([...children].map(stopChild));
  await status("stopped");
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  await status("starting");
  await checkPort(config.backendPort, "127.0.0.1");
  await checkPort(config.frontendPort, "127.0.0.1");
  let lastFingerprint = await fingerprint();
  // Stop requests must work even during the initial build.
  let polling = false;
  timer = setInterval(async () => {
    if (polling || stopping) return;
    polling = true;
    try {
      if (await stat(stopPath).then(() => true, () => false)) { await shutdown(); return; }
      if (building || !started) return;
      const latest = await fingerprint();
      if (latest !== lastFingerprint) {
        await sleep(700);
        lastFingerprint = await fingerprint();
        if (!stopping) void rebuild().catch(async (error) => {
          console.error(error);
          await status("failed", error.message);
        });
      }
    } catch (error) { console.error(error); }
    finally { polling = false; }
  }, 1000);
  await rebuild(true);
  if (stopping) process.exit(0);
  const vite = launch(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--mode", "web", "--host", "127.0.0.1", "--port", String(config.frontendPort)], {
    ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "1", SUCANVAS_WEB_BACKEND: `http://127.0.0.1:${config.backendPort}`,
    SUCANVAS_WEB_DEV_ORIGIN: "", SUCANVAS_WEB_DEV_PORT: String(config.frontendPort), SUCANVAS_WEB_CA_FILE: "",
  });
  await ready(vite, `http://127.0.0.1:${config.frontendPort}`);
  vite.once("exit", () => { if (!stopping) void status("failed", "Development frontend exited; see logs.").then(() => shutdown(1)); });
  await status("ready", config.frontendUrl);
  started = true;
} catch (error) {
  console.error(error);
  await shutdown(1);
}
