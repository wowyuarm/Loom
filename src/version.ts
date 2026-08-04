import { createRequire } from "node:module";

const packageJson = createRequire(import.meta.url)("../../package.json") as { version: string };

export const LOOM_VERSION = packageJson.version;
