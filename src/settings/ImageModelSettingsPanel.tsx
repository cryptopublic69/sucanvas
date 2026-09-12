import type {
  WorkflowModuleRecord
} from "../CanvasNode";
import {
  SettingsSelect,
  h3DiffusionModelDisplayName
} from "../CanvasNode";

type ImageModelSettingsPanelProps = {
  selectedImageWorkflowModule: WorkflowModuleRecord | null;
  workflowModules: WorkflowModuleRecord[];
  setSelectedImageWorkflowModuleId: React.Dispatch<React.SetStateAction<string>>;
  setKrea2DiffusionModelName: React.Dispatch<React.SetStateAction<string>>;
  isKrea2DiffusionModelName: (value: string) => boolean;
  krea2DiffusionModelName: string;
  krea2DiffusionModelCatalogLoaded: boolean;
  krea2DiffusionModelOptions: string[];
};

export function ImageModelSettingsPanel({
  selectedImageWorkflowModule,
  workflowModules,
  setSelectedImageWorkflowModuleId,
  setKrea2DiffusionModelName,
  isKrea2DiffusionModelName,
  krea2DiffusionModelName,
  krea2DiffusionModelCatalogLoaded,
  krea2DiffusionModelOptions,
}: ImageModelSettingsPanelProps) {
  return (
    <section className="settings-pane model-settings-pane" aria-labelledby="image-model-settings-title">
      <div className="settings-pane-heading">
        <h3 id="image-model-settings-title">图片模型参数</h3>
        <p>每个图片生成方案独立保存基础模型；当前支持 Krea2 文生图与图像编辑。</p>
      </div>
      <div className="model-workflow-module-select">
        <span>编辑方案</span>
        <SettingsSelect
          value={selectedImageWorkflowModule?.id ?? ""}
          onChange={(value) => {
            const module = workflowModules.find((candidate) => (
              !candidate.deletedAt
              && candidate.capability === "image-generation"
              && candidate.id === value
            ));
            if (!module) return;
            setSelectedImageWorkflowModuleId(module.id);
            setKrea2DiffusionModelName(
              isKrea2DiffusionModelName(module.defaults.diffusionModelName)
                ? module.defaults.diffusionModelName
                : "",
            );
          }}
          ariaLabel="图片模型参数编辑方案"
          placeholder="没有可用图片方案"
          options={workflowModules.filter((module) => (
            !module.deletedAt && module.capability === "image-generation"
          )).map((module) => ({
            value: module.id,
            label: `${module.name} · ${module.revision}`,
          }))}
        />
      </div>
      <div className="model-workflow-module-select model-diffusion-model-select">
        <span>Krea2 基础模型</span>
        <SettingsSelect
          value={krea2DiffusionModelName}
          onChange={setKrea2DiffusionModelName}
          ariaLabel="Krea2 基础模型"
          placeholder={krea2DiffusionModelCatalogLoaded ? "Krea2 目录中没有可用模型" : "正在读取 ComfyUI 模型…"}
          disabled={!selectedImageWorkflowModule || !krea2DiffusionModelOptions.length}
          options={krea2DiffusionModelOptions.map((model) => ({
            value: model,
            label: h3DiffusionModelDisplayName(model),
          }))}
        />
        <small>仅显示 ComfyUI 中 Krea2 目录的 UNET 基础模型；保存后应用于当前图片方案、图像编辑及图片放大。</small>
      </div>
    </section>
  );
}
