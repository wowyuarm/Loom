export type OperationalEvent =
  | {
      event: "host.started";
      at: string;
      root: string;
    }
  | {
      event: "host.stopped";
      at: string;
      root: string;
      signal: "SIGINT" | "SIGTERM";
    }
  | {
      event: "integration.state";
      at: string;
      integration: "local" | "weixin" | "raft";
      state: string;
    }
  | {
      event: "runtime.transition";
      at: string;
      entityType: string;
      entityId: string;
      fromState: string | null;
      toState: string;
      reason: string;
    }
  | {
      event: "driver.run.started";
      at: string;
      observedAt: string;
    }
  | {
      event: "driver.run.completed";
      at: string;
      observedAt: string;
      durationMs: number;
      disposition: string;
    }
  | {
      event: "driver.run.failed";
      at: string;
      observedAt: string;
      durationMs: number;
      errorType: string;
    }
  | {
      event: "agent.tool.started";
      at: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      event: "agent.tool.completed";
      at: string;
      toolCallId: string;
      toolName: string;
      durationMs: number;
      status: "ok" | "error";
    }
  | {
      event: "model.runtime";
      at: string;
      state: "active" | "degraded" | "blocked";
      revisionId?: string;
      failureKind?: string;
    };

export type OperationalEventObserver = (event: OperationalEvent) => void;

export function emitOperationalEvent(
  observer: OperationalEventObserver | undefined,
  event: OperationalEvent,
): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Operational output must not change Runtime or Agent behavior.
  }
}

export function operationalTimestamp(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

export function operationalErrorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
