import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// CANVAS-043: scripts/web/Test-WebDeployment.ps1 runs `caddy adapt` under $ErrorActionPreference = 'Stop'. caddy writes
// "Caddyfile input is not formatted" to stderr with exit code 0; when the caller redirects PowerShell's streams (`*>`,
// `2>&1`, as the first 041p deploy did) Windows PowerShell 5.1 turns that stderr line into a NativeCommandError and the
// validator stops. Only caddy's exit code may decide, and only stdout is JSON. The real validator runs here against a
// minimal valid deployment with a fake caddy.exe (stdout JSON, one stderr warn line, chosen exit code).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = path.join(ROOT, "scripts", "web", "Test-WebDeployment.ps1");
const windows = process.platform === "win32";
const POWERSHELL = windows ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
const WARN = '{"level":"warn","logger":"caddyfile","msg":"Caddyfile input is not formatted; run \'caddy fmt --overwrite\' to fix inconsistencies"}';
const sha = (text) => createHash("sha256").update(text).digest("hex").toUpperCase();
const adapted = (host) => JSON.stringify({ apps: { http: { servers: { srv0: { routes: [{ match: [{ host: [host] }] }] } } } } });

let area;
let deployment;
function env() {
  // Windows PowerShell must load its own modules, not inherited PowerShell 7 modules (same as webDeploymentSmoke.py).
  return { ...process.env, PSModulePath: path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") };
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function setup() {
  mkdirSync(path.join(ROOT, ".web-dev"), { recursive: true });
  area = mkdtempSync(path.join(ROOT, ".web-dev", "validator-caddy-stderr-"));
  deployment = path.join(area, "deployment");
  const version = "v043test";
  const script = "console.log('043');\n";
  const index = `<!doctype html><html><head><script type="module" src="/assets/${version}/index.js"></script></head></html>\n`;
  mkdirSync(path.join(deployment, "web", "assets", version), { recursive: true });
  mkdirSync(path.join(deployment, "proxy"));
  writeFileSync(path.join(deployment, "web", "assets", version, "index.js"), script);
  writeFileSync(path.join(deployment, "web", "index.html"), index);
  writeFileSync(path.join(deployment, "web-assets.json"), JSON.stringify({
    assetVersion: version, index: { sha256: sha(index) }, assets: [{ path: `/assets/${version}/index.js`, sha256: sha(script) }],
  }));
  writeFileSync(path.join(deployment, "config.json"), JSON.stringify({ publicUrl: "http://127.0.0.1:8099", webDirectory: "web" }));
  writeFileSync(path.join(deployment, "proxy", "Caddyfile"), "http://127.0.0.1:8099 {\n respond \"mock\"\n}\n");
  // Fake caddy.exe: prints fake-stdout.txt to stdout, one warn line to stderr, exits with fake-exit.txt.
  const source = `using System; using System.IO;
public static class FakeCaddy {
  public static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    File.WriteAllText(Path.Combine(dir, "fake-args.txt"), String.Join(" ", args));
    Console.Out.Write(File.ReadAllText(Path.Combine(dir, "fake-stdout.txt")));
    Console.Out.Flush();
    Console.Error.WriteLine(${JSON.stringify(WARN)});
    Console.Error.Flush();
    return Int32.Parse(File.ReadAllText(Path.Combine(dir, "fake-exit.txt")).Trim());
  }
}`;
  writeFileSync(path.join(area, "FakeCaddy.cs"), source);
  execFileSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `Add-Type -TypeDefinition (Get-Content -LiteralPath ${quote(path.join(area, "FakeCaddy.cs"))} -Raw) -OutputType ConsoleApplication -OutputAssembly ${quote(path.join(deployment, "proxy", "caddy.exe"))}`],
  { env: env(), stdio: "pipe" });
}

function caddy(stdout, exitCode) {
  writeFileSync(path.join(deployment, "proxy", "fake-stdout.txt"), stdout);
  writeFileSync(path.join(deployment, "proxy", "fake-exit.txt"), String(exitCode));
}

// Call the validator the way a caller does. "redirect-all" is the first 041p deploy (`& script *> file`), "merge-errors"
// is `2>&1`; "process" redirects only at the process level (what launch-deploy.cmd does). Returns returned/threw + text.
function validate(mode) {
  const out = path.join(area, `out-${mode}.txt`);
  const call = `& ${quote(VALIDATOR)} -DeploymentDirectory ${quote(deployment)}`;
  const body = {
    "redirect-all": `${call} *> ${quote(out)}`,
    "merge-errors": `${call} 2>&1 | Out-File -LiteralPath ${quote(out)} -Encoding utf8`,
    process: call,
  }[mode];
  const wrapper = `$ErrorActionPreference = 'Continue'
try { ${body}; 'WRAPPER: returned' } catch { 'WRAPPER: threw: ' + $_.Exception.Message + ' | ' + $_.FullyQualifiedErrorId }
if (Test-Path -LiteralPath ${quote(out)}) { '--- redirected:'; Get-Content -LiteralPath ${quote(out)} }`;
  const result = spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", wrapper], { env: env(), encoding: "utf8" });
  rmSync(out, { force: true });
  const text = `${result.stdout}\n${result.stderr}`;
  return { returned: text.includes("WRAPPER: returned"), text };
}

test("Test-WebDeployment: caddy stderr warn with exit 0 passes under every redirection; only the exit code decides", { skip: !windows && "Windows PowerShell only" }, (t) => {
  setup();
  t.after(() => rmSync(area, { recursive: true, force: true }));

  // Every case runs; the failures are listed together so one run shows the whole picture.
  const problems = [];
  const expect = (ok, label, r) => { if (!ok) problems.push(`${label}\n${r.text.trim()}`); };

  caddy(adapted("127.0.0.1"), 0);
  for (const mode of ["redirect-all", "merge-errors", "process"]) {
    const r = validate(mode);
    expect(r.returned && r.text.includes("PASS: local release files") && !r.text.includes("NativeCommandError"), `${mode}: warn + exit 0 must pass`, r);
    expect(r.text.includes("Caddyfile input is not formatted"), `${mode}: the stderr line is shown for troubleshooting`, r);
  }
  assert.equal(readFileSync(path.join(deployment, "proxy", "fake-args.txt"), "utf8"), `adapt --config ${path.join(deployment, "proxy", "Caddyfile")} --adapter caddyfile`);

  // stdout alone is the JSON: a wrong host is still found (the stderr line did not break or replace the JSON).
  caddy(adapted("wrong.invalid"), 0);
  for (const mode of ["redirect-all", "process"]) {
    const r = validate(mode);
    expect(!r.returned && r.text.includes("Caddy host matcher does not contain the publicUrl hostname."), `${mode}: host check still works`, r);
  }

  // A failing adapt still stops the check with the same message, under every redirection.
  caddy("not json", 1);
  for (const mode of ["redirect-all", "merge-errors", "process"]) {
    const r = validate(mode);
    expect(!r.returned && r.text.includes("Caddyfile cannot be parsed."), `${mode}: exit 1 -> Caddyfile cannot be parsed.`, r);
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n\n")}`);
});

test("Test-WebDeployment keeps the global Stop and does not swallow everything", () => {
  const source = readFileSync(VALIDATOR, "utf8");
  assert.ok(/^\$ErrorActionPreference = 'Stop'\r?$/m.test(source), "global $ErrorActionPreference = 'Stop' stays");
  assert.ok(source.includes("throw 'Caddyfile cannot be parsed.'"), "a failing adapt still throws");
  assert.ok(!/catch\s*\{\s*\}/.test(source), "no empty catch");
});
