import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_PROACTIVITY_BEHAVIOR,
  DEFAULT_INTERACTIVITY_BEHAVIOR,
} from "./default-materials.js";

export interface InitializeLoomInstanceResult {
  root: string;
  createdFiles: string[];
  requiredIndividualMaterials: Array<{
    path: string;
  }>;
}

export type InitializeChannelName = "weixin" | "raft";

const INITIALIZABLE_CHANNELS: readonly InitializeChannelName[] = ["weixin", "raft"];

const REQUIRED_INDIVIDUAL_MATERIALS: InitializeLoomInstanceResult["requiredIndividualMaterials"] = [
  { path: "workspace/facts.json" },
  { path: "workspace/identity.md" },
  { path: "workspace/memory.md" },
  { path: "workspace/attention.md" },
];

const SCAFFOLD_BEHAVIOR_FILES = new Map<string, string>([
  ["workspace/behavior/interactivity.md", DEFAULT_INTERACTIVITY_BEHAVIOR],
  ["workspace/behavior/proactivity.md", DEFAULT_PROACTIVITY_BEHAVIOR],
]);

function scaffoldInstanceYaml(channels: readonly InitializeChannelName[]): string {
  return [
    "version: 1",
    "channels:",
    ...INITIALIZABLE_CHANNELS.map(name =>
      `  ${name}:\n    enabled: ${channels.includes(name) ? "true" : "false"}`),
    "integrations:",
    "  web:",
    "    enabled: false",
    "  nmem:",
    "    enabled: false",
    "",
  ].join("\n");
}

export async function initializeLoomInstance(options: {
  root: string;
  /** Interaction Channels to enable in the scaffold; at least one is required. */
  channels: readonly InitializeChannelName[];
}): Promise<InitializeLoomInstanceResult> {
  const channels = [...new Set(options.channels)];
  const invalid = channels.filter(name => !INITIALIZABLE_CHANNELS.includes(name));
  if (invalid.length > 0) {
    throw new Error(`Unsupported Interaction Channel: ${invalid[0]}`);
  }
  if (channels.length === 0) {
    throw new Error("Loom requires at least one enabled Interaction Channel");
  }
  const root = path.resolve(options.root);
  const scaffoldFiles = new Map<string, string>([
    ["configuration/instance.yaml", scaffoldInstanceYaml(channels)],
    ...SCAFFOLD_BEHAVIOR_FILES,
  ]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await ensureDirectory(root, "configuration/pi");
  const createdFiles: string[] = [];
  for (const [relativePath, content] of scaffoldFiles) {
    if (await writeIfMissing(root, relativePath, content)) createdFiles.push(relativePath);
  }
  return {
    root,
    createdFiles: createdFiles.sort(),
    requiredIndividualMaterials: REQUIRED_INDIVIDUAL_MATERIALS.map(material => ({ ...material })),
  };
}

async function writeIfMissing(root: string, relativePath: string, content: string): Promise<boolean> {
  await ensureDirectory(root, path.posix.dirname(relativePath));
  const file = path.join(root, relativePath);
  try {
    await writeFile(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

async function ensureDirectory(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const part of relativePath.split("/").filter(part => part && part !== ".")) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Instance scaffold path must stay inside the Instance Root");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
