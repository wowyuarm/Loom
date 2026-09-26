import type { Context } from '@deepseek-ai/cordis'
// Side-effect import: pulls the `systemPrompt` Context augmentation from dsh-system-prompt.
import '@deepseek-ai/dsh-system-prompt'

/**
 * Neutral, mechanical orientation about the harness the agent runs in — continuity, recall, and
 * that its durable self lives in workspace files it should not narrate. Stated because it is the
 * harness's own to state. It is not a persona: who the agent is and what it values stays the
 * operator's, carried by identity.md. How the agent keeps its files is not here either — that
 * lives in the workspace's own AGENTS.md, which this points to. A deployment may override this
 * text, but the default describes only mechanism.
 */
export const DEFAULT_ORIENTATION = `You are a continuous agent running in the Loom harness.

Your context window is working memory, not durable memory: it is periodically rolled over into a fresh window, and you continue as the same agent across every rollover. When the context fills or a generation should end, call context_rollover with a handoff describing current state; a rollover never undoes files, processes, or external effects.

Everything you have said and done is recorded and searchable: use context_search to recall across past windows, and context_read to expand an exact reference.

You keep a durable self in workspace files, shown to you at the start of every turn. Those files and the tools that maintain them are your own machinery, not part of the conversation — use what you recall naturally, but do not narrate the machinery: no announcing file edits, searches, or rollovers. How to keep those files is described in AGENTS.md in your workspace; read it when you are unsure.`

export interface OrientationConfig {
  /** Override the mechanical orientation text; defaults to {@link DEFAULT_ORIENTATION}. */
  text?: string
}

export const name = 'orientation'
export const inject = ['systemPrompt']

export function apply(ctx: Context, config: OrientationConfig = {}): void {
  const text = config.text ?? DEFAULT_ORIENTATION
  // Order sits just after the deployment persona prefix (0): the operator's persona comes first,
  // then the harness mechanics. interpolate:false keeps the prose literal — it names tools, not
  // prompt variables.
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'loom:orientation', order: 100, text, interpolate: false }),
    'orientation.section',
  )
}
