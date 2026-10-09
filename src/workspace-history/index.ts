/**
 * The workspace's own history, kept mechanically by the harness.
 *
 * The agent's materials are plain markdown it rewrites whole, which is exactly what makes them
 * durable between context windows and exactly what loses their history: every save overwrites the
 * last one, so nothing on disk says how long an entry has been carried. Git already answers that
 * question precisely — a whole-file rewrite still blames each unchanged line to the commit that
 * last touched it — so this plugin commits the workspace after every committed turn and exposes the
 * resulting per-line times as `ctx.workspaceHistory`.
 *
 * The agent is not a participant: it keeps writing with its normal file tools, sees no new tool, is
 * told nothing, and cannot tell the difference. Nothing here calls a model, wakes the agent, or
 * changes any material. Failures (no repository, held index lock, full disk) are logged and the
 * turn goes on — this is a convenience the turn must survive without, not a mechanism it depends on.
 */
import type { Context } from '@deepseek-ai/cordis'
import { commitWorkspaceTurn, lineModifiedTimes } from './git.ts'

export const name = 'workspace-history'

export interface WorkspaceHistoryConfig {
  /** The agent's workspace root, which is also the repository root the snapshots are taken in. */
  workspace: string
}

export function apply(ctx: Context, config: WorkspaceHistoryConfig): void {
  const logger = ctx.logger('workspace-history')
  ctx.provide('workspaceHistory', {
    lineModifiedTimes: (relPath: string) => lineModifiedTimes(config.workspace, relPath),
  })

  // One snapshot per committed turn. The `completed` reason is what says the model finished rather
  // than being blocked, aborted, or cut off mid-reply — the same fact after-interaction rides. The
  // queue serializes commits because two turns can end close together and git locks its index.
  let queue: Promise<void> = Promise.resolve()
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const turn = event.data.turn
    queue = queue.then(async () => {
      const outcome = await commitWorkspaceTurn(config.workspace, turn)
      if (outcome.kind === 'committed') logger.info(`workspace snapshot ${outcome.subject}`)
      // Unchanged turns say nothing: they are the common case and would drown the journal.
      else if (outcome.kind === 'unavailable') logger.warn(`workspace snapshot skipped: ${outcome.reason}`)
    })
  })
}

export { WORKSPACE_GITIGNORE, commitWorkspaceTurn, lineModifiedTimes, parseBlame } from './git.ts'
export type { CommitOutcome } from './git.ts'
