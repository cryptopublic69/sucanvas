import { useCallback, useRef, useState } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { comfyOutputFromContent, generationSnapshotFromContent, openComfyProgressSocket, recordAtCurrentFlowPosition } from "../CanvasNode";
import type { CanvasFlowNode, ComfySubmitResult, GenerationSnapshot, JsonObject, NodePatch, NodeRecord, PersistedComfyTask, WorkflowModuleDefaultMap, WorkflowModuleRecord } from "../CanvasNode";
import { videoUpscaleDefaults, videoUpscaleGenerationSnapshot, videoUpscaleModule, videoUpscaleParameterError } from "./videoUpscale";
import type { VideoUpscaleDraft, VideoUpscaleSnapshot } from "./videoUpscale";

type Dependencies = {
  nodesSnapshot: MutableRefObject<CanvasFlowNode[]>;
  modules: WorkflowModuleRecord[];
  defaults: WorkflowModuleDefaultMap;
  visibleIds: string[];
  setDefaults: Dispatch<SetStateAction<WorkflowModuleDefaultMap>>;
  serverUrl: MutableRefObject<string>;
  inputRoot: MutableRefObject<string>;
  ownedClients: MutableRefObject<Set<string>>;
  cancelledClients: MutableRefObject<Set<string>>;
  register: (nodeId: string, clientId: string) => void;
  unregister: (nodeId: string, clientId: string) => void;
  remember: (task: PersistedComfyTask) => void;
  forget: (clientId: string) => void;
  changeNode: (id: string, patch: NodePatch) => void;
  updatePlaceholder: (id: string | undefined, patch: JsonObject) => void;
  createPlaceholder: (options: { source: NodeRecord; clientId: string; snapshot: GenerationSnapshot; secondary: boolean; sourceGeneratorId: string; processing?: VideoUpscaleSnapshot }) => Promise<NodeRecord>;
  completePlaceholder: (id: string | undefined, title: string, content: JsonObject) => Promise<NodeRecord | null>;
  finalizePlaceholder: (node: NodeRecord, patch: JsonObject) => Promise<NodeRecord | null>;
  notice: (message: string) => void;
  reportError: (error: unknown) => void;
};

export function useVideoUpscale(deps: Dependencies) {
  const [draft, setDraft] = useState<VideoUpscaleDraft | null>(null);
  const preparing = useRef(new Set<string>());
  const configure = useCallback((previewId: string) => {
    const preview = deps.nodesSnapshot.current.find((node) => node.id === previewId)?.data.record;
    if (!preview || preview.kind !== "generated-video" || preview.content.generationPlaceholder === true) return;
    const module = videoUpscaleModule(deps.modules, deps.defaults, deps.visibleIds);
    if (!module) { deps.notice("没有可用的视频超分模块，请在设置的工作流方案中导入并启用"); return; }
    setDraft({ previewId, previewTitle: preview.title, workflowModuleId: module.id, parameters: videoUpscaleDefaults(module) });
  }, [deps.nodesSnapshot, deps.modules, deps.defaults, deps.visibleIds, deps.notice]);

  const execute = useCallback(async (previewId: string, configured?: VideoUpscaleDraft) => {
    if (preparing.current.has(previewId)) return;
    const node = deps.nodesSnapshot.current.find((candidate) => candidate.id === previewId);
    if (!node || node.data.record.kind !== "generated-video" || node.data.record.content.generationPlaceholder === true) return;
    const preview = recordAtCurrentFlowPosition(node);
    const source = comfyOutputFromContent(preview.content);
    if (!source) { deps.notice("当前预览缺少远程视频文件信息，无法执行超分"); return; }
    const module = configured
      ? deps.modules.find((candidate) => candidate.id === configured.workflowModuleId && !candidate.deletedAt && candidate.capability === "video-upscale" && deps.visibleIds.includes(candidate.id))
      : videoUpscaleModule(deps.modules, deps.defaults, deps.visibleIds);
    if (!module?.adapter.videoProcessing) { deps.notice("没有可用的视频超分模块，请在工作流方案中导入并启用"); return; }
    const parameters = configured?.parameters ?? videoUpscaleDefaults(module);
    const parameterError = videoUpscaleParameterError(module, parameters);
    if (parameterError) { deps.notice(parameterError); return; }
    const originalSnapshot = generationSnapshotFromContent(preview.content);
    const ratio = typeof preview.content.aspectRatio === "number" && preview.content.aspectRatio > 0
      ? preview.content.aspectRatio : preview.width / Math.max(1, preview.height - 38);
    const processing: VideoUpscaleSnapshot = {
      workflowModuleId: module.id, workflowModuleName: module.name, workflowModuleRevision: module.revision,
      outputNodeId: module.adapter.videoProcessing.outputNodeId, parameters,
      parameterLabels: Object.fromEntries(module.uiSchema.groups.flatMap((group) => group.fields.map((field) => [field.key, field.label]))),
      sourceVideoUrl: source.url, aspectRatio: ratio,
    };
    const snapshot = videoUpscaleGenerationSnapshot(originalSnapshot, processing);
    const sourceGeneratorId = typeof preview.content.sourceGeneratorId === "string" && preview.content.sourceGeneratorId ? preview.content.sourceGeneratorId : preview.id;
    const clientId = crypto.randomUUID();
    let placeholder: NodeRecord | undefined;
    let socket: WebSocket | null = null;
    let preserveTask = false;
    let submitted = false;
    preparing.current.add(previewId);
    try {
      placeholder = await deps.createPlaceholder({ source: preview, clientId, snapshot, secondary: true, sourceGeneratorId, processing });
      deps.ownedClients.current.add(clientId);
      deps.cancelledClients.current.delete(clientId);
      deps.remember({ clientId, nodeId: previewId, canvasId: preview.canvasId, snapshot, startedAt: Date.now(), kind: "video-upscale", sourceGeneratorId, placeholderNodeId: placeholder.id });
      deps.register(previewId, clientId);
      const update = (message: string, progress: number | null = null) => {
        if (deps.cancelledClients.current.has(clientId)) return;
        const latest = deps.nodesSnapshot.current.find((candidate) => candidate.id === previewId)?.data.record;
        if (latest) deps.changeNode(previewId, { content: { ...latest.content, status: "running", executionProgress: progress, validationMessage: message } });
        deps.updatePlaceholder(placeholder?.id, { status: "running", executionProgress: progress, validationMessage: message });
      };
      update("正在准备源视频并提交超分任务…");
      socket = await openComfyProgressSocket(clientId, deps.serverUrl.current);
      if (deps.cancelledClients.current.has(clientId)) throw new Error("ComfyUI 超分已取消");
      socket?.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "execution_start") update("正在执行视频超分…");
          else if (message.type === "executing" && message.data?.node) {
            const id = String(message.data.node);
            update(id === module.adapter.videoProcessing?.videoInput.nodeId ? "正在读取源视频…"
              : id === module.adapter.videoProcessing?.outputNodeId ? "正在保存超分视频…" : "正在执行视频超分…");
          } else if (message.type === "progress" && typeof message.data?.value === "number" && message.data?.max > 0) {
            update(`超分当前步骤：${message.data.value}/${message.data.max}`, Math.max(0, Math.min(100, message.data.value / message.data.max * 100)));
          }
        } catch { /* Ignore binary previews and unrelated messages. */ }
      });
      const onSubmitted = new Channel<null>();
      onSubmitted.onmessage = () => { submitted = true; update("超分任务已提交，等待 ComfyUI 处理…"); };
      const result = await invoke<ComfySubmitResult>("submit_comfyui_video_upscale", {
        onSubmitted,
        input: { serverUrl: deps.serverUrl.current, sourceServerUrl: preview.content.comfyServerUrl ?? "", inputRootPath: deps.inputRoot.current, workflowModuleId: module.id, clientId, source, parameters },
      });
      if (deps.cancelledClients.current.has(clientId)) throw new Error("ComfyUI 超分已取消");
      const output = result.outputs[0];
      if (!output) throw new Error("超分没有返回视频输出");
      await deps.completePlaceholder(placeholder.id, "超分预览", {
        videoUrl: output.url, originalName: output.filename, filename: output.filename, subfolder: output.subfolder, fileType: output.fileType,
        comfyPromptId: result.promptId, comfyServerUrl: deps.serverUrl.current, sourceGeneratorId, sourcePreviewId: previewId,
        seed: typeof preview.content.seed === "string" ? preview.content.seed : "", aspectRatio: ratio,
        generationSnapshot: snapshot, videoUpscale: processing, hasBeenPlayed: false,
        ...(typeof result.executionElapsedSeconds === "number" ? { generationElapsedSeconds: result.executionElapsedSeconds } : {}),
      });
      const latest = deps.nodesSnapshot.current.find((candidate) => candidate.id === previewId)?.data.record;
      if (latest) deps.changeNode(previewId, { content: { ...latest.content, status: "idle", executionProgress: null, validationMessage: "超分完成" } });
      deps.notice(result.cleanupWarning ? `超分完成；${result.cleanupWarning}` : "超分完成，结果已显示在右侧预览框");
    } catch (error) {
      const cancelled = deps.cancelledClients.current.has(clientId);
      const errorText = String(error);
      preserveTask = !cancelled && (submitted || errorText.includes("提交超分任务失败") || errorText.includes("解析超分响应失败") || errorText.includes("超分响应缺少"))
        && !errorText.includes("ComfyUI 超分失败") && !errorText.includes("没有视频输出");
      const message = cancelled ? "已取消视频超分" : preserveTask ? "超分任务状态暂未确认，保留占位并等待恢复结果…" : `超分失败：${errorText}`;
      const latest = deps.nodesSnapshot.current.find((candidate) => candidate.id === previewId)?.data.record;
      if (latest) deps.changeNode(previewId, { content: { ...latest.content, status: cancelled ? "cancelled" : preserveTask ? "running" : "invalid", executionProgress: null, validationMessage: message } });
      try { if (preserveTask) deps.updatePlaceholder(placeholder?.id, { status: "running", executionProgress: null, validationMessage: message });
      else if (placeholder) await deps.finalizePlaceholder(placeholder, { status: cancelled ? "cancelled" : preserveTask ? "running" : "invalid", executionProgress: null, validationMessage: message }); }
      catch (error) { preserveTask = true; deps.reportError(error); }
      if (!cancelled) deps.reportError(error);
      else deps.notice(message);
    } finally {
      socket?.close(); preparing.current.delete(previewId);
      deps.ownedClients.current.delete(clientId); deps.cancelledClients.current.delete(clientId);
      if (!preserveTask) deps.forget(clientId);
      deps.unregister(previewId, clientId);
    }
  }, [deps]);

  const submit = async () => {
    if (!draft) return;
    const module = deps.modules.find((module) => module.id === draft.workflowModuleId && !module.deletedAt && module.capability === "video-upscale");
    if (!module) { deps.notice("所选超分模块已缺失或被删除"); return; }
    const error = videoUpscaleParameterError(module, draft.parameters);
    if (error) { deps.notice(error); return; }
    // Remember the selected module; each ordinary click still uses its own defaults.
    deps.setDefaults((current) => ({ ...current, "video-upscale": module.id }));
    setDraft(null);
    await execute(draft.previewId, draft);
  };
  return { draft, setDraft, configure, execute, submit };
}
