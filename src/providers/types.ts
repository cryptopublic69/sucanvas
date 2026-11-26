export type ExternalVideoProviderId =
  | "jimeng-cn"
  | "dreamina-jp"
  | "libtv"
  | "lovart";

export type VideoExecutionChannel = "local" | "colab" | ExternalVideoProviderId;

export interface ExternalVideoModelSpec {
  id: string;
  label: string;
  series: string;
  resolutions: string[];
  defaultResolution: string;
  minDuration: number;
  maxDuration: number;
  defaultDuration: number;
  aspectRatios: string[];
  modes: string[];
  supportsAudioToggle: boolean;
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
}

export interface ProviderStatusSnapshot {
  provider: ExternalVideoProviderId;
  label: string;
  installed: boolean;
  loggedIn: boolean;
  ready: boolean;
  statusText: string;
  error?: string | null;
  binaryPath?: string | null;
  models: ExternalVideoModelSpec[];
}

export interface ExternalVideoSubmitPayload {
  canvasId: string;
  provider: ExternalVideoProviderId;
  modelId?: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution?: string;
  mode?: string;
  enableSound?: boolean;
  generatorNodeId: string;
  placeholderNodeId: string;
  imagePaths: string[];
  videoPaths: string[];
  audioPaths: string[];
  promptVersionLabel?: string;
  promptSourceNodeId?: string;
  promptSourceTitle?: string;
  title?: string;
}

export interface ExternalVideoJobRecord {
  id: string;
  canvasId: string;
  provider: ExternalVideoProviderId;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  generatorNodeId: string;
  placeholderNodeId: string;
  userId: string;
  status:
    | "queued"
    | "running"
    | "awaiting_confirmation"
    | "confirming"
    | "succeeded"
    | "failed"
    | "cancelled";
  stageMessage: string;
  costCredits?: number | null;
  quoteSummary?: string | null;
  remoteProjectId?: string | null;
  remoteNodeId?: string | null;
  remoteSubmitId?: string | null;
  remoteThreadId?: string | null;
  workingDir?: string | null;
  outputAssetPath?: string | null;
  outputVideoUrl?: string | null;
  error?: string | null;
  executionElapsedSeconds?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalProvidersNodeContext {
  enabled: boolean;
  loading: boolean;
  providersById: Record<ExternalVideoProviderId, ProviderStatusSnapshot>;
  onConfirmJob: (jobId: string) => Promise<ExternalVideoJobRecord>;
  onCancelJob: (jobId: string) => Promise<ExternalVideoJobRecord>;
}

export interface ExternalProvidersController {
  enabled: boolean;
  loading: boolean;
  error: string;
  providers: ProviderStatusSnapshot[];
  providersById: Record<ExternalVideoProviderId, ProviderStatusSnapshot>;
  refresh: () => Promise<void>;
  submitVideo: (payload: ExternalVideoSubmitPayload) => Promise<ExternalVideoJobRecord>;
  confirmVideo: (jobId: string) => Promise<ExternalVideoJobRecord>;
  cancelVideo: (jobId: string) => Promise<ExternalVideoJobRecord>;
  nodeContext: ExternalProvidersNodeContext;
}
