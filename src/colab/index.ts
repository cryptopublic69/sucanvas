/**
 * Isolated, hot-pluggable Colab ComfyUI channel module.
 *
 * Deprecation / removal switch (2 edits across the repo):
 * 1. Frontend: set `COLAB_CHANNEL_ENABLED = false` below.
 * 2. Backend: comment out `"colab-channel",` in `src-tauri/Cargo.toml` under `[features].web-server`.
 *
 * Typed explicitly as `: boolean` so toggling `true` <-> `false` never triggers TypeScript
 * literal narrowing (`TS2367`) errors. Historical `sucanvas://colab-outputs/` media playback,
 * cleanup, and existing Colab node fallback to `"local"` remain intact when disabled.
 */
import "./colab.css";
import { normalizeVideoChannel } from "./presets";
import { useColabChannelState, type UseColabChannelOptions } from "./useColabChannel";

export const COLAB_CHANNEL_ENABLED: boolean = true;

export function effectiveVideoChannel(content: Record<string, unknown>): "local" | "colab" {
  return normalizeVideoChannel(
    content.generationChannel,
    COLAB_CHANNEL_ENABLED,
    import.meta.env.MODE === "web",
  );
}

export function useColabChannel(options: Omit<UseColabChannelOptions, "enabled">) {
  return useColabChannelState({ ...options, enabled: COLAB_CHANNEL_ENABLED });
}

export { colabProxyServerUrl, isColabProxyUrl, readColabProfile } from "./api";
export {
  ColabChannelToggle,
  ColabLockedModelField,
  ColabLockedWorkflowField,
  ColabVideoChannelBadge,
  buildColabChannelSwitchPatch,
  buildLocalChannelRestorePatch,
} from "./ColabNodeControls";
export { ColabSettingsSection } from "./ColabSettingsSection";
export {
  COLAB_ALLOWED_LORAS,
  COLAB_LIVE_PREVIEW_NODE_ID,
  COLAB_PROFILE_LABELS,
  COLAB_PROFILE_MODELS,
  COLAB_WORKFLOW_DEFAULT_LABEL,
  COLAB_WORKFLOW_MODULE_ID,
  colabGeneratedVideoWorkflowLabel,
  colabPresetNodePatch,
  colabPresetStorageKey,
  colabWorkflowDefaultSettings,
  emptyColabVideoPresetsByProfile,
  isAllowedColabLoraName,
  loadColabVideoPresets,
  normalizeVideoChannel,
  resolveColabProfileForSnapshot,
  saveColabVideoPresets,
} from "./presets";
export type {
  ColabChannelController,
  ColabConnectionPatch,
  ColabNodeContext,
  ColabProfileId,
  ColabProfileOption,
  ColabProfileStatus,
} from "./types";
