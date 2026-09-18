export const MAX_STYLE_LORAS = 6;
export interface H3StyleLora {
  name: string;
  strength: number;
  bypassed: boolean;
  applyToSecondary: boolean;
  applyToSecondPass: boolean;
}

export function usedStyleLoras(slots: H3StyleLora[], secondPass = false): H3StyleLora[] {
  return slots.filter((slot) => !slot.bypassed && Boolean(slot.name.trim())
    && (!secondPass || slot.applyToSecondPass)).map((slot) => ({ ...slot }));
}

export function recordedStyleLoras(value: unknown): H3StyleLora[] | null {
  return Array.isArray(value) ? h3StyleLorasFromContent({ styleLoras: value }) : null;
}

export function styleLoraUsageFromSnapshot(snapshot: Record<string, unknown>, secondary: boolean) {
  const hasLegacyRecord = snapshot.styleLorasRecorded !== false && (Array.isArray(snapshot.styleLoras)
    || typeof snapshot.styleLoraName === "string");
  const slots = h3StyleLorasFromContent(snapshot);
  return {
    primary: snapshot.primaryStyleLoras !== undefined
      ? recordedStyleLoras(snapshot.primaryStyleLoras)
      : !secondary && hasLegacyRecord ? usedStyleLoras(slots) : null,
    secondary: snapshot.secondaryStyleLoras !== undefined
      ? recordedStyleLoras(snapshot.secondaryStyleLoras)
      : secondary && hasLegacyRecord ? usedStyleLoras(slots, true) : null,
  };
}

export function h3StyleLorasFromContent(content: Record<string, unknown>): H3StyleLora[] {
  const saved = content.generationStyleLoras ?? content.styleLoras;
  const legacyName = content.generationStyleLoraName ?? content.styleLoraName;
  const rows = Array.isArray(saved) ? saved : typeof legacyName === "string" ? [{
    name: legacyName,
    strength: content.generationStyleLoraStrength ?? content.styleLoraStrength,
    bypassed: content.generationStyleLoraBypassed ?? content.styleLoraBypassed,
    applyToSecondary: content.generationStyleLoraApplyToSecondary ?? content.styleLoraApplyToSecondary,
  }] : [];
  return rows.map((value) => {
    const slot = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const name = typeof slot.name === "string" ? slot.name : "";
    return {
      name,
      strength: typeof slot.strength === "number" ? slot.strength : 1,
      bypassed: typeof slot.bypassed === "boolean" ? slot.bypassed : !name,
      applyToSecondary: slot.applyToSecondary === true,
      applyToSecondPass: typeof slot.applyToSecondPass === "boolean" ? slot.applyToSecondPass : slot.applyToSecondary === true,
    };
  });
}

export function styleLoraValidationError(slots: H3StyleLora[]): string | null {
  if (slots.length > MAX_STYLE_LORAS) return "最多支持6个风格 LoRA";
  for (const [index, slot] of slots.entries()) {
    if (!Number.isFinite(slot.strength) || slot.strength < 0 || slot.strength > 10) return `风格 LoRA ${index + 1} 权重必须在0到10之间`;
    if (!slot.bypassed && !slot.name.trim()) return `请选择风格 LoRA ${index + 1} 或开启 Bypass`;
  }
  return null;
}
