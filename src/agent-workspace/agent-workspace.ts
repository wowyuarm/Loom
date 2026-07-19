import { readFile } from "node:fs/promises";
import path from "node:path";

export type WorkspaceTurnKind = "interaction" | "opportunity";

export interface AgentWorkspaceTurnSnapshot {
  identity: string;
  longTermMemory: string;
  behavior: string;
  currentAttention: string;
}

export class AgentWorkspaceMaterialError extends Error {
  override readonly name = "AgentWorkspaceMaterialError";

  constructor(
    readonly relativePath: string,
    readonly reason: "missing" | "empty",
  ) {
    super(`Required Agent Workspace material ${relativePath} is ${reason}`);
  }
}

export class AgentWorkspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async loadTurnSnapshot(kind: WorkspaceTurnKind): Promise<AgentWorkspaceTurnSnapshot> {
    const [identity, longTermMemory, interactionBehavior, backgroundBehavior, currentAttention] = await Promise.all([
      this.#read("identity.md"),
      this.#read("memory.md"),
      this.#read("behavior/interaction.md"),
      this.#read("behavior/background.md"),
      this.#read("attention.md"),
    ]);
    return {
      identity,
      longTermMemory,
      behavior: kind === "interaction" ? interactionBehavior : backgroundBehavior,
      currentAttention,
    };
  }

  async #read(relativePath: string): Promise<string> {
    try {
      const content = await readFile(path.join(this.root, relativePath), "utf8");
      if (content.trim().length === 0) {
        throw new AgentWorkspaceMaterialError(relativePath, "empty");
      }
      return content;
    } catch (error) {
      if (isMissingFile(error)) {
        throw new AgentWorkspaceMaterialError(relativePath, "missing");
      }
      throw error;
    }
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
