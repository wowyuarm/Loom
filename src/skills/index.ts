/**
 * The agent's own skills, and nothing else.
 *
 * Wraps the Harness filesystem provider with its default roots off and a single root — the
 * agent's `skills/` directory — so project (`.dsh/skills`, `.agents/skills`) and user
 * (`~/.dsh/skills`, `~/.agents/skills`) roots never leak in. The agent is one continuous
 * individual, not a checkout with a user behind it, and a skill it did not write is not
 * something it should find.
 *
 * There is deliberately no bundled root. Loom's starting skills are seeded into the workspace
 * once by the scaffold and then belong to the agent: a read-only shipped copy would shadow a
 * same-named one of its own forever, and the one thing that must track a layout that keeps
 * changing is exactly the thing it has to be able to revise.
 *
 * @module loom/skills
 */

import { resolve } from 'node:path'
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

export interface SkillsConfig {
  /** The agent's workspace root; its skills live in `<workspace>/skills`. */
  workspace: string
}

export const name = 'skills'
export const inject = ['skills']

export function apply(ctx: Context, config: SkillsConfig): void {
  const skills = ctx.get('skills') as SkillRegistry | undefined
  // A deployment without the skill registry keeps its agent; it simply carries no skill catalog.
  if (skills === undefined) return
  skills.registerProvider(control => new AgentSkillProvider(ctx, control, resolve(config.workspace, 'skills')))
}

/** One root, the agent's own `skills/` directory, with every default root off. */
export class AgentSkillProvider implements SkillProvider {
  readonly name: string
  private readonly wrapped: FileSystemSkillProvider

  constructor(ctx: Context, control: SkillProviderControl, private readonly directory: string) {
    this.name = `loom-agent:${directory}`
    this.wrapped = new FileSystemSkillProvider(ctx, control, {
      providerName: this.name,
      includeDefaultRoots: false,
      customSkillDirs: [directory],
    })
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    return this.wrapped.list(options)
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    return this.wrapped.get(candidate, options)
  }

  async dispose(): Promise<void> {
    await this.wrapped.dispose()
  }
}
