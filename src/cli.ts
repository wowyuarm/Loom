#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { openLoomHost } from "./host/index.js";
import { initializeLoomInstance } from "./instance/index.js";
import { resolveInstanceLayout } from "./instance/layout.js";
import {
  readLocalInteractionHistory,
  sendLocalChat,
} from "./integrations/local/index.js";
import type { InteractionViewEntry } from "./runtime/index.js";
import {
  operationalTimestamp,
  type OperationalEvent,
  type OperationalEventObserver,
} from "./operational-events.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command !== "init" && command !== "run" && command !== "chat" && command !== "history") {
    throw new Error(usage());
  }
  const root = readRoot(args, command);
  if (command === "init") {
    const result = await initializeLoomInstance({ root });
    console.log(JSON.stringify({ event: "instance.initialized", ...result }));
    return;
  }
  if (command === "chat") {
    const text = remainingArguments(args, "--root").join(" ").trim();
    if (!text) throw new Error(usage("chat"));
    const result = await sendLocalChat({
      socketPath: resolveInstanceLayout(root).localSocketPath,
      text,
    });
    if (result.outcome.state === "failed" || result.outcome.state === "blocked") {
      throw new Error(`Local chat did not complete: ${result.outcome.reason}`);
    }
    for (const entry of result.entries) {
      const text = interactionText(entry.content);
      if (text) console.log(text);
    }
    return;
  }
  if (command === "history") {
    const remaining = remainingArguments(args, "--root");
    if (remaining.length > 0) throw new Error(`Unknown argument: ${remaining[0]}`);
    const entries = await readRecentInteractions(resolveInstanceLayout(root).localSocketPath, 100);
    for (const entry of entries) {
      console.log(`${entry.at} ${entry.actor} [${entry.source}]: ${interactionText(entry.content) ?? JSON.stringify(entry.content)}`);
    }
    return;
  }
  const observe: OperationalEventObserver = event => writeOperationalEvent(event);
  const host = await openLoomHost({ root, observe });
  const termination = waitForTerminationSignal();
  try {
    await host.start();
    const runningStatus = host.status();
    observe({
      event: "host.started",
      at: operationalTimestamp(),
      root: runningStatus.root,
    });
    for (const integration of ["local", "weixin"] as const) {
      const status = runningStatus.integrations?.[integration];
      if (!status) continue;
      observe({
        event: "integration.state",
        at: operationalTimestamp(),
        integration,
        state: status.state,
      });
    }
    const signal = await termination.promise;
    await host.stop();
    observe({
      event: "host.stopped",
      at: operationalTimestamp(),
      root: host.status().root,
      signal,
    });
  } catch (error) {
    await host.stop();
    throw error;
  } finally {
    termination.dispose();
  }
}

function writeOperationalEvent(event: OperationalEvent): void {
  console.log(JSON.stringify(event));
}

function readRoot(args: string[], command: "init" | "run" | "chat" | "history"): string {
  const name = "--root";
  const index = args.indexOf(name);
  if (index < 0) return path.join(homedir(), ".loom");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(usage(command));
  }
  const remaining = remainingArguments(args, name);
  if (command !== "chat" && remaining.length > 0) throw new Error(`Unknown argument: ${remaining[0]}`);
  return value;
}

function remainingArguments(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index < 0) return [...args];
  return args.filter((_, candidate) => candidate !== index && candidate !== index + 1);
}

function usage(command?: "init" | "run" | "chat" | "history"): string {
  if (command === "chat") return "Usage: loom chat [--root <instance-root>] <text>";
  if (command) return `Usage: loom ${command} [--root <instance-root>]`;
  return [
    "Usage:",
    "  loom init [--root <instance-root>]",
    "  loom run [--root <instance-root>]",
    "  loom chat [--root <instance-root>] <text>",
    "  loom history [--root <instance-root>]",
    "",
    "The default Instance Root is ~/.loom.",
  ].join("\n");
}

function interactionText(content: unknown): string | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const text = (content as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

async function readRecentInteractions(socketPath: string, limit: number): Promise<InteractionViewEntry[]> {
  const entries: InteractionViewEntry[] = [];
  let after: string | undefined;
  while (true) {
    const page = await readLocalInteractionHistory({
      socketPath,
      ...(after ? { after } : {}),
      limit: 500,
    });
    entries.push(...page.entries);
    after = page.cursor ?? after;
    if (!page.hasMore) return entries.slice(-limit);
  }
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
