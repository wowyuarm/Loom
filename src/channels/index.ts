import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type AssistantMessage, type ContextFormed, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-tools'
// Side-effect import: pulls the `systemPrompt` Context augmentation from dsh-system-prompt.
import '@deepseek-ai/dsh-system-prompt'
import type { ChannelAttachment, ChannelCapabilities, InboundMessage, ResolvedAttachment } from '@contexera/dsh-channel-gateway'
import '@contexera/dsh-channel-gateway'
import type { AgentRuntime, Clock, DeliveryEffect, RuntimeState } from '../contracts/index.ts'

export const name = 'channels'
export const inject = ['channels', 'runtimeState', 'agentRuntime', 'clock', 'tools', 'systemPrompt']

/** The workspace subdirectory that holds files exchanged over channels, namespaced per channel. */
const MEDIA_DIR = 'media'

/** The agent's one outbound tool: assistant text reaches nobody, this call is what reaches them. */
const SEND_MESSAGE_TOOL = 'message'

/** Attribution id for messages this plugin produces; the owner prefix is Loom's naming convention. */
const LOOM_CHANNELS_PLUGIN_ID = '@loom/channels'

/** One-line account of the undelivered-reply notice, recorded in its durable source. */
const UNANSWERED_REPLY_SUMMARY = 'turn ended with an undelivered reply'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    '@loom/channels': { kind: typeof LOOM_CHANNELS_PLUGIN_ID } & ContextFormed
  }
}

export interface ChannelsConfig {
  /**
   * The agent's workspace root. Incoming attachments are written under `media/<channel>/` here so
   * the agent's own read/read_image tools (rooted at this same workspace) can open them, and an
   * outbound attachment path is resolved against it and refused if it escapes the workspace.
   */
  workspace: string
}

/**
 * The one conversation the agent is currently addressing: the channel and the opaque route of
 * the message it is answering. `send_message` resolves to this so the model never handles a
 * route. v1 tracks a single focus — the most recently delivered inbound — which fits a reactive
 * one-conversation loop; multi-conversation addressing and unprompted sends are deferred.
 */
interface ActiveConversation {
  channel: string
  route: string
}

/**
 * Consume `channel/inbound`: deduplicate against the durable ledger, record acceptance with the
 * route for later replies, land any attachments in the workspace, focus the conversation, and
 * deliver the message to the single agent. The gateway and its adapters own transport and
 * authorization; this is the seam that turns an authorized message into an agent turn and lets
 * the agent answer back, files included.
 */
export function apply(ctx: Context, config: ChannelsConfig): void {
  const focus = new ActiveConversationTracker()
  const unanswered = new UnansweredReplyWatch()
  registerInboundConsumer(ctx, config, focus, unanswered)
  ctx.tools.register(createSendMessageTool(ctx, config, focus))
  registerReconciliationContext(ctx)
  registerUnansweredReplyNotice(ctx, unanswered)
}

/**
 * Whether the person's latest message still has no answer.
 *
 * A turn can end with the model having written a reply that nobody received: assistant text is
 * never shown to anyone, and only the `message` tool reaches the person. This tracks the two facts
 * that make that detectable — an inbound nobody has answered, and what the current turn wrote —
 * so the stop boundary can ask once.
 */
class UnansweredReplyWatch {
  private awaiting = false
  private asked = false
  private answeredTurn: number | undefined
  private textTurn: number | undefined

  /** An accepted inbound opens one question; a later inbound replaces the earlier one. */
  inboundArrived(): void {
    this.awaiting = true
    this.asked = false
  }

  /**
   * A `message` call answers the inbound whether or not the send succeeded. An attempt that
   * failed is already named by the unconfirmed-delivery context, and asking again would invite
   * the blind resend that context exists to prevent.
   */
  answerAttempted(turn: number): void {
    this.answeredTurn = turn
    this.awaiting = false
  }

  textWritten(turn: number): void {
    this.textTurn = turn
  }

  /** This stop boundary owes one question: an unanswered inbound, text written, no attempt, none asked. */
  owesQuestion(turn: number): boolean {
    return this.awaiting && !this.asked && this.answeredTurn !== turn && this.textTurn === turn
  }

  askedNow(): void {
    this.asked = true
  }
}

/**
 * Ask once, at a turn's stop boundary, whether a reply the model wrote was meant to be sent.
 *
 * `agent/turn-stopping` is DSH's own boundary — it fires when the model owes no response and is
 * awaited before the turn commits; steering there re-reads the inbox and runs one more step, which
 * is what turns a written-but-unsent reply into a chance to send it. Both facts the question needs
 * come from the session log rather than from a guess: a `tool/call` named `message`, and an
 * `assistant/message` carrying text. The question is a notice, not an instruction: it states what
 * happened and leaves staying silent a legitimate answer.
 */
function registerUnansweredReplyNotice(ctx: Context, watch: UnansweredReplyWatch): void {
  ctx.on('session/event', (session, event) => {
    if (session.id !== ctx.agentRuntime.current()?.session.id) return
    if (event.type === 'tool/call' && event.data.name === SEND_MESSAGE_TOOL) watch.answerAttempted(event.data.turn)
    else if (event.type === 'assistant/message' && carriesText(event.data.message)) watch.textWritten(event.data.turn)
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent !== ctx.agentRuntime.current() || !watch.owesQuestion(turn)) return
    watch.askedNow()
    agent.steer(unansweredReplyNotice())
  })
}

function carriesText(message: AssistantMessage): boolean {
  return message.content.some(block => block.type === 'text' && block.text.trim() !== '')
}

function unansweredReplyNotice(): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'The turn ended with assistant text that nobody received: assistant text is not shown to '
        + 'the person you are talking with, and the `message` tool is the only way to reach them. If '
        + 'that text was meant for them, send it now with `message`; if you meant to stay silent, end '
        + 'the turn.',
    }],
    source: { kind: LOOM_CHANNELS_PLUGIN_ID, form: 'notice', summary: UNANSWERED_REPLY_SUMMARY },
  })
}

/**
 * Name outbound effects whose delivery is still uncertain (a crash mid-send, or a send that
 * threw) in every turn's context, so the agent inherits the uncertainty across a restart and can
 * verify before assuming it was seen. Loom never resends on its own. A later successful send on
 * the same conversation clears the entry, so this is silent in normal operation.
 */
function registerReconciliationContext(ctx: Context): void {
  const runtimeState: RuntimeState = ctx.runtimeState
  ctx.systemPrompt.context({
    name: 'loom:undelivered',
    order: 45,
    text: () => reconciliationText(runtimeState.uncertainDeliveries()),
  })
}

function reconciliationText(uncertain: readonly DeliveryEffect[]): string {
  if (uncertain.length === 0) return ''
  const lines = uncertain.map(effect => `- to ${effect.channel} (${effect.route}): ${JSON.stringify(effect.text)}`)
  return [
    'Unconfirmed delivery: you tried to send the following, but whether it reached the recipient is unknown '
    + '(the send was interrupted or errored). Verify before assuming it was seen; do not blindly resend.',
    ...lines,
  ].join('\n')
}

class ActiveConversationTracker {
  private active: ActiveConversation | undefined
  set(channel: string, route: string): void {
    this.active = { channel, route }
  }
  get(): ActiveConversation | undefined {
    return this.active
  }
}

/**
 * The in-process ledger of handoffs awaiting confirmation. Keyed by the created
 * `user/message` id, and separately by the accepted-input key, so a drain never creates a second
 * attempt for a record this process already handed off. Entries persist for the process
 * lifetime until the matching Session event commits; the accepting set and durable accepted
 * record then stop normal and concurrent duplicates without retaining every historical key in memory.
 */
class HandoffLedger {
  private readonly awaiting = new Map<MessageId, { channel: string; providerMessageId: string }>()
  private readonly attempted = new Set<string>()

  attemptedAlready(channel: string, providerMessageId: string): boolean {
    return this.attempted.has(handoffKey(channel, providerMessageId))
  }

  record(messageId: MessageId, channel: string, providerMessageId: string): void {
    this.awaiting.set(messageId, { channel, providerMessageId })
    this.attempted.add(handoffKey(channel, providerMessageId))
  }

  /** The input a committed `user/message` confirms, or undefined for a message we did not send. */
  confirm(messageId: MessageId): { channel: string; providerMessageId: string } | undefined {
    const pending = this.awaiting.get(messageId)
    if (pending === undefined) return undefined
    this.awaiting.delete(messageId)
    this.attempted.delete(handoffKey(pending.channel, pending.providerMessageId))
    return pending
  }
}

/** In-process key for one accepted input; a separator no realistic id contains. */
function handoffKey(channel: string, providerMessageId: string): string {
  return `${channel}\u0000${providerMessageId}`
}

function registerInboundConsumer(
  ctx: Context,
  config: ChannelsConfig,
  focus: ActiveConversationTracker,
  unanswered: UnansweredReplyWatch,
): void {
  const runtimeState: RuntimeState = ctx.runtimeState
  const agentRuntime: AgentRuntime = ctx.agentRuntime
  const clock: Clock = ctx.clock
  const logger = ctx.logger('channels')
  const handoffs = new HandoffLedger()
  // The durable ledger is intentionally not an atomic claim primitive. This small in-process set
  // closes the normal concurrent-event window before the first record is written; after a restart,
  // a duplicate remains an allowed at-least-once outcome.
  const accepting = new Set<string>()

  ctx.on('channel/inbound', (message: InboundMessage) => {
    void acceptInbound(message).catch((error: unknown) => {
      logger.error(`inbound accept failed for ${message.channel}:${message.providerMessageId}: ${String(error)}`)
    })
  })

  // A pending input becomes delivered only when its `user/message` commits to a session log.
  // `deliverTracked` returning an id means the message reached the process inbox, not that any
  // turn committed it — the rollover admission gate can even carry it to a successor generation.
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'user/message') return
    const pending = handoffs.confirm(event.data.id)
    if (pending === undefined) return
    void runtimeState.confirmInput(pending.channel, pending.providerMessageId).catch((error: unknown) => {
      logger.warn(`failed to confirm ${pending.channel}:${pending.providerMessageId}: ${String(error)}`)
    })
  })

  let draining: Promise<void> | undefined
  // Both an agent-ready signal and this plugin's own mount drain: the boot signal fires before
  // this plugin mounted (the service is provided only after boot), so the mount drain is not
  // redundant, and a rollover successor signals after the mount.
  ctx.on('loom/agent-ready', () => { void drainPending() })
  void drainPending()

  function drainPending(): Promise<void> {
    if (draining !== undefined) return draining
    const run = async (): Promise<void> => {
      if (agentRuntime.current() === undefined) return
      for (const input of runtimeState.pendingInputs()) {
        const text = input.text
        if (text === undefined) continue
        await handOff(input.channel, input.providerMessageId, input.route, text)
      }
    }
    // Queue the body in a microtask so `draining` is visible before any handoff can synchronously
    // emit another ready signal. A mount drain and a rollover-ready drain therefore share one pass.
    draining = Promise.resolve().then(run).finally(() => { draining = undefined })
    return draining
  }

  /**
   * Hand one accepted input to the live agent and remember it until its `user/message` commits.
   * A key already attempted in this process is skipped, so a drain cannot spin on the same record;
   * a later process has no memory of the attempt and may redeliver — the allowed duplicate.
   *
   * Every inbound steers. Steering is DSH's own "nearest step boundary" boundary: an idle agent
   * opens a turn with it, and a running agent consumes it at its next step — so a message arriving
   * mid-tool-call waits for that call to finish instead of interrupting it, and one arriving
   * between turns starts the next turn. `message` is a tool call like any other and therefore
   * never marks a turn as closed; a turn ends when the model stops owing a response, not when it
   * happens to send one. Each message stays one atomic user message: when several land inside the
   * same step, the loop claims them together and the model sees them as the separate inputs they
   * are.
   */
  async function handOff(
    channel: string,
    providerMessageId: string,
    route: string,
    text: string,
  ): Promise<void> {
    if (handoffs.attemptedAlready(channel, providerMessageId)) return
    focus.set(channel, route)
    const messageId = agentRuntime.deliverTracked(text)
    if (messageId === undefined) {
      logger.warn(`no live agent to receive ${channel}:${providerMessageId}; message recorded, not delivered`)
      return
    }
    handoffs.record(messageId, channel, providerMessageId)
    // Only an input the agent actually received is one it owes an answer to; a recorded-but-
    // undelivered message was never seen, so nothing about it can be a reply the model forgot.
    unanswered.inboundArrived()
  }

  /**
   * Accept one inbound message: dedup, prepare the full text (attachments included), persist it
   * as pending, then try to hand it to the live agent. The text is persisted before delivery so an
   * Agent that is absent, rolling over, or on the far side of a restart can still be given it.
   */
  async function acceptInbound(message: InboundMessage): Promise<void> {
    const key = handoffKey(message.channel, message.providerMessageId)
    if (runtimeState.isAccepted(message.channel, message.providerMessageId) || accepting.has(key)) return
    accepting.add(key)
    try {
      const text = await framedText(ctx, config, message, logger)
      await runtimeState.recordAccepted({
        channel: message.channel,
        providerMessageId: message.providerMessageId,
        actor: message.actor.id,
        place: message.place.route,
        visibility: message.visibility,
        route: message.place.route,
        acceptedAt: clock.now(),
        text,
        deliveryState: 'pending',
      })
      await handOff(message.channel, message.providerMessageId, message.place.route, text)
    } finally {
      accepting.delete(key)
    }
  }
}

/**
 * A compact provenance header the agent reads, the message text, and one marker per attachment.
 * Each attachment is fetched and written under the workspace `media/<channel>/`, and its marker
 * carries the workspace-relative path so the agent opens it with its own read/read_image tools —
 * the agent, not this seam, decides what to look at. A channel that cannot download, or a fetch
 * that fails, degrades to a marker without a path so the agent still knows something arrived.
 */
async function framedText(
  ctx: Context,
  config: ChannelsConfig,
  message: InboundMessage,
  logger: ReturnType<Context['logger']>,
): Promise<string> {
  const who = message.actor.displayName ?? message.actor.id
  const lines: string[] = [`[${message.channel} · ${message.place.kind} · from ${who}]`]
  if (message.text !== '') lines.push(message.text)
  lines.push(...await ingestAttachments(ctx, config, message, logger))
  return lines.join('\n')
}

async function ingestAttachments(
  ctx: Context,
  config: ChannelsConfig,
  message: InboundMessage,
  logger: ReturnType<Context['logger']>,
): Promise<string[]> {
  const attachments = message.attachments ?? []
  if (attachments.length === 0) return []
  const downloadable = capabilitiesOf(ctx, message.channel)?.attachmentDownload === true
  const notes: string[] = []
  for (const [index, attachment] of attachments.entries()) {
    if (!downloadable) {
      notes.push(`[${attachment.kind}: not retrievable from ${message.channel}]`)
      continue
    }
    try {
      const resolved = await ctx.channels.resolveAttachment(message.channel, attachment)
      const path = await saveIncoming(config.workspace, message, index, attachment, resolved)
      notes.push(`[${attachment.kind}: ${path}]`)
    } catch (error: unknown) {
      logger.warn(`attachment fetch failed for ${message.channel}:${message.providerMessageId}#${index}: ${String(error)}`)
      notes.push(`[${attachment.kind}: download failed]`)
    }
  }
  return notes
}

/**
 * Write one fetched attachment under `media/<channel>/` and return its workspace-relative path.
 * The provider message id and the attachment index prefix the sanitized display name so repeats
 * and same-message attachments never collide, while the name stays readable to the agent.
 */
async function saveIncoming(
  workspace: string,
  message: InboundMessage,
  index: number,
  attachment: ChannelAttachment,
  resolved: ResolvedAttachment,
): Promise<string> {
  const channelSegment = safeSegment(message.channel)
  const directory = join(workspace, MEDIA_DIR, channelSegment)
  await mkdir(directory, { recursive: true })
  const displayName = resolved.name ?? attachment.name ?? attachment.kind
  const extension = extensionOf(displayName, resolved.mimeType ?? attachment.mimeType)
  const stem = stripExtension(safeSegment(displayName))
  const fileName = `${safeSegment(message.providerMessageId)}-${String(index)}-${stem}${extension}`
  await writeFile(join(directory, fileName), resolved.bytes)
  return `${MEDIA_DIR}/${channelSegment}/${fileName}`
}

function createSendMessageTool(ctx: Context, config: ChannelsConfig, focus: ActiveConversationTracker): ToolDefinition {
  return defineTool({
    name: SEND_MESSAGE_TOOL,
    description:
      'Send a message to the person you are currently talking with over their channel (e.g. '
      + 'Telegram). Your assistant text is not shown to anyone; this tool is the only way to '
      + 'reach them. The destination is the conversation the last incoming message came from. '
      + 'To send files, list their workspace paths in `attachments` (e.g. a file you wrote or '
      + 'one you received under media/).',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The message to send. May be empty when sending attachments alone.',
      },
      attachments: {
        type: 'array',
        description: 'Workspace-relative paths of files to send with the message. Each must stay inside the workspace.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          channel: { type: 'string', required: true },
          providerMessageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Sent on ${value.channel} (${value.providerMessageId})` }],
    },
    async execute(args) {
      const active = focus.get()
      if (active === undefined) {
        throw new Error('message: no active conversation — there is no incoming message to reply to yet')
      }
      const attachments = await outboundAttachments(ctx, config, active.channel, args.attachments ?? [])
      // Record the outbound action as pending before attempting the send: this durable write is
      // the barrier a crash mid-send falls back to. A send that throws is recorded `unknown`, not
      // not-sent — the transport cannot tell "never left" from "sent but ack lost", so the agent
      // must not assume it can safely resend.
      const runtimeState: RuntimeState = ctx.runtimeState
      const clock: Clock = ctx.clock
      const effectId = randomUUID()
      await runtimeState.recordEffect({
        effectId,
        kind: 'message',
        channel: active.channel,
        route: active.route,
        text: args.text,
        createdAt: clock.now(),
      })
      let result
      try {
        result = await ctx.channels.send({
          channel: active.channel,
          route: active.route,
          text: args.text,
          format: 'markdown',
          ...(attachments === undefined ? {} : { attachments }),
        })
      } catch (error: unknown) {
        const resolved = await runtimeState.resolveEffect(effectId, { status: 'unknown', error: String(error), resolvedAt: clock.now() })
        ctx.emit('loom/delivery', resolved)
        throw error
      }
      const resolved = await runtimeState.resolveEffect(effectId, { status: 'delivered', remoteId: result.providerMessageId, resolvedAt: clock.now() })
      ctx.emit('loom/delivery', resolved)
      return { channel: active.channel, providerMessageId: result.providerMessageId }
    },
  })
}

/**
 * Read each requested workspace file and shape it for the wire. Refuses a path that escapes the
 * workspace, and refuses any attachment when the target channel cannot carry one, so the model
 * gets a clear error instead of a silently text-only send.
 */
async function outboundAttachments(
  ctx: Context,
  config: ChannelsConfig,
  channel: string,
  paths: readonly string[],
): Promise<ChannelAttachment[] | undefined> {
  if (paths.length === 0) return undefined
  if (capabilitiesOf(ctx, channel)?.attachments !== true) {
    throw new Error(`message: ${channel} cannot carry attachments`)
  }
  const attachments: ChannelAttachment[] = []
  for (const path of paths) {
    const { bytes, name } = await readWorkspaceFile(config.workspace, path)
    const extension = extname(name).toLowerCase()
    const mimeType = MIME_BY_EXTENSION[extension]
    attachments.push({
      kind: KIND_BY_EXTENSION[extension] ?? 'file',
      name,
      data: bytes,
      ...(mimeType === undefined ? {} : { mimeType }),
    })
  }
  return attachments
}

async function readWorkspaceFile(workspace: string, path: string): Promise<{ bytes: Uint8Array; name: string }> {
  const root = resolve(workspace)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`message: attachment path "${path}" is outside the workspace`)
  }
  const bytes = await readFile(target)
  return { bytes: new Uint8Array(bytes), name: basename(target) }
}

function capabilitiesOf(ctx: Context, channel: string): ChannelCapabilities | undefined {
  return ctx.channels.channels.find(registered => registered.name === channel)?.capabilities
}

/** Reduce a provider-supplied string to a safe single path segment: no separators, no `..`, bounded. */
function safeSegment(value: string): string {
  const leaf = value.split(/[/\\]/).pop() ?? value
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return cleaned === '' ? 'file' : cleaned.slice(0, 96)
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** The name's own extension when it has one, else one derived from the media type, else none. */
function extensionOf(name: string, mimeType: string | undefined): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot).toLowerCase()
  return mimeType === undefined ? '' : (EXTENSION_BY_MIME[mimeType] ?? '')
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
}

const KIND_BY_EXTENSION: Record<string, ChannelAttachment['kind']> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.ogg': 'audio',
  '.mp3': 'audio',
  '.mp4': 'video',
}
