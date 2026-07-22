import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  loadInstanceConfiguration,
  MODEL_ROLES,
  type ModelPolicy,
  type ModelRole,
} from "./instance.js";

export type ModelRevisionFailureKind =
  | "instance_configuration"
  | "pi_configuration"
  | "model_not_found"
  | "authentication_missing"
  | "source_changed";

export interface ModelRevisionFailure {
  kind: ModelRevisionFailureKind;
  message: string;
}

export type ModelRuntimeRevisionStatus =
  | {
      state: "active";
      revisionId: string;
      activatedAt: string;
    }
  | {
      state: "degraded";
      revisionId: string;
      activatedAt: string;
      desiredFingerprint: string;
      failedAt: string;
      failure: ModelRevisionFailure;
    }
  | {
      state: "blocked";
      desiredFingerprint: string;
      failedAt: string;
      failure: ModelRevisionFailure;
    };

export interface ResolvedModelCandidate {
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
}

export interface ModelRoleSelection {
  modelRuntime: ModelRuntime;
  candidates: readonly ResolvedModelCandidate[];
}

export interface ModelRuntimeRevision {
  readonly id: string;
  selection(role: ModelRole): ModelRoleSelection;
}

export interface ModelRuntimeRevisions {
  refresh(): Promise<ModelRuntimeRevisionStatus>;
  current(): ModelRuntimeRevision;
  status(): ModelRuntimeRevisionStatus | undefined;
}

export interface OpenModelRuntimeRevisionsOptions {
  configurationFile: string;
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  machineTimeZone?: string;
  now?: () => Date;
}

class RevisionFailure extends Error {
  constructor(readonly kind: ModelRevisionFailureKind, message: string) {
    super(message);
  }
}

class ValidatedModelRuntimeRevision implements ModelRuntimeRevision {
  constructor(
    readonly id: string,
    private readonly modelRuntime: ModelRuntime,
    private readonly selections: ReadonlyMap<ModelRole, readonly ResolvedModelCandidate[]>,
  ) {}

  selection(role: ModelRole): ModelRoleSelection {
    const candidates = this.selections.get(role);
    if (!candidates) throw new Error(`Model Runtime Revision has no selection for ${role}`);
    return { modelRuntime: this.modelRuntime, candidates };
  }
}

class PiModelRuntimeRevisions implements ModelRuntimeRevisions {
  #active: { revision: ModelRuntimeRevision; activatedAt: string } | undefined;
  #status: ModelRuntimeRevisionStatus | undefined;
  #lastSourceFingerprint: string | undefined;
  #refreshing: Promise<ModelRuntimeRevisionStatus> | undefined;

  constructor(private readonly options: OpenModelRuntimeRevisionsOptions) {}

  refresh(): Promise<ModelRuntimeRevisionStatus> {
    const pending = this.#refreshing ?? this.#refreshOnce();
    this.#refreshing = pending;
    const clear = () => {
      if (this.#refreshing === pending) this.#refreshing = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  current(): ModelRuntimeRevision {
    if (!this.#active) {
      const failure = this.#status?.state === "blocked" ? `: ${this.#status.failure.message}` : "";
      throw new Error(`Model Runtime Revision is blocked${failure}`);
    }
    return this.#active.revision;
  }

  status(): ModelRuntimeRevisionStatus | undefined {
    return this.#status;
  }

  async #refreshOnce(): Promise<ModelRuntimeRevisionStatus> {
    let fingerprint = await sourceFingerprint(this.options);
    if (fingerprint === this.#lastSourceFingerprint && this.#status) return this.#status;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fingerprint = await sourceFingerprint(this.options);
        const configuration = await this.#loadConfiguration();
        if (!configuration.modelPolicy) {
          throw new RevisionFailure(
            "instance_configuration",
            "Instance Configuration does not define a models policy",
          );
        }
        const modelRuntime = await ModelRuntime.create({
          authPath: this.options.authPath,
          modelsPath: this.options.modelsPath,
          modelsStorePath: this.options.modelsStorePath,
          allowModelNetwork: false,
        });
        const piError = modelRuntime.getError();
        if (piError) {
          throw new RevisionFailure(
            "pi_configuration",
            "Pi model configuration could not establish a valid runtime",
          );
        }
        const selections = resolveSelections(configuration.modelPolicy, modelRuntime);
        const settledFingerprint = await sourceFingerprint(this.options);
        if (settledFingerprint !== fingerprint) {
          fingerprint = settledFingerprint;
          if (attempt === 0) continue;
          throw new RevisionFailure(
            "source_changed",
            "Model configuration changed while a revision was being established",
          );
        }

        const activatedAt = this.#now().toISOString();
        const revision = new ValidatedModelRuntimeRevision(
          fingerprint,
          modelRuntime,
          selections,
        );
        this.#active = { revision, activatedAt };
        this.#lastSourceFingerprint = fingerprint;
        this.#status = Object.freeze({
          state: "active",
          revisionId: revision.id,
          activatedAt,
        });
        return this.#status;
      } catch (error) {
        const settledFingerprint = await sourceFingerprint(this.options);
        if (settledFingerprint !== fingerprint && attempt === 0) {
          fingerprint = settledFingerprint;
          continue;
        }
        return this.#recordFailure(settledFingerprint, classifyFailure(error));
      }
    }
    return this.#recordFailure(fingerprint, {
      kind: "source_changed",
      message: "Model configuration changed while a revision was being established",
    });
  }

  async #loadConfiguration() {
    try {
      return await loadInstanceConfiguration({
        file: this.options.configurationFile,
        ...(this.options.machineTimeZone
          ? { machineTimeZone: this.options.machineTimeZone }
          : {}),
      });
    } catch {
      throw new RevisionFailure(
        "instance_configuration",
        "Instance Configuration could not be loaded",
      );
    }
  }

  #recordFailure(
    desiredFingerprint: string,
    failure: ModelRevisionFailure,
  ): ModelRuntimeRevisionStatus {
    const failedAt = this.#now().toISOString();
    const recordedFailure = Object.freeze({ ...failure });
    this.#lastSourceFingerprint = desiredFingerprint;
    if (this.#active) {
      this.#status = Object.freeze({
        state: "degraded",
        revisionId: this.#active.revision.id,
        activatedAt: this.#active.activatedAt,
        desiredFingerprint,
        failedAt,
        failure: recordedFailure,
      });
    } else {
      this.#status = Object.freeze({
        state: "blocked",
        desiredFingerprint,
        failedAt,
        failure: recordedFailure,
      });
    }
    return this.#status;
  }

  #now(): Date {
    const now = this.options.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("Model Runtime Revision requires a valid current time");
    return now;
  }
}

function resolveSelections(
  policy: ModelPolicy,
  modelRuntime: ModelRuntime,
): ReadonlyMap<ModelRole, readonly ResolvedModelCandidate[]> {
  const selections = new Map<ModelRole, readonly ResolvedModelCandidate[]>();
  for (const role of MODEL_ROLES) {
    const resolved = policy.roles[role].map(candidate => {
      const model = modelRuntime.getModel(candidate.provider, candidate.model);
      if (!model) {
        throw new RevisionFailure(
          "model_not_found",
          `Pi model ${candidate.provider}/${candidate.model} was not found for role ${role}`,
        );
      }
      if (!modelRuntime.hasConfiguredAuth(candidate.provider)) {
        throw new RevisionFailure(
          "authentication_missing",
          `Pi provider ${candidate.provider} has no configured authentication for role ${role}`,
        );
      }
      return Object.freeze({
        model,
        ...(candidate.thinkingLevel ? { thinkingLevel: candidate.thinkingLevel } : {}),
      });
    });
    selections.set(role, Object.freeze(resolved));
  }
  return selections;
}

function classifyFailure(error: unknown): ModelRevisionFailure {
  if (error instanceof RevisionFailure) {
    return Object.freeze({ kind: error.kind, message: error.message });
  }
  return Object.freeze({
    kind: "pi_configuration",
    message: "Pi Model Runtime could not be established",
  });
}

async function sourceFingerprint(options: OpenModelRuntimeRevisionsOptions): Promise<string> {
  const sources = await Promise.all([
    fileIdentity(options.configurationFile),
    fileIdentity(options.authPath),
    fileIdentity(options.modelsPath),
  ]);
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

async function fileIdentity(
  file: string,
): Promise<Record<string, string> | { missing: true } | { unreadable: string }> {
  try {
    const metadata = await stat(file, { bigint: true });
    return {
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      size: metadata.size.toString(),
      modified: metadata.mtimeNs.toString(),
      changed: metadata.ctimeNs.toString(),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { missing: true };
    }
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    return { unreadable: code };
  }
}

export function openModelRuntimeRevisions(
  options: OpenModelRuntimeRevisionsOptions,
): ModelRuntimeRevisions {
  return new PiModelRuntimeRevisions(options);
}
