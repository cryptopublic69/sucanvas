import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { VideoRegenerationPresetCollection } from "../video/videoRegenerationPresets";
import { colabProxyServerUrl, readColabProfile } from "./api";
import {
  COLAB_ALLOWED_LORAS,
  emptyColabVideoPresetsByProfile,
  loadColabVideoPresets,
  saveColabVideoPresets,
} from "./presets";
import type {
  ColabChannelController,
  ColabConnectionPatch,
  ColabNodeContext,
  ColabProfileId,
  ColabProfileOption,
  ColabProfileStatus,
  ColabSettingsParser,
} from "./types";

const CONFIGURED_STORAGE_KEY = "infinite-canvas:colab-comfy-configured";
const EMPTY_COLLECTION: VideoRegenerationPresetCollection = { presets: [], defaultPresetId: "" };

const DISABLED_PRESETS_BY_PROFILE: Record<ColabProfileId, VideoRegenerationPresetCollection> = {
  dasiwa: EMPTY_COLLECTION,
  cobijada: EMPTY_COLLECTION,
};

export const DISABLED_COLAB_NODE_CONTEXT: ColabNodeContext = {
  enabled: false,
  configured: false,
  available: false,
  profileStatus: null,
  presetsByProfile: DISABLED_PRESETS_BY_PROFILE,
  loraOptions: [],
  diffusionModelOptions: [],
};

function sameAssetList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => (
    item.trim().replace(/\\/g, "/").toLowerCase()
    === (b[index] ?? "").trim().replace(/\\/g, "/").toLowerCase()
  ));
}

export type UseColabChannelOptions = {
  enabled: boolean;
  accessUser: unknown;
  comfyConnectionRevision: number;
  parseSettings: ColabSettingsParser;
};

export function useColabChannelState({
  enabled,
  accessUser,
  comfyConnectionRevision,
  parseSettings,
}: UseColabChannelOptions): ColabChannelController {
  const active = enabled && import.meta.env.MODE === "web";
  const parseSettingsRef = useRef(parseSettings);
  parseSettingsRef.current = parseSettings;

  const [comfyUrlDraft, setComfyUrlDraft] = useState("");
  const [ssPasswordDraft, setSsPasswordDraft] = useState("");
  const [profileDraft, setProfileDraft] = useState<ColabProfileOption>("");
  const [profileStatus, setProfileStatus] = useState<ColabProfileStatus | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [configured, setConfigured] = useState(() => (
    active && window.localStorage.getItem(CONFIGURED_STORAGE_KEY) === "true"
  ));
  const [loraOptions, setLoraOptions] = useState<string[]>([]);
  const [loraCatalogLoaded, setLoraCatalogLoaded] = useState(false);
  const [diffusionModelOptions, setDiffusionModelOptions] = useState<string[]>([]);
  const [diffusionModelCatalogLoaded, setDiffusionModelCatalogLoaded] = useState(false);
  const [presetsByProfile, setPresetsByProfile] = useState<
    Record<ColabProfileId, VideoRegenerationPresetCollection>
  >(() => (
    active
      ? emptyColabVideoPresetsByProfile(window.localStorage, parseSettings)
      : DISABLED_PRESETS_BY_PROFILE
  ));

  const available = active && Boolean(profileStatus?.available && profileStatus.effectiveProfile);

  const refreshProfile = useCallback(async () => {
    if (!active || !accessUser) {
      setProfileStatus(null);
      setLoraOptions([]);
      setLoraCatalogLoaded(false);
      setDiffusionModelOptions([]);
      setDiffusionModelCatalogLoaded(false);
      return;
    }
    setProfileLoading(true);
    try {
      const status = await readColabProfile();
      setProfileStatus(status);
      setConfigured(status.configured);
      window.localStorage.setItem(CONFIGURED_STORAGE_KEY, status.configured ? "true" : "false");
      const allowedLoras = status.allowedLoras?.length
        ? status.allowedLoras
        : [...COLAB_ALLOWED_LORAS];
      setLoraOptions((current) => (sameAssetList(current, allowedLoras) ? current : allowedLoras));
      setLoraCatalogLoaded(true);
      const lockedModels = status.diffusionModelName ? [status.diffusionModelName] : [];
      setDiffusionModelOptions((current) => (
        sameAssetList(current, lockedModels) ? current : lockedModels
      ));
      setDiffusionModelCatalogLoaded(Boolean(status.available && status.diffusionModelName));
    } catch {
      setProfileStatus((current) => (
        current ? { ...current, reachable: false, available: false } : null
      ));
      setDiffusionModelCatalogLoaded(false);
    } finally {
      setProfileLoading(false);
    }
  }, [accessUser, active]);

  useEffect(() => {
    if (!active || !accessUser) {
      setProfileStatus(null);
      setLoraOptions([]);
      setLoraCatalogLoaded(false);
      setDiffusionModelOptions([]);
      setDiffusionModelCatalogLoaded(false);
      return;
    }
    void refreshProfile();
    const onFocus = () => {
      if (document.visibilityState === "visible") void refreshProfile();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshProfile();
    }, 15_000);
    let unlistenConfigChanged: (() => void) | undefined;
    void listen("canvas://colab-config-changed", () => {
      void refreshProfile();
    }).then((unlisten) => {
      unlistenConfigChanged = unlisten;
    }).catch(() => {});
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
      unlistenConfigChanged?.();
    };
  }, [accessUser, active, comfyConnectionRevision, refreshProfile]);

  const syncFromConnection = useCallback((connection: Partial<ColabConnectionPatch>) => {
    if (!active) return;
    const nextUrl = connection.colabComfyUrl ?? "";
    const nextConfigured = Boolean(nextUrl.trim());
    setComfyUrlDraft(nextUrl);
    setSsPasswordDraft(connection.colabSsPassword ?? "");
    setProfileDraft((connection.colabProfile ?? "") as ColabProfileOption);
    setConfigured(nextConfigured);
    window.localStorage.setItem(CONFIGURED_STORAGE_KEY, nextConfigured ? "true" : "false");
  }, [active]);

  const buildConnectionPatch = useCallback((): ColabConnectionPatch => {
    if (!active) {
      return { colabComfyUrl: "", colabSsPassword: "", colabProfile: "" };
    }
    const colabComfyUrl = comfyUrlDraft
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/\/+$/, "");
    const colabSsPassword = ssPasswordDraft.trim();
    if (colabComfyUrl) {
      try {
        const parsed = new URL(colabComfyUrl);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
          throw new Error();
        }
      } catch {
        throw new Error("Colab ComfyUI 服务地址无效，请填写 http:// 或 https:// 开头的完整地址");
      }
    }
    return {
      colabComfyUrl,
      colabSsPassword,
      colabProfile: profileDraft,
    };
  }, [active, comfyUrlDraft, profileDraft, ssPasswordDraft]);

  const loadProfilePresets = useCallback((profile: ColabProfileId) => {
    const loaded = loadColabVideoPresets(window.localStorage, profile, parseSettingsRef.current);
    setPresetsByProfile((current) => ({ ...current, [profile]: loaded }));
    return loaded;
  }, []);

  const saveProfilePresets = useCallback((
    profile: ColabProfileId,
    collection: VideoRegenerationPresetCollection,
  ) => {
    saveColabVideoPresets(window.localStorage, profile, collection);
    const synced = loadColabVideoPresets(window.localStorage, profile, parseSettingsRef.current);
    setPresetsByProfile((current) => ({ ...current, [profile]: synced }));
    return synced;
  }, []);

  const monitorServerUrl = active && available ? colabProxyServerUrl() : undefined;
  const monitorLabel = profileStatus?.label ? `Colab · ${profileStatus.label}` : "Colab";

  const nodeContext = useMemo<ColabNodeContext>(() => (
    active
      ? {
        enabled: true,
        configured,
        available,
        profileStatus,
        presetsByProfile,
        loraOptions,
        diffusionModelOptions,
      }
      : DISABLED_COLAB_NODE_CONTEXT
  ), [active, available, configured, diffusionModelOptions, loraOptions, presetsByProfile, profileStatus]);

  return {
    enabled: active,
    configured: active && configured,
    available,
    profileStatus: active ? profileStatus : null,
    profileLoading: active && profileLoading,
    comfyUrlDraft,
    setComfyUrlDraft,
    ssPasswordDraft,
    setSsPasswordDraft,
    profileDraft,
    setProfileDraft,
    refreshProfile,
    syncFromConnection,
    buildConnectionPatch,
    loraOptions: active ? loraOptions : [],
    loraCatalogLoaded: active && loraCatalogLoaded,
    diffusionModelOptions: active ? diffusionModelOptions : [],
    diffusionModelCatalogLoaded: active && diffusionModelCatalogLoaded,
    presetsByProfile,
    loadProfilePresets,
    saveProfilePresets,
    monitorServerUrl,
    monitorLabel,
    nodeContext,
  };
}
