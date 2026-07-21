export interface NmemClientOptions {
  endpoint: string;
  apiKey?: string;
  spaceId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface NmemMemoryUpsert {
  id: string;
  title: string;
  content: string;
  source: string;
  importance: number;
  labels: string[];
  event_start: string;
  temporal_context: "past";
  unit_type: "event";
  metadata: Record<string, string>;
}

export interface NmemMemoryEvidence {
  reference: string;
  title?: string;
  content: string;
  contentTruncated?: true;
  relevance: number;
  relevanceReason?: string;
  source?: string;
  eventDate?: string;
  recordedAt?: string;
  unitType?: string;
  metadata?: Record<string, unknown>;
}

export interface NmemThreadMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface NmemThreadCreate {
  thread_id: string;
  title: string;
  participants: string[];
  source: string;
  messages: NmemThreadMessage[];
  metadata: Record<string, unknown>;
}

export interface NmemWorkingMemorySnapshot {
  exists: boolean;
  content: string;
  sourceDate?: string;
}

const MAX_EVIDENCE_CONTENT_CHARS = 4_000;

export class NmemRequestError extends Error {
  override readonly name = "NmemRequestError";

  constructor(
    message: string,
    readonly kind: "temporary" | "authentication" | "incompatible",
    readonly status?: number,
  ) {
    super(message);
  }
}

export class NmemClient {
  readonly #endpoint: string;
  readonly #apiKey: string | undefined;
  readonly #spaceId: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: NmemClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#spaceId = options.spaceId;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async requireCapabilities(...features: string[]): Promise<void> {
    const response = await this.#request("/capabilities", { method: "GET" });
    const value = await readJson(response);
    if (!isObject(value) || !isObject(value.features)) {
      throw new NmemRequestError("nmem returned an incompatible capabilities response", "incompatible");
    }
    for (const feature of features) {
      if (value.features[feature] !== true) {
        throw new NmemRequestError(`nmem does not advertise required capability: ${feature}`, "incompatible");
      }
    }
  }

  async upsertMemory(memory: NmemMemoryUpsert): Promise<void> {
    const response = await this.#request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...memory,
        ...(this.#spaceId ? { space_id: this.#spaceId } : {}),
      }),
    });
    const value = await readJson(response);
    if (!isObject(value) || !isObject(value.memory) || value.memory.id !== memory.id) {
      throw new NmemRequestError("nmem returned an incompatible memory upsert response", "incompatible");
    }
  }

  async searchMemories(query: string, limit: number): Promise<NmemMemoryEvidence[]> {
    const response = await this.#request("/memories/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        limit,
        include_entities: false,
        mode: "fast",
        ...(this.#spaceId ? { space_id: this.#spaceId } : {}),
      }),
    });
    const value = await readJson(response);
    if (!Array.isArray(value)) {
      throw new NmemRequestError("nmem returned an incompatible memory search response", "incompatible");
    }
    const evidence: NmemMemoryEvidence[] = [];
    for (const item of value) {
      if (!isObject(item) || typeof item.similarity_score !== "number") {
        throw new NmemRequestError("nmem returned an incompatible memory search result", "incompatible");
      }
      if (item.memory === null || item.memory === undefined) continue;
      if (!isObject(item.memory)
        || typeof item.memory.id !== "string"
        || typeof item.memory.content !== "string") {
        throw new NmemRequestError("nmem returned an incompatible memory search result", "incompatible");
      }
      const content = boundText(item.memory.content, MAX_EVIDENCE_CONTENT_CHARS);
      evidence.push({
        reference: `nmem:memory:${item.memory.id}`,
        ...(typeof item.memory.title === "string" && item.memory.title ? { title: item.memory.title } : {}),
        content: content.value,
        ...(content.truncated ? { contentTruncated: true as const } : {}),
        relevance: item.similarity_score,
        ...(typeof item.relevance_reason === "string" && item.relevance_reason
          ? { relevanceReason: item.relevance_reason }
          : {}),
        ...(typeof item.memory.source === "string" && item.memory.source ? { source: item.memory.source } : {}),
        ...(typeof item.memory.event_start === "string" && item.memory.event_start
          ? { eventDate: item.memory.event_start }
          : {}),
        ...(typeof item.memory.created_at === "string" && item.memory.created_at
          ? { recordedAt: item.memory.created_at }
          : {}),
        ...(typeof item.memory.unit_type === "string" && item.memory.unit_type
          ? { unitType: item.memory.unit_type }
          : {}),
        ...(isObject(item.memory.metadata) ? { metadata: boundedMetadata(item.memory.metadata) } : {}),
      });
    }
    return evidence;
  }

  async createThread(thread: NmemThreadCreate): Promise<void> {
    try {
      const response = await this.#request("/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...thread,
          ...(this.#spaceId ? { space_id: this.#spaceId } : {}),
        }),
      });
      const value = await readJson(response);
      if (!threadIdentity(value, thread.thread_id)) {
        throw new NmemRequestError("nmem returned an incompatible Thread create response", "incompatible");
      }
    } catch (error) {
      if (!(error instanceof NmemRequestError) || error.status !== 422) throw error;
      const query = this.#spaceId ? `?space_id=${encodeURIComponent(this.#spaceId)}` : "";
      const response = await this.#request(`/threads/${encodeURIComponent(thread.thread_id)}${query}`, {
        method: "GET",
      });
      const value = await readJson(response);
      if (!threadIdentity(value, thread.thread_id)) {
        throw new NmemRequestError("nmem reported an existing Thread but could not verify its identity", "incompatible");
      }
    }
  }

  async getWorkingMemory(): Promise<NmemWorkingMemorySnapshot> {
    const query = this.#spaceId ? `?space_id=${encodeURIComponent(this.#spaceId)}` : "";
    const response = await this.#request(`/agent/working-memory${query}`, { method: "GET" });
    const value = await readJson(response);
    if (!isObject(value)
      || typeof value.exists !== "boolean"
      || (value.exists && typeof value.content !== "string")
      || (value.content !== undefined && value.content !== null && typeof value.content !== "string")
      || (value.date !== undefined && value.date !== null && typeof value.date !== "string")
      || (this.#spaceId && value.space_id !== undefined && value.space_id !== this.#spaceId)) {
      throw new NmemRequestError("nmem returned an incompatible Working Memory response", "incompatible");
    }
    return {
      exists: value.exists,
      content: typeof value.content === "string" ? value.content : "",
      ...(typeof value.date === "string" && value.date ? { sourceDate: value.date } : {}),
    };
  }

  async #request(resource: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const headers = new Headers(init.headers);
      if (this.#apiKey) {
        headers.set("authorization", `Bearer ${this.#apiKey}`);
        headers.set("x-nmem-api-key", this.#apiKey);
      }
      let response: Response;
      try {
        response = await this.#fetch(`${this.#endpoint}${resource}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new NmemRequestError(`nmem request failed: ${message}`, "temporary");
      }
      if (response.ok) return response;
      if (response.status === 401 || response.status === 403) {
        throw new NmemRequestError(`nmem authentication failed with HTTP ${response.status}`, "authentication", response.status);
      }
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new NmemRequestError(`nmem is temporarily unavailable: HTTP ${response.status}`, "temporary", response.status);
      }
      throw new NmemRequestError(`nmem rejected the request with HTTP ${response.status}`, "incompatible", response.status);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function threadIdentity(value: unknown, expectedThreadId: string): boolean {
  if (!isObject(value)) return false;
  const thread = isObject(value.thread) ? value.thread : value;
  return thread.thread_id === expectedThreadId || thread.id === expectedThreadId;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new NmemRequestError("nmem returned a non-JSON response", "incompatible");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function boundedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(metadata)
    .filter((entry): entry is [string, string | number | boolean | null] => {
      const value = entry[1];
      return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    })
    .slice(0, 20)
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value]);
  return Object.fromEntries(entries);
}
