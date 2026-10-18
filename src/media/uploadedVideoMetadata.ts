// Video metadata read in the browser before upload, keyed by the uploaded path until importMedia takes it.
export type UploadedVideoMetadata = { width: number; height: number; duration: number };

const pending = new Map<string, UploadedVideoMetadata>();

export function rememberUploadedVideoMetadata(path: string, metadata: UploadedVideoMetadata) {
  pending.set(path, metadata);
  if (pending.size > 64) pending.delete(pending.keys().next().value!);
}

export function takeUploadedVideoMetadata(path: string): UploadedVideoMetadata | undefined {
  const metadata = pending.get(path);
  pending.delete(path);
  return metadata;
}
