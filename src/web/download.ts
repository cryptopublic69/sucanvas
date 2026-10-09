import { download } from "./bridge";
import { generatedMediaDownload } from "./mediaDownload";

export function downloadGeneratedMedia(content: Record<string, unknown>, kind: "video" | "image") {
  const media = generatedMediaDownload(content, kind);
  if (!media) throw new Error(`当前${kind === "video" ? "视频" : "图片"}缺少可下载的文件信息`);
  download(media.resource, media.filename);
}
