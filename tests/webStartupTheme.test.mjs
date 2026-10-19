import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// CANVAS-012c5 item 4: the Web CSP is script-src 'self'; an inline script in
// index.html never runs there. The startup theme is a same-origin file.
test("index.html has no inline script; the startup theme is a same-origin file the build injects", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc=/, "every script has a src");
    assert.equal(body.trim(), "", "no inline code");
  }
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /plugins: \[react\(\), startupTheme\(\)/, "for desktop and Web builds alike");
  assert.match(config, /startup-theme-\$\{createHash/, "hashed name in the versioned assets folder");
});

function run(storage) {
  const root = { dataset: {}, style: {} };
  return readFile(new URL("../src/startup-theme.js", import.meta.url), "utf8").then((source) => {
    vm.runInNewContext(source, { localStorage: storage, document: { documentElement: root } });
    return root;
  });
}

test("the startup theme follows the saved theme and falls back to dark", async () => {
  const light = await run({ getItem: (key) => (key === "infinite-canvas:theme" ? "light" : null) });
  assert.deepEqual([light.dataset.startupTheme, light.style.colorScheme], ["light", "light"]);
  const unset = await run({ getItem: () => null });
  assert.equal(unset.dataset.startupTheme, "dark");
  const blocked = await run({ getItem: () => { throw new Error("storage disabled"); } });
  assert.deepEqual([blocked.dataset.startupTheme, blocked.style.colorScheme], ["dark", "dark"]);
});
