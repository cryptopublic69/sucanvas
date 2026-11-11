// CANVAS-039: the sampler dropdown of a scheme on the settings page (「工作流方案」). Drawn only
// for a package that declares sampler nodes. CANVAS-041: it shows the caller's draft; the
// scheme changes only with 「保存」 or 「另存为新方案」.
import type { ReactElement } from "react";
import {
  currentSampler,
  hasSamplerSetting,
  samplerDraftDirty,
  samplerOptions,
  type SamplerChoices,
  type SamplerModule,
  type SamplerOption,
} from "./samplerSetting";

export interface SamplerSelectProps {
  value: string;
  options: SamplerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}

export function WorkflowSamplerSetting({
  module,
  value,
  choices,
  loading,
  error,
  busy,
  onChange,
  Select,
}: {
  module: SamplerModule;
  /** The draft ("" = unset); without one the saved value is shown. */
  value?: string;
  choices: SamplerChoices | null;
  loading: boolean;
  /** ComfyUI could not be read: the dropdown still shows the current value. */
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  Select: (props: SamplerSelectProps) => ReactElement;
}) {
  if (!hasSamplerSetting(module)) return null;
  const saved = currentSampler(module);
  const draft = value === undefined ? saved : value.trim();
  const dirty = samplerDraftDirty(module, draft);
  const note = error
    ? "暂时读不到 ComfyUI 的采样器列表，只显示当前值。"
    : loading
      ? "正在读取 ComfyUI 的采样器列表…"
      : "1采和二段精修共用这个采样器；未设置时沿用方案包里的值。";
  // The saved value stays offered too, so switching back to it is one click.
  const options = samplerOptions(choices, draft);
  if (saved && !options.some((option) => option.value === saved)) options.push({ value: saved, label: saved });
  return (
    <div className={`workflow-module-sampler${dirty ? " is-dirty" : ""}`}>
      <span>采样器</span>
      <Select
        value={draft}
        options={options}
        onChange={(next) => { if (next !== draft) onChange(next); }}
        disabled={busy}
        ariaLabel="方案采样器"
      />
      {dirty && (
        <strong className="workflow-module-sampler-dirty">
          未保存（本方案仍是：{saved || "未设置"}）。点「保存」写入本方案，或「另存为新方案」。
        </strong>
      )}
      <small>{note}</small>
    </div>
  );
}
