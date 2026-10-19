// Admin "素材清理" (CANVAS-012c4): requests plus the small rules the page
// shows. The server lists, re-checks and moves every file itself (registry,
// references, grace period, media folders); nothing here is a boundary.
import { invoke } from "./bridge";

export type MediaItem = {
  reference: string;
  name: string;
  category: string;
  size: number;
  unreferencedSince: string | null;
  releasedBy: string | null;
  createdBy: string | null;
  trashedAt: string | null;
  canvasName: string | null;
};
export type MediaListing = {
  candidates: MediaItem[];
  trash: MediaItem[];
  candidateBytes: number;
  graceDays: number;
  trashRetentionDays: number;
};
export type MediaOutcome = { done: string[]; bytes: number; skipped: { reference: string; reason: string }[] };

export function listMediaCleanup() {
  return invoke<MediaListing>("list_media_cleanup");
}
export function trashMediaFiles(references: string[]) {
  return invoke<MediaOutcome>("trash_media_files", { references });
}
export function restoreMediaFiles(references: string[]) {
  return invoke<MediaOutcome>("restore_media_files", { references });
}
export function purgeMediaFiles(references: string[]) {
  return invoke<MediaOutcome>("purge_media_files", { references });
}

const CATEGORY_LABELS: Record<string, string> = {
  upload: "上传",
  "upload-staging": "上传暂存",
  generated: "生成",
  resize: "Resize",
  "task-temp": "任务临时副本",
};
export function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category;
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
export function previewKind(name: string): "image" | "video" | "audio" | "file" {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extension)) return "image";
  if (["mp4", "webm", "mov", "mkv", "m4v"].includes(extension)) return "video";
  if (["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(extension)) return "audio";
  return "file";
}
// Trashed files are not served; only files still in place get a preview.
export function previewUrl(item: MediaItem) {
  return item.trashedAt ? null : `/api/resource?resource=${encodeURIComponent(item.reference)}`;
}
// Days until a trashed file is removed for good (never below 0).
export function daysLeft(trashedAt: string, retentionDays: number, now = Date.now()) {
  const removal = new Date(trashedAt).getTime() + retentionDays * 86400000;
  return Math.max(0, Math.ceil((removal - now) / 86400000));
}

export type MediaFilter = { category: string; user: string; sort: "size" | "time" | "name" };
// Filter by category and by user (creator or whoever released it), then sort:
// largest first, oldest unreferenced first, or by name.
export function filterMedia(items: MediaItem[], filter: MediaFilter) {
  const user = filter.user.trim().toLowerCase();
  const time = (item: MediaItem) => item.trashedAt ?? item.unreferencedSince ?? "";
  return items
    .filter((item) => !filter.category || item.category === filter.category)
    .filter((item) => !user || [item.createdBy, item.releasedBy].some((name) => name?.toLowerCase().includes(user)))
    .sort((a, b) => filter.sort === "size" ? b.size - a.size || a.name.localeCompare(b.name)
      : filter.sort === "time" ? time(a).localeCompare(time(b)) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name));
}
// "已移入回收区 3 个（12 MB），跳过 1 个：x.png 仍被画布引用"
export function outcomeMessage(action: string, outcome: MediaOutcome, names: Map<string, string>) {
  const done = `已${action} ${outcome.done.length} 个（${formatBytes(outcome.bytes)}）`;
  if (!outcome.skipped.length) return done;
  const skipped = outcome.skipped.map((skip) => `${names.get(skip.reference) ?? skip.reference.split(/[\\/]/).pop()} ${skip.reason}`);
  return `${done}，跳过 ${outcome.skipped.length} 个：${skipped.join("；")}`;
}
