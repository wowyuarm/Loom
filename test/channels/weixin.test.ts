import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWeixinHttpRemote,
  openWeixinAdapter,
  weixinOpaqueRef,
  WeixinFailure,
  WEIXIN_SESSION_EXPIRED_CODE,
  type WeixinRemote,
  type WeixinRemoteMessage,
} from "../../src/channels/weixin/index.js";
import { openAttachmentStore } from "../../src/attachments/index.js";
import { parseAttachmentReference } from "../../src/attachments/index.js";
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

    remote,
  });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: "input-42" };
  });

  await eventually(() => inputs.length === 1 || adapter.status().state === "degraded");
  assert.equal(adapter.status().lastError, undefined);
  assert.deepEqual(inputs[0], {
    source: "weixin",
    sourceId: "42",
    kind: "interaction",
    payload: { text: "hello from Weixin" },
    occurredAt: "2026-03-21T05:20:00.000Z",
    interaction: {
      routeRef: "primary-route",
      signal: "direct_message",
      actor: { actorRef: "human", kind: "human" },
      place: {
        placeRef: weixinOpaqueRef("place", "primary-route", "peer-1"),
        kind: "direct",
        visibility: "private",
      },
      audience: {
        visibility: "private",
        description: "private conversation with the Weixin peer",
      },
      references: [],
      destinations: [{
        destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
        routeRef: "primary-route",
        kind: "top_level",
        label: "Weixin peer",
      }],
      defaultDestinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    },
  });
  await adapter.stop();

  const recoveredCursors: string[] = [];
  const recovered = await openWeixinAdapter({
    ...paths,

    remote: blockingRemote({ cursors: recoveredCursors, firstPoll: { messages: [] } }),
  });
  t.after(() => recovered.stop());
  recovered.start(async () => ({ disposition: "accepted", inputId: "unused" }));
  await eventually(() => recoveredCursors.length >= 1);
  assert.equal(recoveredCursors[0], "cursor-after-42");
});

test("persists an inbound Weixin image before accepting Input and advancing cursor", async t => {
  const paths = await weixinPaths();
  const attachmentStore = paths.attachmentStore;
  const content = Buffer.from("downloaded image", "utf8");
  const remote = blockingRemote({
    cursors: [],
    firstPoll: {
      cursor: "cursor-after-image",
      messages: [{
        messageId: "image-42",
        from: "peer-1",
        messageType: "user",
        messageState: "finished",
        items: [{
          type: "image",
          image: { encryptedQueryParam: "image-ref", aesKey: "image-key" },
        }],
      }],
    },
    downloadImage: async () => ({ content, mediaType: "image/png", fileName: "arrival.png" }),
  });
  const adapter = await openWeixinAdapter({
    ...paths,

    attachmentStore,
    remote,
  });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    const payload = input.payload as { attachments?: unknown[] };
    const attachment = parseAttachmentReference(payload.attachments?.[0]);
    assert.deepEqual(await attachmentStore.read(attachment), content);
    return { disposition: "accepted", inputId: "input-image-42" };
  });

  await eventually(() => inputs.length === 1 || adapter.status().state === "degraded");
  assert.equal(adapter.status().lastError, undefined);
  const payload = inputs[0]!.payload as { text?: unknown; attachments?: unknown[] };
  assert.equal(payload.text, undefined);
  assert.equal(payload.attachments?.length, 1);
  await adapter.stop();

  const recoveredCursors: string[] = [];
  const recovered = await openWeixinAdapter({
    ...paths,

    attachmentStore,
    remote: blockingRemote({ cursors: recoveredCursors, firstPoll: { messages: [] } }),
  });
  t.after(() => recovered.stop());
  recovered.start(async () => ({ disposition: "accepted", inputId: "unused" }));
  await eventually(() => recoveredCursors.length >= 1);
  assert.equal(recoveredCursors[0], "cursor-after-image");
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
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
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
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    idempotencyKey: "effect-1:2",
  }), { status: "not_sent", error: "recipient unavailable" });

  remote.sendText = async () => { throw new Error("connection reset"); };
  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-3",
    effectId: "effect-1",
    kind: "message",
    payload: { text: "uncertain" },
    routeRef: "primary-route",
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    idempotencyKey: "effect-1:3",
  }), { status: "unknown", error: "connection reset" });
});

test("delivers one immutable outbound attachment from the generic message Effect", async t => {
  const paths = await weixinPaths();
  const attachment = await paths.attachmentStore.put({
    kind: "file",
    mediaType: "text/plain",
    fileName: "note.txt",
    content: Buffer.from("outbound attachment", "utf8"),
  });
  const sends: Parameters<WeixinRemote["sendAttachment"]>[0][] = [];
  const remote = blockingRemote({
    cursors: [],
    firstPoll: { messages: [] },
    sendAttachment: async request => {
      sends.push(request);
      return { disposition: "sent", remoteId: "remote-attachment" };
    },
  });
  const adapter = await openWeixinAdapter({
    ...paths,

    remote,
  });
  t.after(() => adapter.stop());

  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-attachment",
    effectId: "effect-attachment",
    kind: "message",
    payload: {
      attachments: [JSON.parse(JSON.stringify(attachment))],
    },
    routeRef: "primary-route",
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    idempotencyKey: "effect-attachment:1",
  }), { status: "delivered", remoteId: "remote-attachment" });
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.clientId, "effect-attachment:1");
  assert.equal(sends[0]?.text, "");
  assert.deepEqual(sends[0]?.attachment, attachment);
  assert.deepEqual(Buffer.from(sends[0]?.content ?? []), Buffer.from("outbound attachment", "utf8"));
});

test("reports unknown when an attachment fails after its caption was sent", async t => {
  const paths = await weixinPaths();
  t.after(() => paths.attachmentStore.close());
  const attachment = await paths.attachmentStore.put({
    kind: "file",
    mediaType: "text/plain",
    fileName: "partial.txt",
    content: Buffer.from("partial delivery", "utf8"),
  });
  const clientIds: string[] = [];
  let baseUrl = "";
  const server = createServer((request, response) => {
    if (request.url === "/cdn-upload") {
      request.resume();
      request.on("end", () => {
        response.setHeader("x-encrypted-param", "partial-upload-ref");
        response.end();
      });
      return;
    }
    let source = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { source += chunk; });
    request.on("end", () => {
      const body = JSON.parse(source || "{}") as {
        msg?: { client_id?: string };
      };
      response.setHeader("content-type", "application/json");
      if (request.url === "/ilink/bot/getuploadurl") {
        response.end(JSON.stringify({ ret: 0, upload_full_url: `${baseUrl}/cdn-upload` }));
        return;
      }
      if (request.url === "/ilink/bot/sendmessage") {
        if (body.msg?.client_id) clientIds.push(body.msg.client_id);
        response.end(JSON.stringify(
          body.msg?.client_id?.endsWith(":attachment")
            ? { ret: -1, errmsg: "attachment rejected" }
            : { ret: 0 },
        ));
        return;
      }
      response.end(JSON.stringify({ ret: 0 }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(paths.configurationFile, JSON.stringify({
    version: 1,
    routeRef: "primary-route",
    peerId: "peer-1",
    baseUrl,
    cdnBaseUrl: baseUrl,
  }), "utf8");
  const adapter = await openWeixinAdapter({
    ...paths,

    remote: createWeixinHttpRemote(),
  });
  t.after(() => adapter.stop());

  const result = await adapter.deliver({
    attemptId: "attempt-partial",
    effectId: "effect-partial",
    kind: "message",
    payload: {
      text: "caption already visible",
      attachments: [JSON.parse(JSON.stringify(attachment))],
    },
    routeRef: "primary-route",
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    idempotencyKey: "effect-partial:1",
  });

  assert.equal(result.status, "unknown");
  assert.match(result.error ?? "", /after its caption was sent/);
  assert.deepEqual(clientIds, ["effect-partial:1:text", "effect-partial:1:attachment"]);
});

test("stops an inbound image stream when it exceeds 15 MiB", async t => {
  const chunk = Buffer.alloc(1024 * 1024);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    for (let index = 0; index < 16; index += 1) response.write(chunk);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const remote = createWeixinHttpRemote();

  await assert.rejects(remote.downloadImage({
    cdnBaseUrl: "http://unused.invalid",
    image: { fullUrl: `http://127.0.0.1:${address.port}/oversized-image` },
    signal: AbortSignal.timeout(2_000),
  }), /exceeds the 15 MiB inbound limit/);
});

test("maps Weixin HTTP updates and sends the Runtime idempotency key as client_id", async t => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const uploads: Buffer[] = [];
  const imageKey = Buffer.from("0123456789abcdef", "utf8");
  const imageContent = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("loom-image", "utf8"),
  ]);
  const cipher = crypto.createCipheriv("aes-128-ecb", imageKey, null);
  const encryptedImage = Buffer.concat([cipher.update(imageContent), cipher.final()]);
  let baseUrl = "";
  const server = createServer((request, response) => {
    if (request.url === "/cdn-image") {
      response.end(encryptedImage);
      return;
    }
    if (request.url?.startsWith("/cdn-upload")) {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        uploads.push(Buffer.concat(chunks));
        response.setHeader("x-encrypted-param", "download-attachment-ref");
        response.end();
      });
      return;
    }
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
            item_list: [
              { type: 1, text_item: { text: "wire text" } },
              {
                type: 2,
                image_item: {
                  media: {
                    full_url: `${baseUrl}/cdn-image`,
                    aes_key: imageKey.toString("base64"),
                  },
                },
              },
            ],
          }],
        }));
        return;
      }
      if (request.url === "/ilink/bot/getuploadurl") {
        response.end(JSON.stringify({
          ret: 0,
          upload_full_url: `${baseUrl}/cdn-upload`,
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
  baseUrl = `http://127.0.0.1:${address.port}`;
  const remote = createWeixinHttpRemote();
  const controller = new AbortController();

  await remote.start({ baseUrl, token: "wire-token", signal: controller.signal });
  const polled = await remote.poll({
    baseUrl,
    token: "wire-token",
    cursor: "cursor-old",
    timeoutMs: 40_000,
    signal: controller.signal,
  });
  assert.deepEqual(polled, {
    cursor: "cursor-next",
    messages: [{
      messageId: "73",
      from: "peer-1",
      createTimeMs: 1_774_070_400_000,
      messageType: "user",
      messageState: "finished",
      contextToken: "context-73",
      items: [
        { type: "text", text: "wire text" },
        {
          type: "image",
          image: {
            aesKey: imageKey.toString("base64"),
            fullUrl: `${baseUrl}/cdn-image`,
          },
        },
      ],
    }],
  });
  const image = polled.messages?.[0]?.items?.[1]?.image;
  assert.ok(image);
  assert.deepEqual(await remote.downloadImage({
    cdnBaseUrl: `${baseUrl}/unused-cdn`,
    image,
    signal: controller.signal,
  }), {
    content: imageContent,
    mediaType: "image/png",
    fileName: "weixin-image.png",
  });
  assert.deepEqual(await remote.sendText({
    baseUrl,
    token: "wire-token",
    peerId: "peer-1",
    text: "wire reply",
    clientId: "effect-wire:4",
    contextToken: "context-73",
  }), { disposition: "sent", remoteId: "effect-wire:4" });
  const outboundContent = Buffer.from("wire attachment", "utf8");
  const outboundAttachment = {
    version: 1 as const,
    id: `sha256:${crypto.createHash("sha256").update(outboundContent).digest("hex")}`,
    kind: "file" as const,
    mediaType: "text/plain",
    byteSize: outboundContent.length,
    fileName: "wire.txt",
  };
  assert.deepEqual(await remote.sendAttachment({
    baseUrl,
    cdnBaseUrl: `${baseUrl}/cdn`,
    token: "wire-token",
    peerId: "peer-1",
    text: "",
    attachment: outboundAttachment,
    content: outboundContent,
    clientId: "effect-wire-attachment:2",
    contextToken: "context-73",
  }), { disposition: "sent", remoteId: "effect-wire-attachment:2:attachment" });
  await remote.stop({ baseUrl, token: "wire-token" });

  const pollBody = requests.find(item => item.path === "/ilink/bot/getupdates")?.body;
  assert.equal(pollBody?.get_updates_buf, "cursor-old");
  const sendBody = requests.find(item => item.path === "/ilink/bot/sendmessage")?.body as {
    msg?: { client_id?: string; context_token?: string };
  } | undefined;
  assert.equal(sendBody?.msg?.client_id, "effect-wire:4");
  assert.equal(sendBody?.msg?.context_token, "context-73");
  const uploadRequest = requests.find(item => item.path === "/ilink/bot/getuploadurl")?.body as {
    aeskey?: string;
    rawsize?: number;
    rawfilemd5?: string;
  } | undefined;
  assert.equal(uploadRequest?.rawsize, outboundContent.length);
  assert.equal(uploadRequest?.rawfilemd5, crypto.createHash("md5").update(outboundContent).digest("hex"));
  assert.ok(uploadRequest?.aeskey);
  const uploadDecipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(uploadRequest.aeskey, "hex"), null);
  assert.deepEqual(Buffer.concat([uploadDecipher.update(uploads[0]!), uploadDecipher.final()]), outboundContent);
  const attachmentSend = requests.find(item => {
    if (item.path !== "/ilink/bot/sendmessage") return false;
    const body = item.body as { msg?: { client_id?: string } };
    return body.msg?.client_id === "effect-wire-attachment:2:attachment";
  })?.body as { msg?: { item_list?: Array<{ type?: number; file_item?: { file_name?: string } }> } } | undefined;
  assert.equal(attachmentSend?.msg?.item_list?.[0]?.type, 4);
  assert.equal(attachmentSend?.msg?.item_list?.[0]?.file_item?.file_name, "wire.txt");
});

test("does not advance the Weixin cursor when Runtime has not accepted the Input", async t => {
  const paths = await weixinPaths();
  const adapter = await openWeixinAdapter({
    ...paths,

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
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    idempotencyKey: "effect-expired:1",
  }), { status: "delivered", remoteId: "effect-expired:1" });
  assert.equal(sends.length, 2);
  assert.equal(sends[0]?.contextToken, "expired-token");
  assert.equal(sends[1]?.contextToken, undefined);
  assert.equal(sends[0]?.clientId, sends[1]?.clientId);
});

test("shows the peer typing from accepted Input until the Delivery attempt ends", async t => {
  const paths = await weixinPaths();
  const typing: Array<{ status: string; peerId: string; typingTicket: string }> = [];
  const remote = blockingRemote({
    cursors: [],
    firstPoll: {
      cursor: "cursor-typing",
      messages: [{
        messageId: "typing-1",
        from: "peer-1",
        messageType: "user",
        messageState: "finished",
        contextToken: "context-typing",
        items: [{ type: "text", text: "are you there" }],
      }],
    },
    sendTyping: async request => {
      typing.push({ status: request.status, peerId: request.peerId, typingTicket: request.typingTicket });
    },
  });
  const adapter = await openWeixinAdapter({
    ...paths,
    remote,
    typing: { keepaliveMs: 60_000, maxDurationMs: 60_000 },
  });
  t.after(() => adapter.stop());
  adapter.start(async () => ({ disposition: "accepted", inputId: "input-typing" }));

  await eventually(() => typing.length === 1);
  assert.deepEqual(typing[0], { status: "typing", peerId: "peer-1", typingTicket: "typing-ticket" });

  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-typing",
    effectId: "effect-typing",
    kind: "message",
    payload: { text: "still here" },
    routeRef: "primary-route",
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    idempotencyKey: "effect-typing:1",
  }), { status: "delivered", remoteId: "unused" });
  assert.deepEqual(typing[1], { status: "cancel", peerId: "peer-1", typingTicket: "typing-ticket" });
  assert.equal(adapter.status().state, "connected");
  await adapter.stop();
});

test("cancels a typing session that outlives its maximum duration", async t => {
  const paths = await weixinPaths();
  const typing: string[] = [];
  const remote = blockingRemote({
    cursors: [],
    firstPoll: {
      messages: [{
        messageId: "typing-timeout",
        from: "peer-1",
        messageType: "user",
        messageState: "finished",
        items: [{ type: "text", text: "no answer is coming" }],
      }],
    },
    sendTyping: async request => { typing.push(request.status); },
  });
  const adapter = await openWeixinAdapter({
    ...paths,
    remote,
    typing: { keepaliveMs: 60_000, maxDurationMs: 25 },
  });
  t.after(() => adapter.stop());
  adapter.start(async () => ({ disposition: "accepted", inputId: "input-typing-timeout" }));

  await eventually(() => typing.includes("cancel"));
  assert.deepEqual(typing, ["typing", "cancel"]);
});

test("keeps ingress and Delivery working when the peer's typing calls fail", async t => {
  const paths = await weixinPaths();
  const remote = blockingRemote({
    cursors: [],
    firstPoll: {
      cursor: "cursor-typing-failure",
      messages: [{
        messageId: "typing-failure",
        from: "peer-1",
        messageType: "user",
        messageState: "finished",
        items: [{ type: "text", text: "typing is best effort" }],
      }],
    },
    typingTicket: async () => { throw new Error("getconfig unavailable"); },
    sendTyping: async () => { throw new Error("sendtyping unavailable"); },
  });
  const adapter = await openWeixinAdapter({
    ...paths,
    remote,
    typing: { keepaliveMs: 60_000, maxDurationMs: 60_000 },
  });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: "input-typing-failure" };
  });

  await eventually(() => inputs.length === 1);
  await eventually(() => adapter.status().state === "connected");
  assert.equal(adapter.status().lastError, undefined);
  assert.deepEqual(await adapter.deliver({
    attemptId: "attempt-typing-failure",
    effectId: "effect-typing-failure",
    kind: "message",
    payload: { text: "delivery still works" },
    routeRef: "primary-route",
    destinationRef: weixinOpaqueRef("destination", "primary-route", "peer-1"),
    idempotencyKey: "effect-typing-failure:1",
  }), { status: "delivered", remoteId: "unused" });
  await adapter.stop();
});

test("resolves a typing ticket and publishes typing over the Weixin wire", async t => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let baseUrl = "";
  const server = createServer((request, response) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { source += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: JSON.parse(source || "{}") as Record<string, unknown> });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url === "/ilink/bot/getconfig"
        ? { ret: 0, typing_ticket: "ticket-wire" }
        : { ret: 0 }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const remote = createWeixinHttpRemote();

  assert.equal(await remote.typingTicket({
    baseUrl,
    token: "wire-token",
    peerId: "peer-1",
    contextToken: "context-wire",
  }), "ticket-wire");
  await remote.sendTyping({ baseUrl, token: "wire-token", peerId: "peer-1", typingTicket: "ticket-wire", status: "typing" });
  await remote.sendTyping({ baseUrl, token: "wire-token", peerId: "peer-1", typingTicket: "ticket-wire", status: "cancel" });

  const config = requests.find(item => item.path === "/ilink/bot/getconfig")?.body;
  assert.equal(config?.ilink_user_id, "peer-1");
  assert.equal(config?.context_token, "context-wire");
  const typingCalls = requests.filter(item => item.path === "/ilink/bot/sendtyping").map(item => item.body);
  assert.deepEqual(typingCalls, [
    { ilink_user_id: "peer-1", typing_ticket: "ticket-wire", status: 1, base_info: { channel_version: "2.3.1", bot_agent: "Loom" } },
    { ilink_user_id: "peer-1", typing_ticket: "ticket-wire", status: 2, base_info: { channel_version: "2.3.1", bot_agent: "Loom" } },
  ]);
});

test("spaces consecutive outbound Weixin messages without dropping either", async t => {
  const arrivals: number[] = [];
  const server = createServer((request, response) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { source += chunk; });
    request.on("end", () => {
      arrivals.push(Date.now());
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ret: 0 }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const remote = createWeixinHttpRemote({ minimumSendIntervalMs: 150 });

  assert.deepEqual(await remote.sendText({
    baseUrl,
    token: "wire-token",
    peerId: "peer-1",
    text: "first",
    clientId: "effect-pace:1",
  }), { disposition: "sent", remoteId: "effect-pace:1" });
  assert.deepEqual(await remote.sendText({
    baseUrl,
    token: "wire-token",
    peerId: "peer-1",
    text: "second",
    clientId: "effect-pace:2",
  }), { disposition: "sent", remoteId: "effect-pace:2" });

  assert.equal(arrivals.length, 2);
  const gap = arrivals[1]! - arrivals[0]!;
  assert.ok(gap >= 120, `expected consecutive sends to be spaced, saw ${gap}ms`);
});

test("does not let an unrepresentable inbound message block later messages or the cursor", async t => {
  const paths = await weixinPaths();
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("first-image", "utf8"),
  ]);
  const cursors: string[] = [];
  const remote: WeixinRemote = {
    start: async () => {},
    async poll(request) {
      cursors.push(request.cursor);
      // The remote replays everything after the last acknowledged cursor, so an
      // unprocessable message keeps coming back until the adapter moves past it.
      if (request.cursor !== "") {
        await aborted(request.signal);
        return { messages: [] };
      }
      return {
        cursor: "cursor-after-batch",
        messages: [
          {
            messageId: "poison",
            from: "peer-1",
            messageType: "user",
            messageState: "finished",
            items: [
              { type: "image", image: { encryptedQueryParam: "image-1", aesKey: "key-1" } },
              { type: "image", image: { encryptedQueryParam: "image-2", aesKey: "key-2" } },
            ],
          },
          {
            messageId: "sibling",
            from: "peer-1",
            messageType: "user",
            messageState: "finished",
            items: [{ type: "text", text: "second message" }],
          },
        ],
      };
    },
    downloadImage: async () => ({ content: image, mediaType: "image/png", fileName: "first.png" }),
    sendAttachment: async () => { throw new Error("no attachment expected"); },
    sendText: async () => ({ disposition: "sent", remoteId: "unused" }),
    typingTicket: async () => undefined,
    sendTyping: async () => {},
    stop: async () => {},
  };
  const adapter = await openWeixinAdapter({ ...paths, remote });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await eventually(() => inputs.some(input => input.sourceId === "sibling"));
  await eventually(() => cursors.includes("cursor-after-batch"));
  await adapter.stop();
});

test("records an unreadable inbound message as failed ingress and keeps the channel connected", async t => {
  const paths = await weixinPaths();
  const cursors: string[] = [];
  const remote = batchRemote({
    cursors,
    messages: [imageMessage("oversized", "image-poison"), textMessage("sibling", "text that must still arrive")],
    downloadImage: async () => {
      throw new WeixinFailure("Weixin image exceeds the 15 MiB inbound limit", "invalid_message");
    },
  });
  const adapter = await openWeixinAdapter({ ...paths, remote, retry: fastRetry() });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await eventually(() => inputs.some(input => input.sourceId === "sibling"));
  await eventually(() => cursors.includes("cursor-after-batch"));
  const status = adapter.status();
  assert.equal(status.state, "connected");
  assert.equal(status.lastError, undefined);
  assert.equal(status.ingress?.failed, 1);
  assert.equal(status.ingress?.retrying, 0);
  assert.equal(status.ingress?.lastFailureCategory, "invalid_message");
  assert.deepEqual(status.ingress?.failedItemIds, ["oversized"]);
  await adapter.stop();
});

test("holds the cursor and retries a transiently failing message until it succeeds", async t => {
  const paths = await weixinPaths();
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("retried-image", "utf8"),
  ]);
  const cursors: string[] = [];
  let downloads = 0;
  const remote = batchRemote({
    cursors,
    messages: [imageMessage("image-message", "image-retry")],
    downloadImage: async () => {
      downloads += 1;
      if (downloads === 1) throw new Error("Weixin image download returned HTTP 503");
      return { content: image, mediaType: "image/png", fileName: "retried.png" };
    },
  });
  const adapter = await openWeixinAdapter({ ...paths, remote, retry: fastRetry() });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await eventually(() => inputs.some(input => input.sourceId === "image-message"));
  await eventually(() => cursors.includes("cursor-after-batch"));
  assert.equal(downloads, 2);
  // A recovered message leaves no failed or retrying ingress behind.
  assert.equal(adapter.status().ingress, undefined);
  await adapter.stop();
});

test("gives up on a message that keeps failing transiently instead of wedging the channel", async t => {
  const paths = await weixinPaths();
  const cursors: string[] = [];
  const remote = batchRemote({
    cursors,
    messages: [imageMessage("image-message", "image-retry"), textMessage("sibling", "text that must still arrive")],
    downloadImage: async () => { throw new Error("Weixin image download returned HTTP 503"); },
  });
  const adapter = await openWeixinAdapter({ ...paths, remote, retry: fastRetry() });
  t.after(() => adapter.stop());
  const inputs: RuntimeInput[] = [];
  adapter.start(async input => {
    inputs.push(input);
    return { disposition: "accepted", inputId: `input-${input.sourceId}` };
  });

  await eventually(() => inputs.some(input => input.sourceId === "sibling"));
  await eventually(() => cursors.includes("cursor-after-batch"));
  const status = adapter.status();
  assert.equal(status.ingress?.failed, 1);
  assert.equal(status.ingress?.lastFailureCategory, "remote_unavailable");
  assert.deepEqual(status.ingress?.failedItemIds, ["image-message"]);
  await adapter.stop();
});

test("uses the server's long-poll timeout for the next poll", async t => {
  const paths = await weixinPaths();
  const timeouts: number[] = [];
  let polls = 0;
  const remote: WeixinRemote = {
    start: async () => {},
    async poll(request) {
      timeouts.push(request.timeoutMs);
      polls += 1;
      if (polls === 1) return { longpollTimeoutMs: 12_000, messages: [] };
      if (polls === 2) return { longpollTimeoutMs: 1, messages: [] };
      if (polls === 3) return { longpollTimeoutMs: 10 * 60_000, messages: [] };
      await aborted(request.signal);
      return { messages: [] };
    },
    downloadImage: async () => { throw new Error("no image expected"); },
    sendAttachment: async () => { throw new Error("no attachment expected"); },
    sendText: async () => ({ disposition: "sent", remoteId: "unused" }),
    typingTicket: async () => undefined,
    sendTyping: async () => {},
    stop: async () => {},
  };
  const adapter = await openWeixinAdapter({ ...paths, remote, retry: fastRetry() });
  t.after(() => adapter.stop());
  adapter.start(async () => ({ disposition: "accepted", inputId: "unused" }));

  await eventually(() => timeouts.length >= 4);
  assert.deepEqual(timeouts.slice(0, 4), [40_000, 12_000, 5_000, 60_000]);
  await adapter.stop();
});

test("backs off after repeated poll failures", async t => {
  const paths = await weixinPaths();
  const attempts: number[] = [];
  const remote: WeixinRemote = {
    start: async () => {},
    async poll() {
      attempts.push(Date.now());
      throw new Error("Weixin getupdates returned HTTP 500");
    },
    downloadImage: async () => { throw new Error("no image expected"); },
    sendAttachment: async () => { throw new Error("no attachment expected"); },
    sendText: async () => ({ disposition: "sent", remoteId: "unused" }),
    typingTicket: async () => undefined,
    sendTyping: async () => {},
    stop: async () => {},
  };
  const adapter = await openWeixinAdapter({
    ...paths,
    remote,
    retry: { reconnectMs: 10, failureBackoffMs: 250, sessionExpiredMs: 1_000 },
  });
  t.after(() => adapter.stop());
  adapter.start(async () => ({ disposition: "accepted", inputId: "unused" }));

  await eventually(() => attempts.length >= 5);
  await adapter.stop();
  const firstGap = attempts[1]! - attempts[0]!;
  const backedOffGap = attempts[4]! - attempts[3]!;
  assert.ok(firstGap < 150, `expected an immediate retry first, saw ${firstGap}ms`);
  assert.ok(backedOffGap >= 200, `expected backoff after repeated failures, saw ${backedOffGap}ms`);
});

test("waits for an expired bot session instead of hot-looping the poll", async t => {
  const paths = await weixinPaths();
  let polls = 0;
  const remote: WeixinRemote = {
    start: async () => {},
    async poll() {
      polls += 1;
      throw new WeixinFailure("getupdates rejected: ret=-14", "remote_unavailable", WEIXIN_SESSION_EXPIRED_CODE);
    },
    downloadImage: async () => { throw new Error("no image expected"); },
    sendAttachment: async () => { throw new Error("no attachment expected"); },
    sendText: async () => ({ disposition: "sent", remoteId: "unused" }),
    typingTicket: async () => undefined,
    sendTyping: async () => {},
    stop: async () => {},
  };
  const adapter = await openWeixinAdapter({
    ...paths,
    remote,
    retry: { reconnectMs: 5, failureBackoffMs: 5, sessionExpiredMs: 150 },
  });
  t.after(() => adapter.stop());
  adapter.start(async () => ({ disposition: "accepted", inputId: "unused" }));

  await eventually(() => polls >= 2);
  await new Promise<void>(resolve => setTimeout(resolve, 300));
  await adapter.stop();
  assert.ok(polls <= 5, `expected long waits between session-expired polls, saw ${polls} polls`);
  assert.match(adapter.status().lastError ?? "", /ret=-14/);
});

/** The same batch is replayed until the adapter acknowledges a cursor, like the remote does. */
function batchRemote(options: {
  cursors: string[];
  messages: WeixinRemoteMessage[];
  downloadImage: WeixinRemote["downloadImage"];
}): WeixinRemote {
  return {
    start: async () => {},
    async poll(request) {
      options.cursors.push(request.cursor);
      if (request.cursor !== "") {
        await aborted(request.signal);
        return { messages: [] };
      }
      return { cursor: "cursor-after-batch", messages: options.messages };
    },
    downloadImage: options.downloadImage,
    sendAttachment: async () => { throw new Error("no attachment expected"); },
    sendText: async () => ({ disposition: "sent", remoteId: "unused" }),
    typingTicket: async () => undefined,
    sendTyping: async () => {},
    stop: async () => {},
  };
}

function imageMessage(messageId: string, reference: string): WeixinRemoteMessage {
  return {
    messageId,
    from: "peer-1",
    messageType: "user",
    messageState: "finished",
    items: [{ type: "image", image: { encryptedQueryParam: reference, aesKey: `key-${reference}` } }],
  };
}

function textMessage(messageId: string, text: string): WeixinRemoteMessage {
  return {
    messageId,
    from: "peer-1",
    messageType: "user",
    messageState: "finished",
    items: [{ type: "text", text }],
  };
}

function fastRetry(): { reconnectMs: number; failureBackoffMs: number; sessionExpiredMs: number } {
  return { reconnectMs: 5, failureBackoffMs: 10, sessionExpiredMs: 10 };
}

function pollThenStopFailRemote(): WeixinRemote {
  let polls = 0;
  return {
    start: async () => {},
    poll: async () => {
      polls += 1;
      if (polls === 1) throw new Error("original poll failure");
      throw new Error("unexpected second poll");
    },
    downloadImage: async () => { throw new Error("no image expected"); },
    sendAttachment: async () => { throw new Error("no attachment expected"); },
    sendText: async () => ({ disposition: "sent", remoteId: "unused" }),
    typingTicket: async () => undefined,
    sendTyping: async () => {},
    stop: async () => { throw new Error("remote shutdown failed"); },
  };
}

function failingStopRemote(): WeixinRemote {
  let polls = 0;
  return {
    start: async () => {},
    poll: async request => {
      polls += 1;
      if (polls === 1) return { messages: [] };
      await aborted(request.signal);
      return { messages: [] };
    },
    downloadImage: async () => { throw new Error("no image expected"); },
    sendAttachment: async () => { throw new Error("no attachment expected"); },
    sendText: async () => ({ disposition: "sent", remoteId: "unused" }),
    typingTicket: async () => undefined,
    sendTyping: async () => {},
    stop: async () => { throw new Error("remote shutdown failed"); },
  };
}

function blockingRemote(options: {
  cursors: string[];
  firstPoll: Awaited<ReturnType<WeixinRemote["poll"]>>;
  sendText?: WeixinRemote["sendText"];
  downloadImage?: WeixinRemote["downloadImage"];
  sendAttachment?: WeixinRemote["sendAttachment"];
  typingTicket?: WeixinRemote["typingTicket"];
  sendTyping?: WeixinRemote["sendTyping"];
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
    downloadImage: options.downloadImage ?? (async () => { throw new Error("no image expected"); }),
    sendAttachment: options.sendAttachment ?? (async () => { throw new Error("no attachment expected"); }),
    sendText: options.sendText ?? (async () => ({ disposition: "sent", remoteId: "unused" })),
    typingTicket: options.typingTicket ?? (async () => "typing-ticket"),
    sendTyping: options.sendTyping ?? (async () => {}),
    stop: async () => {},
  };
}

test("stop failure does not overwrite an earlier poll failure", async t => {
  const paths = await weixinPaths();
  const adapter = await openWeixinAdapter({
    ...paths,
    remote: pollThenStopFailRemote(),
  });
  adapter.start(async () => ({ disposition: "accepted", inputId: "unused" }));
  await eventually(() => adapter.status().state === "degraded");
  assert.match(adapter.status().lastError ?? "", /original poll failure/);
  await adapter.stop();
  // The original poll failure keeps precedence; the failed notify-stop is
  // awaited but must not replace it.
  assert.equal(adapter.status().state, "stopped");
  assert.match(adapter.status().lastError ?? "", /original poll failure/);
  assert.doesNotMatch(adapter.status().lastError ?? "", /remote shutdown failed/);
});

test("stop awaits remote shutdown, records its failure, and still converges", async t => {
  const paths = await weixinPaths();
  const adapter = await openWeixinAdapter({
    ...paths,
    remote: failingStopRemote(),
  });
  adapter.start(async () => ({ disposition: "accepted", inputId: "unused" }));
  await eventually(() => adapter.status().state === "connected");
  await adapter.stop();
  // The failed notify-stop is awaited and recorded, not discarded; the adapter
  // still converges to stopped so the Host can proceed with channel teardown.
  assert.equal(adapter.status().state, "stopped");
  assert.match(adapter.status().lastError ?? "", /remote shutdown failed/);
});

async function weixinPaths(): Promise<{
  configurationFile: string;
  authFile: string;
  stateFile: string;
  attachmentStore: Awaited<ReturnType<typeof openAttachmentStore>>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-weixin-"));
  const configurationFile = path.join(root, "configuration", "channels", "weixin", "config.json");
  const authFile = path.join(root, "configuration", "channels", "weixin", "auth.json");
  const stateFile = path.join(root, "runtime", "channels", "weixin.db");
  const attachmentStoreRoot = path.join(root, "runtime", "attachments");
  const attachmentStore = await openAttachmentStore({ root: attachmentStoreRoot });
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
  return { configurationFile, authFile, stateFile, attachmentStore };
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}
