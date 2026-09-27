const parameterKeys = [
  "workflowModuleId", "workflowModuleRevision", "prompt", "durationSeconds", "aspectRatio",
  "primaryResolutionMegapixels", "secondaryResolutionMegapixels", "primaryVideoSteps", "primaryAudioSteps",
  "secondarySchedulerSteps", "primaryUpscaleFactor", "primaryBrightness", "primaryContrast", "primarySaturation",
  "secondaryBrightness", "secondaryContrast", "secondarySaturation", "diffusionModelName",
  "loraName", "loraStrength", "loraBypassed", "secondaryLoraName", "secondaryLoraStrength", "secondaryLoraBypassed",
  "styleLoras", "styleLoraName", "styleLoraStrength", "styleLoraBypassed", "styleLoraApplyToSecondary",
  "refImageSize", "strictPromptTags", "imagePaths", "imageRoles", "audioPaths", "videoPaths",
] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]),
  );
  return value;
}

function parameterKey(snapshot: object): string {
  const values = snapshot as Record<string, unknown>;
  return JSON.stringify(parameterKeys.map((key) => canonical(values[key])));
}

export function findDuplicateVideoRequest(
  contents: Iterable<Record<string, unknown>>,
  clientIds: ReadonlySet<string>,
  seed: string,
  snapshot: object,
  sourceGeneratorId: string,
): "active" | "completed" | null {
  const normalize = (value: unknown) => typeof value === "string" && /^\d+$/.test(value)
    ? BigInt(value).toString() : null;
  const requested = normalize(seed);
  if (requested === null) return null;
  const parameters = parameterKey(snapshot);
  for (const content of contents) {
    if (content.sourceGeneratorId !== sourceGeneratorId || content.sourcePreviewId
      || normalize(content.seed) !== requested
      || !content.generationSnapshot || typeof content.generationSnapshot !== "object"
      || parameterKey(content.generationSnapshot) !== parameters) continue;
    if (content.generationPlaceholder === true
      && typeof content.placeholderClientId === "string"
      && clientIds.has(content.placeholderClientId)) return "active";
    if (content.generationPlaceholder !== true && typeof content.videoUrl === "string" && content.videoUrl) return "completed";
  }
  return null;
}
