type OutputContent = Record<string, unknown>;

export function resolveComfyOutputPath(root: string, content: OutputContent): string | null {
  const filenameValue = typeof content.filename === "string" ? content.filename : "";
  const filenameParts = filenameValue.split(/[\\/]/).filter(Boolean);
  const filename = filenameParts[filenameParts.length - 1] ?? "";
  if (!root.trim() || !filename) return null;
  const subfolder = typeof content.subfolder === "string" ? content.subfolder : "";
  const safeSubfolders = subfolder.split(/[\\/]/)
    .filter((part) => part && part !== "." && part !== ".." && !part.includes(":"));
  return [root.trim().replace(/[\\/]+$/, ""), ...safeSubfolders, filename].join("\\");
}

export function generatedVideoDeletionPaths(root: string, content: OutputContent): string[] {
  const original = resolveComfyOutputPath(root, { filename: content.filename, subfolder: content.subfolder });
  if (!original) return [];
  const paths = [original];
  // After storage migration the ComfyUI original is the only active file.
  return [...new Set(paths)];
}
