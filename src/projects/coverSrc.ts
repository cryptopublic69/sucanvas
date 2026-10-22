// CANVAS-021: project-home covers on the Web come from /api/thumbnail, a small cached
// JPEG made on the server, instead of the original that /api/resource serves (often
// several MB). Same resource parameter and session check. Desktop asset URLs and any
// other URL are used as they are.
const RESOURCE = "/api/resource?";

export function coverThumbnailSrc(src: string): string {
  return src.startsWith(RESOURCE) ? `/api/thumbnail?${src.slice(RESOURCE.length)}` : src;
}
