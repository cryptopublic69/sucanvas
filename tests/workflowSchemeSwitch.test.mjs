import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-028: switching a node to another package. A choice from ComfyUI files (`options.comfyui`)
// survives only if it is valid for the new package (inside its directories); otherwise it is dropped
// and the new package's default shows. Repeat items are judged the same way, item by item. Other
// controls keep the existing rule.
const pkg = await loadWorkflowModule("workflowPackage");
const generate = async (short) => (await readJson(`workflow-packages/image-v2/${short}/adapter.json`)).operations.generate;
const control = (operation, id) => operation.controls.find((candidate) => candidate.id === id);
const [krea2, edit, moss] = await Promise.all(["0bf9145b", "52cba27b", "5dd20ec7"].map(generate));

test("Moss with its own model -> Krea2: the model is dropped and Krea2's default shows", () => {
  const values = { modelName: "Moss\\pornmasterMoss_v1.safetensors", negativePrompt: "bad hands", width: 1000 };
  const switched = pkg.switchedControlValues(values, moss, krea2);
  assert.deepEqual(switched, { negativePrompt: "bad hands", width: 1000 });
  assert.equal(pkg.controlValue(control(krea2, "modelName"), switched), control(krea2, "modelName").default);
});

test("Krea2 with its model and LoRA -> Moss: both dropped, Moss's default shows, the rest kept", () => {
  const values = { modelName: "Krea2\\Krea2_turbo.safetensors", loraName: "Krea2\\slider.safetensors", steps: 12, height: 640 };
  const switched = pkg.switchedControlValues(values, krea2, moss);
  assert.deepEqual(switched, { steps: 12, height: 640 });
  assert.equal(pkg.controlValue(control(moss, "modelName"), switched), control(moss, "modelName").default);
});

test("a model inside the new package's directories is kept (Krea2 text-to-image <-> Krea2 edit)", () => {
  for (const model of ["Krea2\\Krea2_turbo.safetensors", "Kera2\\pornmasterKrea2_v2TurboBF16.safetensors", "krea2/other.safetensors"]) {
    assert.deepEqual(pkg.switchedControlValues({ modelName: model }, krea2, edit), { modelName: model }, model);
    assert.deepEqual(pkg.switchedControlValues({ modelName: model }, edit, krea2), { modelName: model }, model);
  }
});

// Generic packages (no real pair shares a repeat group): the same group id, other directories.
const loras = (dirs) => ({ controls: [{ id: "loras", type: "repeat", max: 6, fields: [
  { id: "name", type: "select", default: "", allowEmpty: true, options: { comfyui: { classType: "LoraLoaderModelOnly", input: "lora_name", dirs } } },
  { id: "weight", type: "slider", default: 1, min: 0, max: 2 },
] }] });

test("repeat items whose choice is not valid for the new package are dropped, the others kept as they are", () => {
  const items = [{ name: "a\\x.safetensors", weight: 0.5 }, { name: "b\\y.safetensors", weight: 0.7 }, { name: "", weight: 0.2 }, { weight: 1 }];
  assert.deepEqual(pkg.switchedControlValues({ loras: items }, loras(["a"]), loras(["b"])), {
    loras: [{ name: "b\\y.safetensors", weight: 0.7 }, { name: "", weight: 0.2 }, { weight: 1 }],
  });
  // Nothing valid left: the group is not stored at all.
  assert.deepEqual(pkg.switchedControlValues({ loras: [{ name: "a\\x.safetensors" }] }, loras(["a"]), loras(["b"])), {});
  // Same directories: every item kept, byte for byte.
  assert.deepEqual(pkg.switchedControlValues({ loras: items }, loras(["a", "b"]), loras(["A", "B"])), { loras: items });
});

test("a ComfyUI choice that is not a file name, or from another list without directories, is dropped", () => {
  const list = (classType) => ({ controls: [{ id: "model", type: "select", options: { comfyui: { classType, input: "name", dirs: [] } } }] });
  assert.deepEqual(pkg.switchedControlValues({ model: "x.safetensors" }, list("A"), list("A")), { model: "x.safetensors" });
  assert.deepEqual(pkg.switchedControlValues({ model: "x.safetensors" }, list("A"), list("B")), {});
  assert.deepEqual(pkg.switchedControlValues({ model: 5 }, list("A"), list("A")), {});
});

test("controls that are not ComfyUI choices keep the existing rule", () => {
  // A value equal to the old default gives way to a different new default; anything else is kept.
  const values = { negativePrompt: "", steps: 25, width: 1000 };
  const switched = pkg.switchedControlValues(values, moss, krea2);
  assert.deepEqual(switched, { negativePrompt: "", width: 1000 });
});
