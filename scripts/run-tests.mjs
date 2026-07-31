import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testRoot = mkdtempSync(path.join(tmpdir(), "loom-test-suite-"));
const testPaths = process.argv.slice(2);
let result;

try {
  result = spawnSync(
    process.execPath,
    ["--test", ...(testPaths.length > 0 ? testPaths : ["dist/test/**/*.test.js"])],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TMPDIR: testRoot,
      },
    },
  );
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

if (result.error) {
  throw result.error;
}

if (result.signal !== null) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}
