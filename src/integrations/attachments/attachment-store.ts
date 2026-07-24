import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { AttachmentKind, AttachmentReference } from "../../attachments/index.js";
import { parseAttachmentReference } from "../../attachments/index.js";

export interface PutAttachment {
  kind: AttachmentKind;
  mediaType: string;
  content: Uint8Array;
  fileName?: string;
}

export interface AttachmentStore {
  put(input: PutAttachment): Promise<AttachmentReference>;
  read(attachment: AttachmentReference): Promise<Buffer>;
  reconcileRetention(options: {
    activeAttachmentIds: Iterable<string>;
    observedAt: Date;
  }): Promise<{ deletedAttachmentIds: string[] }>;
  snapshotWorkspaceFile(options: { workspaceRoot: string; source: string }): Promise<AttachmentReference>;
  copyToWorkspace(
    attachmentId: string,
    options: { workspaceRoot: string; destination: string },
  ): Promise<string>;
  close(): void;
}

export async function openAttachmentStore(options: {
  root: string;
  now?: () => Date;
}): Promise<AttachmentStore> {
  const root = path.resolve(options.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return new FileAttachmentStore(root, options.now ?? (() => new Date()));
}

class FileAttachmentStore implements AttachmentStore {
  readonly #database: DatabaseSync;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly now: () => Date,
  ) {
    this.#database = new DatabaseSync(path.join(root, "attachments.db"));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS attachment_content (
        attachment_id TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        unreferenced_since TEXT,
        deleted_at TEXT
      ) STRICT;
    `);
  }

  async put(input: PutAttachment): Promise<AttachmentReference> {
    return this.#mutate(() => this.#put(input));
  }

  async #put(input: PutAttachment): Promise<AttachmentReference> {
    const content = Buffer.from(input.content);
    const digest = sha256(content);
    const attachment: AttachmentReference = {
      version: 1,
      id: `sha256:${digest}`,
      kind: input.kind,
      mediaType: nonEmpty(input.mediaType, "Attachment mediaType"),
      byteSize: content.length,
      ...(input.fileName ? { fileName: safeFileName(input.fileName) } : {}),
    };
    const objectFile = this.#objectFile(digest);
    await mkdir(path.dirname(objectFile), { recursive: true, mode: 0o700 });
    if (await fileExists(objectFile)) {
      await verifyContent(objectFile, attachment);
      this.#recordAvailable(attachment.id);
      return attachment;
    }
    await writeDurably(objectFile, content);
    await verifyContent(objectFile, attachment);
    this.#recordAvailable(attachment.id);
    return attachment;
  }

  async read(attachment: AttachmentReference): Promise<Buffer> {
    const parsed = parseAttachmentReference(attachment);
    const digest = attachmentDigest(parsed.id);
    const objectFile = this.#objectFile(digest);
    const content = await readFile(objectFile).catch(error => {
      throw new Error(`Attachment ${parsed.id} is unavailable: ${errorMessage(error)}`);
    });
    assertContent(content, parsed);
    return content;
  }

  async reconcileRetention(options: {
    activeAttachmentIds: Iterable<string>;
    observedAt: Date;
  }): Promise<{ deletedAttachmentIds: string[] }> {
    return this.#mutate(() => this.#reconcileRetention(options));
  }

  async #reconcileRetention(options: {
    activeAttachmentIds: Iterable<string>;
    observedAt: Date;
  }): Promise<{ deletedAttachmentIds: string[] }> {
    if (!Number.isFinite(options.observedAt.getTime())) {
      throw new Error("Attachment retention requires a valid observedAt");
    }
    const activeIds = [...new Set(options.activeAttachmentIds)];
    for (const id of activeIds) attachmentDigest(id);
    const observedAt = options.observedAt.toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const clearReference = this.#database.prepare(`
        UPDATE attachment_content
        SET unreferenced_since = NULL
        WHERE attachment_id = ? AND deleted_at IS NULL
      `);
      for (const id of activeIds) clearReference.run(id);
      if (activeIds.length === 0) {
        this.#database.prepare(`
          UPDATE attachment_content
          SET unreferenced_since = ?
          WHERE unreferenced_since IS NULL AND deleted_at IS NULL
        `).run(observedAt);
      } else {
        const placeholders = activeIds.map(() => "?").join(", ");
        this.#database.prepare(`
          UPDATE attachment_content
          SET unreferenced_since = ?
          WHERE unreferenced_since IS NULL AND deleted_at IS NULL
            AND attachment_id NOT IN (${placeholders})
        `).run(observedAt, ...activeIds);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    const cutoff = new Date(options.observedAt.getTime() - ATTACHMENT_RETENTION_MS).toISOString();
    const expired = this.#database.prepare(`
      SELECT attachment_id
      FROM attachment_content
      WHERE deleted_at IS NULL AND unreferenced_since <= ?
      ORDER BY attachment_id
    `).all(cutoff) as unknown as Array<{ attachment_id: string }>;
    const deletedAttachmentIds: string[] = [];
    for (const row of expired) {
      const digest = attachmentDigest(row.attachment_id);
      const objectFile = this.#objectFile(digest);
      await rm(objectFile, { force: true });
      await syncDirectory(path.dirname(objectFile));
      const deleted = this.#database.prepare(`
        UPDATE attachment_content
        SET deleted_at = ?
        WHERE attachment_id = ? AND deleted_at IS NULL AND unreferenced_since <= ?
      `).run(observedAt, row.attachment_id, cutoff);
      if (deleted.changes === 1) deletedAttachmentIds.push(row.attachment_id);
    }
    return { deletedAttachmentIds };
  }

  async copyToWorkspace(
    attachmentId: string,
    options: { workspaceRoot: string; destination: string },
  ): Promise<string> {
    const destination = resolveWorkspaceDestination(options.workspaceRoot, options.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await assertInsideWorkspace(options.workspaceRoot, path.dirname(destination));
    await writeDurably(destination, await this.#readById(attachmentId));
    return destination;
  }

  async snapshotWorkspaceFile(options: {
    workspaceRoot: string;
    source: string;
  }): Promise<AttachmentReference> {
    const source = resolveWorkspacePath(options.workspaceRoot, options.source, "source");
    const canonicalSource = await realpath(source).catch(error => {
      throw new Error(`Attachment source could not be read: ${errorMessage(error)}`);
    });
    await assertInsideWorkspace(options.workspaceRoot, canonicalSource);
    const metadata = await stat(canonicalSource);
    if (!metadata.isFile()) throw new Error("Attachment source must be a file inside the Agent Workspace");
    const mediaType = mediaTypeForFileName(canonicalSource);
    return this.put({
      kind: mediaType.startsWith("image/") ? "image" : "file",
      mediaType,
      fileName: path.basename(canonicalSource),
      content: await readFile(canonicalSource),
    });
  }

  async #readById(attachmentId: string): Promise<Buffer> {
    const digest = attachmentDigest(attachmentId);
    const content = await readFile(this.#objectFile(digest)).catch(error => {
      throw new Error(`Attachment ${attachmentId} is unavailable: ${errorMessage(error)}`);
    });
    if (sha256(content) !== digest) {
      throw new Error(`Attachment ${attachmentId} failed integrity verification`);
    }
    return content;
  }

  #objectFile(digest: string): string {
    return path.join(this.root, "objects", digest.slice(0, 2), digest.slice(2));
  }

  close(): void {
    this.#database.close();
  }

  #recordAvailable(attachmentId: string): void {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("Attachment Store clock returned an invalid time");
    this.#database.prepare(`
      INSERT INTO attachment_content (
        attachment_id, first_seen_at, unreferenced_since, deleted_at
      ) VALUES (?, ?, ?, NULL)
      ON CONFLICT (attachment_id) DO UPDATE SET
        unreferenced_since = excluded.unreferenced_since,
        deleted_at = NULL
    `).run(attachmentId, now.toISOString(), now.toISOString());
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(() => {}, () => {});
    return result;
  }
}

const ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

async function writeDurably(target: string, content: Buffer): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
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

async function verifyContent(file: string, attachment: AttachmentReference): Promise<void> {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error(`Attachment ${attachment.id} is not stored as a file`);
  assertContent(await readFile(file), attachment);
}

function assertContent(content: Buffer, attachment: AttachmentReference): void {
  if (content.length !== attachment.byteSize || `sha256:${sha256(content)}` !== attachment.id) {
    throw new Error(`Attachment ${attachment.id} failed integrity verification`);
  }
}

function attachmentDigest(id: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(id);
  if (!match) throw new Error("Attachment reference requires a sha256 id");
  return match[1]!;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeFileName(value: string): string {
  const fileName = path.posix.basename(path.win32.basename(nonEmpty(value, "Attachment fileName")));
  if (!fileName || fileName === "." || fileName === ".." || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw new Error("Attachment fileName is invalid");
  }
  return fileName;
}

function resolveWorkspaceDestination(workspaceRoot: string, requestedPath: string): string {
  return resolveWorkspacePath(workspaceRoot, requestedPath, "destination");
}

function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  label: "source" | "destination",
): string {
  const destination = nonEmpty(requestedPath, "Attachment destination");
  if (path.win32.isAbsolute(destination) && !path.isAbsolute(destination)) {
    throw new Error(`Attachment ${label} must stay inside the Agent Workspace`);
  }
  if (destination === "~" || destination.startsWith("~/") || destination.startsWith("~\\")
    || destination.split(/[\\/]+/).includes("..")) {
    throw new Error(`Attachment ${label} must stay inside the Agent Workspace`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(destination) ? path.resolve(destination) : path.resolve(root, destination);
  if (resolved === root) throw new Error(`Attachment ${label} must name a file inside the Agent Workspace`);
  return resolved;
}

async function assertInsideWorkspace(workspaceRoot: string, destinationParent: string): Promise<void> {
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(path.resolve(workspaceRoot)),
    realpath(destinationParent),
  ]);
  const relative = path.relative(canonicalRoot, canonicalParent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Attachment destination must stay inside the Agent Workspace");
  }
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mediaTypeForFileName(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}
