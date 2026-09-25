import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-tools'
import type { ChannelAttachment, ChannelCapabilities, InboundMessage, ResolvedAttachment } from '@wowyuarm/dsh-channel-gateway'
import '@wowyuarm/dsh-channel-gateway'
import type { AgentRuntime, Clock, RuntimeState } from '../contracts/index.ts'

export const name = 'channels'
export const inject = ['channels', 'runtimeState', 'agentRuntime', 'clock', 'tools']

/** The workspace subdirectory that holds files exchanged over channels, namespaced per channel. */
const MEDIA_DIR = 'media'

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
  registerInboundConsumer(ctx, config, focus)
  ctx.tools.register(createSendMessageTool(ctx, config, focus))
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

function registerInboundConsumer(ctx: Context, config: ChannelsConfig, focus: ActiveConversationTracker): void {
  const runtimeState: RuntimeState = ctx.runtimeState
  const agentRuntime: AgentRuntime = ctx.agentRuntime
  const clock: Clock = ctx.clock
  const logger = ctx.logger('channels')

  ctx.on('channel/inbound', (message: InboundMessage) => {
    void acceptInbound(message).catch((error: unknown) => {
      logger.error(`inbound accept failed for ${message.channel}:${message.providerMessageId}: ${String(error)}`)
    })
  })

  async function acceptInbound(message: InboundMessage): Promise<void> {
    if (runtimeState.isAccepted(message.channel, message.providerMessageId)) return
    await runtimeState.recordAccepted({
      channel: message.channel,
      providerMessageId: message.providerMessageId,
      actor: message.actor.id,
      place: message.place.route,
      visibility: message.visibility,
      route: message.place.route,
      acceptedAt: clock.now(),
    })
    focus.set(message.channel, message.place.route)
    const text = await framedText(ctx, config, message, logger)
    if (!agentRuntime.deliver(text)) {
      logger.warn(`no live agent to receive ${message.channel}:${message.providerMessageId}; message recorded, not delivered`)
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
    name: 'message',
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
      const result = await ctx.channels.send({
        channel: active.channel,
        route: active.route,
        text: args.text,
        ...(attachments === undefined ? {} : { attachments }),
      })
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
