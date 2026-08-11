/**
 * Byte-level hard limits on Cognitive-Organ-maintained Workspace files.
 *
 * These are Harness-owned guardrails against unbounded file growth (the Xi
 * threads/index.md runaway), not Individual behavior configuration. Limits are
 * keyed by file responsibility and applied uniformly to every Instance; they
 * do not impose any structure on md content. Matching is by workspace-relative
 * path. A write that exceeds its file's limit is rejected with a recoverable
 * error so the organ can trim and retry in the same turn (no whole mutation
 * rollback). Paths with no rule are not limited.
 */

const kiB = 1024;

const exact = (path: string, limitBytes: number) => ({
  label: path,
  limitBytes,
  matches: (relativePath: string) => relativePath === path,
});

/**
 * Precise date-stamped files, e.g. daily/2026-08-09.md and
 * episodes/2026-08-09/<id>.md. Contract lists exactly those shapes; other
 * nested or malformed paths stay unlimited (default pass).
 */
const DATED_DAY = /^daily\/\d{4}-\d{2}-\d{2}\.md$/;
const DATED_EPISODE = /^episodes\/\d{4}-\d{2}-\d{2}\/[^/]+\.md$/;

const datedDaily = (limitBytes: number) => ({
  label: "daily/<day>.md",
  limitBytes,
  matches: (relativePath: string) => DATED_DAY.test(relativePath),
});

const datedEpisode = (limitBytes: number) => ({
  label: "episodes/<day>/<id>.md",
  limitBytes,
  matches: (relativePath: string) => DATED_EPISODE.test(relativePath),
});

const threadLike = (limitBytes: number) => ({
  label: "threads/<line>/thread.md",
  limitBytes,
  // Any write under threads/ that is not the index and not inside a notes/ dir.
  matches: (relativePath: string) =>
    relativePath.startsWith("threads/")
    && relativePath.endsWith("/thread.md")
    && relativePath !== "threads/index.md"
    && !relativePath.includes("/notes/"),
});

/**
 * A recoverable rejection for a single over-limit write. It rejects only the
 * current write (the organ can trim and retry in the same turn); it never
 * triggers a whole-mutation rollback on its own.
 */
export class WorkspaceWriteLimitExceededError extends Error {
  readonly code = "WorkspaceWriteLimitExceeded";
  readonly relativePath: string;
  readonly actualBytes: number;
  readonly limitBytes: number;
  readonly excessBytes: number;

  constructor(relativePath: string, actualBytes: number, limitBytes: number) {
    const excessBytes = actualBytes - limitBytes;
    super(
      `${relativePath} exceeds its ${actualBytes} bytes maximum (${limitBytes} bytes; excess ${excessBytes}). `
      + `Delete duplicated or stale entries, archive / split into dedicated files, then retry the same write with reduced content.`,
    );
    this.name = "WorkspaceWriteLimitExceeded";
    this.relativePath = relativePath;
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
    this.excessBytes = excessBytes;
  }
}

export function isWorkspaceWriteLimitError(error: unknown): error is WorkspaceWriteLimitExceededError {
  return error instanceof WorkspaceWriteLimitExceededError;
}

/**
 * The calibrated per-file byte limits (src constants, not Instance config) and
 * the ordered matchers used to resolve them. Later rules never shadow earlier
 * ones; the matched set is a deliberate allowlist-with-limits.
 */
export const WORKSPACE_WRITE_LIMITS: ReadonlyArray<{
  label: string;
  limitBytes: number;
  matches: (relativePath: string) => boolean;
}> = [
  // Curated material files (whole-file replace).
  exact("attention.md", 64 * kiB),
  exact("facts.json", 64 * kiB),
  exact("identity.md", 64 * kiB),
  exact("memory.md", 256 * kiB),
  exact("behavior/interactivity.md", 64 * kiB),
  exact("behavior/proactivity.md", 64 * kiB),
  // Life Recorder outputs.
  datedDaily(128 * kiB),
  datedEpisode(32 * kiB),
  // Thread Maintainer.
  exact("threads/index.md", 256 * kiB),
  threadLike(256 * kiB),
];

/**
 * Reject a write whose content exceeds the calibrated limit for the file at
 * `relativePath` (workspace-relative). Paths without a rule pass. The thrown
 * error is recoverable: it names the file, the limit, the attempted size and
 * the excess, so the organ can trim and retry in the same turn.
 */
export function enforceWorkspaceWriteLimit(relativePath: string, content: string | Buffer): void {
  if (!relativePath) return;
  const actual = Buffer.byteLength(content, "utf8");
  for (const rule of WORKSPACE_WRITE_LIMITS) {
    if (rule.matches(relativePath)) {
      if (actual > rule.limitBytes) {
        const excess = actual - rule.limitBytes;
        const error = new Error(
          `${relativePath} exceeds its ${actual} bytes maximum (${rule.limitBytes} bytes; excess ${excess}). `
          + `Delete duplicated or stale entries, archive / split into dedicated files, then retry the same write with reduced content.`,
        );
        error.name = "WorkspaceWriteLimitExceeded";
        throw error;
      }
      return;
    }
  }
}
