/**
 * The turn that did not complete, said out loud in the two places it has to be said.
 *
 * A failed turn leaves the person with nothing. The loop closes it with a reason other than
 * `completed`, no reply is sent, and nothing in Loom's own pipeline consumed the fact: both
 * listeners that ride a turn's end — `workspace-history` and `after-interaction` — act only on a
 * completed turn. On 2026-10-10 a rate-limited route spent five retries and closed turn 96 as an
 * error; the person saw silence and so did the deployment, and the only record of it was inside the
 * session log's multi-frame zstd. This plugin is the missing consumer, and it reports twice:
 *
 * - **To operations**, through `ctx.logger` on the sink `log` already writes to stderr for
 *   `journalctl --user -u loom.service`. One warning per turn that did not complete, whatever the
 *   reason, carrying the turn number, the failure type and the upstream's own words.
 * - **To the individual itself**, by appending one fact to `attention/attention.md` — the material
 *   resident-context re-reads every turn, nearest the current input. It learns that its last turn
 *   did not succeed and decides for itself whether to say anything about it.
 *
 * The record is a fact and nothing else: what turn, what failure, what the upstream said. It states
 * no rule, gives no instruction, and asks for no behaviour — the agent's own file may drop it
 * whenever the agent next rewrites that file, and that is fine. The durable record is the log line.
 *
 * ## Known limitation: the record's version belongs to the next successful turn
 *
 * The record is written by a turn that did not succeed, but a workspace snapshot is committed only
 * by a turn that did (`workspace-history` rides `reason.kind === 'completed'`). So the file change
 * this plugin makes sits uncommitted until the *next* successful turn commits it, and in the
 * workspace's history the record appears to have been written by that later turn. The data is not
 * lost — it is on disk immediately and the next snapshot carries it — only its attribution is
 * wrong, and the age derived from that history will read one turn too young. This is accepted
 * deliberately: teaching `workspace-history` to commit on failed turns would change what a snapshot
 * means, which is a different change than this one.
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
  // Every kind other than `completed` names itself; only `error` carries a routing code and the
  // upstream's own message, which is the part an operator cannot reconstruct from anywhere else.
  if (reason.kind !== 'error') return reason.kind
  const { code, status, message } = reason.error
  return `${code}${status === undefined ? '' : ` (HTTP ${status})`} — ${summarise(message)}`
}

/** The one fact appended to the individual's attention material. No rule, no request, no advice. */
export function recordLine(turn: number, reason: TurnEndReason): string {
  return `- (harness) turn ${turn} did not complete: ${failureDetail(reason)}`
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
    if (reason.kind === 'completed') return

    logger.warn(`turn ${turn} did not complete: ${failureDetail(reason)}`)

    queue = queue.then(async () => {
      // The turn is already over by the time this runs: it must not be able to fail a turn, so a
      // record that cannot be written is reported and dropped rather than raised.
      try {
        await appendLine(attentionFile, recordLine(turn, reason))
      } catch (error) {
        logger.warn(`turn ${turn} record not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  })
}
