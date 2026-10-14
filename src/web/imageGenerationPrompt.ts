export type WebImagePromptRequest =
  | { kind: "text"; promptNodeId: string }
  | { kind: "snapshot"; prompt: string; negativePrompt: string; promptSourceNodeId: string };

export function imageRegenerationPrompt(content: Record<string, unknown>): WebImagePromptRequest | null {
  const snapshot = content.generationSnapshot as Record<string, unknown> | undefined;
  const recovery = snapshot?.imageRecovery as Record<string, unknown> | undefined;
  const prompt = typeof content.generationPrompt === "string"
    ? content.generationPrompt
    : typeof recovery?.prompt === "string" ? recovery.prompt : "";
  if (!prompt.trim()) return null;
  return {
    kind: "snapshot",
    prompt,
    negativePrompt: typeof content.generationNegativePrompt === "string"
      ? content.generationNegativePrompt
      : typeof recovery?.negativePrompt === "string" ? recovery.negativePrompt : "",
    promptSourceNodeId: typeof content.promptSourceNodeId === "string"
      ? content.promptSourceNodeId
      : typeof recovery?.promptSourceNodeId === "string" ? recovery.promptSourceNodeId : "",
  };
}
