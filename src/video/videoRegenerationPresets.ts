import type { VideoRegenerationDraft, VideoRegenerationNumericField } from "../CanvasNode";

export type VideoRegenerationSettings = Pick<VideoRegenerationDraft,
  Exclude<VideoRegenerationNumericField, `secondary${string}`> | "styleLoras" | "refImageSize">
  & Partial<Pick<VideoRegenerationDraft, Extract<VideoRegenerationNumericField, `secondary${string}`>
    | "loraName" | "loraBypassed" | "diffusionModelName" | "secondaryLoraName" | "secondaryLoraBypassed">>;
export interface VideoRegenerationPreset {
  id: string;
  name: string;
  settings: VideoRegenerationSettings;
}
export interface VideoRegenerationPresetCollection {
  presets: VideoRegenerationPreset[];
  defaultPresetId: string;
}

export function videoPresetNodePatch(settings: VideoRegenerationSettings, sharedSteps: boolean) {
  return {
    generationDuration: settings.durationSeconds,
    generationPrimaryResolution: settings.primaryResolutionMegapixels,
    generationPrimaryUpscaleFactor: settings.primaryUpscaleFactor,
    generationLoraStrength: settings.loraStrength,
    ...(settings.loraName !== undefined ? { generationLoraName: settings.loraName } : {}),
    ...(settings.loraBypassed !== undefined ? { generationLoraBypassed: settings.loraBypassed } : {}),
    generationPrimaryVideoSteps: settings.primaryVideoSteps,
    generationPrimaryAudioSteps: sharedSteps ? settings.primaryVideoSteps : settings.primaryAudioSteps,
    generationPrimaryBrightness: settings.primaryBrightness,
    generationPrimaryContrast: settings.primaryContrast,
    generationPrimarySaturation: settings.primarySaturation,
    generationRefImageSize: settings.refImageSize,
    generationStyleLoras: settings.styleLoras.map((slot) => ({ ...slot })),
    ...(settings.diffusionModelName ? { generationDiffusionModelOverride: settings.diffusionModelName } : {}),
    ...(settings.secondaryResolutionMegapixels !== undefined ? { generationSecondaryResolution: settings.secondaryResolutionMegapixels } : {}),
    ...(settings.secondarySchedulerSteps !== undefined ? { generationSecondarySchedulerSteps: settings.secondarySchedulerSteps } : {}),
    ...(settings.secondaryLoraName !== undefined ? { generationSecondaryLoraName: settings.secondaryLoraName } : {}),
    ...(settings.secondaryLoraStrength !== undefined ? { generationSecondaryLoraStrength: settings.secondaryLoraStrength } : {}),
    ...(settings.secondaryLoraBypassed !== undefined ? { generationSecondaryLoraBypassed: settings.secondaryLoraBypassed } : {}),
    ...(settings.secondaryBrightness !== undefined ? { generationSecondaryBrightness: settings.secondaryBrightness } : {}),
    ...(settings.secondaryContrast !== undefined ? { generationSecondaryContrast: settings.secondaryContrast } : {}),
    ...(settings.secondarySaturation !== undefined ? { generationSecondarySaturation: settings.secondarySaturation } : {}),
  };
}

export function videoNodeExtraParameters(
  content: Record<string, unknown>,
  defaults: Pick<VideoRegenerationSettings, "primaryAudioSteps" | "primaryBrightness" | "primaryContrast" | "primarySaturation">,
  primaryVideoSteps: number,
  sharedSteps: boolean,
) {
  const audio = content.generationPrimaryAudioSteps;
  const color = (key: string, fallback: number) => {
    const value = content[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3 ? value : fallback;
  };
  return {
    primaryAudioSteps: sharedSteps ? primaryVideoSteps : Math.max(primaryVideoSteps,
      typeof audio === "number" && Number.isInteger(audio) && audio >= 1 && audio <= 1000
        ? audio : defaults.primaryAudioSteps),
    primaryBrightness: color("generationPrimaryBrightness", defaults.primaryBrightness),
    primaryContrast: color("generationPrimaryContrast", defaults.primaryContrast),
    primarySaturation: color("generationPrimarySaturation", defaults.primarySaturation),
  };
}

export function videoNodeSecondaryColors(
  content: Record<string, unknown>,
  defaults: { secondaryBrightness: number; secondaryContrast: number; secondarySaturation: number },
) {
  const color = (key: string, fallback: number) => {
    const value = content[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3 ? value : fallback;
  };
  return {
    secondaryBrightness: color("generationSecondaryBrightness", defaults.secondaryBrightness),
    secondaryContrast: color("generationSecondaryContrast", defaults.secondaryContrast),
    secondarySaturation: color("generationSecondarySaturation", defaults.secondarySaturation),
  };
}

export function matchingVideoRegenerationPreset(
  collection: VideoRegenerationPresetCollection,
  settings: VideoRegenerationSettings | null,
): VideoRegenerationPreset | undefined {
  if (!settings) return undefined;
  const matches = collection.presets.filter((preset) => {
    const { styleLoras, ...parameters } = settings;
    if (!Object.entries(parameters).every(([key, value]) => {
      const saved = preset.settings[key as keyof typeof parameters];
      if ((key.startsWith("secondary") || key === "loraName" || key === "loraBypassed") && saved === undefined) return true;
      return typeof value === "number" && typeof saved === "number"
        ? Math.abs(value - saved) < 1e-9
        : value === saved;
    })) return false;
    return styleLoras.length === preset.settings.styleLoras.length
      && styleLoras.every((slot, index) => {
        const saved = preset.settings.styleLoras[index];
        return slot.name === saved.name
          && Math.abs(slot.strength - saved.strength) < 1e-9
          && slot.bypassed === saved.bypassed
          && slot.applyToSecondary === saved.applyToSecondary
          && slot.applyToSecondPass === saved.applyToSecondPass;
      });
  });
  return matches.find((preset) => preset.id === collection.defaultPresetId) ?? matches[0];
}

const STORAGE_KEY = "infinite-canvas:video-regeneration-presets:v1";
const LEGACY_STORAGE_KEY = "infinite-canvas:video-regeneration-settings:v1";
type PresetStorage = Pick<Storage, "getItem" | "setItem">;

export function loadVideoRegenerationPresets(
  storage: PresetStorage,
  parseSettings: (value: unknown) => VideoRegenerationSettings | null,
): VideoRegenerationPresetCollection {
  const empty = { presets: [], defaultPresetId: "" };
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const value = JSON.parse(stored);
      if (!value || !Array.isArray(value.presets)) return empty;
      const presets: VideoRegenerationPreset[] = [];
      for (const entry of value.presets) {
        if (!entry || typeof entry.id !== "string" || !entry.id
          || typeof entry.name !== "string" || !entry.name.trim()
          || presets.some((preset) => preset.id === entry.id)) continue;
        const settings = parseSettings(entry.settings);
        if (settings) presets.push({ id: entry.id, name: entry.name.trim(), settings });
      }
      return {
        presets,
        defaultPresetId: presets.some((preset) => preset.id === value.defaultPresetId)
          ? value.defaultPresetId : "",
      };
    }
    const settings = parseSettings(JSON.parse(storage.getItem(LEGACY_STORAGE_KEY) ?? "null"));
    return settings
      ? { presets: [{ id: "legacy", name: "原有设置", settings }], defaultPresetId: "legacy" }
      : empty;
  } catch {
    return empty;
  }
}

export function saveVideoRegenerationPresets(
  storage: PresetStorage,
  collection: VideoRegenerationPresetCollection,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(collection));
}
