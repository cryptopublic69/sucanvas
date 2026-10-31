// CANVAS-025: the markup of every control outside the repeat group, for every described image
// package, in the states a node shows (list loading / list read). The snapshot next to this file was
// written from the code before CANVAS-025; the repeat-group layout must not change any of it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWorkflowModule, readJson } from "./workflowTestLoader.mjs";

export const SNAPSHOT = "tests/workflowControlsMarkup.snapshot.json";
const DESCRIBED = ["0bf9145b", "52cba27b", "5dd20ec7"];

export async function controlsMarkup() {
  const controls = await loadWorkflowModule("WorkflowControls");
  const states = {
    loading: () => ({ status: "loading" }),
    ready: (control) => ({ status: "ready", values: [`${control.options?.comfyui?.dirs?.[0] ?? "dir"}\\a.safetensors`, `${control.options?.comfyui?.dirs?.[0] ?? "dir"}\\b.safetensors`] }),
  };
  const out = {};
  for (const short of DESCRIBED) {
    const described = await readJson(`src-tauri/testdata/workflow_v2/described/${short}.json`);
    for (const [name, operation] of Object.entries(described.operations)) {
      for (const control of operation.controls ?? []) {
        if (control.type === "repeat" || control.type === "seed") continue;
        for (const [state, choices] of Object.entries(states)) {
          out[`${short}/${name}/${control.id}/${state}`] = renderToStaticMarkup(createElement(controls.WorkflowControlField, {
            control, value: undefined, choices: choices(control), onChange: () => {},
          }));
        }
      }
      if (!(operation.controls ?? []).some((control) => control.type === "repeat")) {
        out[`${short}/${name}/all`] = renderToStaticMarkup(createElement(controls.WorkflowControls, {
          operation, values: {}, choicesFor: states.loading, onChange: () => {},
        }));
      }
    }
  }
  return out;
}

// `node tests/workflowControlsMarkup.mjs --write` records the snapshot (done once, on 9123034).
if (process.argv.includes("--write")) {
  const { writeFile } = await import("node:fs/promises");
  const markup = await controlsMarkup();
  await writeFile(new URL(`../${SNAPSHOT}`, import.meta.url), `${JSON.stringify(markup, null, 1)}\n`);
  console.log(`wrote ${Object.keys(markup).length} entries to ${SNAPSHOT}`);
}
