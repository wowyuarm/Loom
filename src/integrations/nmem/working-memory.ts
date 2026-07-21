import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NmemClient, NmemRequestError } from "./client.js";

export type NmemWorkingMemoryEvidence =
  | {
      status: "available";
      source: "nmem";
      exists: boolean;
      content: string;
      sourceDate?: string;
      fetchedAt: string;
    }
  | {
      status: "stale";
      source: "nmem";
      exists: boolean;
      content: string;
      sourceDate?: string;
      fetchedAt: string;
      failedAt: string;
      reason: NmemRequestError["kind"];
    }
  | {
      status: "unavailable";
      source: "nmem";
      failedAt: string;
      reason: NmemRequestError["kind"] | "not_configured";
    };

export interface NmemWorkingMemoryReader {
  read(): Promise<NmemWorkingMemoryEvidence>;
  close(): void;
}

export interface NmemWorkingMemoryReaderOptions {
  stateRoot: string;
  endpoint?: string;
  apiKey?: string;
  spaceId?: string;
  timeoutMs?: number;
  now?: () => Date;
  fetch?: typeof fetch;
}

interface WorkingMemoryCacheRow {
  has_snapshot: 0 | 1;
  exists_flag: 0 | 1 | null;
  content: string | null;
  source_date: string | null;
  fetched_at: string | null;
}

class SqliteNmemWorkingMemoryReader implements NmemWorkingMemoryReader {
  readonly #database: DatabaseSync;
  readonly #client: NmemClient | undefined;
  readonly #connectionHash: string;
  readonly #now: () => Date;

  constructor(options: NmemWorkingMemoryReaderOptions) {
    this.#now = options.now ?? (() => new Date());
    const directory = path.join(options.stateRoot, "integrations");
    mkdirSync(directory, { recursive: true });
    this.#database = new DatabaseSync(path.join(directory, "nmem.db"));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS working_memory_cache (
        connection_hash TEXT PRIMARY KEY,
        has_snapshot INTEGER NOT NULL CHECK (has_snapshot IN (0, 1)),
        exists_flag INTEGER CHECK (exists_flag IS NULL OR exists_flag IN (0, 1)),
        content TEXT,
        source_date TEXT,
        fetched_at TEXT,
        last_failure_at TEXT,
        last_error_kind TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#connectionHash = createHash("sha256")
      .update(`${options.endpoint ?? ""}\0${options.apiKey ?? ""}\0${options.spaceId ?? ""}`)
      .digest("hex");
    this.#client = options.endpoint
      ? new NmemClient({
          endpoint: options.endpoint,
          ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
          ...(options.spaceId !== undefined ? { spaceId: options.spaceId } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        })
      : undefined;
  }

  async read(): Promise<NmemWorkingMemoryEvidence> {
    const failedAt = this.#now().toISOString();
    if (!this.#client) {
      return { status: "unavailable", source: "nmem", failedAt, reason: "not_configured" };
    }
    try {
      await this.#client.requireCapabilities("ai_agent");
      const snapshot = await this.#client.getWorkingMemory();
      const fetchedAt = this.#now().toISOString();
      this.#recordSuccess(snapshot, fetchedAt);
      return {
        status: "available",
        source: "nmem",
        exists: snapshot.exists,
        content: snapshot.content,
        ...(snapshot.sourceDate ? { sourceDate: snapshot.sourceDate } : {}),
        fetchedAt,
      };
    } catch (error) {
      const reason = classify(error);
      this.#recordFailure(error, failedAt, reason);
      const cached = this.#readCache();
      if (!cached || cached.has_snapshot !== 1 || cached.exists_flag === null
        || cached.content === null || cached.fetched_at === null) {
        return { status: "unavailable", source: "nmem", failedAt, reason };
      }
      return {
        status: "stale",
        source: "nmem",
        exists: cached.exists_flag === 1,
        content: cached.content,
        ...(cached.source_date ? { sourceDate: cached.source_date } : {}),
        fetchedAt: cached.fetched_at,
        failedAt,
        reason,
      };
    }
  }

  close(): void {
    this.#database.close();
  }

  #readCache(): WorkingMemoryCacheRow | undefined {
    return this.#database.prepare(`
      SELECT has_snapshot, exists_flag, content, source_date, fetched_at
      FROM working_memory_cache WHERE connection_hash = ?
    `).get(this.#connectionHash) as unknown as WorkingMemoryCacheRow | undefined;
  }

  #recordSuccess(
    snapshot: { exists: boolean; content: string; sourceDate?: string },
    fetchedAt: string,
  ): void {
    this.#database.prepare(`
      INSERT INTO working_memory_cache (
        connection_hash, has_snapshot, exists_flag, content, source_date,
        fetched_at, last_failure_at, last_error_kind, last_error, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      ON CONFLICT (connection_hash) DO UPDATE SET
        has_snapshot = 1,
        exists_flag = excluded.exists_flag,
        content = excluded.content,
        source_date = excluded.source_date,
        fetched_at = excluded.fetched_at,
        last_failure_at = NULL,
        last_error_kind = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(
      this.#connectionHash,
      snapshot.exists ? 1 : 0,
      snapshot.content,
      snapshot.sourceDate ?? null,
      fetchedAt,
      fetchedAt,
    );
  }

  #recordFailure(error: unknown, failedAt: string, reason: NmemRequestError["kind"]): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#database.prepare(`
      INSERT INTO working_memory_cache (
        connection_hash, has_snapshot, exists_flag, content, source_date,
        fetched_at, last_failure_at, last_error_kind, last_error, updated_at
      ) VALUES (?, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT (connection_hash) DO UPDATE SET
        last_failure_at = excluded.last_failure_at,
        last_error_kind = excluded.last_error_kind,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(this.#connectionHash, failedAt, reason, message, failedAt);
  }
}

export function createNmemWorkingMemoryReader(
  options: NmemWorkingMemoryReaderOptions,
): NmemWorkingMemoryReader {
  return new SqliteNmemWorkingMemoryReader(options);
}

function classify(error: unknown): NmemRequestError["kind"] {
  return error instanceof NmemRequestError ? error.kind : "incompatible";
}
