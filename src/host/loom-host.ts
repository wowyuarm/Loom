import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  loadInstanceConfiguration,
} from "../configuration/index.js";
import {
  createProcessDriver,
  openLoomInstance,
  type LoomInstance,
  type LoomInstanceStatus,
  type OpenLoomInstanceOptions,
  type ProcessDriver,
  type ProcessDriverStatus,
} from "../instance/index.js";
import { resolveInstanceLayout } from "../instance/layout.js";
import { openConfiguredWeixinAdapter } from "../channels/weixin/index.js";
import {
  openConfiguredRaftChannel,
  type RaftRemote,
} from "../channels/raft/index.js";
import { RaftActivityProjector } from "../channels/raft/raft-activity.js";
import {
  openLoomInteractionChannels,
  type InteractionChannel,
  type InteractionChannelStatus,
  type LoomInteractionChannels,
} from "../channels/index.js";
import { openConfiguredWebAccess, type WebAccessIntegration } from "../integrations/web/index.js";
import { loadNmemConnectionConfiguration } from "../integrations/nmem/index.js";
import type {
  AcceptedInput,
  InteractionViewOptions,
  InteractionViewPage,
  RequeueInputResult,
  RuntimeInput,
} from "../runtime/index.js";
import {
  assertNoLegacyAttachmentStore,
  openAttachmentStore,
  type AttachmentStore,
} from "../attachments/index.js";
import { LOOM_VERSION } from "../version.js";
import {
  createLoomStatusServer,
  type LoomCognitiveOrganWorkStatus,
  type LiveLoomStatusReport,
  type LoomIntegrationStatus,
  type LoomModelStatus,
  type LoomStatusServer,
} from "./status-socket.js";

export interface LoomHost {
  start(): Promise<void>;
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  interactionView(options?: InteractionViewOptions): InteractionViewPage;
  requeueInput(inputId: string): RequeueInputResult;
  /** Create a successor budget cycle for blocked / intervention_required Cognitive Organ work. */
  requeueCognitiveOrganWork(workId: string): void;
  /** Move failed ingress items on one channel back to pending without a restart. */
  retryChannelIngress(channelId: string, itemId?: string): Promise<number>;
  wake(): void;
  status(): LoomHostStatus;
  stop(): Promise<void>;
}

export interface LoomHostStatus {
  root: string;
  state: "open" | "running" | "stopping" | "stopped";
  driver: ProcessDriverStatus;
  instance: LoomInstanceStatus;
  channels?: Record<string, InteractionChannelStatus>;
}

export type OpenLoomHostOptions = Omit<
  OpenLoomInstanceOptions,
  "attachmentStore" | "channelAgentSurface" | "webAccess" | "nmem" | "interactionEnabled"
> & {
  raftRemote?: RaftRemote;
};

class DefaultLoomHost implements LoomHost {
  readonly #root: string;
  readonly #instance: LoomInstance;
  readonly #driver: ProcessDriver;
  readonly #ownership: InstanceRootOwnership;
  readonly #channels: LoomInteractionChannels;
  readonly #attachmentStore: AttachmentStore;
  readonly #statusServer: LoomStatusServer;
  readonly #runId = randomUUID();
  readonly #now: () => Date;
  #startedAt: string | undefined;
  #state: LoomHostStatus["state"] = "open";
  #finalInstanceStatus: LoomInstanceStatus | undefined;
  #stopping: Promise<void> | undefined;

  constructor(options: {
    root: string;
    instance: LoomInstance;
    driver: ProcessDriver;
    ownership: InstanceRootOwnership;
    attachmentStore: AttachmentStore;
    channels: LoomInteractionChannels;
    web?: WebAccessIntegration;
    statusSocketPath: string;
    now?: () => Date;
  }) {
    this.#root = options.root;
    this.#instance = options.instance;
    this.#driver = options.driver;
    this.#ownership = options.ownership;
    this.#attachmentStore = options.attachmentStore;
    this.#channels = options.channels;
    this.#now = options.now ?? (() => new Date());
    this.#statusServer = createLoomStatusServer({
      socketPath: options.statusSocketPath,
      read: since => this.#operatorStatus(since),
      requeueInput: inputId => this.requeueInput(inputId).disposition,
      requeueCognitiveOrganWork: workId => this.requeueCognitiveOrganWork(workId),
      retryChannelIngress: (channelId, itemId) => this.retryChannelIngress(channelId, itemId),
      interactionView: options => this.interactionView(options),
    });
  }

  async start(): Promise<void> {
    if (this.#state !== "open") {
      throw new Error(`Loom Host cannot start from state ${this.#state}`);
    }
    this.#driver.start();
    this.#state = "running";
    this.#startedAt = this.#now().toISOString();
    try {
      await this.#channels.start(input => this.acceptInput(input));
      await this.#statusServer.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  #operatorStatus(_since?: string): LiveLoomStatusReport {
    const status = this.status();
    if (!this.#startedAt || status.state === "stopped") {
      throw new Error("Loom Host status is unavailable before start or after stop");
    }
    const runtime = status.instance.runtime;
    const agentStatus = this.#instance.operationalStatus({ ...(_since ? { since: _since } : {}) });
    return {
      schemaVersion: 1,
      observedAt: this.#now().toISOString(),
      runId: this.#runId,
      host: {
        state: status.state,
        version: LOOM_VERSION,
        startedAt: this.#startedAt,
      },
      model: operatorModelStatus(status.instance.models),
      runtime: {
        activeTurn: runtime.turns.some(turn => turn.status === "running"),
        pendingInputs: runtime.inputs.filter(input => input.status === "pending").length,
        pendingEffects: runtime.effects.filter(effect => effect.status === "pending").length,
        deliveriesNeedingAttention: runtime.deliveries.filter(delivery => delivery.status === "unknown").length,
        ...(runtime.oldestPendingOrganAgeMs !== undefined
          ? { oldestPendingOrganAgeMs: runtime.oldestPendingOrganAgeMs }
          : {}),
        ...(runtime.activeSegment?.overdueSince !== undefined
          ? {
              activityOverdueSince: runtime.activeSegment.overdueSince,
              activityOverdueReason: runtime.activeSegment.overdueReason,
              ...(runtime.activeSegment.nextOverdueCheckAt !== undefined
                ? { activityOverdueNextCheckAt: runtime.activeSegment.nextOverdueCheckAt }
                : {}),
            }
          : {}),
        integrityWarnings: runtime.integrityWarnings.length > 0 ? [{
          kind: "unexplained_terminal_turn_segment",
          count: runtime.integrityWarnings.length,
        }] : [],
      },
      agents: agentStatus.agents.map(agent => operatorAgentStatus(agent, status.driver)),
      cognitiveOrganWork: runtime.cognitiveOrganWork.map(work => ({
        workId: work.workId,
        organ: work.organ,
        domainRef: work.domainRef,
        status: work.status,
        attemptCount: work.attemptCount,
        createdAt: work.createdAt,
        ...(work.nextAttemptAt ? { nextAttemptAt: work.nextAttemptAt } : {}),
        ...(work.requeuedFrom ? { requeuedFrom: work.requeuedFrom } : {}),
        ...(work.lastCancelReason ? { lastCancelReason: work.lastCancelReason } : {}),
        ...(work.lastFailureCategory ? { lastFailureCategory: work.lastFailureCategory } : {}),
        ...(work.transcriptRef ? { transcriptRef: work.transcriptRef } : {}),
        ...(work.resultRef ? { resultRef: work.resultRef } : {}),
      } satisfies LoomCognitiveOrganWorkStatus)),
      channels: operatorChannelStatuses(status),
      integrations: operatorIntegrationStatuses(status),
    };
  }

  async acceptInput(input: RuntimeInput): Promise<AcceptedInput> {
    if (this.#state !== "running") {
      throw new Error(`Loom Host cannot accept Input while ${this.#state}`);
    }
    return this.#driver.acceptInput(input);
  }

  interactionView(options?: InteractionViewOptions): InteractionViewPage {
    if (this.#state === "stopped") throw new Error("Loom Host cannot read interactions while stopped");
    const page = this.#instance.interactionView(options);
    const byRoute = this.#channels.routeChannelIds();
    return {
      ...page,
      entries: page.entries.map(entry => {
        const channelId = byRoute.get(entry.source);
        return channelId ? { ...entry, source: channelId } : entry;
      }),
    };
  }

  requeueInput(inputId: string): RequeueInputResult {
    if (this.#state !== "running") {
      throw new Error(`Loom Host cannot requeue Input while ${this.#state}`);
    }
    const result = this.#instance.requeueInput(inputId);
    if (result.disposition === "requeued") this.#driver.wake();
    return result;
  }

  requeueCognitiveOrganWork(workId: string): void {
    if (this.#state !== "running") {
      throw new Error(`Loom Host cannot requeue Cognitive Organ work while ${this.#state}`);
    }
    this.#instance.requeueCognitiveOrganWork(workId);
  }

  retryChannelIngress(channelId: string, itemId?: string): Promise<number> {
    if (this.#state !== "running") {
      throw new Error(`Loom Host cannot retry channel ingress while ${this.#state}`);
    }
    return this.#channels.retryFailedIngress(channelId, itemId);
  }

  wake(): void {
    if (this.#state !== "running") {
      throw new Error(`Loom Host cannot wake while ${this.#state}`);
    }
    this.#driver.wake();
  }

  status(): LoomHostStatus {
    return {
      root: this.#root,
      state: this.#state,
      driver: this.#driver.status(),
      instance: this.#finalInstanceStatus ?? this.#instance.status(),
      channels: this.#channels.status(),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    if (this.#state === "stopped") return;
    this.#finalInstanceStatus = this.#instance.status();
    this.#state = "stopping";
    this.#stopping = this.#finishStop();
    return this.#stopping;
  }

  async #finishStop(): Promise<void> {
    try {
      try {
        await this.#statusServer.stop();
      } finally {
        try {
          await this.#driver.stop();
        } finally {
          try {
            await this.#channels.stop();
          } finally {
            this.#attachmentStore.close();
          }
        }
      }
    } finally {
      try {
        this.#ownership.release();
      } finally {
        this.#state = "stopped";
      }
    }
  }
}

export async function openLoomHost(options: OpenLoomHostOptions): Promise<LoomHost> {
  const root = path.resolve(options.root);
  await assertNoLegacyAttachmentStore(path.join(root, "runtime", "attachments"));
  const ownership = await acquireInstanceRootOwnership(root);
  let web: WebAccessIntegration | undefined;
  let attachmentStore: AttachmentStore | undefined;
  let channels: LoomInteractionChannels | undefined;
  let observeChain: OpenLoomHostOptions["observe"] | undefined;
  const interactionChannels: InteractionChannel[] = [];
  try {
    const layout = resolveInstanceLayout(root);
    attachmentStore = await openAttachmentStore({
      root: layout.attachmentStoreRoot,
      ...(options.now ? { now: options.now } : {}),
    });
    const configuration = await loadInstanceConfiguration({
      file: layout.configurationFile,
      ...(options.machineTimeZone ? { machineTimeZone: options.machineTimeZone } : {}),
    });
    if (configuration.channels.weixin) {
      const weixin = await openConfiguredWeixinAdapter({
        configurationFile: layout.weixinConfigurationFile,
        authFile: layout.weixinAuthFile,
        stateFile: layout.weixinStateFile,
        attachmentStore,
      });
      if (!weixin) throw new Error("Enabled Weixin requires both config.json and auth.json");
      interactionChannels.push(weixin);
    }
    if (configuration.channels.raft) {
      const raftActivity = new RaftActivityProjector();
      const raft = await openConfiguredRaftChannel({
        configurationFile: layout.raftConfigurationFile,
        stateFile: layout.raftStateFile,
        ...(options.raftRemote ? { remote: options.raftRemote } : {}),
        activity: raftActivity,
      });
      if (!raft) throw new Error("Enabled Raft requires config.json");
      interactionChannels.push(raft);
      // Project the Runtime/Main-Agent lifecycle onto Raft activity in
      // addition to the operator observer; projection failures are isolated
      // by the observer contract and never change Runtime behavior.
      const observe: OpenLoomHostOptions["observe"] = options.observe
        ? event => {
            options.observe?.(event);
            raftActivity.observe(event);
          }
        : event => raftActivity.observe(event);
      observeChain = observe;
    } else if (options.raftRemote) {
      throw new Error("Raft Remote was provided while the Channel is disabled");
    }
    if (configuration.integrations.web) {
      web = await openConfiguredWebAccess({
        configurationFile: layout.webConfigurationFile,
        authFile: layout.webAuthFile,
      });
    }
    const nmem = configuration.integrations.nmem
      ? await loadNmemConnectionConfiguration({
          configurationFile: layout.nmemConfigurationFile,
          authFile: layout.nmemAuthFile,
        })
      : undefined;
    if (interactionChannels.length > 0 && options.outboundDelivery) {
      throw new Error("Loom Host cannot combine an enabled interaction channel with another OutboundDelivery");
    }
    const { raftRemote: _raftRemote, ...instanceOptions } = options;
    // The collection owns every Channel from here on: start, rollback, stop,
    // delivery routing and surface composition. The Host never touches an
    // individual Channel again.
    const openedChannels = openLoomInteractionChannels({
      channels: interactionChannels,
      ...(configuration.defaultInteractionRoute
        ? { defaultInteractionRoute: configuration.defaultInteractionRoute }
        : {}),
    });
    channels = openedChannels;
    const instance = await openLoomInstance({
      ...instanceOptions,
      ...(observeChain || options.observe ? { observe: observeChain ?? options.observe } : {}),
      root,
      attachmentStore,
      interactionEnabled: true,
      outboundDelivery: channels,
      ...(channels.agentSurface() ? { channelAgentSurface: channels.agentSurface()! } : {}),
      ...(openedChannels ? { channelStatuses: () => openedChannels.status() } : {}),
      ...(web ? { webAccess: web } : {}),
      ...(nmem ? { nmem } : {}),
    });
    return new DefaultLoomHost({
      root,
      instance,
      driver: createProcessDriver({
        instance,
        ...(options.now ? { now: options.now } : {}),
        ...(options.observe ? { observe: options.observe } : {}),
      }),
      ownership,
      attachmentStore,
      channels,
      statusSocketPath: layout.statusSocketPath,
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    // Channels opened but not yet handed to the collection are stopped by the
    // collection; channels opened before its construction are stopped directly.
    // Both adapters stop safely before their start() was ever called.
    try {
      if (channels) {
        await channels.stop();
      } else {
        for (const channel of [...interactionChannels].reverse()) await channel.stop();
      }
    } catch {
      // Best effort cleanup; the original failure is the reported cause.
    }
    attachmentStore?.close();
    ownership.release();
    throw error;
  }
}

function operatorModelStatus(status: LoomInstanceStatus["models"]): LoomModelStatus {
  if (status.state === "active") return { ...status };
  if (status.state === "degraded") {
    return {
      state: status.state,
      revisionId: status.revisionId,
      activatedAt: status.activatedAt,
      failedAt: status.failedAt,
      failureCategory: status.failure.kind,
    };
  }
  return {
    state: status.state,
    failedAt: status.failedAt,
    failureCategory: status.failure.kind,
  };
}

function operatorAgentStatus(
  agent: ReturnType<LoomInstance["operationalStatus"]>["agents"][number],
  driver: ProcessDriverStatus,
): ReturnType<LoomInstance["operationalStatus"]>["agents"][number] {
  if (agent.state !== "failed" || !driver.nextRunAt) {
    return agent;
  }
  if (agent.name === "main-agent" && driver.lastError) {
    return { ...agent, state: "retrying", nextRunAt: driver.nextRunAt };
  }
  if (driver.lastRun?.result.disposition !== "deferred") return agent;
  const reason = driver.lastRun.result.reason;
  const retrying = (
    (agent.name === "life-recorder" && reason === "activity_recording_failed")
    || (agent.name === "thread-maintainer" && reason === "thread_maintenance_failed")
  );
  return retrying ? { ...agent, state: "retrying", nextRunAt: driver.nextRunAt } : agent;
}

function operatorChannelStatuses(status: LoomHostStatus): LoomIntegrationStatus[] {
  return Object.entries(status.channels ?? {})
    .filter(([, channel]) => channel !== undefined)
    .map(([name, channel]) => ({
      name,
      state: channel.state,
      ...(channel.ingress ? { ingress: channel.ingress } : {}),
      ...(channel.lastError
        ? { lastFailure: { category: failureCategory(channel.lastError) } }
        : {}),
    }));
}

function operatorIntegrationStatuses(status: LoomHostStatus): LoomIntegrationStatus[] {
  const integrations: LoomIntegrationStatus[] = [];
  if (status.instance.nmem) {
    const blocked = [
      ...status.instance.nmem.threads.items,
      ...status.instance.nmem.episodes.items,
    ].filter(item => item.status === "blocked");
    integrations.push({
      name: "nmem",
      state: blocked.length > 0 ? "degraded" : "active",
      ...(blocked[0]?.lastError
        ? { lastFailure: { category: failureCategory(blocked[0].lastError) } }
        : {}),
    });
  }
  return integrations;
}

function failureCategory(message: string): string {
  if (/auth|credential|token|401|403/i.test(message)) return "authentication";
  if (/rate|429/i.test(message)) return "rate_limited";
  if (/timeout|timed out|abort/i.test(message)) return "timeout";
  if (/connect|network|socket|ECONN|ENOTFOUND|fetch failed|HTTP 5\d\d/i.test(message)) return "connection";
  if (/unavailable|not found/i.test(message)) return "unavailable";
  return "unknown";
}

class InstanceRootOwnership {
  #released = false;

  constructor(private readonly database: DatabaseSync) {}

  release(): void {
    if (this.#released) return;
    this.#released = true;
    try {
      this.database.exec("ROLLBACK");
    } finally {
      this.database.close();
    }
  }
}

async function acquireInstanceRootOwnership(root: string): Promise<InstanceRootOwnership> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if (isMissingFile(error)) throw new Error(`Prepared Instance Root does not exist: ${root}`);
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error(`Prepared Instance Root is not a directory: ${root}`);

  const layout = resolveInstanceLayout(root);
  await mkdir(layout.runtimeRoot, { recursive: true });
  const database = new DatabaseSync(path.join(layout.runtimeRoot, "host-lock.db"));
  database.exec("PRAGMA busy_timeout = 0");
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) {
      throw new Error(`Instance Root is already owned by a live Loom Host: ${root}`);
    }
    throw error;
  }
  return new InstanceRootOwnership(database);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}
