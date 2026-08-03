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
  }) {
    this.#root = options.root;
    this.#instance = options.instance;
    this.#driver = options.driver;
    this.#ownership = options.ownership;
    this.#attachmentStore = options.attachmentStore;
    this.#local = options.local;
    this.#weixin = options.weixin;
    this.#raft = options.raft;
  }

  async start(): Promise<void> {
    if (this.#state !== "open") {
      throw new Error(`Loom Host cannot start from state ${this.#state}`);
    }
    this.#driver.start();
    this.#state = "running";
    try {
      await this.#local?.start({
        acceptInput: input => this.acceptInput(input),
        interactionView: options => this.#instance.interactionView(options),
        inputOutcome: inputId => this.#instance.inputOutcome(inputId),
      });
      this.#weixin?.start(input => this.acceptInput(input));
      await this.#raft?.start(input => this.acceptInput(input));
    } catch (error) {
      await this.stop();
      throw error;
    }
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
        await this.#driver.stop();
      } finally {
        try {
          await this.#local?.stop();
        } finally {
          try {
            try {
              await this.#weixin?.stop();
            } finally {
              await this.#raft?.stop();
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
