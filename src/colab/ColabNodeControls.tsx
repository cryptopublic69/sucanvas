import type { H3StyleLora } from "../styleLoras";
import {
  COLAB_WORKFLOW_DEFAULT_LABEL,
  colabPresetNodePatch,
  colabWorkflowDefaultSettings,
} from "./presets";
import type { ColabNodeContext, ColabProfileId } from "./types";

export function ColabChannelToggle({
  colab,
  channel,
  onSelect,
}: {
  colab?: ColabNodeContext;
  channel: "local" | "colab";
  onSelect: (nextChannel: "local" | "colab") => void;
}) {
  if (!colab?.enabled) return null;
  const { available, configured, profileStatus } = colab;
  return (
    <div
      className="video-workflow-module-select video-channel-select"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span>执行渠道</span>
      <div className="video-channel-options" role="radiogroup" aria-label="视频执行渠道">
        <button
          type="button"
          role="radio"
          aria-checked={channel === "local"}
          className={channel === "local" ? "is-active" : ""}
          onClick={() => onSelect("local")}
        >
          本地
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={channel === "colab"}
          disabled={!available}
          title={available
            ? `提交到 Colab ComfyUI（${profileStatus?.label ?? "已就绪"}）执行并使用 SS_tools 回传`
            : (profileStatus?.error ?? (configured ? "Colab 实例当前不可用" : "管理员尚未配置 Colab ComfyUI 服务地址"))}
          className={channel === "colab" ? "is-active" : ""}
          onClick={() => onSelect("colab")}
        >
          Colab
        </button>
      </div>
    </div>
  );
}

export function ColabLockedWorkflowField({ colab }: { colab?: ColabNodeContext }) {
  const available = Boolean(colab?.available);
  const status = colab?.profileStatus;
  return (
    <div
      className={`video-locked-value ${available ? "" : "is-offline"}`}
      title={available
        ? (status?.workflowLabel ?? COLAB_WORKFLOW_DEFAULT_LABEL)
        : (status?.error ?? "Colab 实例当前未运行或无法连接")}
    >
      {available
        ? (status?.workflowLabel ?? COLAB_WORKFLOW_DEFAULT_LABEL)
        : "Colab 实例未连接（请切回本地）"}
    </div>
  );
}

export function ColabLockedModelField({ colab }: { colab?: ColabNodeContext }) {
  const available = Boolean(colab?.available);
  const status = colab?.profileStatus;
  return (
    <div
      className={`video-locked-value ${available ? "" : "is-offline"}`}
      title={available
        ? (status?.diffusionModelName ?? "")
        : (status?.error ?? "Colab 实例当前未运行")}
    >
      {available && status?.effectiveProfile
        ? `${status.label} · ${status.source === "detected" ? "自动识别锁定" : "手动锁定"}`
        : (status?.error ?? "Colab 实例未连接")}
    </div>
  );
}

/** Kept unconditional so existing Colab-generated video cards keep their badge even if disabled. */
export function ColabVideoChannelBadge({ comfyChannel }: { comfyChannel: unknown }) {
  if (comfyChannel !== "colab") return null;
  return (
    <span
      className="generated-video-channel-badge"
      title="通过 Colab ComfyUI + SS_tools 执行并解码保存"
    >
      Colab
    </span>
  );
}

export type LocalChannelBackupInput = {
  primaryVideoResolution: number;
  primaryVideoSteps: number;
  h3LoraName: string;
  h3LoraStrength: number;
  h3LoraBypassed: boolean;
  primaryBrightness: number;
  primaryContrast: number;
  primarySaturation: number;
  styleLoras: H3StyleLora[];
};

export function buildColabChannelSwitchPatch(
  content: Record<string, unknown>,
  colab: ColabNodeContext | undefined,
  backupInput: LocalChannelBackupInput,
): Record<string, unknown> {
  const localBackup = {
    generationPrimaryResolution: backupInput.primaryVideoResolution,
    generationPrimaryVideoSteps: backupInput.primaryVideoSteps,
    generationLoraName: backupInput.h3LoraName,
    generationLoraStrength: backupInput.h3LoraStrength,
    generationLoraBypassed: backupInput.h3LoraBypassed,
    generationPrimaryBrightness: backupInput.primaryBrightness,
    generationPrimaryContrast: backupInput.primaryContrast,
    generationPrimarySaturation: backupInput.primarySaturation,
    generationStyleLoras: backupInput.styleLoras.map((slot) => ({ ...slot })),
  };
  const targetProfile: ColabProfileId = colab?.profileStatus?.effectiveProfile ?? "dasiwa";
  const profileCollection = colab?.presetsByProfile[targetProfile];
  const defaultColabPreset = profileCollection?.presets.find(
    (preset) => preset.id === profileCollection.defaultPresetId,
  ) ?? profileCollection?.presets[0];
  const colabSettings = defaultColabPreset?.settings ?? colabWorkflowDefaultSettings(targetProfile);
  return {
    ...content,
    localChannelBackup: localBackup,
    generationChannel: "colab",
    ...colabPresetNodePatch(colabSettings),
    status: "idle",
    validationMessage: "",
  };
}

export function buildLocalChannelRestorePatch(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const backup = content.localChannelBackup;
  const restored = backup && typeof backup === "object" && !Array.isArray(backup)
    ? (backup as Record<string, unknown>)
    : {};
  const nextContent: Record<string, unknown> = {
    ...content,
    ...restored,
    generationChannel: "local",
    status: "idle",
    validationMessage: "",
  };
  delete nextContent.localChannelBackup;
  return nextContent;
}
