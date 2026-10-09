/**
 * workspace-history: mechanical snapshots of the agent's workspace.
 *
 * The unit layer pins the git layer's promises — only text materials enter the history, a changed
 * turn commits exactly once and an unchanged one not at all, an ignored clone stays out, and every
 * failure is an outcome rather than a throw. The load-bearing one is the whole-file rewrite: the
 * agent overwrites its materials whole, and the ages the projection later shows depend on untouched
 * lines keeping their old commits.
 *
 * The integration layer boots the real stack over a mock model and proves the wiring: a committed
 * turn produces one commit, an unchanged turn produces none, and neither adds a model call or a
 * message — the snapshot must be invisible to the agent.
 */

import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as WorkspaceHistoryPlugin from '../src/workspace-history/index.ts'
import { WORKSPACE_GITIGNORE, commitWorkspaceTurn, lineModifiedTimes } from '../src/workspace-history/index.ts'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse } from './support/mock-adapter.ts'

const DAY_ONE = '2026-09-25T10:00:00+08:00'
const DAY_THIRTEEN = '2026-10-08T10:00:00+08:00'

function git(workspace: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-C', workspace, ...args],
    // stderr stays out of the test output: an empty history is a normal state here, not noise.
    { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] },
  )
}

function initRepo(workspace: string): void {
  execFileSync('git', ['init', '-q', workspace], { encoding: 'utf8' })
}

/** A commit whose author and committer dates are pinned, so ages are exact rather than relative. */
function commitAt(workspace: string, isoDate: string, message: string): void {
  git(workspace, ['add', '-A'])
  git(workspace, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate })
}

/** Commit subjects, newest first; an empty history is empty rather than an error. */
function subjects(workspace: string): string[] {
  try {
    return git(workspace, ['log', '--pretty=%s']).trim().split('\n').filter(line => line !== '')
  } catch {
    return []
  }
}

async function write(workspace: string, rel: string, text: string): Promise<void> {
  const path = join(workspace, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'loom-workspace-history-'))
}

describe('workspace-history git layer', () => {
  it('records the text materials — and only them — then leaves an unchanged turn alone', async () => {
    const ws = await tmpWorkspace()
    try {
      initRepo(ws)
      await write(ws, 'attention/attention.md', '- one\n\n- two\n')
      await write(ws, 'media/contexera-logo.png', 'not text at all')
      // A cloned repository under .scratch: without the ignore rule git records a bare gitlink.
      await mkdir(join(ws, '.scratch/clone'), { recursive: true })
      execFileSync('git', ['init', '-q', join(ws, '.scratch/clone')], { encoding: 'utf8' })
      await write(ws, '.scratch/clone/readme.md', '# a clone, not the agent\'s writing\n')

      const first = await commitWorkspaceTurn(ws, 3)
      expect(first.kind).toBe('committed')
      if (first.kind !== 'committed') return
      expect(first.subject).toMatch(/^turn 3: /)
      expect(first.files).toContain('attention/attention.md')
      expect(first.files).toContain('.gitignore')

      const tracked = git(ws, ['ls-files']).trim().split('\n')
      expect(tracked).toContain('attention/attention.md')
      expect(tracked.some(name => name.endsWith('.png'))).toBe(false)
      expect(tracked.some(name => name.startsWith('.scratch/'))).toBe(false)
      expect(await readFile(join(ws, '.gitignore'), 'utf8')).toBe(WORKSPACE_GITIGNORE)

      // Nothing moved: no commit, no empty commit either.
      expect(await commitWorkspaceTurn(ws, 4)).toEqual({ kind: 'unchanged' })
      expect(subjects(ws)).toHaveLength(1)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('never rewrites an ignore file the agent wrote itself', async () => {
    const ws = await tmpWorkspace()
    try {
      initRepo(ws)
      await write(ws, 'attention/attention.md', '- one\n')
      await mkdir(join(ws, '.scratch/clone'), { recursive: true })
      execFileSync('git', ['init', '-q', join(ws, '.scratch/clone')], { encoding: 'utf8' })

      // The agent's own rules, ours kept alongside them: the file is its material, so it is used
      // as it stands and never rewritten.
      const mine = `${WORKSPACE_GITIGNORE}\n# a rule of my own\n`
      await write(ws, '.gitignore', mine)
      await write(ws, 'attention/attention.md', '- one\n\n- two\n')
      expect((await commitWorkspaceTurn(ws, 5)).kind).toBe('committed')
      expect(await readFile(join(ws, '.gitignore'), 'utf8')).toBe(mine)

      // Rules that stop excluding the clone: git will not stage an embedded repository, so the
      // snapshot refuses (and the caller logs it) rather than recording a bare gitlink.
      await write(ws, '.gitignore', '# mine\n')
      await write(ws, 'attention/attention.md', '- one\n\n- two\n\n- three\n')
      const refused = await commitWorkspaceTurn(ws, 6)
      expect(refused.kind).toBe('unavailable')
      expect(refused.kind === 'unavailable' ? refused.reason : '').toContain('git add failed')
      expect(await readFile(join(ws, '.gitignore'), 'utf8')).toBe('# mine\n')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('keeps the ages of untouched lines across a whole-file rewrite', async () => {
    const ws = await tmpWorkspace()
    try {
      initRepo(ws)
      const path = join(ws, 'attention/attention.md')
      // Three entries, one per line, blank lines between them — the shape the agent writes.
      await write(ws, 'attention/attention.md', '- first\n\n- second\n\n- third\n')
      commitAt(ws, DAY_ONE, 'day one')
      // It rewrites the whole file to change one entry; the other two are untouched.
      await writeFile(path, '- first\n\n- second REWRITTEN\n\n- third\n', 'utf8')
      commitAt(ws, DAY_THIRTEEN, 'day thirteen')

      const times = lineModifiedTimes(ws, 'attention/attention.md')
      expect(times?.get(1)).toBe(Date.parse(DAY_ONE))
      expect(times?.get(3)).toBe(Date.parse(DAY_THIRTEEN))
      expect(times?.get(5)).toBe(Date.parse(DAY_ONE))

      // A rewrite that has not been committed yet still blames the moved line to now, and leaves
      // the lines it did not touch where they were.
      await writeFile(path, '- first\n\n- second CHANGED AGAIN\n\n- third\n', 'utf8')
      const dirty = lineModifiedTimes(ws, 'attention/attention.md')
      expect(dirty?.get(3)).toBeGreaterThan(Date.parse(DAY_THIRTEEN))
      expect(dirty?.get(1)).toBe(Date.parse(DAY_ONE))
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('reports an unavailable history instead of throwing, for a missing or broken repository', async () => {
    const ws = await tmpWorkspace()
    try {
      expect(await commitWorkspaceTurn(ws, 1)).toEqual({
        kind: 'unavailable',
        reason: 'the workspace is not a git repository',
      })
      expect(lineModifiedTimes(ws, 'attention/attention.md')).toBeUndefined()

      // A `.git` that points nowhere: every git command fails, and the turn must still be fine.
      await writeFile(join(ws, '.git'), 'gitdir: /nonexistent\n', 'utf8')
      await write(ws, 'attention/attention.md', '- one\n')
      expect((await commitWorkspaceTurn(ws, 2)).kind).toBe('unavailable')
      expect(lineModifiedTimes(ws, 'attention/attention.md')).toBeUndefined()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe('workspace-history over a real turn', () => {
  it('commits once for a changed turn, not at all for an unchanged one, and wakes nothing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'loom-history-smoke-'))
    const ctx = new Context()
    const fibers: Fiber[] = []
    const mock = new MockAdapter([textResponse('noted'), textResponse('still here')])
    const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> => {
      fibers.push(await ctx.plugin(plugin as never, config as never))
    }
    try {
      await load(LlmRuntime)
      await load(SessionStore)
      await load(SessionProjectionRegistry)
      await load(SessionPersistence, { root: join(workspace, '.sessions') })
      await load(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
      await load(TokenMeter)
      await load(SystemPrompt)
      await load(ToolRuntime)
      await load(AgentRegistry)
      await load(AgentLoop, { agents: [] })
      await load(Storage)
      await load(StorageSqlite, { path: ':memory:' })
      await load(StorageDomain, { backend: 'sqlite' })
      ctx.llm.registerAdapter(['mock'], mock)
      await load(ClockPlugin)
      await load(RuntimeStatePlugin)
      await load(ResidentContextPlugin, { workspace })
      await load(WorkspaceHistoryPlugin, { workspace })
      provideFakePresets(ctx)
      await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })
      await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })

      const agent = ctx.agentRuntime.current()
      expect(agent).toBeDefined()

      // The repository is created by the deployment, not by the plugin: this one is handed over
      // already initialized, the way the instance-side step does it.
      initRepo(workspace)
      await write(workspace, 'memory/memory.md', 'A standing fact worth keeping.\n')

      agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent?.whenIdle()
      await vi.waitFor(() => { expect(subjects(workspace)).toHaveLength(1) })

      const first = subjects(workspace)[0] ?? ''
      expect(first).toMatch(/^turn \d+: /)
      expect(git(workspace, ['show', '--name-only', '--pretty=format:', 'HEAD'])).toContain('memory/memory.md')

      // A second turn that changes nothing must add no commit — and no model call, no message.
      agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
      await agent?.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(subjects(workspace)).toHaveLength(1)
      expect(mock.requests).toHaveLength(2)
      expect(agent?.inbox.nextTurn.length).toBe(0)
      expect(agent?.inbox.nextStep.length).toBe(0)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
