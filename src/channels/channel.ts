import type {
  AcceptedInput,
  DeliveryAttemptRequest,
  DeliveryObservation,
  RuntimeInput,
} from "../runtime/index.js";
import type { InteractionChannelAgentSurface } from "./surface.js";

/**
 * Channel-neutral live status of one Interaction Channel, as surfaced to the
 * Host and operator. Adapters may keep richer internal status; what crosses
 * the channel boundary stays neutral so the Host never re-implements
 * per-channel state machines.
 */
export interface InteractionChannelStatus {
  state: "stopped" | "connecting" | "connected" | "degraded";
  lastError?: string;
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
  agentSurface?(): InteractionChannelAgentSurface;
}
