/**
 * The turn that failed, said out loud in the two places it has to be said.
 *
 * A failed turn leaves the person with nothing. The loop closes it with the `error` reason, no reply
 * is sent, and nothing in Loom's own pipeline consumed the fact: both listeners that ride a turn's
 * end — `workspace-history` and `after-interaction` — act only on a completed turn. On 2026-10-10 a
 * rate-limited route spent five retries and closed turn 96 as an error; the person saw silence and
 * so did the deployment, and the only record of it was inside the session log's multi-frame zstd.
 * This plugin is the missing consumer, and it reports twice:
 *
 * - **To operations**, through `ctx.logger` on the sink `log` already writes to stderr for
 *   `journalctl --user -u loom.service`: one warning per turn an operator has a reason to look at,
 *   carrying the turn number, the failure type and the upstream's own words.
 * - **To the individual itself**, by appending one fact to `attention/attention.md` — the material
 *   resident-context re-reads every turn, nearest the current input. It learns that its last turn
 *   failed and decides for itself whether to say anything about it.
 *
 * The record is a fact and nothing else: what turn, what failure, what the upstream said. It states
 * no rule, gives no instruction, and asks for no behaviour — the agent's own file may drop it
 * whenever the agent next rewrites that file, and that is fine. The durable record is the log line.
 *
 * ## Which endings are reported, and why not the rest
 *
 * A turn end is not a verdict, so each reason is read on its own terms rather than treated as "not
 * completed, therefore failure" (`TurnEndReasonMap` in `@deepseek-ai/dsh-session`):
 *
 * | reason | operations | the individual | why |
 * |---|---|---|---|
 * | `error` | warn | record | the turn failed: the answer was never produced |
 * | `interrupted` | warn | record | a crash-orphaned turn was closed after the fact |
 * | `max-tokens` | warn | — | a step reached its output ceiling **even if a plugin continued the turn and it finished**; calling that a failure would put a falsehood in the one channel reserved for facts |
 * | `blocked` | warn | — | a pre-step was refused. The work did not run, but the reason type carries no cause, and "blocked" alone tells the individual nothing it can use |
 * | `aborted` | — | — | a cancellation request interrupted the turn; a person's own stop is not a fault |
 * | `completed`, `forked` | — | — | nothing happened to report; fork seeds are not a live ending |
 *
 * ## Known limitation: the record's version belongs to the next successful turn
 *
 * The record is written by a turn that failed, but a workspace snapshot is committed only by a turn
 * that succeeded (`workspace-history` rides `reason.kind === 'completed'`). So the file change this
 * plugin makes sits uncommitted until the *next* successful turn commits it, and in the workspace's
 * history the record appears to have been written by that later turn. The data is not lost — it is
 * on disk immediately and the next snapshot carries it — only its attribution is wrong, and the age
 * derived from that history will read one turn too young. This is accepted deliberately: teaching
 * `workspace-history` to commit on failed turns would change what a snapshot means, which is a
 * different change than this one.
 *
 * The upstream's text is quoted, flattened and bounded, because the log plane carries no
 * conversation content by design: an `LlmFailure` is provider metadata — a routing code, an HTTP
 * status, the upstream's message — rather than anything the agent or the person wrote.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

export const name = 'turn-failures'

export interface TurnFailuresConfig {
  /** The agent's workspace root. The record lands in the attention material inside it. */
  workspace: string
}

/**
 * The attention material, relative to the workspace. The same path resident-context publishes from
 * (`src/resident-context/layout.ts`): the two meet in the deployment's workspace rather than
 * through an import, so a rename there has to be mirrored here.
 */
const ATTENTION_MATERIAL = 'attention/attention.md'

/** The upstream's message is quoted to this many characters, so one failure cannot flood a line. */
const MAX_UPSTREAM_TEXT = 200

/** The upstream message on one line: it arrives with newlines and can be arbitrarily long. */
function summarise(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= MAX_UPSTREAM_TEXT ? flat : `${flat.slice(0, MAX_UPSTREAM_TEXT - 1)}…`
}

/** The failure type and upstream summary for one reason: what happened, in as few facts as hold it. */
export function failureDetail(reason: TurnEndReason): string {
  // Only `error` carries a routing code and the upstream's own message, which is the part an
  // operator cannot reconstruct from anywhere else; every other kind names itself.
  if (reason.kind !== 'error') return reason.kind
  const { code, status, message } = reason.error
  return `${code}${status === undefined ? '' : ` (HTTP ${status})`} — ${summarise(message)}`
}

/** What one turn end is worth saying, and where. */
export type TurnEndReport =
  /** Nothing to say: the turn completed, a person stopped it, or it is a fork seed. */
  | { readonly kind: 'silent' }
  /** Operations only: worth a line in the journal, but not a fact about the individual. */
  | { readonly kind: 'warn'; readonly message: string }
  /** A failed turn: the journal line, and the one fact appended to the individual's material. */
  | { readonly kind: 'record'; readonly message: string; readonly line: string }

/**
 * Decide what one turn end is worth. A reason is read on its own terms rather than as "not
 * `completed`, therefore failure" — `max-tokens` in particular can close a turn that a plugin
 * carried to a perfectly good finish, and `aborted` is the person's own stop.
 * @param turn - the turn number the loop ended.
 * @param reason - why it ended.
 * @returns what to log, what to record, or that there is nothing to say.
 */
export function reportFor(turn: number, reason: TurnEndReason): TurnEndReport {
  switch (reason.kind) {
    case 'completed':
    case 'aborted':
    case 'forked':
      return { kind: 'silent' }
    case 'max-tokens':
      // The ceiling was reached, which is not the same as the turn failing: it may have finished
      // anyway. Operations still wants to know a route is running out of output room.
      return { kind: 'warn', message: `turn ${turn} hit the output-token ceiling` }
    case 'blocked':
      // A refused pre-step: the work did not run. The reason type carries no cause to quote.
      return { kind: 'warn', message: `turn ${turn} blocked: a pre-step was refused` }
    case 'error':
    case 'interrupted': {
      const detail = failureDetail(reason)
      return {
        kind: 'record',
        message: `turn ${turn} failed: ${detail}`,
        line: `- (harness) turn ${turn} failed: ${detail}`,
      }
    }
    default:
      // `TurnEndReasonMap` is merge-extensible. An ending this plugin has never seen is reported as
      // the bare fact it is — never as a failure, the one claim it cannot check.
      return { kind: 'warn', message: `turn ${turn} ended: ${(reason as TurnEndReason).kind}` }
  }
}

/**
 * Append one line to a file, tolerating a file that does not end in a newline. The caller owns
 * serialization: two records written at once would otherwise interleave.
 */
async function appendLine(file: string, line: string): Promise<void> {
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch (error) {
    // A missing material is not an error: resident-context scaffolds it, and a workspace that has
    // not been scaffolded yet still deserves the record. Anything else (permissions, a directory
    // in the file's place) is the caller's to report.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await writeFile(file, `${existing}${separator}${line}\n`, 'utf8')
}

export function apply(ctx: Context, config: TurnFailuresConfig): void {
  const logger = ctx.logger('turn-failures')
  const attentionFile = join(config.workspace, ATTENTION_MATERIAL)
  // Records are appended in arrival order, as workspace-history serializes its commits: two turns
  // can fail close together and each read-modify-write would otherwise drop the other's line.
  let queue: Promise<void> = Promise.resolve()

  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end') return
    const { turn, reason } = event.data
    const report = reportFor(turn, reason)
    if (report.kind === 'silent') return

    logger.warn(report.message)
    if (report.kind === 'warn') return

    queue = queue.then(async () => {
      // The turn is already over by the time this runs: it must not be able to fail a turn, so a
      // record that cannot be written is reported and dropped rather than raised.
      try {
        await appendLine(attentionFile, report.line)
      } catch (error) {
        logger.warn(`turn ${turn} record not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  })
}
