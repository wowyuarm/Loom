import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { durableWrite } from "../../workspace/workspace-mutation.js";
import type { WorkspaceWriteOutcome } from "../../workspace/workspace-mutation.js";
import { enforceWorkspaceWriteLimit } from "../../workspace/workspace-write-limits.js";

interface WorkspaceFileSnapshot {
  content: Buffer;
  mode: number;
}

interface ThreadWorkspaceSnapshot {
  files: Map<string, WorkspaceFileSnapshot>;
}

export class ThreadWorkspaceTransaction {
  readonly moves: Array<{ source: string; destination: string }> = [];
  #mutated = false;

  private constructor(
    readonly root: string,
    private readonly before: ThreadWorkspaceSnapshot,
  ) {}

  static async begin(root: string): Promise<ThreadWorkspaceTransaction> {
    await mkdir(root, { recursive: true });
    return new ThreadWorkspaceTransaction(root, await snapshot(root));
  }

  get mutated(): boolean {
    return this.#mutated;
  }

  async write(relativePath: string, content: string): Promise<WorkspaceWriteOutcome> {
    // Entries are relative to the threads/ root; enforce against the
    // workspace-relative path so the shared byte-limit table applies.
    try {
      enforceWorkspaceWriteLimit(`threads/${relativePath}`, content);
    } catch (error) {
      return { state: "rejected", error: errorMessage(error) };
    }
    const target = path.join(this.root, relativePath);
    let previous: Buffer | undefined;
    let mode = 0o600;
    try {
      [previous, mode] = await Promise.all([
        readFile(target),
        stat(target).then(value => value.mode & 0o777),
      ]);
    } catch (error) {
      if (!isMissing(error)) return { state: "rejected", error: errorMessage(error) };
    }
    const next = Buffer.from(content, "utf8");
    if (previous?.equals(next)) {
      return {
        state: "rejected",
        error: `Thread file ${relativePath} is unchanged; return NO_CHANGE instead of rewriting it`,
      };
    }
    try {
      await durableWrite(target, next, mode);
    } catch (error) {
      return { state: "uncertain", error: errorMessage(error) };
    }
    this.#mutated = true;
    return { state: "applied" };
  }

  async move(source: string, destination: string): Promise<WorkspaceWriteOutcome> {
    const sourcePath = path.join(this.root, source);
    const destinationPath = path.join(this.root, destination);
    try {
      await stat(sourcePath);
      if (await exists(destinationPath)) {
        return { state: "rejected", error: `Thread move destination ${destination} already exists` };
      }
    } catch (error) {
      return { state: "rejected", error: errorMessage(error) };
    }
    try {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await rename(sourcePath, destinationPath);
    } catch (error) {
      return { state: "uncertain", error: errorMessage(error) };
    }
    this.moves.push({ source, destination });
    this.#mutated = true;
    return { state: "applied" };
  }

  async changedPaths(): Promise<string[]> {
    return diff(this.before, await snapshot(this.root));
  }
}

async function snapshot(root: string): Promise<ThreadWorkspaceSnapshot> {
  const result: ThreadWorkspaceSnapshot = { files: new Map() };
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Thread Workspace cannot contain symbolic link ${relative}`);
      if (entry.isDirectory()) {
        await visit(target, relative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Thread Workspace contains unsupported entry ${relative}`);
      const metadata = await stat(target);
      result.files.set(relative, {
        content: await readFile(target),
        mode: metadata.mode & 0o777,
      });
    }
  }
  await visit(root, "");
  return result;
}

function diff(before: ThreadWorkspaceSnapshot, after: ThreadWorkspaceSnapshot): string[] {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths]
    .filter(relative => {
      const left = before.files.get(relative);
      const right = after.files.get(relative);
      return !left || !right || left.mode !== right.mode || !left.content.equals(right.content);
    })
    .sort();
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
