import { RESERVED_LOOM_TOOL_NAMES } from "./reserved-tool-names.js";
import type {
  AcceptedInput,
  DeliveryAttemptRequest,
  DeliveryObservation,
  RuntimeInput,
} from "../runtime/index.js";
import type { InteractionChannel, InteractionChannelStatus } from "./channel.js";
import type {
  ExternalAttentionEvidence,
  InteractionChannelAgentSurface,
  InteractionChannelAttentionSource,
  InteractionChannelTools,
} from "./surface.js";

export interface OpenLoomInteractionChannelsOptions {
  channels: InteractionChannel[];
  /** Proactive default route; when configured it must name an enabled Channel. */
  defaultInteractionRoute?: string;
}

/**
 * The Host-facing collection of every enabled Interaction Channel. Lifecycle,
 * delivery routing, status aggregation and model-facing surface composition
 * live here so the Host never re-implements per-channel logic.
 */
export interface LoomInteractionChannels {
  start(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>): Promise<void>;
  stop(): Promise<void>;
  deliver(attempt: DeliveryAttemptRequest): Promise<DeliveryObservation>;
  /** Channel-neutral live status keyed by stable channel id. */
  status(): Readonly<Record<string, InteractionChannelStatus>>;
  /** Move failed ingress items on one channel back to pending without a restart. */
  retryFailedIngress(channelId: string, itemId?: string): Promise<number>;
  agentSurface(): InteractionChannelAgentSurface | undefined;
  /** Route refs owned by each Channel id, for display in interaction history. */
  routeChannelIds(): ReadonlyMap<string, string>;
}

export function openLoomInteractionChannels(
  options: OpenLoomInteractionChannelsOptions,
): LoomInteractionChannels {
  if (options.channels.length === 0) {
    throw new Error("Loom requires at least one enabled Interaction Channel");
  }
  const channels = [...options.channels];
  const routes = new Set<string>();
  const ids = new Set<string>();
  for (const channel of channels) {
    if (routes.has(channel.routeRef)) {
      throw new Error(`Interaction Channels cannot share the route ${channel.routeRef}`);
    }
    routes.add(channel.routeRef);
    if (ids.has(channel.id)) {
      throw new Error(`Interaction Channels cannot share the id ${channel.id}`);
    }
    ids.add(channel.id);
  }
  if (options.defaultInteractionRoute && !routes.has(options.defaultInteractionRoute)) {
    throw new Error(
      `Default Interaction Route ${options.defaultInteractionRoute} is not an enabled Interaction Channel route`,
    );
  }
  const surface = composeAgentSurface(channels, options.defaultInteractionRoute);
  return {
    async start(acceptInput) {
      const started: InteractionChannel[] = [];
      try {
        for (const channel of channels) {
          await channel.start(acceptInput);
          started.push(channel);
        }
      } catch (error) {
        for (const channel of [...started].reverse()) {
          try {
            await channel.stop();
          } catch {
            // Roll back best effort; the original start failure is the cause.
          }
        }
        throw error;
      }
    },
    async stop() {
      for (const channel of [...channels].reverse()) await channel.stop();
    },
    async deliver(attempt) {
      const owner = channels.find(channel => channel.routeRef === attempt.routeRef);
      if (!owner) {
        return {
          status: "not_sent",
          error: `No enabled Interaction Channel owns route ${attempt.routeRef}`,
        };
      }
      return owner.deliver(attempt);
    },
    status: () => {
      const statuses: Record<string, InteractionChannelStatus> = {};
      for (const channel of channels) statuses[channel.id] = channel.status();
      return statuses;
    },
    async retryFailedIngress(channelId, itemId) {
      const owner = channels.find(channel => channel.id === channelId);
      if (!owner) {
        throw new Error(`No enabled Interaction Channel has id ${channelId}`);
      }
      if (!owner.retryFailedIngress) {
        throw new Error(`Interaction Channel ${channelId} does not support retrying failed ingress`);
      }
      return owner.retryFailedIngress(itemId);
    },
    agentSurface: () => surface,
    routeChannelIds: () => new Map(channels.map(channel => [channel.routeRef, channel.id])),
  };
}

/**
 * Rules shared by every Interaction Channel, presented before the
 * per-channel sections so guidance never repeats itself per channel.
 */
export const COMMON_CHANNEL_GUIDANCE = [
  "You are the same Individual across every Interaction Channel; continue the same identity, memory and relationships in each.",
  "Answer on the Route the interaction arrived on: a message that came in through Weixin is answered on Weixin, one from Raft on Raft.",
  "Choose the Destination from the current Interaction Context that matches the place you are answering; when more than one is available, prefer the one where the conversation lives.",
  "Speak within the visibility of the place you are in: what is said in a private channel or DM stays there and is not relayed to other places.",
  "Use message to make a durable Effect, and choose a Destination from the current Interaction Context when more than one is available.",
].join(" ");

function composeAgentSurface(
  channels: InteractionChannel[],
  defaultInteractionRoute: string | undefined,
): InteractionChannelAgentSurface | undefined {
  const surfaces = channels
    .map(channel => ({ channel, surface: channel.agentSurface?.() }))
    .filter(
      (entry): entry is { channel: InteractionChannel; surface: InteractionChannelAgentSurface } =>
        entry.surface !== undefined,
    );
  if (surfaces.length === 0) return undefined;

  const toolNames: string[] = [];
  const toolOwners = new Map<string, string>();
  for (const { channel, surface } of surfaces) {
    for (const name of surface.tools.names) {
      if (RESERVED_LOOM_TOOL_NAMES.has(name)) {
        throw new Error(`Interaction Channel ${channel.routeRef} uses the reserved tool name ${name}`);
      }
      const owner = toolOwners.get(name);
      if (owner) {
        throw new Error(`Interaction Channels ${owner} and ${channel.routeRef} both provide the tool ${name}`);
      }
      toolOwners.set(name, channel.routeRef);
      toolNames.push(name);
    }
  }

  const defaultSurface = defaultInteractionRoute
    ? surfaces.find(entry => entry.channel.routeRef === defaultInteractionRoute)
    : undefined;
  const attentionEntries = surfaces
    .map(entry => ({
      channel: entry.channel,
      source: entry.surface.attentionSource,
    }))
    .filter(
      (entry): entry is { channel: InteractionChannel; source: InteractionChannelAttentionSource } =>
        entry.source !== undefined,
    );

  return {
    guidance: composeGuidance(surfaces),
    tools: composeTools(surfaces, toolNames),
    destinations: surfaces.flatMap(
      entry => (entry.surface.defaultDestination ? [entry.surface.defaultDestination] : []),
    ),
    ...(defaultSurface?.surface.defaultDestination
      ? { defaultDestination: defaultSurface.surface.defaultDestination }
      : {}),
    ...(attentionEntries.length > 0
      ? { attentionSource: aggregateAttentionSources(attentionEntries) }
      : {}),
  };
}

function composeGuidance(
  surfaces: Array<{ channel: InteractionChannel; surface: InteractionChannelAgentSurface }>,
): string {
  return [
    COMMON_CHANNEL_GUIDANCE,
    ...surfaces.map(entry => `## ${entry.channel.label}\n\n${entry.surface.guidance.trim()}`),
  ].join("\n\n");
}

function composeTools(
  surfaces: Array<{ channel: InteractionChannel; surface: InteractionChannelAgentSurface }>,
  names: string[],
): InteractionChannelTools {
  return {
    names,
    create: control => surfaces.flatMap(entry => entry.surface.tools.create(control)),
  };
}

/**
 * Captures every source in one pass and merges them into a single bounded
 * evidence, keyed by stable channel id. The composite revision records each
 * child revision so acknowledgement reaches exactly the sources that
 * produced this capture — no hidden association state. A single source is
 * passed through untouched.
 */
function aggregateAttentionSources(
  entries: Array<{ channel: InteractionChannel; source: InteractionChannelAttentionSource }>,
): InteractionChannelAttentionSource {
  if (entries.length === 1) return entries[0]!.source;
  return {
    async capture(): Promise<ExternalAttentionEvidence | undefined> {
      const captured: Array<{ id: string; evidence: ExternalAttentionEvidence }> = [];
      for (const entry of entries) {
        const evidence = await entry.source.capture();
        if (evidence) captured.push({ id: entry.channel.id, evidence });
      }
      if (captured.length === 0) return undefined;
      captured.sort((a, b) => a.id.localeCompare(b.id));
      const observedAt = captured.reduce(
        (latest, entry) => (entry.evidence.observedAt > latest ? entry.evidence.observedAt : latest),
        captured[0]!.evidence.observedAt,
      );
      return {
        source: captured.map(entry => entry.id).join("|"),
        revision: JSON.stringify(captured.map(entry => ({
          channelId: entry.id,
          revision: entry.evidence.revision,
        }))),
        observedAt,
        evidence: Object.assign(
          {},
          ...captured.map(entry => ({ [entry.id]: entry.evidence.evidence })),
        ),
      };
    },
    async markPresented(revision) {
      let children: Array<{ channelId: string; revision: string }>;
      try {
        const parsed = JSON.parse(revision) as unknown;
        children = Array.isArray(parsed)
          ? parsed.filter(
              (child): child is { channelId: string; revision: string } =>
                typeof child === "object" && child !== null
                && typeof (child as { channelId?: unknown }).channelId === "string"
                && typeof (child as { revision?: unknown }).revision === "string",
            )
          : [];
      } catch {
        // A corrupt or unreadable persisted evidence revision (e.g. a
        // truncated journal after a crash) must not break the collection
        // loop: the presented store simply stays as it was, and the next
        // capture re-projects the same evidence.
        return;
      }
      for (const child of children) {
        const entry = entries.find(candidate => candidate.channel.id === child.channelId);
        if (entry) await entry.source.markPresented(child.revision);
      }
    },
  };
}
