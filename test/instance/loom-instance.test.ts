import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLoomInstance } from "../../src/instance/index.js";
import { openAttachmentStore } from "../../src/integrations/attachments/index.js";
import { parseAttachmentReference } from "../../src/attachments/index.js";
import type { DeliveryAttemptRequest } from "../../src/runtime/index.js";

test("keeps accepted Input pending while blocked and resumes it after model configuration recovers", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  assert.equal(instance.status().models?.state, "blocked");
  assert.equal(instance.status().nmem, undefined);

  const accepted = await instance.acceptInput({
    source: "test-channel",
    sourceId: "blocked-input",
    kind: "interaction",
    payload: { text: "hello" },
  });

  assert.equal(accepted.disposition, "accepted");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "deferred",
    reason: "model_runtime_blocked",
    nextRunAt: "2026-07-22T10:00:30.000Z",
  });
  assert.equal(instance.status().models?.state, "blocked");
  assert.equal(instance.status().runtime.inputs[0]?.status, "pending");
  assert.equal(instance.status().runtime.turns.length, 0);

  const provider = await startOpenAiProvider({ text: "Recovered response" });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  now = new Date("2026-07-22T10:01:00.000Z");

  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:31:00.000Z",
  });
  assert.equal(instance.status().models?.state, "active");
  assert.equal(instance.status().runtime.inputs[0]?.status, "consumed");
  assert.equal(instance.status().runtime.turns[0]?.status, "completed");
});

test("retains Input attachment content until 30 days after the Input is consumed", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  let now = new Date("2026-07-01T00:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  const attachments = await openAttachmentStore({
    root: path.join(root, "runtime", "integrations", "attachments"),
    now: () => now,
  });
  t.after(() => attachments.close());
  const attachment = await attachments.put({
    kind: "image",
    mediaType: "image/png",
    content: Buffer.from("retained while pending", "utf8"),
  });
  await instance.acceptInput({
    source: "test-channel",
    sourceId: "attachment-input",
    kind: "interaction",
    payload: { attachments: [JSON.parse(JSON.stringify(attachment))] },
  });

  now = new Date("2026-08-15T00:00:00.000Z");
  await instance.runOnce(now);
  assert.equal((await attachments.read(attachment)).toString("utf8"), "retained while pending");

  const provider = await startOpenAiProvider({ text: "Observed the attachment metadata." });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  await instance.runOnce(now);
  assert.equal(instance.status().runtime.inputs[0]?.status, "consumed");

  now = new Date("2026-09-14T00:00:00.000Z");
  await instance.runOnce(now);
  await assert.rejects(attachments.read(attachment), /is unavailable/);
});

test("retains outbound attachment content while Delivery requires reconciliation", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  await mkdir(path.join(root, "workspace", "outbound"), { recursive: true });
  await writeFile(path.join(root, "workspace", "outbound", "note.txt"), "keep for delivery", "utf8");
  const provider = await startOpenAiProvider({
    tool: {
      name: "message",
      arguments: { action: "send", attachment_path: "outbound/note.txt" },
    },
  });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, "primary-route");
  let now = new Date("2026-07-01T00:00:00.000Z");
  const instance = await openLoomInstance({
    root,
    machineTimeZone: "UTC",
    now: () => now,
    outboundDelivery: {
      deliver: async () => ({ status: "unknown", error: "remote outcome unknown" }),
    },
  });
  let instanceClosed = false;
  t.after(() => { if (!instanceClosed) instance.close(); });
  const attachments = await openAttachmentStore({
    root: path.join(root, "runtime", "integrations", "attachments"),
    now: () => now,
  });
  t.after(() => attachments.close());

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "outbound-attachment-input",
    kind: "interaction",
    payload: { text: "send the note" },
  });
  await instance.runOnce(now);
  const effectPayload = instance.status().runtime.effects[0]?.payload as {
    attachments?: unknown[];
  };
  const attachment = parseAttachmentReference(effectPayload.attachments?.[0]);

  await instance.runOnce(now);
  assert.equal(instance.status().runtime.effects[0]?.status, "reconciliation_required");
  instance.close();
  instanceClosed = true;

  now = new Date("2026-08-15T00:00:00.000Z");
  await attachments.reconcileRetention({ activeAttachmentIds: [], observedAt: now });
  assert.equal((await attachments.read(attachment)).toString("utf8"), "keep for delivery");
});

test("refuses to open when Instance Configuration is malformed", async () => {
  const root = await createInstanceRoot();
  await writeFile(
    path.join(root, "configuration", "instance.yaml"),
    "version: [private malformed configuration",
    "utf8",
  );

  await assert.rejects(
    openLoomInstance({ root, machineTimeZone: "UTC" }),
    /Instance Configuration could not be read/,
  );
});

test("does not initialize missing Harness-owned Behavior materials while opening", async () => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const interaction = path.join(root, "workspace", "behavior", "interaction.md");
  await writeFile(interaction, "Existing individual interaction behavior.\n", "utf8");
  await rm(path.join(root, "workspace", "behavior", "background.md"));

  await assert.rejects(
    openLoomInstance({ root }),
    /Required Agent Workspace material behavior\/background\.md is missing/,
  );
  await assert.rejects(
    readFile(path.join(root, "workspace", "behavior", "background.md"), "utf8"),
    /ENOENT/,
  );
});

test("runs one Main Agent Turn through the assembled Instance", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider({ text: "A private response" });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "high");
  const now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  assert.equal(instance.status().models?.state, "active");

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "working-input",
    kind: "interaction",
    payload: { text: "hello" },
  });

  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });
  assert.equal(provider.requests(), 1);
  assert.equal(provider.bodies()[0]?.reasoning_effort, "high");
  assert.deepEqual(toolNames(provider.bodies()[0]!), [
    "attachment",
    "bash",
    "edit",
    "expand_tool_result",
    "find",
    "grep",
    "ls",
    "nmem_recall",
    "read",
    "write",
  ]);
  assert.equal(instance.status().runtime.inputs[0]?.status, "consumed");
  assert.equal(instance.status().runtime.turns[0]?.status, "completed");
});

test("refuses to open before model execution when Individual-owned materials are missing", async t => {
  const root = await createInstanceRoot();
  const provider = await startOpenAiProvider({ text: "must not run" });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);

  await assert.rejects(
    openLoomInstance({ root, machineTimeZone: "UTC" }),
    /Required Agent Workspace material .* is missing/,
  );

  assert.equal(provider.requests(), 0);
});

test("binds message Effects to the configured default Interaction Route", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider({
    tool: {
      name: "message",
      arguments: { action: "send", text: "A visible message" },
    },
  });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, "primary-route");
  const now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "message-input",
    kind: "interaction",
    payload: { text: "say hello" },
  });
  await instance.runOnce(now);

  assert.equal(provider.requests(), 1);
  assert.deepEqual(instance.status().runtime.effects.map(effect => ({
    kind: effect.kind,
    payload: effect.payload,
    routeRef: effect.routeRef,
    status: effect.status,
  })), [{
    kind: "message",
    payload: { text: "A visible message" },
    routeRef: "primary-route",
    status: "pending",
  }]);
});

test("delivers persisted Effects while cold-start model configuration is blocked", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider({
    tool: {
      name: "message",
      arguments: { action: "send", text: "Deliver after restart" },
    },
  });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, "primary-route");
  const now = new Date("2026-07-22T10:00:00.000Z");
  const first = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "delivery-input",
    kind: "interaction",
    payload: { text: "send it" },
  });
  await first.runOnce(now);
  assert.equal(first.status().runtime.effects[0]?.status, "pending");
  first.close();

  await writeFile(path.join(root, "configuration", "instance.yaml"), [
    "version: 1",
    "interaction:",
    "  defaultRoute: primary-route",
    "models:",
    "  default:",
    "    - provider: local-test",
    "      model: missing-model",
    "",
  ].join("\n"), "utf8");
  const delivered: DeliveryAttemptRequest[] = [];
  const second = await openLoomInstance({
    root,
    machineTimeZone: "UTC",
    now: () => now,
    outboundDelivery: {
      deliver: async request => {
        delivered.push(request);
        return { status: "delivered", remoteId: "remote-1" };
      },
    },
  });
  t.after(() => second.close());

  await second.runOnce(now);

  assert.equal(second.status().models?.state, "blocked");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.routeRef, "primary-route");
  assert.equal(second.status().runtime.effects[0]?.status, "completed");
  assert.equal(second.status().runtime.deliveries[0]?.status, "delivered");
});

test("continues five minutes after confirmed Delivery through the assembled Instance", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "message", arguments: { action: "send", text: "A visible reply" } } },
    body => {
      const context = JSON.stringify(body);
      assert.match(context, /<after_chat_continuation>/);
      assert.match(context, /confirmed delivered 5 minutes ago/);
      assert.match(context, /Do not manufacture a follow-up/);
      return { tool: { name: "message", arguments: { action: "no_reply" } } };
    },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, "primary-route");
  let now = new Date("2026-07-22T10:00:00.000Z");
  const delivered: DeliveryAttemptRequest[] = [];
  const instance = await openLoomInstance({
    root,
    machineTimeZone: "UTC",
    now: () => now,
    outboundDelivery: {
      deliver: async request => {
        delivered.push(request);
        return { status: "delivered", remoteId: `remote-${delivered.length}` };
      },
    },
  });
  t.after(() => instance.close());

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "after-chat-input",
    kind: "interaction",
    payload: { text: "say something" },
  });
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:05:00.000Z",
  });
  const segment = instance.status().runtime.activeSegment;
  assert.ok(segment);
  assert.equal(delivered.length, 1);
  assert.equal(instance.status().runtime.afterChatContinuation?.status, "pending");

  now = new Date("2026-07-22T10:05:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });
  assert.equal(provider.requests(), 2);
  assert.equal(delivered.length, 1);
  assert.equal(instance.status().runtime.activeSegment?.id, segment.id);
  assert.equal(instance.status().runtime.activeSegment?.lastActivityAt, "2026-07-22T10:00:00.000Z");
  assert.equal(instance.status().runtime.afterChatContinuation?.status, "completed");
});

test("freezes idle Activity but defers Life Recorder work while models are blocked", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { text: "A private response" },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Activity is settled.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const first = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "pending-recorder-input",
    kind: "interaction",
    payload: { text: "keep this activity" },
  });
  await first.runOnce(now);
  first.close();

  await writeFile(path.join(root, "configuration", "instance.yaml"), [
    "version: 1",
    "models:",
    "  default:",
    "    - provider: local-test",
    "      model: missing-model",
    "",
  ].join("\n"), "utf8");
  now = new Date("2026-07-22T10:30:00.000Z");
  const recovered = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => recovered.close());

  assert.deepEqual(await recovered.runOnce(now), {
    disposition: "deferred",
    reason: "model_runtime_blocked",
    nextRunAt: "2026-07-22T10:30:30.000Z",
  });
  assert.equal(provider.requests(), 1);
  assert.equal(recovered.status().runtime.activeSegment, undefined);
  assert.equal(recovered.status().runtime.activities[0]?.status, "pending");
  assert.equal(recovered.status().runtime.activities[0]?.attempts, 0);

  await writeModelConfiguration(root, provider.baseUrl);

  assert.deepEqual(await recovered.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(provider.requests(), 5);
  assert.equal(recovered.status().runtime.activities[0]?.status, "recorded");
});

test("records a closed Activity through a revision-bound Life Recorder", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { text: "A private response" },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Activity is settled.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  await instance.acceptInput({
    source: "test-channel",
    sourceId: "recorded-input",
    kind: "interaction",
    payload: { text: "remember this moment" },
  });
  await instance.runOnce(now);

  now = new Date("2026-07-22T10:30:00.000Z");
  await instance.runOnce(now);

  assert.equal(provider.requests(), 5);
  assert.equal(instance.status().runtime.activeSegment, undefined);
  assert.equal(instance.status().runtime.activities[0]?.status, "recorded");
  assert.equal(instance.status().runtime.activities[0]?.receipt?.segmentId, instance.status().runtime.activities[0]?.id);
  assert.equal(instance.status().runtime.activities[0]?.receipt?.recordedAt, "2026-07-22T10:30:00.000Z");
  assert.deepEqual(instance.status().runtime.threadMaintenance, []);
});

test("reflects a completed logical day through the assembled Instance", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  await mkdir(path.join(root, "workspace", "daily"), { recursive: true });
  await writeFile(path.join(root, "workspace", "daily", "2026-07-22.md"), "A day worth carrying.\n", "utf8");
  const provider = await startOpenAiProvider(
    { text: "A day worth carrying." },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
    { tool: { name: "read", arguments: { path: "facts.json" } } },
    { tool: { name: "read", arguments: { path: "identity.md" } } },
    { tool: { name: "read", arguments: { path: "memory.md" } } },
    { tool: { name: "read", arguments: { path: "behavior/interaction.md" } } },
    { tool: { name: "read", arguments: { path: "behavior/background.md" } } },
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { tool: { name: "read", arguments: { path: "daily/2026-07-22.md" } } },
    { text: "NO_CHANGE" },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "medium", {
    intervalMinutes: 2_000,
    quietIntervalMinutes: 2_000,
    attentionIntervalMinutes: 2_000,
    reflectionDelayMinutes: 15,
  }, { "memory-reflector": "max" });
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "reflection-input",
    kind: "interaction",
    payload: { text: "remember the shape of today" },
  });
  await instance.runOnce(now);
  now = new Date("2026-07-22T10:30:00.000Z");
  await instance.runOnce(now);
  assert.equal(instance.status().runtime.activities[0]?.status, "recorded");

  now = new Date("2026-07-23T03:15:00.000Z");
  await instance.runOnce(now);
  assert.equal(provider.requests(), 11);
  assert.equal(provider.bodies()[3]?.reasoning_effort, "max");
  assert.equal(instance.status().runtime.memoryReflection?.lastCompletedDay, "2026-07-22");
  assert.equal(instance.status().runtime.memoryReflection?.lastResult?.outcome, "no_change");
  assert.equal(instance.status().runtime.memoryReflection?.nextDay, "2026-07-23");
});

test("maintains changed Thread material through the assembled Instance", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  await mkdir(path.join(root, "workspace", "threads"), { recursive: true });
  await writeFile(path.join(root, "workspace", "threads", "index.md"), "# Threads\n", "utf8");
  const provider = await startOpenAiProvider(
    { tool: { name: "write", arguments: {
      path: "threads/garden/thread.md",
      content: "# Garden\n\nA living line.\n",
    } } },
    { text: "The private line has a place now." },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
    { tool: { name: "read", arguments: { path: "index.md" } } },
    { tool: { name: "read", arguments: { path: "garden/thread.md" } } },
    body => {
      const reference = JSON.stringify(body).match(/Reference ID: (evidence-[A-Za-z0-9-]+)/)?.[1];
      assert.ok(reference);
      return { tool: { name: "read_thread_activity", arguments: {
        referenceId: reference,
        offset: 0,
        limit: 200,
      } } };
    },
    { text: "NO_CHANGE" },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "medium", {
    intervalMinutes: 60,
    quietIntervalMinutes: 90,
  }, { "thread-maintainer": "max" });
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  await instance.acceptInput({
    source: "test-channel",
    sourceId: "thread-input",
    kind: "interaction",
    payload: { text: "continue the garden line" },
  });
  await instance.runOnce(now);

  now = new Date("2026-07-22T10:30:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(provider.requests(), 8);
  assert.equal(provider.bodies()[4]?.reasoning_effort, "max");
  assert.equal(instance.status().runtime.activities[0]?.status, "recorded");
  assert.equal(instance.status().runtime.threadMaintenance[0]?.status, "completed");
  assert.equal(instance.status().runtime.threadMaintenance[0]?.attempts, 1);
  assert.equal(instance.status().runtime.threadMaintenance[0]?.result?.outcome, "no_change");

  await instance.runOnce(now);
  assert.equal(provider.requests(), 8);
});

test("reconciles nmem Thread and Episode projections after local Activity work", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { text: "A private response worth keeping." },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    body => {
      const eventId = frozenActivityEventId(body);
      assert.ok(eventId);
      return { tool: { name: "record_episode", arguments: {
        ordinal: 0,
        title: "A useful distinction remained",
        occurredAt: "2026-07-22T10:00:00.000Z",
        importance: 0.7,
        labels: ["calibration"],
        scene: "The exchange kept one useful distinction available for later.",
        evidenceEventIds: [eventId],
      } } };
    },
    { text: "Recorded." },
  );
  t.after(() => provider.close());
  const nmem = await startNmemProjectionServer();
  t.after(() => nmem.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "medium", {
    intervalMinutes: 60,
    quietIntervalMinutes: 90,
  });
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({
    root,
    machineTimeZone: "UTC",
    now: () => now,
    nmem: { endpoint: nmem.baseUrl },
  });
  t.after(() => instance.close());
  await instance.acceptInput({
    source: "test-channel",
    sourceId: "nmem-projection-input",
    kind: "interaction",
    payload: { text: "keep the useful distinction" },
  });
  await instance.runOnce(now);

  const frozen = instance.status().runtime.activeSegment;
  assert.ok(frozen);
  now = new Date("2026-07-22T10:30:00.000Z");
  await instance.runOnce(now);

  assert.equal(nmem.threadRequests(), 1);
  assert.equal(nmem.memoryRequests(), 1);
  assert.deepEqual(instance.status().nmem?.threads.summary, {
    current: 1,
    pending: 0,
    blocked: 0,
  });
  assert.deepEqual(instance.status().nmem?.episodes.summary, {
    current: 1,
    pending: 0,
    blocked: 0,
  });

  await instance.runOnce(now);
  assert.equal(nmem.threadRequests(), 1);
  assert.equal(nmem.memoryRequests(), 1);
});

test("keeps nmem projection failure-soft and resumes it after restart backoff", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { text: "A local response remains available." },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
  );
  t.after(() => provider.close());
  const nmem = await startNmemProjectionServer({ failThreadRequests: 1 });
  t.after(() => nmem.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "medium", {
    intervalMinutes: 60,
    quietIntervalMinutes: 90,
  });
  let now = new Date("2026-07-22T12:00:00.000Z");
  const first = await openLoomInstance({
    root,
    machineTimeZone: "UTC",
    now: () => now,
    nmem: { endpoint: nmem.baseUrl },
  });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "nmem-retry-input",
    kind: "interaction",
    payload: { text: "keep local continuity" },
  });
  await first.runOnce(now);
  now = new Date("2026-07-22T12:30:00.000Z");
  assert.deepEqual(await first.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T12:30:30.000Z",
  });
  assert.equal(nmem.threadRequests(), 1);
  assert.equal(first.status().nmem?.threads.summary.pending, 1);
  assert.match(first.status().nmem?.threads.items[0]?.lastError ?? "", /temporarily unavailable/i);
  assert.equal(first.status().runtime.activities[0]?.status, "recorded");
  first.close();

  now = new Date("2026-07-22T12:30:10.000Z");
  const recovered = await openLoomInstance({
    root,
    machineTimeZone: "UTC",
    now: () => now,
    nmem: { endpoint: nmem.baseUrl },
  });
  t.after(() => recovered.close());
  await recovered.runOnce(now);
  assert.equal(nmem.threadRequests(), 1);
  assert.equal(recovered.status().nmem?.threads.summary.pending, 1);

  now = new Date("2026-07-22T12:30:31.000Z");
  await recovered.runOnce(now);
  assert.equal(nmem.threadRequests(), 2);
  assert.deepEqual(recovered.status().nmem?.threads.summary, {
    current: 1,
    pending: 0,
    blocked: 0,
  });
  assert.equal(recovered.status().nmem?.threads.items[0]?.attempts, 2);
  assert.equal(recovered.status().nmem?.threads.items[0]?.lastError, undefined);
});

test("forms a proactive opening through a revision-bound Orientation", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({
      outcome: "none",
      whyNow: "Nothing currently warrants an opening.",
      evidence: ["attention.md contains one quiet curiosity"],
    }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  const now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  const result = await instance.formOpportunity();

  assert.equal(result.disposition, "none");
  assert.equal(provider.requests(), 2);
  assert.equal(instance.status().runtime.inputs.length, 0);
});

test("keeps the first proactive Pulse delayed until the ordinary cadence", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({
      outcome: "none",
      whyNow: "Nothing currently warrants an opening.",
      evidence: ["attention.md contains one quiet curiosity"],
    }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });
  assert.equal(provider.requests(), 0);

  now = new Date("2026-07-22T10:29:59.999Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });
  assert.equal(provider.requests(), 0);

  now = new Date("2026-07-22T10:30:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(provider.requests(), 2);
});

test("uses the quiet-hours cadence from the Instance time policy", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Quiet.", evidence: ["attention read"] }) },
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { tool: { name: "read", arguments: { path: "memory.md" } } },
    { text: "NO_CHANGE" },
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Morning.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "medium", undefined, {
    "attention-maintainer": "high",
  });
  let now = new Date("2026-07-22T00:45:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  await instance.runOnce(now);
  now = new Date("2026-07-22T01:15:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T02:45:00.000Z",
  });

  now = new Date("2026-07-22T07:15:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T07:45:00.000Z",
  });
  assert.equal(provider.requests(), 7);
  assert.equal(provider.bodies()[2]?.reasoning_effort, "high");
});

test("applies an explicit proactive Pulse cadence when opening the Instance", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Nothing now.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "medium", {
    intervalMinutes: 45,
    quietIntervalMinutes: 120,
  });
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:45:00.000Z",
  });
  now = new Date("2026-07-22T10:45:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:30:00.000Z",
  });
  assert.equal(provider.requests(), 2);
});

test("persists a completed Pulse schedule across Instance restart", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Still quiet.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const first = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  await first.runOnce(now);
  now = new Date("2026-07-22T10:30:00.000Z");
  await first.runOnce(now);
  first.close();

  now = new Date("2026-07-22T10:45:00.000Z");
  const recovered = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => recovered.close());

  assert.deepEqual(await recovered.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(provider.requests(), 2);
  assert.equal(recovered.status().runtime.proactivePulse?.lastPulseAt, "2026-07-22T10:30:00.000Z");
});

test("continues an admitted Pulse Opportunity through the Main Agent lifecycle", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({
      outcome: "opportunity",
      narrative: "The garden question may still have some life in it.",
      whyNow: "It remains in current attention.",
      evidence: ["attention read"],
    }) },
    { text: "The Individual lets the opening pass quietly." },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  await instance.runOnce(now);

  now = new Date("2026-07-22T10:30:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(provider.requests(), 3);
  assert.equal(instance.status().runtime.inputs[0]?.kind, "opportunity");
  assert.equal(instance.status().runtime.inputs[0]?.status, "consumed");
  assert.equal(instance.status().runtime.turns[0]?.status, "completed");
});

test("retries a failed Orientation Pulse from its persisted due time", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: "not a valid Orientation result" },
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Recovered.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const first = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  await first.runOnce(now);

  now = new Date("2026-07-22T10:30:00.000Z");
  const failed = await first.runOnce(now);
  assert.equal(failed.disposition, "deferred");
  assert.equal("reason" in failed ? failed.reason : undefined, "orientation_failed");
  assert.equal(first.status().runtime.proactivePulse?.consecutiveFailures, 1);
  assert.equal(first.status().runtime.proactivePulse?.nextPulseAfter, "2026-07-22T10:35:00.000Z");
  first.close();

  now = new Date("2026-07-22T10:35:00.000Z");
  const recovered = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:05:00.000Z",
  });
  assert.equal(recovered.status().runtime.proactivePulse?.consecutiveFailures, 0);
  assert.equal(recovered.status().runtime.proactivePulse?.lastError, undefined);
});

test("keeps a due Pulse behind an open Activity until the Activity closes", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { text: "A private response" },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Activity is settled.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  await instance.acceptInput({
    source: "test-channel",
    sourceId: "pulse-behind-activity",
    kind: "interaction",
    payload: { text: "hello" },
  });

  await instance.runOnce(now);
  now = new Date("2026-07-22T10:29:59.999Z");
  assert.equal((await instance.runOnce(now)).disposition, "waiting");
  assert.equal(provider.requests(), 1);

  now = new Date("2026-07-22T10:30:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(provider.requests(), 5);
  assert.equal(instance.status().runtime.activeSegment, undefined);
});

test("keeps a due Pulse unclaimed while model configuration is blocked", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  await instance.runOnce(now);
  now = new Date("2026-07-22T10:30:00.000Z");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "deferred",
    reason: "model_runtime_blocked",
    nextRunAt: "2026-07-22T10:30:30.000Z",
  });
  assert.equal(instance.status().runtime.proactivePulse?.lastPulseAt, undefined);
  assert.equal(instance.status().runtime.proactivePulse?.nextPulseAfter, "2026-07-22T10:30:00.000Z");

  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({ outcome: "none", whyNow: "Recovered.", evidence: ["attention read"] }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);

  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal(provider.requests(), 2);
});

async function createInstanceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-instance-"));
  await mkdir(path.join(root, "configuration", "pi"), { recursive: true });
  return root;
}

async function writeIndividualMaterials(root: string): Promise<void> {
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }), "utf8"),
    writeFile(path.join(workspace, "identity.md"), "Rowan is a continuing AI Individual.\n", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "Rowan and Alex are getting to know each other.\n", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Rowan is curious about Alex's garden.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "interaction.md"), "Respond as Rowan in direct interaction.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "background.md"), "Use background time as Rowan's own.\n", "utf8"),
  ]);
}

async function writeModelConfiguration(
  root: string,
  baseUrl: string,
  defaultRoute?: string,
  thinkingLevel = "medium",
  schedule?: {
    intervalMinutes: number;
    quietIntervalMinutes: number;
    attentionIntervalMinutes?: number;
    reflectionDelayMinutes?: number;
  },
  roleThinkingLevels?: Partial<Record<
    "attention-maintainer" | "thread-maintainer" | "memory-reflector",
    "high" | "max"
  >>,
): Promise<void> {
  const configurationRoot = path.join(root, "configuration");
  await writeFile(path.join(configurationRoot, "instance.yaml"), [
    "version: 1",
    ...(defaultRoute ? ["interaction:", `  defaultRoute: ${defaultRoute}`] : []),
    ...(schedule ? [
      "schedule:",
      "  proactivePulse:",
      `    intervalMinutes: ${schedule.intervalMinutes}`,
      "    quietHours:",
      "      start: \"01:00\"",
      "      end: \"07:00\"",
      `      intervalMinutes: ${schedule.quietIntervalMinutes}`,
      ...(schedule.attentionIntervalMinutes !== undefined ? [
        "  attentionMaintenance:",
        `    intervalMinutes: ${schedule.attentionIntervalMinutes}`,
      ] : []),
      ...(schedule.reflectionDelayMinutes !== undefined ? [
        "  memoryReflection:",
        `    delayMinutes: ${schedule.reflectionDelayMinutes}`,
      ] : []),
    ] : []),
    "models:",
    "  default:",
    "    - provider: local-test",
    "      model: local-model",
    `      thinkingLevel: ${thinkingLevel}`,
    ...Object.entries(roleThinkingLevels ?? {}).flatMap(([role, level]) => [
      `  ${role}:`,
      "    - provider: local-test",
      "      model: local-model",
      `      thinkingLevel: ${level}`,
    ]),
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(configurationRoot, "pi", "models.json"), JSON.stringify({
    providers: {
      "local-test": {
        name: "Local Test",
        baseUrl,
        apiKey: "test-key",
        api: "openai-completions",
        models: [{
          id: "local-model",
          name: "Local Model",
          reasoning: true,
          thinkingLevelMap: { max: "max" },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 16_384,
        }],
      },
    },
  }), "utf8");
}

type ProviderResponse =
  | { text: string }
  | { tool: { name: string; arguments: Record<string, unknown> } }
  | ((body: Record<string, unknown>) => Exclude<ProviderResponse, Function>);

async function startOpenAiProvider(...providerResponses: ProviderResponse[]): Promise<{
  baseUrl: string;
  requests(): number;
  bodies(): Array<Record<string, unknown>>;
  close(): void;
}> {
  let requestCount = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const configuredResponse = providerResponses[requestCount] ?? providerResponses.at(-1);
      assert.ok(configuredResponse);
      const providerResponse = typeof configuredResponse === "function"
        ? configuredResponse(requestBodies.at(-1)!)
        : configuredResponse;
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      const delta = "text" in providerResponse
        ? { role: "assistant", content: providerResponse.text }
        : {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: `call-${requestCount + 1}`,
              type: "function",
              function: {
                name: providerResponse.tool.name,
                arguments: JSON.stringify(providerResponse.tool.arguments),
              },
            }],
          };
      response.write(`data: ${JSON.stringify({
        id: "completion-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "completion-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-model",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "text" in providerResponse ? "stop" : "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requestCount,
    bodies: () => structuredClone(requestBodies),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function startNmemProjectionServer(options: {
  failThreadRequests?: number;
} = {}): Promise<{
  baseUrl: string;
  threadRequests(): number;
  memoryRequests(): number;
  close(): void;
}> {
  let threads = 0;
  let memories = 0;
  let remainingThreadFailures = options.failThreadRequests ?? 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        version: "0.10.31",
        features: { threads: true, memories: true, search: true },
      }));
      return;
    }
    const body = await readRequestJson(request);
    if (request.url === "/threads" && request.method === "POST") {
      threads += 1;
      if (remainingThreadFailures > 0) {
        remainingThreadFailures -= 1;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "temporarily unavailable" }));
        return;
      }
      const threadId = String((body as { thread_id?: unknown }).thread_id ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ thread: { thread_id: threadId } }));
      return;
    }
    if (request.url === "/memories" && request.method === "POST") {
      memories += 1;
      const memoryId = String((body as { id?: unknown }).id ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ memory: { id: memoryId } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    threadRequests: () => threads,
    memoryRequests: () => memories,
    close: () => server.close(),
  };
}

async function readRequestJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function frozenActivityEventId(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && "type" in parsed
        && parsed.type === "loom.frozen-activity.page" && "events" in parsed
        && Array.isArray(parsed.events)) {
        const event = parsed.events[0];
        return event && typeof event === "object" && "eventId" in event
          ? String(event.eventId)
          : undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const eventId = frozenActivityEventId(item);
      if (eventId) return eventId;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const eventId = frozenActivityEventId(item);
      if (eventId) return eventId;
    }
  }
  return undefined;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  assert.ok(Array.isArray(tools));
  return tools.map(tool => {
    assert.ok(tool && typeof tool === "object" && "function" in tool);
    const definition = (tool as { function: unknown }).function;
    assert.ok(definition && typeof definition === "object" && "name" in definition);
    return String((definition as { name: unknown }).name);
  }).sort();
}
