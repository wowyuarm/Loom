import type { InteractionChannelStatus } from "../channels/channel.js";
import type { CognitiveOrganName } from "../runtime/cognitive-organ-execution.js";
import type { RuntimeStatus } from "../runtime/index.js";

/**
 * One currently active sustained-degradation fact, reduced to the narrow
 * fields an Orientation run may see. Refs are stable identities built from
 * fault kind + affected object + stable cause; they never carry raw error
 * text, transient work ids, or credentials.
 */
export interface HarnessCondition {
  /** Stable identity: kind + affected object + stable cause. */
  ref: string;
  /** Understandable capability name, not an internal organ id. */
  capability: string;
  /** Short lived-impact statement. */
  impact: string;
  /** When the degradation started (ISO time), when a provable time exists. */
  since?: string;
}

export interface HarnessConditionsEvidence {
  /** Identity of this captured set, passed back to markPresented. */
  revision: string;
  observedAt: string;
  conditions: HarnessCondition[];
}

export interface HarnessConditionSource {
  capture(): Promise<HarnessConditionsEvidence | undefined>;
  markPresented(revision: string): Promise<void>;
}

/** Stable display names for the capabilities affected by blocked organ work. */
const ORGAN_CAPABILITIES: Readonly<Record<CognitiveOrganName, string>> = Object.freeze({
  orientation: "Orientation sensing",
  "life-recorder": "Life recording",
  "attention-maintainer": "Attention maintenance",
  "memory-reflector": "Memory reflection",
  "thread-maintainer": "Thread maintenance",
  "tool-trace-compactor": "Tool trace compaction",
});

const KNOWN_CAUSES = new Set([
  "turn_limit",
  "provider",
  "tool_error",
  "timeout",
  "interrupted",
  "authentication",
  "invalid_result",
  "workspace",
  "remote_unavailable",
  "invalid_message",
  "admission_failed",
]);

/**
 * Normalize a failure category for the internal dedup identity. Unknown
 * values fold to "unknown" so unstable or technical strings never enter the
 * identity. The model-visible impact never carries the cause.
 */
function normalizedCause(category: string | undefined): string {
  return category !== undefined && KNOWN_CAUSES.has(category) ? category : "unknown";
}

/** Fixed, cause-free impact statement for blocked organ work. */
const BLOCKED_ORGAN_IMPACT = "blocked after retries exhausted";


/** Upper bound of persisted presented refs; oldest entries are trimmed. */
const MAX_PRESENTED_REFS = 256;

export interface HarnessConditionStore {
  presentedRefs(): string[];
  markPresented(ref: string, at: Date): void;
  /** Drop the oldest persisted refs beyond a bounded retention. */
  trimPresented(keep: number): void;
}

export interface CreateHarnessConditionSourceOptions {
  /** Reads the authoritative Runtime status at capture time. */
  runtimeStatus: () => RuntimeStatus;
  /** Reads the authoritative status of every enabled Channel at capture time. */
  channelStatuses: () => Record<string, InteractionChannelStatus>;
  store: HarnessConditionStore;
  now?: () => Date;
}

/**
 * Small evidence source assembled at Instance boundary. It reads authoritative
 * facts from Runtime status and Channel status (never the Runtime DB) and
 * reduces them to narrow, deduplicated conditions for Orientation. Retrying,
 * intervention_required, model-runtime and watchdog facts are deliberately
 * out of scope for the first version.
 */
export function createHarnessConditionSource(
  options: CreateHarnessConditionSourceOptions,
): HarnessConditionSource {
  const now = options.now ?? (() => new Date());
  return {
    async capture() {
      const presented = new Set(options.store.presentedRefs());
      const conditions: HarnessCondition[] = [];
      const pendingRefs: string[] = [];
      for (const work of options.runtimeStatus().cognitiveOrganWork) {
        if (work.status !== "blocked") continue;
        const causeRef = normalizedCause(work.lastFailureCategory);
        const ref = `organ-blocked:${work.organ}:${work.domainRef}:${causeRef}`;
        // The stable cause is part of the identity: the same work blocked
        // again for a different cause is a new degradation, not the old one
        // repeating. The aggregated ref is the dedup identity.
        if (presented.has(ref)) continue;
        conditions.push({
          ref,
          capability: ORGAN_CAPABILITIES[work.organ] ?? work.organ,
          impact: BLOCKED_ORGAN_IMPACT,
          // Provable failure time when available; never the work creation time.
          ...(work.lastFailureAt ? { since: work.lastFailureAt } : {}),
        });
        pendingRefs.push(ref);
      }
      for (const [channelId, status] of Object.entries(options.channelStatuses())) {
        const failed = status.ingress?.failed ?? 0;
        if (failed <= 0) continue;
        const causeRef = normalizedCause(status.ingress?.lastFailureCategory);
        const ref = `channel-ingress-failed:${channelId}:${causeRef}`;
        const capability = `${channelId} message ingress`;
        const impact = `${failed} inbound item(s) permanently failed`;
        const itemIds = status.ingress?.failedItemIds;
        if (itemIds && itemIds.length > 0) {
          // Internal per-item acknowledgement tokens dedupe by failed item
          // identity: partial clearing never re-presents the remainder, and a
          // later item failing under the same cause presents the aggregated
          // condition once. Item ids never enter conditions[].ref or Context.
          const freshTokens = itemIds
            .map(itemId => `channel-item:${channelId}:${causeRef}:${itemId}`)
            .filter(token => !presented.has(token));
          if (freshTokens.length === 0) continue;
          conditions.push({ ref, capability, impact });
          pendingRefs.push(ref, ...freshTokens);
        } else {
          // Adapters without item ids keep the channel+cause singleton.
          if (presented.has(ref)) continue;
          conditions.push({ ref, capability, impact });
          pendingRefs.push(ref);
        }
      }
      if (conditions.length === 0) return undefined;
      return {
        // Structured revision: item ids are opaque per Channel contract and
        // may contain any character, so an unambiguous encoding is required.
        revision: JSON.stringify(pendingRefs),
        observedAt: now().toISOString(),
        conditions,
      };
    },
    async markPresented(revision: string) {
      const at = now();
      for (const ref of JSON.parse(revision) as string[]) {
        // Item ids are opaque and may contain surrounding whitespace; persist
        // exactly as captured so acknowledgement always matches capture.
        if (typeof ref === "string" && ref.length > 0) options.store.markPresented(ref, at);
      }
      // Bounded retention: drop the oldest presented refs so the store never
      // grows without limit; a cleared degradation recurring later is then
      // presentable again as a new fact.
      options.store.trimPresented(MAX_PRESENTED_REFS);
    },
  };
}
