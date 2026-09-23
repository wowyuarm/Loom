import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const projectRoot = resolve(import.meta.dirname, '..')

interface Entry {
  id?: string
  name?: string
  config?: Record<string, unknown>
  disabled?: boolean
}

/**
 * Compose Loom over dsh-base exactly as a launcher does: a profile naming both bundles in
 * order, each bundle's `cordis.patch.yml` resolved and applied by the real app-boot composer.
 * This is the manifest's own test — it proves the patch parses, every plugin name resolves,
 * and Loom's rows land over base's rather than beside them.
 */
async function composeLoomOverBase(): Promise<Entry[]> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-profile-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'loom-test-profile',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'loom'] } },
    }), 'utf8')
    // The profile is the second resolution anchor, so the bundle under development resolves
    // from it the way an installed bundle resolves from the launcher.
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await symlink(projectRoot, join(dir, 'node_modules', 'loom'), 'dir')

    const profile = loadProfileDirectory('dsh', dir, join(projectRoot, 'package.json'), { userLayer: false })
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['@deepseek-ai/dsh-base', 'loom'])
    return composeEntries(profile.layers.map(layer => layer.patches)) as Entry[]
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('loom bundle manifest', () => {
  it('composes over dsh-base: Loom rows mount and base rows are patched, not duplicated', async () => {
    const entries = await composeLoomOverBase()
    const byId = new Map(entries.filter(e => e.id !== undefined).map(e => [e.id, e]))

    // Loom's own rows are present with the package's subpath exports as plugin names.
    expect(byId.get('clock')?.name).toBe('loom/clock')
    expect(byId.get('runtime-state')?.name).toBe('loom/runtime-state')
    expect(byId.get('orientation')?.name).toBe('loom/orientation')
    expect(byId.get('resident-context')?.name).toBe('loom/resident-context')
    expect(byId.get('agent-runtime')?.name).toBe('loom/agent-runtime')
    expect(byId.get('storage-sqlite')?.name).toBe('@deepseek-ai/dsh-storage-sqlite')

    // Base's stack is still there.
    expect(byId.get('agent-loop')?.name).toBe('@deepseek-ai/dsh-agent-loop')
    expect(byId.get('system-prompt')?.name).toBe('@deepseek-ai/dsh-system-prompt')
    expect(byId.get('llm-deepseek')?.name).toBe('@deepseek-ai/dsh-llm-deepseek')

    // One row per id: Loom patched base's rows rather than inserting duplicates.
    const ids = entries.filter(e => e.id !== undefined).map(e => e.id)
    expect(ids.length).toBe(new Set(ids).size)

    // The agent's durable local state is routed to sqlite while base's domains stay on json.
    expect(byId.get('storage-domain')?.config).toMatchObject({
      backend: 'json',
      routes: { loom_runtime_state: 'sqlite' },
    })

    // Identity is the agent's own: base leaves the deployment persona empty and Loom keeps it
    // that way, so identity.md (a resident file the agent maintains) carries it.
    expect(byId.get('system-prompt')?.config).toMatchObject({ personaPrefix: '' })

    // The loop creates no agent from configuration; agent-runtime boots the one agent.
    expect(byId.get('agent-loop')?.config).toMatchObject({ agents: [] })

    // Workspace-rooted: the agent's resident files and its file tools share one directory.
    // `!!js` values stay unevaluated until mount, so the invariant to hold here is that all
    // three rows carry the same workspace expression.
    const workspace = (byId.get('resident-context')?.config as { workspace?: unknown } | undefined)?.workspace
    expect(workspace).toEqual({ __jsExpr: "dshHomePath('loom/workspace')" })
    expect(byId.get('agent-runtime')?.config).toMatchObject({ workspace })
    expect(byId.get('fs-sandbox')?.config).toMatchObject({ cwd: workspace })
    expect(byId.get('storage-sqlite')?.config).toEqual({ path: { __jsExpr: "dshHomePath('loom/runtime-state.db')" } })
  })
})
