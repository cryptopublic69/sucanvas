// Generated-image node layout from the final image's real pixel size (CANVAS-036).
// A result is shaped when it arrives, before its node is written: below zoom 0.35 the canvas only renders
// overview cards, so the full node's <img> onLoad correction can't be relied on, and a package whose
// output size isn't known up front (image edit: the size follows the input) would keep its placeholder shape.
export const GENERATED_IMAGE_CHROME_HEIGHT = 38;
export const GENERATED_IMAGE_PREVIEW_LAYOUT_VERSION = 2;

export type NaturalSize = { width: number; height: number };

export function generatedImageNodeHeight(width: number, aspectRatio: number): number {
  return Math.min(
    2400,
    Math.max(180, width / aspectRatio + GENERATED_IMAGE_CHROME_HEIGHT),
  );
}

export function generatedImageLayout(naturalWidth: number, naturalHeight: number, nodeWidth: number) {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) return null;
  const aspectRatio = naturalWidth / naturalHeight;
  return {
    width: nodeWidth,
    height: generatedImageNodeHeight(nodeWidth, aspectRatio),
    content: {
      aspectRatio,
      naturalWidth,
      naturalHeight,
      generatedImagePreviewLayoutVersion: GENERATED_IMAGE_PREVIEW_LAYOUT_VERSION,
    },
  };
}

// An image result without a saved ratio: read the image's own size and return the node's final shape.
// Content that already has a ratio (re-opened, hand-resized) is left as it is. If the size can't be read,
// the content is returned unchanged and the full node's on-load correction stays the fallback.
export async function withGeneratedImageLayout<T extends Record<string, unknown>>(
  content: T,
  nodeWidth: number,
  measure: (url: string) => Promise<NaturalSize>,
): Promise<{ content: T; width?: number; height?: number }> {
  const url = typeof content.imageUrl === "string" ? content.imageUrl : "";
  if (!url || typeof content.aspectRatio === "number") return { content };
  try {
    const size = await measure(url);
    const layout = generatedImageLayout(size.width, size.height, nodeWidth);
    if (!layout) return { content };
    return { content: { ...content, ...layout.content }, width: layout.width, height: layout.height };
  } catch {
    return { content };
  }
}

// The browser's own decode of the result URL (the node's <img> then reuses the cached file).
export function measureImageUrl(url: string, timeoutMs = 15000): Promise<NaturalSize> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.src = "";
      reject(new Error("读取图片尺寸超时"));
    }, timeoutMs);
    image.decoding = "async";
    image.onload = () => {
      clearTimeout(timer);
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve({ width: image.naturalWidth, height: image.naturalHeight });
      else reject(new Error("图片没有可用的尺寸信息"));
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error("无法读取图片尺寸"));
    };
    image.src = url;
  });
}
