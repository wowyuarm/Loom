import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const OUTSIDE_WORKSPACE = "Path must stay inside the Agent Workspace";

export function createWorkspaceReadTools(root: string): ToolDefinition[] {
  const workspaceRoot = path.resolve(root);
  const read = createReadToolDefinition(workspaceRoot);
  const ls = createLsToolDefinition(workspaceRoot);
  const grep = createGrepToolDefinition(workspaceRoot);
  const executeRead = read.execute.bind(read);
  const executeLs = ls.execute.bind(ls);
  const executeGrep = grep.execute.bind(grep);

  read.execute = async (toolCallId, params, signal, onUpdate, context) => {
    await assertWorkspacePath(workspaceRoot, params.path);
    return executeRead(toolCallId, params, signal, onUpdate, context);
  };
  ls.execute = async (toolCallId, params, signal, onUpdate, context) => {
    await assertWorkspacePath(workspaceRoot, params.path ?? ".");
    return executeLs(toolCallId, params, signal, onUpdate, context);
  };
  grep.execute = async (toolCallId, params, signal, onUpdate, context) => {
    await assertWorkspacePath(workspaceRoot, params.path ?? ".");
    return executeGrep(toolCallId, params, signal, onUpdate, context);
  };

  return [defineTool(read), defineTool(ls), defineTool(grep)];
}

async function assertWorkspacePath(root: string, requestedPath: string): Promise<void> {
  if (isLexicalEscape(requestedPath)) throw new Error(OUTSIDE_WORKSPACE);
  const target = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(root, requestedPath);
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    realpath(root),
    realpath(target),
  ]);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(OUTSIDE_WORKSPACE);
  }
}

function isLexicalEscape(requestedPath: string): boolean {
  if (path.win32.isAbsolute(requestedPath) && !path.isAbsolute(requestedPath)) return true;
  if (requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")) return true;
  return requestedPath.split(/[\\/]+/).includes("..");
}
