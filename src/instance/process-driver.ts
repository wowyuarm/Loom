import type { AcceptedInput, RuntimeInput } from "../runtime/index.js";
import type { LoomInstance, LoomInstanceRunResult } from "./loom-instance.js";

const DEFAULT_PROCESS_ERROR_RETRY_MS = 30 * 1_000;
const DEFAULT_PROCESS_BUSY_RETRY_MS = 1_000;

export type ProcessDriverWait = (
  until: Date | undefined,
  signal: AbortSignal,
) => Promise<void>;

export interface ProcessDriverOptions {
  instance: LoomInstance;
  now?: () => Date;
  wait?: ProcessDriverWait;
}

export interface ProcessDriver {
  start(): void;
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  wake(): void;
  status(): ProcessDriverStatus;
  stop(): Promise<void>;
}

export interface ProcessDriverStatus {
  state: "created" | "running" | "waiting" | "stopping" | "stopped";
  nextRunAt?: string;
  lastRun?: {
    observedAt: string;
    result: LoomInstanceRunResult;
  };
  lastError?: {
    occurredAt: string;
    message: string;
  };
}

class DefaultProcessDriver implements ProcessDriver {
  readonly #instance: LoomInstance;
  readonly #now: () => Date;
  readonly #wait: ProcessDriverWait;
  #running: Promise<void> | undefined;
  #waitController: AbortController | undefined;
  #wakeVersion = 0;
  #stopRequested = false;
  #state: ProcessDriverStatus["state"] = "created";
  #nextRunAt: string | undefined;
  #lastRun: ProcessDriverStatus["lastRun"];
  #lastError: ProcessDriverStatus["lastError"];

  constructor(options: ProcessDriverOptions) {
    this.#instance = options.instance;
    this.#now = options.now ?? (() => new Date());
    this.#wait = options.wait ?? waitUntil;
  }

  start(): void {
    if (this.#running) throw new Error("Process driver has already started");
    if (this.#stopRequested) throw new Error("Process driver has already stopped");
    this.#state = "running";
    this.#running = this.#run();
  }

  async acceptInput(input: RuntimeInput): Promise<AcceptedInput> {
    const accepted = await this.#instance.acceptInput(input);
    this.wake();
    return accepted;
  }

  wake(): void {
    this.#wakeVersion += 1;
    this.#waitController?.abort();
  }

  status(): ProcessDriverStatus {
    return {
      state: this.#state,
      ...(this.#nextRunAt ? { nextRunAt: this.#nextRunAt } : {}),
      ...(this.#lastRun ? {
        lastRun: {
          observedAt: this.#lastRun.observedAt,
          result: { ...this.#lastRun.result },
        },
      } : {}),
      ...(this.#lastError ? { lastError: { ...this.#lastError } } : {}),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopRequested) {
      await this.#running;
      return;
    }
    this.#stopRequested = true;
    this.#state = "stopping";
    this.wake();
    if (this.#running) {
      await this.#running;
    } else {
      this.#instance.close();
      this.#state = "stopped";
    }
  }

  async #run(): Promise<void> {
    try {
      while (!this.#stopRequested) {
        const wakeVersion = this.#wakeVersion;
        const observedAt = this.#now();
        this.#state = "running";
        this.#nextRunAt = undefined;
        let result: LoomInstanceRunResult;
        try {
          result = await this.#instance.runOnce(observedAt);
          this.#lastRun = { observedAt: observedAt.toISOString(), result };
          this.#lastError = undefined;
        } catch (error) {
          const nextRunAt = new Date(observedAt.getTime() + DEFAULT_PROCESS_ERROR_RETRY_MS);
          this.#lastError = {
            occurredAt: observedAt.toISOString(),
            message: error instanceof Error ? error.message : String(error),
          };
          if (this.#stopRequested) break;
          if (this.#wakeVersion !== wakeVersion) continue;
          await this.#waitFor(nextRunAt);
          continue;
        }
        if (this.#stopRequested) break;
        if (this.#wakeVersion !== wakeVersion) continue;
        await this.#waitForNextRun(result, observedAt);
      }
    } finally {
      this.#instance.close();
      this.#nextRunAt = undefined;
      this.#state = "stopped";
    }
  }

  async #waitForNextRun(result: LoomInstanceRunResult, observedAt: Date): Promise<void> {
    const resultTime = "nextRunAt" in result ? new Date(result.nextRunAt) : undefined;
    const busyRetry = result.disposition === "busy"
      ? new Date(observedAt.getTime() + DEFAULT_PROCESS_BUSY_RETRY_MS)
      : undefined;
    const until = resultTime && busyRetry
      ? new Date(Math.min(resultTime.getTime(), busyRetry.getTime()))
      : resultTime ?? busyRetry;
    await this.#waitFor(until);
  }

  async #waitFor(until: Date | undefined): Promise<void> {
    const controller = new AbortController();
    this.#state = "waiting";
    this.#nextRunAt = until?.toISOString();
    this.#waitController = controller;
    try {
      await this.#wait(until, controller.signal);
    } finally {
      if (this.#waitController === controller) this.#waitController = undefined;
    }
  }
}

export function createProcessDriver(options: ProcessDriverOptions): ProcessDriver {
  return new DefaultProcessDriver(options);
}

async function waitUntil(until: Date | undefined, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timeout = until
      ? setTimeout(resolve, Math.max(0, Math.min(until.getTime() - Date.now(), 2_147_483_647)))
      : undefined;
    signal.addEventListener("abort", () => {
      if (timeout) clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
