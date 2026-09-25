import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const projectRoot = resolve(import.meta.dirname, '..')

/** The loader's `!!js` tag, so a preset parses here the way the roster parses it. */
const JsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
})
const presetSchema = JSON_SCHEMA.extend(JsExpr)

interface Entry {
  id?: string
  name?: string
  config?: Record<string, unknown> | Entry[]
  insert?: Entry[]
  group?: boolean
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
    expect(byId.get('log')?.name).toBe('loom/log')
    expect(byId.get('runtime-state')?.name).toBe('loom/runtime-state')
    expect(byId.get('orientation')?.name).toBe('loom/orientation')
    expect(byId.get('resident-context')?.name).toBe('loom/resident-context')
    expect(byId.get('agent-runtime')?.name).toBe('loom/agent-runtime')
    expect(byId.get('storage-sqlite')?.name).toBe('@deepseek-ai/dsh-storage-sqlite')
    expect(byId.get('channels')?.name).toBe('loom/channels')
    expect(byId.get('channel-gateway')?.name).toBe('@wowyuarm/dsh-channel-gateway')
    expect(byId.get('channel-telegram')?.name).toBe('@wowyuarm/dsh-channel-gateway/telegram')

    // Base's stack is still there.
    expect(byId.get('agent-loop')?.name).toBe('@deepseek-ai/dsh-agent-loop')
    expect(byId.get('system-prompt')?.name).toBe('@deepseek-ai/dsh-system-prompt')
    expect(byId.get('llm-deepseek')?.name).toBe('@deepseek-ai/dsh-llm-deepseek-api-key')

    // One row per id: Loom patched base's rows rather than inserting duplicates.
    const ids = entries.filter(e => e.id !== undefined).map(e => e.id)
    expect(ids.length).toBe(new Set(ids).size)

    // The agent's durable local state is routed to sqlite while base's domains stay on json.
    expect(byId.get('storage-domain')?.config).toMatchObject({
      backend: 'json',
      routes: { loom_runtime_state: 'sqlite' },
    })

    // Identity is the agent's own: the harness asserts none, base keeps the deployment persona
    // empty, and Loom keeps both that way — identity.md (a resident file the agent maintains)
    // is the only thing that says who the agent is.
    expect(byId.get('system-prompt')?.config).toMatchObject({
      includeHarnessIdentity: false,
      personaPrefix: '',
      personaSuffix: '',
    })

    // The gateway admits nobody until a deployment lists actors: unauthenticated access is
    // not a default.
    expect(byId.get('channel-gateway')?.config).toMatchObject({ allow: [] })

    // The agent plane: the registry is seeded with Loom's preset, which this bundle declares
    // itself — no shipped or user root can supply a preset this deployment would then run.
    expect(byId.get('agent-preset-registry')?.config).toMatchObject({ default: 'loom' })
    expect(byId.get('preset-loom')?.name).toBe('@deepseek-ai/dsh-agent-preset')

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

  it('declares every agent-plane row in the preset and leaves none enabled in the bundle', async () => {
    const entries = await composeLoomOverBase()
    const byId = new Map(entries.filter(e => e.id !== undefined).map(e => [e.id, e]))
    const patches = load(
      await readFile(join(projectRoot, 'presets', 'loom.patch.yml'), 'utf8'),
      { schema: presetSchema },
    ) as Entry[]

    // The preset file is a patch that declares one preset; its plugins are the agent plane.
    const declaration = patches[0]?.insert?.[0]
    expect(declaration?.name).toBe('@deepseek-ai/dsh-agent-preset')
    const definition = declaration?.config as { id?: string; plugins?: Entry[] } | undefined
    expect(definition?.id).toBe('loom')
    const preset = definition?.plugins ?? []

    expect(preset.length).toBeGreaterThan(0)
    // Flatten group rows (e.g. the compaction isolate realm): the invariant is about the leaf
    // capability rows, not the `cordis:group` containers that hold them.
    const leaves: Entry[] = []
    const collect = (rows: Entry[]): void => {
      for (const row of rows) {
        if (row.group === true && Array.isArray(row.config)) collect(row.config as Entry[])
        else leaves.push(row)
      }
    }
    collect(preset)

    for (const row of leaves) {
      expect(row.id).toBeDefined()
      expect(row.name).toMatch(/^@deepseek-ai\//)
      // A preset row whose base counterpart stayed enabled would sit in the global layer too,
      // which every agent inherits — the tool would reach the model without this file naming it.
      expect(byId.get(row.id as string)?.disabled, `base row "${row.id}" is still enabled`).toBe(true)
    }

    // Base's task-execution scaffolding is gone rather than merely undeclared: these rows
    // inject services and prompt sections of their own, which no preset row can suppress.
    for (const id of ['plan-mode', 'goal', 'goal-round-driver', 'command-goal', 'tool-goal', 'tool-todo', 'tool-ralph']) {
      expect(byId.get(id)?.disabled, `scaffolding row "${id}" is still enabled`).toBe(true)
    }

    // Nothing about this deployment leaves the machine except the model request itself. The
    // telemetry exporter, the plugin-package inventory, and the session-log upload are three
    // separate outbound paths, so all three are pinned here — a base addition that re-enables
    // one of them must fail this test rather than quietly start shipping.
    for (const id of ['session-telemetry-otel', 'session-log-deepseek', 'plugin-package-inventory-deepseek']) {
      expect(byId.get(id)?.disabled, `outbound row "${id}" is still enabled`).toBe(true)
    }
  })
})
