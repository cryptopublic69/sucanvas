// CANVAS-039: a scheme's sampler, chosen on the settings page (「工作流方案」). A package that
// declares sampler nodes (adapter bindings samplerSelectNodeIds) offers it; the value is the
// module setting samplerName (manifest defaults). Unset = the package's own value. The server
// writes it into the declared nodes when submitting; nodes and presets carry no sampler.

export interface SamplerChoices {
  /** The value the package's workflow carries. */
  packageValue: string;
  /** ComfyUI's choices (empty when ComfyUI could not be read). */
  options: string[];
  comfyuiError?: string | null;
}

export interface SamplerOption {
  value: string;
  label: string;
}

/** The part of a module record this setting reads. */
export interface SamplerModule {
  deletedAt?: string | null;
  defaults: object & { samplerName?: string | null };
  adapter?: { bindings?: object & { samplerSelectNodeIds?: string[] } };
}

export function samplerNodeIds(module: SamplerModule): string[] {
  return module.adapter?.bindings?.samplerSelectNodeIds?.filter((id) => id.trim()) ?? [];
}

export function hasSamplerSetting(module: SamplerModule): boolean {
  return !module.deletedAt && samplerNodeIds(module).length > 0;
}

export function currentSampler(module: SamplerModule): string {
  return typeof module.defaults.samplerName === "string" ? module.defaults.samplerName.trim() : "";
}

/** "Unset (package value)" first, then ComfyUI's list; the current value always stays offered. */
export function samplerOptions(choices: SamplerChoices | null, current: string): SamplerOption[] {
  const packageValue = choices?.packageValue?.trim() ?? "";
  const options: SamplerOption[] = [{
    value: "",
    label: packageValue ? `未设置（沿用方案包：${packageValue}）` : "未设置（沿用方案包）",
  }];
  for (const name of choices?.options ?? []) {
    if (name && !options.some((option) => option.value === name)) options.push({ value: name, label: name });
  }
  if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
  return options;
}

/** The module settings with this sampler; an empty choice clears it (null). */
export function samplerDefaults<T extends object>(defaults: T, value: string): T & { samplerName: string | null } {
  return { ...defaults, samplerName: value.trim() || null };
}

// CANVAS-041: on the settings page the sampler is a draft like the scheme's name; 「保存」 and
// 「另存为新方案」 write it, choosing one writes nothing.

/** The settings a save sends: the scheme's own settings, with the draft where the package declares sampler nodes. */
export function samplerDraftDefaults<T extends object>(module: SamplerModule & { defaults: T }, draft: string): T {
  return hasSamplerSetting(module) ? samplerDefaults(module.defaults, draft) : module.defaults;
}

/** The draft differs from the scheme's saved sampler. */
export function samplerDraftDirty(module: SamplerModule, draft: string): boolean {
  return hasSamplerSetting(module) && draft.trim() !== currentSampler(module);
}
