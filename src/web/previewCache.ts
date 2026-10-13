export function versionedPreviewUrl(src: string, promptId: string, origin = window.location.origin): string {
  if (!src || !promptId) return src;
  try {
    const url = new URL(src, origin);
    url.searchParams.set("infinite_canvas_prompt", promptId);
    return url.toString();
  } catch {
    return src;
  }
}
