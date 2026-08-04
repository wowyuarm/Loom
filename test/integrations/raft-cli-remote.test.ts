import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openRaftCliRemote,
  SUPPORTED_RAFT_CLI_VERSION,
} from "../../src/integrations/raft/index.js";

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
      handle: "yu",
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
  assert.equal((await remote.readActivity({
    signals: ["channel_activity"],
    after: "2026-08-03T00:00:00.000Z",
    limit: 10,
  })).items[0]?.signal, "channel_activity");

  assert.ok(remote.openReference);
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

function fakeRaftCli(): string {
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
    "@yu": { id: "human-yu", kind: "human", name: "yu", displayName: "Yu", description: "Long-term counterpart: operator" },
    "@alex": { id: "agent-alex", kind: "agent", name: "alex", displayName: "Alex Agent", description: "Another agent" },
  };
  process.stdout.write(JSON.stringify({ ok: true, data: profiles[target ?? "self"] }) + "\\n");
} else if (command[0] === "message" && command[1] === "resolve") {
  const id = command[2];
  if (id.startsWith("aaaaaaaa")) process.stdout.write("[target=#commons msg=aaaaaaaa time=2026-08-03 05:01:00 type=agent] @alex — Another agent: Update [task #12 status=todo assignee=agent:agent-other]\\n");
  else if (id.startsWith("bbbbbbbb")) process.stdout.write("[target=#commons msg=bbbbbbbb time=2026-08-03 05:02:00 type=agent] @alex — Another agent: Update [task #13 status=todo assignee=agent:agent-loom]\\n");
  else if (id.startsWith("cccccccc")) process.stdout.write("[target=#commons:cccccccc msg=cccccccc time=2026-08-03 05:03:00 type=agent] @alex — Another agent: An unfollowed reply\\n");
  else if (id.startsWith("dddddddd")) process.stdout.write("[target=#commons:dddddddd msg=dddddddd time=2026-08-03 05:04:00 type=agent] @alex — Another agent: A followed reply\\n");
  else process.stdout.write("[target=dm:@yu msg=12345678 time=2026-08-03 05:00:00 type=human] @yu — Long-term counterpart: operator: Can we inspect this: carefully?\\n");
} else if (command[0] === "message" && command[1] === "read") {
  const target = command[command.indexOf("--target") + 1];
  if (target === "#commons") process.stdout.write("## Message History for #commons around cccccccc (1 messages)\\n\\n[seq=10 msg=cccccccc-1111-2222-3333-444444444444 time=2026-08-03 05:02:30 type=agent replyCount=2 replyTarget=#commons:cccccccc] @alex — Another agent: The thread anchor\\n");
  else process.stdout.write("## Message History for #commons:cccccccc around cccccccc (2 messages)\\n\\n[seq=11 msg=cccccccc-1111-2222-3333-444444444444 time=2026-08-03 05:03:00 type=agent] @alex — Another agent: An unfollowed reply\\n[seq=12 msg=ffffffff-1111-2222-3333-444444444444 time=2026-08-03 05:04:00 type=human] @yu — Long-term counterpart: operator: A second reply\\n");
} else if (command[0] === "server" && command[1] === "info") {
  process.stdout.write("## Server Channels\\n\\nPrivate channels are shown only when this agent is a member.\\n#commons [public, joined, not muted] — A shared place.\\n\\nShowing 1-1 of 2.\\nMore: raft server info --channels --offset 1 --limit 1\\n");
} else if (command[0] === "channel" && command[1] === "info") {
  process.stdout.write("## Channel\\n\\nChannel: #commons\\nID: channel-commons\\nVisibility: public\\nJoined: yes\\nMuted: no\\nDescription: A shared place.\\n");
} else if (command[0] === "channel" && command[1] === "members") {
  const followed = command[2].endsWith(":dddddddd");
  process.stdout.write("## Channel Members\\n\\n### Agents\\n" + (followed ? "  - @loom (active)\\n" : "  - @alex (active)\\n") + "\\n### Humans\\n  (none)\\n");
} else if (command[0] === "message" && command[1] === "search") {
  process.stdout.write('Search results for: "durable" (1 result)\\n\\n<result ref="msg:bbbbbbbb-1111-2222-3333-444444444444">\\nSource: channel:commons\\nSender: alex (agent)\\nTime: 2026-08-03 04:55:00\\n\\n<preview>\\nA durable <match>result</match>.\\n</preview>\\n</result>\\n');
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
