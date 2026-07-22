import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FrozenActivity, ThreadActivityObservation } from "../../runtime/index.js";

export type ThreadEvidenceRelation = ThreadActivityObservation["relation"];
export type { ThreadActivityObservation } from "../../runtime/index.js";

export interface ThreadEvidenceReference {
  referenceId: string;
  threadRef: string;
  activityId: string;
  turnId: string;
  relation: ThreadEvidenceRelation;
  paths: string[];
  occurredAt: string;
}

export interface ThreadRecord {
  threadRef: string;
  currentPath: string;
  aliases: string[];
}

interface ThreadEvidenceState {
  version: 1;
  threads: ThreadRecord[];
  references: ThreadEvidenceReference[];
}

export class ThreadEvidenceIndex {
  private constructor(
    private readonly stateFile: string,
    private state: ThreadEvidenceState,
    private readonly nextThreadRef: () => string,
  ) {}

  static async open(
    stateFile: string,
    nextThreadRef: () => string = randomUUID,
  ): Promise<ThreadEvidenceIndex> {
    return new ThreadEvidenceIndex(stateFile, await readState(stateFile), nextThreadRef);
  }

  async record(
    activity: FrozenActivity,
    observations: ThreadActivityObservation[],
  ): Promise<ThreadEvidenceReference[]> {
    const currentReferences: ThreadEvidenceReference[] = [];
    for (const observation of observations) {
      let thread = this.state.threads.find(candidate =>
        candidate.currentPath === observation.threadPath || candidate.aliases.includes(observation.threadPath));
      if (!thread) {
        thread = {
          threadRef: this.#newThreadRef(),
          currentPath: observation.threadPath,
          aliases: [],
        };
        this.state.threads.push(thread);
      }
      const referenceId = `evidence-${activity.segmentId}-${observation.turnId}-${thread.threadRef}`;
      let reference = this.state.references.find(candidate => candidate.referenceId === referenceId);
      if (!reference) {
        const turn = activity.turns.find(candidate => candidate.turnId === observation.turnId);
        if (!turn) throw new Error(`Thread observation has unknown Turn ${observation.turnId}`);
        reference = {
          referenceId,
          threadRef: thread.threadRef,
          activityId: activity.segmentId,
          turnId: observation.turnId,
          relation: observation.relation,
          paths: [...new Set(observation.paths)].sort(),
          occurredAt: turn.endedAt,
        };
        this.state.references.push(reference);
      } else {
        reference.paths = [...new Set([...reference.paths, ...observation.paths])].sort();
        if (observation.relation === "changed") reference.relation = "changed";
      }
      currentReferences.push(reference);
    }
    this.state.threads.sort((left, right) => left.threadRef.localeCompare(right.threadRef));
    this.state.references.sort(compareReferences);
    await this.#persist();
    return [...new Map(currentReferences.map(reference => [reference.referenceId, reference])).values()];
  }

  thread(threadRef: string): ThreadRecord | undefined {
    const thread = this.state.threads.find(candidate => candidate.threadRef === threadRef);
    return thread ? structuredClone(thread) : undefined;
  }

  hasThread(threadRef: string): boolean {
    return this.state.threads.some(thread => thread.threadRef === threadRef);
  }

  reference(referenceId: string): ThreadEvidenceReference | undefined {
    const reference = this.state.references.find(candidate => candidate.referenceId === referenceId);
    return reference ? structuredClone(reference) : undefined;
  }

  references(threadRef: string): ThreadEvidenceReference[] {
    return this.state.references
      .filter(reference => reference.threadRef === threadRef)
      .sort(compareReferences)
      .map(reference => structuredClone(reference));
  }

  async applyMoves(moves: Array<{ source: string; destination: string }>): Promise<void> {
    for (const move of moves) {
      for (const thread of this.state.threads) {
        if (thread.currentPath === move.source || thread.currentPath.startsWith(`${move.source}/`)) {
          const suffix = thread.currentPath.slice(move.source.length);
          if (!thread.aliases.includes(thread.currentPath)) thread.aliases.push(thread.currentPath);
          thread.currentPath = `${move.destination}${suffix}`;
        }
      }
    }
    await this.#persist();
  }

  #newThreadRef(): string {
    const threadRef = this.nextThreadRef();
    if (!threadRef || this.state.threads.some(thread => thread.threadRef === threadRef)) {
      throw new Error(`Thread reference must be non-blank and unique: ${threadRef}`);
    }
    return threadRef;
  }

  async #persist(): Promise<void> {
    await writeState(this.stateFile, this.state);
  }
}

export function compareReferences(
  left: ThreadEvidenceReference,
  right: ThreadEvidenceReference,
): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.referenceId.localeCompare(right.referenceId);
}

async function readState(stateFile: string): Promise<ThreadEvidenceState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.threads) || !Array.isArray(parsed.references)) {
      throw new Error("Thread evidence state has an invalid structure");
    }
    return parsed as unknown as ThreadEvidenceState;
  } catch (error) {
    if (isMissing(error)) return { version: 1, threads: [], references: [] };
    throw error;
  }
}

async function writeState(stateFile: string, state: ThreadEvidenceState): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, stateFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
