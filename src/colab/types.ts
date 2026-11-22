import type { Dispatch, SetStateAction } from "react";
import type {
  VideoRegenerationPresetCollection,
  VideoRegenerationSettings,
} from "../video/videoRegenerationPresets";

export type ColabProfileId = "dasiwa" | "cobijada";

export type ColabProfileOption = "" | ColabProfileId;

export type ColabProfileStatus = {
  configured: boolean;
  reachable: boolean;
  available: boolean;
  selectedProfile: ColabProfileOption;
  detectedProfile: ColabProfileId | null;
  effectiveProfile: ColabProfileId | null;
  source: "detected" | "manual" | "none";
  label: string;
  workflowLabel: string;
  diffusionModelName: string;
  allowedLoras: string[];
  samplerOptions?: string[];
  error: string | null;
};

export type ColabConnectionPatch = {
  colabComfyUrl: string;
  colabSsPassword: string;
  colabProfile: ColabProfileOption;
};

export type ColabNodeContext = {
  enabled: boolean;
  configured: boolean;
  available: boolean;
  profileStatus: ColabProfileStatus | null;
  presetsByProfile: Record<ColabProfileId, VideoRegenerationPresetCollection>;
  loraOptions: string[];
  diffusionModelOptions: string[];
  samplerOptions: string[];
};

export type ColabSettingsParser = (value: unknown) => VideoRegenerationSettings | null;

export type ColabChannelController = {
  enabled: boolean;
  configured: boolean;
  available: boolean;
  profileStatus: ColabProfileStatus | null;
  profileLoading: boolean;
  comfyUrlDraft: string;
  setComfyUrlDraft: Dispatch<SetStateAction<string>>;
  ssPasswordDraft: string;
  setSsPasswordDraft: Dispatch<SetStateAction<string>>;
  profileDraft: ColabProfileOption;
  setProfileDraft: Dispatch<SetStateAction<ColabProfileOption>>;
  refreshProfile: () => Promise<void>;
  syncFromConnection: (connection: Partial<ColabConnectionPatch>) => void;
  buildConnectionPatch: () => ColabConnectionPatch;
  loraOptions: string[];
  loraCatalogLoaded: boolean;
  diffusionModelOptions: string[];
  diffusionModelCatalogLoaded: boolean;
  samplerOptions: string[];
  presetsByProfile: Record<ColabProfileId, VideoRegenerationPresetCollection>;
  loadProfilePresets: (profile: ColabProfileId) => VideoRegenerationPresetCollection;
  saveProfilePresets: (
    profile: ColabProfileId,
    collection: VideoRegenerationPresetCollection,
  ) => VideoRegenerationPresetCollection;
  monitorServerUrl: string | undefined;
  monitorLabel: string;
  nodeContext: ColabNodeContext;
};
