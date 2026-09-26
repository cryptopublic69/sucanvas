import type { VideoRegenerationPromptOption } from "../CanvasNode";

const normalizedText = (text: string) => text.replace(/\s+/g, " ").trim();

export function deduplicateRegenerationPromptOptions(
  options: VideoRegenerationPromptOption[],
  selectedKey: string,
): { options: VideoRegenerationPromptOption[]; selectedKey: string } {
  const unique: VideoRegenerationPromptOption[] = [];
  let nextSelectedKey = selectedKey;
  // Prefer a named version over a separate historical snapshot entry.
  const ordered = [...options.filter((option) => option.key !== "snapshot"),
    ...options.filter((option) => option.key === "snapshot")];
  for (const option of ordered) {
    const index = unique.findIndex((existing) => (
      normalizedText(existing.prompt) === normalizedText(option.prompt)
    ));
    if (index < 0) {
      unique.push(option);
      continue;
    }
    if (option.key === selectedKey) {
      const existing = unique[index];
      // Keep the selected payload intact, using the visible version's identity.
      unique[index] = {
        ...option,
        key: existing.key,
        label: existing.label.includes("（当前视频）")
          ? existing.label : `${existing.label}（当前视频）`,
      };
      nextSelectedKey = existing.key;
    }
  }
  return { options: unique, selectedKey: nextSelectedKey };
}
