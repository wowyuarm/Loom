import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface WorkspaceFileSnapshot {
  content: Buffer;
  mode: number;
}

interface ThreadWorkspaceSnapshot {
  directories: string[];
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

  async write(relativePath: string, content: string): Promise<void> {
    const target = path.join(this.root, relativePath);
    let previous: Buffer | undefined;
    let mode = 0o600;
    try {
      [previous, mode] = await Promise.all([
        readFile(target),
        stat(target).then(value => value.mode & 0o777),
      ]);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const next = Buffer.from(content, "utf8");
    if (previous?.equals(next)) {
      throw new Error(`Thread file ${relativePath} is unchanged; return NO_CHANGE instead of rewriting it`);
    }
    await atomicWrite(target, next, mode);
    this.#mutated = true;
  }

  async move(source: string, destination: string): Promise<void> {
    const sourcePath = path.join(this.root, source);
    const destinationPath = path.join(this.root, destination);
    await stat(sourcePath);
    if (await exists(destinationPath)) throw new Error(`Thread move destination ${destination} already exists`);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await rename(sourcePath, destinationPath);
    this.moves.push({ source, destination });
    this.#mutated = true;
  }

  async changedPaths(): Promise<string[]> {
    return diff(this.before, await snapshot(this.root));
  }

  async rollback(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
    for (const directory of [...this.before.directories]
      .sort((left, right) => left.split("/").length - right.split("/").length)) {
      await mkdir(path.join(this.root, directory), { recursive: true });
    }
    for (const [relative, file] of this.before.files) {
      const target = path.join(this.root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      await chmod(target, file.mode);
    }
    this.#mutated = false;
    this.moves.length = 0;
  }
}

async function snapshot(root: string): Promise<ThreadWorkspaceSnapshot> {
  const result: ThreadWorkspaceSnapshot = { directories: [], files: new Map() };
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Thread Workspace cannot contain symbolic link ${relative}`);
      if (entry.isDirectory()) {
        result.directories.push(relative);
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

async function atomicWrite(target: string, content: Buffer, mode: number): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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
