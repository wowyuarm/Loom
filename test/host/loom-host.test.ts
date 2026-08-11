import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openLoomHost, readLoomInteractionHistory, readLoomStatus } from "../../src/host/index.js";
import type { RaftRemote } from "../../src/channels/raft/index.js";
import type { OperationalEvent } from "../../src/operational-events.js";
import { weixinOpaqueRef } from "../../src/channels/weixin/index.js";
import { resolveInstanceLayout } from "../../src/instance/layout.js";
import { openRuntime, type AgentExecution } from "../../src/runtime/index.js";

test("holds exclusive live ownership of one prepared Instance Root", async t => {
  const root = await preparedInstanceRoot();
  const first = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => first.stop());

  await first.start();
  await eventually(() => first.status().driver.state === "waiting");
  assert.equal(first.status().state, "running");
  assert.equal(first.status().instance.models.state, "blocked");

  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /Instance Root is already owned by a live Loom Host/,
  );

  await first.stop();
  assert.equal(first.status().state, "stopped");
  assert.equal(first.status().driver.state, "stopped");

  const replacement = await openLoomHost({ root, machineTimeZone: "UTC" });
  await replacement.stop();
});

test("serves content-free live status with Channel state only", async t => {
  const root = await preparedInstanceRoot();
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();
  await eventually(() => host.status().channels?.weixin?.state === "degraded");

  const report = await readLoomStatus(resolveInstanceLayout(root).statusSocketPath);
  assert.equal((await stat(resolveInstanceLayout(root).statusSocketPath)).mode & 0o777, 0o600);

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.host.state, "running");
  if (!("runId" in report)) return;
  assert.match(report.runId, /^[0-9a-f-]{36}$/);
  assert.match(report.host.version, /^0\.0\.0\+g[0-9a-f]{7,12}$/);
  assert.match(report.host.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.model.state, "blocked");
  assert.deepEqual(report.runtime, {
    activeTurn: false,
    pendingInputs: 0,
    pendingEffects: 0,
    deliveriesNeedingAttention: 0,
    integrityWarnings: [],
  });
  assert.deepEqual(report.agents.map(agent => ({ name: agent.name, state: agent.state })), [
    { name: "main-agent", state: "never_run" },
    { name: "orientation", state: "never_run" },
    { name: "life-recorder", state: "never_run" },
    { name: "attention-maintainer", state: "never_run" },
    { name: "memory-reflector", state: "never_run" },
    { name: "thread-maintainer", state: "never_run" },
  ]);
  assert.deepEqual(report.channels, [{
    name: "weixin",
    state: "degraded",
    lastFailure: { category: "connection" },
  }]);
  assert.deepEqual(report.integrations, []);
  assert.equal("root" in report.host, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replaceAll("\\", "\\\\")));
});

test("exposes an overdue active Segment through the operator status socket (issue #4)", async t => {
  const root = await preparedInstanceRoot();
  // Initialize the Runtime schema, then plant an overdue Segment that cannot
  // close: it is blocked by a running Turn row, so the Host driver cannot
  // freeze it and the overdue record stays observable on the status socket.
  const seeded = openRuntime({ root: path.join(root, "runtime"), now: () => new Date("2026-08-08T09:00:00.000Z") });
  seeded.close();
  const database = new DatabaseSync(path.join(root, "runtime", "runtime.db"));
  database.exec(`
    INSERT INTO active_segment (singleton, id, opened_at, last_activity_at, status,
                                overdue_since, overdue_reason_json, next_overdue_check_at)
    VALUES (1, 'segment-overdue', '2026-08-08T08:00:00.000Z', '2026-08-08T08:00:00.000Z', 'active',
            '2026-08-08T09:00:00.000Z', '{"kind":"main_agent_turn","turnId":"turn-1"}',
            '2026-08-08T09:15:00.000Z');
    INSERT INTO turns (id, segment_id, status, lease_owner, fencing_token, lease_expires_at,
                       started_at, recording_day)
    VALUES ('turn-1', 'segment-overdue', 'running', 'owner-1', 1, '2099-01-01T00:00:00.000Z',
            '2026-08-08T08:05:00.000Z', '2026-08-08');
  `);
  database.close();

  // Freeze the Host clock just before the planted next-overdue-check so the
  // overdue record (kept from closing by the running Turn) is reported
  // untouched instead of being re-checked against a real clock.
  const host = await openLoomHost({
    root,
    machineTimeZone: "UTC",
    now: () => new Date("2026-08-08T08:30:00.000Z"),
  });
  t.after(() => host.stop());
  await host.start();
  await eventually(() => host.status().state === "running");

  // Read through the real operator socket: the overdue record with its
  // blocker and re-check time must be present in the public report.
  const report = await readLoomStatus(resolveInstanceLayout(root).statusSocketPath);
  assert.ok("runId" in report);
  assert.equal(report.runtime.activityOverdueSince, "2026-08-08T09:00:00.000Z");
  assert.deepEqual(report.runtime.activityOverdueReason, {
    kind: "main_agent_turn",
    turnId: "turn-1",
  });
  assert.equal(report.runtime.activityOverdueNextCheckAt, "2026-08-08T09:15:00.000Z");
});

test("accepts channel Input only through a running Host", async t => {
  const root = await preparedInstanceRoot();
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());

  await assert.rejects(
    async () => host.acceptInput({
      source: "test-channel",
      sourceId: "before-start",
      kind: "interaction",
      payload: { text: "too early" },
    }),
    /cannot accept Input while open/,
  );

  await host.start();
  const accepted = await host.acceptInput({
    source: "test-channel",
    sourceId: "host-input",
    kind: "interaction",
    payload: { text: "hello" },
  });
  await eventually(() => host.status().instance.runtime.inputs.length === 1);

  assert.equal(accepted.disposition, "accepted");
  assert.equal(host.status().instance.runtime.inputs[0]?.sourceId, "host-input");
  assert.equal(host.status().instance.runtime.inputs[0]?.status, "pending");
});

test("groups the same interaction wave independently of channel source", async t => {
  const root = await preparedInstanceRoot();
  let now = Date.parse("2026-08-05T10:00:00.000Z");
  const host = await openLoomHost({
    root,
    machineTimeZone: "UTC",
    now: () => new Date(now),
  });
  t.after(() => host.stop());
  await host.start();

  const interaction = {
    routeRef: "shared-route",
    signal: "direct_message" as const,
    actor: { actorRef: "human" as const, kind: "human" as const },
    place: {
      placeRef: "shared-direct-place",
      kind: "direct" as const,
      visibility: "private" as const,
    },
    audience: { visibility: "private" as const, description: "private conversation" },
    references: [],
    destinations: [{
      destinationRef: "shared-direct-place:top-level",
      routeRef: "shared-route",
      kind: "top_level" as const,
    }],
    defaultDestinationRef: "shared-direct-place:top-level",
  };
  await host.acceptInput({
    source: "local",
    sourceId: "local-message",
    kind: "interaction",
    payload: { text: "first" },
    interaction,
  });
  now += 500;
  await host.acceptInput({
    source: "raft",
    sourceId: "raft-message",
    kind: "interaction",
    payload: { text: "second" },
    interaction,
  });

  const [first, second] = host.status().instance.runtime.inputs;
  assert.ok(first?.interactionWaveId);
  assert.equal(second?.interactionWaveId, first.interactionWaveId);
});

test("releases Instance Root ownership when Instance opening fails", async () => {
  const root = await preparedInstanceRoot();
  const configuration = path.join(root, "configuration", "instance.yaml");
  await mkdir(path.dirname(configuration), { recursive: true });
  await writeFile(configuration, "version: [malformed", "utf8");

  await assert.rejects(openLoomHost({ root }), /Instance Configuration could not be read/);
  await writeFile(configuration, "version: 1\nchannels:\n  weixin:\n    enabled: true\n", "utf8");

  const recovered = await openLoomHost({ root });
  await recovered.stop();
});

test("serves cross-channel interaction history over the Host status socket", async t => {
  const root = await preparedInstanceRoot();
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();

  const accepted = await host.acceptInput({
    source: "test-channel",
    sourceId: "host-input-1",
    kind: "interaction",
    payload: { text: "hello through the Host" },
  });
  const history = await readLoomInteractionHistory(resolveInstanceLayout(root).statusSocketPath);

  assert.equal(accepted.disposition, "accepted");
  assert.deepEqual(history.entries.map(entry => ({
    actorRef: entry.actorRef,
    source: entry.source,
    content: entry.content,
  })), [{
    actorRef: "human",
    source: "test-channel",
    content: { text: "hello through the Host" },
  }]);
  assert.equal(host.status().channels?.weixin?.state, "degraded");
});

test("rejects an incomplete Weixin configuration before opening the Host", async () => {
  const root = await preparedInstanceRoot();
  await configureWeixin(root, "https://weixin.invalid");
  const authFile = path.join(root, "configuration", "channels", "weixin", "auth.json");
  await rm(authFile);

  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /requires both config\.json and auth\.json/,
  );

  await writeFile(authFile, JSON.stringify({ version: 1, token: "restored-token" }), "utf8");
  const recovered = await openLoomHost({ root, machineTimeZone: "UTC" });
  await recovered.stop();
});

test("rejects zero enabled Channels and does not inspect disabled Weixin files", async () => {
  const root = await preparedInstanceRoot();
  const configurationRoot = path.join(root, "configuration");
  const weixinRoot = path.join(configurationRoot, "channels", "weixin");
  await mkdir(weixinRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "channels:",
      "  weixin:",
      "    enabled: false",
      "  raft:",
      "    enabled: false",
      "",
    ].join("\n"), "utf8"),
    writeFile(path.join(weixinRoot, "config.json"), "not active configuration", "utf8"),
  ]);

  // Disabled Weixin files are never inspected: corrupt content would fail open
  // if it were, but the Host rejects the zero-Channel configuration first.
  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /at least one enabled Interaction Channel/,
  );
});

test("loads an enabled nmem connection from the Instance Root", async t => {
  const root = await preparedInstanceRoot();
  await configureNmem(root, {
    endpoint: "http://127.0.0.1:1",
    spaceId: "loom-test",
    apiKey: "nmem-test-key",
  });

  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();

  assert.ok(host.status().instance.nmem);
  const report = await readLoomStatus(resolveInstanceLayout(root).statusSocketPath);
  assert.ok("runId" in report);
  if ("runId" in report) {
    assert.deepEqual(report.integrations, [{ name: "nmem", state: "active" }]);
  }
});

test("rejects enabled nmem without connection configuration", async () => {
  const root = await preparedInstanceRoot();
  const configurationRoot = path.join(root, "configuration");
  await mkdir(configurationRoot, { recursive: true });
  await writeFile(path.join(configurationRoot, "instance.yaml"), [
    "version: 1",
    "channels:",
    "  weixin:",
    "    enabled: true",
    "integrations:",
    "  nmem:",
    "    enabled: true",
    "",
  ].join("\n"), "utf8");

  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /Enabled nmem requires config\.json/,
  );
});

test("accepts local nmem without an auth file", async () => {
  const root = await preparedInstanceRoot();
  await configureNmem(root, { endpoint: "http://127.0.0.1:14242" });

  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  assert.ok(host.status().instance.nmem);
  await host.stop();
});

test("does not inspect nmem files while the Integration is disabled", async () => {
  const root = await preparedInstanceRoot();
  const configurationRoot = path.join(root, "configuration");
  const nmemRoot = path.join(configurationRoot, "integrations", "nmem");
  await mkdir(nmemRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "channels:",
      "  weixin:",
      "    enabled: true",
      "integrations:",
      "  nmem:",
      "    enabled: false",
      "",
    ].join("\n"), "utf8"),
    writeFile(path.join(nmemRoot, "config.json"), "not active configuration", "utf8"),
    writeFile(path.join(nmemRoot, "auth.json"), "not active credentials", "utf8"),
  ]);

  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  assert.equal(host.status().instance.nmem, undefined);
  await host.stop();
});

test("runs one configured Weixin route through Host ingress and graceful stop", async t => {
  let pollCount = 0;
  let stopNotifications = 0;
  const server = createServer((request, response) => {
    if (request.url === "/ilink/bot/getupdates") {
      pollCount += 1;
      if (pollCount > 1) {
        request.on("aborted", () => response.destroy());
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ret: 0,
        get_updates_buf: "host-cursor",
        msgs: [{
          message_id: 91,
          from_user_id: "host-peer",
          create_time_ms: 1_774_070_400_000,
          message_type: 1,
          message_state: 2,
          context_token: "host-context",
          item_list: [{ type: 1, text_item: { text: "hello through Host" } }],
        }],
      }));
      return;
    }
    if (request.url === "/ilink/bot/msg/notifystop") stopNotifications += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ret: 0 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const root = await preparedInstanceRoot();
  await configureWeixin(root, `http://127.0.0.1:${address.port}`);
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();

  await eventually(() => host.status().instance.runtime.inputs.length === 1);
  assert.deepEqual(host.status().instance.runtime.inputs[0], {
    id: host.status().instance.runtime.inputs[0]?.id,
    source: "weixin",
    sourceId: "91",
    kind: "interaction",
    payload: { text: "hello through Host" },
    interaction: {
      routeRef: "primary-route",
      signal: "direct_message",
      actor: { actorRef: "human", kind: "human" },
      place: {
        placeRef: weixinOpaqueRef("place", "primary-route", "host-peer"),
        kind: "direct",
        visibility: "private",
      },
      audience: {
        visibility: "private",
        description: "private conversation with the Weixin peer",
      },
      references: [],
      destinations: [{
        destinationRef: weixinOpaqueRef("destination", "primary-route", "host-peer"),
        routeRef: "primary-route",
        kind: "top_level",
        label: "Weixin peer",
      }],
      defaultDestinationRef: weixinOpaqueRef("destination", "primary-route", "host-peer"),
    },
    interactionWaveId: host.status().instance.runtime.inputs[0]?.interactionWaveId,
    status: "pending",
  });
  assert.equal(host.status().channels?.weixin?.state, "connected");

  await host.stop();
  assert.equal(host.status().state, "stopped");
  assert.equal(host.status().channels?.weixin?.state, "stopped");
  assert.equal(stopNotifications, 1);
});

test("keeps the Host running while the configured Weixin route is degraded", async t => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/ilink/bot/getupdates") {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "offline" }));
      return;
    }
    response.end(JSON.stringify({ ret: 0 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const root = await preparedInstanceRoot();
  await configureWeixin(root, `http://127.0.0.1:${address.port}`);
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();

  await eventually(() => host.status().channels?.weixin?.state === "degraded");
  assert.equal(host.status().state, "running");
  assert.notEqual(host.status().driver.state, "stopped");
  assert.match(host.status().channels?.weixin?.lastError ?? "", /HTTP 503/);
  const report = await readLoomStatus(resolveInstanceLayout(root).statusSocketPath);
  assert.ok("runId" in report);
  if ("runId" in report) {
    assert.deepEqual(report.channels, [{
      name: "weixin",
      state: "degraded",
      lastFailure: { category: "connection" },
    }]);
    assert.doesNotMatch(JSON.stringify(report), /HTTP 503|offline/);
  }
});

test("assembles one explicitly enabled Raft Channel and owns its lifecycle", async t => {
  const root = await preparedInstanceRoot();
  await configureRaft(root);
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no wake expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    listPlaces: async () => ({ items: [] }),
    readActivity: async () => ({ items: [] }),
    searchMessages: async () => ({ items: [] }),
    openReference: async () => ({ objectKind: "place", evidence: {}, references: [] }),
  };
  const host = await openLoomHost({ root, machineTimeZone: "UTC", raftRemote: remote });
  t.after(() => host.stop());

  await host.start();
  await eventually(() => host.status().channels?.raft?.state === "connected");
  assert.equal(host.status().state, "running");
  assert.deepEqual(host.status().channels?.raft, {
    state: "connected",
    ingress: { pending: 0, retrying: 0, failed: 0, spooled: 0 },
  });

  await host.stop();
  assert.equal(host.status().channels?.raft?.state, "stopped");
});

test("chains the operator observer through Raft activity projection", async t => {
  const root = await preparedInstanceRoot();
  await configureRaft(root);
  const events: OperationalEvent[] = [];
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no wake expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    listPlaces: async () => ({ items: [] }),
    readActivity: async () => ({ items: [] }),
    searchMessages: async () => ({ items: [] }),
    openReference: async () => ({ objectKind: "place", evidence: {}, references: [] }),
  };
  const host = await openLoomHost({
    root,
    machineTimeZone: "UTC",
    raftRemote: remote,
    observe: event => events.push(event),
  });
  t.after(() => host.stop());
  await host.start();
  await eventually(() => host.status().channels?.raft?.state === "connected");

  await host.acceptInput({
    source: "test-channel",
    sourceId: "observe-chain",
    kind: "interaction",
    payload: { text: "hello" },
  });
  // The Raft activity projection must not swallow the operator observer: the
  // same committed transition still reaches the external observer.
  await eventually(() => events.some(event =>
    event.event === "runtime.transition" && event.entityType === "input"));

  await host.stop();
});

test("assembles Weixin and Raft Channels together in one Host", async t => {
  const root = await preparedInstanceRoot();
  await configureRaft(root);
  const configurationRoot = path.join(root, "configuration");
  await writeFile(path.join(configurationRoot, "instance.yaml"), [
    "version: 1",
    "channels:",
    "  weixin:",
    "    enabled: true",
    "  raft:",
    "    enabled: true",
    "interaction:",
    "  defaultRoute: primary-route",
    "",
  ].join("\n"), "utf8");
  const remote: RaftRemote = {
    resolveMessage: async () => { throw new Error("no wake expected"); },
    sendText: async () => { throw new Error("no send expected"); },
    listPlaces: async () => ({ items: [] }),
    readActivity: async () => ({ items: [] }),
    searchMessages: async () => ({ items: [] }),
    openReference: async () => ({ objectKind: "place", evidence: {}, references: [] }),
  };
  const host = await openLoomHost({ root, machineTimeZone: "UTC", raftRemote: remote });
  t.after(() => host.stop());
  await host.start();
  await eventually(() => host.status().channels?.raft?.state === "connected");
  await eventually(() => host.status().channels?.weixin?.state === "degraded");

  assert.deepEqual(host.status().channels?.raft, {
    state: "connected",
    ingress: { pending: 0, retrying: 0, failed: 0, spooled: 0 },
  });
  assert.equal(host.status().channels?.weixin?.state, "degraded");
  const report = await readLoomStatus(resolveInstanceLayout(root).statusSocketPath);
  assert.ok("runId" in report);
  if ("runId" in report) {
    assert.deepEqual(report.channels, [
      { name: "weixin", state: "degraded", lastFailure: { category: "connection" } },
      {
        name: "raft",
        state: "connected",
        ingress: { pending: 0, retrying: 0, failed: 0, spooled: 0 },
      },
    ]);
  }
});

test("retries failed wakes on one Channel through the running Host", async t => {
  const root = await preparedInstanceRoot();
  await configureRaft(root);
  let broken = true;
  // Occurred after the Host opens, so the resolved message is not predated by
  // the Channel activation boundary and is delivered as an Input.
  const occurredAt = new Date(Date.now() + 60_000).toISOString();
  const remote: RaftRemote = {
    async drainInbox() {
      return {
        entries: [{
          receiptId: "dm:@alex:aaaaaaaa",
          messageId: "retry-message",
          receivedAt: occurredAt,
        }],
        spooled: 0,
        acknowledge: async () => {},
      };
    },
    async resolveMessage(messageId) {
      if (broken) throw new Error("unsupported Raft message");
      return {
        messageId,
        occurredAt,
        signal: "direct_message",
        content: "Retried through the Host.",
        sender: { memberId: "human-alex", kind: "human", handle: "alex" },
        place: {
          target: "dm:@alex",
          kind: "direct",
          visibility: "private",
          audience: "Only this Individual and Alex can see this DM.",
        },
      };
    },
    sendText: async () => { throw new Error("no send expected"); },
  };
  const host = await openLoomHost({ root, machineTimeZone: "UTC", raftRemote: remote });
  t.after(() => host.stop());
  await host.start();
  await eventually(() => host.status().channels?.raft?.ingress?.failed === 1);
  assert.equal(host.status().channels?.raft?.ingress?.lastFailureCategory, "invalid_message");

  broken = false;
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const result = await runCli(cli, ["retry-ingress", "--root", root, "raft"], process.env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Retried 1 failed ingress item on raft");
  await eventually(() => host.status().channels?.raft?.ingress?.failed === 0);
  assert.equal(host.status().channels?.raft?.ingress?.pending, 0);
  assert.ok(host.status().instance.runtime.inputs.some(
    input => input.sourceId === "retry-message",
  ));
});

test("delivers a persisted outbound Effect through the configured Weixin route", async t => {
  const sentMessages: Array<{
    clientId: string | undefined;
    text: string | undefined;
    to: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    if (request.url === "/ilink/bot/getupdates") {
      request.on("aborted", () => response.destroy());
      return;
    }
    let source = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { source += chunk; });
    request.on("end", () => {
      if (request.url === "/ilink/bot/sendmessage") {
        const body = JSON.parse(source) as {
          msg?: {
            client_id?: string;
            to_user_id?: string;
            item_list?: Array<{ text_item?: { text?: string } }>;
          };
        };
        sentMessages.push({
          clientId: body.msg?.client_id,
          to: body.msg?.to_user_id,
          text: body.msg?.item_list?.[0]?.text_item?.text,
        });
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ret: 0 }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const root = await preparedInstanceRoot();
  await configureWeixin(root, `http://127.0.0.1:${address.port}`);
  const runtime = openRuntime({ root: path.join(root, "runtime"), execution: outboundEffectExecution });
  await runtime.acceptInput({
    source: "test",
    sourceId: "seed-outbound",
    kind: "interaction",
    payload: { text: "seed" },
  });
  assert.equal((await runtime.advance()).disposition, "turn_completed");
  runtime.close();

  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();
  await eventually(() => host.status().instance.runtime.effects[0]?.status === "completed");

  assert.deepEqual(sentMessages, [{
    clientId: host.status().instance.runtime.deliveries[0]?.idempotencyKey,
    to: "host-peer",
    text: "persisted outbound",
  }]);
  assert.equal(host.status().instance.models.state, "blocked");
  await host.stop();
});

const outboundEffectExecution: AgentExecution = {
  start(request, control) {
    control.prepareExecutionState(request.executionState ?? { version: 1 });
    control.includeInput(request.inputs[0]!.id);
    control.prepareEffect({
      kind: "message",
      payload: { text: "persisted outbound" },
      routeRef: "primary-route",
      destinationRef: weixinOpaqueRef("destination", "primary-route", "host-peer"),
    });
    return {
      result: Promise.resolve({
        outcome: "completed",
        inputAnchors: request.inputs.map(input => ({
          inputId: input.id,
          transcriptAnchor: {
            sourceId: request.recordingDay,
            sessionId: "host-weixin-seed",
            entryId: `input-${input.id}`,
          },
        })),
        transcriptAnchor: {
          sourceId: request.recordingDay,
          sessionId: "host-weixin-seed",
          entryId: `turn-${request.turnId}`,
        },
        executionState: { version: 1, turnId: request.turnId },
        executionRecord: { version: 1, turnId: request.turnId },
      }),
      steer: async input => control.includeInput(input.id),
      abort: async () => {},
    };
  },
};

async function runCli(
  cli: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  return { code: code as number | null, stdout, stderr };
}

async function preparedInstanceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-host-"));
  const workspace = path.join(root, "workspace");
  const configuration = path.join(root, "configuration");
  const weixinRoot = path.join(configuration, "channels", "weixin");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await mkdir(weixinRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configuration, "instance.yaml"), [
      "version: 1",
      "channels:",
      "  weixin:",
      "    enabled: true",
      "",
    ].join("\n"), "utf8"),
    writeFile(path.join(weixinRoot, "config.json"), JSON.stringify({
      version: 1,
      routeRef: "primary-route",
      peerId: "host-peer",
      baseUrl: "http://127.0.0.1:1",
    }), "utf8"),
    writeFile(path.join(weixinRoot, "auth.json"), JSON.stringify({
      version: 1,
      token: "host-token",
    }), "utf8"),
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }), "utf8"),
    writeFile(path.join(workspace, "identity.md"), "Rowan is a continuing AI Individual.\n", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "No durable memories yet.\n", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Nothing is currently foregrounded.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "interactivity.md"), "Meet direct interaction as Rowan.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "proactivity.md"), "Proactivity time belongs to Rowan.\n", "utf8"),
  ]);
  return root;
}

async function configureWeixin(root: string, baseUrl: string): Promise<void> {
  const configurationRoot = path.join(root, "configuration");
  const weixinRoot = path.join(configurationRoot, "channels", "weixin");
  await mkdir(weixinRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "channels:",
      "  weixin:",
      "    enabled: true",
      "interaction:",
      "  defaultRoute: primary-route",
      "",
    ].join("\n"), "utf8"),
    writeFile(path.join(weixinRoot, "config.json"), JSON.stringify({
      version: 1,
      routeRef: "primary-route",
      peerId: "host-peer",
      baseUrl,
    }), "utf8"),
    writeFile(path.join(weixinRoot, "auth.json"), JSON.stringify({
      version: 1,
      token: "host-token",
    }), "utf8"),
  ]);
}

async function configureRaft(root: string): Promise<void> {
  const configurationRoot = path.join(root, "configuration");
  const raftRoot = path.join(configurationRoot, "channels", "raft");
  await mkdir(raftRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "channels:",
      "  raft:",
      "    enabled: true",
      "interaction:",
      "  defaultRoute: raft-primary",
      "",
    ].join("\n"), "utf8"),
    writeFile(path.join(raftRoot, "config.json"), JSON.stringify({
      version: 1,
      routeRef: "raft-primary",
      profile: "loom-test",
      serverId: "server-1",
      selfMemberId: "agent-rowan",
      principalMemberId: "human-alex",
      principalDmTarget: "dm:@alex",
    }), "utf8"),
  ]);
}

async function configureNmem(root: string, options: {
  endpoint: string;
  spaceId?: string;
  apiKey?: string;
}): Promise<void> {
  const configurationRoot = path.join(root, "configuration");
  const nmemRoot = path.join(configurationRoot, "integrations", "nmem");
  await mkdir(nmemRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "channels:",
      "  weixin:",
      "    enabled: true",
      "integrations:",
      "  nmem:",
      "    enabled: true",
      "",
    ].join("\n"), "utf8"),
    writeFile(path.join(nmemRoot, "config.json"), JSON.stringify({
      version: 1,
      endpoint: options.endpoint,
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    }), "utf8"),
    ...(options.apiKey ? [
      writeFile(path.join(nmemRoot, "auth.json"), JSON.stringify({
        version: 1,
        apiKey: options.apiKey,
      }), "utf8"),
    ] : []),
  ]);
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

test("host assembly rejects a legacy-only attachment path before creating any file", async () => {
  const root = await preparedInstanceRoot();
  await mkdir(path.join(root, "runtime", "integrations", "attachments"), { recursive: true });
  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /migrate it to .*runtime\/attachments/,
  );
  // Refusal happens before the host lock, status socket or any runtime file.
  await assert.rejects(stat(path.join(root, "runtime", "host-lock.db")));
  await assert.rejects(stat(path.join(root, "runtime", "attachments")));
});

test("host assembly rejects when both attachment paths exist", async () => {
  const root = await preparedInstanceRoot();
  await mkdir(path.join(root, "runtime", "attachments"), { recursive: true });
  await mkdir(path.join(root, "runtime", "integrations", "attachments"), { recursive: true });
  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /found at both/,
  );
  await assert.rejects(stat(path.join(root, "runtime", "host-lock.db")));
});
