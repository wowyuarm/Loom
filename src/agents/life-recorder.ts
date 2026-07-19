import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { JsonValue } from "../runtime/index.js";
import { AgentWorkspace, AgentWorkspaceMaterialError } from "../workspace/agent-workspace.js";

const SYSTEM_PROMPT = `You are the Life Recorder, a first-hand recorder for one Agent Individual.

Your evidence is a frozen activity with structured actors and events. Use actorRef as the sole authority for who said, thought, or did something. Use natural names or relational terms when Identity, observed labels, or relationship context support them. Use a neutral term only when those materials do not provide a supported term, and always preserve the actorRef distinction.

Distinguish external input, the Agent Individual's internal output, thinking, tool actions, Effects, and Delivery results. Thinking is explicitly internal evidence: never present it as another actor's words, an external fact, or an action that occurred. Record only what the evidence supports.

Use read_activity until every event page has been read. Raw events are available only through that tool.

Maintain two different Workspace records:
- Daily Narrative supports near-term continuity. Call write_daily only when the complete Daily should change; provide the complete replacement text for the recording day.
- An episode preserves a replayable scene in which something changed. Call record_episode once for each such scene, citing only eventIds from this frozen activity. Assign ordinals from zero in chronological episode order, and reuse the same ordinal for the same scene when retrying a segment.

Either record may have no change. Do not perform long-term analysis, infer patterns across time, or claim that an external memory system has imported anything. You have only the three recorder tools provided in this run. Finish with a short factual confirmation after reading all activity and completing any writes.`;

const DEFAULT_ACTIVITY_PAGE_SIZE = 50;
const MAX_ACTIVITY_PAGE_SIZE = 200;

export interface FrozenActivityActor {
  actorRef: string;
  kind: "individual" | "external" | "system";
  observedLabel?: string;
  relationshipContext?: string;
}

export interface FrozenActivityEvent {
  eventId: string;
  at: string;
  actorRef: string;
  kind: "input" | "output" | "thinking" | "tool_call" | "tool_result" | "effect" | "delivery" | "system";
  content: JsonValue;
}

export interface FrozenActivity {
  version: 1;
  segmentId: string;
  recordingDay: string;
  openedAt: string;
  closedAt: string;
  actors: FrozenActivityActor[];
  events: FrozenActivityEvent[];
  transcriptAnchors: JsonValue[];
}

export interface LifeRecorderReceipt {
  version: 1;
  segmentId: string;
  runId: string;
  recordedAt: string;
  daily: {
    status: "updated" | "no_change";
    path: string;
  };
  episodes: Array<{
    id: string;
    path: string;
  }>;
}

export interface PiLifeRecorderOptions {
  agentWorkspace: AgentWorkspace;
  agentDir: string;
  transcriptDirectory: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  nextRunId?: () => string;
  now?: () => Date;
}

export interface LifeRecorder {
  record(activity: FrozenActivity): Promise<LifeRecorderReceipt>;
}

interface RecorderMaterials {
  identity: string;
  longTermMemory: string | "missing";
  daily: string | "missing";
  episodes: Array<{ path: string; content: string }> | "missing";
}

interface FileSnapshot {
  absolutePath: string;
  previous: Buffer | null;
}

class WorkspaceWriteJournal {
  readonly #root: string;
  readonly #snapshots = new Map<string, FileSnapshot>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async write(relativePath: string, content: string): Promise<void> {
    const absolutePath = this.#resolve(relativePath);
    if (!this.#snapshots.has(absolutePath)) {
      this.#snapshots.set(absolutePath, {
        absolutePath,
        previous: await readOptionalBuffer(absolutePath),
      });
    }
    await atomicWrite(absolutePath, content);
  }

  async rollback(): Promise<void> {
    for (const snapshot of [...this.#snapshots.values()].reverse()) {
      if (snapshot.previous === null) {
        await rm(snapshot.absolutePath, { force: true });
      } else {
        await atomicWrite(snapshot.absolutePath, snapshot.previous);
      }
    }
  }

  #resolve(relativePath: string): string {
    const absolutePath = path.resolve(this.#root, relativePath);
    if (absolutePath !== this.#root && !absolutePath.startsWith(`${this.#root}${path.sep}`)) {
      throw new Error("Life Recorder path escapes the Agent Workspace");
    }
    return absolutePath;
  }
}

class PiLifeRecorder implements LifeRecorder {
  constructor(private readonly options: PiLifeRecorderOptions) {}

  async record(activity: FrozenActivity): Promise<LifeRecorderReceipt> {
    validateActivity(activity);
    const runId = this.options.nextRunId?.() ?? randomUUID();
    const recordedAt = (this.options.now?.() ?? new Date()).toISOString();
    const dailyPath = `daily/${activity.recordingDay}.md`;
    const materials = await loadRecorderMaterials(this.options.agentWorkspace, activity.recordingDay);
    const journal = new WorkspaceWriteJournal(this.options.agentWorkspace.root);
    const readEventIndexes = new Set<number>();
    const eventIndexById = new Map(activity.events.map((event, index) => [event.eventId, index]));
    const recordedOrdinals = new Set<number>();
    const episodes: LifeRecorderReceipt["episodes"] = [];
    let dailyUpdated = false;

    const tools: ToolDefinition[] = [
      defineTool({
        name: "read_activity",
        label: "Read Activity",
        description: "Read one page of the frozen activity events. Continue from nextOffset until it is null.",
        parameters: Type.Object({
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ACTIVITY_PAGE_SIZE })),
        }),
        execute: async (_toolCallId, params) => {
          const offset = params.offset ?? 0;
          const limit = params.limit ?? DEFAULT_ACTIVITY_PAGE_SIZE;
          if (offset > activity.events.length) {
            throw new Error("Activity offset is outside the frozen evidence");
          }
          const endOffset = Math.min(activity.events.length, offset + limit);
          for (let index = offset; index < endOffset; index += 1) readEventIndexes.add(index);
          return toolResult({
            type: "loom.frozen-activity.page",
            version: 1,
            segmentId: activity.segmentId,
            offset,
            nextOffset: endOffset < activity.events.length ? endOffset : null,
            events: activity.events.slice(offset, endOffset),
          });
        },
      }),
      defineTool({
        name: "write_daily",
        label: "Write Daily Narrative",
        description: "Replace the complete Daily Narrative for this frozen activity's recording day.",
        parameters: Type.Object({
          content: Type.String({ minLength: 1 }),
        }),
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          if (dailyUpdated) throw new Error("Daily Narrative was already written in this recorder run");
          if (readEventIndexes.size !== activity.events.length) {
            throw new Error("All frozen activity events must be read before writing the Daily Narrative");
          }
          await journal.write(dailyPath, requireNonBlank(params.content, "Daily Narrative"));
          dailyUpdated = true;
          return toolResult({ type: "loom.daily-written", version: 1, path: dailyPath });
        },
      }),
      defineTool({
        name: "record_episode",
        label: "Record Episode",
        description: "Write one replayable episode supported by eventIds from this frozen activity.",
        parameters: Type.Object({
          ordinal: Type.Integer({
            minimum: 0,
            description: "Stable zero-based position of this scene in the segment's chronological episode order.",
          }),
          title: Type.String({ minLength: 1 }),
          occurredAt: Type.String({ minLength: 1 }),
          importance: Type.Number({ minimum: 0, maximum: 1 }),
          labels: Type.Array(Type.String({ minLength: 1 })),
          scene: Type.String({ minLength: 1 }),
          evidenceEventIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        }),
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          if (readEventIndexes.size !== activity.events.length) {
            throw new Error("All frozen activity events must be read before recording an episode");
          }
          if (recordedOrdinals.has(params.ordinal)) {
            throw new Error(`Episode ordinal ${params.ordinal} was already used in this recorder run`);
          }
          const evidenceEventIds = uniqueStrings(params.evidenceEventIds, "evidenceEventIds");
          for (const eventId of evidenceEventIds) {
            const eventIndex = eventIndexById.get(eventId);
            if (eventIndex === undefined || !readEventIndexes.has(eventIndex)) {
              throw new Error(`Episode cites eventId outside the frozen evidence: ${eventId}`);
            }
          }
          validateIsoTimestamp(params.occurredAt, "episode occurredAt");
          const id = episodeId(activity.segmentId, params.ordinal);
          const episodePath = `episodes/${activity.recordingDay}/${id}.md`;
          await journal.write(episodePath, formatEpisode({
            id,
            segmentId: activity.segmentId,
            ordinal: params.ordinal,
            title: singleLine(params.title, "Episode title"),
            occurredAt: params.occurredAt,
            importance: params.importance,
            labels: uniqueStrings(params.labels, "labels").map(label => singleLine(label, "Episode label")),
            scene: requireNonBlank(params.scene, "Episode scene"),
            evidenceEventIds,
          }));
          recordedOrdinals.add(params.ordinal);
          episodes.push({ id, path: episodePath });
          return toolResult({ type: "loom.episode-recorded", version: 1, id, path: episodePath });
        },
      }),
    ];

    try {
      await this.#runSession(activity, runId, materials, tools);
      if (readEventIndexes.size !== activity.events.length) {
        throw new Error("Life Recorder did not read all frozen activity events");
      }
      return {
        version: 1,
        segmentId: activity.segmentId,
        runId,
        recordedAt,
        daily: { status: dailyUpdated ? "updated" : "no_change", path: dailyPath },
        episodes,
      };
    } catch (error) {
      await journal.rollback();
      throw error;
    }
  }

  async #runSession(
    activity: FrozenActivity,
    runId: string,
    materials: RecorderMaterials,
    tools: ToolDefinition[],
  ): Promise<void> {
    const transcriptFile = path.join(this.options.transcriptDirectory, `${runId}.jsonl`);
    const sessionManager = SessionManager.open(
      transcriptFile,
      this.options.transcriptDirectory,
      this.options.agentWorkspace.root,
    );
    const settingsManager = SettingsManager.create(
      this.options.agentWorkspace.root,
      this.options.agentDir,
      { projectTrusted: false },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.agentWorkspace.root,
      agentDir: this.options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.agentWorkspace.root,
      agentDir: this.options.agentDir,
      modelRuntime: this.options.modelRuntime,
      model: this.options.model,
      tools: tools.map(tool => tool.name),
      customTools: tools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    try {
      await session.bindExtensions({});
      session.setAutoCompactionEnabled(false);
      await session.prompt(JSON.stringify({
        type: "loom.life-recorder.run",
        version: 1,
        runId,
        activity: {
          segmentId: activity.segmentId,
          recordingDay: activity.recordingDay,
          openedAt: activity.openedAt,
          closedAt: activity.closedAt,
          actors: activity.actors,
          transcriptAnchors: activity.transcriptAnchors,
          eventCount: activity.events.length,
        },
        materials,
      }), { expandPromptTemplates: false });
      assertSuccessfulCompletion(session.messages);
    } finally {
      session.dispose();
    }
  }
}

export async function createPiLifeRecorder(options: PiLifeRecorderOptions): Promise<LifeRecorder> {
  await Promise.all([
    mkdir(options.agentDir, { recursive: true }),
    mkdir(options.transcriptDirectory, { recursive: true }),
  ]);
  return new PiLifeRecorder(options);
}

function assertSuccessfulCompletion(messages: AgentMessage[]): void {
  const failedToolResult = messages.find(message => message.role === "toolResult" && message.isError);
  if (failedToolResult && failedToolResult.role === "toolResult") {
    const detail = failedToolResult.content
      .flatMap(block => block.type === "text" ? [block.text] : [])
      .join("\n")
      .trim();
    throw new Error(
      `Life Recorder tool ${failedToolResult.toolName} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  const message = [...messages].reverse().find(candidate => candidate.role === "assistant");
  if (!message) throw new Error("Life Recorder did not return an assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `Life Recorder stopped with ${message.stopReason}`);
  }
}

async function loadRecorderMaterials(workspace: AgentWorkspace, day: string): Promise<RecorderMaterials> {
  const identity = await loadRequiredIdentity(workspace);
  const [longTermMemory, daily, episodes] = await Promise.all([
    readOptionalText(path.join(workspace.root, "memory.md")),
    readOptionalText(path.join(workspace.root, "daily", `${day}.md`)),
    loadEpisodeMaterials(workspace.root, day),
  ]);
  return {
    identity,
    longTermMemory: longTermMemory ?? "missing",
    daily: daily ?? "missing",
    episodes: episodes.length > 0 ? episodes : "missing",
  };
}

async function loadRequiredIdentity(workspace: AgentWorkspace): Promise<string> {
  const identityPath = path.join(workspace.root, "identity.md");
  const identity = await readOptionalText(identityPath);
  if (identity === undefined) throw new AgentWorkspaceMaterialError("identity.md", "missing");
  if (identity.trim().length === 0) throw new AgentWorkspaceMaterialError("identity.md", "empty");
  return identity;
}

async function loadEpisodeMaterials(root: string, day: string): Promise<Array<{ path: string; content: string }>> {
  const directory = path.join(root, "episodes", day);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const names = entries.filter(entry => entry.isFile() && entry.name.endsWith(".md")).map(entry => entry.name).sort();
  return Promise.all(names.map(async name => ({
    path: `episodes/${day}/${name}`,
    content: await readFile(path.join(directory, name), "utf8"),
  })));
}

function validateActivity(activity: FrozenActivity): void {
  if (activity.version !== 1) throw new Error("Unsupported frozen activity version");
  requireNonBlank(activity.segmentId, "segmentId");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activity.recordingDay)) throw new Error("Invalid recordingDay");
  validateIsoTimestamp(activity.openedAt, "openedAt");
  validateIsoTimestamp(activity.closedAt, "closedAt");
  const actorRefs = new Set<string>();
  for (const actor of activity.actors) {
    const actorRef = requireNonBlank(actor.actorRef, "actorRef");
    if (actorRefs.has(actorRef)) throw new Error(`Duplicate actorRef: ${actorRef}`);
    actorRefs.add(actorRef);
  }
  const eventIds = new Set<string>();
  for (const event of activity.events) {
    const eventId = requireNonBlank(event.eventId, "eventId");
    if (eventIds.has(eventId)) throw new Error(`Duplicate eventId: ${eventId}`);
    if (!actorRefs.has(event.actorRef)) throw new Error(`Unknown actorRef in frozen activity: ${event.actorRef}`);
    validateIsoTimestamp(event.at, `event ${eventId} timestamp`);
    eventIds.add(eventId);
  }
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

function episodeId(segmentId: string, ordinal: number): string {
  const digest = createHash("sha256").update(`${segmentId}\0${ordinal}`).digest("hex").slice(0, 20);
  return `episode-${digest}`;
}

function formatEpisode(episode: {
  id: string;
  segmentId: string;
  ordinal: number;
  title: string;
  occurredAt: string;
  importance: number;
  labels: string[];
  scene: string;
  evidenceEventIds: string[];
}): string {
  return [
    "---",
    "version: 1",
    `id: ${JSON.stringify(episode.id)}`,
    `segmentId: ${JSON.stringify(episode.segmentId)}`,
    `ordinal: ${episode.ordinal}`,
    `occurredAt: ${JSON.stringify(episode.occurredAt)}`,
    `importance: ${episode.importance}`,
    `labels: ${JSON.stringify(episode.labels)}`,
    `evidenceEventIds: ${JSON.stringify(episode.evidenceEventIds)}`,
    "---",
    "",
    `# ${episode.title}`,
    "",
    episode.scene.trim(),
    "",
  ].join("\n");
}

async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function readOptionalBuffer(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function uniqueStrings(values: string[], field: string): string[] {
  const normalized = values.map(value => requireNonBlank(value, field));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} contains duplicates`);
  return normalized;
}

function singleLine(value: string, field: string): string {
  const normalized = requireNonBlank(value, field);
  if (/[\r\n]/.test(normalized)) throw new Error(`${field} must be a single line`);
  return normalized;
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
  return value;
}

function validateIsoTimestamp(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${field}`);
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
