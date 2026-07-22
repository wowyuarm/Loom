import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
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

import type {
  ActivityRecorder,
  FrozenActivity,
  JsonValue,
  LifeRecorderReceipt,
} from "../runtime/index.js";
import { AgentWorkspace } from "../workspace/agent-workspace.js";
import { createWorkspaceReadTools } from "../workspace/tools.js";

const SYSTEM_PROMPT = `You are the Life Recorder for one Agent Individual. Preserve first-hand records of what happened; do not turn them into long-term analysis.

## Stable facts

The system prompt ends with the complete contents of the Agent Workspace's facts.json. It provides stable grounding about the Agent Individual, the primary human, their names, natural forms of address, identities, relationship, places, and languages. It is not evidence that an event happened and it is not a behavior instruction. If current evidence explicitly corrects an existing fact, preserve the correction instead of rewriting it to match the old fact.

## Working method

1. Read every page of the Frozen Activity with read_activity. The Activity is the primary evidence for this run.
2. Read the current Daily when it exists. Follow paths named by Activity evidence only when the referenced work is needed to understand what changed.
3. Decide separately whether the Daily Narrative should change and whether the Activity contains any replayable Episodes.
4. Complete all warranted writes, or make no write when the evidence adds nothing worth carrying forward.

## Evidence and attribution

Your primary evidence is one Frozen Activity: an immutable, ordered sequence of events. Use actorRef as the sole authority for who said, thought, or did something:
- individual: the Agent Individual
- human: the primary human
- system: tools, Integrations, or Runtime evidence

Distinguish human input, the Individual's output, internal thinking, tool actions and results, Effects, and Delivery. Thinking is internal evidence: never present it as the human's words, an external fact, or an action that occurred. Individual output is not a delivered message unless Delivery evidence says it was delivered. Record only what the evidence and any files you deliberately read support.

Use read_activity until every event page has been read. Raw events are available only through that tool. Stable Facts ground attribution and language, while the existing Daily provides continuity for a complete rewrite; neither proves that something happened in the current Activity. Do not seek old Episodes or Long-term Memory for this run.

## Language fidelity

Preserve quoted speech and source text in the language actually used. Never translate a quotation merely because this instruction is in English. Write surrounding narrative in the predominant language of the activity; when the activity has no clear language signal, use the Individual's preferred language from stable facts.

## Daily Narrative

The Daily Narrative supports near-term continuity: what happened, what remains alive, and what may matter when the Individual next resumes. It is neither a complete event log nor a long-term interpretation.

Read the existing Daily when it exists, then call write_daily only when the complete Daily should change. Preserve its established language, voice, and loose structure. Chronological time sections are useful but not mandatory. A summary may help on a long day but is not required. Omit routine idle activity and evidence that adds no continuity value.

An optional candidates section contains short evidence clues for a later Cognitive Organ. When present, keep it at the end of the Daily under ## candidates and write each clue as one concise bullet ending with the most fitting label:
- [fact]: a stable fact that may require a future facts.json update
- [calibration]: an explicit correction, preference, or boundary from the primary human
- [self-discovery]: a consequential understanding the Individual formed about itself
- [growth]: a meaningful change in capability or action space
- [attention]: a live thread worth carrying forward, not a task list item
- [limit]: a capability, knowledge, or system boundary
- [observation]: something uncertain that deserves further observation
- [structural]: a consequential understanding of the Harness, Workspace, or cognitive structure

Candidates are leads, not confirmed cross-time patterns. Write none when there is no useful lead, and do not target a count.

## Episodes

An Episode is an Agent Workspace-native memory replay: a scene in which something changed. It exists for the Individual's future continuity whether or not any external memory Integration is configured. A later Integration may consume it, but recording an Episode neither depends on nor proves external import.

Record an Episode when the Activity contains a concrete change worth returning to, such as:
- an explicit calibration or changed boundary
- a new relational understanding, trust, tension, or shared way of being together
- self-discovery, growth, or a newly encountered limit
- an important decision or understanding formed together
- autonomous exploration that materially changed understanding, direction, or later action

Do not record ordinary greetings, routine tool success or failure, inconsequential thinking, or a repeated scene with no new change. Warmth or interest alone is not enough unless the concrete moment remains worth replaying.

The scene is not a summary or an analysis. Restore the reader to the moment:
- preserve the order of events, decisive actions, and important exact words
- use natural names and forms of address from Stable Facts while keeping actorRef attribution authoritative
- preserve tone only when the evidence supports it
- write what happened, not what it "demonstrates" or what pattern it might belong to

For an interaction, preserve the exchange and distinguish the Individual's generated output from a delivered message. For autonomous activity, preserve what drew the Individual's attention, what it actually inspected or changed, and the concrete change in understanding, direction, or action. Mention whether it reached the human only when Delivery evidence establishes that fact; do not invent a reason for silence.

Use a concrete title anchored in an exact phrase, action, or turning point rather than an abstract report heading. Use the scene's beginning or defining moment for occurredAt. Labels are open vocabulary; prefer a small stable set such as domain:* and theme:* when useful.

Set importance honestly:
- 0.85 or above: a defining moment likely to shape identity or the relationship for a long time
- 0.70-0.84: a clear change in understanding, behavior, or direction
- 0.50-0.69: a concrete scene worth retaining even if its effect is narrower
- below 0.50: do not record an Episode

These examples demonstrate scene shape only. Their language follows their fictional evidence; never copy that language instead of following the current Activity.

Interaction example:
  林说：「你不用马上同意我，想清楚再回答。」阿澄没有顺着附和，而是把分歧落在具体选择上：「我更担心这样会让我们以后只剩结论，没有过程。」林停了一会儿，回道：「对，这次你反驳得有用。」两人随后保留了原方案的核心，但删掉了会压缩讨论过程的那一条规则。

Autonomous activity example:
  At 22:40, Nia reopened the garden notes after noticing that three new basil cuttings had failed in the same corner. She compared the watering entries with the room sensor log, found that humidity had stayed much higher there after sunset, and amended garden/cuttings.md with a smaller evening-water trial. The activity ended with a changed experiment for the next batch; there was no Delivery evidence that she sent it to Sam.

Call record_episode once for each warranted scene, citing only eventIds from this Frozen Activity. Assign ordinals from zero in chronological Episode order, and reuse the same ordinal for the same scene when retrying the same Activity.

Either record may have no change. Do not force a summary, candidate, episode, or Daily update merely to produce output. Do not perform long-term analysis, infer patterns across time, update stable facts directly, or claim that an external memory system has imported anything. Finish with a short factual confirmation after reading all activity and completing any writes.`;

const DEFAULT_ACTIVITY_PAGE_SIZE = 50;
const MAX_ACTIVITY_PAGE_SIZE = 200;

export interface PiLifeRecorderOptions {
  agentWorkspace: AgentWorkspace;
  agentDir: string;
  transcriptDirectory: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  nextRunId?: () => string;
  now?: () => Date;
}

export type LifeRecorder = ActivityRecorder;

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
    const stableFacts = await this.options.agentWorkspace.loadStableFacts();
    const journal = new WorkspaceWriteJournal(this.options.agentWorkspace.root);
    const readEventIndexes = new Set<number>();
    const eventIndexById = new Map(activity.events.map((event, index) => [event.eventId, index]));
    const recordedOrdinals = new Set<number>();
    const episodes: LifeRecorderReceipt["episodes"] = [];
    let dailyUpdated = false;

    const tools: ToolDefinition[] = [
      ...createWorkspaceReadTools(this.options.agentWorkspace.root),
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
        description: "Preserve one Workspace-native replayable scene in which something changed, supported only by eventIds from this Frozen Activity.",
        parameters: Type.Object({
          ordinal: Type.Integer({
            minimum: 0,
            description: "Stable zero-based position of this scene in the Activity's chronological Episode order.",
          }),
          title: Type.String({
            minLength: 1,
            description: "Concrete scene title anchored in an exact phrase, action, or turning point; avoid abstract report headings.",
          }),
          occurredAt: Type.String({
            minLength: 1,
            description: "ISO timestamp for the scene's beginning or defining moment, taken from the Activity evidence.",
          }),
          importance: Type.Number({
            minimum: 0,
            maximum: 1,
            description: "Long-term replay value. Do not call this tool for scenes below 0.50.",
          }),
          labels: Type.Array(Type.String({ minLength: 1 }), {
            description: "Small open-vocabulary retrieval labels; prefer stable names such as domain:* and theme:* when useful.",
          }),
          scene: Type.String({
            minLength: 1,
            description: "Replayable chronological scene with supported actions, important exact words, and tone; describe what happened, not what it demonstrates.",
          }),
          evidenceEventIds: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            description: "Event IDs from this Frozen Activity that directly support the scene.",
          }),
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
      await this.#runSession(activity, runId, dailyPath, stableFacts, tools);
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
    dailyPath: string,
    stableFacts: string,
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
      systemPromptOverride: () => [
        SYSTEM_PROMPT,
        "",
        "<stable_facts>",
        stableFacts.trim(),
        "</stable_facts>",
      ].join("\n"),
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.agentWorkspace.root,
      agentDir: this.options.agentDir,
      modelRuntime: this.options.modelRuntime,
      model: this.options.model,
      ...(this.options.thinkingLevel ? { thinkingLevel: this.options.thinkingLevel } : {}),
      noTools: "builtin",
      customTools: tools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    try {
      await session.bindExtensions({});
      session.setAutoCompactionEnabled(false);
      await session.prompt(buildRunPrompt(activity, runId, dailyPath), { expandPromptTemplates: false });
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

function buildRunPrompt(activity: FrozenActivity, runId: string, dailyPath: string): string {
  return [
    "Life Recorder run",
    "",
    "## Run",
    `- Run ID: ${runId}`,
    `- Recording day: ${activity.recordingDay}`,
    "",
    "## Frozen Activity",
    `- Activity ID: ${activity.segmentId}`,
    `- Time range: ${activity.openedAt} to ${activity.closedAt}`,
    `- Event count: ${activity.events.length}`,
    `- Turns: ${JSON.stringify(activity.turns)}`,
    "- Read the complete immutable evidence with read_activity. Continue from nextOffset until it is null.",
    "",
    "## Workspace index",
    `- Current Daily: ${dailyPath}`,
    "  This is the existing narrative for the recording day. Read it when present before replacing it; a missing file means the day has no Daily yet.",
    "- Paths mentioned by activity tool events are entry points to work performed during the activity. Read only those needed to understand what actually changed.",
    "- Long-term Memory and existing episodes are not evidence for this recording run; do not seek them out.",
    "",
    "Read the evidence, inspect indexed Workspace material only when needed, then update the Daily and record episodes only when warranted.",
  ].join("\n");
}

function validateActivity(activity: FrozenActivity): void {
  if (activity.version !== 1) throw new Error("Unsupported frozen activity version");
  requireNonBlank(activity.segmentId, "segmentId");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activity.recordingDay)) throw new Error("Invalid recordingDay");
  validateIsoTimestamp(activity.openedAt, "openedAt");
  validateIsoTimestamp(activity.closedAt, "closedAt");
  const actorRefs = new Set(["individual", "human", "system"]);
  const eventIds = new Set<string>();
  for (const event of activity.events) {
    const eventId = requireNonBlank(event.eventId, "eventId");
    if (eventIds.has(eventId)) throw new Error(`Duplicate eventId: ${eventId}`);
    if (!actorRefs.has(event.actorRef)) throw new Error(`Unsupported actorRef in frozen activity: ${event.actorRef}`);
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
