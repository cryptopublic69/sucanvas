import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-027: the node's prompt box is drawn right above the package's negative prompt control,
// found by the control's own fields (the program's negative prompt id on a text control), never
// by package. Without such a control the prompt stays where it was (above every control).
const pkg = await loadWorkflowModule("workflowPackage");
const controls = await loadWorkflowModule("WorkflowControls");
const PACKAGES = ["0bf9145b", "52cba27b", "5dd20ec7"];
const generate = async (short) => (await readJson(`workflow-packages/image-v2/${short}/adapter.json`)).operations.generate;

const probe = createElement("section", { className: "prompt-probe" }, "P");
const PROBE = '<section class="prompt-probe">P</section>';
const render = (operation, values, before) => renderToStaticMarkup(createElement(controls.WorkflowControls, {
  operation, values, before, choicesFor: () => ({ status: "loading" }), onChange: () => {},
}));
const count = (text, needle) => text.split(needle).length - 1;

test("the negative prompt control is found by its control fields in every image package", async () => {
  for (const short of PACKAGES) {
    const anchor = pkg.promptAnchorControl(await generate(short), {});
    assert.equal(anchor?.id, pkg.NEGATIVE_PROMPT_CONTROL_ID, short);
    assert.equal(anchor?.type, "textarea", short);
  }
});

test("no anchor without a visible text control of that id", () => {
  const plain = { controls: [{ id: "steps", type: "number", label: "步数", default: 8 }] };
  assert.equal(pkg.promptAnchorControl(plain, {}), undefined);
  const notText = { controls: [{ id: pkg.NEGATIVE_PROMPT_CONTROL_ID, type: "select", label: "x", options: { values: [] } }] };
  assert.equal(pkg.promptAnchorControl(notText, {}), undefined);
  const hidden = { controls: [
    { id: "on", type: "toggle", default: false },
    { id: pkg.NEGATIVE_PROMPT_CONTROL_ID, type: "textarea", visibleWhen: { truthy: { control: "on" } } },
  ] };
  assert.equal(pkg.promptAnchorControl(hidden, {}), undefined);
  assert.equal(pkg.promptAnchorControl(hidden, { on: true })?.id, pkg.NEGATIVE_PROMPT_CONTROL_ID);
});

test("the prompt box sits immediately before the negative prompt, after the controls above it", async () => {
  for (const short of PACKAGES) {
    const operation = await generate(short);
    const markup = render(operation, {}, { controlId: pkg.NEGATIVE_PROMPT_CONTROL_ID, content: probe });
    assert.equal(count(markup, PROBE), 1, short);
    const negative = markup.indexOf('<label class="image-generation-negative-field');
    assert.ok(negative > 0, short);
    // Directly adjacent: nothing between the prompt box and the negative prompt field.
    assert.equal(markup.indexOf(PROBE) + PROBE.length, negative, short);
    // Every control the package declares before the negative prompt is still drawn before the prompt box.
    const shown = pkg.visibleControls(operation, {}).filter((control) => control.type !== "seed");
    const at = shown.findIndex((control) => control.id === pkg.NEGATIVE_PROMPT_CONTROL_ID);
    for (const control of shown.slice(0, at)) {
      const where = control.type === "repeat"
        ? markup.indexOf(`<section class="workflow-repeat" aria-label="${control.label}">`)
        : markup.indexOf(`aria-label="${control.label}"`);
      assert.ok(where >= 0 && where < markup.indexOf(PROBE), `${short}: ${control.id} before the prompt`);
    }
    for (const control of shown.slice(at + 1)) {
      assert.ok(markup.indexOf(`aria-label="${control.label}"`) > negative, `${short}: ${control.id} after the negative prompt`);
    }
  }
});

test("a package without the anchor does not draw the prompt box among its controls", () => {
  const plain = { controls: [{ id: "steps", type: "number", label: "步数", default: 8 }] };
  const markup = render(plain, {}, { controlId: pkg.NEGATIVE_PROMPT_CONTROL_ID, content: probe });
  assert.equal(count(markup, PROBE), 0);
  assert.equal(markup, render(plain, {}, undefined));
});
