// Zero relative runtime imports: keep `import type` only so `tests/webColabChannel.test.mjs`
// can load this module standalone under Node.
import type {
  VideoRegenerationPreset,
  VideoRegenerationPresetCollection,
  VideoRegenerationSettings,
} from "../video/videoRegenerationPresets";
import type { ColabProfileId, ColabProfileOption } from "./types";

type PresetStorage = Pick<Storage, "getItem" | "setItem">;

export const COLAB_WORKFLOW_MODULE_ID = "colab:minimax-h3-fla-v3-ss";
export const COLAB_LIVE_PREVIEW_NODE_ID = "141";
export const COLAB_WORKFLOW_DEFAULT_LABEL = "Colab 专用 · Fla全能参考 V3.1 (1采 SS)";
export const COLAB_DEFAULT_SAMPLER = "euler";
export const COLAB_FALLBACK_SAMPLERS: readonly string[] = [
  "euler",
  "lcm",
  "euler_ancestral",
  "heun",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_3m_sde",
  "res_multistep",
  "uni_pc",
  "ddim",
];

export type ColabVideoPresetSettings = VideoRegenerationSettings & {
  colabSampler?: string;
};

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

export function normalizeVideoChannel(
  generationChannel: unknown,
  enabled: boolean,
  isWebMode: boolean,
): "local" | "colab" {
  return enabled && isWebMode && generationChannel === "colab" ? "colab" : "local";
}

export function isAllowedColabLoraName(name: string): boolean {
  const normalized = name.trim().replace(/\\/g, "/").toLowerCase();
  return Boolean(normalized) && COLAB_ALLOWED_LORAS.some((candidate) => candidate.toLowerCase() === normalized);
}

export function colabSamplerFromValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : COLAB_DEFAULT_SAMPLER;
}

export function colabSamplerFromContent(content: Record<string, unknown>): string {
  return colabSamplerFromValue(content.generationColabSampler);
}

export function colabSamplerSelectOptions(
  liveOptions: readonly string[] | undefined,
  current: string,
): Array<{ value: string; label: string }> {
  const source = liveOptions?.length ? liveOptions : COLAB_FALLBACK_SAMPLERS;
  const seen = new Set<string>();
  const ordered: string[] = [];
  const pushUnique = (item: string) => {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  pushUnique(COLAB_DEFAULT_SAMPLER);
  for (const item of source) pushUnique(item);
  pushUnique(current);
  return ordered.map((item) => ({
    value: item,
    label: item === COLAB_DEFAULT_SAMPLER ? `${item}（默认）` : item,
  }));
}

export function colabSubmitInputExtras(
  channel: "local" | "colab",
  snapshot: { colabSampler?: string },
): Record<string, unknown> {
  return channel === "colab"
    ? { colabSampler: colabSamplerFromValue(snapshot.colabSampler) }
    : {};
}

export function withColabSamplerSetting(
  settings: VideoRegenerationSettings | null,
  colabSampler?: unknown,
): ColabVideoPresetSettings | null {
  if (!settings) return null;
  return {
    ...settings,
    colabSampler: colabSamplerFromValue(
      colabSampler ?? (settings as ColabVideoPresetSettings).colabSampler,
    ),
  };
}

export function colabPresetStorageKey(profile: ColabProfileId): string {
  return `infinite-canvas:colab-video-presets:${profile}:v1`;
}

export function colabWorkflowDefaultSettings(profile: ColabProfileId): ColabVideoPresetSettings {
  return {
    primaryResolutionMegapixels: 0.8,
    primaryUpscaleFactor: 1.0,
    primaryVideoSteps: 5,
    primaryAudioSteps: 5,
    colabSampler: COLAB_DEFAULT_SAMPLER,
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

function stripTransientFields(settings: VideoRegenerationSettings): VideoRegenerationSettings {
  const { durationSeconds: _duration, seed: _seed, refImageSize: _refImageSize, ...parameters } = settings as
    VideoRegenerationSettings & { durationSeconds?: unknown; seed?: unknown; refImageSize?: unknown };
  return parameters;
}

function sanitizeColabPresetSettings(
  profile: ColabProfileId,
  settings: ColabVideoPresetSettings,
): ColabVideoPresetSettings {
  const lockedModel = COLAB_PROFILE_MODELS[profile];
  const primaryAllowed = Boolean(settings.loraName && isAllowedColabLoraName(settings.loraName));
  return {
    ...stripTransientFields(settings),
    diffusionModelName: lockedModel,
    primaryUpscaleFactor: 1.0,
    primaryAudioSteps: settings.primaryVideoSteps,
    colabSampler: colabSamplerFromValue(settings.colabSampler),
    loraName: primaryAllowed ? settings.loraName : COLAB_ALLOWED_LORAS[0],
    loraBypassed: primaryAllowed ? (settings.loraBypassed ?? false) : true,
    styleLoras: settings.styleLoras.map((slot) => (
      isAllowedColabLoraName(slot.name)
        ? { ...slot, applyToSecondary: false, applyToSecondPass: false }
        : {
          ...slot,
          name: COLAB_ALLOWED_LORAS[1],
          bypassed: true,
          applyToSecondary: false,
          applyToSecondPass: false,
        }
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
        const rawSampler = entry.settings && typeof entry.settings === "object"
          ? (entry.settings as Record<string, unknown>).colabSampler
          : undefined;
        presets.push({
          id: entry.id,
          name: entry.name.trim(),
          settings: sanitizeColabPresetSettings(profile, {
            ...settings,
            colabSampler: colabSamplerFromValue(rawSampler),
          }),
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
      settings: sanitizeColabPresetSettings(profile, preset.settings as ColabVideoPresetSettings),
    })),
  }));
}

function keyForColabProfile(profile: ColabProfileId): string {
  return colabPresetStorageKey(profile);
}

/** Node content patch for Colab presets without overwriting local workflow/model bindings. */
export function colabPresetNodePatch(settings: ColabVideoPresetSettings) {
  return {
    generationPrimaryResolution: settings.primaryResolutionMegapixels,
    generationLoraStrength: settings.loraStrength,
    ...(settings.loraName !== undefined ? { generationLoraName: settings.loraName } : {}),
    ...(settings.loraBypassed !== undefined ? { generationLoraBypassed: settings.loraBypassed } : {}),
    generationPrimaryVideoSteps: settings.primaryVideoSteps,
    generationPrimaryAudioSteps: settings.primaryVideoSteps,
    generationColabSampler: colabSamplerFromValue(settings.colabSampler),
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

export function resolveColabProfileForSnapshot(
  workflowModuleRevision: string | undefined,
  diffusionModelName: string | undefined,
  activeProfile?: ColabProfileId | null,
  fallbackDraft?: ColabProfileOption,
): ColabProfileId {
  if (activeProfile === "dasiwa" || activeProfile === "cobijada") return activeProfile;
  if (workflowModuleRevision === "dasiwa" || workflowModuleRevision === "cobijada") {
    return workflowModuleRevision;
  }
  const normalizedModel = (diffusionModelName ?? "").trim().replace(/\\/g, "/").toLowerCase();
  for (const [profile, model] of Object.entries(COLAB_PROFILE_MODELS) as Array<[ColabProfileId, string]>) {
    if (model.toLowerCase() === normalizedModel) return profile;
  }
  return fallbackDraft === "cobijada" ? "cobijada" : "dasiwa";
}

export function colabGeneratedVideoWorkflowLabel(
  workflowModuleId?: string,
  workflowModuleRevision?: string,
): string | null {
  if (workflowModuleId !== COLAB_WORKFLOW_MODULE_ID) return null;
  if (workflowModuleRevision === "dasiwa" || workflowModuleRevision === "cobijada") {
    return `Colab 专用 · ${COLAB_PROFILE_LABELS[workflowModuleRevision]} (Fla V3.1 1采 SS)`;
  }
  return COLAB_WORKFLOW_DEFAULT_LABEL;
}
