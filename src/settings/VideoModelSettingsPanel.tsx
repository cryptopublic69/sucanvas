import type {
  WorkflowModuleRecord
} from "../CanvasNode";
import {
  ModelParameterNumberInput,
  SettingsSelect,
  h3DiffusionModelDisplayName, h3LoraPreferenceFromStorage, h3ModelParametersFromStorage
} from "../CanvasNode";
type H3ModelParameters = ReturnType<typeof h3ModelParametersFromStorage>;
type H3LoraPreference = ReturnType<typeof h3LoraPreferenceFromStorage>;

type VideoModelSettingsPanelProps = {
  selectedWorkflowModule: WorkflowModuleRecord | null;
  workflowModules: WorkflowModuleRecord[];
  setSelectedWorkflowModuleId: React.Dispatch<React.SetStateAction<string>>;
  setH3DiffusionModelName: React.Dispatch<React.SetStateAction<string>>;
  setH3ModelParametersDraft: React.Dispatch<React.SetStateAction<H3ModelParameters>>;
  workflowUsesSharedPrimarySteps: (workflowModule: WorkflowModuleRecord | undefined) => boolean;
  setH3LoraPreference: React.Dispatch<React.SetStateAction<H3LoraPreference>>;
  h3DiffusionModelName: string;
  h3DiffusionModelCatalogLoaded: boolean;
  h3DiffusionModelOptions: string[];
  h3ModelParametersDraft: H3ModelParameters;
};

export function VideoModelSettingsPanel({
  selectedWorkflowModule,
  workflowModules,
  setSelectedWorkflowModuleId,
  setH3DiffusionModelName,
  setH3ModelParametersDraft,
  workflowUsesSharedPrimarySteps,
  setH3LoraPreference,
  h3DiffusionModelName,
  h3DiffusionModelCatalogLoaded,
  h3DiffusionModelOptions,
  h3ModelParametersDraft,
}: VideoModelSettingsPanelProps) {
  return (
    <section className="settings-pane model-settings-pane" aria-labelledby="model-settings-title">
      <div className="settings-pane-heading">
        <h3 id="model-settings-title">视频模型参数</h3>
        <p>参数独立保存在所选工作流方案中，不会影响其他并存方案。</p>
      </div>
      <div className="model-workflow-module-select">
        <span>编辑方案</span>
        <SettingsSelect
          value={selectedWorkflowModule?.capability === "video-generation" ? selectedWorkflowModule.id : ""}
          onChange={(value) => {
            const module = workflowModules.find((candidate) => candidate.id === value);
            if (!module) return;
            setSelectedWorkflowModuleId(module.id);
            setH3DiffusionModelName(module.defaults.diffusionModelName);
            setH3ModelParametersDraft({
              primaryVideoSteps: module.defaults.primaryVideoSteps,
              primaryAudioSteps: workflowUsesSharedPrimarySteps(module)
                ? module.defaults.primaryVideoSteps
                : module.defaults.primaryAudioSteps,
              secondarySchedulerSteps: module.defaults.secondarySchedulerSteps,
              primaryUpscaleFactor: module.defaults.primaryUpscaleFactor,
              primaryBrightness: module.defaults.primaryBrightness,
              primaryContrast: module.defaults.primaryContrast,
              primarySaturation: module.defaults.primarySaturation,
              secondaryBrightness: module.defaults.secondaryBrightness,
              secondaryContrast: module.defaults.secondaryContrast,
              secondarySaturation: module.defaults.secondarySaturation,
            });
            setH3LoraPreference((current) => ({
              ...current,
              loraName: module.defaults.loraName,
              loraStrength: module.defaults.loraStrength,
            }));
          }}
          ariaLabel="模型参数编辑方案"
          placeholder="没有可用方案"
          options={workflowModules.filter((module) => (
            !module.deletedAt
            && module.capability === "video-generation"
            && module.variant !== "text-to-video"
          )).map((module) => ({
            value: module.id,
            label: `${module.name} · ${module.revision}`,
          }))}
        />
      </div>
      <div className="model-workflow-module-select model-diffusion-model-select">
        <span>MiniMax H3 基础模型</span>
        <SettingsSelect
          value={h3DiffusionModelName}
          onChange={setH3DiffusionModelName}
          ariaLabel="MiniMax H3 基础模型"
          placeholder={h3DiffusionModelCatalogLoaded ? "MinimaxH3 目录中没有可用模型" : "正在读取 ComfyUI 模型…"}
          disabled={!h3DiffusionModelOptions.length}
          options={h3DiffusionModelOptions.map((model) => ({
            value: model,
            label: h3DiffusionModelDisplayName(model),
          }))}
        />
        <small>来自 ComfyUI 的 models/diffusion_models/MinimaxH3 目录，保存后应用于当前工作流方案。</small>
      </div>
      <section className="h3-model-parameters" aria-label="H3 模型参数">
        {selectedWorkflowModule?.uiSchema.groups.filter((group) => group.fields.some((field) => (
          field.key !== "primaryVideoSteps"
          && field.key !== "secondarySchedulerSteps"
          && (field.key !== "primaryAudioSteps" || !workflowUsesSharedPrimarySteps(selectedWorkflowModule))
        ))).map((group, groupIndex) => (
          <div className="h3-model-parameter-group" key={group.id}>
            <strong>{group.title}</strong>
            <div className="h3-model-parameters-grid">
              {group.fields.filter((field) => (
                field.key !== "primaryVideoSteps"
                && field.key !== "secondarySchedulerSteps"
                && (field.key !== "primaryAudioSteps" || !workflowUsesSharedPrimarySteps(selectedWorkflowModule))
              )).map((field, fieldIndex) => (
                <label key={field.key}>
                  {field.label}
                  <ModelParameterNumberInput
                    autoFocus={groupIndex === 0 && fieldIndex === 0}
                    min={field.minKey
                      ? h3ModelParametersDraft[field.minKey] || field.min
                      : field.min}
                    max={field.max}
                    step={field.step}
                    value={h3ModelParametersDraft[field.key]}
                    onChange={(value) => setH3ModelParametersDraft((current) => ({
                      ...current,
                      [field.key]: value,
                    }))}
                  />
                </label>
              ))}
            </div>
            {group.id !== "sampling-steps" && group.note && <small className="h3-model-parameters-note">{group.note}</small>}
          </div>
        ))}
      </section>
    </section>
  );
}
