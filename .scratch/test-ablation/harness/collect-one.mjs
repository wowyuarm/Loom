// Usage: node collect-one.mjs <repoRoot> <workDir> <distTestRel>
// Runs one compiled test file in its own process with a private TMPDIR and a
// private NODE_V8_COVERAGE directory, then records duration + node:test
// summary into <workDir>/manifest/.  Coverage JSONs stay in
// <workDir>/coverage/<name>/ for merge-coverage.mjs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const [repoRoot, workDir, distTestRel] = process.argv.slice(2);
const name = path.relative("dist/test", distTestRel).replace(/\.test\.js$/, "").replaceAll("/", "__");
const covDir = path.join(workDir, "coverage", name);
rmSync(covDir, { recursive: true, force: true });
mkdirSync(covDir, { recursive: true });
const tmp = mkdtempSync(path.join(workDir, "tmp-"));

const started = performance.now();
const run = spawnSync(process.execPath, ["--test", distTestRel], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
  env: { ...process.env, TMPDIR: tmp, NODE_V8_COVERAGE: covDir },
});
const durationMs = Math.round(performance.now() - started);
rmSync(tmp, { recursive: true, force: true });

const summary = {};
for (const match of `${run.stdout}\n${run.stderr}`.matchAll(/^ℹ (tests|suites|pass|fail|cancelled|skipped) (\d+)/gm)) {
  summary[match[1]] = Number(match[2]);
}
const failingTests = [...`${run.stdout}\n${run.stderr}`.matchAll(/^✖ (.+?) \(/gm)].map(match => match[1]);

const record = {
  file: distTestRel,
  name,
  durationMs,
  exitCode: run.status,
  signal: run.signal,
  failingTests,
  ...summary,
  covDir,
};
mkdirSync(path.join(workDir, "manifest"), { recursive: true });
writeFileSync(path.join(workDir, "manifest", `${name}.json`), JSON.stringify(record, null, 2));
console.error(`${record.fail ? "FAIL" : "ok  "} ${name}: ${summary.tests ?? "?"} tests, ${durationMs}ms`);
