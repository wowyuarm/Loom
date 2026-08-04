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
import {
  LOCAL_INTERACTION_ROUTE,
  openLocalInteractionChannel,
  type LocalInteractionChannel,
  type LocalInteractionChannelStatus,
} from "../integrations/local/index.js";
import {
  openConfiguredWeixinAdapter,
  type WeixinAdapter,
  type WeixinAdapterStatus,
} from "../integrations/weixin/index.js";
import {
  openConfiguredRaftChannel,
  type RaftChannel,
  type RaftChannelStatus,
  type RaftRemote,
} from "../integrations/raft/index.js";
import type {
  AcceptedInput,
  InteractionViewOptions,
  InteractionViewPage,
  RuntimeInput,
} from "../runtime/index.js";
import {
  openAttachmentStore,
  type AttachmentStore,
} from "../integrations/attachments/index.js";
import { LOOM_VERSION } from "../version.js";
import {
  createLoomStatusServer,
  type LiveLoomStatusReport,
  type LoomIntegrationStatus,
  type LoomModelStatus,
  type LoomStatusServer,
} from "./status-socket.js";

export interface LoomHost {
  start(): Promise<void>;
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  interactionView(options?: InteractionViewOptions): InteractionViewPage;
  wake(): void;
  status(): LoomHostStatus;
  stop(): Promise<void>;
}

export interface LoomHostStatus {
  root: string;
  state: "open" | "running" | "stopping" | "stopped";
  driver: ProcessDriverStatus;
  instance: LoomInstanceStatus;
  integrations?: {
    local?: LocalInteractionChannelStatus;
    weixin?: WeixinAdapterStatus;
    raft?: RaftChannelStatus;
  };
}

export type OpenLoomHostOptions = Omit<
  OpenLoomInstanceOptions,
  "attachmentStore" | "channelAgentSurface"
> & {
  raftRemote?: RaftRemote;
};

class DefaultLoomHost implements LoomHost {
  readonly #root: string;
  readonly #instance: LoomInstance;
  readonly #driver: ProcessDriver;
  readonly #ownership: InstanceRootOwnership;
  readonly #local: LocalInteractionChannel | undefined;
  readonly #weixin: WeixinAdapter | undefined;
  readonly #raft: RaftChannel | undefined;
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
    local?: LocalInteractionChannel;
    weixin?: WeixinAdapter;
    raft?: RaftChannel;
    statusSocketPath: string;
    now?: () => Date;
  }) {
    this.#root = options.root;
    this.#instance = options.instance;
    this.#driver = options.driver;
    this.#ownership = options.ownership;
    this.#attachmentStore = options.attachmentStore;
    this.#local = options.local;
    this.#weixin = options.weixin;
    this.#raft = options.raft;
    this.#now = options.now ?? (() => new Date());
    this.#statusServer = createLoomStatusServer({
      socketPath: options.statusSocketPath,
      read: since => this.#operatorStatus(since),
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
      await this.#local?.start({
        acceptInput: input => this.acceptInput(input),
        interactionView: options => this.#instance.interactionView(options),
        inputOutcome: inputId => this.#instance.inputOutcome(inputId),
      });
      this.#weixin?.start(input => this.acceptInput(input));
      await this.#raft?.start(input => this.acceptInput(input));
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
      },
      agents: agentStatus.agents.map(agent => operatorAgentStatus(agent, status.driver)),
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
    return this.#instance.interactionView(options);
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
      ...(this.#local || this.#weixin || this.#raft ? {
        integrations: {
          ...(this.#local ? { local: this.#local.status() } : {}),
          ...(this.#weixin ? { weixin: this.#weixin.status() } : {}),
          ...(this.#raft ? { raft: this.#raft.status() } : {}),
        },
      } : {}),
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
            try {
              await this.#local?.stop();
            } finally {
              try {
                await this.#weixin?.stop();
              } finally {
                await this.#raft?.stop();
              }
            }
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
  const ownership = await acquireInstanceRootOwnership(root);
  let local: LocalInteractionChannel | undefined;
  let weixin: WeixinAdapter | undefined;
  let raft: RaftChannel | undefined;
  let attachmentStore: AttachmentStore | undefined;
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
    const enabledInteractionChannels = [
      configuration.integrations.local,
      configuration.integrations.weixin,
      configuration.integrations.raft,
    ].filter(Boolean).length;
    if (enabledInteractionChannels > 1) {
      throw new Error("Loom Host currently accepts one enabled interaction channel");
    }
    if (configuration.integrations.local) {
      if (configuration.defaultInteractionRoute !== LOCAL_INTERACTION_ROUTE) {
        throw new Error(`Local Interaction Channel requires interaction.defaultRoute: ${LOCAL_INTERACTION_ROUTE}`);
      }
      local = openLocalInteractionChannel({ socketPath: layout.localSocketPath });
    }
    if (configuration.integrations.weixin) {
      if (!configuration.defaultInteractionRoute) {
        throw new Error("Enabled Weixin requires interaction.defaultRoute");
      }
      weixin = await openConfiguredWeixinAdapter({
        configurationFile: layout.weixinConfigurationFile,
        authFile: layout.weixinAuthFile,
        stateFile: layout.weixinStateFile,
        attachmentStore,
        expectedRouteRef: configuration.defaultInteractionRoute,
      });
      if (!weixin) throw new Error("Enabled Weixin requires both config.json and auth.json");
    }
    if (configuration.integrations.raft) {
      if (!configuration.defaultInteractionRoute) {
        throw new Error("Enabled Raft requires interaction.defaultRoute");
      }
      raft = await openConfiguredRaftChannel({
        configurationFile: layout.raftConfigurationFile,
        stateFile: layout.raftStateFile,
        expectedRouteRef: configuration.defaultInteractionRoute,
        ...(options.raftRemote ? { remote: options.raftRemote } : {}),
      });
      if (!raft) throw new Error("Enabled Raft requires config.json");
    } else if (options.raftRemote) {
      throw new Error("Raft Remote was provided while the Integration is disabled");
    }
    if ((local || weixin || raft) && options.outboundDelivery) {
      throw new Error("Loom Host cannot combine an enabled interaction channel with another OutboundDelivery");
    }
    const { outboundDelivery, raftRemote: _raftRemote, ...instanceOptions } = options;
    const instance = await openLoomInstance({
      ...instanceOptions,
      root,
      attachmentStore,
      ...(local || weixin || raft || outboundDelivery
        ? { outboundDelivery: local ?? weixin ?? raft ?? outboundDelivery }
        : {}),
      ...(raft ? { channelAgentSurface: raft.agentSurface() } : {}),
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
      statusSocketPath: layout.statusSocketPath,
      ...(options.now ? { now: options.now } : {}),
      ...(local ? { local } : {}),
      ...(weixin ? { weixin } : {}),
      ...(raft ? { raft } : {}),
    });
  } catch (error) {
    await local?.stop();
    await weixin?.stop();
    await raft?.stop();
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

function operatorIntegrationStatuses(status: LoomHostStatus): LoomIntegrationStatus[] {
  const integrations: LoomIntegrationStatus[] = [];
  for (const [name, integration] of Object.entries(status.integrations ?? {})) {
    if (!integration) continue;
    integrations.push({
      name,
      state: integration.state,
      ...(integration.lastError ? { lastFailure: { category: failureCategory(integration.lastError) } } : {}),
    });
  }
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
  if (/connect|network|socket|ECONN|ENOTFOUND|HTTP 5\d\d/i.test(message)) return "connection";
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
