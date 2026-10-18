// Video preview layout shared by generated videos, the uploaded-asset on-load correction and web uploads.
export const MATERIAL_NODE_LAYOUT_VERSION = 3;
export const MATERIAL_NOTE_HEIGHT = 37;
export const MEDIA_NODE_CHROME_HEIGHT = 73 + MATERIAL_NOTE_HEIGHT;
export const GENERATED_VIDEO_PREVIEW_WIDTH = 420;
export const GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH = 300;

export function generatedVideoPreviewWidthForRatio(aspectRatio: number): number {
  return aspectRatio < 1
    ? GENERATED_VIDEO_PORTRAIT_PREVIEW_WIDTH
    : GENERATED_VIDEO_PREVIEW_WIDTH;
}

export function mediaNodeHeightForAspectRatio(width: number, aspectRatio: number): number {
  return Math.min(
    2400,
    Math.max(180, width / aspectRatio + MEDIA_NODE_CHROME_HEIGHT),
  );
}

// Uploaded videos are framed like generated ones: a fixed width per orientation, never their pixel size.
export function videoAssetLayout(naturalWidth: number, naturalHeight: number) {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) return null;
  const aspectRatio = naturalWidth / naturalHeight;
  const width = generatedVideoPreviewWidthForRatio(aspectRatio);
  return {
    width,
    height: mediaNodeHeightForAspectRatio(width, aspectRatio),
    content: { aspectRatio, naturalWidth, naturalHeight, materialNodeLayoutVersion: MATERIAL_NODE_LAYOUT_VERSION },
  };
}
