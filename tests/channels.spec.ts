import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as ChannelGatewayPlugin from '@wowyuarm/dsh-channel-gateway'
import type {
  Channel,
  ChannelAttachment,
  ChannelInbox,
  ChannelSendResult,
  InboundMessage,
  OutboundMessage,
  ResolvedAttachment,
} from '@wowyuarm/dsh-channel-gateway'
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ResidentContextPlugin from '../src/resident-context/index.ts'
import * as AgentRuntimePlugin from '../src/agent-runtime/index.ts'
import * as ChannelsPlugin from '../src/channels/index.ts'
import { provideFakePresets } from './support/fake-presets.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/** A scripted in-memory transport: hand it inbound messages, read back what was sent. */
class MockChannel implements Channel {
  readonly name = 'mock-chat'
  readonly capabilities = {
    attachments: true,
    attachmentDownload: true,
    buttons: false,
    edit: false,
    replyTo: true,
    maxTextLength: 4096,
  }
  private inbox: ChannelInbox | undefined
  readonly sent: OutboundMessage[] = []
  private nextId = 1
  /** When set, `send` throws instead of delivering — an ambiguous transport failure. */
  failSend = false

  async start(inbox: ChannelInbox): Promise<void> {
    this.inbox = inbox
  }
  async stop(): Promise<void> {
    this.inbox = undefined
  }
  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    if (this.failSend) throw new Error('transport unavailable')
    this.sent.push(message)
    return { providerMessageId: `out-${this.nextId++}` }
  }
  async resolveAttachment(attachment: ChannelAttachment): Promise<ResolvedAttachment> {
    return { bytes: new TextEncoder().encode(`bytes-of-${attachment.ref ?? 'unknown'}`) }
  }
  receive(message: InboundMessage): void {
    if (this.inbox === undefined) throw new Error('channel not started')
    this.inbox.deliver(message)
  }
}

function inbound(providerMessageId: string, text: string): InboundMessage {
  return {
    channel: 'mock-chat',
    providerMessageId,
    actor: { id: 'user-1', displayName: 'Alice' },
    place: { route: 'conv-42', kind: 'direct' },
    visibility: 'private',
    text,
    timestamp: new Date().toISOString(),
  }
}

function inboundWithImage(providerMessageId: string, text: string, ref: string): InboundMessage {
  return { ...inbound(providerMessageId, text), attachments: [{ kind: 'image', ref, mimeType: 'image/png' }] }
}

/** The concatenated text of the first user message the model was asked to generate against. */
function firstUserText(mock: MockAdapter): string {
  const message = mock.requests[0]?.messages.find(m => m.source?.kind === 'user')
  return (message?.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Whether any message across every recorded request carries a text block containing `needle`. */
function promptContains(mock: MockAdapter, needle: string): boolean {
  return mock.requests.some(request =>
    request.messages.some(message =>
      (message.content ?? []).some(block => block.type === 'text' && block.text.includes(needle)),
    ),
  )
}

/** The text of one message, concatenated — used to match what steer/followup was handed. */
function textOf(message: UserMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** A one-shot latch: a test resolves it to release work it parked. */
function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

interface Harness {
  ctx: Context
  channel: MockChannel
  mock: MockAdapter
  workspace: string
  dispose: () => Promise<void>
}

async function bootWithChannels(mock: MockAdapter): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'loom-ch-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> => {
    fibers.push(await ctx.plugin(plugin as never, config as never))
  }

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
  provideFakePresets(ctx)
  await load(AgentRuntimePlugin, { workspace, agentOptions: { provider: 'mock', model: 'mock' } })
  await load(ChannelGatewayPlugin, { allow: ['*'] })
  await load(ChannelsPlugin, { workspace })

  await vi.waitFor(() => { expect(ctx.agentRuntime?.current()).toBeDefined() })

  const channel = new MockChannel()
  const unregister = ctx.channels.register(channel)
  await vi.waitFor(() => { expect(ctx.channels.channels.map(c => c.name)).toContain('mock-chat') })

  return {
    ctx,
    channel,
    mock,
    workspace,
    dispose: async () => {
      unregister()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

describe('channels consumer', () => {
  it('accepts an inbound message, delivers it to the agent, and dedups a repeat', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'ok' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()

      h.channel.receive(inbound('m1', 'hello'))
      // Acceptance runs async off the synchronous inbound broadcast, so wait for the turn it
      // drives rather than assuming it already started.
      await vi.waitFor(() => { expect(h.channel.sent).toHaveLength(1) })
      await agent?.whenIdle()
      expect(h.ctx.runtimeState.isAccepted('mock-chat', 'm1')).toBe(true)

      // A repeat of the same provider message id is dropped: no second turn.
      const requests = h.mock.requests.length
      h.channel.receive(inbound('m1', 'hello'))
      await vi.waitFor(() => { expect(h.ctx.runtimeState.isAccepted('mock-chat', 'm1')).toBe(true) })
      await agent?.whenIdle()
      expect(h.mock.requests).toHaveLength(requests)
    } finally {
      await h.dispose()
    }
  })

  it('replies to the active conversation via message', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'hi Alice' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'are you there?'))
      await vi.waitFor(() => { expect(h.channel.sent).toHaveLength(1) })
      await agent?.whenIdle()

      expect(h.channel.sent[0]).toMatchObject({ channel: 'mock-chat', route: 'conv-42', text: 'hi Alice', format: 'markdown' })
    } finally {
      await h.dispose()
    }
  })

  it('lands an inbound attachment under the workspace and points the agent at it', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'got it' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inboundWithImage('m1', 'look at this', 'img1'))
      await vi.waitFor(() => { expect(h.mock.requests.length).toBeGreaterThan(0) })
      await agent?.whenIdle()

      const files = await readdir(join(h.workspace, 'media', 'mock-chat'))
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/\.png$/)
      const saved = await readFile(join(h.workspace, 'media', 'mock-chat', files[0] as string))
      expect(saved.toString()).toBe('bytes-of-img1')
      expect(firstUserText(h.mock)).toContain(`[image: media/mock-chat/${files[0] as string}]`)
    } finally {
      await h.dispose()
    }
  })

  it('sends a workspace file as an outbound attachment', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'here it is', attachments: ['note.txt'] }),
      textResponse('done'),
    ]))
    try {
      await writeFile(join(h.workspace, 'note.txt'), 'file body')
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'send me the note'))
      await vi.waitFor(() => { expect(h.channel.sent).toHaveLength(1) })
      await agent?.whenIdle()

      const [message] = h.channel.sent
      expect(message?.attachments).toHaveLength(1)
      expect(message?.attachments?.[0]).toMatchObject({ kind: 'file', name: 'note.txt' })
      expect(new TextDecoder().decode(message?.attachments?.[0]?.data)).toBe('file body')
    } finally {
      await h.dispose()
    }
  })

  it('records a delivered effect and announces it, leaving nothing to reconcile', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'hi Alice' }),
      textResponse('done'),
    ]))
    try {
      const delivered: string[] = []
      h.ctx.on('loom/delivery', effect => { if (effect.status === 'delivered') delivered.push(effect.remoteId ?? '') })
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'are you there?'))
      await vi.waitFor(() => { expect(h.channel.sent).toHaveLength(1) })
      await agent?.whenIdle()

      expect(h.ctx.runtimeState.uncertainDeliveries()).toEqual([])
      expect(delivered).toEqual(['out-1'])
    } finally {
      await h.dispose()
    }
  })

  it('leaves an unconfirmed effect when the send fails and names it in a later prompt', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'hi Alice' }),
      textResponse('understood'),
      toolCallResponse('s2', 'message', { text: 'still here' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.failSend = true
      h.channel.receive(inbound('m1', 'are you there?'))
      // The send throws, so nothing lands on the wire; the tool error drives the model's next step.
      await vi.waitFor(() => { expect(h.mock.requests.length).toBeGreaterThanOrEqual(2) })
      await agent?.whenIdle()

      // The failed send is recorded as unknown — uncertain, not not-sent — and never resent.
      const uncertain = h.ctx.runtimeState.uncertainDeliveries()
      expect(uncertain).toHaveLength(1)
      expect(uncertain[0]).toMatchObject({ status: 'unknown', channel: 'mock-chat', route: 'conv-42', text: 'hi Alice' })
      expect(h.channel.sent).toHaveLength(0)

      // A later turn's prompt names the unconfirmed delivery so the agent can verify it.
      const before = h.mock.requests.length
      h.channel.receive(inbound('m2', 'still there?'))
      await vi.waitFor(() => { expect(h.mock.requests.length).toBeGreaterThan(before) })
      await agent?.whenIdle()
      expect(promptContains(h.mock, 'Unconfirmed delivery')).toBe(true)
    } finally {
      await h.dispose()
    }
  })
})

describe('undelivered reply notice', () => {
  it('asks once when a turn ends with text nobody received, and the reply then goes out', async () => {
    const h = await bootWithChannels(new MockAdapter([
      textResponse('draft reply that nobody sees'),
      toolCallResponse('s1', 'message', { text: 'hi Alice, I am here' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'are you there?'))
      // Both the notice step and the send it prompted are part of the same turn.
      await vi.waitFor(() => { expect(h.mock.requests.length).toBeGreaterThan(1) })
      await agent?.whenIdle()

      // The turn's own text reached nobody; the boundary asked about it, and the reply went out.
      expect(h.channel.sent).toHaveLength(1)
      expect(h.channel.sent[0]).toMatchObject({ text: 'hi Alice, I am here' })

      // The question is attributed to this plugin's own producer kind, not to a person.
      const notice = h.mock.requests.at(-1)?.messages.find(m => m.source?.kind === '@loom/channels')
      expect(notice?.content).toMatchObject([{ type: 'text', text: expect.stringContaining('nobody received') }])
    } finally {
      await h.dispose()
    }
  })

  it('asks only once for the same undelivered reply', async () => {
    const h = await bootWithChannels(new MockAdapter([
      textResponse('first attempt at a reply'),
      textResponse('second attempt at a reply'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.receive(inbound('m1', 'are you there?'))
      await vi.waitFor(() => { expect(h.mock.requests).toHaveLength(2) })
      await agent?.whenIdle()

      // The second turn wrote text again and still sent nothing, but the inbound was already
      // asked about: the turn closes instead of asking forever.
      expect(h.mock.requests).toHaveLength(2)
      expect(h.channel.sent).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('stays quiet when no inbound is waiting to be answered', async () => {
    const h = await bootWithChannels(new MockAdapter([textResponse('thinking out loud')]))
    try {
      const agent = h.ctx.agentRuntime.current()
      // A turn Loom itself started — nothing here is owed to a person.
      agent?.followup(createUserMessage({ content: [{ type: 'text', text: 'internal input' }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(h.mock.requests).toHaveLength(1) })
      await agent?.whenIdle()

      expect(h.mock.requests).toHaveLength(1)
      expect(h.channel.sent).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('treats a failed send as an answer rather than asking again', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'hi Alice' }),
      textResponse('understood'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      h.channel.failSend = true
      h.channel.receive(inbound('m1', 'are you there?'))
      await vi.waitFor(() => { expect(h.ctx.runtimeState.uncertainDeliveries()).toHaveLength(1) })
      await agent?.whenIdle()

      // The attempt is recorded as an unconfirmed delivery, which the agent reconciles on its own
      // terms; being asked again here would only invite the blind resend that context prevents.
      expect(h.ctx.runtimeState.uncertainDeliveries()).toHaveLength(1)
      expect(h.mock.requests).toHaveLength(2)
    } finally {
      await h.dispose()
    }
  })
})

describe('inbound placement', () => {
  it('steers an inbound into the agent instead of queueing a followup turn', async () => {
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'hi Alice' }),
      textResponse('done'),
    ]))
    try {
      const agent = h.ctx.agentRuntime.current()
      expect(agent).toBeDefined()
      const steered = vi.spyOn(agent!, 'steer')
      const followed = vi.spyOn(agent!, 'followup')

      h.channel.receive(inbound('m1', 'hello'))
      await vi.waitFor(() => {
        expect(steered.mock.calls.some(([message]) => textOf(message).includes('hello'))).toBe(true)
      })
      await agent?.whenIdle()

      expect(followed).not.toHaveBeenCalled()
      expect(h.channel.sent).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })

  it('joins the running turn even after it has answered, because a send is a tool call and not a turn end', async () => {
    const release = latch()
    let holding = false
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'message', { text: 'first reply' }),
      toolCallResponse('s2', 'park', {}),
      textResponse('turn one done'),
      textResponse('second turn done'),
    ]))
    try {
      h.ctx.tools.register(defineTool({
        name: 'park',
        description: 'Test tool that keeps the current turn open until the test releases it.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          holding = true
          await release.promise
          return 'parked'
        },
      }))
      const agent = h.ctx.agentRuntime.current()
      expect(agent).toBeDefined()
      const steered = vi.spyOn(agent!, 'steer')
      const followed = vi.spyOn(agent!, 'followup')

      h.channel.receive(inbound('m1', 'first question'))
      await vi.waitFor(() => { expect(holding).toBe(true) })
      // The reply already went out on the wire; the turn is still open.
      expect(h.channel.sent).toHaveLength(1)

      h.channel.receive(inbound('m2', 'second question'))
      await vi.waitFor(() => {
        expect(steered.mock.calls.some(([message]) => textOf(message).includes('second question'))).toBe(true)
      })
      // Answering never closes the turn, so the next message steers rather than
      // waiting for a turn of its own.
      expect(followed).not.toHaveBeenCalled()

      release.resolve()
      await agent?.whenIdle()
      expect(h.channel.sent).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })

  it('keeps a burst of messages atomic and delivers them in one step together', async () => {
    const release = latch()
    let holding = false
    const h = await bootWithChannels(new MockAdapter([
      toolCallResponse('s1', 'park', {}),
      textResponse('done'),
    ]))
    try {
      h.ctx.tools.register(defineTool({
        name: 'park',
        description: 'Test tool that keeps the current turn open until the test releases it.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          holding = true
          await release.promise
          return 'parked'
        },
      }))
      const agent = h.ctx.agentRuntime.current()
      expect(agent).toBeDefined()
      const steered: string[] = []
      const realSteer = agent!.steer.bind(agent!)
      vi.spyOn(agent!, 'steer').mockImplementation((message: UserMessage) => {
        steered.push(textOf(message))
        realSteer(message)
      })

      h.channel.receive(inbound('m0', 'opener'))
      await vi.waitFor(() => { expect(holding).toBe(true) }, { timeout: 10000 })

      // Three messages land while the tool call is still running.
      h.channel.receive(inbound('m1', 'alpha'))
      h.channel.receive(inbound('m2', 'beta'))
      h.channel.receive(inbound('m3', 'gamma'))
      await vi.waitFor(() => { expect(steered).toHaveLength(4) }, { timeout: 10000 })

      release.resolve()
      await agent?.whenIdle()

      // Each message stays its own user message — three steers, never one merged blob.
      // A later notice steer is not inbound text; only the person's four are asserted here.
      const inboundSteers = steered.filter(text => /opener|alpha|beta|gamma/.test(text))
      expect(inboundSteers).toHaveLength(4)
      expect(inboundSteers[1]).toContain('alpha')
      expect(inboundSteers[1]).not.toContain('beta')
      expect(inboundSteers[2]).toContain('beta')
      expect(inboundSteers[3]).toContain('gamma')
      // ...and the model sees them as the separate inputs they are, in arrival order.
      const batch = h.mock.requests.at(-1)?.messages
        .filter(m => m.source?.kind === 'user')
        .map(m => (m.content ?? []).filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join(' '))
      expect(batch).toHaveLength(4)
      expect(batch?.[1]).toContain('alpha')
      expect(batch?.[2]).toContain('beta')
      expect(batch?.[3]).toContain('gamma')
    } finally {
      await h.dispose()
    }
  })
})
