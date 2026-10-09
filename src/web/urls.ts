export function downloadFilename(resource: string, suggested?: string): string {
  let name = suggested?.trim();
  if (!name) {
    try {
      const url = new URL(resource, "http://localhost");
      name = url.searchParams.get("downloadName") || url.searchParams.get("filename") || url.searchParams.get("resource") || (url.protocol.startsWith("http") ? decodeURIComponent(url.pathname) : resource);
    } catch { name = resource; }
  }
  return name.split(/[\\/]/).pop()?.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "download";
}

export function webApiUrl(value: string, from: string, to: string): string {
  if (!from || from === to) return value;
  const source = from.replace(/\/$/, "");
  const destination = to.replace(/\/$/, "");
  const tail = value.startsWith(source) ? value.slice(source.length) : "";
  if (!/^\/api\/(comfy|resource)(?:[/?]|$)/.test(tail)) return value;
  return destination + tail;
}

export function webApiUrls<T>(value: T, from: string, to: string): T {
  if (!from || from === to) return value;
  if (typeof value === "string") return webApiUrl(value, from, to) as T;
  if (Array.isArray(value)) return value.map((item) => webApiUrls(item, from, to)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, webApiUrls(item, from, to)])) as T;
  }
  return value;
}
