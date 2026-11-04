import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

// CANVAS-032: the image info panel lists the LoRAs a generated image really used. The LoRA group
// is found from the package's control description (a repeat group with a `name` field); only
// items that took effect are listed (named and switched on, missing fields taking the field
// defaults as the server does); none -> "无". Old images with only generationLoraName are unchanged.
const lorasOf = async () => (await loadWorkflowModule("loraInfo")).generatedImageLoras;
const generate = async (dir) => (await readJson(`workflow-packages/image-v2/${dir}/adapter.json`)).operations.generate;
const groupId = (operation) => operation.controls.find((control) => control.type === "repeat").id;

test("Moss-style package, 2 LoRAs (1 on, 1 off): only the one switched on is listed", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = await generate("5dd20ec7");
  const content = {
    generationLoraName: "",
    generationControlValues: {
      [groupId(operation)]: [
        { name: "moss\\kept_lora.safetensors", weight: 0.8, on: true },
        { name: "moss\\switched_off.safetensors", weight: 1.2, on: false },
      ],
    },
  };
  assert.deepEqual(generatedImageLoras(content, operation), {
    kind: "entries",
    entries: [{ name: "moss\\kept_lora.safetensors", strength: 0.8 }],
  });
});

test("the real production record shape (items with only a name) takes the field defaults", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = await generate("5dd20ec7");
  // node:fdf803fb-… in production, step 0 of the report.
  const content = {
    generationLoraName: "",
    generationControlValues: {
      height: 1280,
      loras: [{ name: "moss\\moss_pussy_lora_v2.0.safetensors" }],
      modelName: "Moss\\moss-image-sft-dit-int8-convrot.safetensors",
      width: 720,
    },
  };
  assert.deepEqual(generatedImageLoras(content, operation), {
    kind: "entries",
    entries: [{ name: "moss\\moss_pussy_lora_v2.0.safetensors", strength: 1 }],
  });
});

test("Krea2-style package, 6 LoRAs: all six listed in order with their weights", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = await generate("0bf9145b");
  const items = [1, 2, 3, 4, 5, 6].map((n) => ({ name: `Krea2\\lora_${n}.safetensors`, weight: n / 4, on: true }));
  delete items[2].weight;
  delete items[4].on;
  const result = generatedImageLoras({ generationLoraName: "", generationControlValues: { [groupId(operation)]: items } }, operation);
  assert.equal(result.kind, "entries");
  assert.deepEqual(result.entries.map((entry) => entry.name), items.map((item) => item.name));
  assert.deepEqual(result.entries.map((entry) => entry.strength), [0.25, 0.5, 1, 1, 1.25, 1.5]);
});

test("all switched off or unnamed: nothing listed and no count (the panel shows 无)", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = await generate("52cba27b");
  const content = {
    generationLoraName: "",
    generationControlValues: {
      [groupId(operation)]: [
        { name: "Krea2\\a.safetensors", on: false },
        { name: "   ", on: true },
        { name: "", weight: 1 },
        { name: "Krea2\\b.safetensors", weight: 0.5, on: false },
      ],
    },
  };
  assert.deepEqual(generatedImageLoras(content, operation), { kind: "entries", entries: [] });
  assert.deepEqual(generatedImageLoras({ generationLoraName: "", generationControlValues: { width: 720 } }, operation), { kind: "entries", entries: [] });
});

test("a package without a LoRA group: 无, and an old name still shows", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = await generate("5a9e19a3");
  assert.ok(!operation.controls.some((control) => control.type === "repeat"));
  assert.deepEqual(generatedImageLoras({ generationLoraName: "", generationControlValues: { resolution: 1024 } }, operation), { kind: "entries", entries: [] });
  assert.deepEqual(generatedImageLoras({ generationLoraName: "dir\\old.safetensors", generationControlValues: {} }, operation), { kind: "legacy", name: "dir\\old.safetensors" });
});

test("old image with only generationLoraName shows it as before", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = await generate("0bf9145b");
  assert.deepEqual(generatedImageLoras({ generationLoraName: "Krea2\\old_single.safetensors" }, operation), { kind: "legacy", name: "Krea2\\old_single.safetensors" });
  assert.deepEqual(generatedImageLoras({ generationLoraName: "Krea2\\old_single.safetensors" }, undefined), { kind: "legacy", name: "Krea2\\old_single.safetensors" });
  assert.deepEqual(generatedImageLoras({ generationLoraName: "" }, operation), { kind: "entries", entries: [] });
});

test("what cannot be known says 未记录, never 无", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = await generate("0bf9145b");
  // An upscale preview copies only the old field; its source's LoRA group is not on it.
  assert.deepEqual(generatedImageLoras({ generationLoraName: "", sourcePreviewId: "node:x" }, operation), { kind: "unrecorded" });
  // The package is gone: its controls cannot say which value is the LoRA group.
  assert.deepEqual(generatedImageLoras({ generationLoraName: "", generationControlValues: { loras: [{ name: "a" }] } }, undefined), { kind: "unrecorded" });
  // Nothing recorded at all.
  assert.deepEqual(generatedImageLoras({}, operation), { kind: "unrecorded" });
});

test("the group is found by its description, not its id; a weight that is not a number is not recorded", async () => {
  const generatedImageLoras = await lorasOf();
  const operation = {
    controls: [
      { id: "anyGroup", type: "repeat", fields: [
        { id: "name", type: "select", default: "" },
        { id: "power", type: "number", default: 0.7 },
        { id: "enabled", type: "toggle", default: false },
      ] },
      { id: "otherList", type: "repeat", fields: [{ id: "label", type: "text" }] },
    ],
  };
  const content = { generationControlValues: {
    anyGroup: [{ name: "x\\one.safetensors", enabled: true }, { name: "x\\two.safetensors" }, { name: "x\\three.safetensors", enabled: true, power: "?" }],
    otherList: [{ label: "not a lora" }],
  } };
  assert.deepEqual(generatedImageLoras(content, operation), {
    kind: "entries",
    entries: [{ name: "x\\one.safetensors", strength: 0.7 }, { name: "x\\three.safetensors", strength: null }],
  });
});
