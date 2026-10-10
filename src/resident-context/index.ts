import type { Context } from '@deepseek-ai/cordis'
import { defaultCaps, registerResidentContext, type ResidentContextCaps } from './projection.ts'
import { ensureWorkspaceScaffold } from './scaffold.ts'
import { registerResidentShapeReminders } from './shape-reminders.ts'
import { registerResidentWriteBudget } from './write-budget.ts'

export interface ResidentContextConfig {
  /** Agent workspace root; resident files are read and written relative to it. */
  workspace: string
  /** Per-file byte caps; unset files fall back to defaults. */
  caps?: Partial<ResidentContextCaps>
}

export const name = 'resident-context'
export const inject = ['systemPrompt', 'tools']

export function apply(ctx: Context, config: ResidentContextConfig): void {
  // Materialize the workspace skeleton on mount (idempotent), so the agent never has to conjure
  // its own file layout and a fresh deployment wakes into the first-waking prompt.
  ensureWorkspaceScaffold(config.workspace)
  const caps: ResidentContextCaps = { ...defaultCaps, ...config.caps }
  registerResidentContext(ctx, config.workspace, caps)
  // The agent maintains every resident file — including memory and its index — with the generic
  // write/edit tools; no dedicated tool. This flags a resident file the moment such a write pushes
  // it toward its cap, so the prune signal reaches the agent while it still holds the context.
  registerResidentWriteBudget(ctx, config.workspace, caps)
  // The shape the materials are meant to keep, riding the read results of attention and threads:
  // the workspace's own instructions say the same things, but a reminder at the moment of reading
  // is the one the writing hand actually sees.
  registerResidentShapeReminders(ctx)
}

export { defaultCaps } from './projection.ts'
export type { ResidentContextCaps } from './projection.ts'
export {
  ensureWorkspaceScaffold,
  bootstrapFile,
  DEFAULT_BOOTSTRAP,
} from './scaffold.ts'
export { seededSkillFiles } from './seeded-skills.ts'
export {
  residentFiles,
  notesDir,
  memoryCoreOf,
  memoryIndexOf,
} from './layout.ts'
