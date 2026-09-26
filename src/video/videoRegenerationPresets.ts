import type { VideoRegenerationDraft, VideoRegenerationNumericField } from "../CanvasNode";

export type VideoRegenerationSettings = Pick<VideoRegenerationDraft,
  VideoRegenerationNumericField | "styleLoras" | "refImageSize"> & Partial<Pick<VideoRegenerationDraft, "diffusionModelName">>;
export interface VideoRegenerationPreset {
  id: string;
  name: string;
  settings: VideoRegenerationSettings;
}
export interface VideoRegenerationPresetCollection {
  presets: VideoRegenerationPreset[];
  defaultPresetId: string;
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
