import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ManualClock } from '../src/clock/index.ts'
import { applyBudget } from '../src/resident-context/budget.ts'
import { registerResidentContext, defaultCaps } from '../src/resident-context/projection.ts'
import { ensureWorkspaceScaffold } from '../src/resident-context/scaffold.ts'
import { lineModifiedTimes } from '../src/workspace-history/index.ts'

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'loom-resident-context-'))
}

async function writeResidentFile(workspace: string, rel: string, text: string): Promise<void> {
  const path = join(workspace, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

const DAY_ONE = '2026-09-25T10:00:00+08:00'
const DAY_THIRTEEN = '2026-10-08T10:00:00+08:00'
const DAY_TWENTY_TWO = '2026-10-22T10:00:00+08:00'

/** A commit in the workspace repository with pinned dates, so entry ages are exact. */
function commitAt(workspace: string, isoDate: string, message: string): void {
  const env = { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate }
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-C', workspace]
  execFileSync('git', [...identity, 'add', '-A'], { encoding: 'utf8', env })
  execFileSync('git', [...identity, 'commit', '-q', '-m', message], { encoding: 'utf8', env })
}

/** Compose the projection over a workspace whose history is the real one on disk. */
async function assemble(
  workspace: string,
  now: number,
  caps = defaultCaps,
  history = true,
): Promise<{ contexts: Map<string, string>, names: string[] }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  ctx.provide('clock', new ManualClock(now))
  // `history: false` is the deployment that never mounted workspace-history at all.
  if (history) {
    ctx.provide('workspaceHistory', { lineModifiedTimes: (relPath: string) => lineModifiedTimes(workspace, relPath) })
  }
  registerResidentContext(ctx, workspace, caps)
  const assembly = await ctx.systemPrompt.assemble()
  const ours = assembly.contexts.filter(c => ['memory-core', 'memory-index', 'threads-index', 'attention'].includes(c.name))
  return { contexts: new Map(ours.map(c => [c.name, c.text])), names: ours.map(c => c.name) }
}

describe('resident-context projection', () => {
  it('injects dynamic materials as contexts in wake-bundle order; an absent file contributes empty text', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'I am the agent.')
      await writeResidentFile(ws, 'attention/attention.md', 'Right now: testing.')
      await writeResidentFile(ws, 'memory/memory.md', 'Settled fact.\n\n## Notes\n- alpha → memory/notes/alpha.md\n')
      // threads/index.md intentionally absent.

      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, defaultCaps)

      const assembly = await ctx.systemPrompt.assemble()
      const ours = assembly.contexts.filter(c =>
        ['memory-core', 'memory-index', 'threads-index', 'attention'].includes(c.name))
      // identity is no longer a context; it is an always-present system section (see below).
      expect(ours.map(c => c.name)).toEqual(['memory-core', 'memory-index', 'threads-index', 'attention'])
      expect(ours.find(c => c.name === 'memory-core')?.text).toContain('Settled fact.')
      // A file with ample room carries no usage line — the signal is silent until it fills.
      expect(ours.find(c => c.name === 'memory-core')?.text).not.toMatch(/KiB\]/)
      expect(ours.find(c => c.name === 'memory-index')?.text).toContain('alpha → memory/notes/alpha.md')
      // Absent file: empty text, which contributes nothing to the rendered prompt (no usage line).
      expect(ours.find(c => c.name === 'threads-index')?.text).toBe('')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('injects identity as an always-present system section, read fresh and kept literal', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'I am the agent.')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, defaultCaps)

      const assembly = await ctx.systemPrompt.assemble()
      const identity = assembly.sections.find(s => s.name === 'loom:identity')
      // identity is read fresh from its file, kept literal so a stray brace cannot break assembly.
      expect(identity?.text).toBe('I am the agent.')
      expect(identity?.interpolate).toBe(false)
      // The memory-model guidance is no longer a system section — how to keep the files lives in
      // the workspace's own AGENTS.md, surfaced on-touch, not in the prompt.
      expect(assembly.sections.find(s => s.name === 'loom:memory-guidance')).toBeUndefined()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('splices the first-waking prompt only while bootstrap.md is present, ahead of identity', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'I am the agent.')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, defaultCaps)

      // Absent: the first-waking prompt contributes nothing.
      let assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find(s => s.name === 'loom:bootstrap')?.text ?? '').toBe('')

      // Present: its content renders literally and leads, ahead of identity.
      await writeResidentFile(ws, 'bootstrap.md', 'You are waking for the first time.')
      assembly = await ctx.systemPrompt.assemble()
      const boot = assembly.sections.find(s => s.name === 'loom:bootstrap')
      expect(boot?.text).toBe('You are waking for the first time.')
      expect(boot?.interpolate).toBe(false)
      const order = assembly.sections.map(s => s.name)
      expect(order.indexOf('loom:bootstrap')).toBeLessThan(order.indexOf('loom:identity'))
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('shows a usage line once a material fills toward its cap', async () => {
    const ws = await tmpWorkspace()
    try {
      // attention past half of a small cap: the prune signal appears, before the hard wall.
      await writeResidentFile(ws, 'attention/attention.md', 'x'.repeat(70))
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, { ...defaultCaps, attention: 100 })

      const assembly = await ctx.systemPrompt.assemble()
      const attention = assembly.contexts.find(c => c.name === 'attention')
      expect(attention?.text).toMatch(/\[attention: [\d.]+\/[\d.]+ KiB\]/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('truncates a resident file that exceeds its cap', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'identity/identity.md', 'z'.repeat(5000))
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      registerResidentContext(ctx, ws, { ...defaultCaps, identity: 100 })

      const assembly = await ctx.systemPrompt.assemble()
      const identity = assembly.sections.find(s => s.name === 'loom:identity')
      expect(identity?.text).toContain('over budget')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('tags each carried entry with its age, derived from the workspace history', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'attention/attention.md', '# 当前\n\n- 第一条\n\n- 第二条\n')
      await writeResidentFile(ws, 'threads/index.md', '- `alpha/` — one line.\n')
      await writeResidentFile(ws, 'memory/memory.md', 'Settled.\n\n## Notes\n- a → memory/notes/a.md\n')
      execFileSync('git', ['init', '-q', ws], { encoding: 'utf8' })
      commitAt(ws, DAY_ONE, 'day one')
      // A whole-file rewrite that touches only the second entry: the first must keep its age.
      await writeResidentFile(ws, 'attention/attention.md', '# 当前\n\n- 第一条\n\n- 第二条 改过\n')
      commitAt(ws, DAY_THIRTEEN, 'day thirteen')

      const { contexts, names } = await assemble(ws, Date.parse(DAY_TWENTY_TWO))
      // Same projection as before: no new provider, no new order, nothing else changed.
      expect(names).toEqual(['memory-core', 'memory-index', 'threads-index', 'attention'])
      expect(contexts.get('attention')).toBe('# 当前\n\n- 第一条 (27 days untouched)\n\n- 第二条 改过 (14 days untouched)\n')
      expect(contexts.get('threads-index')).toBe('- `alpha/` — one line. (27 days untouched)\n')
      // The heading is the file's structure, and memory is not an aged material at all.
      expect(contexts.get('memory-core')).not.toContain('untouched')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('ages neighbours line by line when the agent leaves no blank line between them', async () => {
    const ws = await tmpWorkspace()
    try {
      // The agent's own attention held two entries like this on the day this was built: adjacent
      // lines, no separator, each an entry of its own. Reading them as one block would silently
      // drop the first entry's age.
      await writeResidentFile(ws, 'attention/attention.md', '- first\n- second\n')
      execFileSync('git', ['init', '-q', ws], { encoding: 'utf8' })
      commitAt(ws, DAY_ONE, 'day one')
      await writeResidentFile(ws, 'attention/attention.md', '- first\n- second 改过\n')
      commitAt(ws, DAY_THIRTEEN, 'day thirteen')

      const { contexts } = await assemble(ws, Date.parse(DAY_TWENTY_TWO))
      expect(contexts.get('attention')).toBe('- first (27 days untouched)\n- second 改过 (14 days untouched)\n')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('measures ages at the turn start, so a turn that outlives a day mark does not re-age it', async () => {
    const ws = await tmpWorkspace()
    try {
      await writeResidentFile(ws, 'attention/attention.md', '- 第一条\n')
      execFileSync('git', ['init', '-q', ws], { encoding: 'utf8' })
      commitAt(ws, DAY_ONE, 'day one')

      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      const clock = new ManualClock(Date.parse(DAY_THIRTEEN))
      ctx.provide('clock', clock)
      ctx.provide('workspaceHistory', { lineModifiedTimes: (relPath: string) => lineModifiedTimes(ws, relPath) })
      registerResidentContext(ctx, ws, defaultCaps)

      const session = {} as Session
      const attention = async (): Promise<string> => {
        const assembly = await ctx.systemPrompt.assemble({ agent: { session } } as never)
        return assembly.contexts.find(c => c.name === 'attention')?.text ?? ''
      }

      ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } } as never)
      const first = await attention()
      expect(first).toBe('- 第一条 (13 days untouched)\n')

      // Nine days pass while the same turn is still running: the material keeps saying thirteen,
      // so the loop is never handed a changed snapshot for a difference the agent cannot act on.
      clock.set(Date.parse(DAY_TWENTY_TWO))
      expect(await attention()).toBe(first)

      // The next turn measures again.
      ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } } as never)
      expect(await attention()).toBe('- 第一条 (27 days untouched)\n')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('leaves the material exactly as it is when there is no history to read', async () => {
    const ws = await tmpWorkspace()
    try {
      const raw = '# 当前\n\n- 第一条\n'
      await writeResidentFile(ws, 'attention/attention.md', raw)

      // The workspace is not a repository: blame cannot answer, so nothing is added.
      const withoutRepo = await assemble(ws, Date.parse(DAY_TWENTY_TWO))
      expect(withoutRepo.contexts.get('attention')).toBe(raw)

      // And a deployment that never mounted workspace-history behaves the same way.
      const withoutService = await assemble(ws, Date.parse(DAY_TWENTY_TWO), defaultCaps, false)
      expect(withoutService.contexts.get('attention')).toBe(raw)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('spends the ages against the material budget rather than around it', async () => {
    const ws = await tmpWorkspace()
    try {
      const raw = '- aaa\n\n- bbb\n\n- ccc\n'
      await writeResidentFile(ws, 'attention/attention.md', raw)
      execFileSync('git', ['init', '-q', ws], { encoding: 'utf8' })
      commitAt(ws, DAY_ONE, 'day one')

      // The material alone fits; with three markers on it, it does not — and the file is cut the
      // way any over-budget material is cut, markers included.
      expect(applyBudget(raw, 40).truncated).toBe(false)
      const { contexts } = await assemble(ws, Date.parse(DAY_TWENTY_TWO), { ...defaultCaps, attention: 40 })
      const attention = contexts.get('attention') ?? ''
      expect(attention).toContain('27 days untouched')
      expect(attention).toContain('over budget')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe('workspace scaffold', () => {
  it('materializes the skeleton once and never re-seeds a scaffolded workspace', async () => {
    const ws = await tmpWorkspace()
    try {
      ensureWorkspaceScaffold(ws)
      // Material files exist (empty), plus the housekeeping guide and the first-waking prompt.
      expect(await readFile(join(ws, 'identity/identity.md'), 'utf8')).toBe('')
      expect(await readFile(join(ws, 'attention/attention.md'), 'utf8')).toBe('')
      expect(existsSync(join(ws, 'memory/notes'))).toBe(true)
      expect(await readFile(join(ws, 'AGENTS.md'), 'utf8')).toContain('Keeping your workspace')
      expect(await readFile(join(ws, 'bootstrap.md'), 'utf8')).toContain('waking for the first time')

      // Once born — identity written, bootstrap.md deleted — a second call must leave it untouched.
      await writeFile(join(ws, 'identity/identity.md'), 'I am the agent.', 'utf8')
      await rm(join(ws, 'bootstrap.md'))
      ensureWorkspaceScaffold(ws)
      expect(await readFile(join(ws, 'identity/identity.md'), 'utf8')).toBe('I am the agent.')
      expect(existsSync(join(ws, 'bootstrap.md'))).toBe(false)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('never overwrites a live individual and never drops it back into birth', async () => {
    const ws = await tmpWorkspace()
    try {
      // A workspace from before this feature: it holds an identity but no AGENTS.md yet.
      await writeResidentFile(ws, 'identity/identity.md', 'I am already someone.')
      ensureWorkspaceScaffold(ws)
      // Identity is preserved, the housekeeping guide is added, and no first-waking prompt appears.
      expect(await readFile(join(ws, 'identity/identity.md'), 'utf8')).toBe('I am already someone.')
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(true)
      expect(existsSync(join(ws, 'bootstrap.md'))).toBe(false)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

