import type { ComfyOutputFile, JsonObject, NodeRecord } from "../CanvasNode";

// Must match the extensions accepted by video_upscale.rs before a job is submitted.
const UPSCALE_VIDEO_EXTENSION = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;
// Web imports live under the ComfyUI input or output root and are readable through /view.
const COMFY_RESOURCE = /^sucanvas-(input|output):\/\/(.+)$/;

function comfyOutputFromContent(content: JsonObject): ComfyOutputFile | null {
  const filename = typeof content.filename === "string" ? content.filename : "";
  const subfolder = typeof content.subfolder === "string" ? content.subfolder : "";
  const fileType = typeof content.fileType === "string" ? content.fileType : "output";
  const url = typeof content.videoUrl === "string"
    ? content.videoUrl
    : typeof content.imageUrl === "string" ? content.imageUrl : "";
  return filename && url ? { filename, subfolder, fileType, url } : null;
}

type UploadedVideoSource = { source: ComfyOutputFile; reason: "" } | { source: null; reason: string };

function uploadedVideoSource(content: JsonObject): UploadedVideoSource {
  const assetPath = typeof content.assetPath === "string" ? content.assetPath : "";
  if (!assetPath) return { source: null, reason: "该视频缺少文件路径，无法超分" };
  const match = COMFY_RESOURCE.exec(assetPath);
  const segments = match ? match[2].split("/") : [];
  if (!match || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return { source: null, reason: "该视频不在 ComfyUI 输入或输出目录中（例如尚未迁移的旧素材），无法超分" };
  }
  const filename = segments[segments.length - 1];
  if (!UPSCALE_VIDEO_EXTENSION.test(filename)) {
    return { source: null, reason: "该视频格式不支持超分，仅支持 mp4、mov、mkv、webm、avi、m4v" };
  }
  return {
    source: { filename, subfolder: segments.slice(0, -1).join("/"), fileType: match[1], url: assetPath },
    reason: "",
  };
}

function videoUpscaleSourceFromRecord(record: Pick<NodeRecord, "kind" | "content">): ComfyOutputFile | null {
  if (record.kind === "generated-video") return comfyOutputFromContent(record.content);
  if (record.kind === "video") return uploadedVideoSource(record.content).source;
  return null;
}

// Empty when the record can be upscaled; otherwise the explanation shown on the disabled button.
function videoUpscaleSourceUnavailableReason(record: Pick<NodeRecord, "kind" | "content">): string {
  if (record.kind === "generated-video") {
    return comfyOutputFromContent(record.content) ? "" : "当前预览缺少远程视频文件信息，无法执行超分";
  }
  if (record.kind === "video") return uploadedVideoSource(record.content).reason;
  return "该节点不是视频，无法超分";
}

export { comfyOutputFromContent, videoUpscaleSourceFromRecord, videoUpscaleSourceUnavailableReason };
