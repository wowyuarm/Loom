import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as ChannelGatewayPlugin from '@contexera/dsh-channel-gateway'
import type { Channel, ChannelInbox, ChannelSendResult, InboundMessage, OutboundMessage } from '@contexera/dsh-channel-gateway'
import * as ClockPlugin from '../src/clock/index.ts'
import * as RuntimeStatePlugin from '../src/runtime-state/index.ts'
import * as ChannelsPlugin from '../src/channels/index.ts'
import type { AgentRuntime } from '../src/contracts/index.ts'

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

  async start(inbox: ChannelInbox): Promise<void> {
    this.inbox = inbox
  }
  async stop(): Promise<void> {
    this.inbox = undefined
  }
  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    this.sent.push(message)
    return { providerMessageId: `out-${this.sent.length}` }
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

/**
 * A controllable stand-in for the live agent. It records every handoff, and its `live` flag lets a
 * test hold the agent absent (before boot, mid-restart) so acceptance has to stay durable.
 */
class RecordingRuntime implements AgentRuntime {
  readonly delivered: string[] = []
  readonly messages: UserMessage[] = []
  live = false

  private agent(): Agent {
    return { id: 's-main', session: { id: 's-main' } } as unknown as Agent
  }
  current(): Agent | undefined {
    return this.live ? this.agent() : undefined
  }
  deliver(text: string): MessageId | undefined {
    if (!this.live) return undefined
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    this.messages.push(message)
    this.delivered.push(text)
    return message.id
  }
}

/** Commit one `user/message` the way a live Session does, so handoff confirmation can be observed. */
function commitUserMessage(ctx: Context, message: UserMessage): void {
  const session = { id: 's-main' } as unknown as Session
  // Only type/data are read by the consumer; the durable fields a real append adds are irrelevant here.
  const event = { type: 'user/message', data: message } as unknown as SessionEvent
  ctx.emit('session/event', session, event)
}

interface Harness {
  ctx: Context
  channel: MockChannel
  runtime: RecordingRuntime
  runtimeState: import('../src/contracts/index.ts').RuntimeState
  dispose: () => Promise<void>
}

/** Boot just the channels stack over a real runtime-state medium, with a controllable agent. */
async function bootChannels(path: string, runtime: RecordingRuntime, channelsConfig?: unknown): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'loom-handoff-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const load = async (plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> => {
    fibers.push(await ctx.plugin(plugin as never, config as never))
  }

  await load(SystemPrompt)
  await load(ToolRuntime)
  await load(Storage)
  await load(StorageSqlite, { path })
  await load(StorageDomain, { backend: 'sqlite' })
  await load(ClockPlugin)
  await load(RuntimeStatePlugin)
  ctx.provide('agentRuntime', runtime)
  await load(ChannelGatewayPlugin, { allow: ['*'] })
  await load(ChannelsPlugin, channelsConfig ?? { workspace })

  const channel = new MockChannel()
  const unregister = ctx.channels.register(channel)
  await vi.waitFor(() => { expect(ctx.channels.channels.map(c => c.name)).toContain('mock-chat') })

  return {
    ctx,
    channel,
    runtime,
    runtimeState: ctx.runtimeState,
    dispose: async () => {
      unregister()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

describe('durable inbound handoff', () => {
  it('keeps an input pending while no agent is live, delivers it on ready, and confirms only on commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-handoff-'))
    const runtime = new RecordingRuntime()
    const h = await bootChannels(join(dir, 'state.sqlite'), runtime)
    try {
      h.channel.receive(inbound('m1', 'hello'))
      await vi.waitFor(() => { expect(h.runtimeState.pendingInputs()).toHaveLength(1) })
      expect(h.runtimeState.isAccepted('mock-chat', 'm1')).toBe(true)
      expect(runtime.delivered).toEqual([])

      // The agent becomes live: draining hands the stored text over, but the input stays pending
      // until the matching user/message commits.
      runtime.live = true
      // Two ready signals can overlap (mount and rollover notifications); they share one drain.
      h.ctx.emit('loom/agent-ready', runtime.current()!)
      h.ctx.emit('loom/agent-ready', runtime.current()!)
      await vi.waitFor(() => { expect(runtime.delivered).toHaveLength(1) })
      expect(runtime.delivered[0]).toContain('hello')
      expect(h.runtimeState.pendingInputs()).toHaveLength(1)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(runtime.delivered).toHaveLength(1)

      commitUserMessage(h.ctx, runtime.messages[0]!)
      await vi.waitFor(() => { expect(h.runtimeState.pendingInputs()).toEqual([]) })
    } finally {
      await h.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drains a pending input written before a restart, once the agent is live again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-handoff-'))
    const path = join(dir, 'state.sqlite')
    try {
      const before = new RecordingRuntime()
      const first = await bootChannels(path, before)
      first.channel.receive(inbound('m1', 'left before restart'))
      await vi.waitFor(() => { expect(first.runtimeState.pendingInputs()).toHaveLength(1) })
      await first.dispose()

      // A fresh process over the same medium: the accepted text is reloaded and handed to the now
      // live agent on mount. Redelivery here is the explicitly allowed duplicate across a restart.
      const after = new RecordingRuntime()
      after.live = true
      const second = await bootChannels(path, after)
      try {
        await vi.waitFor(() => { expect(after.delivered).toHaveLength(1) })
        expect(after.delivered[0]).toContain('left before restart')
        expect(second.runtimeState.pendingInputs()).toHaveLength(1)
      } finally {
        await second.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not create a second in-process handoff when the same input arrives concurrently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-handoff-'))
    const runtime = new RecordingRuntime()
    runtime.live = true
    const h = await bootChannels(join(dir, 'state.sqlite'), runtime)
    try {
      h.channel.receive(inbound('m1', 'hello'))
      h.channel.receive(inbound('m1', 'same input again'))
      await vi.waitFor(() => { expect(runtime.delivered).toHaveLength(1) })
      expect(h.runtimeState.pendingInputs()).toHaveLength(1)
    } finally {
      await h.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('dedups a normal repeat of the same provider message id without a second handoff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-handoff-'))
    const runtime = new RecordingRuntime()
    runtime.live = true
    const h = await bootChannels(join(dir, 'state.sqlite'), runtime)
    try {
      h.channel.receive(inbound('m1', 'hello'))
      await vi.waitFor(() => { expect(runtime.delivered).toHaveLength(1) })
      h.channel.receive(inbound('m1', 'hello again'))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(runtime.delivered).toHaveLength(1)
      expect(h.runtimeState.isAccepted('mock-chat', 'm1')).toBe(true)
    } finally {
      await h.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('channels configuration and handoff scoping', () => {
  // An absent workspace degrades every attachment to a path-less marker that reads exactly like a
  // transport fault, with no diagnostic naming the cause. The load is where that is decidable, so
  // the row fails there rather than at the first attachment.
  it('fails the load when the workspace is absent, rather than degrading attachments silently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-handoff-'))
    const runtime = new RecordingRuntime()
    runtime.live = true
    await expect(bootChannels(join(dir, 'state.sqlite'), runtime, {})).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })

  it('confirms a handoff only against the live generation\'s own log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-handoff-'))
    const runtime = new RecordingRuntime()
    runtime.live = true
    const h = await bootChannels(join(dir, 'state.sqlite'), runtime)
    try {
      h.channel.receive(inbound('m1', 'hello'))
      await vi.waitFor(() => { expect(h.runtimeState.pendingInputs()).toHaveLength(1) })

      // The same message id committed by another session is not this input's handoff: an id
      // collision across sessions must not retire a record whose message is still undelivered.
      h.ctx.emit('session/event', { id: 'another-session' } as unknown as Session,
        { type: 'user/message', data: runtime.messages[0] } as unknown as SessionEvent)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.runtimeState.pendingInputs()).toHaveLength(1)

      // The live session's own commit confirms it.
      commitUserMessage(h.ctx, runtime.messages[0]!)
      await vi.waitFor(() => { expect(h.runtimeState.pendingInputs()).toEqual([]) })
    } finally {
      await h.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
