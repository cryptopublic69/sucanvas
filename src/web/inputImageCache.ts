export type InputImagePreview = { src: string; url: string; width: number; height: number };
const previews = new Map<string, InputImagePreview>();
const pending = new Map<string, Promise<InputImagePreview>>();
const queue: Array<() => void> = [];
let active = 0;

function schedulePreview(src: string): Promise<InputImagePreview> {
  const pump = () => {
    while (active < 4 && queue.length) queue.shift()!();
  };
  return new Promise((resolve, reject) => {
    queue.push(() => {
      active++;
      void loadPreview(src).then(resolve, reject).finally(() => { active--; pump(); });
    });
    pump();
  });
}

export function peekInputImagePreview(src: string): InputImagePreview | undefined {
  return previews.get(src);
}

async function loadPreview(src: string): Promise<InputImagePreview> {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`图片加载失败 (${response.status})`);
  const blob = await response.blob();
  const originalUrl = URL.createObjectURL(blob);
  let retainedOriginal = false;
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => image.naturalWidth && image.naturalHeight
        ? resolve(image) : reject(new Error("图片尺寸无效"));
      image.onerror = () => reject(new Error("无法读取图片"));
      image.src = originalUrl;
    });
    const { naturalWidth: width, naturalHeight: height } = image;
    let compressed: Blob | null = null;
    // Preserve animation and vector content; static raster previews use a
    // bounded thumbnail while original dimensions and asset references remain.
    if (!/image\/(gif|svg\+xml)/i.test(blob.type)) {
      try {
        const scale = Math.min(1, 1280 / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (context) {
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          compressed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
        }
      } catch { /* Retain the original bytes if thumbnail encoding is unavailable. */ }
    }
    const url = compressed ? URL.createObjectURL(compressed) : originalUrl;
    retainedOriginal = !compressed;
    return { src, url, width, height };
  } finally {
    if (!retainedOriginal) URL.revokeObjectURL(originalUrl);
  }
}

export function requestInputImagePreview(src: string): Promise<InputImagePreview> {
  const cached = previews.get(src);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(src);
  if (existing) return existing;
  // Finish and cache an in-flight preview even if its node leaves the viewport.
  const request = schedulePreview(src).then((preview) => {
    previews.set(src, preview);
    return preview;
  }).finally(() => pending.delete(src));
  pending.set(src, request);
  return request;
}
