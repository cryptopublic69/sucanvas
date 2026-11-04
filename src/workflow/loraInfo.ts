// CANVAS-032: which LoRAs a generated image used, for the image info panel. Read from the control
// values stored on the image (generationControlValues) and the generating package's controls: a
// repeat group with a `name` field is a LoRA group; its toggle field switches an item, its number
// field is the weight. Missing fields take the field default, as the server does when it submits
// (workflow_v2/engine.rs resolve_controls). Generic: names no workflow, control or node.
import { isNamedRepeatGroup, type ControlDescription, type ControlValues, type OperationDescription } from "./workflowPackage";

export type GeneratedLora = { name: string; strength: number | null };

export type GeneratedLoraInfo =
  /** The LoRAs that took effect; empty means none (the panel says 无). */
  | { kind: "entries"; entries: GeneratedLora[] }
  /** An image from before the LoRA group: its single old LoRA name, shown as before. */
  | { kind: "legacy"; name: string }
  /** Not knowable from the record (the panel says 未记录). */
  | { kind: "unrecorded" };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fieldValue(field: ControlDescription, item: Record<string, unknown>): unknown {
  const own = item[field.id];
  return own === undefined || own === null ? field.default : own;
}

function groupEntries(group: ControlDescription, values: ControlValues): GeneratedLora[] {
  const stored = values[group.id];
  const items = Array.isArray(stored) ? stored : stored === undefined || stored === null ? group.default : [];
  const fields = group.fields ?? [];
  const nameField = fields.find((field) => field.id === "name");
  const switches = fields.filter((field) => field.type === "toggle");
  const weightField = fields.find((field) => field.type === "slider" || field.type === "number");
  if (!nameField || !Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!isObject(item)) return [];
    const name = fieldValue(nameField, item);
    if (typeof name !== "string" || !name.trim()) return [];
    if (switches.some((field) => fieldValue(field, item) !== true)) return [];
    const raw = weightField ? fieldValue(weightField, item) : undefined;
    const weight = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    return [{ name: name.trim(), strength: Number.isFinite(weight) ? weight : null }];
  });
}

export function generatedImageLoras(content: Record<string, unknown>, operation: OperationDescription | undefined): GeneratedLoraInfo {
  // The old field is shown exactly as before.
  const legacyName = typeof content.generationLoraName === "string" && content.generationLoraName.trim()
    ? content.generationLoraName
    : "";
  const values = isObject(content.generationControlValues) ? content.generationControlValues : null;
  if (values && operation) {
    const groups = (operation.controls ?? []).filter((control) => isNamedRepeatGroup(control));
    if (groups.length) return { kind: "entries", entries: groups.flatMap((group) => groupEntries(group, values)) };
  }
  if (legacyName) return { kind: "legacy", name: legacyName };
  if (values) return operation ? { kind: "entries", entries: [] } : { kind: "unrecorded" };
  // An upscale preview carries only the old field over from its source, not the source's LoRA group.
  if (typeof content.sourcePreviewId === "string" || typeof content.generationLoraName !== "string") return { kind: "unrecorded" };
  return { kind: "entries", entries: [] };
}
