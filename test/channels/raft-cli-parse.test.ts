import assert from "node:assert/strict";
import test from "node:test";

import {
  RaftCliCommandError,
  cursorOffset,
  decodeXml,
  directMessageHandle,
  dmPlaceEvidence,
  dmPlaceFor,
  historyEvidence,
  localTimestamp,
  parseChannelInfo,
  parseHistory,
  parseInboxNotices,
  parseInboxSpoolEntry,
  parseResolvedMessageHeader,
  parseTarget,
  parseTaskReference,
  rejectedMutation,
  resolvedContent,
  safePlaceLabel,
  signalFor,
  signalForFast,
  taskAssignment,
  taskContent,
  validateBridgeWake,
} from "../../src/channels/raft/raft-cli-parse.js";

test("parseResolvedMessageHeader parses a 0.0.17 resolve header and remainder", () => {
  const header = parseResolvedMessageHeader(
    "[target=#general msg=1234abcd time=2026-08-03 05:00:00 type=human] @yu: hello everyone",
  );
  assert.deepEqual(header, {
    target: "#general",
    shortId: "1234abcd",
    localTime: "2026-08-03 05:00:00",
    senderKind: "human",
    senderHandle: "yu",
    remainder: ": hello everyone",
  });
  assert.throws(
    () => parseResolvedMessageHeader("unsupported"),
    /unsupported 0\.0\.17 format/,
  );
});

test("parseHistory parses only [seq= lines and rejects unsupported rows", () => {
  const rows = parseHistory([
    "[seq=1 msg=aaaa1111-2222-3333-4444-555566667777 time=2026-08-03 05:00:00 type=agent] @alice: hi",
    "interleaved noise",
    "[seq=2 msg=bbbb2222-2222-3333-4444-555566667777 time=2026-08-03 05:01:00 type=system] @system: archive",
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    messageId: "aaaa1111-2222-3333-4444-555566667777",
    occurredAt: "2026-08-03T05:00:00.000Z",
    senderName: "alice",
    senderType: "agent",
    remainder: ": hi",
  });
  assert.equal(rows[1]!.senderType, "system");
  assert.throws(
    () => parseHistory("[seq=1 msg=xyz time=nope type=human] @x: y"),
    /unsupported 0\.0\.17 history format/,
  );
});

test("parseInboxNotices extracts receipts and parseInboxSpoolEntry validates persisted entries", () => {
  const notices = parseInboxNotices([
    "[target=#general msg=1234abcd time=2026-08-03 05:00:00 type=human] @yu: hi",
    "[target=dm:@yu msg=5678efab time=2026-08-03 05:01:00 type=agent] @alice: hello",
    "not a notice",
  ].join("\n"));
  assert.deepEqual(notices, [
    {
      receiptId: "#general:1234abcd",
      target: "#general",
      shortId: "1234abcd",
      receivedAt: "2026-08-03T05:00:00.000Z",
    },
    {
      receiptId: "dm:@yu:5678efab",
      target: "dm:@yu",
      shortId: "5678efab",
      receivedAt: "2026-08-03T05:01:00.000Z",
    },
  ]);
  assert.deepEqual(parseInboxSpoolEntry({
    receiptId: "#general:1234abcd",
    target: "#general",
    shortId: "1234abcd",
    receivedAt: "2026-08-03T05:00:00.000Z",
    messageId: "1234abcd-2222-3333-4444-555566667777",
  }), {
    receiptId: "#general:1234abcd",
    target: "#general",
    shortId: "1234abcd",
    receivedAt: "2026-08-03T05:00:00.000Z",
    messageId: "1234abcd-2222-3333-4444-555566667777",
  });
  assert.throws(() => parseInboxSpoolEntry({ receiptId: "", target: "#g", shortId: "x", receivedAt: "nope" }));
  assert.throws(() => parseInboxSpoolEntry("not-an-object"));
});

test("parseTarget distinguishes top-level and reply-thread targets", () => {
  assert.deepEqual(parseTarget("#general"), { base: "#general", thread: false });
  assert.deepEqual(parseTarget("dm:@yu"), { base: "dm:@yu", thread: false });
  assert.deepEqual(parseTarget("#general:1234abcd"), { base: "#general", thread: true });
  assert.deepEqual(parseTarget("dm:@yu:1234abcd"), { base: "dm:@yu", thread: true });
  assert.throws(() => parseTarget("#general:nothex"), /unsupported target/);
});

test("cursorOffset and directMessageHandle validate their inputs", () => {
  assert.equal(cursorOffset(undefined), 0);
  assert.equal(cursorOffset("42"), 42);
  assert.throws(() => cursorOffset("0x2a"), /cursor is invalid/);
  assert.equal(directMessageHandle("dm:@yu"), "yu");
  assert.throws(() => directMessageHandle("dm:@yu:1234abcd"), /top-level dm:@handle/);
});

test("resolvedContent strips the sender description or plain separator", () => {
  assert.equal(resolvedContent(": hello", undefined), "hello");
  assert.equal(resolvedContent(" — Loom 实现 lane: hello", "Loom 实现 lane"), "hello");
  assert.throws(() => resolvedContent("hello", undefined), /unsupported sender\/content separator/);
  assert.throws(() => resolvedContent(":   ", undefined), /blank content/);
});

test("taskAssignment parses task suffixes with typed or handle assignees", () => {
  assert.deepEqual(taskAssignment("fix it [task #12 status=in_progress assignee=agent:terra]"), {
    number: 12,
    status: "in_progress",
    assigneeType: "agent",
    assigneeId: "terra",
  });
  assert.deepEqual(taskAssignment("hi [task #3 status=done assignee=@yu]"), {
    number: 3,
    status: "done",
    assigneeHandle: "@yu",
  });
  assert.equal(taskAssignment("no task here"), undefined);
  assert.equal(taskContent("fix it [task #12 status=in_progress assignee=agent:terra]"), "fix it");
});

test("parseTaskReference requires a well-formed task ref object", () => {
  assert.deepEqual(parseTaskReference(JSON.stringify({ target: "#Loom-Arc", number: 2, messageId: "abc12345" })), {
    target: "#Loom-Arc",
    number: 2,
    messageId: "abc12345",
  });
  assert.throws(() => parseTaskReference("nope"), /task ref is malformed/);
  assert.throws(() => parseTaskReference(JSON.stringify({ target: "#g", number: "x", messageId: "m" })), /task ref is malformed/);
});

test("safePlaceLabel prefers a provided label but falls back to a canonical one", () => {
  assert.equal(safePlaceLabel("#general", "Loom 频道"), "Loom 频道");
  assert.equal(safePlaceLabel("#general"), "general");
  assert.equal(safePlaceLabel("#general:1234abcd"), "general reply thread");
  assert.equal(safePlaceLabel("dm:@yu"), "DM with @yu");
  assert.equal(safePlaceLabel("dm:@yu:1234abcd"), "DM with @yu reply thread");
});

test("decodeXml and localTimestamp are deterministic", () => {
  assert.equal(decodeXml("a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;"), "a <b> & \"c\" 'd'");
  assert.equal(localTimestamp("2026-08-03 05:00:00"), "2026-08-03T05:00:00.000Z");
  assert.throws(() => localTimestamp("nope"), /invalid timestamp/);
});

test("validateBridgeWake accepts the configured wake and rejects mismatches", () => {
  validateBridgeWake({
    schema: "raft-channel-wake.v1",
    attemptId: "a",
    eventId: "b",
    messageId: "c",
    agentId: "agent-loom",
    profile: "loom-pilot",
    coreSessionId: "d",
    adapterInstance: "e",
    occurredAt: "2026-08-03T05:00:00Z",
  }, { profile: "loom-pilot", agentId: "agent-loom" });
  assert.throws(
    () => validateBridgeWake({ schema: "raft-channel-wake.v1", attemptId: "a" }, { profile: "loom-pilot", agentId: "agent-loom" }),
    /agent binding/,
  );
  assert.throws(
    () => validateBridgeWake({
      schema: "raft-channel-wake.v1",
      attemptId: "a",
      eventId: "b",
      messageId: "c",
      agentId: "agent-loom",
      profile: "loom-pilot",
      coreSessionId: "d",
      adapterInstance: "e",
      occurredAt: "not-a-time",
    }, { profile: "loom-pilot", agentId: "agent-loom" }),
    /ISO timestamp/,
  );
  assert.throws(
    () => validateBridgeWake({
      schema: "raft-channel-wake.v1",
      attemptId: "a",
      agentId: "agent-loom",
      profile: "loom-pilot",
      occurredAt: "2026-08-03T05:00:00Z",
      rogue: 1,
    }, { profile: "loom-pilot", agentId: "agent-loom" }),
    /unsupported field/,
  );
});

test("parseChannelInfo maps channel info output to a place", () => {
  assert.deepEqual(parseChannelInfo([
    "Visibility: private",
    "Joined: yes",
    "Muted: no",
  ].join("\n"), "#Loom-Arc"), {
    target: "#Loom-Arc",
    kind: "channel",
    visibility: "private",
    label: "Loom-Arc",
    joined: true,
    muted: false,
  });
  assert.throws(() => parseChannelInfo("Visibility: unknown", "#x"), /did not report visibility/);
});

test("historyEvidence maps a resolved message to evidence with sender profile resolution", () => {
  const place = {
    target: "dm:@yu",
    kind: "direct" as const,
    visibility: "private" as const,
    label: "DM with @yu",
    audience: "Only members of dm:@yu can read this DM.",
  };
  const message = {
    messageId: "1234abcd-2222-3333-4444-555566667777",
    occurredAt: "2026-08-03T05:00:00.000Z",
    senderName: "yu",
    senderType: "human" as const,
    remainder: " — Yu: hello",
  };
  assert.deepEqual(historyEvidence(message, place, {
    id: "human-yu",
    kind: "human",
    name: "yu",
    displayName: "Yu",
    description: "Yu",
  }), {
    occurredAt: "2026-08-03T05:00:00.000Z",
    content: "hello",
    sender: { kind: "human", handle: "@yu", displayName: "Yu" },
    place: { kind: "direct", visibility: "private", label: "DM with @yu" },
    audience: "Only members of dm:@yu can read this DM.",
    visibility: "private",
  });
  // A thread place carries a reply destination.
  const thread = historyEvidence(
    { ...message, senderName: "alice", senderType: "agent", remainder: ": hi" },
    { ...place, target: "#general:1234abcd", kind: "reply_thread", label: "general reply thread" },
  ) as { replyDestination: string; sender: { kind: string; handle: string } };
  assert.equal(thread.replyDestination, "#general:1234abcd");
  assert.deepEqual(thread.sender, { kind: "agent", handle: "@alice" });
});

test("dmPlaceEvidence and dmPlaceFor map DM targets without process side effects", () => {
  assert.deepEqual(dmPlaceEvidence("dm:@yu"), {
    kind: "dm",
    visibility: "private",
    label: "DM with @yu",
  });
  assert.deepEqual(dmPlaceEvidence("dm:@yu:1234abcd"), {
    kind: "reply_thread",
    visibility: "private",
    label: "DM with @yu reply thread",
  });
  assert.deepEqual(dmPlaceFor("dm:@yu"), {
    target: "dm:@yu",
    kind: "direct",
    visibility: "private",
    label: "dm:@yu",
    audience: "Only members of dm:@yu can read this DM.",
  });
  assert.deepEqual(dmPlaceFor("dm:@yu:1234abcd"), {
    target: "dm:@yu:1234abcd",
    kind: "reply_thread",
    visibility: "private",
    label: "dm:@yu reply thread",
    audience: "Members of dm:@yu can read this reply thread.",
  });
});

test("signalFor classifies inbound signals deterministically", () => {
  const self = { id: "agent-loom", name: "Terra" };
  assert.equal(signalFor("do it [task #2 status=in_progress assignee=agent:agent-loom]", "#general", self, false), "task");
  assert.equal(signalFor("do it [task #2 status=in_progress assignee=agent:someone-else]", "#general", self, false), "channel_activity");
  assert.equal(signalFor("hi @Terra", "#general", self, false), "mention");
  assert.equal(signalFor("hello", "dm:@yu", self, false), "direct_message");
  assert.equal(signalFor("hello [task #9 status=todo]", "#general", self, false), "channel_activity");
  assert.equal(signalFor("hello", "#general:1234abcd", self, true), "thread_reply");
  assert.equal(signalFor("hello", "#general:1234abcd", self, false), "channel_activity");
  assert.equal(signalFor("hello", "#general", self, false), "channel_activity");
});

test("signalForFast returns only membership-independent signals", () => {
  const self = { id: "agent-loom", name: "Terra" };
  // Task assigned to self short-circuits without membership.
  assert.equal(signalForFast("do it [task #2 status=in_progress assignee=agent:agent-loom]", "#general:1234abcd", self), "task");
  // Non-self task is channel activity without membership.
  assert.equal(signalForFast("do it [task #2 status=in_progress assignee=agent:someone-else]", "#general:1234abcd", self), "channel_activity");
  // Mentions short-circuit without membership.
  assert.equal(signalForFast("hi @Terra", "#general:1234abcd", self), "mention");
  // DM targets short-circuit.
  assert.equal(signalForFast("hello", "dm:@yu:1234abcd", self), "direct_message");
  // Plain channel never needs membership.
  assert.equal(signalForFast("hello", "#general", self), "channel_activity");
  // Plain reply thread is the only case that needs membership.
  assert.equal(signalForFast("hello", "#general:1234abcd", self), undefined);
});

test("RaftCliCommandError classifies permanent and retryable failures", () => {
  const permanent = new RaftCliCommandError(
    "Error: Task is already assigned\nCode: INVALID_TARGET\n",
    "",
    1,
  );
  assert.equal(permanent.permanent, true);
  assert.equal(permanent.raftCode, "INVALID_TARGET");
  assert.equal(permanent.summary, "Task is already assigned");
  assert.equal(rejectedMutation(permanent), "Task is already assigned");

  const retryable = new RaftCliCommandError(
    "Error: rate limit exceeded\nCode: SEND_FAILED\n",
    "",
    1,
  );
  assert.equal(retryable.permanent, false);
  assert.equal(rejectedMutation(retryable), undefined);

  const missing = new RaftCliCommandError("Error: no auth\nCode: MISSING_TOKEN\n", "", 1);
  assert.equal(missing.permanent, true);
  assert.equal(rejectedMutation(missing), "no auth");
});
