import type {
  AcceptedInput,
  DeliveryAttemptRequest,
  DeliveryObservation,
  RuntimeInput,
} from "../runtime/index.js";
import type { InteractionChannelAgentSurface } from "./surface.js";

/**
 * Channel-neutral failure class of one ingress item. Named by what recovery
 * needs, not by the underlying protocol.
 */
export type InteractionChannelFailureCategory =
  | "remote_unavailable"
  | "invalid_message"
  | "admission_failed";

/**
 * Channel-neutral ingress health: how much queued inbound work is waiting or
 * failing. Only counts, timing, failure classes and opaque local item ids
 * cross the boundary — never message content, raw targets or full errors.
 */
export interface InteractionChannelIngressStatus {
  /** Ingress items waiting to be processed. */
  pending: number;
  /** Ingress items that failed transiently and are waiting for a scheduled retry. */
  retrying: number;
  /** Ingress items that failed permanently and need operator attention. */
  failed: number;
  /** Items held in the adapter's recovery spool, still awaiting completion. */
  spooled: number;
  /** Earliest received time among items that are not complete. */
  oldestOutstandingAt?: string;
  /**
   * ISO time when the earliest currently-failed item entered permanent
   * failure. Only counts items that are still failed now.
   */
  firstFailureAt?: string;
  /**
   * ISO time when the most recent currently-failed item entered permanent
   * failure. Only counts items that are still failed now.
   */
  lastFailureAt?: string;
  /** Most recent failure class among retrying/failed/spooled items. */
  lastFailureCategory?: InteractionChannelFailureCategory;
  /** Bounded local ids of failed items, for targeted recovery without a restart. */
  failedItemIds?: string[];
}

/**
 * Channel-neutral live status of one Interaction Channel, as surfaced to the
 * Host and operator. Adapters may keep richer internal status; what crosses
 * the channel boundary stays neutral so the Host never re-implements
 * per-channel state machines.
 */
export interface InteractionChannelStatus {
  state: "stopped" | "connecting" | "connected" | "degraded";
  lastError?: string;
  ingress?: InteractionChannelIngressStatus;
}

/**
 * A live external Interaction Channel as seen by the Host. Protocol, ingress,
 * delivery and recovery stay behind the concrete adapter; the Host only
 * coordinates lifecycle, routes outbound Effects by route and merges the
 * model-facing surfaces of every enabled channel.
 */
export interface InteractionChannel {
  /** Stable identity of the channel kind, e.g. "raft" or "weixin". */
  readonly id: string;
  /** Display label used in assembled guidance sections, e.g. "Raft". */
  readonly label: string;
  /** Instance-configured route this channel owns. */
  readonly routeRef: string;
  start(acceptInput: (input: RuntimeInput) => Promise<AcceptedInput>): Promise<void> | void;
  stop(): Promise<void>;
  deliver(attempt: DeliveryAttemptRequest): Promise<DeliveryObservation>;
  status(): InteractionChannelStatus;
  /** Move one failed ingress item (by local id), or all of them, back to pending without a restart. */
  retryFailedIngress?(itemId?: string): Promise<number>;
  agentSurface?(): InteractionChannelAgentSurface;
}
