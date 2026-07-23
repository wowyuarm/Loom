import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWeixinHttpRemote,
  openWeixinAdapter,
  type WeixinRemote,
} from "../../src/integrations/weixin/index.js";
import type { RuntimeInput } from "../../src/runtime/index.js";

test("accepts text Input before advancing the durable Weixin cursor", async t => {
  const paths = await weixinPaths();
  const cursors: string[] = [];
  const remote = blockingRemote({
    cursors,
    firstPoll: {
      cursor: "cursor-after-42",
      messages: [{
        messageId: "42",
        from: "peer-1",
        createTimeMs: 1_774_070_400_000,
        messageType: "user",
        messageState: "finished",
        contextToken: "context-42",
        items: [{ type: "text", text: "hello from Weixin" }],
      }],
    },
  });
  const adapter = await openWeixinAdapter({
    ...paths,
    expectedRouteRef: "primary-route",
    remote,
  });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: "input-42" };
  });

  await eventually(() => inputs.length === 1);
  assert.deepEqual(inputs[0], {
    source: "weixin",
    sourceId: "42",
    kind: "interaction",
    payload: { text: "hello from Weixin" },
    occurredAt: "2026-03-21T05:20:00.000Z",
  });
  await adapter.stop();

  const recoveredCursors: string[] = [];
  const recovered = await openWeixinAdapter({
    ...paths,
    expectedRouteRef: "primary-route",
    remote: blockingRemote({ cursors: recoveredCursors, firstPoll: { messages: [] } }),
  });
  t.after(() => recovered.stop());
  recovered.start(async () => ({ disposition: "accepted", inputId: "unused" }));
  await eventually(() => recoveredCursors.length >= 1);
  assert.equal(recoveredCursors[0], "cursor-after-42");
});

test("delivers text with Runtime idempotency and the accepted peer context", async t => {
  const paths = await weixinPaths();
  const sends: Parameters<WeixinRemote["sendText"]>[0][] = [];
  const remote = blockingRemote({
    cursors: [],
    firstPoll: {
      cursor: "cursor-after-context",
      messages: [{
        messageId: "context-message",
        from: "peer-1",
        messageType: "user",
        messageState: "finished",
        contextToken: "peer-context",
        items: [{ type: "text", text: "remember this context" }],
      }],
    },
    sendText: async request => {
      sends.push(request);
      return { disposition: "sent", remoteId: "remote-77" };
    },
  });
  const adapter = await openWeixinAdapter({
    ...paths,
    expectedRouteRef: "primary-route",
    remote,
  });
  t.after(() => adapter.stop());
  adapter.start(async () => ({ disposition: "accepted", inputId: "context-input" }));
  await eventually(() => adapter.status().state === "connected");

  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-1",
    effectId: "effect-1",
    kind: "message",
    payload: { text: "a visible reply" },
    routeRef: "primary-route",
    idempotencyKey: "effect-1:1",
  }), { status: "delivered", remoteId: "remote-77" });
  assert.deepEqual(sends[0], {
    baseUrl: "https://weixin.invalid",
    token: "secret-token",
    peerId: "peer-1",
    text: "a visible reply",
    clientId: "effect-1:1",
    contextToken: "peer-context",
  });

  remote.sendText = async () => ({ disposition: "rejected", error: "recipient unavailable" });
  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-2",
    effectId: "effect-1",
    kind: "message",
    payload: { text: "retry" },
    routeRef: "primary-route",
    idempotencyKey: "effect-1:2",
  }), { status: "not_sent", error: "recipient unavailable" });

  remote.sendText = async () => { throw new Error("connection reset"); };
  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-3",
    effectId: "effect-1",
    kind: "message",
    payload: { text: "uncertain" },
    routeRef: "primary-route",
    idempotencyKey: "effect-1:3",
  }), { status: "unknown", error: "connection reset" });
});

test("maps Weixin HTTP updates and sends the Runtime idempotency key as client_id", async t => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { source += chunk; });
    request.on("end", () => {
      const body = JSON.parse(source || "{}") as Record<string, unknown>;
      requests.push({ path: request.url ?? "", body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/ilink/bot/getupdates") {
        response.end(JSON.stringify({
          ret: 0,
          get_updates_buf: "cursor-next",
          msgs: [{
            message_id: 73,
            from_user_id: "peer-1",
            create_time_ms: 1_774_070_400_000,
            message_type: 1,
            message_state: 2,
            context_token: "context-73",
            item_list: [{ type: 1, text_item: { text: "wire text" } }],
          }],
        }));
        return;
      }
      response.end(JSON.stringify({ ret: 0 }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const remote = createWeixinHttpRemote();
  const controller = new AbortController();

  await remote.start({ baseUrl, token: "wire-token", signal: controller.signal });
  assert.deepEqual(await remote.poll({
    baseUrl,
    token: "wire-token",
    cursor: "cursor-old",
    signal: controller.signal,
  }), {
    cursor: "cursor-next",
    messages: [{
      messageId: "73",
      from: "peer-1",
      createTimeMs: 1_774_070_400_000,
      messageType: "user",
      messageState: "finished",
      contextToken: "context-73",
      items: [{ type: "text", text: "wire text" }],
    }],
  });
  assert.deepEqual(await remote.sendText({
    baseUrl,
    token: "wire-token",
    peerId: "peer-1",
    text: "wire reply",
    clientId: "effect-wire:4",
    contextToken: "context-73",
  }), { disposition: "sent", remoteId: "effect-wire:4" });
  await remote.stop({ baseUrl, token: "wire-token" });

  const pollBody = requests.find(item => item.path === "/ilink/bot/getupdates")?.body;
  assert.equal(pollBody?.get_updates_buf, "cursor-old");
  const sendBody = requests.find(item => item.path === "/ilink/bot/sendmessage")?.body as {
    msg?: { client_id?: string; context_token?: string };
  } | undefined;
  assert.equal(sendBody?.msg?.client_id, "effect-wire:4");
  assert.equal(sendBody?.msg?.context_token, "context-73");
});

test("does not advance the Weixin cursor when Runtime has not accepted the Input", async t => {
  const paths = await weixinPaths();
  const adapter = await openWeixinAdapter({
    ...paths,
    expectedRouteRef: "primary-route",
    remote: blockingRemote({
      cursors: [],
      firstPoll: {
        cursor: "cursor-must-wait",
        messages: [{
          messageId: "not-accepted",
          from: "peer-1",
          messageType: "user",
          messageState: "finished",
          items: [{ type: "text", text: "do not lose me" }],
        }],
      },
    }),
  });
  adapter.start(async () => { throw new Error("Runtime unavailable"); });
  await eventually(() => adapter.status().state === "degraded");
  await adapter.stop();

  const recoveredCursors: string[] = [];
  const recovered = await openWeixinAdapter({
    ...paths,
    expectedRouteRef: "primary-route",
    remote: blockingRemote({ cursors: recoveredCursors, firstPoll: { messages: [] } }),
  });
  t.after(() => recovered.stop());
  recovered.start(async () => ({ disposition: "accepted", inputId: "recovered" }));
  await eventually(() => recoveredCursors.length >= 1);
  assert.equal(recoveredCursors[0], "");
});

test("retries once without an expired peer context inside the same Delivery attempt", async t => {
  const paths = await weixinPaths();
  const sends: Parameters<WeixinRemote["sendText"]>[0][] = [];
  const remote = blockingRemote({
    cursors: [],
    firstPoll: {
      cursor: "cursor-expired-context",
      messages: [{
        messageId: "expired-context",
        from: "peer-1",
        messageType: "user",
        messageState: "finished",
        contextToken: "expired-token",
        items: [{ type: "text", text: "refresh this session" }],
      }],
    },
    sendText: async request => {
      sends.push(request);
      return sends.length === 1
        ? { disposition: "rejected", error: "session expired", code: -14 }
        : { disposition: "sent", remoteId: request.clientId };
    },
  });
  const adapter = await openWeixinAdapter({
    ...paths,
    expectedRouteRef: "primary-route",
    remote,
  });
  t.after(() => adapter.stop());
  adapter.start(async () => ({ disposition: "accepted", inputId: "expired-context-input" }));
  await eventually(() => adapter.status().state === "connected");

  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-expired",
    effectId: "effect-expired",
    kind: "message",
    payload: { text: "same Delivery" },
    routeRef: "primary-route",
    idempotencyKey: "effect-expired:1",
  }), { status: "delivered", remoteId: "effect-expired:1" });
  assert.equal(sends.length, 2);
  assert.equal(sends[0]?.contextToken, "expired-token");
  assert.equal(sends[1]?.contextToken, undefined);
  assert.equal(sends[0]?.clientId, sends[1]?.clientId);
});

function blockingRemote(options: {
  cursors: string[];
  firstPoll: Awaited<ReturnType<WeixinRemote["poll"]>>;
  sendText?: WeixinRemote["sendText"];
}): WeixinRemote {
  let polls = 0;
  return {
    start: async () => {},
    async poll(request) {
      options.cursors.push(request.cursor);
      polls += 1;
      if (polls === 1) return options.firstPoll;
      await aborted(request.signal);
      return { messages: [] };
    },
    sendText: options.sendText ?? (async () => ({ disposition: "sent", remoteId: "unused" })),
    stop: async () => {},
  };
}

async function weixinPaths(): Promise<{
  configurationFile: string;
  authFile: string;
  stateFile: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-weixin-"));
  const configurationFile = path.join(root, "configuration", "integrations", "weixin", "config.json");
  const authFile = path.join(root, "configuration", "integrations", "weixin", "auth.json");
  const stateFile = path.join(root, "runtime", "integrations", "weixin.db");
  await mkdir(path.dirname(configurationFile), { recursive: true });
  await Promise.all([
    writeFile(configurationFile, JSON.stringify({
      version: 1,
      routeRef: "primary-route",
      peerId: "peer-1",
      baseUrl: "https://weixin.invalid",
    }), "utf8"),
    writeFile(authFile, JSON.stringify({ version: 1, token: "secret-token" }), "utf8"),
  ]);
  return { configurationFile, authFile, stateFile };
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}
