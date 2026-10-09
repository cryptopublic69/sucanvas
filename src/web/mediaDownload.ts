export function generatedMediaDownload(content: Record<string, unknown>, kind: "video" | "image") {
  const asset = typeof content.assetPath === "string" ? content.assetPath : "";
  const url = content[kind === "video" ? "videoUrl" : "imageUrl"];
  // Imported desktop outputs may have only a ComfyUI URL, or an old drive
  // path. Download through the Web proxy without requiring a mapped directory.
  const resource = asset.startsWith("sucanvas://") ? asset
    : typeof url === "string" && /^(https?:\/\/|\/api\/)/.test(url) ? url : "";
  if (!resource) return null;
  const name = [content.originalName, content.filename].find((value) => typeof value === "string" && value.trim());
  const filename = typeof name === "string"
    ? name.split(/[\\/]/).pop()!.replace(/[<>:"|?*\x00-\x1f]/g, "_")
    : kind === "video" ? "生成视频.mp4" : "生成图片.png";
  return { resource, filename };
}
