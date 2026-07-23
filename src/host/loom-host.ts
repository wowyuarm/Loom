import { mkdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  createProcessDriver,
  openLoomInstance,
  type LoomInstance,
  type LoomInstanceStatus,
  type OpenLoomInstanceOptions,
  type ProcessDriver,
  type ProcessDriverStatus,
} from "../instance/index.js";
import { resolveInstanceLayout } from "../instance/layout.js";
import type { AcceptedInput, RuntimeInput } from "../runtime/index.js";

export interface LoomHost {
  start(): void;
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  wake(): void;
  status(): LoomHostStatus;
  stop(): Promise<void>;
}

export interface LoomHostStatus {
  root: string;
  state: "open" | "running" | "stopping" | "stopped";
  driver: ProcessDriverStatus;
  instance: LoomInstanceStatus;
}

export type OpenLoomHostOptions = OpenLoomInstanceOptions;

class DefaultLoomHost implements LoomHost {
  readonly #root: string;
  readonly #instance: LoomInstance;
  readonly #driver: ProcessDriver;
  readonly #ownership: InstanceRootOwnership;
  #state: LoomHostStatus["state"] = "open";
  #finalInstanceStatus: LoomInstanceStatus | undefined;
  #stopping: Promise<void> | undefined;

  constructor(options: {
    root: string;
    instance: LoomInstance;
    driver: ProcessDriver;
    ownership: InstanceRootOwnership;
  }) {
    this.#root = options.root;
    this.#instance = options.instance;
    this.#driver = options.driver;
    this.#ownership = options.ownership;
  }

  start(): void {
    if (this.#state !== "open") {
      throw new Error(`Loom Host cannot start from state ${this.#state}`);
    }
    this.#driver.start();
    this.#state = "running";
  }

  async acceptInput(input: RuntimeInput): Promise<AcceptedInput> {
    if (this.#state !== "running") {
      throw new Error(`Loom Host cannot accept Input while ${this.#state}`);
    }
    return this.#driver.acceptInput(input);
  }

  wake(): void {
    if (this.#state !== "running") {
      throw new Error(`Loom Host cannot wake while ${this.#state}`);
    }
    this.#driver.wake();
  }

  status(): LoomHostStatus {
    return {
      root: this.#root,
      state: this.#state,
      driver: this.#driver.status(),
      instance: this.#finalInstanceStatus ?? this.#instance.status(),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    if (this.#state === "stopped") return;
    this.#finalInstanceStatus = this.#instance.status();
    this.#state = "stopping";
    this.#stopping = this.#finishStop();
    return this.#stopping;
  }

  async #finishStop(): Promise<void> {
    try {
      await this.#driver.stop();
    } finally {
      try {
        this.#ownership.release();
      } finally {
        this.#state = "stopped";
      }
    }
  }
}

export async function openLoomHost(options: OpenLoomHostOptions): Promise<LoomHost> {
  const root = path.resolve(options.root);
  const ownership = await acquireInstanceRootOwnership(root);
  try {
    const instance = await openLoomInstance({ ...options, root });
    return new DefaultLoomHost({
      root,
      instance,
      driver: createProcessDriver({ instance, ...(options.now ? { now: options.now } : {}) }),
      ownership,
    });
  } catch (error) {
    ownership.release();
    throw error;
  }
}

class InstanceRootOwnership {
  #released = false;

  constructor(private readonly database: DatabaseSync) {}

  release(): void {
    if (this.#released) return;
    this.#released = true;
    try {
      this.database.exec("ROLLBACK");
    } finally {
      this.database.close();
    }
  }
}

async function acquireInstanceRootOwnership(root: string): Promise<InstanceRootOwnership> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if (isMissingFile(error)) throw new Error(`Prepared Instance Root does not exist: ${root}`);
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error(`Prepared Instance Root is not a directory: ${root}`);

  const layout = resolveInstanceLayout(root);
  await mkdir(layout.runtimeRoot, { recursive: true });
  const database = new DatabaseSync(path.join(layout.runtimeRoot, "host-lock.db"));
  database.exec("PRAGMA busy_timeout = 0");
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) {
      throw new Error(`Instance Root is already owned by a live Loom Host: ${root}`);
    }
    throw error;
  }
  return new InstanceRootOwnership(database);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}
