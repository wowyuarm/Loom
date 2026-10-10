import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import { AgentSkillProvider, bundledSkillsDirectory } from '../src/skills/index.ts'

/**
 * A skill body. The description is the catalog's only routing entry, and it is parsed as YAML
 * front matter — a bare colon in it breaks the parse and drops the skill silently, so the text
 * below stays colon-free.
 */
function skillBody(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`
}

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'loom-skills-'))
}

/**
 * One registry with Loom's provider mounted over a throwaway workspace. The provider is
 * registered through the registry seam the plugin uses, which is what keeps the test on the
 * scoping behaviour rather than on plugin assembly.
 */
async function mount(
  workspace: string,
): Promise<{ ctx: Context; list: () => Promise<string[]>; load: (name: string) => Promise<string | undefined> }> {
  const ctx = new Context()
  await ctx.plugin(Skills)
  ctx.skills.registerProvider(
    control =>
      new AgentSkillProvider(ctx, control, {
        bundled: bundledSkillsDirectory(),
        private: join(workspace, 'skills'),
      }),
  )
  return {
    ctx,
    list: async () => (await ctx.skills.list({ cwd: workspace })).map(s => s.name),
    load: async (name: string) => (await ctx.skills.get(name, { cwd: workspace }))?.content,
  }
}

async function plant(workspace: string, relative: string, name: string): Promise<void> {
  const directory = join(workspace, relative, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    skillBody(name, `A method kept for reuse, reached for when ${name} comes up again.`),
  )
}

describe('loom skills provider', () => {
  it('discovers the bundled skills Loom ships', async () => {
    const workspace = await tmpWorkspace()
    try {
      const { list } = await mount(workspace)
      expect(await list()).toContain('agent-skill-manager')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('discovers a skill the agent wrote into its own workspace directory', async () => {
    const workspace = await tmpWorkspace()
    try {
      await plant(workspace, 'skills', 'my-method')
      const { list } = await mount(workspace)
      expect(await list()).toContain('my-method')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  /**
   * The whole point of the provider: with default roots off, a skill sitting in the project or
   * user roots — which for this agent would be a skill it did not write — stays invisible. Both
   * roots are planted inside the workspace so the only thing under test is the root selection.
   */
  it('ignores project and user skill roots', async () => {
    const workspace = await tmpWorkspace()
    try {
      await plant(workspace, '.dsh/skills', 'project-skill')
      await plant(workspace, '.agents/skills', 'agents-skill')
      const { list } = await mount(workspace)
      const names = await list()
      expect(names).not.toContain('project-skill')
      expect(names).not.toContain('agents-skill')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('loads the body of a skill it discovered', async () => {
    const workspace = await tmpWorkspace()
    try {
      await plant(workspace, 'skills', 'loaded-method')
      const { list, load } = await mount(workspace)
      expect(await list()).toContain('loaded-method')
      expect(await load('loaded-method')).toContain('# loaded-method')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
