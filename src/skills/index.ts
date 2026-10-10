/**
 * The agent's own skills: discovery scoped to the skills Loom ships plus the
 * ones the agent keeps in its workspace, and nothing else.
 *
 * Wraps the Harness filesystem provider with its default roots off, so project
 * (`.dsh/skills`, `.agents/skills`) and user (`~/.dsh/skills`, `~/.agents/skills`)
 * roots never leak in — the agent is one continuous individual, not a checkout
 * with a user behind it, and a skill it did not write (or one we did not ship)
 * is not something it should find. Same shape as the per-Member provider in
 * `dsh-agent-team`, minus the per-Member mounting: there is exactly one agent
 * here and its directory is provisioned by the workspace scaffold.
 *
 * @module loom/skills
 */

import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
  SkillRegistry,
} from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

/**
 * Skills shipped with Loom: the `core-skills/` directory beside this plugin's built output
 * (`lib/core-skills/`, copied there by the build, which `tsc` alone would not carry) or beside
 * the source tree when this module runs from `src/` in a test.
 */
export function bundledSkillsDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [resolve(here, '../core-skills'), resolve(here, '../../core-skills')]) {
    if (existsSync(candidate)) return candidate
  }
  return resolve(here, '../core-skills')
}

export interface SkillsConfig {
  /** The agent's workspace root; its own skills live in `<workspace>/skills`. */
  workspace: string
}

export const name = 'skills'
export const inject = ['skills']

export function apply(ctx: Context, config: SkillsConfig): void {
  const skills = ctx.get('skills') as SkillRegistry | undefined
  // A deployment without the skill registry keeps its agent; it simply carries no skill catalog.
  if (skills === undefined) return
  const privateDirectory = resolve(config.workspace, 'skills')
  skills.registerProvider(
    control =>
      new AgentSkillProvider(ctx, control, {
        bundled: bundledSkillsDirectory(),
        private: privateDirectory,
      }),
  )
}

/**
 * The bundled read-only skills first, then the agent's own writable directory.
 * Both sit at the custom rank, and discovery keeps the first root's same-name
 * candidate, so a shipped skill stays stable while the agent adds its own under
 * their own names.
 */
export class AgentSkillProvider implements SkillProvider {
  readonly name: string
  private readonly wrapped: FileSystemSkillProvider

  constructor(ctx: Context, control: SkillProviderControl, roots: { bundled: string; private: string }) {
    this.name = `loom-agent:${roots.private}`
    this.wrapped = new FileSystemSkillProvider(ctx, control, {
      providerName: this.name,
      includeDefaultRoots: false,
      customSkillDirs: [roots.bundled, roots.private],
    })
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    return this.wrapped.list(options)
  }

  async get(
    candidate: SkillCandidate,
    options: SkillLookupOptions,
  ): Promise<SkillDefinition | undefined> {
    return this.wrapped.get(candidate, options)
  }

  async dispose(): Promise<void> {
    await this.wrapped.dispose()
  }
}
