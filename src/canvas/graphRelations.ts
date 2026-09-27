export interface RelationRecord { id: string }
export interface RelationEdge { id: string; source: string; target: string; kind?: string }

// Keep dependency arrays stable so unrelated node edits can reuse derived inputs.
export class GraphRelations<T extends RelationRecord> {
  records = new Map<string, T>();
  inputs = new Map<string, T[]>();
  parents = new Map<string, T[]>();
  outputCounts = new Map<string, number>();
  private edges: RelationEdge[] = [];
  private incoming = new Map<string, RelationEdge[]>();
  private targets = new Map<string, Set<string>>();

  update(records: T[], edges: RelationEdge[]) {
    const dirty = new Set<string>();
    const nextRecords = new Map(records.map((record) => [record.id, record]));
    const topologyChanged = edges.length !== this.edges.length || edges.some((edge, index) => {
      const old = this.edges[index];
      return edge.id !== old.id || edge.source !== old.source || edge.target !== old.target || edge.kind !== old.kind;
    });
    if (topologyChanged) {
      const previousIncoming = this.incoming;
      this.incoming = new Map();
      this.targets.clear();
      this.outputCounts.clear();
      for (const edge of edges) {
        const incoming = this.incoming.get(edge.target) ?? [];
        incoming.push(edge);
        this.incoming.set(edge.target, incoming);
        const targets = this.targets.get(edge.source) ?? new Set();
        targets.add(edge.target);
        this.targets.set(edge.source, targets);
        this.outputCounts.set(edge.source, (this.outputCounts.get(edge.source) ?? 0) + 1);
      }
      for (const id of new Set([...previousIncoming.keys(), ...this.incoming.keys()])) {
        const before = previousIncoming.get(id) ?? [];
        const after = this.incoming.get(id) ?? [];
        if (before.length !== after.length || after.some((edge, index) => edge.id !== before[index].id
          || edge.source !== before[index].source || edge.kind !== before[index].kind)) dirty.add(id);
      }
      this.edges = edges;
    }
    for (const record of records) {
      if (this.records.get(record.id) !== record) this.targets.get(record.id)?.forEach((id) => dirty.add(id));
    }
    this.records.forEach((_, id) => {
      if (!nextRecords.has(id)) this.targets.get(id)?.forEach((target) => dirty.add(target));
    });
    this.records = nextRecords;
    for (const id of dirty) {
      const inputs: T[] = [];
      const parents: T[] = [];
      for (const edge of this.incoming.get(id) ?? []) {
        const source = nextRecords.get(edge.source);
        if (!source) continue;
        inputs.push(source);
        if (edge.kind === "content-derivation" || edge.kind === "scene-branch") parents.push(source);
      }
      if (inputs.length) this.inputs.set(id, inputs); else this.inputs.delete(id);
      if (parents.length) this.parents.set(id, parents); else this.parents.delete(id);
    }
  }
}
