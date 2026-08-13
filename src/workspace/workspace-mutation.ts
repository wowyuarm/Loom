import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { enforceWorkspaceWriteLimit, isWorkspaceWriteLimitError } from "./workspace-write-limits.js";

export interface WorkspaceMutationOptions {
  workspaceRoot: string;
  journalRoot: string;
  operationKey: string;
}

export type OpenedWorkspaceMutation<Result> =
  | { state: "active"; mutation: WorkspaceMutation<Result> }
  | { state: "completed"; result: Result };

export interface WorkspaceMutation<Result> {
  write(relativePath: string, content: string | Buffer): Promise<WorkspaceWriteOutcome>;
  remove(relativePath: string): Promise<WorkspaceWriteOutcome>;
  complete(result: Result): Promise<void>;
  rollback(): Promise<void>;
}

/** Proof status for one whole-file replacement. Callers must decide from this
 * result, rather than guessing from an exception whether a retry is safe. */
export type WorkspaceWriteOutcome =
  | { state: "applied" }
  | { state: "rejected"; error: string }
  | { state: "uncertain"; error: string };

export interface WorkspaceTreeMutation<Result> {
  complete(result: Result): Promise<void>;
  rollback(): Promise<void>;
}

interface FileSnapshot {
  path: string;
  previous: "missing" | "file";
  backup?: string;
  mode?: number;
}

interface PendingManifest {
  version: 1;
  operationKey: string;
  state: "pending";
  kind: "files";
  snapshots: FileSnapshot[];
}

interface TreeEntrySnapshot {
  path: string;
  kind: "directory" | "file";
  mode: number;
  backup?: string;
}

interface PendingTreeManifest {
  version: 1;
  operationKey: string;
  state: "pending";
  kind: "tree";
  treePath: string;
  treeExisted: boolean;
  treeMode?: number;
  entries: TreeEntrySnapshot[];
  snapshots?: FileSnapshot[];
}

interface CompletedManifest {
  version: 1;
  operationKey: string;
  state: "completed";
  kind: "files" | "tree";
  result: unknown;
}

type PendingMutationManifest = PendingManifest | PendingTreeManifest;
type MutationManifest = PendingMutationManifest | CompletedManifest;

class DurableWorkspaceMutation<Result> implements WorkspaceMutation<Result> {
  #manifest: PendingManifest;
  #settled = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly journalDirectory: string,
    manifest: PendingManifest,
  ) {
    this.#manifest = manifest;
  }

  async write(relativePath: string, content: string | Buffer): Promise<WorkspaceWriteOutcome> {
    this.#assertActive();
    let normalized: string;
    try {
      normalized = normalizeRelativePath(relativePath);
      enforceWorkspaceWriteLimit(normalized, content);
    } catch (error) {
      if (isWorkspaceWriteLimitError(error)) return { state: "rejected", error: error.message };
      return { state: "rejected", error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const target = await resolveWorkspaceFile(this.workspaceRoot, normalized);
      if (!this.#manifest.snapshots.some(snapshot => snapshot.path === normalized)) {
        const snapshot = await captureFileSnapshot(target, normalized, this.journalDirectory);
        this.#manifest = {
          ...this.#manifest,
          snapshots: [...this.#manifest.snapshots, snapshot],
        };
        await writeManifest(this.journalDirectory, this.#manifest);
      }
      await replaceFromJournal(this.journalDirectory, target, Buffer.from(content), 0o600);
      return { state: "applied" };
    } catch (error) {
      // A failed rename, chmod, directory sync, or staged-file cleanup can
      // leave the target changed even when the promise rejects. Never let an
      // organ retry such a write inside the same mutation.
      return { state: "uncertain", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async remove(relativePath: string): Promise<WorkspaceWriteOutcome> {
    this.#assertActive();
    let normalized: string;
    try {
      normalized = normalizeRelativePath(relativePath);
    } catch (error) {
      return { state: "rejected", error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const target = await resolveWorkspaceFile(this.workspaceRoot, normalized, false);
      try {
        await lstat(target);
      } catch (error) {
        // Removing a file that is already absent is a provable no-op: the
        // post-condition (target does not exist) already holds, matching the
        // write-side convention where reaching the target state is applied.
        if (isMissing(error)) return { state: "applied" };
        throw error;
      }
      if (!this.#manifest.snapshots.some(snapshot => snapshot.path === normalized)) {
        const snapshot = await captureFileSnapshot(target, normalized, this.journalDirectory);
        this.#manifest = {
          ...this.#manifest,
          snapshots: [...this.#manifest.snapshots, snapshot],
        };
        await writeManifest(this.journalDirectory, this.#manifest);
      }
      await rm(target, { force: true });
      await syncDirectory(path.dirname(target));
      return { state: "applied" };
    } catch (error) {
      // A failed unlink or directory sync can leave the target changed even
      // when the promise rejects. Never let an organ retry such a removal
      // inside the same mutation.
      return { state: "uncertain", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async complete(result: Result): Promise<void> {
    this.#assertActive();
    const serialized = cloneJson(result);
    await writeManifest(this.journalDirectory, {
      version: 1,
      operationKey: this.#manifest.operationKey,
      state: "completed",
      kind: "files",
      result: serialized,
    });
    this.#settled = true;
    await removeBackups(this.journalDirectory);
  }

  async rollback(): Promise<void> {
    if (this.#settled) return;
    await restorePendingMutation(this.workspaceRoot, this.journalDirectory, this.#manifest);
    this.#settled = true;
  }

  #assertActive(): void {
    if (this.#settled) throw new Error("Workspace Mutation is already settled");
  }
}

class DurableWorkspaceTreeMutation<Result> implements WorkspaceTreeMutation<Result> {
  #settled = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly journalDirectory: string,
    private readonly manifest: PendingTreeManifest,
  ) {}

  async complete(result: Result): Promise<void> {
    this.#assertActive();
    await writeManifest(this.journalDirectory, {
      version: 1,
      operationKey: this.manifest.operationKey,
      state: "completed",
      kind: "tree",
      result: cloneJson(result),
    });
    this.#settled = true;
    await removeBackups(this.journalDirectory);
  }

  async rollback(): Promise<void> {
    if (this.#settled) return;
    await restorePendingMutation(this.workspaceRoot, this.journalDirectory, this.manifest);
    this.#settled = true;
  }

  #assertActive(): void {
    if (this.#settled) throw new Error("Workspace Tree Mutation is already settled");
  }
}

export async function beginWorkspaceMutation<Result>(
  options: WorkspaceMutationOptions,
): Promise<OpenedWorkspaceMutation<Result>> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const journalRoot = path.resolve(options.journalRoot);
  const operationKey = nonEmpty(options.operationKey, "Workspace Mutation operationKey");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(journalRoot, { recursive: true, mode: 0o700 }),
  ]);
  const journalDirectory = path.join(journalRoot, operationDirectoryName(operationKey));
  const existing = await readManifest(journalDirectory);
  if (existing) {
    assertOperation(existing, operationKey);
    if (existing.state === "completed") {
      return { state: "completed", result: cloneJson(existing.result) as Result };
    }
    await restorePendingMutation(workspaceRoot, journalDirectory, existing);
  }

  await mkdir(journalDirectory, { recursive: false, mode: 0o700 });
  const manifest: PendingManifest = {
    version: 1,
    operationKey,
    state: "pending",
    kind: "files",
    snapshots: [],
  };
  await writeManifest(journalDirectory, manifest);
  return {
    state: "active",
    mutation: new DurableWorkspaceMutation<Result>(workspaceRoot, journalDirectory, manifest),
  };
}

export async function beginWorkspaceTreeMutation<Result>(
  options: WorkspaceMutationOptions & { treePath: string; protectedFiles?: string[] },
): Promise<
  | { state: "active"; mutation: WorkspaceTreeMutation<Result> }
  | { state: "completed"; result: Result }
> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const journalRoot = path.resolve(options.journalRoot);
  const operationKey = nonEmpty(options.operationKey, "Workspace Mutation operationKey");
  const treePath = normalizeRelativePath(options.treePath);
  const protectedFiles = [...new Set((options.protectedFiles ?? []).map(normalizeRelativePath))];
  if (protectedFiles.some(file => file === treePath || file.startsWith(`${treePath}/`))) {
    throw new Error("Workspace Tree Mutation protected files must be outside the captured tree");
  }
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(journalRoot, { recursive: true, mode: 0o700 }),
  ]);
  const journalDirectory = path.join(journalRoot, operationDirectoryName(operationKey));
  const existing = await readManifest(journalDirectory);
  if (existing) {
    assertOperation(existing, operationKey);
    if (existing.state === "completed") {
      return { state: "completed", result: cloneJson(existing.result) as Result };
    }
    await restorePendingMutation(workspaceRoot, journalDirectory, existing);
  }

  await mkdir(journalDirectory, { recursive: false, mode: 0o700 });
  const captured = await captureTreeSnapshot(workspaceRoot, treePath, journalDirectory);
  const snapshots: FileSnapshot[] = [];
  for (const relativePath of protectedFiles) {
    snapshots.push(await captureFileSnapshot(
      await resolveWorkspaceFile(workspaceRoot, relativePath),
      relativePath,
      journalDirectory,
    ));
  }
  const manifest: PendingTreeManifest = {
    version: 1,
    operationKey,
    state: "pending",
    kind: "tree",
    treePath,
    treeExisted: captured.existed,
    ...(captured.mode === undefined ? {} : { treeMode: captured.mode }),
    entries: captured.entries,
    snapshots,
  };
  await writeManifest(journalDirectory, manifest);
  return {
    state: "active",
    mutation: new DurableWorkspaceTreeMutation<Result>(workspaceRoot, journalDirectory, manifest),
  };
}

export async function recoverWorkspaceMutations(options: {
  workspaceRoot: string;
  journalRoot: string;
}): Promise<void> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const journalRoot = path.resolve(options.journalRoot);
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(journalRoot, { recursive: true, mode: 0o700 }),
  ]);
  const entries = await readdir(journalRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const journalDirectory = path.join(journalRoot, entry.name);
    const manifest = await readManifest(journalDirectory);
    if (!manifest) {
      await rm(journalDirectory, { recursive: true, force: true });
      continue;
    }
    if (entry.name !== operationDirectoryName(manifest.operationKey)) {
      throw new Error(`Workspace Mutation journal identity is invalid: ${journalDirectory}`);
    }
    if (manifest.state === "pending") {
      await restorePendingMutation(workspaceRoot, journalDirectory, manifest);
    }
  }
}

async function captureFileSnapshot(
  target: string,
  relativePath: string,
  journalDirectory: string,
): Promise<FileSnapshot> {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Workspace Mutation target must be a regular file: ${relativePath}`);
    }
    const backup = fileBackupPath(relativePath);
    await durableWrite(path.join(journalDirectory, backup), await readFile(target), metadata.mode & 0o777);
    return { path: relativePath, previous: "file", backup, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (isMissing(error)) return { path: relativePath, previous: "missing" };
    throw error;
  }
}

async function restorePendingMutation(
  workspaceRoot: string,
  journalDirectory: string,
  manifest: PendingMutationManifest,
): Promise<void> {
  if (manifest.kind === "tree") {
    await restoreTreeSnapshot(workspaceRoot, journalDirectory, manifest);
    await restoreFileSnapshots(workspaceRoot, journalDirectory, manifest.snapshots ?? []);
    await rm(journalDirectory, { recursive: true, force: true });
    await syncDirectory(path.dirname(journalDirectory));
    return;
  }
  await restoreFileSnapshots(workspaceRoot, journalDirectory, manifest.snapshots);
  await rm(journalDirectory, { recursive: true, force: true });
  await syncDirectory(path.dirname(journalDirectory));
}

async function restoreFileSnapshots(
  workspaceRoot: string,
  journalDirectory: string,
  snapshots: FileSnapshot[],
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const target = await resolveWorkspaceFile(workspaceRoot, snapshot.path);
    if (snapshot.previous === "missing") {
      await rm(target, { force: true });
      await syncDirectory(path.dirname(target));
      continue;
    }
    if (!snapshot.backup || snapshot.mode === undefined) {
      throw new Error(`Workspace Mutation backup is incomplete for ${snapshot.path}`);
    }
    await replaceFromJournal(
      journalDirectory,
      target,
      await readFile(path.join(journalDirectory, snapshot.backup)),
      snapshot.mode,
    );
  }
}

async function captureTreeSnapshot(
  workspaceRoot: string,
  treePath: string,
  journalDirectory: string,
): Promise<{ existed: boolean; mode?: number; entries: TreeEntrySnapshot[] }> {
  const treeRoot = path.resolve(workspaceRoot, treePath);
  if (!treeRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Workspace Mutation tree must stay inside the Agent Workspace");
  }
  let metadata;
  try {
    metadata = await lstat(treeRoot);
  } catch (error) {
    if (isMissing(error)) return { existed: false, entries: [] };
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Workspace Mutation tree must be a directory: ${treePath}`);
  }
  const entries: TreeEntrySnapshot[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const entryMetadata = await lstat(target);
      if (entryMetadata.isSymbolicLink()) {
        throw new Error(`Workspace Mutation tree cannot contain symbolic link ${relative}`);
      }
      if (entryMetadata.isDirectory()) {
        entries.push({ path: relative, kind: "directory", mode: entryMetadata.mode & 0o777 });
        await visit(target, relative);
        continue;
      }
      if (!entryMetadata.isFile()) {
        throw new Error(`Workspace Mutation tree contains unsupported entry ${relative}`);
      }
      const backup = treeBackupPath(relative);
      await durableWrite(path.join(journalDirectory, backup), await readFile(target), entryMetadata.mode & 0o777);
      entries.push({
        path: relative,
        kind: "file",
        mode: entryMetadata.mode & 0o777,
        backup,
      });
    }
  }
  await visit(treeRoot, "");
  return { existed: true, mode: metadata.mode & 0o777, entries };
}

async function restoreTreeSnapshot(
  workspaceRoot: string,
  journalDirectory: string,
  manifest: PendingTreeManifest,
): Promise<void> {
  const treeRoot = path.resolve(workspaceRoot, manifest.treePath);
  if (!treeRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Workspace Mutation tree must stay inside the Agent Workspace");
  }
  await rm(treeRoot, { recursive: true, force: true });
  if (!manifest.treeExisted) {
    await syncDirectory(path.dirname(treeRoot));
    return;
  }
  await mkdir(treeRoot, { recursive: true });
  if (manifest.treeMode === undefined) {
    throw new Error(`Workspace Mutation tree mode is missing for ${manifest.treePath}`);
  }
  await chmod(treeRoot, manifest.treeMode);
  for (const entry of manifest.entries
    .filter(entry => entry.kind === "directory")
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length)) {
    const directory = path.join(treeRoot, entry.path);
    await mkdir(directory, { recursive: true, mode: entry.mode });
    await chmod(directory, entry.mode);
  }
  for (const entry of manifest.entries.filter(entry => entry.kind === "file")) {
    if (!entry.backup) throw new Error(`Workspace Mutation tree backup is missing for ${entry.path}`);
    await replaceFromJournal(
      journalDirectory,
      path.join(treeRoot, entry.path),
      await readFile(path.join(journalDirectory, entry.backup)),
      entry.mode,
    );
  }
  await syncDirectory(path.dirname(treeRoot));
}

async function resolveWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  createParent = true,
): Promise<string> {
  const target = path.resolve(workspaceRoot, relativePath);
  if (target === workspaceRoot || !target.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Workspace Mutation path must stay inside the Agent Workspace");
  }
  if (createParent) await mkdir(path.dirname(target), { recursive: true });
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(workspaceRoot),
    realpath(path.dirname(target)),
  ]);
  const relative = path.relative(canonicalRoot, canonicalParent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workspace Mutation path must stay inside the Agent Workspace");
  }
  return target;
}

async function replaceFromJournal(
  journalDirectory: string,
  target: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  const staged = path.join(journalDirectory, `staged-${randomUUID()}`);
  await durableWrite(staged, content, mode);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(staged, target);
  await chmod(target, mode);
  await syncDirectory(path.dirname(target));
}

async function writeManifest(directory: string, manifest: MutationManifest): Promise<void> {
  await durableWrite(
    path.join(directory, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"),
    0o600,
  );
}

async function readManifest(directory: string): Promise<MutationManifest | undefined> {
  let source: string;
  try {
    source = await readFile(path.join(directory, "manifest.json"), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Workspace Mutation manifest is invalid: ${directory}`);
  }
  if (!isObject(value)
    || value.version !== 1
    || typeof value.operationKey !== "string"
    || (value.state !== "pending" && value.state !== "completed")) {
    throw new Error(`Workspace Mutation manifest is invalid: ${directory}`);
  }
  if (value.state === "completed") {
    if ((value.kind !== "files" && value.kind !== "tree") || !("result" in value)) {
      throw new Error(`Workspace Mutation result is missing: ${directory}`);
    }
    return value as unknown as CompletedManifest;
  }
  if (value.kind === "tree") {
    if (!isNormalizedRelativePath(value.treePath)
      || typeof value.treeExisted !== "boolean"
      || (value.treeExisted && !isFileMode(value.treeMode))
      || (!value.treeExisted && value.treeMode !== undefined)
      || !Array.isArray(value.entries)
      || !value.entries.every(isTreeEntrySnapshot)
      || (value.snapshots !== undefined
        && (!Array.isArray(value.snapshots) || !value.snapshots.every(isFileSnapshot)))) {
      throw new Error(`Workspace Mutation tree snapshot is invalid: ${directory}`);
    }
    return value as unknown as PendingTreeManifest;
  }
  if (value.kind !== "files" || !Array.isArray(value.snapshots) || !value.snapshots.every(isFileSnapshot)) {
    throw new Error(`Workspace Mutation snapshots are invalid: ${directory}`);
  }
  return value as unknown as PendingManifest;
}

function isTreeEntrySnapshot(value: unknown): value is TreeEntrySnapshot {
  return isObject(value)
    && isNormalizedRelativePath(value.path)
    && isFileMode(value.mode)
    && (value.kind === "directory"
      ? value.backup === undefined
      : value.kind === "file" && value.backup === treeBackupPath(value.path));
}

function isFileSnapshot(value: unknown): value is FileSnapshot {
  return isObject(value)
    && isNormalizedRelativePath(value.path)
    && (value.previous === "missing"
      ? value.backup === undefined && value.mode === undefined
      : value.previous === "file"
        && value.backup === fileBackupPath(value.path)
        && isFileMode(value.mode));
}

async function durableWrite(file: string, content: Buffer, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeBackups(journalDirectory: string): Promise<void> {
  await rm(path.join(journalDirectory, "backups"), { recursive: true, force: true });
  const entries = await readdir(journalDirectory);
  await Promise.all(entries
    .filter(name => name.startsWith("staged-"))
    .map(name => rm(path.join(journalDirectory, name), { force: true })));
  await syncDirectory(journalDirectory);
}

function operationDirectoryName(operationKey: string): string {
  return createHash("sha256").update(operationKey).digest("hex");
}

function fileBackupPath(relativePath: string): string {
  return `backups/${createHash("sha256").update(relativePath).digest("hex")}`;
}

function treeBackupPath(relativePath: string): string {
  return `backups/tree/${createHash("sha256").update(relativePath).digest("hex")}`;
}

function assertOperation(manifest: MutationManifest, operationKey: string): void {
  if (manifest.operationKey !== operationKey) {
    throw new Error("Workspace Mutation operation identity does not match its journal");
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = nonEmpty(value, "Workspace Mutation path").replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized)
    || normalized === "."
    || normalized.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error("Workspace Mutation path must be a normalized relative file path");
  }
  return normalized;
}

function isNormalizedRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeRelativePath(value) === value;
  } catch {
    return false;
  }
}

function isFileMode(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o777;
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Workspace Mutation result must be JSON-serializable");
  return JSON.parse(serialized) as T;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
