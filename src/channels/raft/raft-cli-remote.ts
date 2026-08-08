import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

import {
  RaftRetryableError,
  type RaftInboxBatch,
  type RaftRemote,
  type RaftRemoteActivity,
  type RaftRemoteMessage,
  type RaftRemoteOpenResult,
  type RaftRemotePage,
  type RaftRemotePlace,
  type RaftRemoteSearchResult,
  type RaftRemoteStatus,
} from "./raft-channel.js";
import type { JsonValue } from "../../runtime/index.js";
import {
  RaftCliCommandError,
  SUPPORTED_RAFT_CLI_VERSION,
  assertEqual,
  cursorOffset,
  decodeXml,
  directMessageHandle,
  dmPlaceEvidence,
  dmPlaceFor,
  errorMessage,
  escapeRegExp,
  historyEvidence,
  jsonObject,
  localTimestamp,
  objectField,
  parseChannelInfo,
  parseHistory,
  parseInboxNotices,
  parseInboxSpoolEntry,
  parseResolvedMessageHeader,
  parseTarget,
  parseTaskReference,
  rejectedMutation,
  required,
  resolvedContent,
  safePlaceLabel,
  signalFor,
  signalForFast,
  stringField,
  taskAssignment,
  taskContent,
  validateBridgeWake,
  type HistoryMessage,
  type InboxSpoolEntry,
  type RaftProfile,
} from "./raft-cli-parse.js";

export { SUPPORTED_RAFT_CLI_VERSION };

export interface OpenRaftCliRemoteOptions {
  profile: string;
  expectedServerId: string;
  expectedSelfMemberId: string;
  expectedPrincipalMemberId: string;
  principalDmTarget: string;
  bridgeStateDirectory: string;
  cliEntrypoint?: string;
  /** Bounded wait for one CLI command before the child is terminated and the call fails retryable. */
  commandTimeoutMs?: number;
}

class DefaultRaftCliRemote implements RaftRemote {
  readonly #entrypoint: string;
  readonly #profile: string;
  #selfProfile!: RaftProfile;
  readonly #profilesByHandle = new Map<string, RaftProfile>();
  #bridgeServer: Server | undefined;
  #bridgeProcess: ChildProcessWithoutNullStreams | undefined;
  #bridgeStop: Promise<void> | undefined;
  #bridgeState: "stopped" | "available" | "unavailable" = "stopped";
  #bridgeError: string | undefined;

  readonly #commandTimeoutMs: number;

  constructor(private readonly options: OpenRaftCliRemoteOptions) {
    this.#profile = required(options.profile, "Raft profile");
    this.#entrypoint = options.cliEntrypoint ?? packagedRaftEntrypoint();
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
  }

  async validate(): Promise<void> {
    const version = (await this.#run(["--version"], { useProfile: false })).stdout.trim();
    if (version !== SUPPORTED_RAFT_CLI_VERSION) {
      throw new Error(`Raft CLI ${version || "returned no version"}; Loom requires ${SUPPORTED_RAFT_CLI_VERSION}`);
    }

    const whoami = jsonObject(await this.#run(["auth", "whoami"]), "Raft auth whoami");
    const identity = objectField(whoami, "data", "Raft auth whoami");
    assertEqual(identity.agentId, this.options.expectedSelfMemberId, "Raft self member binding");
    assertEqual(identity.serverId, this.options.expectedServerId, "Raft server binding");

    this.#selfProfile = await this.#profileFor();
    assertEqual(this.#selfProfile.id, this.options.expectedSelfMemberId, "Raft self profile binding");
    if (this.#selfProfile.kind !== "agent") throw new Error("Raft self profile must be an agent");

    const principalHandle = directMessageHandle(this.options.principalDmTarget);
    const principal = await this.#profileFor(principalHandle);
    assertEqual(principal.id, this.options.expectedPrincipalMemberId, "Raft principal member binding");
    if (principal.kind !== "human") throw new Error("Raft principal member must be human");
  }

  async start(acceptWake: Parameters<NonNullable<RaftRemote["start"]>>[0]): Promise<void> {
    if (this.#bridgeServer || this.#bridgeProcess) return;
    await mkdir(this.options.bridgeStateDirectory, { recursive: true });
    const token = randomBytes(24).toString("base64url");
    const server = createServer((request, response) => {
      void this.#handleBridgeRequest(request, response, token, acceptWake);
    });
    this.#bridgeServer = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Raft wake endpoint did not bind a TCP port");
      const endpoint = `http://127.0.0.1:${address.port}/wake`;
      const child = this.#spawn([
        "agent", "bridge",
        "--json",
        "--wake-adapter", "wake-channel",
        "--wake-channel-endpoint", endpoint,
        "--adapter-instance", "loom",
        "--state-dir", this.options.bridgeStateDirectory,
      ], { RAFT_CHANNEL_TOKEN: token });
      this.#bridgeProcess = child;
      await bridgeStarted(child);
      this.#bridgeState = "available";
      child.stdout.resume();
      child.stderr.on("data", chunk => {
        const message = String(chunk).trim();
        if (message) this.#bridgeError = message.slice(-2_000);
      });
      child.once("error", error => this.#bridgeFailed(errorMessage(error)));
      child.once("close", (code, signal) => {
        if (this.#bridgeProcess === child) {
          this.#bridgeFailed(`Raft bridge exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`);
        }
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#bridgeStop) return this.#bridgeStop;
    this.#bridgeStop = this.#finishStop();
    return this.#bridgeStop;
  }

  async #finishStop(): Promise<void> {
    this.#bridgeState = "stopped";
    const server = this.#bridgeServer;
    this.#bridgeServer = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
    const child = this.#bridgeProcess;
    this.#bridgeProcess = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child.once("close", () => resolve()));
    }
  }

  status(): RaftRemoteStatus {
    return {
      available: this.#bridgeState === "available",
      cliVersion: SUPPORTED_RAFT_CLI_VERSION,
      serverId: this.options.expectedServerId,
      selfMemberId: this.options.expectedSelfMemberId,
      ...(this.#bridgeError ? { lastError: this.#bridgeError } : {}),
    };
  }

  async drainInbox(): Promise<RaftInboxBatch> {
    const prior = await this.#readInboxSpool();
    const output = (await this.#run(["message", "check"])).stdout;
    const merged = new Map(prior.map(entry => [entry.receiptId, entry]));
    for (const entry of parseInboxNotices(output)) {
      const existing = merged.get(entry.receiptId);
      merged.set(entry.receiptId, { ...existing, ...entry });
    }
    const spool = [...merged.values()];
    await this.#writeInboxSpool(spool);

    const completed: InboxSpoolEntry[] = [];
    for (const entry of spool) {
      if (entry.messageId) {
        completed.push(entry);
        continue;
      }
      try {
        const resolved = parseResolvedMessageHeader(
          (await this.#run(["message", "resolve", entry.shortId])).stdout.trimEnd(),
        );
        entry.target = resolved.target;
        await this.#writeInboxSpool(spool);
        const history = await this.#readHistory(entry.target, entry.shortId, 1);
        const match = history.find(row => row.messageId.toLowerCase().startsWith(entry.shortId.toLowerCase()));
        if (!match) throw new Error(`Raft inbox message ${entry.shortId} was not found in its history`);
        entry.messageId = match.messageId;
        delete entry.lastError;
        await this.#writeInboxSpool(spool);
        completed.push(entry);
      } catch (error) {
        // Isolate one bad receipt: keep it in the spool for recovery, never
        // drop it or guess its content, and let the rest of the batch proceed.
        entry.lastError = errorMessage(error).slice(0, 200);
        await this.#writeInboxSpool(spool);
      }
    }

    const receiptIds = new Set(completed.map(entry => entry.receiptId));
    const messages = new Map<string, InboxSpoolEntry>();
    for (const entry of completed) {
      if (!messages.has(entry.messageId!)) messages.set(entry.messageId!, entry);
    }
    const spooled = spool.filter(entry => !entry.messageId);
    return {
      entries: [...messages.values()].map(entry => ({
        receiptId: entry.receiptId,
        messageId: entry.messageId!,
        receivedAt: entry.receivedAt,
      })),
      spooled: spooled.length,
      ...(spooled.length > 0
        ? { spooledOldestAt: spooled.map(entry => entry.receivedAt).sort()[0]! }
        : {}),
      acknowledge: async () => {
        const current = await this.#readInboxSpool();
        await this.#writeInboxSpool(current.filter(entry => !receiptIds.has(entry.receiptId)));
      },
    };
  }

  async resolveMessage(messageId: string): Promise<RaftRemoteMessage> {
    const canonicalId = required(messageId, "Raft message id");
    const output = (await this.#run(["message", "resolve", canonicalId])).stdout.trimEnd();
    const { target, shortId, localTime, senderKind, senderHandle, remainder } = parseResolvedMessageHeader(output);
    if (!canonicalId.toLowerCase().startsWith(shortId!.toLowerCase())) {
      throw new Error("Raft message resolve returned a different message id");
    }
    const sender = senderKind === "system" ? undefined : await this.#profileFor(senderHandle!);
    if (sender && sender.kind !== senderKind) throw new Error("Raft message sender kind disagrees with its profile");
    const content = resolvedContent(remainder!, sender?.description);
    const place = await this.#placeFor(target!);
    const task = taskAssignment(content);
    return {
      messageId: canonicalId,
      occurredAt: localTimestamp(localTime!),
      signal: await this.#signalFor(target!, content),
      content,
      sender: {
        memberId: sender?.id ?? `system:${senderHandle}`,
        kind: senderKind as "human" | "agent" | "system",
        handle: sender?.name ?? senderHandle!,
        ...(sender?.displayName?.trim() ? { displayName: sender.displayName.trim() } : {}),
      },
      place,
      ...(task ? { task } : {}),
    };
  }

  async sendText(request: { target: string; text: string }): Promise<
    | { disposition: "sent"; remoteId: string }
    | { disposition: "held" | "rejected"; error: string }
  > {
    const target = required(request.target, "Raft message target");
    const text = required(request.text, "Raft message text");
    const result = await this.#run(["message", "send", "--target", target], { stdin: text });
    const sent = /^Message sent to .+\. Message ID: ([0-9a-f-]+)/im.exec(result.stdout);
    if (sent) return { disposition: "sent", remoteId: sent[1]! };
    if (/^(?:Freshness hold:|Unreviewed synced context)/m.test(result.stdout)) {
      return {
        disposition: "held",
        error: result.stdout.trim().split("\n", 1)[0]!,
      };
    }
    throw new Error("Raft message send returned an outcome Loom cannot confirm");
  }

  async listPlaces(request: {
    scope: "attention" | "joined" | "discoverable";
    kind?: "channel" | "dm";
    visibility?: "public" | "private";
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<RaftRemotePage<RaftRemotePlace>> {
    if (request.kind === "dm") {
      throw new Error("Raft CLI 0.0.17 cannot list DMs without reading message history");
    }
    const offset = cursorOffset(request.cursor);
    const args = ["server", "info", "--channels"];
    if (request.scope !== "discoverable") args.push("--joined");
    if (request.query?.trim()) args.push("--query", request.query.trim());
    args.push("--limit", String(request.limit), "--offset", String(offset));
    const output = (await this.#run(args)).stdout;
    const items = [...output.matchAll(/^#([A-Za-z0-9_-]+) \[(public|private), (joined|not joined)(?:, (muted|not muted))?(?:, (archived|not archived))?\](?: — .*)?$/gm)]
      .map(match => ({
        target: `#${match[1]}`,
        kind: "channel" as const,
        visibility: match[2] as "public" | "private",
        label: match[1]!,
        joined: match[3] === "joined",
        ...(match[4] ? { muted: match[4] === "muted" } : {}),
      }))
      .filter(place => !request.visibility || place.visibility === request.visibility);
    const nextOffset = /More: .*--offset ([0-9]+)/.exec(output)?.[1];
    return {
      items,
      ...(nextOffset ? { nextCursor: nextOffset } : {}),
    };
  }

  async readActivity(request: {
    signals: string[];
    placeTarget?: string;
    after?: string;
    before?: string;
    cursor?: string;
    limit: number;
  }): Promise<RaftRemotePage<RaftRemoteActivity>> {
    if (!request.placeTarget && !request.after && !request.before) {
      throw new Error("Raft activity reading requires a place or time bound");
    }
    const page = await this.#search({
      ...(request.placeTarget ? { placeTarget: request.placeTarget } : {}),
      ...(request.after ? { after: request.after } : {}),
      ...(request.before ? { before: request.before } : {}),
      sort: "recent",
      ...(request.cursor ? { cursor: request.cursor } : {}),
      limit: request.limit,
    });
    const items = await Promise.all(page.items.map(async item => ({
      signal: await this.#signalFor(item.place.target, item.preview),
      occurredAt: item.occurredAt,
      place: item.place,
      sender: item.sender,
      references: item.references,
      summary: item.preview,
    })));
    const filtered = items.filter(item => request.signals.includes(item.signal));
    return { items: filtered, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async searchMessages(request: {
    query: string;
    placeTarget?: string;
    senderHandle?: string;
    after?: string;
    before?: string;
    sort: "relevance" | "recent";
    cursor?: string;
    limit: number;
  }): Promise<RaftRemotePage<RaftRemoteSearchResult>> {
    return this.#search(request);
  }

  async openReference(request: {
    kind: "message" | "place" | "destination" | "thread" | "task" | "member" | "reminder";
    value: string;
    aroundValue?: string;
    before: number;
    after: number;
    cursor?: string;
    limit: number;
  }): Promise<RaftRemoteOpenResult> {
    if (request.cursor || (request.aroundValue && request.kind !== "thread")) {
      throw new Error("Raft CLI 0.0.17 cannot page an opaque open operation without exposing CLI cursors");
    }
    if (request.kind === "message") {
      const message = await this.resolveMessage(request.value);
      const parsedTarget = parseTarget(message.place.target);
      const messageEvidence = {
        occurredAt: message.occurredAt,
        signal: message.signal,
        content: message.content,
        sender: {
          kind: message.sender.kind,
          ...(message.sender.handle ? { handle: `@${message.sender.handle.replace(/^@/, "")}` } : {}),
          ...(message.sender.displayName ? { displayName: message.sender.displayName } : {}),
        },
        place: {
          kind: message.place.kind,
          visibility: message.place.visibility,
          ...(message.place.label ? { label: safePlaceLabel(message.place.target, message.place.label) } : {}),
        },
        audience: message.place.audience,
        visibility: message.place.visibility,
      } satisfies JsonValue;
      const thread = parsedTarget.thread
        ? await this.#openThreadContext(message.place.target, request.value, request.before, request.after, request.limit)
        : undefined;
      return {
        objectKind: "message",
        evidence: { ...messageEvidence, ...(thread ? { thread } : {}) },
        references: [
          { kind: "place", value: message.place.target },
          ...(parsedTarget.thread ? [{ kind: "destination" as const, value: message.place.target }] : []),
          ...(message.sender.handle ? [{ kind: "member" as const, value: message.sender.handle }] : []),
        ],
      };
    }
    if (request.kind === "task") {
      const reference = parseTaskReference(request.value);
      const message = await this.resolveMessage(reference.messageId);
      if (!message.task || message.task.number !== reference.number) {
        throw new Error("Raft task ref no longer identifies the expected task");
      }
      if (parseTarget(message.place.target).base !== parseTarget(reference.target).base) {
        throw new Error("Raft task ref resolved in a different place");
      }
      return {
        objectKind: "task",
        evidence: {
          number: message.task.number,
          status: message.task.status,
          content: taskContent(message.content),
          ...(message.task.assigneeType || message.task.assigneeId || message.task.assigneeHandle ? {
            assignee: {
              ...(message.task.assigneeType ? { kind: message.task.assigneeType } : {}),
              ...(message.task.assigneeId ? { memberId: message.task.assigneeId } : {}),
              ...(message.task.assigneeHandle ? { handle: message.task.assigneeHandle } : {}),
            },
          } : {}),
          createdBy: {
            kind: message.sender.kind,
            ...(message.sender.handle ? { handle: `@${message.sender.handle.replace(/^@/, "")}` } : {}),
            ...(message.sender.displayName ? { displayName: message.sender.displayName } : {}),
          },
          place: {
            kind: message.place.kind,
            visibility: message.place.visibility,
            ...(message.place.label ? { label: safePlaceLabel(message.place.target, message.place.label) } : {}),
          },
          visibility: message.place.visibility,
        },
        references: [
          { kind: "message", value: message.messageId },
          { kind: "place", value: message.place.target },
        ],
      };
    }
    if (request.kind === "member") {
      const profile = await this.#profileFor(request.value);
      return {
        objectKind: "member",
        evidence: {
          kind: profile.kind,
          handle: `@${profile.name}`,
          ...(profile.displayName?.trim() ? { displayName: profile.displayName.trim() } : {}),
          ...(profile.description?.trim() ? { description: profile.description.trim() } : {}),
        },
        references: [],
      };
    }
    if (request.kind === "thread") {
      const parsed = parseTarget(request.value);
      if (!parsed.thread) throw new Error("Raft thread ref must identify a reply thread");
      const threadId = request.value.slice(parsed.base.length + 1);
      return {
        objectKind: "thread",
        evidence: {
          place: await this.#placeEvidence(request.value),
          thread: await this.#openThreadContext(
            request.value,
            request.aroundValue ?? threadId,
            request.before,
            request.after,
            request.limit,
          ),
        },
        references: [{ kind: "destination", value: request.value }],
      };
    }
    if (request.kind === "place" || request.kind === "destination") {
      const place = await this.#placeEvidence(request.value);
      return {
        objectKind: request.kind,
        evidence: place,
        references: [],
      };
    }
    throw new Error(`Raft ${request.kind} reading is unavailable in CLI ${SUPPORTED_RAFT_CLI_VERSION}`);
  }

  async #openThreadContext(
    threadTarget: string,
    aroundMessage: string,
    before: number,
    after: number,
    limit: number,
  ): Promise<JsonValue> {
    const parsed = parseTarget(threadTarget);
    const threadId = threadTarget.slice(parsed.base.length + 1);
    const anchorPage = await this.#readHistory(parsed.base, threadId, 1);
    const replyPage = await this.#readHistory(threadTarget, aroundMessage, Math.max(1, Math.min(limit, before + after + 1)));
    const [anchorPlace, replyPlace] = await Promise.all([
      this.#placeFor(parsed.base),
      this.#placeFor(threadTarget),
    ]);
    const anchor = anchorPage[0] ? await this.#historyEvidence(anchorPage[0], anchorPlace) : null;
    const replies = await Promise.all(replyPage.map(row => this.#historyEvidence(row, replyPlace)));
    return {
      anchor,
      replies,
    };
  }

  async #readHistory(target: string, around: string, limit: number): Promise<HistoryMessage[]> {
    const output = (await this.#run(["message", "read", "--target", target, "--around", around, "--limit", String(limit)])).stdout;
    return parseHistory(output);
  }

  async #readInboxSpool(): Promise<InboxSpoolEntry[]> {
    try {
      const value = JSON.parse(await readFile(this.#inboxSpoolFile(), "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("Raft inbox spool is not an array");
      return value.map(parseInboxSpoolEntry);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async #writeInboxSpool(entries: InboxSpoolEntry[]): Promise<void> {
    await mkdir(this.options.bridgeStateDirectory, { recursive: true });
    const file = this.#inboxSpoolFile();
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  #inboxSpoolFile(): string {
    return path.join(this.options.bridgeStateDirectory, "loom-inbox-spool.json");
  }

  async #historyEvidence(message: HistoryMessage, place: RaftRemoteMessage["place"]): Promise<JsonValue> {
    const sender = message.senderType === "system" ? undefined : await this.#profileFor(message.senderName);
    return historyEvidence(message, place, sender);
  }

  async #profileFor(handle?: string): Promise<RaftProfile> {
    const requestedHandle = handle?.replace(/^@/, "").trim();
    const candidates = requestedHandle
      ? [...new Set([requestedHandle, requestedHandle.toLowerCase()])]
      : [undefined];
    let lastError: unknown;
    for (const candidate of candidates) {
      if (candidate && this.#profilesByHandle.has(candidate)) return this.#profilesByHandle.get(candidate)!;
      try {
        const args = ["profile", "show"];
        if (candidate) args.push(`@${candidate}`);
        args.push("--json");
        const document = jsonObject(await this.#run(args), "Raft profile show");
        const data = objectField(document, "data", "Raft profile show");
        const kind = data.kind;
        if (kind !== "human" && kind !== "agent") throw new Error("Raft profile show returned an unsupported member kind");
        const profile: RaftProfile = {
          id: stringField(data, "id", "Raft profile show"),
          kind,
          name: stringField(data, "name", "Raft profile show"),
          ...(typeof data.displayName === "string" || data.displayName === null
            ? { displayName: data.displayName }
            : {}),
          ...(typeof data.description === "string" || data.description === null
            ? { description: data.description }
            : {}),
        };
        this.#profilesByHandle.set(profile.name, profile);
        this.#profilesByHandle.set(profile.name.toLowerCase(), profile);
        if (candidate) this.#profilesByHandle.set(candidate, profile);
        return profile;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Raft profile show failed");
  }

  async #search(request: {
    query?: string;
    placeTarget?: string;
    senderHandle?: string;
    after?: string;
    before?: string;
    sort: "relevance" | "recent";
    cursor?: string;
    limit: number;
  }): Promise<RaftRemotePage<RaftRemoteSearchResult>> {
    const offset = cursorOffset(request.cursor);
    const args = ["message", "search"];
    if (request.query?.trim()) args.push("--query", request.query.trim());
    if (request.placeTarget) args.push("--target", request.placeTarget);
    if (request.senderHandle) args.push("--sender", `@${request.senderHandle.replace(/^@/, "")}`);
    if (request.after) args.push("--after", request.after);
    if (request.before) args.push("--before", request.before);
    args.push("--sort", request.sort, "--limit", String(request.limit), "--offset", String(offset));
    const output = (await this.#run(args)).stdout;
    const blocks = [...output.matchAll(/<result ref="msg:([^"]+)">\nSource: ([^\n]+)\nSender: ([A-Za-z0-9_-]+) \((human|agent|system)\)\nTime: ([^\n]+)\n\n<preview>\n([\s\S]*?)\n<\/preview>\n<\/result>/g)];
    const items = await Promise.all(blocks.map(async match => {
      const sender = match[4] === "system" ? undefined : await this.#profileFor(match[3]!);
      if (sender && sender.kind !== match[4]) throw new Error("Raft search sender kind disagrees with its profile");
      const place = await this.#searchPlace(match[2]!);
      const preview = decodeXml(match[6]!.trim());
      const task = taskAssignment(preview);
      return {
        messageId: match[1]!,
        occurredAt: localTimestamp(match[5]!),
        place,
        sender: {
          memberId: sender?.id ?? `system:${match[3]}`,
          kind: match[4] as "human" | "agent" | "system",
          handle: sender?.name ?? match[3]!,
          ...(sender?.displayName?.trim() ? { displayName: sender.displayName.trim() } : {}),
        },
        preview,
        references: [
          { kind: "message" as const, value: match[1]! },
          ...(task ? [{
            kind: "task" as const,
            value: JSON.stringify({
              target: parseTarget(place.target).base,
              number: task.number,
              messageId: match[1]!,
            }),
          }] : []),
        ],
      } satisfies RaftRemoteSearchResult;
    }));
    return {
      items,
      ...(items.length === request.limit ? { nextCursor: String(offset + request.limit) } : {}),
    };
  }

  async mutateTask(request: {
    action: "claim" | "unclaim" | "update";
    target: string;
    number: number;
    messageId: string;
    status?: "in_progress" | "in_review" | "done";
  }): Promise<
    | { disposition: "succeeded"; remoteId: string }
    | { disposition: "rejected"; error: string }
  > {
    const target = required(request.target, "Raft task target");
    if (!Number.isInteger(request.number) || request.number < 1) throw new Error("Raft task number must be positive");
    required(request.messageId, "Raft task message id");
    const args = ["task", request.action, "--target", target, "--number", String(request.number)];
    if (request.action === "update") {
      if (!request.status) throw new Error("Raft task update requires status");
      args.push("--status", request.status);
    }
    try {
      await this.#run(args);
    } catch (error) {
      const rejected = rejectedMutation(error);
      if (rejected) return { disposition: "rejected", error: rejected };
      throw error;
    }
    return {
      disposition: "succeeded",
      remoteId: `raft-task:${target}:${request.number}:${request.action}${request.status ? `:${request.status}` : ""}`,
    };
  }

  async mutateAttention(request: {
    action: "unfollow_thread" | "mute_channel" | "unmute_channel";
    target: string;
    reason?: string;
  }): Promise<
    | { disposition: "succeeded"; remoteId: string }
    | { disposition: "rejected"; error: string }
  > {
    const target = required(request.target, "Raft attention target");
    const reason = request.reason?.trim();
    let args: string[];
    if (request.action === "unfollow_thread") {
      args = ["thread", "unfollow", "--target", target];
      if (reason) args.push("--reason", reason);
    } else {
      if (reason) throw new Error(`Raft ${request.action} does not accept reason`);
      args = ["channel", request.action === "mute_channel" ? "mute" : "unmute", "--target", target];
    }
    try {
      await this.#run(args);
    } catch (error) {
      const rejected = rejectedMutation(error);
      if (rejected) return { disposition: "rejected", error: rejected };
      throw error;
    }
    return {
      disposition: "succeeded",
      remoteId: `raft-attention:${request.action}:${target}`,
    };
  }

  async #searchPlace(source: string): Promise<RaftRemotePlace> {
    const channel = /^channel:([A-Za-z0-9_-]+)$/.exec(source);
    if (channel) return this.#channelPlace(`#${channel[1]}`);
    const thread = /^thread:([A-Za-z0-9_-]+):([0-9a-f]{8})$/i.exec(source);
    if (thread) {
      const base = await this.#channelPlace(`#${thread[1]}`);
      return { ...base, target: `#${thread[1]}:${thread[2]}`, kind: "reply_thread" };
    }
    const dm = /^dm:([A-Za-z0-9_-]+)(?::([0-9a-f]{8}))?$/i.exec(source);
    if (dm) {
      return {
        target: `dm:@${dm[1]}${dm[2] ? `:${dm[2]}` : ""}`,
        kind: dm[2] ? "reply_thread" : "dm",
        visibility: "private",
        label: dm[2] ? `DM with @${dm[1]} reply thread` : `DM with @${dm[1]}`,
      };
    }
    throw new Error("Raft message search returned an unsupported source");
  }

  async #channelPlace(target: string): Promise<RaftRemotePlace> {
    const info = (await this.#run(["channel", "info", target])).stdout;
    return parseChannelInfo(info, target);
  }

  async #placeEvidence(target: string): Promise<JsonValue> {
    const parsed = parseTarget(target);
    if (parsed.base.startsWith("dm:@")) {
      return dmPlaceEvidence(target);
    }
    const place = await this.#channelPlace(parsed.base);
    return {
      kind: parsed.thread ? "reply_thread" : "channel",
      visibility: place.visibility,
      label: safePlaceLabel(target),
      joined: place.joined ?? false,
      ...(place.muted !== undefined ? { muted: place.muted } : {}),
    };
  }

  async #placeFor(target: string): Promise<RaftRemoteMessage["place"]> {
    const parsed = parseTarget(target);
    if (parsed.base.startsWith("dm:@")) {
      return dmPlaceFor(target);
    }
    const place = await this.#channelPlace(parsed.base);
    return {
      target,
      kind: parsed.thread ? "reply_thread" : "channel",
      visibility: place.visibility,
      label: parsed.thread ? `${parsed.base} reply thread` : parsed.base,
      audience: parsed.thread
        ? `Members of ${parsed.base} can read this reply thread.`
        : `Members of ${parsed.base} can read this channel.`,
    };
  }

  async #signalFor(target: string, content: string): Promise<RaftRemoteMessage["signal"]> {
    const selfMember = {
      id: this.options.expectedSelfMemberId,
      name: this.#selfProfile.name,
    };
    const fast = signalForFast(content, target, selfMember);
    if (fast !== undefined) return fast;
    return signalFor(content, target, selfMember, await this.#participatesInThread(target));
  }

  async #participatesInThread(target: string): Promise<boolean> {
    const output = (await this.#run(["channel", "members", target])).stdout;
    return new RegExp(
      `^\\s*-\\s+@${escapeRegExp(this.#selfProfile.name)}(?:\\s|\\()`,
      "im",
    ).test(output);
  }

  async #run(
    args: string[],
    options: { stdin?: string; useProfile?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.#spawn(args, {}, options.useProfile === false);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      // A hung CLI child must not pin the serial drain forever; terminate it and
      // fail retryable so the rest of the batch can proceed.
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new RaftRetryableError(
          `Raft CLI command timed out after ${this.#commandTimeoutMs}ms`,
        ));
      }, this.#commandTimeoutMs);
      child.on("error", error => {
        clearTimeout(timer);
        reject(new RaftRetryableError(error.message));
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else {
          const failure = new RaftCliCommandError(stderr, stdout, code);
          // Permanent for known codes and the <OP>_FAILED family (deterministic
          // conflicts); retryable only for SERVER_5XX and rate-limit summaries.
          reject(failure.permanent ? failure : new RaftRetryableError(failure.message));
        }
      });
      child.stdin.end(options.stdin ?? "");
    });
  }

  #bridgeFailed(message: string): void {
    this.#bridgeState = "unavailable";
    this.#bridgeError = message;
  }

  #spawn(args: string[], extraEnv: NodeJS.ProcessEnv = {}, withoutProfile = false): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [
      this.#entrypoint,
      ...(withoutProfile ? [] : ["--profile", this.#profile]),
      ...args,
    ], {
      env: { ...process.env, TZ: "UTC", ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  async #handleBridgeRequest(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    token: string,
    acceptWake: Parameters<NonNullable<RaftRemote["start"]>>[0],
  ): Promise<void> {
    response.setHeader("content-type", "application/json");
    if (request.headers["x-raft-bridge-token"] !== token) {
      response.statusCode = 401;
      response.end(JSON.stringify({ ok: false, reason: "invalid bridge token" }));
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/activity/drain") {
      response.statusCode = 200;
      response.end(JSON.stringify({
        schema: "raft-activity-drain.v1",
        events: [],
        dropped: 0,
      }));
      return;
    }
    if (request.method !== "POST" || pathname !== "/wake") {
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, reason: "unknown endpoint" }));
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await readWakePayload(request);
      validateBridgeWake(payload, {
        profile: this.#profile,
        agentId: this.options.expectedSelfMemberId,
      });
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, reason: errorMessage(error) }));
      return;
    }
    try {
      await acceptWake({
        attemptId: String(payload.attemptId),
        messageId: String(payload.messageId),
        receivedAt: String(payload.occurredAt),
      });
      response.statusCode = 200;
      response.end(JSON.stringify({
        ok: true,
        runtimeSession: `loom:${this.options.expectedSelfMemberId}`,
      }));
    } catch (error) {
      response.statusCode = 503;
      response.end(JSON.stringify({
        ok: false,
        reason: errorMessage(error),
        retryAfterMs: 1_000,
      }));
    }
  }
}


export async function openRaftCliRemote(options: OpenRaftCliRemoteOptions): Promise<RaftRemote> {
  const remote = new DefaultRaftCliRemote(options);
  await remote.validate();
  return remote;
}

function packagedRaftEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@botiverse/raft/dist/raft.js");
}

async function bridgeStarted(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => fail(new Error("Timed out waiting for Raft bridge startup")), 10_000);
    const onData = (chunk: Buffer | string) => {
      buffered += String(chunk);
      while (buffered.includes("\n")) {
        const index = buffered.indexOf("\n");
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { type?: unknown };
          if (event.type === "bridge_process_started") succeed();
        } catch {
          fail(new Error("Raft bridge returned invalid startup JSON"));
        }
      }
    };
    const onClose = () => fail(new Error("Raft bridge exited before startup completed"));
    const onError = (error: Error) => fail(error);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const succeed = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    child.stdout.on("data", onData);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function readWakePayload(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let source = "";
  for await (const chunk of request) {
    source += String(chunk);
    if (Buffer.byteLength(source, "utf8") > 16_384) throw new Error("Raft bridge wake is too large");
  }
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Raft bridge wake must be a JSON object");
  }
}
