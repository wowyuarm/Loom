import path from "node:path";

import type { FrozenActivity, JsonValue } from "../../runtime/index.js";
import type { ThreadActivityObservation, ThreadEvidenceRelation } from "./evidence.js";

const CHANGE_TOOLS = new Set(["edit", "write"]);
const OBSERVATION_TOOLS = new Set(["find", "grep", "ls", "read"]);

export function threadObservationsFromActivity(
  activity: FrozenActivity,
  workspaceRoot: string,
): ThreadActivityObservation[] {
  const grouped = new Map<string, ThreadActivityObservation>();
  for (const event of activity.events) {
    if (event.kind !== "tool_call" || !isObject(event.content)) continue;
    const toolName = event.content.toolName ?? event.content.name;
    const relation = relationFor(toolName);
    if (!relation || !isObject(event.content.arguments)) continue;
    const candidate = event.content.arguments.path;
    if (typeof candidate !== "string") continue;
    const relative = relativeThreadPath(candidate, workspaceRoot);
    if (!relative || relative === "index.md") continue;
    const threadPath = threadRoot(relative);
    if (!threadPath) continue;
    const key = `${event.turnId}\0${threadPath}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        turnId: event.turnId,
        threadPath,
        relation,
        paths: [relative],
      });
      continue;
    }
    if (!existing.paths.includes(relative)) existing.paths.push(relative);
    if (relation === "changed") existing.relation = "changed";
  }
  const observations = [...grouped.values()];
  if (!observations.some(observation => observation.relation === "changed")) return [];
  return observations
    .map(observation => ({ ...observation, paths: observation.paths.sort() }))
    .sort((left, right) => left.turnId.localeCompare(right.turnId)
      || left.threadPath.localeCompare(right.threadPath));
}

function relationFor(value: JsonValue | undefined): ThreadEvidenceRelation | undefined {
  if (typeof value !== "string") return undefined;
  if (CHANGE_TOOLS.has(value)) return "changed";
  if (OBSERVATION_TOOLS.has(value)) return "observed";
  return undefined;
}

function relativeThreadPath(candidate: string, workspaceRoot: string): string | undefined {
  const workspace = path.resolve(workspaceRoot);
  const target = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspace, candidate);
  const threadsRoot = path.join(workspace, "threads");
  const relative = path.relative(threadsRoot, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function threadRoot(relative: string): string | undefined {
  const parts = relative.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  if (parts[0] === "archive") return parts.length >= 3 ? parts.slice(0, 2).join("/") : undefined;
  return parts[0];
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
