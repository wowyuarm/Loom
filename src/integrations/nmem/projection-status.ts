export interface NmemProjectionStatus {
  summary: {
    current: number;
    pending: number;
    blocked: number;
  };
  items: Array<{
    id: string;
    status: "current" | "pending" | "blocked";
    attempts: number;
    nextAttemptAt?: string;
    lastError?: string;
  }>;
}

export function projectionStatus(rows: Array<{
  id: string;
  status: "current" | "pending" | "blocked";
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}>): NmemProjectionStatus {
  const summary = { current: 0, pending: 0, blocked: 0 };
  const items = rows.map(row => {
    summary[row.status] += 1;
    return {
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  });
  return { summary, items };
}
