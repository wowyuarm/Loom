#!/usr/bin/env node
// Workspace mirror: periodically commit and push an Instance's Agent Workspace
// to its configured private remote, as a human review surface only. This is
// explicitly not a backup (see docs/operations/reference/backup-and-restore.md).
//
// Usage: node src/integrations/workspace-mirror/mirror.mjs --root <instance-root>
//
// Behavior:
// - Reads workspaceMirror from configuration/instance.yaml; exits 0 without
//   action when the mirror is disabled or unconfigured.
// - Initializes the workspace git repository on first run (idempotent).
// - Commits only when the working tree changed; otherwise exits 0.
// - Pushes to the configured remote/branch; a failed push exits non-zero so
//   the timer retries on the next cycle.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";

const GITIGNORE_PATTERNS = ["*token*", "*auth*", "*.env", "*.bak", "*.bak-*"];

function usage() {
  console.error("Usage: node src/integrations/workspace-mirror/mirror.mjs --root <instance-root>");
  process.exit(2);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function ensureGitignore(workspace) {
  const gitignorePath = path.join(workspace, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const existingLines = new Set(existing.split("\n"));
  const missing = GITIGNORE_PATTERNS.filter(pattern => !existingLines.has(pattern));
  if (missing.length === 0) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignorePath, `${separator}${missing.join("\n")}\n`);
  console.log(`Workspace mirror: appended ${missing.length} pattern(s) to .gitignore`);
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  if (rootIndex < 0 || !args[rootIndex + 1] || args[rootIndex + 1].startsWith("--")) usage();
  const root = path.resolve(args[rootIndex + 1]);
  const workspace = path.join(root, "workspace");
  const gitDir = path.join(workspace, ".git");
  if (!existsSync(workspace)) {
    console.error(`Workspace mirror: missing workspace at ${workspace}`);
    process.exit(1);
  }

  let document;
  try {
    document = parse(await readFile(path.join(root, "configuration", "instance.yaml"), "utf8"), { uniqueKeys: true });
  } catch (error) {
    console.error(`Workspace mirror: cannot read instance configuration: ${error.message}`);
    process.exit(1);
  }
  const mirror = document?.workspaceMirror;
  if (mirror === undefined) {
    console.log("Workspace mirror: not configured, no action");
    process.exit(0);
  }
  if (mirror.enabled !== true) {
    console.log("Workspace mirror: disabled, no action");
    process.exit(0);
  }
  if (typeof mirror.remote !== "string" || !mirror.remote.trim()) {
    console.error("Workspace mirror: enabled but remote is missing");
    process.exit(1);
  }
  const remote = mirror.remote.trim();
  const branch = typeof mirror.branch === "string" && mirror.branch.trim() ? mirror.branch.trim() : "main";

  // Time zone for the commit message: use the configured instance time zone
  // when present, otherwise fall back to the machine time zone (same rule as
  // src/configuration/instance.ts).
  const configuredTimeZone = typeof document?.time?.timeZone === "string" && document.time.timeZone
    ? document.time.timeZone
    : undefined;
  const timeZone = configuredTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(now).replace(",", "");

  if (!existsSync(gitDir)) {
    run("git", ["init", "-b", branch], { cwd: workspace });
    console.log(`Workspace mirror: initialized repository in ${workspace}`);
  }
  ensureGitignore(workspace);
  run("git", ["config", "user.name", "workspace-mirror"], { cwd: workspace });
  run("git", ["config", "user.email", "workspace-mirror@loom.invalid"], { cwd: workspace });
  try {
    const current = run("git", ["remote", "get-url", "origin"], { cwd: workspace });
    if (current !== remote) {
      run("git", ["remote", "set-url", "origin", remote], { cwd: workspace });
      console.log(`Workspace mirror: updated remote origin to ${remote}`);
    }
  } catch {
    run("git", ["remote", "add", "origin", remote], { cwd: workspace });
    console.log(`Workspace mirror: added remote origin ${remote}`);
  }

  const porcelain = run("git", ["status", "--porcelain"], { cwd: workspace });
  if (porcelain !== "") {
    run("git", ["add", "-A"], { cwd: workspace });
    run("git", ["commit", "-m", `workspace mirror: ${stamp} (${timeZone})`], { cwd: workspace });
    console.log(`Workspace mirror: committed ${porcelain.split("\n").length} changed path(s)`);
  } else {
    let ahead = "0";
    try {
      ahead = run("git", ["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: workspace });
    } catch {
      // No upstream ref yet; treat as needing a push so the first mirror
      // cycle can push the initial commit even without new changes.
      ahead = "1";
    }
    if (ahead === "0") {
      console.log("Workspace mirror: no changes, nothing to commit");
      process.exit(0);
    }
    console.log(`Workspace mirror: ${ahead} unpushed commit(s), retrying push`);
  }
  try {
    run("git", ["push", "-u", "origin", branch], { cwd: workspace });
    console.log(`Workspace mirror: pushed to origin/${branch}`);
  } catch (error) {
    console.error(`Workspace mirror: push failed (will retry next cycle): ${error.message.split("\n")[0]}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Workspace mirror: ${error.message}`);
  process.exit(1);
});
