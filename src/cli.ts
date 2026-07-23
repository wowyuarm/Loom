#!/usr/bin/env node

import process from "node:process";

import { openLoomHost } from "./host/index.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command !== "run") throw new Error("Usage: loom run --root <instance-root>");
  const root = readRequiredFlag(args, "--root");
  const host = await openLoomHost({ root });
  const termination = waitForTerminationSignal();
  try {
    host.start();
    console.log(JSON.stringify({ event: "host.started", root: host.status().root }));
    const signal = await termination.promise;
    await host.stop();
    console.log(JSON.stringify({ event: "host.stopped", root: host.status().root, signal }));
  } catch (error) {
    await host.stop();
    throw error;
  } finally {
    termination.dispose();
  }
}

function readRequiredFlag(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Usage: loom run ${name} <instance-root>`);
  }
  const remaining = args.filter((_, candidate) => candidate !== index && candidate !== index + 1);
  if (remaining.length > 0) throw new Error(`Unknown argument: ${remaining[0]}`);
  return value;
}

function waitForTerminationSignal(): {
  promise: Promise<"SIGINT" | "SIGTERM">;
  dispose(): void;
} {
  let resolve!: (signal: "SIGINT" | "SIGTERM") => void;
  const promise = new Promise<"SIGINT" | "SIGTERM">(done => { resolve = done; });
  const onSigint = () => resolve("SIGINT");
  const onSigterm = () => resolve("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    promise,
    dispose: () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

main(process.argv.slice(2)).catch(error => {
  console.error(`[loom] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
