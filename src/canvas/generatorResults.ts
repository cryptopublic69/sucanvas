// A generator node's own results (CANVAS-038): the nodes its start button created, running placeholders
// included. Second-pass / upscale previews (made from a preview: sourcePreviewId) and image copies are not
// its own. One filter for the placement of the next result and for "jump to the latest result".
type ResultNode = {
  kind: string;
  source?: string;
  createdAt: string;
  content: Record<string, unknown>;
};

export type GeneratorResultKind = "generated-image" | "generated-video";

export function generatorResultKind(generatorKind: string): GeneratorResultKind | null {
  return generatorKind === "image-generation" ? "generated-image"
    : generatorKind === "video-generation" ? "generated-video"
      : null;
}

export function isGeneratorResult(node: ResultNode, generatorId: string, resultKind: GeneratorResultKind): boolean {
  return node.kind === resultKind
    && node.content.sourceGeneratorId === generatorId
    && typeof node.content.sourcePreviewId !== "string"
    && (resultKind !== "generated-image" || (node.content.generatedImageCopy !== true && node.source !== "clipboard"));
}

// The newest by creation time; on a tie the later one in the list.
export function latestByCreation<T extends { createdAt: string }>(nodes: T[]): T | null {
  return nodes.reduce<T | null>((latest, node) => {
    if (!latest) return node;
    return (Date.parse(node.createdAt) || 0) >= (Date.parse(latest.createdAt) || 0) ? node : latest;
  }, null);
}

export function latestGeneratorResult<T extends ResultNode>(generator: { id: string; kind: string }, nodes: T[]): T | null {
  const resultKind = generatorResultKind(generator.kind);
  if (!resultKind) return null;
  return latestByCreation(nodes.filter((node) => isGeneratorResult(node, generator.id, resultKind)));
}
