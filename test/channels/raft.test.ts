import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  openRaftChannel,
  RaftRetryableError,
  type RaftRemote,
} from "../../src/channels/raft/index.js";
import type { EffectRequest, RuntimeInput } from "../../src/runtime/index.js";

const activationTime = () => new Date("2026-08-03T04:59:00.000Z");

test("persists a content-free wake before resolving and completing its Runtime Input", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-ingress-"));
  const resolution = deferred<Awaited<ReturnType<RaftRemote["resolveMessage"]>>>();
  let resolveCalls = 0;
  const remote: RaftRemote = {
    async resolveMessage() {
      resolveCalls += 1;
      return resolution.promise;
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: "input-raft-message-42" };
  });

  assert.deepEqual(await channel.acceptWake({
    attemptId: "attempt-42",
    messageId: "message-42",
    receivedAt: "2026-08-03T05:00:01.000Z",
  }), { ok: true });
  assert.equal(channel.status().ingress.pending, 1);
  assert.equal(resolveCalls, 1);
  assert.equal(inputs.length, 0);

  resolution.resolve({
    messageId: "message-42",
    occurredAt: "2026-08-03T05:00:00.000Z",
    signal: "direct_message",
    content: "Can you look at this with me?",
    sender: {
      memberId: "human-yu",
      kind: "human",
      handle: "yu",
      displayName: "Yu",
    },
    place: {
      target: "dm:@yu",
      kind: "direct",
      visibility: "private",
      label: "DM with Yu",
      audience: "Only this Individual and Yu can see this DM.",
    },
  });
  await eventually(() => channel.status().ingress.pending === 0 || channel.status().state === "degraded");

  assert.equal(channel.status().state, "connected");
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], {
    source: "raft",
    sourceId: "message-42",
    kind: "interaction",
    payload: { text: "Can you look at this with me?" },
    occurredAt: "2026-08-03T05:00:00.000Z",
    interaction: {
      routeRef: "raft-primary",
      signal: "direct_message",
      actor: {
        actorRef: "human",
        kind: "human",
        label: "Yu (@yu)",
      },
      place: {
        placeRef: inputs[0]!.interaction!.place.placeRef,
        kind: "direct",
        label: "DM with Yu",
        visibility: "private",
      },
      audience: {
        visibility: "private",
        description: "Only this Individual and Yu can see this DM.",
        actorRefs: ["individual", "human"],
      },
      references: [{ kind: "message", ref: inputs[0]!.interaction!.references[0]!.ref }],
      destinations: [{
        destinationRef: inputs[0]!.interaction!.destinations[0]!.destinationRef,
        routeRef: "raft-primary",
        kind: "top_level",
        label: "DM with Yu",
      }],
      defaultDestinationRef: inputs[0]!.interaction!.destinations[0]!.destinationRef,
    },
  });
  assert.match(inputs[0]!.interaction!.place.placeRef, /^raft:place:/);
  assert.match(inputs[0]!.interaction!.references[0]!.ref, /^raft:message:/);
  assert.match(inputs[0]!.interaction!.destinations[0]!.destinationRef, /^raft:destination:/);

  await channel.stop();
  const recovered = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => recovered.stop());
  await recovered.start(async () => {
    throw new Error("a completed wake must not recreate its Input");
  });
  await recovered.acceptWake({
    attemptId: "attempt-42-replayed",
    messageId: "message-42",
    receivedAt: "2026-08-03T05:05:00.000Z",
  });
  await delay(20);
  assert.equal(resolveCalls, 1);
  assert.equal(recovered.status().ingress.pending, 0);
});

test("isolates one unresolvable wake so a later DM still reaches Runtime", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-isolated-wake-"));
  const remote: RaftRemote = {
    resolveMessage: async messageId => {
      if (messageId === "bad-wake") throw new Error("unsupported Raft message");
      return {
        messageId,
        occurredAt: "2026-08-03T05:00:00.000Z",
        signal: "direct_message",
        content: "This later DM must not be blocked.",
        sender: { memberId: "human-yu", kind: "human", handle: "yu" },
        place: { target: "dm:@yu", kind: "direct", visibility: "private", audience: "Only this Individual and Yu can see this DM." },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"), now: activationTime, routeRef: "raft-primary",
    serverId: "server-1", selfMemberId: "agent-hal", principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu", remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => { inputs.push(input); return { disposition: "accepted", inputId: input.sourceId }; });
  await channel.acceptWake({ attemptId: "bad-attempt", messageId: "bad-wake", receivedAt: "2026-08-03T05:00:00.000Z" });
  await channel.acceptWake({ attemptId: "good-attempt", messageId: "good-wake", receivedAt: "2026-08-03T05:00:01.000Z" });
  await eventually(() => inputs.length === 1);
  assert.equal(inputs[0]?.sourceId, "good-wake");
});

test("drains the authoritative inbox when an old wake is replayed and preserves Raft order", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-inbox-drain-"));
  let exposeInbox = false;
  let acknowledged = 0;
  const inbox = [
    { receiptId: "receipt-missed", messageId: "message-missed", receivedAt: "2026-08-03T05:00:00.000Z" },
    { receiptId: "receipt-later", messageId: "message-later", receivedAt: "2026-08-03T05:00:01.000Z" },
  ];
  const remote: RaftRemote = {
    async drainInbox() {
      const entries = exposeInbox ? inbox : [];
      exposeInbox = false;
      return {
        entries,
        spooled: 0,
        acknowledge: async () => { acknowledged += entries.length; },
      };
    },
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: messageId === "message-missed"
        ? "2026-08-03T05:00:00.000Z"
        : "2026-08-03T05:00:01.000Z",
      signal: "direct_message",
      content: messageId === "message-missed" ? "The missed message." : "The later message.",
      sender: { memberId: "human-yu", kind: "human", handle: "yu" },
      place: {
        target: "dm:@yu",
        kind: "direct",
        visibility: "private",
        audience: "Only this Individual and Yu can see this DM.",
      },
    }),
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const accepted: string[] = [];
  await channel.start(async input => {
    accepted.push(input.sourceId);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await channel.acceptWake({
    attemptId: "attempt-old",
    messageId: "message-old",
    receivedAt: "2026-08-03T04:59:30.000Z",
  });
  await eventually(() => accepted.includes("message-old"));
  accepted.length = 0;
  exposeInbox = true;

  await channel.acceptWake({
    attemptId: "attempt-old-replayed",
    messageId: "message-old",
    receivedAt: "2026-08-03T05:02:00.000Z",
  });
  await eventually(() => accepted.length === 2);

  assert.deepEqual(accepted, ["message-missed", "message-later"]);
  assert.equal(acknowledged, 2);
  assert.equal(channel.status().ingress.pending, 0);
});

test("recovers pending Raft inbox messages at startup without waiting for another wake", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-startup-inbox-"));
  let acknowledged = false;
  const remote: RaftRemote = {
    drainInbox: async () => ({
      entries: [{
        receiptId: "receipt-startup",
        messageId: "message-startup",
        receivedAt: "2026-08-03T05:00:00.000Z",
      }],
      spooled: 0,
      acknowledge: async () => { acknowledged = true; },
    }),
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: "2026-08-03T05:00:00.000Z",
      signal: "direct_message",
      content: "Recover this without another wake.",
      sender: { memberId: "human-yu", kind: "human", handle: "yu" },
      place: {
        target: "dm:@yu",
        kind: "direct",
        visibility: "private",
        audience: "Only this Individual and Yu can see this DM.",
      },
    }),
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const accepted: RuntimeInput[] = [];
  await channel.start(async input => {
    accepted.push(input);
    return { disposition: "accepted", inputId: "input-startup" };
  });

  await eventually(() => accepted.length === 1);
  assert.equal(accepted[0]?.sourceId, "message-startup");
  assert.equal(acknowledged, true);
});

test("exposes a previously observed Raft place beside the current default Destination", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-known-destinations-"));
  const remote: RaftRemote = {
    resolveMessage: async messageId => messageId === "message-ops"
      ? {
          messageId,
          occurredAt: "2026-08-03T05:00:00.000Z",
          signal: "mention",
          content: "Please keep this operations channel in view.",
          sender: { memberId: "agent-ops", kind: "agent", handle: "ops" },
          place: {
            target: "#operations",
            kind: "channel",
            visibility: "public",
            label: "operations",
            audience: "Members of #operations can read this channel.",
          },
        }
      : {
          messageId,
          occurredAt: "2026-08-03T05:01:00.000Z",
          signal: "direct_message",
          content: "Report the result where the team can see it.",
          sender: { memberId: "human-yu", kind: "human", handle: "yu" },
          place: {
            target: "dm:@yu",
            kind: "direct",
            visibility: "private",
            label: "DM with Yu",
            audience: "Only this Individual and Yu can see this DM.",
          },
        },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await channel.acceptWake({
    attemptId: "attempt-ops",
    messageId: "message-ops",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => inputs.length === 1);
  await channel.acceptWake({
    attemptId: "attempt-human",
    messageId: "message-human",
    receivedAt: "2026-08-03T05:01:01.000Z",
  });
  await eventually(() => inputs.length === 2);

  const current = inputs[1]!.interaction!;
  assert.equal(current.destinations.length, 2);
  assert.equal(current.destinations[0]!.label, "DM with Yu");
  assert.equal(current.defaultDestinationRef, current.destinations[0]!.destinationRef);
  assert.deepEqual(current.destinations[1], {
    destinationRef: inputs[0]!.interaction!.destinations[0]!.destinationRef,
    routeRef: "raft-primary",
    kind: "top_level",
    label: "operations",
  });
  assert.doesNotMatch(JSON.stringify(current), /#operations|dm:@yu/);

  await channel.stop();
  const recovered = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => recovered.stop());
  const recoveredInputs: RuntimeInput[] = [];
  await recovered.start(async input => {
    recoveredInputs.push(input);
    return { disposition: "accepted", inputId: `recovered-${input.sourceId}` };
  });
  await recovered.acceptWake({
    attemptId: "attempt-human-restart",
    messageId: "message-human-restart",
    receivedAt: "2026-08-03T05:02:01.000Z",
  });
  await eventually(() => recoveredInputs.length === 1);
  assert.equal(recoveredInputs[0]!.interaction!.destinations[1]!.label, "operations");
});

test("bounds known Raft Destinations by most recent observation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-bounded-destinations-"));
  const remote: RaftRemote = {
    resolveMessage: async messageId => {
      const number = Number(messageId.replace("message-channel-", ""));
      if (Number.isInteger(number)) {
        return {
          messageId,
          occurredAt: `2026-08-03T05:${String(number).padStart(2, "0")}:00.000Z`,
          signal: "mention",
          content: `Channel ${number} update.`,
          sender: { memberId: `agent-${number}`, kind: "agent", handle: `agent-${number}` },
          place: {
            target: `#channel-${number}`,
            kind: "channel",
            visibility: "public",
            label: `channel-${number}`,
            audience: `Members of channel ${number} can read it.`,
          },
        };
      }
      return {
        messageId,
        occurredAt: "2026-08-03T05:10:00.000Z",
        signal: "direct_message",
        content: "Which known place should receive the report?",
        sender: { memberId: "human-yu", kind: "human", handle: "yu" },
        place: {
          target: "dm:@yu",
          kind: "direct",
          visibility: "private",
          label: "DM with Yu",
          audience: "Only this Individual and Yu can see this DM.",
        },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  for (let number = 1; number <= 9; number += 1) {
    await channel.acceptWake({
      attemptId: `attempt-channel-${number}`,
      messageId: `message-channel-${number}`,
      receivedAt: `2026-08-03T05:${String(number).padStart(2, "0")}:01.000Z`,
    });
    await eventually(() => inputs.length === number);
  }
  await channel.acceptWake({
    attemptId: "attempt-current-dm",
    messageId: "message-current-dm",
    receivedAt: "2026-08-03T05:10:01.000Z",
  });
  await eventually(() => inputs.length === 10);

  assert.deepEqual(inputs[9]!.interaction!.destinations.map(destination => destination.label), [
    "DM with Yu",
    "channel-9",
    "channel-8",
    "channel-7",
    "channel-6",
    "channel-5",
    "channel-4",
    "channel-3",
  ]);
});

test("exposes an already registered principal DM beside a current channel Destination", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-registered-destination-"));
  const remote: RaftRemote = {
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: "2026-08-03T05:00:00.000Z",
      signal: "mention",
      content: "Please answer here or contact Yu deliberately.",
      sender: { memberId: "agent-ops", kind: "agent", handle: "ops" },
      place: {
        target: "#operations",
        kind: "channel",
        visibility: "public",
        label: "operations",
        audience: "Members of #operations can read this channel.",
      },
    }),
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  channel.agentSurface();
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await channel.acceptWake({
    attemptId: "attempt-operations",
    messageId: "message-operations",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => inputs.length === 1);

  assert.equal(inputs[0]!.interaction!.destinations.length, 2);
  assert.equal(inputs[0]!.interaction!.destinations[0]!.label, "operations");
  assert.deepEqual(inputs[0]!.interaction!.destinations[1], {
    destinationRef: channel.agentSurface().defaultDestination!.destinationRef,
    routeRef: "raft-primary",
    kind: "top_level",
    label: "DM with @yu",
  });
});

test("offers a top-level task's reply thread as an opaque optional Destination", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-task-thread-destination-"));
  const remote: RaftRemote = {
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: "2026-08-03T05:00:00.000Z",
      signal: "task",
      content: "Validate the new Raft behavior.",
      sender: { memberId: "agent-codex", kind: "agent", handle: "codex" },
      place: {
        target: "#Loom-Main",
        kind: "channel",
        visibility: "public",
        label: "Loom-Main",
        audience: "Members of #Loom-Main can read this channel.",
      },
      task: { number: 2, status: "todo", assigneeHandle: "@hal" },
    }),
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await channel.acceptWake({
    attemptId: "attempt-task-thread",
    messageId: "aaaaaaaa-1111-2222-3333-444444444444",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => inputs.length === 1);

  const interaction = inputs[0]!.interaction!;
  assert.equal(interaction.destinations.length, 2);
  assert.equal(interaction.defaultDestinationRef, interaction.destinations[0]!.destinationRef);
  assert.equal(interaction.destinations[0]!.kind, "top_level");
  assert.deepEqual(interaction.destinations[1], {
    destinationRef: interaction.destinations[1]!.destinationRef,
    routeRef: "raft-primary",
    kind: "reply_thread",
    label: "Loom-Main reply thread",
  });
  assert.match(interaction.destinations[1]!.destinationRef, /^raft:destination:/);
  assert.doesNotMatch(JSON.stringify(interaction), /#Loom-Main:aaaaaaaa/);
});

test("delivers a persisted message through its opaque Destination and preserves unknown outcomes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-delivery-"));
  const sends: Array<{ target: string; text: string }> = [];
  let sendOutcome: "sent" | "held" | "unknown" = "sent";
  const remote: RaftRemote = {
    resolveMessage: async () => ({
      messageId: "message-with-destination",
      occurredAt: "2026-08-03T05:00:00.000Z",
      signal: "thread_reply",
      content: "Please reply in this thread.",
      sender: { memberId: "agent-2", kind: "agent", handle: "helper" },
      place: {
        target: "#work:thread-77",
        kind: "reply_thread",
        visibility: "public",
        label: "#work reply thread",
        audience: "Members of #work can read this reply thread.",
      },
    }),
    async sendText(request) {
      sends.push(request);
      if (sendOutcome === "unknown") throw new Error("connection ended before Raft confirmed the send");
      if (sendOutcome === "held") return { disposition: "held", error: "Raft held a draft after newer activity" };
      return { disposition: "sent", remoteId: "remote-reply-1" };
    },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  let destinationRef = "";
  await channel.start(async input => {
    destinationRef = input.interaction!.destinations[0]!.destinationRef;
    return { disposition: "accepted", inputId: "input-with-destination" };
  });
  await channel.acceptWake({
    attemptId: "attempt-destination",
    messageId: "message-with-destination",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => channel.status().ingress.pending === 0);

  assert.deepEqual(await channel.deliver({
    attemptId: "delivery-1",
    effectId: "effect-1",
    kind: "message",
    payload: { text: "A reply from the same Individual." },
    routeRef: "raft-primary",
    destinationRef,
    idempotencyKey: "effect-1:1",
  }), { status: "delivered", remoteId: "remote-reply-1" });
  assert.deepEqual(sends[0], {
    target: "#work:thread-77",
    text: "A reply from the same Individual.",
  });

  sendOutcome = "held";
  assert.deepEqual(await channel.deliver({
    attemptId: "delivery-2",
    effectId: "effect-2",
    kind: "message",
    payload: { text: "Wait until the newer activity is read." },
    routeRef: "raft-primary",
    destinationRef,
    idempotencyKey: "effect-2:1",
  }), { status: "not_sent", error: "Raft held a draft after newer activity" });

  sendOutcome = "unknown";
  assert.deepEqual(await channel.deliver({
    attemptId: "delivery-3",
    effectId: "effect-3",
    kind: "message",
    payload: { text: "Do not automatically duplicate this." },
    routeRef: "raft-primary",
    destinationRef,
    idempotencyKey: "effect-3:1",
  }), {
    status: "unknown",
    error: "connection ended before Raft confirmed the send",
  });
});

test("offers bounded Raft tools that keep remote targets behind opaque refs", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-tools-"));
  const opened: Array<{ kind: string; value: string }> = [];
  const activityRequests: Array<{ after?: string }> = [];
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no ingress expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    listPlaces: async request => ({
      items: [{
        target: "#research",
        kind: "channel",
        visibility: "public",
        label: "research",
        joined: true,
        muted: false,
      }],
      ...(request.cursor ? {} : { nextCursor: "places-page-2" }),
    }),
    readActivity: async request => {
      activityRequests.push(request);
      return { items: [] };
    },
    searchMessages: async () => ({
      items: [{
        messageId: "message-1",
        occurredAt: "2026-08-03T05:00:00.000Z",
        place: { target: "#research", kind: "channel", visibility: "public", label: "research" },
        sender: { memberId: "agent-other", kind: "agent", handle: "other" },
        preview: "A thread message",
        references: [{ kind: "message", value: "message-1" }],
      }],
    }),
    openReference: async request => {
      opened.push({ kind: request.kind, value: request.value });
      if (request.kind === "message") {
        return {
          objectKind: "message",
          evidence: {
            content: "A thread message",
            sender: { kind: "agent", handle: "@other" },
            place: { kind: "reply_thread", visibility: "public", label: "research reply thread" },
            audience: "Members of #research can read this thread.",
            thread: {
              anchor: { content: "The anchor", visibility: "public" },
              replies: [{ content: "A reply", replyDestination: "#research:message-1" }],
            },
          },
          references: [{ kind: "destination", value: "#research:message-1" }],
        };
      }
      return {
        objectKind: "place",
        evidence: { description: "A public channel for ongoing research." },
        references: [],
      };
    },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const tools = channel.agentTools({ prepareEffect: () => ({ effectId: "unused" }) });
  assert.deepEqual(tools.map(tool => tool.name), [
    "raft_places",
    "raft_activity",
    "raft_search",
    "raft_open",
    "raft_task",
    "raft_attention",
  ]);

  const places = await executeTool(tools, "raft_places", { scope: "discoverable", limit: 10 });
  const placeDetails = places.details as {
    items: Array<{ placeRef: string }>;
    nextCursor?: string;
  };
  assert.match(placeDetails.items[0]!.placeRef, /^raft:place:/);
  assert.equal(placeDetails.nextCursor, "places-page-2");
  assert.doesNotMatch(JSON.stringify(places.details), /#research/);

  const openedPlace = await executeTool(tools, "raft_open", {
    ref: placeDetails.items[0]!.placeRef,
    limit: 20,
  });
  assert.deepEqual(opened, [{ kind: "place", value: "#research" }]);
  assert.deepEqual(openedPlace.details, {
    type: "loom.raft-open",
    version: 1,
    ref: placeDetails.items[0]!.placeRef,
    objectKind: "place",
    evidence: { description: "A public channel for ongoing research." },
    references: [],
  });

  const search = await executeTool(tools, "raft_search", { query: "thread", limit: 10 });
  const messageRef = (search.details as { items: Array<{ messageRef: string }> }).items[0]!.messageRef;
  const openedMessage = await executeTool(tools, "raft_open", { ref: messageRef });
  assert.match(openedMessage.content[0]!.type === "text" ? openedMessage.content[0]!.text : "", /The anchor/);
  assert.match(openedMessage.content[0]!.type === "text" ? openedMessage.content[0]!.text : "", /A reply/);
  assert.doesNotMatch(openedMessage.content[0]!.type === "text" ? openedMessage.content[0]!.text : "", /#research:message-1/);
  assert.deepEqual((openedMessage.details as { evidence: { thread: { replies: Array<{ replyDestinationRef: string }> } } }).evidence.thread.replies[0], {
    content: "A reply",
    replyDestinationRef: (openedMessage.details as { references: Array<{ kind: string; ref: string }> }).references.find(reference => reference.kind === "destination")!.ref,
  });
  assert.doesNotMatch(JSON.stringify(openedMessage.details), /#research:message-1/);

  await executeTool(tools, "raft_activity", { limit: 10 });
  assert.equal(activityRequests.length, 1);
  assert.ok(activityRequests[0]!.after);
  assert.ok(!Number.isNaN(Date.parse(activityRequests[0]!.after!)));
});

test("raft_open evidence does not promote a read-only reply destination to known", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-open-no-known-"));
  const opened: Array<{ kind: string; value: string }> = [];
  const remote: RaftRemote = {
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: "2026-08-05T05:00:00.000Z",
      signal: "mention",
      content: "A mention in research.",
      sender: { memberId: "human-yu", kind: "human", handle: "yu" },
      place: {
        target: "#research",
        kind: "channel",
        visibility: "public",
        label: "research",
        audience: "Members of #research can read this.",
      },
    }),
    openReference: async request => {
      opened.push({ kind: request.kind, value: request.value });
      return {
        objectKind: "message",
        evidence: {
          content: "A thread message",
          place: { kind: "reply_thread", visibility: "public", label: "research reply thread" },
          thread: {
            anchor: { content: "The anchor", visibility: "public" },
            replies: [{ content: "A reply", replyDestination: "#unfamiliar:abcd1234" }],
          },
        },
        references: [{ kind: "destination", value: "#unfamiliar:abcd1234" }],
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await channel.acceptWake({
    attemptId: "attempt-research-1",
    messageId: "message-research-1",
    receivedAt: "2026-08-05T05:00:01.000Z",
  });
  await eventually(() => inputs.length === 1);

  const tools = channel.agentTools({ prepareEffect: () => ({ effectId: "unused" }) });
  const messageRef = inputs[0]!.interaction!.references
    .find(reference => reference.kind === "message")!.ref;
  const openedMessage = await executeTool(tools, "raft_open", { ref: messageRef });
  const details = openedMessage.details as {
    evidence: { thread: { replies: Array<{ replyDestinationRef: string }> } };
    references: Array<{ kind: string; ref: string }>;
  };
  const replyDestinationRef = details.evidence.thread.replies[0]!.replyDestinationRef;
  assert.match(replyDestinationRef, /^raft:destination:/);
  assert.equal(
    replyDestinationRef,
    details.references.find(reference => reference.kind === "destination")!.ref,
  );

  await channel.acceptWake({
    attemptId: "attempt-research-2",
    messageId: "message-research-2",
    receivedAt: "2026-08-05T05:01:01.000Z",
  });
  await eventually(() => inputs.length === 2);

  const destinations = inputs[1]!.interaction!.destinations;
  assert.ok(
    !destinations.some(destination => destination.destinationRef === replyDestinationRef),
    "raft_open must not promote a read-only reply destination to a known Destination",
  );
  assert.ok(
    !destinations.some(destination => destination.label?.includes("unfamiliar")),
    "raft_open must not expose a read-only reply destination among known Destinations",
  );
});

test("prepares and delivers one task claim through an opaque task ref", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-task-claim-"));
  const taskActions: unknown[] = [];
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no ingress expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    readActivity: async () => ({
      items: [{
        signal: "task",
        occurredAt: "2026-08-05T01:00:00.000Z",
        place: { target: "#work", kind: "channel", visibility: "public", label: "work" },
        references: [{
          kind: "task",
          value: JSON.stringify({ target: "#work", number: 17, messageId: "task-message-17" }),
        }],
        summary: "Review the rollout [task #17 status=todo]",
      }],
    }),
    openReference: async request => {
      assert.equal(request.kind, "task");
      assert.deepEqual(JSON.parse(request.value), {
        target: "#work",
        number: 17,
        messageId: "task-message-17",
      });
      return {
        objectKind: "task",
        evidence: { number: 17, status: "todo", content: "Review the rollout" },
        references: [{ kind: "message", value: "task-message-17" }],
      };
    },
    mutateTask: async request => {
      taskActions.push(request);
      return { disposition: "succeeded", remoteId: "task-17-claimed" };
    },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const effects: EffectRequest[] = [];
  const tools = channel.agentTools({
    prepareEffect: effect => {
      effects.push(effect);
      return { effectId: "effect-task-claim" };
    },
  });
  const activity = await executeTool(tools, "raft_activity", { signals: ["task"], limit: 10 });
  const taskRef = (activity.details as {
    items: Array<{ references: Array<{ kind: string; ref: string }> }>;
  }).items[0]!.references.find(reference => reference.kind === "task")!.ref;

  const opened = await executeTool(tools, "raft_open", { ref: taskRef });
  assert.equal((opened.details as { objectKind: string }).objectKind, "task");
  assert.doesNotMatch(JSON.stringify(opened.details), /#work|task-message-17/);

  await executeTool(tools, "raft_task", { action: "claim", taskRef });
  assert.deepEqual(effects, [{
    kind: "raft_task",
    payload: { action: "claim", taskRef },
    routeRef: "raft-primary",
  }]);
  assert.deepEqual(await channel.deliver({
    attemptId: "delivery-task-claim",
    effectId: "effect-task-claim",
    kind: "raft_task",
    payload: effects[0]!.payload,
    routeRef: "raft-primary",
    idempotencyKey: "effect-task-claim:1",
  }), { status: "delivered", remoteId: "task-17-claimed" });
  assert.deepEqual(taskActions, [{
    action: "claim",
    target: "#work",
    number: 17,
    messageId: "task-message-17",
  }]);
});

test("prepares and delivers one thread unfollow through an opaque place ref", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-thread-unfollow-"));
  const attentionActions: unknown[] = [];
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no ingress expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    readActivity: async () => ({
      items: [{
        signal: "thread_reply",
        occurredAt: "2026-08-05T01:00:00.000Z",
        place: {
          target: "#work:abcd1234",
          kind: "reply_thread",
          visibility: "public",
          label: "work reply thread",
        },
        references: [{ kind: "message", value: "thread-message-1" }],
        summary: "The discussion is complete.",
      }],
    }),
    mutateAttention: async request => {
      attentionActions.push(request);
      return { disposition: "succeeded", remoteId: "thread-unfollowed" };
    },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const effects: EffectRequest[] = [];
  const tools = channel.agentTools({
    prepareEffect: effect => {
      effects.push(effect);
      return { effectId: "effect-thread-unfollow" };
    },
  });
  const activity = await executeTool(tools, "raft_activity", { limit: 10 });
  const placeRef = (activity.details as { items: Array<{ place: { placeRef: string } }> }).items[0]!.place.placeRef;

  await executeTool(tools, "raft_attention", {
    action: "unfollow_thread",
    placeRef,
    reason: "The accepted task is complete.",
  });
  assert.deepEqual(effects, [{
    kind: "raft_attention",
    payload: {
      action: "unfollow_thread",
      placeRef,
      reason: "The accepted task is complete.",
    },
    routeRef: "raft-primary",
  }]);
  assert.deepEqual(await channel.deliver({
    attemptId: "delivery-thread-unfollow",
    effectId: "effect-thread-unfollow",
    kind: "raft_attention",
    payload: effects[0]!.payload,
    routeRef: "raft-primary",
    idempotencyKey: "effect-thread-unfollow:1",
  }), { status: "delivered", remoteId: "thread-unfollowed" });
  assert.deepEqual(attentionActions, [{
    action: "unfollow_thread",
    target: "#work:abcd1234",
    reason: "The accepted task is complete.",
  }]);
});

test("mutes and unmutes only a regular channel place ref", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-channel-attention-"));
  const attentionActions: unknown[] = [];
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no ingress expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    listPlaces: async () => ({
      items: [{ target: "#work", kind: "channel", visibility: "public", label: "work", joined: true }],
    }),
    readActivity: async () => ({
      items: [{
        signal: "thread_reply",
        occurredAt: "2026-08-05T01:00:00.000Z",
        place: { target: "#work:abcd1234", kind: "reply_thread", visibility: "public" },
        references: [],
      }],
    }),
    mutateAttention: async request => {
      attentionActions.push(request);
      return { disposition: "succeeded", remoteId: `attention-${request.action}` };
    },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const effects: EffectRequest[] = [];
  const tools = channel.agentTools({
    prepareEffect: effect => {
      effects.push(effect);
      return { effectId: `effect-${effects.length}` };
    },
  });
  const places = await executeTool(tools, "raft_places", { scope: "joined" });
  const channelRef = (places.details as { items: Array<{ placeRef: string }> }).items[0]!.placeRef;
  const activity = await executeTool(tools, "raft_activity", { limit: 10 });
  const threadRef = (activity.details as { items: Array<{ place: { placeRef: string } }> }).items[0]!.place.placeRef;

  await assert.rejects(executeTool(tools, "raft_attention", {
    action: "unfollow_thread",
    placeRef: channelRef,
  }), /requires a reply-thread placeRef/);
  await assert.rejects(executeTool(tools, "raft_attention", {
    action: "mute_channel",
    placeRef: threadRef,
  }), /requires a regular-channel placeRef/);
  assert.equal(effects.length, 0);

  await executeTool(tools, "raft_attention", { action: "mute_channel", placeRef: channelRef });
  await executeTool(tools, "raft_attention", { action: "unmute_channel", placeRef: channelRef });
  assert.equal(effects.length, 2);
  for (const [index, effect] of effects.entries()) {
    assert.deepEqual(await channel.deliver({
      attemptId: `delivery-channel-attention-${index}`,
      effectId: `effect-${index + 1}`,
      kind: effect.kind,
      payload: effect.payload,
      routeRef: "raft-primary",
      idempotencyKey: `effect-${index + 1}:1`,
    }), {
      status: "delivered",
      remoteId: `attention-${index === 0 ? "mute_channel" : "unmute_channel"}`,
    });
  }
  assert.deepEqual(attentionActions, [
    { action: "mute_channel", target: "#work" },
    { action: "unmute_channel", target: "#work" },
  ]);
});

test("keeps rejected and unknown Raft actions distinct without retrying", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-action-outcomes-"));
  let attempts = 0;
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no ingress expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    readActivity: async () => ({
      items: [{
        signal: "task",
        occurredAt: "2026-08-05T01:00:00.000Z",
        place: { target: "#work", kind: "channel", visibility: "public" },
        references: [{
          kind: "task",
          value: JSON.stringify({ target: "#work", number: 17, messageId: "task-message-17" }),
        }],
      }],
    }),
    mutateTask: async () => {
      attempts += 1;
      if (attempts === 1) return { disposition: "rejected", error: "Task is already assigned to another member" };
      throw new Error("connection ended before Raft confirmed the action");
    },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const tools = channel.agentTools({ prepareEffect: () => ({ effectId: "unused" }) });
  const activity = await executeTool(tools, "raft_activity", { signals: ["task"], limit: 10 });
  const taskRef = (activity.details as {
    items: Array<{ references: Array<{ kind: string; ref: string }> }>;
  }).items[0]!.references.find(reference => reference.kind === "task")!.ref;
  const request = {
    attemptId: "delivery-task-action",
    effectId: "effect-task-action",
    kind: "raft_task",
    payload: { action: "claim", taskRef },
    routeRef: "raft-primary",
    idempotencyKey: "effect-task-action:1",
  };

  assert.deepEqual(await channel.deliver(request), {
    status: "not_sent",
    error: "Task is already assigned to another member",
  });
  assert.deepEqual(await channel.deliver({ ...request, attemptId: "delivery-task-action-2" }), {
    status: "unknown",
    error: "connection ended before Raft confirmed the action",
  });
  assert.equal(attempts, 2);
});

test("stops accepting new wakes while an in-flight wake reaches its Runtime boundary", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-stop-"));
  const resolution = deferred<Awaited<ReturnType<RaftRemote["resolveMessage"]>>>();
  const remote: RaftRemote = {
    resolveMessage: async () => resolution.promise,
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const accepted: RuntimeInput[] = [];
  await channel.start(async input => {
    accepted.push(input);
    return { disposition: "accepted", inputId: "input-before-stop" };
  });
  await channel.acceptWake({
    attemptId: "attempt-before-stop",
    messageId: "message-before-stop",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });

  const firstStop = channel.stop();
  const secondStop = channel.stop();
  await assert.rejects(channel.acceptWake({
    attemptId: "attempt-after-stop",
    messageId: "message-after-stop",
    receivedAt: "2026-08-03T05:00:02.000Z",
  }), /cannot accept a wake after stop/);

  resolution.resolve({
    messageId: "message-before-stop",
    occurredAt: "2026-08-03T05:00:00.000Z",
    signal: "direct_message",
    content: "This wake was already being resolved.",
    sender: { memberId: "human-yu", kind: "human", handle: "yu" },
    place: {
      target: "dm:@yu",
      kind: "direct",
      visibility: "private",
      audience: "Only this Individual and Yu can see this DM.",
    },
  });
  await Promise.all([firstStop, secondStop]);

  assert.equal(channel.status().state, "stopped");
  assert.equal(accepted.length, 1);
});

test("keeps ordinary channel activity out of Runtime Inputs until Orientation consumes a fixed revision", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-attention-"));
  const stateFile = path.join(root, "raft.db");
  const remote: RaftRemote = {
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: messageId === "ambient-1"
        ? "2026-08-03T05:00:00.000Z"
        : "2026-08-03T05:01:00.000Z",
      signal: "channel_activity",
      content: messageId === "ambient-1"
        ? "A public message body that must stay out of the snapshot."
        : "A later public message body.",
      sender: {
        memberId: messageId === "ambient-1" ? "agent-one" : "human-two",
        kind: messageId === "ambient-1" ? "agent" : "human",
        handle: messageId === "ambient-1" ? "one" : "two",
      },
      place: {
        target: "#commons",
        kind: "channel",
        visibility: "public",
        label: "commons",
        audience: "Members of #commons can read this channel.",
      },
    }),
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile,
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-loom",
    principalMemberId: "human-principal",
    principalDmTarget: "dm:@principal",
    remote,
  });
  let runtimeInputs = 0;
  await channel.start(async () => {
    runtimeInputs += 1;
    throw new Error("ordinary activity must not become a Runtime Input");
  });
  await channel.acceptWake({
    attemptId: "attempt-ambient-1",
    messageId: "ambient-1",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => channel.status().ingress.pending === 0);

  const source = channel.agentSurface().attentionSource;
  assert.ok(source);
  const first = await source.capture();
  assert.ok(first);
  assert.equal(first.source, "raft");
  assert.equal(first.evidence.signalCount, 1);
  assert.doesNotMatch(JSON.stringify(first), /public message body|ambient-1/);
  assert.equal(runtimeInputs, 0);

  await channel.acceptWake({
    attemptId: "attempt-ambient-2",
    messageId: "ambient-2",
    receivedAt: "2026-08-03T05:01:01.000Z",
  });
  await eventually(() => channel.status().ingress.pending === 0);
  assert.equal((await source.capture())?.evidence.signalCount, 2);
  await source.markPresented(first.revision);
  const remaining = await source.capture();
  assert.ok(remaining);
  assert.equal(remaining.evidence.signalCount, 1);

  await channel.stop();
  const recovered = await openRaftChannel({
    stateFile,
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-loom",
    principalMemberId: "human-principal",
    principalDmTarget: "dm:@principal",
    remote,
  });
  t.after(() => recovered.stop());
  const recoveredSource = recovered.agentSurface().attentionSource;
  assert.ok(recoveredSource);
  assert.equal((await recoveredSource.capture())?.revision, remaining.revision);
  await recoveredSource.markPresented(remaining.revision);
  assert.equal(await recoveredSource.capture(), undefined);
});

test("does not create a Runtime Input for a message that predates activation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-activation-boundary-"));
  const remote: RaftRemote = {
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: "2000-01-01T00:00:00.000Z",
      signal: "direct_message",
      content: "An old message.",
      sender: { memberId: "human-yu", kind: "human", handle: "yu" },
      place: {
        target: "dm:@yu",
        kind: "direct",
        visibility: "private",
        audience: "Only members of this DM can read it.",
      },
    }),
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-loom",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: "must-not-exist" };
  });
  await channel.acceptWake({
    attemptId: "attempt-old",
    messageId: "message-old",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => channel.status().ingress.pending === 0);

  assert.equal(inputs.length, 0);
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Raft Channel state");
    await delay(5);
  }
}

async function eventuallyWithClock(
  clock: { current: number },
  predicate: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Raft Channel state");
    clock.current += 25;
    await delay(5);
  }
}

async function executeTool(
  tools: ReturnType<Awaited<ReturnType<typeof openRaftChannel>>["agentTools"]>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find(candidate => candidate.name === name);
  assert.ok(tool);
  return tool.execute(`call-${name}`, params, undefined, undefined, undefined as never);
}

test("backs off a transiently failing wake and recovers it without manual intervention", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-backoff-"));
  let resolveCalls = 0;
  const remote: RaftRemote = {
    async resolveMessage(messageId) {
      resolveCalls += 1;
      if (resolveCalls <= 2) throw new RaftRetryableError("Raft CLI is briefly unavailable");
      return {
        messageId,
        occurredAt: "2026-08-03T05:00:00.000Z",
        signal: "direct_message",
        content: "Recover through bounded backoff.",
        sender: { memberId: "human-yu", kind: "human", handle: "yu" },
        place: {
          target: "dm:@yu",
          kind: "direct",
          visibility: "private",
          audience: "Only this Individual and Yu can see this DM.",
        },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  // A controllable clock: fixed activation boundary, advanced while waiting so
  // persisted retry deadlines eventually elapse (a frozen clock never lets a
  // retry_wait wake become due, and a real clock would make these messages
  // predate the activation boundary).
  const clock = { current: Date.parse("2026-08-03T04:59:00.000Z") };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: () => new Date(clock.current),
    retryBaseDelayMs: 40,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: input.sourceId };
  });

  await channel.acceptWake({
    attemptId: "attempt-transient",
    messageId: "message-transient",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await eventuallyWithClock(clock, () => channel.status().ingress.retrying === 1);
  assert.equal(channel.status().ingress.lastFailureCategory, "remote_unavailable");
  assert.equal(channel.status().ingress.failed, 0);

  await eventuallyWithClock(clock, () => inputs.length === 1);
  assert.equal(inputs[0]?.sourceId, "message-transient");
  assert.equal(resolveCalls, 3);
  assert.equal(channel.status().ingress.pending, 0);
  assert.equal(channel.status().ingress.retrying, 0);
  assert.equal(channel.status().ingress.failed, 0);
});

test("marks a permanently failing wake as failed and never retries it automatically", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-permanent-"));
  let badCalls = 0;
  const remote: RaftRemote = {
    async resolveMessage(messageId) {
      if (messageId === "bad-wake") {
        badCalls += 1;
        throw new Error("unsupported Raft message");
      }
      return {
        messageId,
        occurredAt: "2026-08-03T05:00:00.000Z",
        signal: "direct_message",
        content: "A later DM must not be blocked by the failed wake.",
        sender: { memberId: "human-yu", kind: "human", handle: "yu" },
        place: {
          target: "dm:@yu",
          kind: "direct",
          visibility: "private",
          audience: "Only this Individual and Yu can see this DM.",
        },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    retryBaseDelayMs: 30,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: input.sourceId };
  });

  await channel.acceptWake({
    attemptId: "bad-attempt",
    messageId: "bad-wake",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await eventually(() => channel.status().ingress.failed === 1);
  assert.equal(channel.status().ingress.lastFailureCategory, "invalid_message");

  await channel.acceptWake({
    attemptId: "good-attempt",
    messageId: "good-wake",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => inputs.length === 1);
  assert.equal(inputs[0]?.sourceId, "good-wake");

  await delay(150);
  assert.equal(badCalls, 1);
  assert.equal(channel.status().ingress.failed, 1);
});

test("retries failed wakes on demand without a restart and without duplicating Inputs", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-manual-retry-"));
  let permanent = true;
  const remote: RaftRemote = {
    async resolveMessage(messageId) {
      if (permanent) throw new Error("permanent failure");
      return {
        messageId,
        occurredAt: "2026-08-03T05:00:00.000Z",
        signal: "direct_message",
        content: `Retried content for ${messageId}.`,
        sender: { memberId: "human-yu", kind: "human", handle: "yu" },
        place: {
          target: "dm:@yu",
          kind: "direct",
          visibility: "private",
          audience: "Only this Individual and Yu can see this DM.",
        },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: activationTime,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: input.sourceId };
  });
  await channel.acceptWake({
    attemptId: "attempt-first",
    messageId: "first-wake",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await channel.acceptWake({
    attemptId: "attempt-second",
    messageId: "second-wake",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventually(() => channel.status().ingress.failed === 2);
  permanent = false;

  const [firstItemId, secondItemId] = channel.status().ingress.failedItemIds!;
  assert.deepEqual([firstItemId, secondItemId], ["wake-1", "wake-2"]);

  assert.equal(await channel.retryFailedIngress(firstItemId), 1);
  await eventually(() => inputs.some(input => input.sourceId === "first-wake"));
  assert.equal(inputs.filter(input => input.sourceId === "first-wake").length, 1);
  await assert.rejects(channel.retryFailedIngress(firstItemId), /is not failed/);

  assert.equal(await channel.retryFailedIngress(), 1);
  await eventually(() => inputs.some(input => input.sourceId === "second-wake"));
  assert.equal(inputs.filter(input => input.sourceId === "second-wake").length, 1);
  assert.equal(channel.status().ingress.failed, 0);
  assert.equal(channel.status().ingress.pending, 0);

  await assert.rejects(channel.retryFailedIngress("wake-99"), /is not known/);
});

test("persists retry and failure state across a channel restart", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-restart-state-"));
  const stateFile = path.join(root, "raft.db");
  const remote: RaftRemote = {
    resolveMessage: async messageId => {
      if (messageId === "permanent-wake") throw new Error("permanent failure");
      throw new RaftRetryableError("Raft CLI is still unavailable");
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const clock = { current: Date.parse("2026-08-03T04:59:00.000Z") };
  const channel = await openRaftChannel({
    stateFile,
    now: () => new Date(clock.current),
    retryBaseDelayMs: 50,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: input.sourceId };
  });
  await channel.acceptWake({
    attemptId: "attempt-permanent",
    messageId: "permanent-wake",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await channel.acceptWake({
    attemptId: "attempt-retry",
    messageId: "retry-wake",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventuallyWithClock(clock, () => channel.status().ingress.failed === 1 && channel.status().ingress.retrying === 1);
  await channel.stop();
  assert.equal(inputs.length, 0);

  const recoveredRemote: RaftRemote = {
    resolveMessage: async messageId => {
      if (messageId === "permanent-wake") throw new Error("permanent failure");
      return {
        messageId,
        occurredAt: "2026-08-03T05:00:01.000Z",
        signal: "direct_message",
        content: "Recovered after restart.",
        sender: { memberId: "human-yu", kind: "human", handle: "yu" },
        place: {
          target: "dm:@yu",
          kind: "direct",
          visibility: "private",
          audience: "Only this Individual and Yu can see this DM.",
        },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const recovered = await openRaftChannel({
    stateFile,
    now: () => new Date(clock.current),
    retryBaseDelayMs: 50,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote: recoveredRemote,
  });
  t.after(() => recovered.stop());
  await recovered.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: input.sourceId };
  });
  assert.equal(recovered.status().ingress.failed, 1);
  assert.equal(recovered.status().ingress.retrying, 1);

  await eventuallyWithClock(clock, () => recovered.status().ingress.retrying === 0 && inputs.length === 1);
  assert.equal(inputs[0]?.sourceId, "retry-wake");
  assert.equal(recovered.status().ingress.failed, 1);
  assert.equal(recovered.status().ingress.pending, 0);
});

test("treats Runtime admission failure as retryable and recovers", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-admission-retry-"));
  let admissions = 0;
  const remote: RaftRemote = {
    resolveMessage: async messageId => ({
      messageId,
      occurredAt: "2026-08-03T05:00:00.000Z",
      signal: "direct_message",
      content: "Admit this after a transient Runtime block.",
      sender: { memberId: "human-yu", kind: "human", handle: "yu" },
      place: {
        target: "dm:@yu",
        kind: "direct",
        visibility: "private",
        audience: "Only this Individual and Yu can see this DM.",
      },
    }),
    sendText: async () => { throw new Error("no send expected"); },
  };
  const clock = { current: Date.parse("2026-08-03T04:59:00.000Z") };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: () => new Date(clock.current),
    retryBaseDelayMs: 40,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  await channel.start(async () => {
    admissions += 1;
    if (admissions === 1) throw new Error("Runtime is busy");
    return { disposition: "accepted", inputId: "input-admitted" };
  });

  await channel.acceptWake({
    attemptId: "attempt-admission",
    messageId: "message-admission",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await eventuallyWithClock(clock, () => channel.status().ingress.lastFailureCategory === "admission_failed");
  assert.equal(channel.status().ingress.retrying, 1);

  await eventuallyWithClock(clock, () => admissions === 2);
  assert.equal(channel.status().ingress.retrying, 0);
  assert.equal(channel.status().ingress.pending, 0);
  assert.equal(channel.status().ingress.failed, 0);
});

test("picks the most recent failure category by local insertion order when attempts tie", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-category-tie-"));
  const remote: RaftRemote = {
    resolveMessage: async messageId => {
      if (messageId === "tie-permanent") throw new Error("permanent failure");
      throw new RaftRetryableError("Raft CLI is still unavailable");
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const clock = { current: Date.parse("2026-08-03T04:59:00.000Z") };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: () => new Date(clock.current),
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  await channel.start(async () => ({ disposition: "accepted", inputId: "input-tie" }));

  await channel.acceptWake({
    attemptId: "attempt-tie-a",
    messageId: "tie-retry",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await channel.acceptWake({
    attemptId: "attempt-tie-b",
    messageId: "tie-permanent",
    receivedAt: "2026-08-03T05:00:01.000Z",
  });
  await eventuallyWithClock(clock, () => channel.status().ingress.lastFailureCategory !== undefined);
  // Both attempts share the same clock instant; the later-inserted item
  // wins the tie, so its category is the one reported.
  assert.equal(channel.status().ingress.lastFailureCategory, "invalid_message");
});

test("status failure times come from currently failed wakes and follow manual retry and restart", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-failure-times-"));
  let permanent = true;
  const remote: RaftRemote = {
    async resolveMessage(messageId) {
      if (permanent) throw new Error("permanent failure");
      return {
        messageId,
        occurredAt: "2026-08-03T05:00:00.000Z",
        signal: "direct_message",
        content: `Recovered ${messageId}.`,
        sender: { memberId: "human-yu", kind: "human", handle: "yu" },
        place: {
          target: "dm:@yu",
          kind: "direct",
          visibility: "private",
          audience: "Only this Individual and Yu can see this DM.",
        },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const clock = { current: Date.parse("2026-08-03T05:00:00.000Z") };
  const open = () => openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: () => new Date(clock.current),
    retryBaseDelayMs: 40,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  const channel = await open();
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: input.sourceId };
  });

  // First wake fails permanently at 05:00:00.
  await channel.acceptWake({
    attemptId: "attempt-first",
    messageId: "first-wake",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await eventually(() => channel.status().ingress.failed === 1);
  assert.equal(channel.status().ingress.firstFailureAt, "2026-08-03T05:00:00.000Z");
  assert.equal(channel.status().ingress.lastFailureAt, "2026-08-03T05:00:00.000Z");

  // Second wake fails permanently later at 05:10:00; MIN/MAX now differ and
  // only currently failed rows count (the pending/retrying rows are excluded).
  clock.current = Date.parse("2026-08-03T05:10:00.000Z");
  await channel.acceptWake({
    attemptId: "attempt-second",
    messageId: "second-wake",
    receivedAt: "2026-08-03T05:10:00.000Z",
  });
  await eventually(() => channel.status().ingress.failed === 2);
  assert.equal(channel.status().ingress.firstFailureAt, "2026-08-03T05:00:00.000Z");
  assert.equal(channel.status().ingress.lastFailureAt, "2026-08-03T05:10:00.000Z");

  // Manual retry of the older wake clears it; the remaining failed set
  // recomputes both times from the surviving row.
  permanent = false;
  const [firstItemId] = channel.status().ingress.failedItemIds!;
  assert.equal(await channel.retryFailedIngress(firstItemId), 1);
  await eventually(() => channel.status().ingress.failed === 1);
  assert.equal(channel.status().ingress.firstFailureAt, "2026-08-03T05:10:00.000Z");
  assert.equal(channel.status().ingress.lastFailureAt, "2026-08-03T05:10:00.000Z");
  assert.equal(channel.status().ingress.lastFailureCategory, "invalid_message");

  // Restart keeps the same authoritative times from the persisted wakes.
  await channel.stop();
  clock.current = Date.parse("2026-08-03T06:00:00.000Z");
  const recovered = await open();
  t.after(() => recovered.stop());
  await recovered.start(async () => {
    throw new Error("a failed wake must not be auto-processed after restart");
  });
  assert.equal(recovered.status().ingress.failed, 1);
  assert.equal(recovered.status().ingress.firstFailureAt, "2026-08-03T05:10:00.000Z");
  assert.equal(recovered.status().ingress.lastFailureAt, "2026-08-03T05:10:00.000Z");
});

test("failure times ignore pending and retry_wait wakes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-failure-times-filter-"));
  let releasePending: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releasePending = resolve; });
  const remote: RaftRemote = {
    async resolveMessage(messageId) {
      if (messageId === "pending-wake") {
        await gate;
        return {
          messageId,
          occurredAt: "2026-08-03T05:00:00.000Z",
          signal: "direct_message",
          content: "A wake that stayed pending while others failed.",
          sender: { memberId: "human-yu", kind: "human", handle: "yu" },
          place: {
            target: "dm:@yu",
            kind: "direct",
            visibility: "private",
            audience: "Only this Individual and Yu can see this DM.",
          },
        };
      }
      if (messageId === "retry-wake") throw new RaftRetryableError("server unavailable");
      throw new Error("permanent failure");
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const clock = { current: Date.parse("2026-08-03T05:00:00.000Z") };
  const channel = await openRaftChannel({
    stateFile: path.join(root, "raft.db"),
    now: () => new Date(clock.current),
    retryBaseDelayMs: 60_000,
    routeRef: "raft-primary",
    serverId: "server-1",
    selfMemberId: "agent-hal",
    principalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    remote,
  });
  t.after(() => channel.stop());
  const inputs: RuntimeInput[] = [];
  await channel.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: input.sourceId };
  });

  // A transient failure stays retry_wait (next_retry_at far in the future).
  await channel.acceptWake({
    attemptId: "attempt-retry",
    messageId: "retry-wake",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await eventually(() => channel.status().ingress.retrying === 1);
  assert.equal(channel.status().ingress.failed, 0);
  assert.equal(channel.status().ingress.firstFailureAt, undefined);

  // A permanent failure at 05:00:00 is the only failed row so far.
  await channel.acceptWake({
    attemptId: "attempt-failed",
    messageId: "failed-wake",
    receivedAt: "2026-08-03T05:00:00.000Z",
  });
  await eventually(() => channel.status().ingress.failed === 1);
  assert.equal(channel.status().ingress.firstFailureAt, "2026-08-03T05:00:00.000Z");
  assert.equal(channel.status().ingress.lastFailureAt, "2026-08-03T05:00:00.000Z");

  // A wake held in pending (resolve never settles) must not change the times:
  // MIN/MAX count only currently failed rows.
  await channel.acceptWake({
    attemptId: "attempt-pending",
    messageId: "pending-wake",
    receivedAt: "2026-08-03T05:05:00.000Z",
  });
  await eventually(() => channel.status().ingress.pending === 1);
  assert.equal(channel.status().ingress.pending, 1);
  assert.equal(channel.status().ingress.retrying, 1);
  assert.equal(channel.status().ingress.failed, 1);
  assert.equal(channel.status().ingress.firstFailureAt, "2026-08-03T05:00:00.000Z");
  assert.equal(channel.status().ingress.lastFailureAt, "2026-08-03T05:00:00.000Z");

  // Let the pending wake complete, then fail a second wake later; the still
  // retry_wait row must stay excluded from both times.
  releasePending!();
  await eventually(() => inputs.some(input => input.sourceId === "pending-wake"));
  clock.current = Date.parse("2026-08-03T05:10:00.000Z");
  await channel.acceptWake({
    attemptId: "attempt-failed-later",
    messageId: "failed-wake-later",
    receivedAt: "2026-08-03T05:10:00.000Z",
  });
  await eventually(() => channel.status().ingress.failed === 2);
  assert.equal(channel.status().ingress.retrying, 1);
  assert.equal(channel.status().ingress.pending, 0);
  assert.equal(channel.status().ingress.firstFailureAt, "2026-08-03T05:00:00.000Z");
  assert.equal(channel.status().ingress.lastFailureAt, "2026-08-03T05:10:00.000Z");
});
