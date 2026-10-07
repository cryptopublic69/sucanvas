import type { GenerationSnapshot, WorkflowModuleDefaultMap, WorkflowModuleRecord } from "../CanvasNode";

export interface VideoUpscaleSnapshot {
  workflowModuleId: string;
  workflowModuleName: string;
  workflowModuleRevision: string;
  outputNodeId: string;
  parameters: Record<string, number>;
  parameterLabels: Record<string, string>;
  sourceVideoUrl: string;
  aspectRatio: number;
}

export interface VideoUpscaleDraft {
  previewId: string;
  previewTitle: string;
  workflowModuleId: string;
  parameters: Record<string, number>;
}

export function videoUpscaleFromValue(value: unknown): VideoUpscaleSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as VideoUpscaleSnapshot;
  if (typeof source.workflowModuleId !== "string" || !source.workflowModuleId
    || typeof source.workflowModuleName !== "string" || typeof source.workflowModuleRevision !== "string"
    || typeof source.outputNodeId !== "string" || typeof source.sourceVideoUrl !== "string"
    || typeof source.aspectRatio !== "number" || !Number.isFinite(source.aspectRatio) || source.aspectRatio <= 0
    || !source.parameters || typeof source.parameters !== "object" || Array.isArray(source.parameters)
    || Object.values(source.parameters).some((value) => typeof value !== "number" || !Number.isFinite(value))) return undefined;
  return { ...source, parameterLabels: source.parameterLabels ?? {} };
}

export function videoUpscaleModule(modules: WorkflowModuleRecord[], defaults: WorkflowModuleDefaultMap, visibleIds: string[]): WorkflowModuleRecord | undefined {
  const available = modules.filter((module) => !module.deletedAt && module.capability === "video-upscale" && visibleIds.includes(module.id));
  return available.find((module) => module.id === defaults["video-upscale"]) ?? available[0];
}

export function videoUpscaleDefaults(module: WorkflowModuleRecord): Record<string, number> {
  return Object.fromEntries(module.uiSchema.groups.flatMap((group) => group.fields.map((field) => [field.key, field.default])));
}

export function videoUpscaleParameterError(module: WorkflowModuleRecord, values: Record<string, number>): string | null {
  for (const field of module.uiSchema.groups.flatMap((group) => group.fields)) {
    const value = values[field.key];
    const offset = (value - field.min) / field.step;
    if (!Number.isFinite(value) || value < field.min || value > field.max || Math.abs(offset - Math.round(offset)) > 1e-6) {
      return `${field.label}必须在 ${field.min}–${field.max} 之间，步长为 ${field.step}`;
    }
  }
  return null;
}

// Retain the original generation metadata when available. Processing itself only needs a video.
export function videoUpscaleGenerationSnapshot(source: GenerationSnapshot | null, processing: VideoUpscaleSnapshot): GenerationSnapshot {
  return {
    prompt: "", promptInformation: "", promptNodeId: "", promptNodeTitle: "", promptNodeIdSource: "",
    promptVersionId: "", promptVersionLabel: "", durationSeconds: 0, aspectRatio: "16:9",
    primaryResolutionMegapixels: 0.4, secondaryResolutionMegapixels: 0.5,
    primaryVideoSteps: 8, primaryAudioSteps: 8, secondarySchedulerSteps: 8, primaryUpscaleFactor: 1,
    primaryBrightness: 1, primaryContrast: 1, primarySaturation: 1, secondaryBrightness: 1, secondaryContrast: 1, secondarySaturation: 1,
    diffusionModelName: "", loraName: "", loraStrength: 1, loraBypassed: true, secondaryLoraName: "", secondaryLoraStrength: 1, secondaryLoraBypassed: true,
    styleLoras: [], styleLoraName: "", styleLoraStrength: 1, styleLoraBypassed: true, styleLoraApplyToSecondary: false,
    refImageSize: "match", imagePaths: [], imageRoles: [], audioPaths: [], videoPaths: [], workflowModuleId: "", workflowModuleRevision: "",
    ...source, videoUpscale: processing,
  };
}
