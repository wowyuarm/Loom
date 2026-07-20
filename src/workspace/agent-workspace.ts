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

  async loadStableFacts(): Promise<string> {
    const source = await this.#read("facts.json");
    let facts: unknown;
    try {
      facts = JSON.parse(source);
    } catch {
      throw new Error("Agent Workspace facts.json must contain valid JSON");
    }
    if (!isObject(facts)
      || facts.version !== 1
      || !isObject(facts.individual)
      || !isObject(facts.human)) {
      throw new Error(
        "Agent Workspace facts.json must have version 1 and object sections named individual and human",
      );
    }
    return source;
  }

  async loadCurrentAttention(): Promise<string> {
    return this.#read("attention.md");
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
