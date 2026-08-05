import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLoomHost, readLoomStatus } from "../../src/host/index.js";
import { readLocalInteractionHistory } from "../../src/integrations/local/index.js";
import type { RaftRemote } from "../../src/integrations/raft/index.js";
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

test("serves content-free live status independently of Interaction Channels", async t => {
  const root = await preparedInstanceRoot();
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();

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
  });
  assert.deepEqual(report.agents.map(agent => ({ name: agent.name, state: agent.state })), [
    { name: "main-agent", state: "never_run" },
    { name: "orientation", state: "never_run" },
    { name: "life-recorder", state: "never_run" },
    { name: "attention-maintainer", state: "never_run" },
    { name: "memory-reflector", state: "never_run" },
    { name: "thread-maintainer", state: "never_run" },
  ]);
  assert.deepEqual(report.integrations, []);
  assert.equal("root" in report.host, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replaceAll("\\", "\\\\")));
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
  await rm(configuration);

  const recovered = await openLoomHost({ root });
  await recovered.stop();
});

test("starts an explicitly enabled Local channel over the Instance Interaction View", async t => {
  const root = await preparedInstanceRoot();
  const configurationRoot = path.join(root, "configuration");
  await mkdir(configurationRoot, { recursive: true });
  await writeFile(path.join(configurationRoot, "instance.yaml"), [
    "version: 1",
    "integrations:",
    "  local:",
    "    enabled: true",
    "interaction:",
    "  defaultRoute: local",
    "",
  ].join("\n"), "utf8");
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();

  const accepted = await host.acceptInput({
    source: "local",
    sourceId: "host-local-1",
    kind: "interaction",
    payload: { text: "hello through the local route" },
  });
  const history = await readLocalInteractionHistory({
    socketPath: resolveInstanceLayout(root).localSocketPath,
  });

  assert.equal(accepted.disposition, "accepted");
  assert.deepEqual(history.entries.map(entry => ({
    actorRef: entry.actorRef,
    source: entry.source,
    content: entry.content,
  })), [{
    actorRef: "human",
    source: "local",
    content: { text: "hello through the local route" },
  }]);
  assert.equal(host.status().integrations?.local?.state, "listening");
});

test("rejects an incomplete Weixin configuration before opening the Host", async () => {
  const root = await preparedInstanceRoot();
  await configureWeixin(root, "https://weixin.invalid");
  const authFile = path.join(root, "configuration", "integrations", "weixin", "auth.json");
  await rm(authFile);

  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /requires both config\.json and auth\.json/,
  );

  await writeFile(authFile, JSON.stringify({ version: 1, token: "restored-token" }), "utf8");
  const recovered = await openLoomHost({ root, machineTimeZone: "UTC" });
  await recovered.stop();
});

test("does not inspect Weixin files while the Integration is disabled", async () => {
  const root = await preparedInstanceRoot();
  const configurationRoot = path.join(root, "configuration");
  const weixinRoot = path.join(configurationRoot, "integrations", "weixin");
  await mkdir(weixinRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "integrations:",
      "  weixin:",
      "    enabled: false",
      "",
    ].join("\n"), "utf8"),
    writeFile(path.join(weixinRoot, "config.json"), "not active configuration", "utf8"),
  ]);

  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  assert.equal(host.status().integrations, undefined);
  await host.stop();
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
    interactionWaveId: host.status().instance.runtime.inputs[0]?.interactionWaveId,
    status: "pending",
  });
  assert.equal(host.status().integrations?.weixin?.state, "connected");

  await host.stop();
  assert.equal(host.status().state, "stopped");
  assert.equal(host.status().integrations?.weixin?.state, "stopped");
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

  await eventually(() => host.status().integrations?.weixin?.state === "degraded");
  assert.equal(host.status().state, "running");
  assert.notEqual(host.status().driver.state, "stopped");
  assert.match(host.status().integrations?.weixin?.lastError ?? "", /HTTP 503/);
  const report = await readLoomStatus(resolveInstanceLayout(root).statusSocketPath);
  assert.ok("runId" in report);
  if ("runId" in report) {
    assert.deepEqual(report.integrations, [{
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
  await eventually(() => host.status().integrations?.raft?.state === "connected");
  assert.equal(host.status().state, "running");
  assert.deepEqual(host.status().integrations?.raft, {
    state: "connected",
    pendingWakes: 0,
  });

  await host.stop();
  assert.equal(host.status().integrations?.raft?.state, "stopped");
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

async function preparedInstanceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-host-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }), "utf8"),
    writeFile(path.join(workspace, "identity.md"), "Rowan is a continuing AI Individual.\n", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "No durable memories yet.\n", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Nothing is currently foregrounded.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "interaction.md"), "Meet direct interaction as Rowan.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "background.md"), "Background time belongs to Rowan.\n", "utf8"),
  ]);
  return root;
}

async function configureWeixin(root: string, baseUrl: string): Promise<void> {
  const configurationRoot = path.join(root, "configuration");
  const weixinRoot = path.join(configurationRoot, "integrations", "weixin");
  await mkdir(weixinRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "integrations:",
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
  const raftRoot = path.join(configurationRoot, "integrations", "raft");
  await mkdir(raftRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(configurationRoot, "instance.yaml"), [
      "version: 1",
      "integrations:",
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
