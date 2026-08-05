import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  openRaftChannel,
  type RaftRemote,
} from "../../src/integrations/raft/index.js";
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
  assert.equal(channel.status().pendingWakes, 1);
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
  await eventually(() => channel.status().pendingWakes === 0 || channel.status().state === "degraded");

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
  assert.equal(recovered.status().pendingWakes, 0);
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
  await eventually(() => channel.status().pendingWakes === 0);

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
  await eventually(() => channel.status().pendingWakes === 0);

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
  await eventually(() => channel.status().pendingWakes === 0);
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
  await eventually(() => channel.status().pendingWakes === 0);

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

async function executeTool(
  tools: ReturnType<Awaited<ReturnType<typeof openRaftChannel>>["agentTools"]>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find(candidate => candidate.name === name);
  assert.ok(tool);
  return tool.execute(`call-${name}`, params, undefined, undefined, undefined as never);
}
