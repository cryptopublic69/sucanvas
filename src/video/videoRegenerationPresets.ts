import type { VideoRegenerationDraft, VideoRegenerationNumericField } from "../CanvasNode";
import type { ColabProfileId } from "../web/connection";

export const COLAB_ALLOWED_LORAS: readonly string[] = [
  "MinimaxH3/pika_h3_flex_fl2va_comfy_bf16.safetensors",
  "MinimaxH3/MysticXXX_MMH3-V1.safetensors",
];

export const COLAB_PROFILE_MODELS: Record<ColabProfileId, string> = {
  dasiwa:
    "MinimaxH3/dasiwa_minimax_h3_ref2va_v5xs_pruned_graviton_int8_row-wise_convrot_runtime_mixed.safetensors",
  cobijada:
    "MinimaxH3/Cobijada_H3_Hybrid_Uncensored_pruned_hybrid_int8_convrot_pruned.safetensors",
};

export const COLAB_PROFILE_LABELS: Record<ColabProfileId, string> = {
  dasiwa: "DaSiWa V5xs",
  cobijada: "Cobijada",
};

export function isAllowedColabLoraName(name: string): boolean {
  const normalized = name.trim().replace(/\\/g, "/").toLowerCase();
  return Boolean(normalized) && COLAB_ALLOWED_LORAS.some((candidate) => candidate.toLowerCase() === normalized);
}

export function colabPresetStorageKey(profile: ColabProfileId): string {
  return `infinite-canvas:colab-video-presets:${profile}:v1`;
}

export function colabWorkflowDefaultSettings(profile: ColabProfileId): VideoRegenerationSettings {
  return {
    primaryResolutionMegapixels: 0.8,
    primaryUpscaleFactor: 1.0,
    primaryVideoSteps: 5,
    primaryAudioSteps: 5,
    loraName: COLAB_ALLOWED_LORAS[0],
    loraStrength: 0.6,
    loraBypassed: false,
    primaryBrightness: 1.0,
    primaryContrast: 0.8,
    primarySaturation: 1.0,
    styleLoras: [
      {
        name: COLAB_ALLOWED_LORAS[1],
        strength: 0.35,
        bypassed: false,
        applyToSecondary: false,
        applyToSecondPass: false,
      },
    ],
    diffusionModelName: COLAB_PROFILE_MODELS[profile],
  };
}

export function emptyColabVideoPresetsByProfile(
  storage: PresetStorage,
  parseSettings: (value: unknown) => VideoRegenerationSettings | null,
): Record<ColabProfileId, VideoRegenerationPresetCollection> {
  return {
    dasiwa: loadColabVideoPresets(storage, "dasiwa", parseSettings),
    cobijada: loadColabVideoPresets(storage, "cobijada", parseSettings),
  };
}

function sanitizeColabPresetSettings(
  profile: ColabProfileId,
  settings: VideoRegenerationSettings,
): VideoRegenerationSettings {
  const lockedModel = COLAB_PROFILE_MODELS[profile];
  const primaryAllowed = Boolean(settings.loraName && isAllowedColabLoraName(settings.loraName));
  return {
    ...presetOnlySettings(settings),
    diffusionModelName: lockedModel,
    primaryUpscaleFactor: 1.0,
    primaryAudioSteps: settings.primaryVideoSteps,
    loraName: primaryAllowed ? settings.loraName : COLAB_ALLOWED_LORAS[0],
    loraBypassed: primaryAllowed ? (settings.loraBypassed ?? false) : true,
    styleLoras: settings.styleLoras.map((slot) => (
      isAllowedColabLoraName(slot.name)
        ? { ...slot, applyToSecondary: false, applyToSecondPass: false }
        : { ...slot, name: COLAB_ALLOWED_LORAS[1], bypassed: true, applyToSecondary: false, applyToSecondPass: false }
    )),
  };
}

export function loadColabVideoPresets(
  storage: PresetStorage,
  profile: ColabProfileId,
  parseSettings: (value: unknown) => VideoRegenerationSettings | null,
): VideoRegenerationPresetCollection {
  const key = colabPresetStorageKey(profile);
  const seededDefaultId = `colab-default-${profile}`;
  const seeded: VideoRegenerationPresetCollection = {
    presets: [
      {
        id: seededDefaultId,
        name: `${COLAB_PROFILE_LABELS[profile]} 默认方案`,
        settings: colabWorkflowDefaultSettings(profile),
      },
    ],
    defaultPresetId: seededDefaultId,
  };
  try {
    const stored = storage.getItem(key);
    if (stored === null) return seeded;
    const value = JSON.parse(stored);
    if (!value || !Array.isArray(value.presets)) return seeded;
    const presets: VideoRegenerationPreset[] = [];
    for (const entry of value.presets) {
      if (!entry || typeof entry.id !== "string" || !entry.id
        || typeof entry.name !== "string" || !entry.name.trim()
        || presets.some((preset) => preset.id === entry.id)) continue;
      const settings = parseSettings(entry.settings);
      if (settings) {
        presets.push({
          id: entry.id,
          name: entry.name.trim(),
          settings: sanitizeColabPresetSettings(profile, settings),
        });
      }
    }
    return {
      presets,
      defaultPresetId: presets.some((preset) => preset.id === value.defaultPresetId)
        ? value.defaultPresetId : "",
    };
  } catch {
    return seeded;
  }
}

export function saveColabVideoPresets(
  storage: PresetStorage,
  profile: ColabProfileId,
  collection: VideoRegenerationPresetCollection,
): void {
  storage.setItem(keyForColabProfile(profile), JSON.stringify({
    ...collection,
    presets: collection.presets.map((preset) => ({
      ...preset,
      settings: sanitizeColabPresetSettings(profile, preset.settings),
    })),
  }));
}

function keyForColabProfile(profile: ColabProfileId): string {
  return colabPresetStorageKey(profile);
}

/** Node content patch for Colab presets without overwriting local workflow/model bindings. */
export function colabPresetNodePatch(settings: VideoRegenerationSettings) {
  return {
    generationPrimaryResolution: settings.primaryResolutionMegapixels,
    generationLoraStrength: settings.loraStrength,
    ...(settings.loraName !== undefined ? { generationLoraName: settings.loraName } : {}),
    ...(settings.loraBypassed !== undefined ? { generationLoraBypassed: settings.loraBypassed } : {}),
    generationPrimaryVideoSteps: settings.primaryVideoSteps,
    generationPrimaryAudioSteps: settings.primaryVideoSteps,
    generationPrimaryBrightness: settings.primaryBrightness,
    generationPrimaryContrast: settings.primaryContrast,
    generationPrimarySaturation: settings.primarySaturation,
    generationStyleLoras: settings.styleLoras.map((slot) => ({
      ...slot,
      applyToSecondary: false,
      applyToSecondPass: false,
    })),
  };
}

export type VideoRegenerationSettings = Pick<VideoRegenerationDraft,
  Exclude<VideoRegenerationNumericField, `secondary${string}` | "durationSeconds"> | "styleLoras">
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

function presetOnlySettings(settings: VideoRegenerationSettings): VideoRegenerationSettings {
  const { durationSeconds: _duration, seed: _seed, refImageSize: _refImageSize, ...parameters } = settings as
    VideoRegenerationSettings & { durationSeconds?: unknown; seed?: unknown; refImageSize?: unknown };
  return parameters;
}

export function orderedVideoRegenerationPresets(collection: VideoRegenerationPresetCollection) {
  return [
    ...collection.presets.filter((preset) => preset.id === collection.defaultPresetId),
    ...collection.presets.filter((preset) => preset.id !== collection.defaultPresetId),
  ];
}

export function reorderVideoRegenerationPresets(collection: VideoRegenerationPresetCollection, id: string, destination: number) {
  const displayed = orderedVideoRegenerationPresets(collection);
  const pinned = displayed[0]?.id === collection.defaultPresetId;
  if (id === collection.defaultPresetId || !Number.isInteger(destination)
    || destination < 0 || destination >= displayed.length) return collection.presets;
  const movable = displayed.filter((preset) => preset.id !== collection.defaultPresetId);
  const index = movable.findIndex((preset) => preset.id === id);
  if (index < 0) return collection.presets;
  const [moved] = movable.splice(index, 1);
  movable.splice(Math.max(0, destination - (pinned ? 1 : 0)), 0, moved);
  let next = 0;
  return collection.presets.map((preset) => preset.id === collection.defaultPresetId ? preset : movable[next++]);
}

export function videoPresetNodePatch(settings: VideoRegenerationSettings, sharedSteps: boolean) {
  return {
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
    const { styleLoras, ...parameters } = presetOnlySettings(settings);
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
        if (settings) presets.push({ id: entry.id, name: entry.name.trim(), settings: presetOnlySettings(settings) });
      }
      return {
        presets,
        defaultPresetId: presets.some((preset) => preset.id === value.defaultPresetId)
          ? value.defaultPresetId : "",
      };
    }
    const settings = parseSettings(JSON.parse(storage.getItem(LEGACY_STORAGE_KEY) ?? "null"));
    return settings
      ? { presets: [{ id: "legacy", name: "原有设置", settings: presetOnlySettings(settings) }], defaultPresetId: "legacy" }
      : empty;
  } catch {
    return empty;
  }
}

export function saveVideoRegenerationPresets(
  storage: PresetStorage,
  collection: VideoRegenerationPresetCollection,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({
    ...collection,
    presets: collection.presets.map((preset) => ({ ...preset, settings: presetOnlySettings(preset.settings) })),
  }));
}
