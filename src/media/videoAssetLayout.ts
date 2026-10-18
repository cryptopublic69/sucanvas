// Layout of uploaded image/video asset nodes, shared by the on-load correction and web uploads.
export const MATERIAL_NODE_LAYOUT_VERSION = 3;
export const MATERIAL_NOTE_HEIGHT = 37;
export const MEDIA_NODE_CHROME_HEIGHT = 73 + MATERIAL_NOTE_HEIGHT;

export function mediaNodeHeightForAspectRatio(width: number, aspectRatio: number): number {
  return Math.min(
    2400,
    Math.max(180, width / aspectRatio + MEDIA_NODE_CHROME_HEIGHT),
  );
}

// The size a video asset node settles on once its natural size is known; null when it is unusable.
export function videoAssetLayout(width: number, naturalWidth: number, naturalHeight: number) {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) return null;
  const aspectRatio = naturalWidth / naturalHeight;
  return {
    width,
    height: mediaNodeHeightForAspectRatio(width, aspectRatio),
    content: { aspectRatio, naturalWidth, naturalHeight, materialNodeLayoutVersion: MATERIAL_NODE_LAYOUT_VERSION },
  };
}
