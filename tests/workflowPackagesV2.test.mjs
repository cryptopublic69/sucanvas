import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-024d: interface increment, port display order, the Kera2 -> Krea2 rename of values
// stored on old nodes, and the settings page's model choice read from the package.
const pkg = await loadWorkflowModule("workflowPackage");
const legacy = await loadWorkflowModule("legacyImageNode");
const controls = await loadWorkflowModule("WorkflowControls");
const described = (short) => readJson(`src-tauri/testdata/workflow_v2/described/${short}.json`);

test("width and height arrows move by 64 (the package's increment), not by a validation step", async () => {
  const generate = (await described("0bf9145b")).operations.generate;
  const width = generate.controls.find((c) => c.id === "width");
  assert.equal(width.increment, 64);
  assert.equal(width.step, undefined);
  const markup = renderToStaticMarkup(createElement(controls.WorkflowControls, {
    operation: generate, values: {}, choicesFor: () => ({ status: "loading" }), onChange: () => {},
  }));
  assert.match(markup, /<input[^>]*aria-label="宽度"[^>]*step="64"/);
  assert.match(markup, /<input[^>]*aria-label="高度"[^>]*step="64"/);
});

test("the image edit node lists its images before the prompt, as the package orders them", async () => {
  const edit = (await described("52cba27b")).operations.generate;
  assert.deepEqual(pkg.displayPorts(edit).map((port) => port.id), ["images", "prompt"]);
  const krea2 = (await described("0bf9145b")).operations.generate;
  assert.deepEqual(pkg.displayPorts(krea2).map((port) => port.id), ["prompt"]);
});

test("a Kera2 model stored on an old node becomes Krea2 once, field by field", async () => {
  const generate = (await described("0bf9145b")).operations.generate;
  // Converted by 024c (no version yet) with a model picked on the node.
  const converted024c = { nodeShell: pkg.WORKFLOW_NODE_SHELL, operation: "generate", workflowModuleId: "m",
    controlValues: { modelName: "Kera2\\pornmasterKrea2_v2TurboBF16.safetensors", width: 900, loraName: "Krea2\\l.safetensors" } };
  assert.equal(legacy.needsLegacyImageConversion(converted024c), true);
  const migrated = legacy.convertLegacyImageNodeContent(converted024c, generate);
  assert.deepEqual(migrated.controlValues, { modelName: "Krea2\\pornmasterKrea2_v2TurboBF16.safetensors", width: 900, loraName: "Krea2\\l.safetensors" });
  assert.equal(migrated.nodeShellVersion, legacy.NODE_SHELL_VERSION);
  assert.equal(legacy.needsLegacyImageConversion(migrated), false);
  // A Kera2 file picked after the migration (the directory is renamed only at go-live) stays.
  const picked = { ...migrated, controlValues: { ...migrated.controlValues, modelName: "Kera2\\x.safetensors" } };
  assert.equal(legacy.convertLegacyImageNodeContent(picked, generate), picked);
  // Old-format nodes are converted and renamed in the same pass; slash spelling too.
  const old = legacy.convertLegacyImageNodeContent({ workflowModuleId: "m", width: 1280, controlValues: undefined }, generate);
  assert.equal(old.nodeShellVersion, legacy.NODE_SHELL_VERSION);
  const slash = legacy.convertLegacyImageNodeContent({ ...converted024c, controlValues: { modelName: "Kera2/y.safetensors" } }, generate);
  assert.equal(slash.controlValues.modelName, "Krea2/y.safetensors");
  // Inside a repeat group too.
  const group = legacy.convertLegacyImageNodeContent({ ...converted024c, controlValues: { loras: [{ name: "Kera2\\a.safetensors", weight: 1 }] } }, undefined);
  assert.deepEqual(group.controlValues.loras, [{ name: "Krea2\\a.safetensors", weight: 1 }]);
});

test("the settings page finds the module's model control by its setting and checks its directories", async () => {
  for (const [short, good, bad] of [
    ["0bf9145b", "Kera2\\a.safetensors", "Moss\\a.safetensors"],
    ["5dd20ec7", "Moss\\a.safetensors", "Krea2\\a.safetensors"],
  ]) {
    const description = await described(short);
    const control = pkg.settingControl(description, "diffusionModelName");
    assert.equal(control?.id, "modelName", short);
    assert.equal(pkg.choiceInDirectories(control, good), true, `${short} ${good}`);
    assert.equal(pkg.choiceInDirectories(control, bad), false, `${short} ${bad}`);
    assert.equal(pkg.choiceInDirectories(control, "Moss\\"), false, "a directory alone is not a file");
  }
});
