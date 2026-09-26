import type { Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { Dices, Sparkles } from "lucide-react";
import { ModelParameterNumberInput, REF_IMAGE_SIZE_OPTIONS, randomFixedSeed } from "../CanvasNode";
import type { SecondarySampleDraft } from "../CanvasNode";

type SecondarySampleDialogProps = {
  secondarySampleDraft: SecondarySampleDraft | null;
  setSecondarySampleDraft: Dispatch<SetStateAction<SecondarySampleDraft | null>>;
  secondarySampleDialogRef: RefObject<HTMLFormElement | null>;
  submitConfiguredSecondarySample: () => Promise<void>;
};

export function SecondarySampleDialog({
  secondarySampleDraft,
  setSecondarySampleDraft,
  secondarySampleDialogRef,
  submitConfiguredSecondarySample,
}: SecondarySampleDialogProps) {
  return (
    <>
      {secondarySampleDraft && createPortal(
        <div
          className="project-dialog-backdrop"
          onMouseDown={() => setSecondarySampleDraft(null)}
        >
          <form
            ref={secondarySampleDialogRef}
            className="project-dialog video-regeneration-dialog secondary-sample-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitConfiguredSecondarySample();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon"><Sparkles size={21} /></div>
            <div>
              <h2>调整2采参数</h2>
              <p>默认使用“{secondarySampleDraft.previewTitle}”当前可用的2采设置，只覆盖下列项目。</p>
            </div>
            <div className="video-regeneration-fields">
              <label>
                Seed
                <div className="video-regeneration-seed">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={20}
                    value={secondarySampleDraft.seed}
                    onChange={(event) => setSecondarySampleDraft((current) => current && ({
                      ...current,
                      seed: event.currentTarget.value.replace(/\D/g, ""),
                    }))}
                    aria-label="2采 Seed"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    title="点击色子随机生成新 Seed"
                    aria-label="随机生成新 Seed"
                    onClick={() => setSecondarySampleDraft((current) => {
                      if (!current) return current;
                      let seed = randomFixedSeed();
                      while (seed === current.seed) seed = randomFixedSeed();
                      return { ...current, seed };
                    })}
                  >
                    <Dices size={14} />
                  </button>
                </div>
              </label>
              <label>
                2采分辨率（MP）
                <ModelParameterNumberInput
                  secondarySampleField="secondaryResolutionMegapixels"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={secondarySampleDraft.secondaryResolutionMegapixels}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondaryResolutionMegapixels: value,
                  }))}
                />
              </label>
              <label>
                2采 LoRA 强度
                <ModelParameterNumberInput
                  secondarySampleField="secondaryLoraStrength"
                  min={0}
                  max={10}
                  step={0.01}
                  value={secondarySampleDraft.secondaryLoraStrength}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondaryLoraStrength: value,
                  }))}
                />
              </label>
              <label>
                Scheduler Steps
                <ModelParameterNumberInput
                  secondarySampleField="secondarySchedulerSteps"
                  min={1}
                  max={10000}
                  step={1}
                  value={secondarySampleDraft.secondarySchedulerSteps}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondarySchedulerSteps: value,
                  }))}
                />
              </label>
              <label>
                亮度
                <ModelParameterNumberInput
                  secondarySampleField="secondaryBrightness"
                  min={0}
                  max={3}
                  step={0.05}
                  value={secondarySampleDraft.secondaryBrightness}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondaryBrightness: value,
                  }))}
                />
              </label>
              <label>
                对比度
                <ModelParameterNumberInput
                  secondarySampleField="secondaryContrast"
                  min={0}
                  max={3}
                  step={0.05}
                  value={secondarySampleDraft.secondaryContrast}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondaryContrast: value,
                  }))}
                />
              </label>
              <label>
                饱和度
                <ModelParameterNumberInput
                  secondarySampleField="secondarySaturation"
                  min={0}
                  max={3}
                  step={0.05}
                  value={secondarySampleDraft.secondarySaturation}
                  onChange={(value) => setSecondarySampleDraft((current) => current && ({
                    ...current,
                    secondarySaturation: value,
                  }))}
                />
              </label>
              <fieldset className="video-regeneration-ref-mode">
                <legend>参考图模式</legend>
                <div>
                  {REF_IMAGE_SIZE_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={secondarySampleDraft.refImageSize === option ? "is-active" : ""}
                      onClick={() => setSecondarySampleDraft((current) => current && ({
                        ...current,
                        refImageSize: option,
                      }))}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
            <p className="video-regeneration-note">
              Seed 默认保持原视频数值，点击色子才会随机更换。2采 LoRA 强度为 0 时不使用 LoRA，其余提示词、素材、模型及 LoRA 文件保持原2采逻辑。
            </p>
            <div className="project-dialog-actions">
              <button type="button" className="dialog-cancel" onClick={() => setSecondarySampleDraft(null)}>
                取消
              </button>
              <button type="submit" className="primary-button">
                <Sparkles size={13} />
                开始2采
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </>
  );
}
