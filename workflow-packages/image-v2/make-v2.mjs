// CANVAS-024d package authoring (not program code): the three image packages as version 2.
//
// Input, per module: a read-only copy of the production package (manifest.json, workflow.json)
// and the v1 converter's output for it (src-tauri/testdata/workflow_v2/v2/<id>/adapter.json,
// kept current by the test checked_in_v2_packages_are_exactly_the_converter_output).
// Output: workflow-packages/image-v2/<id>/{manifest.json, adapter.json, workflow.json}.
//
// Usage: node make-v2.mjs <directory holding the production copies, one folder per module id>
// What changes against the converter's output is written out below, package by package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONVERTED = path.join(HERE, "..", "..", "src-tauri", "testdata", "workflow_v2", "v2");
const copies = process.argv[2];
if (!copies) throw new Error("usage: node make-v2.mjs <production copies directory>");

// Numbers keep their original text (1.0 stays 1.0: ComfyUI and the goldens see the difference).
const RAW = Symbol("raw number");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"), (key, value, context) => (
  typeof value === "number" && /[.eE]/.test(context.source) ? { [RAW]: context.source, valueOf: () => value } : value
));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, (key, item) => (
  item && typeof item === "object" && RAW in item ? JSON.rawJSON(item[RAW]) : item
), 2) + "\n");
// su 11-01: "Kera2" is a typo of Krea2; every model path in the package uses Krea2.
const renamed = (value) => (typeof value === "string" && /^Kera2[\\/]/.test(value) ? `Krea2${value.slice(5)}` : value);
const renameDeep = (value) => {
  if (Array.isArray(value)) return value.map(renameDeep);
  if (value && typeof value === "object" && !(RAW in value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameDeep(v)]));
  return renamed(value);
};
const control = (operation, id) => operation.controls.find((c) => c.id === id);

// Each package's revision goes up when its release changes (v1 = the production package before 024d).
const REVISIONS = { "0bf9145b": "v3", "52cba27b": "v2", "5dd20ec7": "v3" };

// The LoRA group every image package offers (Moss first, Krea2 since CANVAS-029): up to six
// items of file / weight 0–2 / on, files from the package's own LoRA directory. It goes right
// after the model control.
const addLoraGroup = (operation, dir) => {
  const modelIndex = operation.controls.findIndex((c) => c.id === "modelName");
  if (modelIndex < 0) throw new Error("no modelName control");
  operation.controls.splice(modelIndex + 1, 0, {
    id: "loras", type: "repeat", label: "LoRA", max: 6,
    fields: [
      { id: "name", type: "select", label: "LoRA", default: "", allowEmpty: true, emptyLabel: "不使用",
        options: { comfyui: { classType: "LoraLoaderModelOnly", input: "lora_name", dirs: [dir] } } },
      { id: "weight", type: "slider", label: "权重", default: 1.0, min: 0.0, max: 2.0, step: 0.05, number: "float" },
      { id: "on", type: "toggle", label: "启用", default: true },
    ],
  });
};

const packages = {
  // Krea2 text-to-image: the default model is named on the control (so the import check can
  // see it), the workflow's own loader and the module setting use Krea2. LoRA node 159 is
  // written by explicit steps (no binding defaults left to the program).
  // CANVAS-029 (v3): the single LoRA control becomes the LoRA group. Node 159 (Power Lora
  // Loader) takes any number of lora_<n> inputs: item n is written to lora_<n> as
  // {lora, on, strength}; an item without a file is not written. No item leaves the workflow's
  // own lora_1 (switched off) as before; one item at weight 1 writes what the old control wrote.
  // Old nodes' single LoRA becomes item 1 (src/workflow/legacyImageNode.ts, by field).
  "0bf9145b": ({ adapter, workflow, manifest }) => {
    for (const name of ["generate", "upscaleImage"]) {
      control(adapter.operations[name], "modelName").default = renamed(workflow["98"].inputs.unet_name);
    }
    const generate = adapter.operations.generate;
    const single = generate.controls.findIndex((c) => c.id === "loraName");
    const write = generate.steps.findIndex((step) => step.op === "set" && step.node === "159" && step.input === "lora_1");
    if (single < 0 || write < 0) throw new Error("Krea2: no single LoRA control / step");
    if (workflow["159"].class_type !== "Power Lora Loader (rgthree)") throw new Error("Krea2: node 159 is not a Power Lora Loader");
    generate.controls.splice(single, 1);
    addLoraGroup(generate, "Krea2");
    generate.steps.splice(write, 1, {
      op: "fill", repeat: "loras", node: "159", inputPattern: "lora_{n}",
      itemWhen: { not: { empty: { trim: { item: "name" } } } },
      value: { object: { lora: { trim: { item: "name" } }, on: { item: "on" }, strength: { float: { item: "weight" } } } },
    });
    return { adapter, workflow: renameDeep(workflow), manifest: renameDeep(manifest) };
  },
  // Krea2 image edit: same rename of its default model and loaders.
  "52cba27b": ({ adapter, workflow, manifest }) => {
    const model = control(adapter.operations.generate, "modelName");
    model.default = renamed(model.default);
    return { adapter, workflow: renameDeep(workflow), manifest: renameDeep(manifest) };
  },
  // Moss: six model-only LoRA slots placed after the model loader (28 -> 38). A slot whose
  // item is switched off or has no file is skipped; unused slots are dropped by keepReachable.
  // CANVAS-026 (v3): the negative prompt defaults to the workflow's own text in node 36.
  "5dd20ec7": ({ adapter, workflow, manifest }) => {
    const negative = workflow["36"].inputs.text;
    if (typeof negative !== "string" || !negative.trim()) throw new Error("Moss: node 36 has no text");
    control(adapter.operations.generate, "negativePrompt").default = negative;
    const slots = ["9701", "9702", "9703", "9704", "9705", "9706"];
    if (JSON.stringify(workflow["38"].inputs.model) !== JSON.stringify(["28", 0])) throw new Error("Moss: 38.model is not 28");
    slots.forEach((id, index) => {
      if (workflow[id]) throw new Error(`Moss: node ${id} exists`);
      workflow[id] = {
        inputs: { model: index ? [slots[index - 1], 0] : ["28", 0], lora_name: "", strength_model: 1.0 },
        class_type: "LoraLoaderModelOnly",
        _meta: { title: `LoRA 槽 ${index + 1}` },
      };
    });
    const generate = adapter.operations.generate;
    addLoraGroup(generate, "moss");
    const keep = generate.steps.findIndex((step) => step.op === "keepReachable");
    generate.steps.splice(keep, 0, {
      op: "chain", id: "lora", repeat: "loras", slots, linkInput: "model",
      itemWhen: { all: [{ truthy: { item: "on" } }, { not: { empty: { trim: { item: "name" } } } }] },
      fields: { lora_name: { path: { item: "name" } }, strength_model: { float: { item: "weight" } } },
      from: { link: ["28", 0] },
      to: [{ node: "38", input: "model" }],
    });
    adapter.nodeTypes = { ...(adapter.nodeTypes ?? {}), ...Object.fromEntries(slots.map((id) => [id, "LoraLoaderModelOnly"])) };
    return { adapter, workflow, manifest };
  },
};

for (const [short, edit] of Object.entries(packages)) {
  const source = fs.readdirSync(copies).find((name) => name.slice(16, 24) === short);
  if (!source) throw new Error(`no production copy for ${short}`);
  const manifest = read(path.join(copies, source, "manifest.json"));
  const workflow = read(path.join(copies, source, "workflow.json"));
  const adapter = read(path.join(CONVERTED, short, "adapter.json"));
  const result = edit({ adapter, workflow, manifest });
  // Version 2 of the same module: same id and name, new revision and package kind.
  Object.assign(result.manifest, { revision: REVISIONS[short], adapterKind: "workflow-package-v2", engineApiVersion: "2" });
  const out = path.join(HERE, short);
  fs.mkdirSync(out, { recursive: true });
  write(path.join(out, "manifest.json"), result.manifest);
  write(path.join(out, "adapter.json"), result.adapter);
  write(path.join(out, "workflow.json"), result.workflow);
  console.log(`${short}: ${result.manifest.id} ${result.manifest.name} -> ${out}`);
}
