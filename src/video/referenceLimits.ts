// Reference-to-video (全能参考) input limits. Connecting, the node's own check and
// submission all read them from the selected workflow module, so a package that
// was not upgraded is held to its own limit everywhere instead of failing in ComfyUI.

/** Packages from before the third audio input; also the limit when no module is found. */
export const LEGACY_REFERENCE_AUDIO_MAX = 2;
/** Image limit for adapters that do not declare imageMax. */
export const DEFAULT_REFERENCE_IMAGE_MAX = 9;

export interface ReferenceCounts {
  images: number;
  audios: number;
}

export type ReferenceLimits = ReferenceCounts;

export type ReferenceMediaKind = "image" | "audio" | "video" | null;

interface ReferenceModule {
  id: string;
  capability: string;
  variant: string;
  deletedAt: string | null;
  adapter?: { inputContract?: { imageMax?: unknown; audioMax?: unknown } };
}

const declaredCount = (value: unknown, fallback: number) => (
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback
);

export function referenceLimits(module: ReferenceModule | null | undefined): ReferenceLimits {
  const contract = module?.adapter?.inputContract;
  return {
    images: declaredCount(contract?.imageMax, DEFAULT_REFERENCE_IMAGE_MAX),
    audios: declaredCount(contract?.audioMax, LEGACY_REFERENCE_AUDIO_MAX),
  };
}

/** The module a reference node submits with: its own choice, else the default for the slot. */
export function referenceModuleFor<T extends ReferenceModule>(
  content: Record<string, unknown>,
  modules: T[],
  defaults: Partial<Record<string, string>>,
): T | undefined {
  const moduleId = typeof content.workflowModuleId === "string"
    ? content.workflowModuleId
    : defaults["video-generation:reference-to-video"] ?? "";
  return modules.find((module) => (
    !module.deletedAt
    && module.id === moduleId
    && module.capability === "video-generation"
    && module.variant === "reference-to-video"
  ));
}

export function referenceCounts(kinds: ReferenceMediaKind[]): ReferenceCounts {
  return {
    images: kinds.filter((kind) => kind === "image").length,
    audios: kinds.filter((kind) => kind === "audio").length,
  };
}

/**
 * Connecting `adding` to a plain reference node that already has `connected`.
 * A batch either fits as a whole or is refused as a whole.
 */
export function referenceConnectionError(
  connected: ReferenceCounts,
  adding: ReferenceMediaKind[],
  limits: ReferenceLimits,
): string | null {
  const added = referenceCounts(adding);
  const batch = adding.length > 1;
  if (added.audios && connected.audios + added.audios > limits.audios) {
    return batch
      ? `全能参考最多连接 ${limits.audios} 个音频（已连 ${connected.audios} 个，这次选了 ${added.audios} 个），整批未连接`
      : `全能参考最多连接 ${limits.audios} 个音频`;
  }
  if (added.images && connected.images + added.images > limits.images) {
    return batch
      ? `全能参考最多连接 ${limits.images} 张图片（已连 ${connected.images} 张，这次选了 ${added.images} 张），整批未连接`
      : `全能参考最多连接 ${limits.images} 张图片`;
  }
  return null;
}

/** Plain reference nodes are limited when connecting; smart (storyboard) nodes take any number of candidates. */
export function referenceConnectionLimitApplies(
  target: { kind: string; content: Record<string, unknown> },
  mode: string,
): boolean {
  return target.kind === "video-generation"
    && mode === "reference-to-video"
    && target.content.storyboardReferenceCompiler !== true;
}

export interface ReferenceBatchNode {
  id: string;
  selected: boolean;
  kind: string;
  mediaKind: ReferenceMediaKind;
}

const BATCH_INPUT_KINDS = new Set(["text", "image", "audio", "video"]);

/**
 * Dragging from a selected input node connects the whole selection (see connectNodes).
 * Returns the refusal for that batch, or null when it is not a batch or it fits.
 * The dragged node may itself be connected already; the rest of the selection still counts.
 */
export function referenceBatchConnectionError(
  sourceId: string,
  targetId: string,
  nodes: ReferenceBatchNode[],
  edges: { source: string; target: string }[],
  limits: ReferenceLimits,
): string | null {
  const source = nodes.find((node) => node.id === sourceId);
  if (!source?.selected || !BATCH_INPUT_KINDS.has(source.kind)) return null;
  const connectedIds = new Set(edges.filter((edge) => edge.target === targetId).map((edge) => edge.source));
  const adding = nodes
    .filter((node) => node.selected && BATCH_INPUT_KINDS.has(node.kind) && !connectedIds.has(node.id))
    .map((node) => node.mediaKind);
  if (adding.length < 2) return null;
  const connected = referenceCounts(
    nodes.filter((node) => connectedIds.has(node.id)).map((node) => node.mediaKind),
  );
  return referenceConnectionError(connected, adding, limits);
}

/** Submission check for a plain node (`node`) or one storyboard shot (`storyboard`). */
export function referenceSubmitError(
  counts: ReferenceCounts,
  limits: ReferenceLimits,
  scope: "node" | "storyboard",
): string | null {
  if (counts.images > limits.images) {
    return scope === "node"
      ? `当前参考工作流最多支持 ${limits.images} 张图片`
      : `当前分镜选中了 ${counts.images} 张图片，单次最多 ${limits.images} 张`;
  }
  if (counts.audios > limits.audios) {
    return scope === "node"
      ? `当前参考工作流最多支持 ${limits.audios} 个音频`
      : `当前分镜选中了 ${counts.audios} 个音频，单次最多 ${limits.audios} 个`;
  }
  return null;
}
