#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  openLoomHost,
  readLoomInteractionHistory,
  readLoomStatus,
  requeueLoomInput,
  type LoomStatusReport,
} from "./host/index.js";
import { initializeLoomInstance } from "./instance/index.js";
import { resolveInstanceLayout } from "./instance/layout.js";
import type { InteractionViewEntry } from "./runtime/index.js";
import {
  operationalTimestamp,
  type OperationalEvent,
  type OperationalEventObserver,
} from "./operational-events.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command !== "init" && command !== "run" && command !== "history"
    && command !== "status" && command !== "requeue") {
    throw new Error(usage());
  }
  const root = readRoot(args, command);
  if (command === "init") {
    const result = await initializeLoomInstance({ root, channels: readInitChannels(args) });
    console.log(JSON.stringify({ event: "instance.initialized", ...result }));
    return;
  }
  if (command === "history") {
    const remaining = remainingArguments(args, "--root");
    if (remaining.length > 0) throw new Error(`Unknown argument: ${remaining[0]}`);
    const entries = await readRecentInteractions(resolveInstanceLayout(root).statusSocketPath, 100);
    for (const entry of entries) {
      console.log(`${entry.at} ${entry.actorRef} [${entry.source}]: ${interactionText(entry.content) ?? JSON.stringify(entry.content)}`);
    }
    return;
  }
  if (command === "status") {
    const options = readStatusArguments(args);
    const report = await readLoomStatus(resolveInstanceLayout(root).statusSocketPath, {
      ...(options.since ? { since: options.since } : {}),
    });
    console.log(options.json ? JSON.stringify(report) : formatStatus(report, options.since));
    if (report.host.state === "unavailable") process.exitCode = 1;
    return;
  }
  if (command === "requeue") {
    const remaining = remainingArguments(args, "--root");
    if (remaining.length !== 1 || !remaining[0]!.trim()) throw new Error(usage("requeue"));
    const inputId = remaining[0]!.trim();
    const disposition = await requeueLoomInput(resolveInstanceLayout(root).statusSocketPath, inputId);
    if (disposition !== "requeued") throw new Error(`Input ${inputId} is not blocked`);
    console.log(`Requeued Input ${inputId}`);
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
    for (const [channel, status] of Object.entries(runningStatus.channels ?? {})) {
      observe({
        event: "channel.state",
        at: operationalTimestamp(),
        channel,
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

function readStatusArguments(args: string[]): { json: boolean; since?: string } {
  let json = false;
  let since: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--root") {
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--since") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !isIsoTimestamp(value)) {
        throw new Error(usage("status"));
      }
      since = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { json, ...(since ? { since } : {}) };
}

function formatStatus(report: LoomStatusReport, since?: string): string {
  if (!("runId" in report)) return "Loom Host unavailable";
  const modelDetail = report.model.state === "active"
    ? report.model.revisionId
    : report.model.state === "degraded"
      ? `${report.model.revisionId}, ${report.model.failureCategory}`
      : report.model.failureCategory;
  const lines = [
    `Host: ${report.host.state} (Loom ${report.host.version}, started ${report.host.startedAt})`,
    `Model: ${report.model.state} (${modelDetail})`,
    `Runtime: active turn ${report.runtime.activeTurn ? "yes" : "no"}; ${report.runtime.pendingInputs} pending Inputs; ${report.runtime.pendingEffects} pending Effects; ${report.runtime.deliveriesNeedingAttention} Deliveries need attention`,
    "Agents:",
  ];
  if (report.runtime.oldestPendingOrganAgeMs !== undefined) {
    lines.splice(3, 0, `Oldest pending organ work: ${Math.floor(report.runtime.oldestPendingOrganAgeMs / 1_000)}s`);
  }
  for (const warning of report.runtime.integrityWarnings) {
    lines.splice(3, 0, `Runtime integrity warning: ${warning.kind} (${warning.count})`);
  }
  for (const agent of report.agents) {
    const latestAt = agent.latest?.endedAt ?? agent.latest?.startedAt;
    const outcome = agent.latest?.outcome ? `, ${agent.latest.outcome}` : "";
    const retry = agent.nextRunAt ? `, next ${agent.nextRunAt}` : "";
    lines.push(`  ${agentLabel(agent.name)}: ${agent.state}${latestAt ? ` at ${latestAt}` : ""}${outcome}${retry}`);
  }
  lines.push("Channels:");
  if (report.channels.length === 0) lines.push("  None enabled");
  for (const channel of report.channels) {
    const failure = channel.lastFailure ? ` (${channel.lastFailure.category})` : "";
    lines.push(`  ${integrationLabel(channel.name)}: ${channel.state}${failure}`);
  }
  lines.push("Integrations:");
  if (report.integrations.length === 0) lines.push("  None enabled");
  for (const integration of report.integrations) {
    const failure = integration.lastFailure ? ` (${integration.lastFailure.category})` : "";
    lines.push(`  ${integrationLabel(integration.name)}: ${integration.state}${failure}`);
  }
  if (since) {
    lines.push(`Agent runs since ${since}:`);
    for (const agent of report.agents) {
      const history = agent.history ?? [];
      lines.push(`  ${agentLabel(agent.name)}: ${history.length}`);
      for (const run of history) {
        const at = run.endedAt ?? run.startedAt;
        lines.push(`    ${at} ${run.result}${run.outcome ? ` (${run.outcome})` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

function agentLabel(name: string): string {
  return ({
    "main-agent": "Main Agent",
    orientation: "Orientation",
    "life-recorder": "Life Recorder",
    "attention-maintainer": "Attention Maintainer",
    "memory-reflector": "Memory Reflector",
    "thread-maintainer": "Thread Maintainer",
  } as Record<string, string>)[name] ?? name;
}

function integrationLabel(name: string): string {
  if (name === "nmem") return "nmem";
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function writeOperationalEvent(event: OperationalEvent): void {
  console.log(JSON.stringify(event));
}

type LoomCommand = "init" | "run" | "history" | "status" | "requeue";

function readInitChannels(args: string[]): Array<"weixin" | "raft"> {
  const channels: Array<"weixin" | "raft"> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--channel") continue;
    const value = args[index + 1];
    if (value !== "weixin" && value !== "raft") throw new Error(usage("init"));
    if (!channels.includes(value)) channels.push(value);
    index += 1;
  }
  if (channels.length === 0) throw new Error(usage("init"));
  return channels;
}

function readRoot(args: string[], command: LoomCommand): string {
  const name = "--root";
  const index = args.indexOf(name);
  if (index < 0) return path.join(homedir(), ".loom");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(usage(command));
  }
  const remaining = remainingArguments(args, name);
  if (command !== "init" && command !== "status" && command !== "requeue" && remaining.length > 0) {
    throw new Error(`Unknown argument: ${remaining[0]}`);
  }
  return value;
}

function remainingArguments(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index < 0) return [...args];
  return args.filter((_, candidate) => candidate !== index && candidate !== index + 1);
}

function usage(command?: LoomCommand): string {
  if (command === "status") {
    return "Usage: loom status [--root <instance-root>] [--json] [--since <ISO-timestamp>]";
  }
  if (command === "requeue") return "Usage: loom requeue [--root <instance-root>] <input-id>";
  if (command === "init") {
    return "Usage: loom init [--root <instance-root>] --channel raft|weixin [--channel raft|weixin]";
  }
  if (command) return `Usage: loom ${command} [--root <instance-root>]`;
  return [
    "Usage:",
    "  loom init [--root <instance-root>] --channel raft|weixin [--channel raft|weixin]",
    "  loom run [--root <instance-root>]",
    "  loom history [--root <instance-root>]",
    "  loom status [--root <instance-root>] [--json] [--since <ISO-timestamp>]",
    "  loom requeue [--root <instance-root>] <input-id>",
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
    const page = await readLoomInteractionHistory(socketPath, {
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
