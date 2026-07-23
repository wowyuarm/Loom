import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
});

async function preparedInstanceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cli-"));
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
