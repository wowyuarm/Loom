import assert from "node:assert/strict";
import test from "node:test";

import type {
  AcceptedInput,
  DeliveryAttemptRequest,
  DeliveryObservation,
  RuntimeInput,
} from "../../src/runtime/index.js";
import type { InteractionChannel, InteractionChannelStatus } from "../../src/channels/index.js";
import type {
  ExternalAttentionEvidence,
  InteractionChannelAgentSurface,
} from "../../src/channels/surface.js";
import {
  COMMON_CHANNEL_GUIDANCE,
  openLoomInteractionChannels,
} from "../../src/channels/collection.js";

test("rejects zero Channels and duplicate routes or ids", () => {
  const weixin = mockChannel({ id: "weixin", routeRef: "primary-route" });
  const other = mockChannel({ id: "weixin", routeRef: "other-route" });
  const duplicateRoute = mockChannel({ id: "raft", routeRef: "primary-route" });

  assert.throws(
    () => openLoomInteractionChannels({ channels: [] }),
    /at least one enabled Interaction Channel/,
  );
  assert.throws(
    () => openLoomInteractionChannels({ channels: [weixin, duplicateRoute] }),
    /cannot share the route primary-route/,
  );
  assert.throws(
    () => openLoomInteractionChannels({ channels: [weixin, other] }),
    /cannot share the id weixin/,
  );
  assert.throws(
    () => openLoomInteractionChannels({
      channels: [weixin],
      defaultInteractionRoute: "missing-route",
    }),
    /Default Interaction Route missing-route is not an enabled Interaction Channel route/,
  );
});

test("routes delivery by routeRef and reports unknown routes as not_sent", async () => {
  const delivered: string[] = [];
  const channels = openLoomInteractionChannels({
    channels: [
      mockChannel({
        id: "weixin",
        routeRef: "primary-route",
        deliver: attempt => {
          delivered.push(attempt.routeRef);
          return { status: "delivered", remoteId: "1" };
        },
      }),
    ],
  });

  assert.deepEqual(
    await channels.deliver({
      attemptId: "attempt-1",
      effectId: "effect-1",
      routeRef: "primary-route",
      kind: "message",
      payload: { text: "hi" },
      idempotencyKey: "key-1",
    }),
    { status: "delivered", remoteId: "1" },
  );
  assert.deepEqual(delivered, ["primary-route"]);

  const unknown = await channels.deliver({
    attemptId: "attempt-2",
    effectId: "effect-2",
    routeRef: "foreign-route",
    kind: "message",
    payload: { text: "hi" },
    idempotencyKey: "key-2",
  });
  assert.equal(unknown.status, "not_sent");
  assert.match(unknown.error ?? "", /No enabled Interaction Channel owns route foreign-route/);
});

test("starts every Channel in order and stops them in reverse order", async () => {
  const events: string[] = [];
  const channels = openLoomInteractionChannels({
    channels: [
      mockChannel({
        id: "weixin",
        routeRef: "weixin-route",
        start: async () => { events.push("start:weixin"); },
        stop: async () => { events.push("stop:weixin"); },
      }),
      mockChannel({
        id: "raft",
        routeRef: "raft-route",
        start: async () => { events.push("start:raft"); },
        stop: async () => { events.push("stop:raft"); },
      }),
    ],
  });

  await channels.start(async () => ({ disposition: "accepted" } as AcceptedInput));
  await channels.stop();

  assert.deepEqual(events, ["start:weixin", "start:raft", "stop:raft", "stop:weixin"]);
});

test("rolls back already-started Channels when one Channel start fails", async () => {
  const events: string[] = [];
  const broken = openLoomInteractionChannels({
    channels: [
      mockChannel({
        id: "weixin",
        routeRef: "weixin-route",
        start: async () => { events.push("start:weixin"); },
        stop: async () => { events.push("stop:weixin"); },
      }),
      mockChannel({
        id: "raft",
        routeRef: "raft-route",
        start: async () => { events.push("start:raft"); },
        stop: async () => { events.push("stop:raft"); },
      }),
      mockChannel({
        id: "slack",
        routeRef: "slack-route",
        start: async () => {
          events.push("start:slack");
          throw new Error("channel exploded");
        },
      }),
    ],
  });

  await assert.rejects(
    broken.start(async () => ({ disposition: "accepted" } as AcceptedInput)),
    /channel exploded/,
  );
  assert.deepEqual(events, ["start:weixin", "start:raft", "start:slack", "stop:raft", "stop:weixin"]);
});

test("aggregates status keyed by stable Channel id", async () => {
  const channels = openLoomInteractionChannels({
    channels: [
      mockChannel({ id: "weixin", routeRef: "weixin-route", status: { state: "connected" } }),
      mockChannel({ id: "raft", routeRef: "raft-route", status: { state: "degraded", lastError: "boom" } }),
    ],
  });

  assert.deepEqual(channels.status(), {
    weixin: { state: "connected" },
    raft: { state: "degraded", lastError: "boom" },
  });
  assert.deepEqual(channels.routeChannelIds(), new Map([
    ["weixin-route", "weixin"],
    ["raft-route", "raft"],
  ]));
});

test("rejects duplicate tool names listing both owning routes and reserved names", () => {
  const tool = { names: ["echo"], create: () => [] };
  assert.throws(
    () => openLoomInteractionChannels({
      channels: [
        mockChannel({ id: "weixin", routeRef: "weixin-route", surface: { tools: tool } }),
        mockChannel({ id: "raft", routeRef: "raft-route", surface: { tools: tool } }),
      ],
    }),
    /Interaction Channels weixin-route and raft-route both provide the tool echo/,
  );
  assert.throws(
    () => openLoomInteractionChannels({
      channels: [
        mockChannel({ id: "weixin", routeRef: "weixin-route", surface: { tools: { names: ["message"], create: () => [] } } }),
      ],
    }),
    /reserved tool name message/,
  );
});

test("composes one shared guidance with per-label sections in Channel order", () => {
  const channels = openLoomInteractionChannels({
    channels: [
      mockChannel({ id: "weixin", routeRef: "weixin-route", label: "Weixin", surface: { guidance: "Weixin guidance body." } }),
      mockChannel({ id: "raft", routeRef: "raft-route", label: "Raft", surface: { guidance: "Raft guidance body." } }),
    ],
  });

  const surface = channels.agentSurface();
  assert.ok(surface);
  assert.match(surface.guidance, new RegExp(`^${escapeRegExp(COMMON_CHANNEL_GUIDANCE)}`));
  assert.match(surface.guidance, /## Weixin\n\nWeixin guidance body\./);
  assert.match(surface.guidance, /## Raft\n\nRaft guidance body\./);
  assert.ok(surface.guidance.indexOf("## Weixin") < surface.guidance.indexOf("## Raft"));
});

test("returns no agent surface when no Channel provides one", () => {
  const channels = openLoomInteractionChannels({
    channels: [mockChannel({ id: "weixin", routeRef: "weixin-route" })],
  });
  assert.equal(channels.agentSurface(), undefined);
});

test("exposes every Channel's stable Destination and keeps the default only from the default Route", async () => {
  const weixinDestination = {
    destinationRef: "weixin-destination",
    routeRef: "weixin-route",
    kind: "top_level" as const,
    label: "Weixin peer",
  };
  const raftDestination = {
    destinationRef: "raft-destination",
    routeRef: "raft-route",
    kind: "top_level" as const,
    label: "principal DM",
  };
  const delivered: string[] = [];
  const channels = openLoomInteractionChannels({
    channels: [
      mockChannel({
        id: "weixin",
        routeRef: "weixin-route",
        surface: { defaultDestination: weixinDestination },
        deliver: attempt => {
          delivered.push(`weixin:${attempt.routeRef}`);
          return { status: "delivered", remoteId: "w" };
        },
      }),
      mockChannel({
        id: "raft",
        routeRef: "raft-route",
        surface: { defaultDestination: raftDestination },
        deliver: attempt => {
          delivered.push(`raft:${attempt.routeRef}`);
          return { status: "delivered", remoteId: "r" };
        },
      }),
    ],
    defaultInteractionRoute: "raft-route",
  });

  const surface = channels.agentSurface();
  assert.ok(surface);
  assert.deepEqual(surface.defaultDestination, raftDestination);
  assert.deepEqual(surface.destinations, [weixinDestination, raftDestination]);

  // A Turn that arrived through Weixin can still answer through the Raft place:
  // the Effect fixed the Raft Destination, so the collection routes it by its
  // routeRef to the Raft Channel, and the Weixin Channel never sees it.
  assert.deepEqual(await channels.deliver({
    attemptId: "attempt-cross",
    effectId: "effect-cross",
    routeRef: "raft-route",
    kind: "message",
    payload: { text: "I will answer in Raft." },
    destinationRef: "raft-destination",
    idempotencyKey: "key-cross",
  }), { status: "delivered", remoteId: "r" });
  assert.deepEqual(delivered, ["raft:raft-route"]);
});

test("passes a single attention source through untouched", async () => {
  const source = attentionSource("captured-revision");
  const channels = openLoomInteractionChannels({
    channels: [mockChannel({ id: "weixin", routeRef: "weixin-route", surface: { attentionSource: source } })],
  });

  const evidence = await channels.agentSurface()?.attentionSource?.capture();
  assert.deepEqual(evidence, {
    source: "fixture",
    revision: "captured-revision",
    observedAt: "2026-08-05T00:00:00.000Z",
    evidence: { count: 1 },
  });
});

test("captures every attention source in one pass with a composite revision", async () => {
  const presented: Array<{ channel: string; revision: string }> = [];
  const channels = openLoomInteractionChannels({
    channels: [
      mockChannel({
        id: "weixin",
        routeRef: "weixin-route",
        surface: { attentionSource: attentionSource("w-1", revision => presented.push({ channel: "weixin", revision })) },
      }),
      mockChannel({
        id: "raft",
        routeRef: "raft-route",
        surface: { attentionSource: attentionSource("r-1", revision => presented.push({ channel: "raft", revision })) },
      }),
    ],
  });

  const aggregate = channels.agentSurface()?.attentionSource;
  assert.ok(aggregate);
  const evidence = await aggregate.capture();
  assert.ok(evidence);
  assert.equal(evidence.source, "raft|weixin");
  assert.deepEqual(JSON.parse(evidence.revision), [
    { channelId: "raft", revision: "r-1" },
    { channelId: "weixin", revision: "w-1" },
  ]);
  assert.deepEqual(evidence.evidence, {
    raft: { count: 1 },
    weixin: { count: 1 },
  });

  await aggregate.markPresented(evidence.revision);
  assert.deepEqual(presented, [
    { channel: "raft", revision: "r-1" },
    { channel: "weixin", revision: "w-1" },
  ]);
});

test("ignores malformed composite revisions when acknowledging attention", async () => {
  let acknowledged = 0;
  const channels = openLoomInteractionChannels({
    channels: [
      mockChannel({
        id: "weixin",
        routeRef: "weixin-route",
        surface: {
          attentionSource: {
            capture: async () => undefined,
            markPresented: async () => { acknowledged += 1; },
          },
        },
      }),
      mockChannel({
        id: "raft",
        routeRef: "raft-route",
        surface: {
          attentionSource: {
            capture: async () => undefined,
            markPresented: async () => { acknowledged += 1; },
          },
        },
      }),
    ],
  });

  await channels.agentSurface()?.attentionSource?.markPresented("not-json");
  await channels.agentSurface()?.attentionSource?.markPresented("42");
  await channels.agentSurface()?.attentionSource?.markPresented("[]");
  assert.equal(acknowledged, 0);
});

function mockChannel(options: {
  id: string;
  label?: string;
  routeRef: string;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
  status?: InteractionChannelStatus;
  deliver?: (attempt: DeliveryAttemptRequest) => DeliveryObservation | Promise<DeliveryObservation>;
  surface?: Partial<InteractionChannelAgentSurface>;
}): InteractionChannel {
  return {
    id: options.id,
    label: options.label ?? options.id,
    routeRef: options.routeRef,
    start: async (acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>) => {
      await options.start?.();
    },
    stop: async () => { await options.stop?.(); },
    deliver: async attempt => options.deliver?.(attempt) ?? { status: "not_sent", error: "no delivery" },
    status: () => options.status ?? { state: "stopped" },
    ...(options.surface ? {
      agentSurface: () => ({
        guidance: "",
        tools: { names: [], create: () => [] },
        ...options.surface,
      }),
    } : {}),
  };
}

function attentionSource(
  revision: string,
  onPresented: (revision: string) => void = () => {},
): InteractionChannelAttentionSourceFixture {
  return {
    async capture(): Promise<ExternalAttentionEvidence> {
      return {
        source: "fixture",
        revision,
        observedAt: "2026-08-05T00:00:00.000Z",
        evidence: { count: 1 },
      };
    },
    async markPresented(acknowledgedRevision) {
      onPresented(acknowledgedRevision);
    },
  };
}

interface InteractionChannelAttentionSourceFixture {
  capture(): Promise<ExternalAttentionEvidence | undefined>;
  markPresented(revision: string): Promise<void>;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
