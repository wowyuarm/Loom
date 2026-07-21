import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parse } from "yaml";

import type { Runtime } from "../../runtime/index.js";
import type { AgentWorkspace } from "../../workspace/agent-workspace.js";
import { NmemClient, NmemRequestError, type NmemMemoryUpsert } from "./client.js";

export interface NmemEpisodeReconcileResult {
  imported: number;
  current: number;
  pending: number;
  blocked: number;
}

export interface NmemEpisodeReconciler {
  reconcile(): Promise<NmemEpisodeReconcileResult>;
  close(): void;
}

export interface NmemEpisodeReconcilerOptions {
  runtime: Pick<Runtime, "status">;
  agentWorkspace: AgentWorkspace;
  stateRoot: string;
  endpoint?: string;
  apiKey?: string;
  spaceId?: string;
  timeoutMs?: number;
  now?: () => Date;
  fetch?: typeof fetch;
}

interface EpisodeExportRow {
  episode_id: string;
  content_hash: string;
  status: "current" | "pending" | "blocked";
  attempt_count: number;
  next_attempt_at: string | null;
  connection_hash: string;
}

interface PreparedEpisode {
  id: string;
  path: string;
  source: string;
  contentHash: string;
}

class SqliteNmemEpisodeReconciler implements NmemEpisodeReconciler {
  readonly #runtime: Pick<Runtime, "status">;
  readonly #workspaceRoot: string;
  readonly #database: DatabaseSync;
  readonly #client: NmemClient | undefined;
  readonly #connectionHash: string;
  readonly #now: () => Date;

  constructor(options: NmemEpisodeReconcilerOptions) {
    this.#runtime = options.runtime;
    this.#workspaceRoot = options.agentWorkspace.root;
    this.#now = options.now ?? (() => new Date());
    const directory = path.join(options.stateRoot, "integrations");
    mkdirSync(directory, { recursive: true });
    this.#database = new DatabaseSync(path.join(directory, "nmem.db"));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS episode_exports (
        episode_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'pending', 'blocked')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        connection_hash TEXT NOT NULL,
        last_error TEXT,
        imported_at TEXT,
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

  async reconcile(): Promise<NmemEpisodeReconcileResult> {
    const result: NmemEpisodeReconcileResult = { imported: 0, current: 0, pending: 0, blocked: 0 };
    const episodes = committedEpisodes(this.#runtime.status());
    if (episodes.length === 0) return result;

    const candidates: PreparedEpisode[] = [];
    for (const reference of episodes) {
      let source: string;
      try {
        source = readFileSync(workspaceFile(this.#workspaceRoot, reference.path), "utf8");
      } catch (error) {
        this.#recordFailure(reference.id, reference.path, `unreadable:${reference.path}`, error);
        result.blocked++;
        continue;
      }
      const contentHash = createHash("sha256").update(source).digest("hex");
      const existing = this.#read(reference.id);
      const sameProjection = existing?.content_hash === contentHash
        && existing.connection_hash === this.#connectionHash;
      if (sameProjection && existing.status === "current") {
        result.current++;
        continue;
      }
      if (sameProjection
        && existing.next_attempt_at
        && existing.next_attempt_at > this.#now().toISOString()) {
        existing.status === "pending" ? result.pending++ : result.blocked++;
        continue;
      }
      candidates.push({ id: reference.id, path: reference.path, source, contentHash });
    }
    if (candidates.length === 0) return result;
    if (!this.#client) {
      result.blocked += candidates.length;
      return result;
    }

    try {
      await this.#client.requireCapabilities("memories");
    } catch (error) {
      for (const episode of candidates) {
        this.#recordFailure(episode.id, episode.path, episode.contentHash, error);
        classify(error) === "temporary" ? result.pending++ : result.blocked++;
      }
      return result;
    }

    for (const reference of candidates) {
      try {
        const episode = parseEpisode(reference.source, reference.id, reference.path);
        await this.#client.upsertMemory(episode);
        this.#recordSuccess(reference.id, reference.path, reference.contentHash);
        result.imported++;
      } catch (error) {
        this.#recordFailure(reference.id, reference.path, reference.contentHash, error);
        classify(error) === "temporary" ? result.pending++ : result.blocked++;
      }
    }
    return result;
  }

  close(): void {
    this.#database.close();
  }

  #read(episodeId: string): EpisodeExportRow | undefined {
    return this.#database.prepare(`
      SELECT episode_id, content_hash, status, attempt_count, next_attempt_at, connection_hash
      FROM episode_exports WHERE episode_id = ?
    `).get(episodeId) as unknown as EpisodeExportRow | undefined;
  }

  #recordSuccess(episodeId: string, workspacePath: string, contentHash: string): void {
    const now = this.#now().toISOString();
    this.#database.prepare(`
      INSERT INTO episode_exports (
        episode_id, workspace_path, content_hash, status, attempt_count,
        next_attempt_at, connection_hash, last_error, imported_at, updated_at
      ) VALUES (?, ?, ?, 'current', 1, NULL, ?, NULL, ?, ?)
      ON CONFLICT (episode_id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        content_hash = excluded.content_hash,
        status = 'current',
        attempt_count = episode_exports.attempt_count + 1,
        next_attempt_at = NULL,
        connection_hash = excluded.connection_hash,
        last_error = NULL,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at
    `).run(episodeId, workspacePath, contentHash, this.#connectionHash, now, now);
  }

  #recordFailure(episodeId: string, workspacePath: string, contentHash: string, error: unknown): void {
    const now = this.#now();
    const kind = classify(error);
    const current = this.#read(episodeId);
    const attempts = current
      && current.content_hash === contentHash
      && current.connection_hash === this.#connectionHash
      ? current.attempt_count
      : 0;
    const nextAttemptAt = new Date(
      now.getTime() + (kind === "temporary" ? retryDelayMs(attempts + 1) : 6 * 60 * 60_000),
    ).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.#database.prepare(`
      INSERT INTO episode_exports (
        episode_id, workspace_path, content_hash, status, attempt_count,
        next_attempt_at, connection_hash, last_error, imported_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)
      ON CONFLICT (episode_id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        content_hash = excluded.content_hash,
        status = excluded.status,
        attempt_count = CASE
          WHEN episode_exports.content_hash = excluded.content_hash
            AND episode_exports.connection_hash = excluded.connection_hash
          THEN episode_exports.attempt_count + 1 ELSE 1 END,
        next_attempt_at = excluded.next_attempt_at,
        connection_hash = excluded.connection_hash,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      episodeId,
      workspacePath,
      contentHash,
      kind === "temporary" ? "pending" : "blocked",
      nextAttemptAt,
      this.#connectionHash,
      message,
      now.toISOString(),
    );
  }
}

export function createNmemEpisodeReconciler(
  options: NmemEpisodeReconcilerOptions,
): NmemEpisodeReconciler {
  return new SqliteNmemEpisodeReconciler(options);
}

function committedEpisodes(status: ReturnType<Runtime["status"]>): Array<{ id: string; path: string }> {
  const references = new Map<string, string>();
  for (const activity of status.activities) {
    if (activity.status !== "recorded" || !activity.receipt) continue;
    for (const episode of activity.receipt.episodes) references.set(episode.id, episode.path);
  }
  return [...references].map(([id, episodePath]) => ({ id, path: episodePath }));
}

function workspaceFile(root: string, relativePath: string): string {
  const canonicalRoot = realpathSync(root);
  const resolved = path.resolve(canonicalRoot, relativePath);
  const canonicalTarget = realpathSync(resolved);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Episode path escapes the Agent Workspace: ${relativePath}`);
  }
  return canonicalTarget;
}

function parseEpisode(source: string, expectedId: string, workspacePath: string): NmemMemoryUpsert {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source);
  if (!match) throw new Error(`Episode ${expectedId} has no valid frontmatter`);
  const metadata = parse(match[1] ?? "") as unknown;
  if (!isObject(metadata) || metadata.id !== expectedId) {
    throw new Error(`Episode ${expectedId} does not preserve its Receipt identity`);
  }
  const segmentId = requiredString(metadata.segmentId, "segmentId");
  const occurredAt = requiredString(metadata.occurredAt, "occurredAt");
  const importance = requiredNumber(metadata.importance, "importance");
  if (importance < 0 || importance > 1) throw new Error("Episode importance must be between 0 and 1");
  const labels = requiredStrings(metadata.labels, "labels");
  const body = (match[2] ?? "").trim();
  const titleMatch = /^#\s+(.+)\r?\n(?:\r?\n)?([\s\S]*)$/u.exec(body);
  if (!titleMatch || !(titleMatch[1] ?? "").trim() || !(titleMatch[2] ?? "").trim()) {
    throw new Error(`Episode ${expectedId} requires a title and replayable scene`);
  }
  const eventDate = new Date(occurredAt);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(occurredAt) || Number.isNaN(eventDate.valueOf())) {
    throw new Error("Episode occurredAt must be an ISO timestamp");
  }
  return {
    id: expectedId,
    title: (titleMatch[1] ?? "").trim(),
    content: (titleMatch[2] ?? "").trim(),
    source: "loom-episode",
    importance,
    labels,
    event_start: occurredAt.slice(0, 10),
    temporal_context: "past",
    unit_type: "event",
    metadata: {
      loom_episode_id: expectedId,
      loom_segment_id: segmentId,
      loom_workspace_path: workspacePath,
    },
  };
}

function classify(error: unknown): NmemRequestError["kind"] {
  return error instanceof NmemRequestError ? error.kind : "incompatible";
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 30_000 * (2 ** Math.min(attempt - 1, 7)));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Episode ${name} must be a non-empty string`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Episode ${name} must be a number`);
  return value;
}

function requiredStrings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`Episode ${name} must be an array of non-empty strings`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
