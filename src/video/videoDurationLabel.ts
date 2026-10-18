// A video has a usable duration only when it is a positive finite number.
// Upscaled uploads carry 0 because they never had a requested duration.
export function validVideoDurationSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Footer text: "耗时 …" plus " / X秒" only when the duration is valid.
export function videoElapsedWithDuration(elapsed: string, durationSeconds: unknown): string {
  const duration = validVideoDurationSeconds(durationSeconds);
  return duration === null ? elapsed : `${elapsed} / ${duration}秒`;
}

// Details panel "基础" row: drop the "X 秒 ·" part when the duration is not valid.
export function videoDurationAspectLabel(durationSeconds: unknown, aspectRatio: string): string {
  const duration = validVideoDurationSeconds(durationSeconds);
  return duration === null ? aspectRatio : `${duration} 秒 · ${aspectRatio}`;
}
