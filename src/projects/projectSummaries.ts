import type { WorkspaceSnapshot } from "../CanvasNode";

const summaries = new WeakMap<WorkspaceSnapshot, WorkspaceSnapshot>();
// Presentation-only snapshots. Never use their content as a database write payload.
export function summarizeProject(project: WorkspaceSnapshot): WorkspaceSnapshot {
  const cached = summaries.get(project);
  if (cached) return cached;
  const result = {
    ...project,
    nodes: project.nodes.map((node) => {
      const content: Record<string, unknown> = {};
      for (const key of ["assetPath", "workflowModuleId", "generationMode"]) {
        if (typeof node.content[key] === "string") content[key] = node.content[key];
      }
      const snapshot = node.content.generationSnapshot;
      if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
        const moduleId = (snapshot as Record<string, unknown>).workflowModuleId;
        content.generationSnapshot = typeof moduleId === "string" ? { workflowModuleId: moduleId } : {};
      }
      return { ...node, content };
    }),
    edges: project.edges.map((edge) => ({ ...edge, metadata: {} })),
  };
  summaries.set(project, result);
  summaries.set(result, result);
  return result;
}
