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
      event: "channel.state";
      at: string;
      channel: string;
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
      event: "agent.tool.error-circuit-opened";
      at: string;
      toolCallId: string;
      toolName: string;
      consecutiveErrors: number;
    }
  | {
      event: "agent.tool.started";
      at: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      event: "agent.run.started";
      at: string;
      runId: string;
      agentName: string;
    }
  | {
      event: "agent.run.finished";
      at: string;
      runId: string;
      agentName: string;
      result: "succeeded" | "failed" | "interrupted";
      /** Bounded failure category; never the raw error text. */
      failureCategory?: string;
    }
  | {
      /** Pi session is about to sleep before re-running a retryable model error. */
      event: "agent.retry.scheduled";
      at: string;
      agentName: string;
      /** 1-indexed upcoming retry attempt. */
      attempt: number;
      maxAttempts: number;
      delayMs: number;
    }
  | {
      event: "agent.retry.finished";
      at: string;
      agentName: string;
      success: boolean;
      /** Retry attempts consumed by this session run. */
      attempt: number;
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
