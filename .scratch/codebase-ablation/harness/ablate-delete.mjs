#!/usr/bin/env node
// Deletion ablation: remove a target (dir or file under src/) plus its reverse
// dependency closure (src + test), build the remainder, run surviving tests.
// Usage: node ablate-delete.mjs <repoDir> <targetRel> <outJson>
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildGraph, reverseClosure, listTsFiles } from "./graph.mjs";

const [repoDirRaw, targetRel, outJson] = process.argv.slice(2);
const repoDir = path.resolve(repoDirRaw);
const slug = targetRel.replaceAll("/", "__");
const worktrees = "/tmp/loom-ablation";
const wt = path.join(worktrees, slug);

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: wt, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });

function fail(json, stage, error) {
  const result = {
    target: targetRel,
    mode: "deletion",
    stage,
    error: String(error).slice(0, 4000),
    ...json,
  };
  mkdirSync(path.dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify(result, null, 2));
  try {
    execSync(`git worktree remove --force "${wt}"`, { cwd: repoDir, stdio: "ignore" });
  } catch {}
  console.error(`[${targetRel}] failed at ${stage}: ${String(error).slice(0, 500)}`);
  process.exit(1);
}

try {
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(worktrees, { recursive: true });
  execSync("git worktree prune", { cwd: repoDir, stdio: "ignore" });
  try {
    execSync(`git worktree add --detach "${wt}" HEAD`, { cwd: repoDir, stdio: "ignore" });
  } catch {
    execSync("git worktree prune", { cwd: repoDir, stdio: "ignore" });
    execSync(`git worktree add --detach "${wt}" HEAD`, { cwd: repoDir, stdio: "ignore" });
  }
  if (!existsSync(wt)) throw new Error(`worktree missing after add: ${wt}`);
  symlinkSync(path.join(repoDir, "node_modules"), path.join(wt, "node_modules"));

  // 1. Compute closure from the worktree's own graph.
  const graph = buildGraph(wt);
  const srcTarget = path.join(wt, "src", targetRel);
  let targets;
  try {
    targets = listTsFiles(srcTarget);
  } catch {
    targets = existsSync(srcTarget) ? [srcTarget] : [];
  }
  if (targets.length === 0) throw new Error(`no target files under src/${targetRel}`);
  const closure = reverseClosure(graph, targets);
  const rel = (p) => path.relative(wt, p);
  const removedSrc = closure.filter((p) => rel(p).startsWith("src/"));
  const removedTest = closure.filter((p) => rel(p).startsWith("test/"));

  // 2. Delete the collapse set.
  for (const f of closure) rmSync(f);

  // 3. Build the remainder (tsc emits dist for both src and test).
  let tscOk = true;
  let tscErrors = "";
  const build = spawnSync("./node_modules/.bin/tsc", ["-p", "tsconfig.json"], {
    cwd: wt,
    encoding: "utf8",
  });
  if (build.status !== 0 || build.error) {
    tscOk = false;
    tscErrors = (build.stdout ?? "") + (build.stderr ?? "") + (build.error ? ` spawn: ${build.error}` : "");
    const json = {
      removedSrcCount: removedSrc.length,
      removedTestCount: removedTest.length,
      tscOk,
      tscErrors: tscErrors.slice(0, 4000),
    };
    fail(json, "build", `tsc failed: ${(build.error ? String(build.error) : tscErrors).slice(0, 300)}`);
  }

  // core-skills copy + CLI exec bit, mirroring `npm run build` post-steps.
  try {
    sh("cp -R src/main-agent/core-skills dist/src/main-agent/core-skills");
    sh("chmod +x dist/src/cli.js");
  } catch {}

  // 4. Run surviving tests.
  let tests = 0,
    pass = 0,
    failCount = 0,
    failures = [],
    failureDetails = "";
  const remainingTests = existsSync(path.join(wt, "dist", "test"))
    ? sh("find dist/test -name '*.test.js'").trim().split("\n").filter(Boolean)
    : [];
  if (remainingTests.length > 0) {
    const run = spawnSync("node", ["scripts/run-tests.mjs"], { cwd: wt, encoding: "utf8", timeout: 600_000 });
    const out = (run.stdout ?? "") + (run.stderr ?? "");
    for (const m of out.matchAll(/ℹ (tests|pass|fail)\s+(\d+)/g)) {
      if (m[1] === "tests") tests = Number(m[2]);
      if (m[1] === "pass") pass = Number(m[2]);
      if (m[1] === "fail") failCount = Number(m[2]);
    }
    const failIdx = out.indexOf("✖ failing tests:");
    failureDetails = failIdx >= 0 ? out.slice(failIdx, failIdx + 6000) : "";
    let inFailures = false;
    for (const line of out.split("\n")) {
      if (line.startsWith("✖ failing tests:")) {
        inFailures = true;
        continue;
      }
      if (inFailures && line.startsWith("✖ ")) {
        failures.push(line.replace(/^✖\s+/, "").replace(/\s+\(\d+(\.\d+)?m?s\)$/, ""));
      }
    }
  }

  const result = {
    target: targetRel,
    mode: "deletion",
    removedSrcCount: removedSrc.length,
    removedTestCount: removedTest.length,
    removedSrc: removedSrc.map(rel),
    removedTest: removedTest.map(rel),
    survivingTestFiles: remainingTests.length,
    tscOk,
    tests,
    pass,
    fail: failCount,
    failures,
    failureDetails: failureDetails.slice(0, 6000),
  };
  mkdirSync(path.dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify(result, null, 2));
  console.log(
    `[${targetRel}] removed ${removedSrc.length} src / ${removedTest.length} test files; ` +
      `${tests} tests ran, ${failCount} failed`,
  );
} catch (error) {
  fail({}, "setup/run", error);
} finally {
  try {
    execSync(`git worktree remove --force "${wt}"`, { cwd: repoDir, stdio: "ignore" });
  } catch {}
  try {
    execSync("git worktree prune", { cwd: repoDir, stdio: "ignore" });
  } catch {}
}
