import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openLoomHost } from "../../src/host/index.js";
import { initializeLoomInstance } from "../../src/instance/index.js";
import { openRuntime } from "../../src/runtime/index.js";

test("initializes the default ~/.loom Instance through the foreground CLI", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-cli-init-"));
  const root = path.join(parent, ".loom");
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

  const child = spawn(process.execPath, [cli, "init"], {
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
      "workspace/behavior/background.md",
      "workspace/behavior/interaction.md",
    ],
    requiredIndividualMaterials: [
      { path: "workspace/facts.json" },
      { path: "workspace/identity.md" },
      { path: "workspace/memory.md" },
      { path: "workspace/attention.md" },
    ],
  });
  assert.match(
    await readFile(path.join(root, "workspace", "behavior", "background.md"), "utf8"),
    /Background time belongs to the Agent Individual/,
  );
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
  assert.match(stdout, /"event":"integration\.state"/);
  assert.match(stdout, /"event":"driver\.run\.started"/);
  assert.match(stdout, /"event":"driver\.run\.completed"/);
});

test("chats through the running Local channel and rebuilds history in another client", async t => {
  const provider = await startMessageProvider("hello through Loom");
  t.after(() => provider.close());
  const home = await mkdtemp(path.join(tmpdir(), "loom-cli-home-"));
  const root = await preparedInstanceRoot(path.join(home, ".loom"));
  await writeModelConfiguration(root, provider.baseUrl);
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

  const chat = await runCli(cli, ["chat", "hello from the human"], env);
  assert.equal(chat.code, 0, chat.stderr);
  assert.equal(chat.stdout.trim(), "hello through Loom");

  await waitForOutput(
    host,
    () => hostStdout.includes('"event":"agent.tool.completed"'),
    () => hostStderr,
  );
  for (const event of [
    "model.runtime",
    "integration.state",
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
  assert.match(history.stdout, /human \[local\]: hello from the human/);
  assert.match(history.stdout, /individual \[local\]: hello through Loom/);

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
    integrations: Array<{ name: string; state: string }>;
  };
  assert.equal(status.host.state, "running");
  assert.equal(status.agents.find(agent => agent.name === "main-agent")?.state, "succeeded");
  assert.equal(status.agents.find(agent => agent.name === "main-agent")?.history?.length, 1);
  assert.deepEqual(status.integrations, [{ name: "local", state: "listening" }]);
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
  assert.match(humanStatus.stdout, /^  Local: listening/m);
  assert.doesNotMatch(humanStatus.stdout, /\{|"schemaVersion"|hello from the human/);

  const exited = once(host, "exit");
  host.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0, hostStderr);
});

async function preparedInstanceRoot(root?: string): Promise<string> {
  const instanceRoot = root ?? await mkdtemp(path.join(tmpdir(), "loom-cli-"));
  const workspace = path.join(instanceRoot, "workspace");
  await initializeLoomInstance({ root: instanceRoot });
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

async function writeModelConfiguration(root: string, baseUrl: string): Promise<void> {
  const configuration = path.join(root, "configuration");
  await writeFile(path.join(configuration, "instance.yaml"), [
    "version: 1",
    "integrations:",
    "  local:",
    "    enabled: true",
    "  weixin:",
    "    enabled: false",
    "  nmem:",
    "    enabled: false",
    "interaction:",
    "  defaultRoute: local",
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

async function startMessageProvider(text: string): Promise<{ baseUrl: string; close(): void }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
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
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
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
