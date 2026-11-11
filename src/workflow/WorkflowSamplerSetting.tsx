// CANVAS-039: the sampler dropdown of a scheme on the settings page (「工作流方案」). Drawn only
// for a package that declares sampler nodes; the choice is saved at once by the caller.
import type { ReactElement } from "react";
import {
  currentSampler,
  hasSamplerSetting,
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
  choices,
  loading,
  error,
  busy,
  onChange,
  Select,
}: {
  module: SamplerModule;
  choices: SamplerChoices | null;
  loading: boolean;
  /** ComfyUI could not be read: the dropdown still shows the current value. */
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  Select: (props: SamplerSelectProps) => ReactElement;
}) {
  if (!hasSamplerSetting(module)) return null;
  const current = currentSampler(module);
  const note = error
    ? "暂时读不到 ComfyUI 的采样器列表，只显示当前值。"
    : loading
      ? "正在读取 ComfyUI 的采样器列表…"
      : "1采和二段精修共用这个采样器；未设置时沿用方案包里的值。";
  return (
    <div className="workflow-module-sampler">
      <span>采样器</span>
      <Select
        value={current}
        options={samplerOptions(choices, current)}
        onChange={(value) => { if (value !== current) onChange(value); }}
        disabled={busy}
        ariaLabel="方案采样器"
      />
      <small>{note}</small>
    </div>
  );
}
