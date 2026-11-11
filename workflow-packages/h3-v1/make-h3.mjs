// CANVAS-039 package authoring (not program code): the five H3 packages declare their sampler
// nodes (adapter bindings samplerSelectNodeIds), so the settings page can choose a sampler per
// scheme. Still version 1 packages (H3 submits through the v1 path); same id, next revision.
//
// Input: the production package copies in src-tauri/testdata/workflow_v2/v1/<id> (CANVAS-039
// checked them against production: workflow.json byte for byte, the other files as JSON).
// Output: workflow-packages/h3-v1/<id>/{manifest.json, adapter.json, ui-schema.json, workflow.json};
// the importable bundles/<id>.zip are written by the Rust test write_h3_release_bundles.
//
// Usage: node make-h3.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "..", "..", "src-tauri", "testdata", "workflow_v2", "v1");

// Numbers keep their original text (1.0 stays 1.0), as in image-v2/make-v2.mjs.
const RAW = Symbol("raw number");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"), (key, value, context) => (
  typeof value === "number" && /[.eE]/.test(context.source) ? { [RAW]: context.source, valueOf: () => value } : value
));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, (key, item) => (
  item && typeof item === "object" && RAW in item ? JSON.rawJSON(item[RAW]) : item
), 2) + "\n");

// Every sampler-select node of the workflow (both passes use the one sampler): the
// single-image schemes have 123 (their second pass 9387 reads it too); Fla has 123 (first pass)
// and 389 (second pass). The script checks this against the workflow below.
const PACKAGES = {
  "0dca5130": { nodes: ["123"], revision: "V3.1-HighMotion" },
  "24f40f6d": { nodes: ["123", "389"], revision: "V3.1-HighMotion" },
  "3e0ce25b": { nodes: ["123"], revision: "V3.1-HighMotion" },
  "eb7a5470": { nodes: ["123", "389"], revision: "V3.1-TRT" },
  "ec9f2156": { nodes: ["123"], revision: "V3.1-HighMotion" },
};

for (const [short, { nodes, revision }] of Object.entries(PACKAGES)) {
  const source = path.join(SOURCE, short);
  const workflowBytes = fs.readFileSync(path.join(source, "workflow.json"));
  const workflow = JSON.parse(workflowBytes.toString("utf8"));
  const selects = Object.entries(workflow).filter(([, node]) => node.class_type === "KSamplerSelect").map(([id]) => id).sort();
  if (JSON.stringify(selects) !== JSON.stringify(nodes)) throw new Error(`${short}: sampler nodes ${selects} != ${nodes}`);
  for (const id of nodes) {
    if (typeof workflow[id].inputs.sampler_name !== "string") throw new Error(`${short}: ${id} has no sampler_name`);
  }
  const manifest = read(path.join(source, "manifest.json"));
  const adapter = read(path.join(source, "adapter.json"));
  if (adapter.bindings.samplerSelectNodeIds) throw new Error(`${short}: already declares sampler nodes`);
  if (manifest.defaults?.samplerName !== undefined) throw new Error(`${short}: the package must not set a sampler`);
  adapter.bindings.samplerSelectNodeIds = nodes;
  manifest.revision = revision;
  const out = path.join(HERE, short);
  fs.mkdirSync(out, { recursive: true });
  write(path.join(out, "manifest.json"), manifest);
  write(path.join(out, "adapter.json"), adapter);
  fs.copyFileSync(path.join(source, "ui-schema.json"), path.join(out, "ui-schema.json"));
  fs.writeFileSync(path.join(out, "workflow.json"), workflowBytes);
  console.log(`${short}: ${manifest.id} ${manifest.name} ${revision} sampler nodes ${nodes.join(",")} -> ${out}`);
}
