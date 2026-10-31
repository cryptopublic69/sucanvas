// TRANSITIONAL — delete in stage five together with src-tauri/src/workflow_v2/legacy_v1_convert.rs
// (CANVAS-024 design §5). Old image generation nodes (any image module: text-to-image, image
// edit, …) are converted in place to the generic workflow node with their module id kept. The
// conversion goes field by field, never by module: the old fixed fields map onto the control
// ids the v1 converter gives every image package, and the single old LoRA becomes the first
// item of a LoRA group when the package has one. Old fields are left in place, so a rollback
// to the old program still finds them. Exempt from the generic-files gate (like the v1 converter).
//
// Version 2 (CANVAS-024d): model paths stored on a node in the "Kera2" directory (a typo of
// Krea2, su 11-01; the directory is renamed at go-live) are rewritten to "Krea2" once. A
// node already at this version is left alone, so a Kera2 file picked afterwards stays.
import { WORKFLOW_NODE_SHELL, type ControlValues, type OperationDescription } from "./workflowPackage";

type Content = Record<string, unknown>;

export const NODE_SHELL_VERSION = 2;

export function needsLegacyImageConversion(content: Content): boolean {
  return content.nodeShell !== WORKFLOW_NODE_SHELL || content.nodeShellVersion !== NODE_SHELL_VERSION;
}

/** A repeat group whose items have a `name` field: where a single old LoRA goes. */
function loraGroup(operation: OperationDescription | undefined): string {
  return operation?.controls?.find((control) => (
    control.type === "repeat" && control.id === "loras" && control.fields?.some((field) => field.id === "name")
  ))?.id ?? "";
}

/** Every stored value, inside repeat items too: `Kera2\…` / `Kera2/…` become `Krea2…`. */
function renameKera2(value: unknown): unknown {
  if (typeof value === "string") return /^Kera2[\\/]/.test(value) ? `Krea2${value.slice(5)}` : value;
  if (Array.isArray(value)) return value.map(renameKera2);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renameKera2(item)]));
  }
  return value;
}

function convertedValues(content: Content, operation: OperationDescription | undefined): ControlValues {
  const declared = (id: string) => !operation || Boolean(operation.controls?.some((control) => control.id === id));
  const values: ControlValues = {};
  const put = (id: string, value: unknown) => {
    if (declared(id)) values[id] = value;
  };
  if (typeof content.negativePrompt === "string") put("negativePrompt", content.negativePrompt);
  // The old submission used `Number(x) || default`: a missing or zero number meant the default.
  for (const key of ["width", "height", "steps", "upscaleMegapixels"]) {
    const number = Number(content[key]);
    if (content[key] !== undefined && Number.isFinite(number) && number) put(key, number);
  }
  if (typeof content.upscaleEnabled === "boolean") put("upscaleEnabled", content.upscaleEnabled);
  const lora = typeof content.imageLoraName === "string" ? content.imageLoraName : "";
  if (lora.trim()) {
    const group = loraGroup(operation);
    if (group) values[group] = [{ name: lora }];
    else put("loraName", lora);
  }
  return values;
}

export function convertLegacyImageNodeContent(content: Content, operation?: OperationDescription): Content {
  if (!needsLegacyImageConversion(content)) return content;
  const current = content.nodeShell === WORKFLOW_NODE_SHELL
    && content.controlValues && typeof content.controlValues === "object" && !Array.isArray(content.controlValues)
    ? content.controlValues as ControlValues
    : content.nodeShell === WORKFLOW_NODE_SHELL ? {} : convertedValues(content, operation);
  return {
    ...content,
    nodeShell: WORKFLOW_NODE_SHELL,
    nodeShellVersion: NODE_SHELL_VERSION,
    operation: typeof content.operation === "string" && content.nodeShell === WORKFLOW_NODE_SHELL ? content.operation : "generate",
    controlValues: renameKera2(current) as ControlValues,
  };
}
