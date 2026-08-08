import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openLoomHost } from "../../src/host/index.js";
import { initializeLoomInstance } from "../../src/instance/index.js";
import { openRuntime } from "../../src/runtime/index.js";
import { createTimePolicy } from "../../src/configuration/index.js";
import { COGNITIVE_ORGAN_POLICY } from "../../src/runtime/cognitive-organ-execution.js";

test("initializes the default ~/.loom Instance through the foreground CLI", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-cli-init-"));
  const root = path.join(parent, ".loom");
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

  const child = spawn(process.execPath, [cli, "init", "--channel", "weixin", "--channel", "weixin"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: parent },
  });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const [code, signal] = await once(child, "exit");

  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.deepEqual(JSON.parse(stdout), {
    event: "instance.initialized",
    root,
    createdFiles: [
      "configuration/instance.yaml",
      "workspace/behavior/interactivity.md",
      "workspace/behavior/proactivity.md",
    ],
    requiredIndividualMaterials: [
      { path: "workspace/facts.json" },
      { path: "workspace/identity.md" },
      { path: "workspace/memory.md" },
      { path: "workspace/attention.md" },
    ],
  });
  assert.match(
    await readFile(path.join(root, "workspace", "behavior", "proactivity.md"), "utf8"),
    /Proactivity time belongs to the Agent Individual/,
  );
});

test("requires an explicit --channel for init and rejects unknown channels", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-cli-init-usage-"));
  const root = path.join(parent, ".loom");
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

  const missing = await runCli(cli, ["init"], { ...process.env, HOME: parent });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /Usage: loom init/);

  const unknown = await runCli(cli, ["init", "--channel", "slack"], { ...process.env, HOME: parent });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Usage: loom init/);
  await assert.rejects(access(root));
});

test("reports an unavailable Host as structured status without opening Instance state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "loom-cli-status-"));
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const result = await runCli(cli, ["status", "--json"], { ...process.env, HOME: home });

  assert.equal(result.code, 1, result.stderr);
  const status = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(status.schemaVersion, 1);
  assert.match(String(status.observedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(status.host, { state: "unavailable" });
  assert.deepEqual(status.agents, []);
  assert.deepEqual(status.integrations, []);
  assert.equal(result.stderr, "");

  const human = await runCli(cli, ["status"], { ...process.env, HOME: home });
  assert.equal(human.code, 1);
  assert.equal(human.stdout.trim(), "Loom Host unavailable");
  assert.equal(human.stderr, "");
});

test("rejects an invalid status history timestamp before contacting the Host", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "loom-cli-status-since-"));
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const result = await runCli(cli, ["status", "--json", "--since", "yesterday"], {
    ...process.env,
    HOME: home,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage: loom status/);
});

test("requeues one blocked Input through the running Host", async t => {
  const root = await preparedInstanceRoot();
  const runtime = openRuntime({
    root: path.join(root, "runtime"),
    execution: {
      start(request, control) {
        control.prepareExecutionState({ version: 1 });
        control.includeInput(request.inputs[0]!.id);
        return {
          result: Promise.reject(new Error("provider failed")),
          steer: async () => {},
          abort: async () => {},
        };
      },
    },
  });
  const accepted = await runtime.acceptInput({
    source: "test",
    sourceId: "blocked-input",
    kind: "interaction",
    payload: { text: "retry after repair" },
  });
  await assert.rejects(runtime.advance(), /provider failed/);
  runtime.close();

  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

  const result = await runCli(cli, ["requeue", "--root", root, accepted.inputId], process.env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Requeued Input ${accepted.inputId}`);
  assert.equal(
    host.status().instance.runtime.inputs.find(input => input.id === accepted.inputId)?.status,
    "pending",
  );
});

test("requeues one held Cognitive Organ work through the running Host", async t => {
  const root = await preparedInstanceRoot();
  let now = new Date("2026-07-19T12:00:00.000Z");
  const attentionHang: { promise: Promise<{ outcome: "no_change"; runId: string; path: string }>; resolve: () => void } = {
    promise: new Promise(() => {}),
    resolve: () => {},
  };
  let resolveStarted!: () => void;
  const attentionStarted = new Promise<void>(resolve => { resolveStarted = resolve; });
  const runtime = openRuntime({
    root: path.join(root, "runtime"),
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: {
      start(request, control) {
        control.prepareExecutionState({ version: 1 });
        control.includeInput(request.inputs[0]!.id);
        return {
          result: Promise.resolve({
            outcome: "completed",
            inputAnchors: request.inputs.map(input => ({
              inputId: input.id,
              transcriptAnchor: {
                sourceId: request.recordingDay,
                sessionId: "session-1",
                entryId: `input-${input.id}`,
              },
            })),
            transcriptAnchor: {
              sourceId: request.recordingDay,
              sessionId: "session-1",
              entryId: `entry-${request.turnId}`,
            },
            executionState: { version: 1, turnId: request.turnId },
            executionRecord: { version: 1, turnId: request.turnId },
          }),
          steer: async () => {},
          abort: async () => {},
        };
      },
    },
    activityLifecycle: {
      freeze: async request => ({
        activity: {
          version: 1,
          segmentId: request.segment.id,
          recordingDay: request.segment.recordingDay,
          openedAt: request.segment.openedAt,
          closedAt: request.segment.closedAt,
          events: [],
          turns: [],
        },
        successorExecutionState: { version: 1 },
      }),
    },
    activityRecorder: {
      record: async activity => ({
        version: 1,
        segmentId: activity.segmentId,
        runId: "record-day-one",
        recordedAt: "2026-07-19T12:00:00.000Z",
        daily: { status: "no_change", path: "daily/2026-07-19.md" },
        episodes: [],
      }),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        resolveStarted();
        return attentionHang.promise;
      },
      cancel: async () => {},
    },
    cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 50 },
    now: () => now,
  });

  await runtime.acceptInput({
    source: "test",
    sourceId: "day-one",
    kind: "interaction",
    payload: { text: "day one" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  assert.deepEqual(
    await runtime.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "waiting", nextRunAt: "2026-07-19T12:00:00.001Z" },
  );
  now = new Date("2026-07-19T12:00:01.000Z");
  const heldRun = runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  await attentionStarted;
  // The human input preempts the held organ; its cancel is ignored, so the
  // grace expiry persists intervention_required in the ledger.
  await runtime.acceptInput({
    source: "test",
    sourceId: "human-while-held",
    kind: "interaction",
    payload: { text: "please answer" },
  });
  runtime.close();
  // heldRun intentionally stays unsettled: the organ never released.

  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());
  await host.start();
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

  // The Host status exposes the discoverable local work id.
  const held = host.status().instance.runtime.cognitiveOrganWork
    .find(work => work.organ === "attention-maintainer")!;
  assert.match(held.workId, /^attention-maintainer-\d+$/);
  assert.equal(held.status, "intervention_required");

  const result = await runCli(cli, ["requeue-organ", "--root", root, held.workId], process.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Requeued Cognitive Organ work ${held.workId}`);

  // The successor is the current cycle, referencing the held work by its local id.
  const successor = host.status().instance.runtime.cognitiveOrganWork
    .find(work => work.organ === "attention-maintainer")!;
  assert.equal(successor.status, "running");
  assert.equal(successor.attemptCount, 1);
  assert.equal(successor.requeuedFrom, held.workId);

  // Human status output shows the current cycle (the held record is history
  // after the requeue) with local ids only, never raw error text.
  const status = await runCli(cli, ["status", "--root", root], process.env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Cognitive Organ Work:/);
  assert.match(
    status.stdout,
    new RegExp(`attention-maintainer-\\d+: running, attempt 1, requeued from ${held.workId}`),
  );
  // The running successor also shows its per-attempt soft deadline, but no
  // transcript or result reference yet.
  assert.match(status.stdout, /soft deadline \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(status.stdout, /transcript organs\/attention-maintainer/);
  assert.doesNotMatch(status.stdout, /lastError/);

  // Unknown and missing ids fail with a clear message before touching anything.
  const unknown = await runCli(cli, ["requeue-organ", "--root", root, "attention-maintainer-999999"], process.env);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown cognitive organ work attention-maintainer-999999/);
  const missing = await runCli(cli, ["requeue-organ", "--root", root], process.env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Usage: loom requeue-organ/);
});

test("runs one prepared Instance until a termination signal requests graceful stop", async t => {
  const root = await preparedInstanceRoot();
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "run", "--root", root], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  await waitForOutput(child, () => stdout.includes('"event":"host.started"'), () => stderr);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await exited;

  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.match(stdout, /"event":"host\.stopped"/);
  assert.match(stdout, /"event":"model\.runtime"/);
  assert.match(stdout, /"event":"channel\.state"/);
  assert.match(stdout, /"event":"driver\.run\.started"/);
  assert.match(stdout, /"event":"driver\.run\.completed"/);
});

test("chats through the running Weixin channel and rebuilds history in another client", async t => {
  const channel = await startWeixinChannel("hello from the human");
  t.after(() => channel.close());
  const home = await mkdtemp(path.join(tmpdir(), "loom-cli-home-"));
  const root = await preparedInstanceRoot(path.join(home, ".loom"));
  await writeWeixinChannel(root, channel.baseUrl);
  await writeModelConfiguration(root, channel.modelBaseUrl);
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const env = { ...process.env, HOME: home };
  const host = spawn(process.execPath, [cli, "run"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  host.stdin.end();
  let hostStdout = "";
  let hostStderr = "";
  host.stdout.on("data", chunk => { hostStdout += String(chunk); });
  host.stderr.on("data", chunk => { hostStderr += String(chunk); });
  t.after(() => {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
  });
  await waitForOutput(host, () => hostStdout.includes('"event":"host.started"'), () => hostStderr);

  await waitForOutput(
    host,
    () => channel.received.includes("hello through Loom"),
    () => hostStderr,
  );
  for (const event of [
    "model.runtime",
    "channel.state",
    "runtime.transition",
    "driver.run.started",
    "driver.run.completed",
    "agent.tool.started",
    "agent.tool.completed",
  ]) {
    assert.match(hostStdout, new RegExp(`"event":"${event.replaceAll(".", "\\.")}"`));
  }
  assert.doesNotMatch(hostStdout, /hello from the human|hello through Loom/);

  const history = await runCli(cli, ["history"], env);
  assert.equal(history.code, 0, history.stderr);
  assert.match(history.stdout, /human \[weixin\]: hello from the human/);
  assert.match(history.stdout, /individual \[weixin\]: hello through Loom/);

  const statusJson = await runCli(cli, [
    "status",
    "--json",
    "--since",
    "2026-01-01T00:00:00.000Z",
  ], env);
  assert.equal(statusJson.code, 0, statusJson.stderr);
  const status = JSON.parse(statusJson.stdout) as {
    host: { state: string };
    agents: Array<{ name: string; state: string; history?: unknown[] }>;
    channels: Array<{ name: string; state: string }>;
    integrations: Array<{ name: string; state: string }>;
  };
  assert.equal(status.host.state, "running");
  assert.equal(status.agents.find(agent => agent.name === "main-agent")?.state, "succeeded");
  assert.equal(status.agents.find(agent => agent.name === "main-agent")?.history?.length, 1);
  assert.deepEqual(status.channels, [{ name: "weixin", state: "connected" }]);
  assert.deepEqual(status.integrations, []);
  assert.doesNotMatch(statusJson.stdout, /hello from the human|hello through Loom|\.loom/);

  const historicalStatus = await runCli(cli, [
    "status",
    "--since",
    "2026-01-01T00:00:00.000Z",
  ], env);
  assert.equal(historicalStatus.code, 0, historicalStatus.stderr);
  assert.match(historicalStatus.stdout, /^Agent runs since /m);
  assert.match(historicalStatus.stdout, /^  Main Agent: 1$/m);
  assert.match(historicalStatus.stdout, /^    .* succeeded \(completed\)$/m);

  const humanStatus = await runCli(cli, ["status"], env);
  assert.equal(humanStatus.code, 0, humanStatus.stderr);
  assert.match(humanStatus.stdout, /^Host: running \(Loom 0\.0\.0\+g[0-9a-f]{7,12}, started /m);
  assert.match(humanStatus.stdout, /^Model: active/m);
  assert.match(humanStatus.stdout, /^  Main Agent: succeeded/m);
  assert.match(humanStatus.stdout, /^  Weixin: connected/m);
  assert.doesNotMatch(humanStatus.stdout, /\{|"schemaVersion"|hello from the human/);

  const exited = once(host, "exit");
  host.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0, hostStderr);
});

async function preparedInstanceRoot(root?: string): Promise<string> {
  const instanceRoot = root ?? await mkdtemp(path.join(tmpdir(), "loom-cli-"));
  const workspace = path.join(instanceRoot, "workspace");
  await initializeLoomInstance({ root: instanceRoot, channels: ["weixin"] });
  await writeWeixinChannel(instanceRoot, "http://127.0.0.1:1");
  await mkdir(workspace, { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }), "utf8"),
    writeFile(path.join(workspace, "identity.md"), "Rowan is a continuing AI Individual.\n", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "No durable memories yet.\n", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Nothing is currently foregrounded.\n", "utf8"),
  ]);
  return instanceRoot;
}

async function writeWeixinChannel(root: string, baseUrl: string): Promise<void> {
  const channelRoot = path.join(root, "configuration", "channels", "weixin");
  await mkdir(channelRoot, { recursive: true });
  await writeFile(path.join(channelRoot, "config.json"), JSON.stringify({
    version: 1,
    routeRef: "primary-route",
    peerId: "peer-1",
    baseUrl,
  }), "utf8");
  await writeFile(path.join(channelRoot, "auth.json"), JSON.stringify({
    version: 1,
    token: "channel-token",
  }), "utf8");
}

async function writeModelConfiguration(root: string, baseUrl: string): Promise<void> {
  const configuration = path.join(root, "configuration");
  await writeFile(path.join(configuration, "instance.yaml"), [
    "version: 1",
    "channels:",
    "  weixin:",
    "    enabled: true",
    "integrations:",
    "  nmem:",
    "    enabled: false",
    "interaction:",
    "  defaultRoute: primary-route",
    "models:",
    "  default:",
    "    - provider: local-test",
    "      model: local-model",
    "      thinkingLevel: medium",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(configuration, "pi", "models.json"), JSON.stringify({
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
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 16_384,
        }],
      },
    },
  }), "utf8");
}

async function startWeixinChannel(humanText: string): Promise<{
  baseUrl: string;
  modelBaseUrl: string;
  received: string[];
  close(): void;
}> {
  const received: string[] = [];
  let delivered = false;
  const server = createServer((request, response) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { source += chunk; });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/v1/chat/completions") {
        respondStreaming(response, "hello through Loom");
        return;
      }
      if (url.pathname === "/ilink/bot/getupdates") {
        if (!delivered) {
          delivered = true;
          respondJson(response, {
            ret: 0,
            get_updates_buf: "cursor-2",
            msgs: [{
              message_id: 1,
              from_user_id: "peer-1",
              create_time_ms: 1_750_000_000_000,
              message_type: 1,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text: humanText } }],
            }],
          });
        } else {
          // long poll: hold the request open until the Host stops polling
          request.on("aborted", () => response.destroy());
        }
        return;
      }
      if (url.pathname === "/ilink/bot/sendmessage") {
        const body = JSON.parse(source) as {
          msg?: { item_list?: Array<{ text_item?: { text?: string } }> };
        };
        received.push(body.msg?.item_list?.[0]?.text_item?.text ?? "");
        respondJson(response, { ret: 0 });
        return;
      }
      // notifystart / notifystop
      respondJson(response, { ret: 0 });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    modelBaseUrl: `${baseUrl}/v1`,
    received,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function respondJson(response: import("node:http").ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function respondStreaming(response: import("node:http").ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
  response.write(`data: ${JSON.stringify({
    id: "completion-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-model",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "call-message",
          type: "function",
          function: { name: "message", arguments: JSON.stringify({ action: "send", text }) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "completion-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

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

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  predicate: () => boolean,
  stderr: () => string,
): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`CLI did not become ready: ${stderr()}`)), 5_000);
    const onData = () => {
      if (predicate()) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`CLI exited before ready (${code ?? signal}): ${stderr()}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}
