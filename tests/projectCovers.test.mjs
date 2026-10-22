import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// CANVAS-021: the project home showed covers from the originals (several MB each) and gave no
// sign that a click was being handled, so opening a canvas seemed to wait for every cover.
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const source = await readFile(new URL("../src/projects/coverSrc.ts", import.meta.url), "utf8").catch(() => "export {};");
const covers = await import(`data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`);
const home = await readFile(new URL("../src/projects/ProjectHome.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/App.css", import.meta.url), "utf8");

test("Web covers come from /api/thumbnail; desktop and other URLs are unchanged", () => {
  const resource = "/api/resource?resource=sucanvas-input%3A%2F%2Fsucanvas-imports%2Fcover.png";
  assert.equal(covers.coverThumbnailSrc(resource), "/api/thumbnail?resource=sucanvas-input%3A%2F%2Fsucanvas-imports%2Fcover.png");
  for (const other of ["http://asset.localhost/C%3A%2Fcover.png", "asset://localhost/cover.png", "/api/comfy/view?filename=a.png", "data:image/png;base64,AA", ""]) {
    assert.equal(covers.coverThumbnailSrc(other), other);
  }
});

test("covers load lazily at low priority, through the thumbnail URL, including the fallback cover", () => {
  const thumbnail = home.slice(home.indexOf("function ProjectThumbnail("), home.indexOf("type ProjectHomeProps"));
  assert.match(thumbnail, /loading="lazy"/);
  assert.match(thumbnail, /decoding="async"/);
  assert.match(thumbnail, /fetchPriority="low"/);
  assert.equal((thumbnail.match(/coverThumbnailSrc\(convertFileSrc\(/g) ?? []).length, 2, "cover and fallback cover");
  assert.doesNotMatch(thumbnail, /src=\{convertFileSrc\(/);
});

test("a clicked card shows that it is opening and the other covers stop loading", () => {
  assert.match(home, /const \[openingProjectId, setOpeningProjectId\] = useState<string \| null>\(null\)/);
  const card = home.slice(home.indexOf("const renderCard = "), home.indexOf("const section = (title"));
  assert.match(card, /is-opening/);
  assert.match(card, /aria-busy=/);
  assert.match(card, /suspendCover=\{openingProjectId !== null\}/);
  const thumbnail = home.slice(home.indexOf("function ProjectThumbnail("), home.indexOf("type ProjectHomeProps"));
  // No src while suspended: the browser drops the unfinished cover requests.
  assert.match(thumbnail, /src=\{suspendCover \? undefined : /);
  assert.match(thumbnail, /正在打开…/);
  // A failed open (the error is reported by openProject) leaves the card clickable again.
  assert.match(home, /\.finally\(\(\) => setOpeningProjectId\(\(current\) => \(current === projectId \? null : current\)\)\)/);
  assert.match(css, /\.project-opening-overlay \{/);
});
