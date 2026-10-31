import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";
import { SNAPSHOT, controlsMarkup } from "./workflowControlsMarkup.mjs";

// CANVAS-025: a repeat group is laid out by field type, one line per item:
// index | select (main width) | slider + number | switch | delete. The heading, the count and the
// add button appear once; inside an item no field label is drawn (the accessible names stay).
const controls = await loadWorkflowModule("WorkflowControls");

// A made-up group whose package order puts the switch first: the layout follows the field types.
const group = {
  id: "extras", type: "repeat", label: "附加", max: 4, fields: [
    { id: "on", type: "toggle", label: "开关", default: true },
    { id: "name", type: "select", label: "名称", default: "", allowEmpty: true, emptyLabel: "不使用",
      options: { values: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] } },
    { id: "weight", type: "slider", label: "强度", default: 1, min: 0, max: 2, step: 0.05, number: "float" },
  ],
};

const render = (operation, values) => renderToStaticMarkup(createElement(controls.WorkflowControls, {
  operation, values, choicesFor: () => ({ status: "ready", values: ["x\\a.safetensors", "x\\b.safetensors"] }), onChange: () => {},
}));

/** The repeat section, then each item's own markup (from its opening tag to the next item). */
function sections(markup, label) {
  const open = `<section class="workflow-repeat" aria-label="${label}">`;
  const start = markup.indexOf(open);
  assert.ok(start >= 0, `no repeat section ${label} in ${markup}`);
  const section = markup.slice(start, markup.indexOf("</section>", start) + "</section>".length);
  const items = section.split('<div class="workflow-repeat-item"').slice(1).map((part) => `<div class="workflow-repeat-item"${part}`);
  return { section, items };
}

const count = (text, needle) => text.split(needle).length - 1;

function assertItem(item, index, labels) {
  const { group: groupLabel, select, slider, toggle } = labels;
  // One select, one slider with its number, one switch, one delete, in that order.
  assert.equal(count(item, "<select"), 1, item);
  assert.equal(count(item, 'type="range"'), 1, item);
  assert.equal(count(item, 'type="number"'), 1, item);
  assert.equal(count(item, 'role="switch"'), 1, item);
  assert.equal(count(item, `aria-label="删除${groupLabel} ${index}"`), 1, item);
  const at = (needle) => { const position = item.indexOf(needle); assert.ok(position >= 0, `${needle} in ${item}`); return position; };
  assert.ok(at('class="workflow-repeat-index"') < at('class="workflow-repeat-main"'));
  assert.ok(at('class="workflow-repeat-main"') < at("<select"));
  assert.ok(at("<select") < at('class="workflow-repeat-tools"'));
  assert.ok(at('class="workflow-repeat-tools"') < at('type="range"'));
  assert.ok(at('type="range"') < at('type="number"'));
  assert.ok(at('type="number"') < at('role="switch"'));
  assert.ok(at('role="switch"') < at(`aria-label="删除${groupLabel} ${index}"`));
  // The slider and its number sit side by side in one field.
  assert.match(item, /<input[^>]*type="range"[^>]*\/><input[^>]*type="number"[^>]*\/>/);
  // The index is the only number drawn as text; no field label, numbered or not, is drawn.
  assert.match(item, new RegExp(`<span class="workflow-repeat-index"[^>]*>${index}</span>`));
  for (const label of [groupLabel, select, slider, toggle]) {
    assert.doesNotMatch(item, new RegExp(`>${label}( ${index})?<`), `visible "${label}" in item ${index}`);
  }
  // Each control keeps an accessible name that tells the items apart.
  assert.match(item, new RegExp(`<select[^>]*aria-label="${select} ${index}"`));
  assert.match(item, new RegExp(`type="number"[^>]*aria-label="${slider} ${index}"|aria-label="${slider} ${index}"[^>]*type="number"`));
  assert.match(item, new RegExp(`role="switch"[^>]*aria-label="${toggle} ${index}"|aria-label="${toggle} ${index}"[^>]*role="switch"`));
}

test("a repeat item is one line: index, select, slider with its number, switch, delete — no field labels", () => {
  for (const n of [1, 3]) {
    const markup = render({ controls: [group] }, { extras: Array.from({ length: n }, () => ({ name: "a" })) });
    const { section, items } = sections(markup, "附加");
    assert.equal(items.length, n);
    items.forEach((item, position) => assertItem(item, position + 1, { group: "附加", select: "名称", slider: "强度", toggle: "开关" }));
    // Heading, count and add button once for the whole group.
    assert.equal(count(section, ">附加<"), 1, section);
    assert.equal(count(section, `>${n}/4<`), 1, section);
    assert.equal(count(section, 'aria-label="添加附加"'), 1, section);
    assert.equal(count(section, 'class="workflow-repeat-heading"'), 1, section);
  }
});

test("an empty repeat group shows only its heading, count and add button", () => {
  const { section, items } = sections(render({ controls: [group] }, {}), "附加");
  assert.equal(items.length, 0);
  assert.equal(count(section, ">附加<"), 1);
  assert.equal(count(section, ">0/4<"), 1);
  assert.equal(count(section, 'aria-label="添加附加"'), 1);
});

test("the image package with a repeat group draws it the same way", async () => {
  // The package source itself (the described fixture predates its repeat group).
  const adapter = await readJson("workflow-packages/image-v2/5dd20ec7/adapter.json");
  const operation = adapter.operations.generate;
  const repeat = operation.controls.find((control) => control.type === "repeat");
  const [select, slider, toggle] = ["select", "slider", "toggle"].map((type) => repeat.fields.find((field) => field.type === type).label);
  const markup = render(operation, { [repeat.id]: [{}, { on: false }, {}] });
  const { section, items } = sections(markup, repeat.label);
  assert.equal(items.length, 3);
  items.forEach((item, position) => assertItem(item, position + 1, { group: repeat.label, select, slider, toggle }));
  assert.equal(count(section, `>${repeat.label}<`), 1, section);
});

test("controls outside the repeat group render exactly as before CANVAS-025", async () => {
  const before = await readJson(SNAPSHOT);
  const now = await controlsMarkup();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(before).sort());
  for (const key of Object.keys(before)) assert.equal(now[key], before[key], key);
});
