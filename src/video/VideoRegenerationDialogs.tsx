import type { VideoRegenerationPresetCollection } from "./videoRegenerationPresets";
import { useEffect, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Dices, FileText, RotateCcw, Settings, StickyNote, X } from "lucide-react";
import { StyleLoraEditor } from "../StyleLoraEditor";
import { ModelParameterNumberInput, REF_IMAGE_SIZE_OPTIONS, VIDEO_REGENERATION_NUMBER_CONFIG, SettingsSelect, randomFixedSeed, h3DiffusionModelDisplayName, sameH3DiffusionModelName, h3LoraDisplayName, sameH3LoraName } from "../CanvasNode";
import type { VideoRegenerationDraft, VideoRegenerationPromptOption, WorkflowModuleRecord } from "../CanvasNode";

type VideoRegenerationDialogsProps = {
  videoRegenerationDraft: VideoRegenerationDraft | null;
  setVideoRegenerationDraft: Dispatch<SetStateAction<VideoRegenerationDraft | null>>;
  videoRegenerationDialogRef: RefObject<HTMLFormElement | null>;
  submitConfiguredVideoRegeneration: () => Promise<void>;
  videoRegenerationInformationOpen: boolean;
  setVideoRegenerationInformationOpen: Dispatch<SetStateAction<boolean>>;
  videoRegenerationWorkflowModule: WorkflowModuleRecord | undefined;
  videoRegenerationUsesSharedPrimarySteps: boolean;
  h3LoraOptions: string[];
  h3DiffusionModelOptions: string[];
  saveVideoRegenerationSettings: (asNew?: boolean) => void;
  presetCollection: VideoRegenerationPresetCollection;
  selectedPresetId: string;
  presetName: string;
  setPresetName: (name: string) => void;
  selectPreset: (id: string) => void;
  setDefaultPreset: () => void;
  deletePreset: () => void;
  movePreset: (id: string, direction: -1 | 1) => void;
  selectedVideoRegenerationPrompt: VideoRegenerationPromptOption | null;
};

export function VideoRegenerationDialogs({
  videoRegenerationDraft,
  setVideoRegenerationDraft,
  videoRegenerationDialogRef,
  submitConfiguredVideoRegeneration,
  videoRegenerationInformationOpen,
  setVideoRegenerationInformationOpen,
  videoRegenerationWorkflowModule,
  videoRegenerationUsesSharedPrimarySteps,
  h3LoraOptions,
  h3DiffusionModelOptions,
  saveVideoRegenerationSettings,
  selectedVideoRegenerationPrompt,
  presetCollection,
  selectedPresetId,
  presetName,
  setPresetName,
  selectPreset,
  setDefaultPreset,
  deletePreset,
  movePreset,
}: VideoRegenerationDialogsProps) {
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  useEffect(() => { setSecondaryExpanded(false); }, [videoRegenerationDraft?.previewId]);
  const dialogOpen = videoRegenerationDraft !== null;
  useEffect(() => {
    if (!dialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (videoRegenerationInformationOpen) {
        setVideoRegenerationInformationOpen(false);
        return;
      }
      const openMenu = videoRegenerationDialogRef.current?.querySelector<HTMLButtonElement>(
        "button[aria-haspopup][aria-expanded='true']",
      );
      if (openMenu) {
        openMenu.click();
        openMenu.focus();
        return;
      }
      setVideoRegenerationDraft(null);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [dialogOpen, videoRegenerationInformationOpen, videoRegenerationDialogRef, setVideoRegenerationInformationOpen, setVideoRegenerationDraft]);
  const selectedModel = videoRegenerationDraft?.diffusionModelName ?? "";
  const catalogModel = h3DiffusionModelOptions.find((model) => sameH3DiffusionModelName(model, selectedModel));
  const selectedPrimaryLora = videoRegenerationDraft?.loraName ?? "";
  const catalogPrimaryLora = h3LoraOptions.find((name) => sameH3LoraName(name, selectedPrimaryLora));
  const selectedSecondaryLora = videoRegenerationDraft?.secondaryLoraName ?? "";
  const catalogSecondaryLora = h3LoraOptions.find((name) => sameH3LoraName(name, selectedSecondaryLora));
  return (
    <>
      {videoRegenerationDraft && createPortal(
        <div
          className="project-dialog-backdrop"
          onMouseDown={() => setVideoRegenerationDraft(null)}
        >
          <form
            ref={videoRegenerationDialogRef}
            className="project-dialog video-regeneration-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              if (!videoRegenerationDraft.presetEditor) void submitConfiguredVideoRegeneration();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-dialog-icon">{videoRegenerationDraft.presetEditor ? <Settings size={21} /> : <RotateCcw size={21} />}</div>
            <div>
              <div className="video-preset-editor-title"><h2>{videoRegenerationDraft.presetEditor ? "预设编辑" : "视频生成"}</h2>{!videoRegenerationDraft.presetEditor && <button type="submit" className="primary-button video-regeneration-header-generate"><RotateCcw size={13} />生成</button>}{videoRegenerationDraft.presetEditor && <button type="button" className="video-details-toggle" aria-label="关闭预设编辑" title="关闭" onClick={() => setVideoRegenerationDraft(null)}><X size={18} /></button>}</div>
              <p>{videoRegenerationDraft.presetEditor ? "编辑并保存共用参数预设，供视频生成节点和 Alt＋重新生成使用。" : videoRegenerationDraft.generatorId ? "使用当前节点的提示词与参数，调整后点击生成。" : videoRegenerationDraft.useSnapshotSettings
                ? `正在使用“${videoRegenerationDraft.previewTitle}”生成时记录的参数、提示词与 Seed，不套用已保存设置。`
                : `提示词与 Seed 来自“${videoRegenerationDraft.previewTitle}”；参数优先套用默认预设，未设默认时使用生成快照。`}</p>
            </div>
            <section className="video-regeneration-presets" aria-label="重新生成参数预设">
              <div className="video-regeneration-preset-fields">
                <label>
                  预设槽位
                  <SettingsSelect
                    value={selectedPresetId}
                    options={presetCollection.presets.map((preset) => ({
                      value: preset.id,
                      label: `${preset.id === presetCollection.defaultPresetId ? "(Default) " : ""}${preset.name}`,
                      title: preset.name,
                    }))}
                    placeholder={presetCollection.presets.length ? "当前参数（未选择预设）" : "暂无预设，可保存当前参数"}
                    disabled={!presetCollection.presets.length}
                    onChange={selectPreset}
                    onMoveOption={movePreset}
                    ariaLabel="重新生成参数预设槽位"
                  />
                </label>
                <label>
                  预设名称
                  <input
                    value={presetName}
                    onChange={(event) => setPresetName(event.currentTarget.value)}
                    maxLength={60}
                    placeholder="输入预设名称"
                    aria-label="预设名称"
                  />
                </label>
              </div>
              <div className="video-regeneration-preset-actions">
                <button type="button" className="dialog-cancel" onClick={() => saveVideoRegenerationSettings()}>
                  {selectedPresetId ? "保存当前预设" : "保存为预设"}
                </button>
                <button type="button" className="dialog-cancel" onClick={() => saveVideoRegenerationSettings(true)}>
                  另存为新预设
                </button>
                <button type="button" className="dialog-cancel" onClick={setDefaultPreset}
                  disabled={!selectedPresetId || selectedPresetId === presetCollection.defaultPresetId}>
                  {selectedPresetId && selectedPresetId === presetCollection.defaultPresetId ? "已是默认" : "设为默认"}
                </button>
                <button type="button" className="dialog-cancel video-regeneration-preset-delete" onClick={deletePreset}
                  disabled={!selectedPresetId}>
                  删除预设
                </button>
              </div>
            </section>
            <div className="video-regeneration-fields">
              {!videoRegenerationDraft.presetEditor && <label className="video-regeneration-prompt-field">
                H3 模型
                <SettingsSelect
                  value={catalogModel ?? selectedModel}
                  options={[
                    ...(selectedModel && !catalogModel ? [{
                      value: selectedModel,
                      label: `${h3DiffusionModelDisplayName(selectedModel)}（当前目录未找到）`,
                      title: selectedModel,
                    }] : []),
                    ...h3DiffusionModelOptions.map((model) => ({
                      value: model,
                      label: h3DiffusionModelDisplayName(model),
                      title: model,
                    })),
                  ]}
                  onChange={(diffusionModelName) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    diffusionModelName,
                  }))}
                  ariaLabel="重新生成 H3 模型"
                />
              </label>}
              {!videoRegenerationDraft.presetEditor && <>
              <label className="video-regeneration-prompt-field">
                提示词版本
                <div className="video-regeneration-prompt-controls">
                  <SettingsSelect
                    value={videoRegenerationDraft.selectedPromptKey}
                    options={videoRegenerationDraft.promptOptions.map((option) => ({
                      value: option.key,
                      label: option.label,
                    }))}
                    onChange={(selectedPromptKey) => {
                      setVideoRegenerationInformationOpen(false);
                      setVideoRegenerationDraft((current) => current && ({
                        ...current,
                        selectedPromptKey,
                      }));
                    }}
                    ariaLabel="重新生成提示词版本"
                  />
                  <button
                    type="button"
                    className="video-regeneration-information-button"
                    onClick={() => setVideoRegenerationInformationOpen(true)}
                    title="查看当前提示词版本的备注"
                    aria-label="查看当前提示词版本的备注"
                  >
                    <StickyNote size={14} />
                    <span>查看备注</span>
                  </button>
                </div>
              </label>
              <label>
                Seed
                <div className="video-regeneration-seed">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={20}
                    value={videoRegenerationDraft.seed}
                    onChange={(event) => setVideoRegenerationDraft((current) => current && ({
                      ...current,
                      seed: event.currentTarget.value.replace(/\D/g, ""),
                    }))}
                    aria-label="重新生成 Seed"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    title="随机生成新 Seed"
                    aria-label="随机生成新 Seed"
                    onClick={() => setVideoRegenerationDraft((current) => {
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
              </>}
              {!videoRegenerationDraft.presetEditor && <label>
                时长（秒）
                <ModelParameterNumberInput
                  regenerationField="durationSeconds"
                  min={2}
                  max={15}
                  step={1}
                  value={videoRegenerationDraft.durationSeconds}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    durationSeconds: value,
                  }))}
                />
              </label>}
              <section className="video-regeneration-group" aria-label="1采参数">
                <header className="video-regeneration-group-header">
                  <h3>1采参数</h3>
              <div className="video-regeneration-header-lora">
                <SettingsSelect
                  title={selectedPrimaryLora || "不使用 LoRA"}
                  value={videoRegenerationDraft.loraBypassed ? "" : catalogPrimaryLora ?? selectedPrimaryLora}
                  ariaLabel="重新生成1采 LoRA"
                  options={[
                    { value: "", label: "不使用 LoRA" },
                    ...(selectedPrimaryLora && !catalogPrimaryLora ? [{
                      value: selectedPrimaryLora,
                      label: `${h3LoraDisplayName(selectedPrimaryLora)}（当前目录未找到）`,
                    }] : []),
                    ...h3LoraOptions.map((name) => ({ value: name, label: h3LoraDisplayName(name), title: name })),
                  ]}
                  onChange={(name) => setVideoRegenerationDraft((current) => current && ({
                    ...current, loraName: name || current.loraName, loraBypassed: !name,
                  }))}
                />
              </div>
<label className="video-regeneration-header-strength" aria-label="1采 LoRA 权重">
                <span>权重</span>
                <ModelParameterNumberInput
                  regenerationField="loraStrength"
                  min={0}
                  max={10}
                  step={0.01}
                  value={videoRegenerationDraft.loraStrength}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    loraStrength: value,
                  }))}
                />
              </label>
                </header>
                <div className="video-regeneration-fields video-regeneration-group-fields">
              <label>
                分辨率（MP）
                <ModelParameterNumberInput
                  regenerationField="primaryResolutionMegapixels"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={videoRegenerationDraft.primaryResolutionMegapixels}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryResolutionMegapixels: value,
                  }))}
                />
              </label>
              {videoRegenerationWorkflowModule?.bindings.primaryUpscaleNodeId?.trim() && <label>
                放大倍率（×）
                <ModelParameterNumberInput
                  regenerationField="primaryUpscaleFactor"
                  min={1}
                  max={4}
                  step={0.1}
                  value={videoRegenerationDraft.primaryUpscaleFactor}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryUpscaleFactor: value,
                  }))}
                />
              </label>}
              <label>
                Video Steps
                <ModelParameterNumberInput
                  regenerationField="primaryVideoSteps"
                  min={1}
                  max={1000}
                  step={1}
                  value={videoRegenerationDraft.primaryVideoSteps}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryVideoSteps: value,
                    primaryAudioSteps: videoRegenerationUsesSharedPrimarySteps
                      ? value
                      : current.primaryAudioSteps,
                  }))}
                />
              </label>
              {!videoRegenerationUsesSharedPrimarySteps && <label>
                Audio Steps
                <ModelParameterNumberInput
                  regenerationField="primaryAudioSteps"
                  min={1}
                  max={1000}
                  step={1}
                  value={videoRegenerationDraft.primaryAudioSteps}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryAudioSteps: value,
                  }))}
                />
              </label>}
              <label className="video-regeneration-row-start">
                亮度
                <ModelParameterNumberInput
                  regenerationField="primaryBrightness"
                  min={0}
                  max={3}
                  step={0.01}
                  value={videoRegenerationDraft.primaryBrightness}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryBrightness: value,
                  }))}
                />
              </label>
              <label>
                对比度
                <ModelParameterNumberInput
                  regenerationField="primaryContrast"
                  min={0}
                  max={3}
                  step={0.01}
                  value={videoRegenerationDraft.primaryContrast}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primaryContrast: value,
                  }))}
                />
              </label>
              <label>
                饱和度
                <ModelParameterNumberInput
                  regenerationField="primarySaturation"
                  min={0}
                  max={3}
                  step={0.01}
                  value={videoRegenerationDraft.primarySaturation}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({
                    ...current,
                    primarySaturation: value,
                  }))}
                />
              </label>
                </div>
              </section>
              <section className="video-regeneration-group" aria-label="2采参数">
                <header className="video-regeneration-group-header video-regeneration-secondary-header">
                  <h3><button type="button" className="video-regeneration-group-toggle" aria-expanded={secondaryExpanded} aria-controls="video-regeneration-secondary-fields" onClick={() => setSecondaryExpanded((expanded) => !expanded)}>{secondaryExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}2采参数</button></h3>
              <div className="video-regeneration-header-lora">
                <SettingsSelect
                  title={selectedSecondaryLora || "不使用 LoRA"}
                  value={videoRegenerationDraft.secondaryLoraBypassed ? "" : catalogSecondaryLora ?? selectedSecondaryLora}
                  ariaLabel="重新生成2采 LoRA"
                  options={[
                    { value: "", label: "不使用 LoRA" },
                    ...(selectedSecondaryLora && !catalogSecondaryLora ? [{
                      value: selectedSecondaryLora,
                      label: `${h3LoraDisplayName(selectedSecondaryLora)}（当前目录未找到）`,
                    }] : []),
                    ...h3LoraOptions.map((name) => ({ value: name, label: h3LoraDisplayName(name), title: name })),
                  ]}
                  onChange={(name) => setVideoRegenerationDraft((current) => current && ({
                    ...current, secondaryLoraName: name || current.secondaryLoraName, secondaryLoraBypassed: !name,
                  }))}
                />
              </div>
<label className="video-regeneration-header-strength" aria-label="2采 LoRA 权重">
                <span>权重</span>
                <ModelParameterNumberInput
                  regenerationField="secondaryLoraStrength"
                  {...VIDEO_REGENERATION_NUMBER_CONFIG.secondaryLoraStrength}
                  value={videoRegenerationDraft.secondaryLoraStrength}
                  onChange={(value) => setVideoRegenerationDraft((current) => current && ({ ...current, secondaryLoraStrength: value }))}
                />
              </label>
                </header>
                {secondaryExpanded && <div id="video-regeneration-secondary-fields" className="video-regeneration-fields video-regeneration-group-fields">
              {([
                ["secondaryResolutionMegapixels", "分辨率（MP）"],
                ["secondarySchedulerSteps", "Steps"],
                ["secondaryBrightness", "亮度"],
                ["secondaryContrast", "对比度"],
                ["secondarySaturation", "饱和度"],
              ] as const).map(([field, label]) => (
                <label key={field} className={field === "secondaryBrightness" ? "video-regeneration-row-start" : undefined}>
                  {label}
                  <ModelParameterNumberInput
                    regenerationField={field}
                    {...VIDEO_REGENERATION_NUMBER_CONFIG[field]}
                    value={videoRegenerationDraft[field]}
                    onChange={(value) => setVideoRegenerationDraft((current) => current && ({ ...current, [field]: value }))}
                  />
                </label>
              ))}
                </div>}
              </section>
              <section className="video-regeneration-group video-regeneration-shared-group" aria-label="共用设置">
                <h3>共用设置</h3>
                <div className="video-regeneration-fields video-regeneration-group-fields">
              <fieldset className="video-regeneration-ref-mode">
                <legend>参考图模式</legend>
                <div>
                  {REF_IMAGE_SIZE_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={videoRegenerationDraft.refImageSize === option ? "is-active" : ""}
                      onClick={() => setVideoRegenerationDraft((current) => current && ({
                        ...current,
                        refImageSize: option,
                      }))}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </fieldset>
            <div className="video-regeneration-style-loras">
              <StyleLoraEditor
                renderStrengthInput={(props) => <ModelParameterNumberInput {...props} min={0} max={10} step={0.01} />}
                slots={videoRegenerationDraft.styleLoras}
                options={h3LoraOptions}
                hasSecondStage={Boolean(videoRegenerationWorkflowModule?.adapter.bindings.livePreviewNodeId)}
                onChange={(styleLoras) => setVideoRegenerationDraft((current) => current && ({ ...current, styleLoras }))}
              />
            </div>
                </div>
              </section>
            </div>

          </form>
        </div>,
        document.body,
      )}
      {videoRegenerationInformationOpen && videoRegenerationDraft && createPortal(
        <div
          className="expanded-editor-backdrop"
          onMouseDown={() => setVideoRegenerationInformationOpen(false)}
        >
          <section
            className="expanded-editor-dialog is-prompt-version is-readonly"
            role="dialog"
            aria-modal="true"
            aria-label="重新生成提示词与备注"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="expanded-editor-header">
              <span className="node-kind-icon"><FileText size={15} /></span>
              <div>
                <strong>{selectedVideoRegenerationPrompt?.label ?? "提示词版本"}</strong>
                <span>当前选择版本 · 只读</span>
              </div>
              <button
                type="button"
                onClick={() => setVideoRegenerationInformationOpen(false)}
                title="关闭"
                aria-label="关闭提示词与备注查看窗口"
              >
                <X size={17} />
              </button>
            </header>
            <div className="expanded-prompt-layout">
              <section className="expanded-prompt-pane is-prompt">
                <header>
                  <strong>提示词</strong>
                  <span>{(selectedVideoRegenerationPrompt?.prompt ?? "").length.toLocaleString()} 字符</span>
                </header>
                <textarea
                  className="expanded-text-editor"
                  value={selectedVideoRegenerationPrompt?.prompt ?? ""}
                  readOnly
                  spellCheck={false}
                  placeholder="未记录提示词"
                  aria-label="当前提示词版本的提示词，只读"
                />
              </section>
              <section className="expanded-prompt-pane is-information">
                <header>
                  <strong>备注</strong>
                  <span>{(selectedVideoRegenerationPrompt?.information ?? "").length.toLocaleString()} 字符</span>
                </header>
                <textarea
                  className="expanded-text-editor"
                  value={selectedVideoRegenerationPrompt?.information ?? ""}
                  readOnly
                  spellCheck={false}
                  placeholder="该提示词版本未填写备注"
                  aria-label="当前提示词版本的备注，只读"
                />
              </section>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
