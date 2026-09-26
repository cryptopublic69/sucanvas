type QueueRecord = {
  id: string;
  kind: string;
  createdAt: string;
  content: Record<string, unknown>;
};

// Canvas-local submission order; derive it from active placeholders so removal
// or completion closes gaps without writing transient positions to the database.
export function generationQueuePositions(records: readonly QueueRecord[]): Map<string, number> {
  const active = records.filter((record) => (
    (record.kind === "generated-video" || record.kind === "generated-image")
    && record.content.generationPlaceholder === true
    && ["running", "pending", "queued", "cancelling"].includes(String(record.content.status))
  ));
  active.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return new Map(active.map((record, index) => [record.id, index + 1]));
}
