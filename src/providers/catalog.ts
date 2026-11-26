import type {
  ExternalVideoModelSpec,
  ExternalVideoProviderId,
  ProviderStatusSnapshot,
  VideoExecutionChannel,
} from "./types";

export const EXTERNAL_VIDEO_PROVIDER_IDS: readonly ExternalVideoProviderId[] = [
  "jimeng-cn",
  "dreamina-jp",
  "libtv",
  "lovart",
] as const;

export const EXTERNAL_PROVIDER_LABELS: Record<ExternalVideoProviderId, string> = {
  "jimeng-cn": "即梦（国区）",
  "dreamina-jp": "即梦（日区）",
  libtv: "LibTV",
  lovart: "Lovart",
};

const DEFAULT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const DREAMINA_MODES = ["auto", "t2v", "first_last_frame", "m2v"];
const LIBTV_MODES = [
  "auto",
  "text2video",
  "singleImage2video",
  "frames2video",
  "image2video",
  "mixed2video",
];
const LOVART_MODES = ["auto"];

function makeSpec(
  id: string,
  label: string,
  series: "2.5" | "2.0",
  resolutions: string[],
  defaultResolution: string,
  minDuration: number,
  maxDuration: number,
  modes: string[],
  supportsAudioToggle: boolean,
  maxImages: number,
  maxVideos: number,
  maxAudios: number,
  maxPromptLength: number | null = null,
): ExternalVideoModelSpec {
  return {
    id,
    label,
    series,
    resolutions,
    defaultResolution,
    minDuration,
    maxDuration,
    defaultDuration: 5,
    aspectRatios: DEFAULT_RATIOS,
    modes,
    supportsAudioToggle,
    maxImages,
    maxVideos,
    maxAudios,
    maxPromptLength,
  };
}

export const FALLBACK_MODELS_BY_PROVIDER: Record<
  ExternalVideoProviderId,
  ExternalVideoModelSpec[]
> = {
  "jimeng-cn": [
    makeSpec("seedance_2.5", "Seedance 2.5", "2.5", ["480p", "720p", "1080p", "4k"], "720p", 4, 30, DREAMINA_MODES, false, 30, 10, 10, 15_000),
    makeSpec("seedance_2.5_flash", "Seedance 2.5 Flash", "2.5", ["480p", "720p"], "720p", 4, 30, DREAMINA_MODES, false, 10, 5, 5, 15_000),
    makeSpec("seedance_2.5_draft", "Seedance 2.5 Draft（样片）", "2.5", ["480p"], "480p", 4, 30, DREAMINA_MODES, false, 30, 10, 10, 15_000),
    makeSpec("seedance_2.0_vip", "Seedance 2.0 VIP", "2.0", ["720p", "1080p", "4K"], "720p", 4, 15, DREAMINA_MODES, false, 9, 3, 3, 4_000),
    makeSpec("seedance_2.0_fast_vip", "Seedance 2.0 Fast VIP", "2.0", ["720p"], "720p", 4, 15, DREAMINA_MODES, false, 9, 3, 3, 4_000),
    makeSpec("seedance_2.0_mini", "Seedance 2.0 Mini", "2.0", ["720p"], "720p", 4, 15, DREAMINA_MODES, false, 9, 3, 3, 4_000),
  ],
  "dreamina-jp": [
    makeSpec("seedance_2.5", "Seedance 2.5", "2.5", ["480p", "720p", "1080p", "4k"], "720p", 4, 30, DREAMINA_MODES, false, 30, 10, 10, 15_000),
    makeSpec("seedance_2.5_flash", "Seedance 2.5 Flash", "2.5", ["480p", "720p"], "720p", 4, 30, DREAMINA_MODES, false, 10, 5, 5, 15_000),
    makeSpec("seedance_2.5_draft", "Seedance 2.5 Draft", "2.5", ["480p"], "480p", 4, 30, DREAMINA_MODES, false, 30, 10, 10, 15_000),
    makeSpec("seedance_2.0", "Seedance 2.0", "2.0", ["720p", "1080p", "4K"], "720p", 4, 15, DREAMINA_MODES, false, 9, 3, 3, 4_000),
    makeSpec("seedance_2.0_fast", "Seedance 2.0 Fast", "2.0", ["720p"], "720p", 4, 15, DREAMINA_MODES, false, 9, 3, 3, 4_000),
    makeSpec("seedance_2.0_mini", "Seedance 2.0 Mini", "2.0", ["720p"], "720p", 4, 15, DREAMINA_MODES, false, 9, 3, 3, 4_000),
  ],
  libtv: [
    makeSpec("Seedance 2.5", "Seedance 2.5", "2.5", ["480p", "720p", "1080p", "4k"], "720p", 4, 30, LIBTV_MODES, true, 30, 10, 10),
    makeSpec("Seedance 2.5 Flash", "Seedance 2.5 Flash", "2.5", ["480p", "720p"], "720p", 4, 30, LIBTV_MODES, true, 10, 5, 5),
    makeSpec("Seedance 2.5（样片模式）", "Seedance 2.5（样片模式）", "2.5", ["480p"], "480p", 4, 30, LIBTV_MODES, true, 30, 10, 10),
    makeSpec("Seedance 2.0 VIP", "Seedance 2.0 VIP", "2.0", ["480p", "720p"], "720p", 4, 15, LIBTV_MODES, true, 9, 3, 3),
    makeSpec("Seedance 2.0 Fast VIP", "Seedance 2.0 Fast VIP", "2.0", ["480p", "720p"], "720p", 4, 15, LIBTV_MODES, true, 9, 3, 3),
    makeSpec("Seedance 2.0 Mini", "Seedance 2.0 Mini", "2.0", ["480p", "720p"], "720p", 4, 15, LIBTV_MODES, true, 9, 3, 3),
  ],
  lovart: [
    makeSpec("generate_video_seedance_v2_5", "Seedance 2.5", "2.5", ["auto", "480p", "720p", "1080p"], "auto", 4, 15, LOVART_MODES, false, 9, 0, 0),
    makeSpec("generate_video_seedance_v2_5_flash", "Seedance 2.5 Flash", "2.5", ["auto", "480p", "720p", "1080p"], "auto", 4, 15, LOVART_MODES, false, 9, 0, 0),
    makeSpec("generate_video_seedance_v2_0", "Seedance 2.0", "2.0", ["auto", "480p", "720p", "1080p"], "auto", 4, 15, LOVART_MODES, false, 9, 0, 0),
    makeSpec("generate_video_seedance_v2_0_fast", "Seedance 2.0 Fast", "2.0", ["auto", "480p", "720p", "1080p"], "auto", 4, 15, LOVART_MODES, false, 9, 0, 0),
    makeSpec("generate_video_seedance_v2_0_mini", "Seedance 2.0 Mini", "2.0", ["auto", "480p", "720p", "1080p"], "auto", 4, 15, LOVART_MODES, false, 9, 0, 0),
  ],
};

export function createFallbackProvidersMap(): Record<
  ExternalVideoProviderId,
  ProviderStatusSnapshot
> {
  return {
    "jimeng-cn": {
      provider: "jimeng-cn",
      label: EXTERNAL_PROVIDER_LABELS["jimeng-cn"],
      installed: true,
      loggedIn: false,
      ready: false,
      statusText: "待检测",
      models: FALLBACK_MODELS_BY_PROVIDER["jimeng-cn"],
    },
    "dreamina-jp": {
      provider: "dreamina-jp",
      label: EXTERNAL_PROVIDER_LABELS["dreamina-jp"],
      installed: true,
      loggedIn: false,
      ready: false,
      statusText: "待检测",
      models: FALLBACK_MODELS_BY_PROVIDER["dreamina-jp"],
    },
    libtv: {
      provider: "libtv",
      label: EXTERNAL_PROVIDER_LABELS.libtv,
      installed: true,
      loggedIn: false,
      ready: false,
      statusText: "待检测",
      models: FALLBACK_MODELS_BY_PROVIDER.libtv,
    },
    lovart: {
      provider: "lovart",
      label: EXTERNAL_PROVIDER_LABELS.lovart,
      installed: true,
      loggedIn: false,
      ready: false,
      statusText: "待检测",
      models: FALLBACK_MODELS_BY_PROVIDER.lovart,
    },
  };
}

export function isExternalVideoChannel(
  value: unknown,
): value is ExternalVideoProviderId {
  return typeof value === "string"
    && (EXTERNAL_VIDEO_PROVIDER_IDS as readonly string[]).includes(value);
}

export function normalizeVideoExecutionChannel(
  raw: unknown,
  colabEnabled: boolean,
  isWebMode: boolean,
): VideoExecutionChannel {
  if (!isWebMode) return "local";
  if (isExternalVideoChannel(raw)) return raw;
  if (raw === "colab" && colabEnabled) return "colab";
  return "local";
}

export interface VideoChannelOption {
  value: VideoExecutionChannel;
  label: string;
  title?: string;
  disabled?: boolean;
}

export function buildVideoChannelSelectOptions({
  colabEnabled,
  colabAvailable,
  colabConfigured,
  colabStatusLabel,
  colabError,
}: {
  colabEnabled: boolean;
  colabAvailable: boolean;
  colabConfigured: boolean;
  colabStatusLabel?: string;
  colabError?: string | null;
}): VideoChannelOption[] {
  const options: VideoChannelOption[] = [
    {
      value: "local",
      label: "本地 ComfyUI",
      title: "使用本地或内网 ComfyUI 工作流生成视频",
    },
  ];
  if (colabEnabled) {
    options.push({
      value: "colab",
      label: colabAvailable ? "Colab" : "Colab（不可用）",
      disabled: !colabAvailable,
      title: colabAvailable
        ? `使用 Colab ComfyUI（${colabStatusLabel ?? "已就绪"}）执行`
        : (colabError ?? (colabConfigured ? "Colab 实例当前不可用" : "尚未配置 Colab ComfyUI 地址")),
    });
  }
  for (const id of EXTERNAL_VIDEO_PROVIDER_IDS) {
    options.push({
      value: id,
      label: EXTERNAL_PROVIDER_LABELS[id],
      title: `通过服务器已授权的 ${EXTERNAL_PROVIDER_LABELS[id]} CLI 调用 Seedance 2.0 / 2.5`,
    });
  }
  return options;
}

export function resolveExternalModelSpec(
  provider: ExternalVideoProviderId,
  requestedModelId: unknown,
  snapshot?: ProviderStatusSnapshot,
): ExternalVideoModelSpec {
  const models = snapshot?.models?.length
    ? snapshot.models
    : FALLBACK_MODELS_BY_PROVIDER[provider];
  if (typeof requestedModelId === "string" && requestedModelId.trim()) {
    const req = requestedModelId.trim().toLowerCase();
    const matched = models.find(
      (item) => item.id.toLowerCase() === req || item.label.toLowerCase() === req,
    );
    if (matched) return matched;
  }
  return models[0];
}

export function clampExternalDuration(
  duration: unknown,
  spec: ExternalVideoModelSpec,
): number {
  const numeric = typeof duration === "number" && Number.isFinite(duration)
    ? Math.round(duration)
    : spec.defaultDuration;
  return Math.max(spec.minDuration, Math.min(spec.maxDuration, numeric));
}

export function externalModeLabel(mode: string): string {
  switch (mode) {
    case "auto":
      return "自动识别（按参考输入）";
    case "t2v":
    case "text2video":
      return "纯文生视频 (t2v)";
    case "first_last_frame":
    case "frames2video":
      return "首尾帧生视频";
    case "singleImage2video":
      return "单图生视频";
    case "image2video":
      return "多图参考生视频";
    case "m2v":
    case "mixed2video":
      return "全能多模态参考";
    default:
      return mode;
  }
}

export function externalChannelDefaultPatch(
  provider: ExternalVideoProviderId,
  snapshot?: ProviderStatusSnapshot,
  currentContent?: Record<string, unknown>,
): Record<string, unknown> {
  const spec = resolveExternalModelSpec(provider, undefined, snapshot);
  const currentDuration = typeof currentContent?.generationDuration === "number"
    ? currentContent.generationDuration
    : spec.defaultDuration;
  return {
    generationChannel: provider,
    externalProvider: provider,
    externalModelId: spec.id,
    externalResolution: spec.defaultResolution,
    externalMode: "auto",
    externalEnableSound: currentContent?.externalEnableSound !== false,
    generationDuration: clampExternalDuration(currentDuration, spec),
    status: "idle",
    validationMessage: "",
  };
}
