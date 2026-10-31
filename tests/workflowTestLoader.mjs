// CANVAS-024c: loads src/workflow/*.ts(x) for node tests. Files are transpiled into
// node_modules/.cache/workflow-tests so bare imports (react, react-dom) resolve from the repo;
// relative imports between workflow files are pointed at the transpiled copies.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const cache = new URL("../node_modules/.cache/workflow-tests/", import.meta.url);
const done = new Map();

async function transpile(name) {
  if (done.has(name)) return done.get(name);
  const promise = (async () => {
    const tsx = new URL(`../src/workflow/${name}.tsx`, import.meta.url);
    const ts_ = new URL(`../src/workflow/${name}.ts`, import.meta.url);
    let source;
    try { source = await readFile(tsx, "utf8"); } catch { source = await readFile(ts_, "utf8"); }
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const relative = [...output.matchAll(/from\s+"\.\/([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
    for (const dependency of relative) await transpile(dependency);
    await mkdir(cache, { recursive: true });
    const target = new URL(`${name}.mjs`, cache);
    await writeFile(target, output.replace(/from\s+"\.\/([A-Za-z0-9_]+)"/g, 'from "./$1.mjs"'));
    return target;
  })();
  done.set(name, promise);
  return promise;
}

export async function loadWorkflowModule(name) {
  return import((await transpile(name)).href);
}

export async function readJson(relative) {
  return JSON.parse(await readFile(new URL(`../${relative}`, import.meta.url), "utf8"));
}
