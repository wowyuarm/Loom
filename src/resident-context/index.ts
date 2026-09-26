import type { Context } from '@deepseek-ai/cordis'
import { defaultCaps, registerResidentContext, type ResidentContextCaps } from './projection.ts'
import { registerMemoryWrite } from './memory-write.ts'

export interface ResidentContextConfig {
  /** Agent workspace root; resident files are read and written relative to it. */
  workspace: string
  /** Per-file byte caps; unset files fall back to defaults. */
  caps?: Partial<ResidentContextCaps>
  /** Override the memory-model guidance section; defaults to the shipped guidance. */
  mindGuidance?: string
}

export const name = 'resident-context'
export const inject = ['systemPrompt', 'tools', 'clock']

export function apply(ctx: Context, config: ResidentContextConfig): void {
  const caps: ResidentContextCaps = { ...defaultCaps, ...config.caps }
  registerResidentContext(ctx, config.workspace, caps, {
    ...(config.mindGuidance === undefined ? {} : { mindGuidance: config.mindGuidance }),
  })
  registerMemoryWrite(ctx, config.workspace)
}

export { defaultCaps, DEFAULT_MIND_GUIDANCE } from './projection.ts'
export type { ResidentContextCaps, ResidentContextOptions } from './projection.ts'
export {
  residentFiles,
  notesDir,
  memoryCoreOf,
  memoryIndexOf,
  upsertMemoryRouting,
} from './layout.ts'
