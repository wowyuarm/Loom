import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLoomHost } from "../../src/host/index.js";
import { openRuntime, type AgentExecution } from "../../src/runtime/index.js";

test("holds exclusive live ownership of one prepared Instance Root", async t => {
  const root = await preparedInstanceRoot();
  const first = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => first.stop());

  first.start();
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

  host.start();
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
  host.start();

  await eventually(() => host.status().instance.runtime.inputs.length === 1);
  assert.deepEqual(host.status().instance.runtime.inputs[0], {
    id: host.status().instance.runtime.inputs[0]?.id,
    source: "weixin",
    sourceId: "91",
    kind: "interaction",
    payload: { text: "hello through Host" },
    status: "pending",
  });
  assert.equal(host.status().integrations?.weixin.state, "connected");

  await host.stop();
  assert.equal(host.status().state, "stopped");
  assert.equal(host.status().integrations?.weixin.state, "stopped");
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
  host.start();

  await eventually(() => host.status().integrations?.weixin.state === "degraded");
  assert.equal(host.status().state, "running");
  assert.notEqual(host.status().driver.state, "stopped");
  assert.match(host.status().integrations?.weixin.lastError ?? "", /HTTP 503/);
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
  host.start();
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

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}
