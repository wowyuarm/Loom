import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_BACKGROUND_BEHAVIOR,
  DEFAULT_INTERACTION_BEHAVIOR,
} from "./default-materials.js";

export interface InitializeLoomInstanceResult {
  root: string;
  createdFiles: string[];
  requiredIndividualMaterials: Array<{
    path: string;
  }>;
}

const REQUIRED_INDIVIDUAL_MATERIALS: InitializeLoomInstanceResult["requiredIndividualMaterials"] = [
  { path: "workspace/facts.json" },
  { path: "workspace/identity.md" },
  { path: "workspace/memory.md" },
  { path: "workspace/attention.md" },
];

const SCAFFOLD_FILES = new Map<string, string>([
  ["configuration/instance.yaml", `version: 1
integrations:
  local:
    enabled: true
  weixin:
    enabled: false
  raft:
    enabled: false
  nmem:
    enabled: false
interaction:
  defaultRoute: local
`],
  ["workspace/behavior/background.md", DEFAULT_BACKGROUND_BEHAVIOR],
  ["workspace/behavior/interaction.md", DEFAULT_INTERACTION_BEHAVIOR],
]);

export async function initializeLoomInstance(options: {
  root: string;
}): Promise<InitializeLoomInstanceResult> {
  const root = path.resolve(options.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await ensureDirectory(root, "configuration/pi");
  const createdFiles: string[] = [];
  for (const [relativePath, content] of SCAFFOLD_FILES) {
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
