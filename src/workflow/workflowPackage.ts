// CANVAS-024c: the generic workflow node's model. A node's look (ports, controls, groups,
// labels) comes from the package description the server returns (get_workflow_package); its
// request is built from the node's control values and what is connected to it. Generic: no
// workflow, adapter or node is named here (checked by the Rust gate test).
// Kept free of imports so tests can load it directly.

export const WORKFLOW_NODE_SHELL = "workflow";

export type PortType = "text" | "image" | "video" | "audio";

export type ComfyFilesOption = { classType: string; input: string; dirs: string[] };

export type ControlDescription = {
  id: string;
  type: "text" | "textarea" | "number" | "slider" | "select" | "toggle" | "seed" | "repeat";
  label?: string;
  default?: unknown;
  preset?: unknown;
  min?: number;
  max?: number;
  step?: number;
  number?: "int" | "float" | "intIfWhole";
  options?: { values?: Array<{ value: unknown; label?: string }>; comfyui?: ComfyFilesOption };
  allowEmpty?: boolean;
  emptyMeansDefault?: boolean;
  visibleWhen?: Condition;
  fields?: ControlDescription[];
  group?: string;
  unit?: string;
  help?: string;
  emptyLabel?: string;
  /** How much the arrows change a number (interface only; `step` is what is valid). */
  increment?: number;
  /** The module setting (manifest defaults key) that is this control's preset. */
  setting?: string;
};

export type PortDescription = { id: string; type: PortType; label?: string; min?: number; max?: number; order?: number };
export type GroupDescription = { id: string; label?: string; swap?: boolean };

export type OperationDescription = {
  label?: string;
  inputs?: PortDescription[];
  outputs?: PortDescription[];
  controls?: ControlDescription[];
  groups?: GroupDescription[];
  livePreviewNode?: string;
};

export type PackageDescription = {
  engineApiVersion: number;
  capability: string;
  variant: string;
  operations: Record<string, OperationDescription>;
  resultUpscale?: boolean;
  moduleId?: string;
  revision?: string;
};

export type ComfyOutputRef = { filename: string; subfolder: string; fileType: string; url: string };
export type WorkflowMediaItem = { text: string } | { path: string } | { output: ComfyOutputRef };
export type ConnectedInputs = Partial<Record<PortType, WorkflowMediaItem[]>>;
export type ControlValues = Record<string, unknown>;

export type OperationRequest = {
  operation: string;
  values: ControlValues;
  inputs: Record<string, WorkflowMediaItem[]>;
  seedMode: string;
  seed: string;
};

// A subset of the package condition language that only reads control values (enough for
// visibleWhen; the server evaluates the full language).
type Condition = Record<string, unknown>;
type Expression = Record<string, unknown>;

export function controlLabel(control: { id: string; label?: string }): string {
  return control.label || control.id;
}

export function portLabel(port: PortDescription): string {
  return port.label || port.id;
}

/** The value a control has on this node: its own, else the module setting, else the package default. */
export function controlValue(control: ControlDescription, values: ControlValues): unknown {
  const own = values[control.id];
  if (own !== undefined && own !== null) return own;
  return control.preset ?? control.default;
}

function expressionValue(expression: unknown, values: ControlValues, controls: ControlDescription[]): unknown {
  if (!expression || typeof expression !== "object") return undefined;
  const [key, inner] = Object.entries(expression as Expression)[0] ?? [];
  if (key === "control") {
    const control = controls.find((candidate) => candidate.id === inner);
    return control ? controlValue(control, values) : values[String(inner)];
  }
  if (key === "const") return inner;
  if (key === "trim") {
    const value = expressionValue(inner, values, controls);
    return typeof value === "string" ? value.trim() : value ?? "";
  }
  return undefined;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

export function conditionHolds(condition: Condition | undefined, values: ControlValues, controls: ControlDescription[]): boolean {
  if (!condition) return true;
  const [key, inner] = Object.entries(condition)[0] ?? [];
  switch (key) {
    case "truthy": return expressionValue(inner, values, controls) === true;
    case "empty": return isEmptyValue(expressionValue(inner, values, controls));
    case "eq": {
      const [expression, expected] = Array.isArray(inner) ? inner : [];
      return JSON.stringify(expressionValue(expression, values, controls)) === JSON.stringify(expected);
    }
    case "defined": return values[String(inner)] !== undefined && values[String(inner)] !== null;
    case "all": return Array.isArray(inner) && inner.every((item) => conditionHolds(item as Condition, values, controls));
    case "any": return Array.isArray(inner) && inner.some((item) => conditionHolds(item as Condition, values, controls));
    case "not": return !conditionHolds(inner as Condition, values, controls);
    default: return true;
  }
}

export function visibleControls(operation: OperationDescription, values: ControlValues): ControlDescription[] {
  const controls = operation.controls ?? [];
  return controls.filter((control) => conditionHolds(control.visibleWhen, values, controls));
}

/** The id the program gives the negative prompt: the old image node's field and the control the
 * v1 converter writes (legacyImageNode.ts, legacy_v1_convert.rs). Any package may declare it. */
export const NEGATIVE_PROMPT_CONTROL_ID = "negativePrompt";

/** The control the node's prompt box is drawn right above: a visible text control with the
 * program's negative prompt id. None means the prompt box stays above every control. */
export function promptAnchorControl(operation: OperationDescription, values: ControlValues): ControlDescription | undefined {
  return visibleControls(operation, values).find((control) => (
    control.id === NEGATIVE_PROMPT_CONTROL_ID && (control.type === "textarea" || control.type === "text")
  ));
}

/** The request for one run of `operationName`: the node's own values for declared controls
 * (unset ones are left to the server's preset/default) and, per input port, what is connected
 * to it. The first port of each type takes that type's connections; text is trimmed. */
export function buildOperationRequest(
  operationName: string,
  operation: OperationDescription,
  nodeValues: ControlValues,
  connected: ConnectedInputs,
  seed: { seedMode: string; seed: string },
): OperationRequest {
  const values: ControlValues = {};
  for (const control of operation.controls ?? []) {
    if (control.type === "seed") continue;
    const value = nodeValues[control.id];
    if (value !== undefined && value !== null) values[control.id] = value;
  }
  const inputs: Record<string, WorkflowMediaItem[]> = {};
  const taken = new Set<PortType>();
  for (const port of operation.inputs ?? []) {
    if (taken.has(port.type)) continue;
    taken.add(port.type);
    const items = connected[port.type] ?? [];
    const prepared = port.type === "text"
      ? items.map((item) => ({ text: "text" in item ? item.text.trim() : "" }))
      : items;
    if (prepared.length) inputs[port.id] = prepared;
  }
  return { operation: operationName, values, inputs, seedMode: seed.seedMode, seed: seed.seed };
}

function numberProblem(control: ControlDescription, value: unknown): string {
  const label = controlLabel(control);
  if (typeof value !== "number" || !Number.isFinite(value)) return `${label}必须是数字`;
  const min = control.min ?? -Infinity;
  const max = control.max ?? Infinity;
  if (value < min || value > max) {
    return `${label}必须在 ${control.min ?? "-"}–${control.max ?? "-"} 之间`;
  }
  if (control.number === "int" && !Number.isInteger(value)) return `${label}必须是整数`;
  if (control.step && control.step > 0) {
    const offset = (value - (control.min ?? 0)) / control.step;
    if (Math.abs(offset - Math.round(offset)) > 1e-6) {
      return `${label}必须在 ${control.min ?? "-"}–${control.max ?? "-"} 之间，步长为 ${control.step}`;
    }
  }
  return "";
}

/** The first thing the server would refuse, said in the node's words; "" if none. */
export function operationRequestError(operation: OperationDescription, request: OperationRequest): string {
  for (const port of operation.inputs ?? []) {
    const items = request.inputs[port.id] ?? [];
    const min = port.min ?? 0;
    const max = port.max ?? 1;
    const count = port.type === "text"
      ? items.filter((item) => "text" in item && item.text.trim()).length
      : items.length;
    if (port.type === "text" && count < min && items.length <= max) return `${portLabel(port)}不能为空`;
    if (count < min || items.length > max) {
      return `${portLabel(port)}需要 ${min}–${max} 个，当前 ${items.length} 个`;
    }
  }
  for (const control of operation.controls ?? []) {
    if (control.type === "seed") continue;
    const value = controlValue(control, request.values);
    if (control.type === "number" || control.type === "slider") {
      if (value === undefined || value === null) continue;
      const problem = numberProblem(control, value);
      if (problem) return problem;
    }
    if (control.type === "repeat") {
      const items = Array.isArray(value) ? value : [];
      if (control.max !== undefined && items.length > control.max) return `${controlLabel(control)}最多 ${control.max} 项`;
    }
  }
  return "";
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Values kept when the node switches package: only controls the new package declares, and a
 * value still equal to the old package's default gives way to the new default. */
export function switchedControlValues(
  values: ControlValues,
  previous: OperationDescription | undefined,
  next: OperationDescription,
): ControlValues {
  const kept: ControlValues = {};
  for (const control of next.controls ?? []) {
    if (!(control.id in values)) continue;
    const value = values[control.id];
    const before = previous && previous !== next
      ? previous.controls?.find((candidate) => candidate.id === control.id)
      : undefined;
    if (before && sameValue(value, before.default) && !sameValue(before.default, control.default)) continue;
    kept[control.id] = value;
  }
  return kept;
}

/** The image toolbar's upscale runs some package's `upscaleImage` operation; images whose
 * own package says `resultUpscale: false` do not offer it. */
export const UPSCALE_OPERATION = "upscaleImage";

export function resultUpscaleOffered(generatingModuleId: string, packages: Record<string, PackageDescription>): boolean {
  if (!Object.values(packages).some((description) => description.operations[UPSCALE_OPERATION])) return false;
  const own = generatingModuleId ? packages[generatingModuleId] : undefined;
  return own?.resultUpscale !== false;
}

/** Which module's `upscaleImage` runs for an image: its own package's, else the default
 * module's, else the first module offering it. */
export function upscaleModuleFor(
  generatingModuleId: string,
  defaultModuleId: string,
  moduleIds: string[],
  packages: Record<string, PackageDescription>,
): string {
  const offers = (moduleId: string) => Boolean(moduleId && packages[moduleId]?.operations[UPSCALE_OPERATION]);
  if (offers(generatingModuleId)) return generatingModuleId;
  if (offers(defaultModuleId)) return defaultModuleId;
  return moduleIds.find(offers) ?? "";
}

/** Input ports in the order the node shows them (the package's `order`, else declaration order). */
export function displayPorts(operation: OperationDescription): PortDescription[] {
  return (operation.inputs ?? [])
    .map((port, index) => ({ port, rank: port.order ?? index, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ port }) => port);
}

/** The control of a module's run operation that takes a given module setting (settings page). */
export function settingControl(description: PackageDescription | undefined, setting: string): ControlDescription | undefined {
  return description?.operations.generate?.controls?.find((control) => control.setting === setting);
}

/** Whether `value` names a file (`dir\file`) inside one of the control's ComfyUI directories. */
export function choiceInDirectories(control: ControlDescription | undefined, value: string): boolean {
  const dirs = control?.options?.comfyui?.dirs ?? [];
  const normalized = value.trim().replace(/\//g, "\\");
  const separator = normalized.indexOf("\\");
  if (separator <= 0 || !normalized.slice(separator + 1).trim()) return false;
  const directory = normalized.slice(0, separator).toLowerCase();
  return dirs.some((dir) => dir.toLowerCase() === directory);
}

/** File name of a `dir\file` choice, for display. */
export function choiceDisplayName(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}
