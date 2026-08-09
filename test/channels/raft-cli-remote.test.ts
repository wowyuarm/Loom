import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openRaftCliRemote,
  RaftRetryableError,
  SUPPORTED_RAFT_CLI_VERSION,
} from "../../src/channels/raft/index.js";

test("validates a pinned Raft profile and resolves and sends through the 0.0.17 CLI contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-cli-"));
  const cli = path.join(root, "fake-raft.mjs");
  await writeFile(cli, fakeRaftCli(), "utf8");
  const remote = await openRaftCliRemote({
    profile: "loom-pilot",
    expectedServerId: "server-1",
    expectedSelfMemberId: "agent-loom",
    expectedPrincipalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    bridgeStateDirectory: path.join(root, "bridge"),
    cliEntrypoint: cli,
  });

  assert.deepEqual(await remote.resolveMessage("12345678-1234-1234-1234-123456789abc"), {
    messageId: "12345678-1234-1234-1234-123456789abc",
    occurredAt: "2026-08-03T05:00:00.000Z",
    signal: "direct_message",
    content: "Can we inspect this: carefully?",
    sender: {
      memberId: "human-yu",
      kind: "human",
      handle: "Yu",
      displayName: "Yu",
    },
    place: {
      target: "dm:@yu",
      kind: "direct",
      visibility: "private",
      label: "dm:@yu",
      audience: "Only members of dm:@yu can read this DM.",
    },
  });
  assert.ok(remote.drainInbox);
  const inbox = await remote.drainInbox();
  assert.deepEqual(inbox.entries, [{
    receiptId: "dm:@loom:87654321",
    messageId: "87654321-1234-1234-1234-123456789abc",
    receivedAt: "2026-08-03T04:59:59.000Z",
  }]);
  assert.match(
    await readFile(path.join(root, "bridge", "loom-inbox-spool.json"), "utf8"),
    /87654321-1234-1234-1234-123456789abc/,
  );
  await inbox.acknowledge();
  assert.equal(await readFile(path.join(root, "bridge", "loom-inbox-spool.json"), "utf8"), "[]\n");
  assert.equal((await remote.resolveMessage("aaaaaaaa-1111-2222-3333-444444444444")).signal, "channel_activity");
  assert.equal((await remote.resolveMessage("bbbbbbbb-1111-2222-3333-444444444444")).signal, "task");
  assert.equal((await remote.resolveMessage("cccccccc-1111-2222-3333-444444444444")).signal, "channel_activity");
  assert.equal((await remote.resolveMessage("dddddddd-1111-2222-3333-444444444444")).signal, "thread_reply");
  assert.deepEqual(await remote.sendText({ target: "dm:@yu", text: "A durable reply." }), {
    disposition: "sent",
    remoteId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.deepEqual(await remote.sendText({ target: "dm:@yu", text: "hold this reply" }), {
    disposition: "held",
    error: "Freshness hold: showing latest 1 of 1 newer message.",
  });

  assert.ok(remote.listPlaces);
  assert.deepEqual(await remote.listPlaces({ scope: "joined", limit: 1 }), {
    items: [{
      target: "#commons",
      kind: "channel",
      visibility: "public",
      label: "commons",
      joined: true,
      muted: false,
    }],
    nextCursor: "1",
  });

  assert.ok(remote.searchMessages);
  assert.deepEqual(await remote.searchMessages({
    query: "durable",
    sort: "relevance",
    limit: 10,
  }), {
    items: [{
      messageId: "bbbbbbbb-1111-2222-3333-444444444444",
      occurredAt: "2026-08-03T04:55:00.000Z",
      place: {
        target: "#commons",
        kind: "channel",
        visibility: "public",
        label: "commons",
        joined: true,
        muted: false,
      },
      sender: {
        memberId: "agent-alex",
        kind: "agent",
        handle: "alex",
        displayName: "Alex Agent",
      },
      preview: "A durable <match>result</match>.",
      references: [{ kind: "message", value: "bbbbbbbb-1111-2222-3333-444444444444" }],
    }],
  });

  assert.ok(remote.readActivity);
  const taskActivity = await remote.readActivity({
    signals: ["task"],
    after: "2026-08-03T00:00:00.000Z",
    limit: 10,
  });
  assert.equal(taskActivity.items[0]?.signal, "task");
  const taskValue = taskActivity.items[0]?.references.find(reference => reference.kind === "task")?.value;
  assert.ok(taskValue);

  assert.ok(remote.openReference);
  const openedTask = await remote.openReference({
    kind: "task",
    value: taskValue,
    before: 0,
    after: 0,
    limit: 1,
  });
  assert.equal(openedTask.objectKind, "task");
  assert.deepEqual(openedTask.evidence, {
    number: 13,
    status: "todo",
    content: "Update",
    assignee: { handle: "@loom" },
    createdBy: { kind: "agent", handle: "@alex", displayName: "Alex Agent" },
    place: { kind: "channel", visibility: "public", label: "commons" },
    visibility: "public",
  });

  assert.ok(remote.mutateTask);
  assert.deepEqual(await remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 13,
    messageId: "bbbbbbbb-1111-2222-3333-444444444444",
  }), { disposition: "succeeded", remoteId: "raft-task:#commons:13:claim" });
  assert.deepEqual(await remote.mutateTask({
    action: "unclaim",
    target: "#commons",
    number: 13,
    messageId: "bbbbbbbb-1111-2222-3333-444444444444",
  }), { disposition: "succeeded", remoteId: "raft-task:#commons:13:unclaim" });
  assert.deepEqual(await remote.mutateTask({
    action: "update",
    target: "#commons",
    number: 13,
    messageId: "bbbbbbbb-1111-2222-3333-444444444444",
    status: "in_review",
  }), { disposition: "succeeded", remoteId: "raft-task:#commons:13:update:in_review" });
  assert.deepEqual(await remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 99,
    messageId: "conflicting-task-message",
  }), { disposition: "rejected", error: "Task is already assigned" });
  await assert.rejects(remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 98,
    messageId: "unknown-task-message",
  }), /Raft service did not confirm the action/);

  assert.ok(remote.mutateAttention);
  assert.deepEqual(await remote.mutateAttention({
    action: "unfollow_thread",
    target: "#commons:cccccccc",
    reason: "The discussion is complete.",
  }), { disposition: "succeeded", remoteId: "raft-attention:unfollow_thread:#commons:cccccccc" });
  assert.deepEqual(await remote.mutateAttention({
    action: "mute_channel",
    target: "#commons",
  }), { disposition: "succeeded", remoteId: "raft-attention:mute_channel:#commons" });
  assert.deepEqual(await remote.mutateAttention({
    action: "unmute_channel",
    target: "#commons",
  }), { disposition: "succeeded", remoteId: "raft-attention:unmute_channel:#commons" });

  const opened = await remote.openReference({
    kind: "message",
    value: "cccccccc-1111-2222-3333-444444444444",
    before: 0,
    after: 0,
    limit: 1,
  });
  assert.equal(opened.objectKind, "message");
  assert.match(JSON.stringify(opened.evidence), /An unfollowed reply/);
  assert.match(JSON.stringify(opened.evidence), /The thread anchor/);
  assert.match(JSON.stringify(opened.evidence), /A second reply/);

  const openedThread = await remote.openReference({
    kind: "thread",
    value: "#commons:cccccccc",
    before: 1,
    after: 1,
    limit: 3,
  });
  assert.equal(openedThread.objectKind, "thread");
  assert.match(JSON.stringify(openedThread.evidence), /The thread anchor/);
  assert.match(JSON.stringify(openedThread.evidence), /A second reply/);

  const wakes: unknown[] = [];
  let wakeAttempts = 0;
  assert.ok(remote.start);
  assert.ok(remote.stop);
  await remote.start(async wake => {
    wakeAttempts += 1;
    if (wakeAttempts === 1) throw new Error("wake ledger is temporarily unavailable");
    wakes.push(wake);
    return { ok: true };
  });
  await eventually(() => wakes.length === 1);
  assert.deepEqual(remote.status?.(), {
    available: true,
    cliVersion: SUPPORTED_RAFT_CLI_VERSION,
    serverId: "server-1",
    selfMemberId: "agent-loom",
  });
  assert.deepEqual(wakes, [{
    attemptId: "attempt-1",
    messageId: "12345678-1234-1234-1234-123456789abc",
    receivedAt: "2026-08-03T05:00:01.000Z",
  }]);
  await remote.stop();
  assert.equal(remote.status?.().available, false);
});

test("serves projected activity through /activity/drain with bounded max and dropped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-cli-activity-"));
  const cli = path.join(root, "fake-raft.mjs");
  await writeFile(cli, fakeRaftCli(), "utf8");
  const drainFile = path.join(root, "drain-result.json");
  const previousDrainFile = process.env.LOOM_TEST_DRAIN_FILE;
  process.env.LOOM_TEST_DRAIN_FILE = drainFile;
  try {
    const { RaftActivityProjector } = await import("../../src/channels/raft/raft-activity.js");
    const activity = new RaftActivityProjector();
    activity.observe({ event: "agent.run.started", at: "2026-08-09T00:00:00.000Z", runId: "run-1", agentName: "main-agent" });
    activity.observe({ event: "agent.tool.started", at: "2026-08-09T00:00:01.000Z", toolCallId: "tool-1", toolName: "read" });
    activity.observe({ event: "agent.tool.completed", at: "2026-08-09T00:00:02.000Z", toolCallId: "tool-1", toolName: "read", durationMs: 120, status: "ok" });
    activity.observe({ event: "agent.run.finished", at: "2026-08-09T00:00:03.000Z", runId: "run-1", agentName: "main-agent", result: "succeeded" });

    const remote = await openRaftCliRemote({
      profile: "loom-pilot",
      expectedServerId: "server-1",
      expectedSelfMemberId: "agent-loom",
      expectedPrincipalMemberId: "human-yu",
      principalDmTarget: "dm:@yu",
      bridgeStateDirectory: path.join(root, "bridge"),
      cliEntrypoint: cli,
      activity,
    });
    assert.ok(remote.start);
    assert.ok(remote.stop);
    await remote.start(async () => ({ ok: true }));
    try {
      await eventually(() => {
        try {
          return JSON.parse(readFileSync(drainFile, "utf8")).events?.length === 4;
        } catch {
          return false;
        }
      });
      const drained = JSON.parse(readFileSync(drainFile, "utf8")) as {
        schema: string;
        events: Array<{ hookEventName: string; sessionId?: string; toolName?: string; status?: string; occurredAt: string; durationMs?: number }>;
        dropped: number;
      };
      assert.equal(drained.schema, "raft-activity-drain.v1");
      assert.deepEqual(drained.events.map(event => event.hookEventName), [
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
      ]);
      assert.equal(drained.events[0]?.sessionId, "main-agent");
      assert.equal(drained.events[1]?.toolName, "read");
      assert.equal(drained.events[2]?.status, "ok");
      assert.equal(drained.events[2]?.durationMs, 120);
      assert.equal(drained.dropped, 0);
    } finally {
      assert.ok(remote.stop);
      await remote.stop();
    }
  } finally {
    if (previousDrainFile === undefined) delete process.env.LOOM_TEST_DRAIN_FILE;
    else process.env.LOOM_TEST_DRAIN_FILE = previousDrainFile;
  }
});

test("rejects a Raft profile whose server binding differs from Instance Configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-cli-binding-"));
  const cli = path.join(root, "fake-raft.mjs");
  await writeFile(cli, fakeRaftCli(), "utf8");
  await assert.rejects(openRaftCliRemote({
    profile: "loom-pilot",
    expectedServerId: "another-server",
    expectedSelfMemberId: "agent-loom",
    expectedPrincipalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    bridgeStateDirectory: path.join(root, "bridge"),
    cliEntrypoint: cli,
  }), /Raft server binding does not match/);
});

test("classifies Raft CLI failures as permanent or retryable at the remote layer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-cli-failure-"));
  const cli = path.join(root, "fake-raft.mjs");
  await writeFile(cli, fakeRaftCli(), "utf8");
  const remote = await openRaftCliRemote({
    profile: "loom-pilot",
    expectedServerId: "server-1",
    expectedSelfMemberId: "agent-loom",
    expectedPrincipalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    bridgeStateDirectory: path.join(root, "bridge"),
    cliEntrypoint: cli,
  });

  // Explicit permanent code: surfaces as a rejected mutation, never retried.
  assert.ok(remote.mutateTask);
  assert.deepEqual(await remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 96,
    messageId: "missing-task-message",
  }), { disposition: "rejected", error: "Task not found" });

  // Missing credential/profile: permanent, so it rejects the mutation instead
  // of being retried as a remote failure.
  assert.deepEqual(await remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 97,
    messageId: "missing-profile-task-message",
  }), { disposition: "rejected", error: "Profile not found" });

  // Deterministic conflict under the same *_FAILED code: permanent, so it
  // surfaces as rejected instead of being retried forever.
  assert.deepEqual(await remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 99,
    messageId: "conflicting-task-message",
  }), { disposition: "rejected", error: "Task is already assigned" });

  // The same *_FAILED code with a rate-limit summary: retryable, so the
  // channel backs off instead of failing the wake permanently.
  const rateLimited = await remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 95,
    messageId: "rate-limited-task-message",
  }).then(() => null, error => error);
  assert.ok(rateLimited instanceof RaftRetryableError);
  assert.match(rateLimited.message, /HTTP 429 Too Many Requests/);

  // Server unavailability: retryable, so the channel will back off and retry.
  const unavailable = await remote.mutateTask({
    action: "claim",
    target: "#commons",
    number: 98,
    messageId: "unavailable-task-message",
  }).then(() => null, error => error);
  assert.ok(unavailable instanceof RaftRetryableError);
  assert.match(unavailable.message, /Raft service did not confirm the action/);
});

test("isolates one bad inbox receipt in the spool while later receipts still become wakes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-cli-spool-"));
  const cli = path.join(root, "fake-raft.mjs");
  await writeFile(cli, spoolIsolationCli(), "utf8");
  const remote = await openRaftCliRemote({
    profile: "loom-pilot",
    expectedServerId: "server-1",
    expectedSelfMemberId: "agent-loom",
    expectedPrincipalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    bridgeStateDirectory: path.join(root, "bridge"),
    cliEntrypoint: cli,
  });

  // The bad receipt cannot be completed yet, so it stays in the spool and is
  // reported as spooled; only the good one becomes a wake in this batch.
  assert.ok(remote.drainInbox);
  const first = await remote.drainInbox();
  assert.deepEqual(first.entries, [{
    receiptId: "dm:@yu:bbbb2222",
    messageId: "bbbb2222-2222-2222-2222-222222222222",
    receivedAt: "2026-08-03T05:00:01.000Z",
  }]);
  assert.equal(first.spooled, 1);
  assert.equal(first.spooledOldestAt, "2026-08-03T05:00:00.000Z");

  // Acknowledging the good batch keeps the isolated receipt for recovery.
  await first.acknowledge();

  // When the receipt becomes resolvable it is recovered on the next drain,
  // and the spool is reported empty.
  const second = await remote.drainInbox();
  assert.deepEqual(second.entries, [{
    receiptId: "dm:@yu:aaaa1111",
    messageId: "aaaa1111-1111-1111-1111-111111111111",
    receivedAt: "2026-08-03T05:00:00.000Z",
  }]);
  assert.equal(second.spooled, 0);
  assert.equal(second.spooledOldestAt, undefined);

  // Acknowledging the recovered batch leaves nothing behind: a fresh drain is
  // empty, which is only possible if the spool was fully cleared.
  await second.acknowledge();
  const third = await remote.drainInbox();
  assert.deepEqual(third.entries, []);
  assert.equal(third.spooled, 0);
});

test("times out a hung Raft CLI command and reports it as retryable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-cli-timeout-"));
  const cli = path.join(root, "hang-raft.mjs");
  await writeFile(cli, hangCli(), "utf8");
  const remote = await openRaftCliRemote({
    profile: "loom-pilot",
    expectedServerId: "server-1",
    expectedSelfMemberId: "agent-loom",
    expectedPrincipalMemberId: "human-yu",
    principalDmTarget: "dm:@yu",
    bridgeStateDirectory: path.join(root, "bridge"),
    cliEntrypoint: cli,
    commandTimeoutMs: 150,
  });

  // A CLI that never exits must not hang the drain: it is killed and the
  // failure is retryable so the channel backs off instead of wedging.
  const error = await remote.resolveMessage("12345678-1234-1234-1234-123456789abc")
    .then(() => null, error => error);
  assert.ok(error instanceof RaftRetryableError);
  assert.match(error.message, /timed out after 150ms/);
});

test("thread task, mention and other-task resolves do not query channel members", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-raft-cli-signal-"));
  const cli = path.join(root, "fake-raft.mjs");
  await writeFile(cli, fakeRaftCli(), "utf8");
  const countFile = path.join(root, "members-count.txt");
  process.env.LOOM_TEST_COUNT_FILE = countFile;
  try {
    const remote = await openRaftCliRemote({
      profile: "loom-pilot",
      expectedServerId: "server-1",
      expectedSelfMemberId: "agent-loom",
      expectedPrincipalMemberId: "human-yu",
      principalDmTarget: "dm:@yu",
      bridgeStateDirectory: path.join(root, "bridge"),
      cliEntrypoint: cli,
    });

    // Reply-thread messages that classify without membership: self task,
    // self mention and a non-self task must not run `channel members`.
    assert.equal((await remote.resolveMessage("eeeeeeee-1111-2222-3333-444444444444")).signal, "task");
    assert.equal((await remote.resolveMessage("99999999-1111-2222-3333-444444444444")).signal, "mention");
    assert.equal((await remote.resolveMessage("88888888-1111-2222-3333-444444444444")).signal, "channel_activity");
    assert.equal(await readFile(countFile, "utf8").catch(() => ""), "");

    // A plain reply thread is the only case that queries membership.
    assert.equal((await remote.resolveMessage("77777777-1111-2222-3333-444444444444")).signal, "channel_activity");
    assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1);
  } finally {
    delete process.env.LOOM_TEST_COUNT_FILE;
  }
});

function hangCli(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0] === "--profile" ? args.slice(2) : args;
if (command[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${SUPPORTED_RAFT_CLI_VERSION}\n`)});
} else if (command.join(" ") === "auth whoami") {
  process.stdout.write(JSON.stringify({ ok: true, data: { agentId: "agent-loom", serverId: "server-1" } }) + "\\n");
} else if (command[0] === "profile" && command[1] === "show") {
  const target = command.find(value => value.startsWith("@"));
  const profiles = {
    self: { id: "agent-loom", kind: "agent", name: "loom", displayName: "Loom Individual", description: "A continuing Individual." },
    "@yu": { id: "human-yu", kind: "human", name: "Yu", displayName: "Yu", description: "Long-term counterpart: operator" },
  };
  process.stdout.write(JSON.stringify({ ok: true, data: profiles[target ?? "self"] }) + "\\n");
} else {
  // Never exit: exercises the remote's command timeout.
  setInterval(() => {}, 60_000);
}
`;
}

function fakeRaftCli(): string {
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = args[0] === "--profile" ? args.slice(2) : args;
if (command[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${SUPPORTED_RAFT_CLI_VERSION}\n`)});
} else if (command.join(" ") === "auth whoami") {
  process.stdout.write(JSON.stringify({ ok: true, data: { agentId: "agent-loom", serverId: "server-1" } }) + "\\n");
} else if (command[0] === "profile" && command[1] === "show") {
  const target = command.find(value => value.startsWith("@"));
  const profiles = {
    self: { id: "agent-loom", kind: "agent", name: "loom", displayName: "Loom Individual", description: "A continuing Individual." },
      "@yu": { id: "human-yu", kind: "human", name: "Yu", displayName: "Yu", description: "Long-term counterpart: operator" },
    "@alex": { id: "agent-alex", kind: "agent", name: "alex", displayName: "Alex Agent", description: "Another agent" },
  };
  process.stdout.write(JSON.stringify({ ok: true, data: profiles[target ?? "self"] }) + "\\n");
} else if (command[0] === "message" && command[1] === "resolve") {
  const id = command[2];
  if (id.startsWith("aaaaaaaa")) process.stdout.write("[target=#commons msg=aaaaaaaa time=2026-08-03 05:01:00 type=agent] @alex — Another agent: Update [task #12 status=todo assignee=agent:agent-other]\\n");
  else if (id.startsWith("bbbbbbbb")) process.stdout.write("[target=#commons msg=bbbbbbbb time=2026-08-03 05:02:00 type=agent] @alex — Another agent: Update [task #13 status=todo assignee=@loom]\\n");
  else if (id.startsWith("cccccccc")) process.stdout.write("[target=#commons:cccccccc msg=cccccccc time=2026-08-03 05:03:00 type=agent] @alex — Another agent: An unfollowed reply\\n");
  else if (id.startsWith("dddddddd")) process.stdout.write("[target=#commons:dddddddd msg=dddddddd time=2026-08-03 05:04:00 type=agent] @alex — Another agent: A followed reply\\n");
  else if (id.startsWith("eeeeeeee")) process.stdout.write("[target=#commons:eeeeeeee msg=eeeeeeee time=2026-08-03 05:05:00 type=agent] @alex — Another agent: Update [task #14 status=in_progress assignee=@loom]\\n");
  else if (id.startsWith("99999999")) process.stdout.write("[target=#commons:99999999 msg=99999999 time=2026-08-03 05:06:00 type=agent] @alex — Another agent: Hi @loom\\n");
  else if (id.startsWith("88888888")) process.stdout.write("[target=#commons:88888888 msg=88888888 time=2026-08-03 05:07:00 type=agent] @alex — Another agent: Update [task #15 status=todo assignee=agent:agent-other]\\n");
  else if (id.startsWith("77777777")) process.stdout.write("[target=#commons:77777777 msg=77777777 time=2026-08-03 05:08:00 type=agent] @alex — Another agent: A plain reply\\n");
  else process.stdout.write("[target=dm:@yu msg=12345678 time=2026-08-03 05:00:00 type=human] @yu — Long-term counterpart: operator: Can we inspect this: carefully?\\n");
} else if (command[0] === "message" && command[1] === "check") {
  process.stdout.write("[target=dm:@loom msg=87654321 time=2026-08-03 04:59:59 type=human] @yu: A missed message.\\n[target=dm:@yu msg=87654321 time=2026-08-03 04:59:59 type=human] @yu: The same message through its canonical DM alias.\\n\\nNo more new messages.\\n");
} else if (command[0] === "message" && command[1] === "read") {
  const target = command[command.indexOf("--target") + 1];
  const around = command[command.indexOf("--around") + 1];
  if (target === "dm:@yu" && around === "87654321") process.stdout.write("## Message History for dm:@yu around 87654321 (1 messages)\\n\\n[seq=9 msg=87654321-1234-1234-1234-123456789abc time=2026-08-03 04:59:59 type=human] @yu — Long-term counterpart: operator: A missed message.\\n");
  else if (target === "#commons") process.stdout.write("## Message History for #commons around cccccccc (1 messages)\\n\\n[seq=10 msg=cccccccc-1111-2222-3333-444444444444 time=2026-08-03 05:02:30 type=agent replyCount=2 replyTarget=#commons:cccccccc] @alex — Another agent: The thread anchor\\n");
  else process.stdout.write("## Message History for #commons:cccccccc around cccccccc (2 messages)\\n\\n[seq=11 msg=cccccccc-1111-2222-3333-444444444444 time=2026-08-03 05:03:00 type=agent] @alex — Another agent: An unfollowed reply\\n[seq=12 msg=ffffffff-1111-2222-3333-444444444444 time=2026-08-03 05:04:00 type=human] @Yu — Long-term counterpart: operator: A second reply\\n");
} else if (command[0] === "server" && command[1] === "info") {
  process.stdout.write("## Server Channels\\n\\nPrivate channels are shown only when this agent is a member.\\n#commons [public, joined, not muted] — A shared place.\\n\\nShowing 1-1 of 2.\\nMore: raft server info --channels --offset 1 --limit 1\\n");
} else if (command[0] === "channel" && command[1] === "info") {
  process.stdout.write("## Channel\\n\\nChannel: #commons\\nID: channel-commons\\nVisibility: public\\nJoined: yes\\nMuted: no\\nDescription: A shared place.\\n");
} else if (command[0] === "channel" && command[1] === "members") {
  appendFileSync(process.env.LOOM_TEST_COUNT_FILE ?? "/dev/null", "members\\n");
  const followed = command[2].endsWith(":dddddddd");
  process.stdout.write("## Channel Members\\n\\n### Agents\\n" + (followed ? "  - @loom (active)\\n" : "  - @alex (active)\\n") + "\\n### Humans\\n  (none)\\n");
} else if (command[0] === "message" && command[1] === "search") {
  if (command.includes("--query")) process.stdout.write('Search results for: "durable" (1 result)\\n\\n<result ref="msg:bbbbbbbb-1111-2222-3333-444444444444">\\nSource: channel:commons\\nSender: alex (agent)\\nTime: 2026-08-03 04:55:00\\n\\n<preview>\\nA durable <match>result</match>.\\n</preview>\\n</result>\\n');
  else process.stdout.write('Search results (1 result)\\n\\n<result ref="msg:bbbbbbbb-1111-2222-3333-444444444444">\\nSource: channel:commons\\nSender: alex (agent)\\nTime: 2026-08-03 05:02:00\\n\\n<preview>\\nUpdate [task #13 status=todo assignee=@loom]\\n</preview>\\n</result>\\n');
} else if (command[0] === "task" && ["claim", "unclaim", "update"].includes(command[1])) {
  const number = command[command.indexOf("--number") + 1];
  if (number === "99") {
    process.stderr.write("Error: Task is already assigned\\nCode: TASK_CLAIM_FAILED\\n");
    process.exitCode = 1;
  } else if (number === "98") {
    process.stderr.write("Error: Raft service did not confirm the action\\nCode: SERVER_5XX\\n");
    process.exitCode = 1;
  } else if (number === "97") {
    process.stderr.write("Error: Profile not found\\nCode: MISSING_PROFILE\\n");
    process.exitCode = 1;
  } else if (number === "96") {
    process.stderr.write("Error: Task not found\\nCode: NOT_FOUND\\n");
    process.exitCode = 1;
  } else if (number === "95") {
    process.stderr.write("Error: HTTP 429 Too Many Requests\\nCode: TASK_CLAIM_FAILED\\n");
    process.exitCode = 1;
  } else process.stdout.write("Task action completed.\\n");
} else if (command[0] === "thread" && command[1] === "unfollow") {
  process.stdout.write("Thread unfollowed.\\n");
} else if (command[0] === "channel" && ["mute", "unmute"].includes(command[1])) {
  process.stdout.write("Channel attention changed.\\n");
} else if (command[0] === "message" && command[1] === "send") {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { body += chunk; });
  process.stdin.on("end", () => {
    if (body.includes("hold")) process.stdout.write("Freshness hold: showing latest 1 of 1 newer message.\\nYour message has been saved as a draft.\\n");
    else process.stdout.write("Message sent to dm:@yu. Message ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\\n");
  });
} else if (command[0] === "agent" && command[1] === "bridge") {
  const endpoint = command[command.indexOf("--wake-channel-endpoint") + 1];
  const headers = { "content-type": "application/json", "x-raft-bridge-token": process.env.RAFT_CHANNEL_TOKEN };
  process.stdout.write(JSON.stringify({ type: "bridge_process_started", pid: process.pid, mode: "poll" }) + "\\n");
  const activityEndpoint = new URL(endpoint);
  activityEndpoint.pathname = "/activity/drain";
  const wrongToken = await fetch(activityEndpoint, { headers: { "x-raft-bridge-token": "wrong-token" } });
  if (wrongToken.status !== 401) throw new Error("Loom accepted a wrong bridge token");
  const activity = await fetch(activityEndpoint, { headers });
  const activityResult = await activity.json();
  if (!activity.ok || activityResult.schema !== "raft-activity-drain.v1") {
    throw new Error("Loom did not provide the Raft activity drain contract");
  }
  if (process.env.LOOM_TEST_DRAIN_FILE) {
    writeFileSync(process.env.LOOM_TEST_DRAIN_FILE, JSON.stringify(activityResult));
  } else if (activityResult.events.length !== 0 || activityResult.dropped !== 0) {
    throw new Error("Loom did not provide the empty Raft activity drain contract");
  }
  const invalid = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ schema: "raft-channel-wake.v1", text: "must not cross the bridge" }),
  });
  if (invalid.status !== 400) throw new Error("Loom accepted a content-bearing wake");
  const wake = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema: "raft-channel-wake.v1",
      attemptId: "attempt-1",
      eventId: "event-1",
      messageId: "12345678-1234-1234-1234-123456789abc",
      agentId: "agent-loom",
      profile: "loom-pilot",
      coreSessionId: "core-1",
      adapterInstance: "loom",
      occurredAt: "2026-08-03T05:00:01.000Z",
    }),
  });
  if (wake.status !== 503) throw new Error("Loom did not ask the bridge to retry a transient wake failure");
  const retry = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema: "raft-channel-wake.v1",
      attemptId: "attempt-1",
      eventId: "event-1",
      messageId: "12345678-1234-1234-1234-123456789abc",
      agentId: "agent-loom",
      profile: "loom-pilot",
      coreSessionId: "core-1",
      adapterInstance: "loom",
      occurredAt: "2026-08-03T05:00:01.000Z",
    }),
  });
  const result = await retry.json();
  if (!retry.ok || result.ok !== true || result.runtimeSession !== "loom:agent-loom") {
    throw new Error("Loom rejected a valid wake");
  }
  setInterval(() => {}, 60_000);
} else {
  process.stderr.write("unexpected fake Raft command: " + command.join(" ") + "\\n");
  process.exitCode = 2;
}
`;
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached");
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function spoolIsolationCli(): string {
  return `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const command = args[0] === "--profile" ? args.slice(2) : args;
if (command[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${SUPPORTED_RAFT_CLI_VERSION}\n`)});
} else if (command.join(" ") === "auth whoami") {
  process.stdout.write(JSON.stringify({ ok: true, data: { agentId: "agent-loom", serverId: "server-1" } }) + "\\n");
} else if (command[0] === "profile" && command[1] === "show") {
  const target = command.find(value => value.startsWith("@"));
  const profiles = {
    self: { id: "agent-loom", kind: "agent", name: "loom", displayName: "Loom Individual", description: "A continuing Individual." },
    "@yu": { id: "human-yu", kind: "human", name: "Yu", displayName: "Yu", description: "Long-term counterpart: operator" },
  };
  process.stdout.write(JSON.stringify({ ok: true, data: profiles[target ?? "self"] }) + "\\n");
} else if (command[0] === "message" && command[1] === "check") {
  const marker = path.join(path.dirname(process.argv[1]), "check-marker");
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    process.stdout.write("[target=dm:@yu msg=aaaa1111 time=2026-08-03 05:00:00 type=human] @yu: First notice.\\n[target=dm:@yu msg=bbbb2222 time=2026-08-03 05:00:01 type=human] @yu: Second notice.\\n\\nNo more new messages.\\n");
  } else {
    process.stdout.write("\\nNo more new messages.\\n");
  }
} else if (command[0] === "message" && command[1] === "resolve") {
  const id = command[2];
  process.stdout.write("[target=dm:@yu msg=" + id + " time=2026-08-03 05:00:00 type=human] @yu — Long-term counterpart: operator: A missed notice.\\n");
} else if (command[0] === "message" && command[1] === "read") {
  const target = command[command.indexOf("--target") + 1];
  const around = command[command.indexOf("--around") + 1];
  const marker = path.join(path.dirname(process.argv[1]), "read-marker-" + around);
  if (around === "aaaa1111" && !existsSync(marker)) {
    writeFileSync(marker, "1");
    process.stdout.write("## Message History for " + target + " around " + around + " (0 messages)\\n\\n");
  } else if (around === "aaaa1111") {
    process.stdout.write("## Message History for " + target + " around " + around + " (1 messages)\\n\\n[seq=1 msg=aaaa1111-1111-1111-1111-111111111111 time=2026-08-03 05:00:00 type=human] @yu — Long-term counterpart: operator: A missed notice.\\n");
  } else {
    process.stdout.write("## Message History for " + target + " around " + around + " (1 messages)\\n\\n[seq=2 msg=bbbb2222-2222-2222-2222-222222222222 time=2026-08-03 05:00:01 type=human] @yu — Long-term counterpart: operator: Second notice.\\n");
  }
}
`;
}
