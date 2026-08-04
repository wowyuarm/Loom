import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = createRequire(import.meta.url)("../../package.json") as { version: string };

export const LOOM_VERSION = `${packageJson.version}${sourceRevision()}`;

function sourceRevision(): string {
  try {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: path.resolve(directory, "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,12}$/.test(revision) ? `+g${revision}` : "";
  } catch {
    return "";
  }
}
