// CANVAS-022: rules shared by the image generation node, its submission and the
// image toolbar once Krea2 and Moss text-to-image modules sit side by side.
// Kept free of imports so tests can load it directly.

export const KREA2_TEXT_TO_IMAGE_ADAPTER = "krea2-text-to-image-v1";
export const MOSS_TEXT_TO_IMAGE_ADAPTER = "moss-text-to-image-v1";

type ImageModuleLike = {
  id: string;
  capability: string;
  variant: string;
  revision: string;
  deletedAt?: string | null;
  adapter?: { adapterId?: string };
};

type ImageContent = Record<string, unknown>;

const MOSS_DEFAULT_STEPS = 25;
const KREA2_DEFAULT_STEPS = 8;

export function isMossImageModule(module: ImageModuleLike | null | undefined): boolean {
  return module?.adapter?.adapterId === MOSS_TEXT_TO_IMAGE_ADAPTER;
}

function isImageEditModule(module: ImageModuleLike | null | undefined): boolean {
  return module?.variant === "image-edit";
}

/** LoRA belongs to the Krea2 text-to-image workflow only (also for nodes whose module is unknown). */
export function imageModuleSupportsLora(module: ImageModuleLike | null | undefined): boolean {
  return !isImageEditModule(module) && !isMossImageModule(module);
}

/** Output upscale is the Krea2 text-to-image workflow's upscale branch. */
export function imageModuleSupportsUpscale(module: ImageModuleLike | null | undefined): boolean {
  return imageModuleSupportsLora(module);
}

export function defaultImageSteps(module: ImageModuleLike | null | undefined): number {
  return isMossImageModule(module) ? MOSS_DEFAULT_STEPS : KREA2_DEFAULT_STEPS;
}

export function imageModelDirectoryLabel(module: ImageModuleLike | null | undefined): string {
  return isMossImageModule(module) ? "Moss" : "Krea2";
}

/** Base model names are `<directory>\<file>`; Krea2 also accepts the historical `Kera2` spelling. */
export function isImageModelNameForModule(value: string | null | undefined, module: ImageModuleLike | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\//g, "\\");
  const separator = normalized.indexOf("\\");
  if (separator <= 0 || !normalized.slice(separator + 1).trim()) return false;
  const directory = normalized.slice(0, separator).toLowerCase();
  return isMossImageModule(module) ? directory === "moss" : directory === "krea2" || directory === "kera2";
}

/** Node content after picking another module: values the new module cannot use are cleared,
 * steps still at the old module's default move to the new default. */
export function imageModuleSwitchContent(
  content: ImageContent,
  module: ImageModuleLike,
  previousModule: ImageModuleLike | null | undefined,
): ImageContent {
  const currentSteps = typeof content.steps === "number" ? content.steps : defaultImageSteps(previousModule);
  return {
    ...content,
    workflowModuleId: module.id,
    workflowModuleRevision: module.revision,
    imageEditLayout: isImageEditModule(module),
    imageLoraName: imageModuleSupportsLora(module) && typeof content.imageLoraName === "string" ? content.imageLoraName : "",
    upscaleEnabled: imageModuleSupportsUpscale(module) ? content.upscaleEnabled === true : false,
    steps: currentSteps === defaultImageSteps(previousModule) ? defaultImageSteps(module) : currentSteps,
    status: "idle",
    validationMessage: "",
  };
}

/** What a submission (and its recovery snapshot) may carry for this module. */
export function effectiveImageOptions(
  content: ImageContent,
  module: ImageModuleLike | null | undefined,
): { loraName: string; upscaleEnabled: boolean } {
  const loraName = typeof content.imageLoraName === "string" ? content.imageLoraName.trim() : "";
  return {
    loraName: imageModuleSupportsLora(module) ? loraName : "",
    upscaleEnabled: imageModuleSupportsUpscale(module) && content.upscaleEnabled === true,
  };
}

function isKrea2TextToImageModule(module: ImageModuleLike): boolean {
  return !module.deletedAt
    && module.capability === "image-generation"
    && module.variant === "image-generation"
    && !isMossImageModule(module);
}

/** The module whose upscale branch the image toolbar runs: the default image module if it is
 * a Krea2 text-to-image module, else the first such module. */
export function imageUpscaleModule<T extends ImageModuleLike>(modules: T[], defaultModuleId: string): T | undefined {
  return modules.find((module) => module.id === defaultModuleId && isKrea2TextToImageModule(module))
    ?? modules.find(isKrea2TextToImageModule);
}

/** Images produced by a Moss module do not offer the Krea2 toolbar upscale. */
export function generatedImageUpscaleSupported(content: ImageContent, modules: ImageModuleLike[]): boolean {
  const moduleId = typeof content.generationWorkflowModuleId === "string" ? content.generationWorkflowModuleId : "";
  const module = moduleId ? modules.find((candidate) => candidate.id === moduleId) : undefined;
  return !isMossImageModule(module);
}
