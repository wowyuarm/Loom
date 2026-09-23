import type { Context } from '@deepseek-ai/cordis'
import { defaultCaps, registerMaterials, type MaterialCaps } from './projection.ts'
import { registerMemoryWrite } from './memory-write.ts'

export interface MaterialsConfig {
  /** Agent workspace root; material files are read and written relative to it. */
  workspace: string
  /** Per-material byte caps; unset materials fall back to defaults. */
  caps?: Partial<MaterialCaps>
}

export const name = 'loom-materials'
export const inject = ['systemPrompt', 'tools', 'clock']

export function apply(ctx: Context, config: MaterialsConfig): void {
  const caps: MaterialCaps = { ...defaultCaps, ...config.caps }
  registerMaterials(ctx, config.workspace, caps)
  registerMemoryWrite(ctx, config.workspace)
}

export { defaultCaps } from './projection.ts'
export type { MaterialCaps } from './projection.ts'
export {
  materialPaths,
  notesDir,
  memoryCoreOf,
  memoryIndexOf,
  upsertMemoryRouting,
} from './layout.ts'
