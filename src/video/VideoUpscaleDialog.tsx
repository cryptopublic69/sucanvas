import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";
import { ModelParameterNumberInput } from "../CanvasNode";
import type { WorkflowModuleRecord } from "../CanvasNode";
import type { VideoUpscaleDraft } from "./videoUpscale";

export function VideoUpscaleDialog({ draft, setDraft, modules, submit }: {
  draft: VideoUpscaleDraft | null;
  setDraft: Dispatch<SetStateAction<VideoUpscaleDraft | null>>;
  modules: WorkflowModuleRecord[];
  submit: () => Promise<void>;
}) {
  useEffect(() => {
    if (!draft) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [Boolean(draft), setDraft]);
  if (!draft) return null;
  const selected = modules.find((module) => !module.deletedAt && module.capability === "video-upscale" && module.id === draft.workflowModuleId);
  return createPortal(
    <div className="project-dialog-backdrop" onMouseDown={() => setDraft(null)}>
      <form className="project-dialog video-regeneration-dialog video-upscale-dialog" onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="project-dialog-icon"><Sparkles size={21} /></div>
        <div className="video-upscale-dialog-heading"><h2>视频超分参数</h2><p>对“{draft.previewTitle}”执行超分，本次参数不修改工作流默认值。</p></div>
        {selected?.uiSchema.groups.map((group) => <section key={group.id}>
          <div className="video-regeneration-fields">
            {group.fields.map((field, index) => <label key={field.key}>{field.label}
              <ModelParameterNumberInput autoFocus={index === 0} min={field.min} max={field.max} step={field.step}
                value={draft.parameters[field.key] ?? field.default} ariaLabel={field.label}
                onChange={(value) => setDraft((current) => current && ({ ...current, parameters: { ...current.parameters, [field.key]: value } }))} />
            </label>)}
          </div>
          {group.note && <p className="video-regeneration-note">{group.note}</p>}
        </section>)}
        <div className="project-dialog-actions">
          <button type="button" className="dialog-cancel" onClick={() => setDraft(null)}>取消</button>
          <button type="submit" className="primary-button" disabled={!selected}><Sparkles size={13} />开始超分</button>
        </div>
      </form>
    </div>, document.body,
  );
}
