/**
 * The mechanical git layer behind the workspace snapshot.
 *
 * It holds no state and makes no judgement: stage whatever the workspace now contains, and if
 * something changed, commit it with a subject naming the turn and the files. Everything the agent
 * wrote is already on disk by the time this runs — the snapshot only records it.
 *
 * Three properties are deliberate:
 *
 * - **Identity travels with the command** (`-c user.name/user.email`), so nothing is written to
 *   `~/.gitconfig` or to the workspace's own `.git/config`, and a machine that never configured
 *   git still snapshots.
 * - **Failures are returned, not thrown.** This is a convenience the agent's turn must survive
 *   without: a missing repository, a held index lock, a full disk, or a broken git all end as an
 *   outcome the caller logs.
 * - **Only text materials are versioned** and that rule lives in the workspace's own `.gitignore`,
 *   which this module writes once if the repository has none (see {@link WORKSPACE_GITIGNORE}).
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The commit identity, inline on every invocation: the harness commits as itself, never as the
 * person who happens to own the machine, and never leaves a trace in any config file.
 */
const IDENTITY = ['-c', 'user.name=Loom', '-c', 'user.email=loom@localhost'] as const

/**
 * What the workspace repository versions: the agent's own text materials.
 *
 * `*` ignores everything, `!` plus a trailing slash re-includes directories (git does not descend
 * into an ignored directory, so without that line nothing below the root could be re-included), and
 * `!*.md` brings back the materials at any depth. `.scratch/` is excluded last, on purpose: it holds cloned and
 * downloaded repositories, which are reading material rather than the agent's own writing — and an
 * embedded repository would otherwise be recorded as a bare gitlink object.
 */
export const WORKSPACE_GITIGNORE = [
  "# The agent's own text materials are versioned; everything else is not.",
  '*',
  '!*/',
  '!*.md',
  '!.gitignore',
  '',
  '# Clones and downloads live here; they are not the agent\'s materials.',
  '.scratch/',
  '',
].join('\n')

/** What one snapshot attempt did. `unavailable` is the only failure shape, and it never throws. */
export type CommitOutcome =
  | { kind: 'committed'; subject: string; files: readonly string[] }
  | { kind: 'unchanged' }
  | { kind: 'unavailable'; reason: string }

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(workspace: string, args: readonly string[]): Promise<RunResult> {
  return new Promise(resolve => {
    execFile(
      'git',
      [...IDENTITY, '-C', workspace, ...args],
      { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** The first line of a git error, which is the part that names the cause without the advice. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? ''
}

/**
 * Write the ignore rule into a repository that has none. An ignore file the agent wrote itself is
 * left exactly as it is — the snapshot does not edit the agent's materials, and this file is one of
 * them. A repository with no ignore rule cannot be staged safely (a 36 MB video would enter the
 * history), so failing to write it is a refusal to commit rather than a degraded commit.
 */
function ensureGitignore(workspace: string): boolean {
  const path = join(workspace, '.gitignore')
  if (existsSync(path)) return true
  try {
    writeFileSync(path, WORKSPACE_GITIGNORE, 'utf8')
    return true
  } catch {
    return false
  }
}

/** A commit subject naming the turn and what moved, kept to one readable line. */
function subjectFor(turn: number, files: readonly string[]): string {
  const named = files.slice(0, 6).join(', ')
  const rest = files.length > 6 ? ` (+${files.length - 6} more)` : ''
  return `turn ${turn}: ${named}${rest}`
}

/**
 * Snapshot the workspace after a committed turn: exactly one commit when something changed, none
 * when nothing did (an empty commit would pollute every later `git blame`).
 */
export async function commitWorkspaceTurn(workspace: string, turn: number): Promise<CommitOutcome> {
  const inside = await run(workspace, ['rev-parse', '--git-dir'])
  if (inside.code !== 0) return { kind: 'unavailable', reason: 'the workspace is not a git repository' }
  if (!ensureGitignore(workspace)) return { kind: 'unavailable', reason: 'could not write .gitignore' }

  const staged = await run(workspace, ['add', '-A'])
  if (staged.code !== 0) return { kind: 'unavailable', reason: `git add failed: ${firstLine(staged.stderr)}` }

  const changed = await run(workspace, ['diff', '--cached', '--quiet'])
  if (changed.code === 0) return { kind: 'unchanged' }
  if (changed.code !== 1) return { kind: 'unavailable', reason: `git diff failed: ${firstLine(changed.stderr)}` }

  const listed = await run(workspace, ['diff', '--cached', '--name-only'])
  const files = listed.stdout.split('\n').map(name => name.trim()).filter(name => name !== '')
  const subject = subjectFor(turn, files)
  const committed = await run(workspace, ['commit', '--quiet', '-m', subject])
  if (committed.code !== 0) return { kind: 'unavailable', reason: `git commit failed: ${firstLine(committed.stderr)}` }
  return { kind: 'committed', subject, files }
}

/**
 * When each line of a versioned file last changed, keyed by 1-based line number — the raw material
 * of a per-entry age. `undefined` means "cannot say", which the caller renders as no ages at all:
 * the file may be outside any repository, have no commit yet, or belong to a broken one.
 *
 * Synchronous because its caller is a prompt provider, which assembles text synchronously; the
 * timeout keeps a wedged git from holding a turn open.
 */
export function lineModifiedTimes(workspace: string, relPath: string): Map<number, number> | undefined {
  try {
    const output = execFileSync(
      'git',
      [...IDENTITY, '-C', workspace, 'blame', '--line-porcelain', '--', relPath],
      { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return parseBlame(output)
  } catch {
    return undefined
  }
}

/**
 * Read `git blame --line-porcelain`. Each record carries its own `author-time` and ends with the
 * line's content behind a tab, so counting content lines yields the 1-based line number the record
 * describes. An uncommitted line blames as "Not Committed Yet" with the current time, which reads
 * as today — the truth from blame's own point of view.
 */
export function parseBlame(output: string): Map<number, number> {
  const times = new Map<number, number>()
  let line = 0
  for (const text of output.split('\n')) {
    if (text.startsWith('\t')) {
      line += 1
      continue
    }
    if (text.startsWith('author-time ')) {
      const seconds = Number(text.slice('author-time '.length))
      if (Number.isFinite(seconds)) times.set(line + 1, seconds * 1000)
    }
  }
  return times
}
