import type {
  WorkflowModuleRecord
} from "../CanvasNode";
import { VideoGenerationDefaultsEditor, videoGenerationDefaultsFromStorage } from "../CanvasNode";
type VideoGenerationDefaults = ReturnType<typeof videoGenerationDefaultsFromStorage>;

type VideoDefaultsSettingsPanelProps = {
  videoGenerationDefaultsDraft: VideoGenerationDefaults;
  workflowModules: WorkflowModuleRecord[];
  videoGenerationDefaultsByWorkflow: Record<string, VideoGenerationDefaults>;
  h3LoraOptions: string[];
  setVideoGenerationDefaultsDraft: React.Dispatch<React.SetStateAction<VideoGenerationDefaults>>;
};

export function VideoDefaultsSettingsPanel({
  videoGenerationDefaultsDraft,
  workflowModules,
  videoGenerationDefaultsByWorkflow,
  h3LoraOptions,
  setVideoGenerationDefaultsDraft,
}: VideoDefaultsSettingsPanelProps) {
  return (
    <section className="settings-pane video-defaults-settings-pane" aria-labelledby="video-defaults-settings-title">
      <div className="settings-pane-heading">
        <div>
          <h3 id="video-defaults-settings-title">视频默认参数</h3>
          <p>这里的参数会套用到之后新建的视频生成节点；已在画布上的节点不会被改动。</p>
        </div>
      </div>
      <VideoGenerationDefaultsEditor
        value={videoGenerationDefaultsDraft}
        workflowModules={workflowModules}
        workflowDefaultsByModule={videoGenerationDefaultsByWorkflow}
        h3LoraOptions={h3LoraOptions}
        onChange={(patch) => setVideoGenerationDefaultsDraft((current) => ({ ...current, ...patch }))}
      />
    </section>
  );
}
