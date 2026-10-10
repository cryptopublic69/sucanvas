// Vite uses this module only for --mode web; desktop keeps the native APIs.
import type { OpenDialogOptions, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { downloadFilename, webApiUrl, webApiUrls } from "./urls";
const devBackend = import.meta.env.DEV ? import.meta.env.SUCANVAS_WEB_DEV_BACKEND ?? "" : "";
let serverOrigin = devBackend;
type DragDropEvent =
  | { type: "enter" | "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "leave" };

type Event<T> = { event: string; id: number; payload: T };
type Listener = (event: Event<unknown>) => void;
const listeners = new Map<string, Set<Listener>>();
const channels = new Map<string, Channel<unknown>>();
let events: EventSource | null = null;
let eventReady: Promise<void> | null = null;

export function reportWebError(error: unknown) {
  window.dispatchEvent(new CustomEvent("sucanvas:web-error", { detail: error instanceof Error ? error.message : String(error) }));
}
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (response.status === 401 && !["/api/auth/session", "/api/auth/login"].includes(path)) window.dispatchEvent(new Event("sucanvas:session-expired"));
  if (!response.ok) {
    const text = await response.text();
    let message = text || `请求失败 (${response.status})`;
    try { message = (JSON.parse(text) as { error?: string }).error || message; } catch { /* plain server response */ }
    throw new Error(message);
  }
  const value = await response.json();
  if (["/api/auth/session", "/api/auth/login"].includes(path) && typeof value?.publicUrl === "string") {
    serverOrigin = devBackend || value.publicUrl;
  }
  return webApiUrls(value, serverOrigin, window.location.origin) as T;
}
function connectEvents(): Promise<void> {
  if (eventReady) return eventReady;
  events = new EventSource("/api/events");
  eventReady = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => { reject(new Error("无法连接任务通知服务")); closeEvents(); }, 15000);
    events!.onopen = () => { window.clearTimeout(timeout); resolve(); };
    events!.onerror = () => {
      // SSE reconnects after a restart or revocation. Lock the UI only when
      // the server confirms expiration; a network interruption may recover.
      void fetch("/api/auth/session", { credentials: "same-origin" }).then((response) => {
        if (response.status === 401) window.dispatchEvent(new Event("sucanvas:session-expired"));
      }).catch(() => {});
    };
    events!.onmessage = (message) => {
      const value = webApiUrls(JSON.parse(message.data), serverOrigin, window.location.origin) as { event: string; payload: unknown };
      if (value.event.startsWith("channel:")) channels.get(value.event.slice(8))?.onmessage(value.payload);
      else if (value.event === "canvas://resync") window.location.reload();
      else for (const listener of listeners.get(value.event) ?? []) listener({ ...value, id: 0 });
    };
  });
  return eventReady;
}
export function closeEvents() { events?.close(); events = null; eventReady = null; channels.clear(); listeners.clear(); }
export class Channel<T> {
  readonly id = crypto.randomUUID();
  onmessage: (message: T) => void = () => {};
  constructor() { channels.set(this.id, this as Channel<unknown>); }
  toJSON() { return { __webChannel: this.id }; }
}
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (command === "verify_app_lock_password") {
    await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: args.password }) });
    return true as T;
  }
  const channel = args.onSubmitted as Channel<unknown> | undefined;
  if (command.startsWith("submit_comfyui_")) await (await import("./settings")).flushSettings();
  if (channel) await connectEvents();
  try {
    const result = await request<{ result: T }>(`/api/invoke/${encodeURIComponent(command)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }, (_key, value) => typeof value === "string" && serverOrigin ? webApiUrl(value, window.location.origin, serverOrigin) : value),
    });
    if (["export_media_asset", "export_generated_video", "export_generated_image"].includes(command) && typeof result.result === "string") download(result.result);
    return result.result;
  } finally { if (channel) channels.delete(channel.id); }
}
export function isTauri() { return false; }
export function convertFileSrc(path: string) {
  if (path.startsWith("sucanvas://") || path.startsWith("sucanvas-export://")) return `/api/resource?resource=${encodeURIComponent(path)}`;
  if (/^(https?:|blob:|data:|\/)/.test(path)) return path;
  return "";
}
export async function listen<T>(name: string, handler: (event: Event<T>) => void): Promise<() => void> {
  const handlers = listeners.get(name) ?? new Set<Listener>();
  const listener = handler as Listener;
  handlers.add(listener); listeners.set(name, handlers);
  try { await connectEvents(); } catch (error) { handlers.delete(listener); throw error; }
  return () => { handlers.delete(listener); };
}
export async function uploadFiles(files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return (await request<{ paths: string[] }>("/api/upload", { method: "POST", body: form })).paths;
}
export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (options.directory) throw new Error("请在服务器配置中设置目录");
  const files = await new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = options.multiple ?? false;
    input.accept = options.filters?.flatMap((filter) => filter.extensions.map((ext) => ext === "*" ? "" : `.${ext}`)).join(",") ?? "";
    input.hidden = true; document.body.appendChild(input);
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    input.click();
  });
  if (!files.length) return null;
  const paths = await uploadFiles(files);
  return options.multiple ? paths : paths[0];
}
export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  const name = (options.defaultPath?.split(/[\\/]/).pop() || "download").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return `sucanvas-export://${crypto.randomUUID()}/${name}`;
}
export function download(resource: string, filename?: string) {
  const url = convertFileSrc(resource);
  if (!url) throw new Error("没有可下载的文件");
  const link = document.createElement("a");
  const name = downloadFilename(resource, filename);
  const target = new URL(url, window.location.origin);
  target.searchParams.set("download", "true");
  if (target.pathname === "/api/resource") target.searchParams.set("filename", name);
  if (target.pathname === "/api/comfy/view") target.searchParams.set("downloadName", name);
  link.href = target.toString();
  link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
}
export async function revealItemInDir(path: string) { download(path); }
export async function openUrl(url: string) {
  const parsed = new URL(url, window.location.origin);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("无效的链接");
  window.open(parsed.toString(), "_blank", "noopener,noreferrer");
}
export function getCurrentWebview() {
  return { onDragDropEvent: async (handler: (event: Event<DragDropEvent>) => void): Promise<() => void> => {
    const filesEvent = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
    const position = (event: DragEvent) => ({ x: event.clientX * window.devicePixelRatio, y: event.clientY * window.devicePixelRatio });
    const dispatch = (payload: DragDropEvent) => handler({ event: "web-drag-drop", id: 0, payload });
    const enter = (event: DragEvent) => { if (filesEvent(event)) { event.preventDefault(); dispatch({ type: "enter", paths: ["upload"], position: position(event) }); } };
    const over = (event: DragEvent) => { if (filesEvent(event)) { event.preventDefault(); dispatch({ type: "over", position: position(event) }); } };
    const leave = (event: DragEvent) => { if (filesEvent(event) && !event.relatedTarget) dispatch({ type: "leave" }); };
    const drop = async (event: DragEvent) => {
      if (!filesEvent(event)) return;
      event.preventDefault();
      const point = position(event);
      try { const paths = await uploadFiles(Array.from(event.dataTransfer?.files ?? [])); dispatch({ type: "drop", paths, position: point }); }
      catch (error) { dispatch({ type: "leave" }); reportWebError(error); }
    };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  } };
}
