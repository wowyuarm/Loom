export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type InputKind = "interaction" | "opportunity";

export interface RuntimeInput {
  source: string;
  sourceId: string;
  kind: InputKind;
  payload: JsonValue;
  occurredAt?: string;
}

export type TranscriptAnchor = {
  sessionId: string;
  entryId: string;
};

export interface ExecutionInput {
  id: string;
  kind: InputKind;
  payload: JsonValue;
  occurredAt: string;
  inclusionPosition: number;
}

export interface TurnRequest {
  turnId: string;
  leaseToken: number;
  inputs: ExecutionInput[];
  executionState?: JsonValue;
}

export interface ExecutionResult {
  outcome: "completed" | "no_reply";
  inputAnchors: Array<{
    inputId: string;
    transcriptAnchor: TranscriptAnchor;
  }>;
  transcriptAnchor: TranscriptAnchor;
  executionState: JsonValue;
  executionRecord: JsonValue;
}

export interface EffectRequest {
  kind: string;
  payload: JsonValue;
  routeRef?: string;
}

export interface EffectReceipt {
  effectId: string;
}

export interface TurnControl {
  includeInput(inputId: string): void;
  prepareExecutionState(state: JsonValue): void;
  replaceExecutionState(expected: JsonValue, replacement: JsonValue): void;
  prepareEffect(effect: EffectRequest): EffectReceipt;
}

export interface DeliveryAttemptRequest {
  attemptId: string;
  effectId: string;
  kind: string;
  payload: JsonValue;
  routeRef: string;
  idempotencyKey: string;
}

export type DeliveryObservation =
  | { status: "delivered"; remoteId: string }
  | { status: "not_sent"; error?: string }
  | { status: "unknown"; error?: string };

export interface OutboundDelivery {
  deliver(attempt: DeliveryAttemptRequest): Promise<DeliveryObservation>;
}

export interface RunningExecution {
  result: Promise<ExecutionResult>;
  steer(input: ExecutionInput): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface AgentExecution {
  start(request: TurnRequest, control: TurnControl): RunningExecution;
}

export type AcceptedInput =
  | { disposition: "accepted"; inputId: string }
  | { disposition: "duplicate"; inputId: string };

export interface RuntimeInputStatus {
  id: string;
  source: string;
  sourceId: string;
  kind: InputKind;
  payload: JsonValue;
  status: "pending" | "active" | "consumed" | "blocked";
}

export interface RuntimeTurnStatus {
  id: string;
  status: "running" | "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";
  inputIds: string[];
  transcriptAnchor?: TranscriptAnchor;
  executionRecord?: JsonValue;
}

export interface RuntimeEffectStatus {
  id: string;
  turnId: string;
  kind: string;
  payload: JsonValue;
  routeRef?: string;
  coveredInputPosition: number;
  status: "pending" | "completed" | "reconciliation_required" | "abandoned";
}

export interface RuntimeDeliveryStatus {
  id: string;
  effectId: string;
  attempt: number;
  status: "prepared" | "dispatching" | "delivered" | "not_sent" | "unknown";
  idempotencyKey: string;
  remoteId?: string;
  error?: string;
}

export interface RuntimeStatus {
  inputs: RuntimeInputStatus[];
  turns: RuntimeTurnStatus[];
  effects: RuntimeEffectStatus[];
  deliveries: RuntimeDeliveryStatus[];
}

export interface RuntimeOptions {
  root: string;
  execution?: AgentExecution;
  outboundDelivery?: OutboundDelivery;
  now?: () => Date;
  nextId?: () => string;
  ownerId?: string;
  leaseDurationMs?: number;
}

export type AdvanceResult =
  | { disposition: "idle" }
  | { disposition: "turn_completed" }
  | { disposition: "delivery_completed" }
  | { disposition: "delivery_not_sent" }
  | { disposition: "delivery_requires_reconciliation" }
  | { disposition: "busy" };

export interface Runtime {
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  advance(): Promise<AdvanceResult>;
  status(): RuntimeStatus;
  close(): void;
}
