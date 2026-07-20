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

export interface FrozenActivityEvent {
  eventId: string;
  at: string;
  actorRef: "individual" | "human" | "system";
  kind: "input" | "output" | "thinking" | "tool_call" | "tool_result" | "effect" | "delivery" | "system";
  content: JsonValue;
}

export interface FrozenActivity {
  version: 1;
  segmentId: string;
  recordingDay: string;
  openedAt: string;
  closedAt: string;
  events: FrozenActivityEvent[];
  transcriptAnchors: JsonValue[];
}

export interface LifeRecorderReceipt {
  version: 1;
  segmentId: string;
  runId: string;
  recordedAt: string;
  daily: {
    status: "updated" | "no_change";
    path: string;
  };
  episodes: Array<{
    id: string;
    path: string;
  }>;
}

export interface ActivityFreezeRequest {
  segment: {
    id: string;
    openedAt: string;
    closedAt: string;
    recordingDay: string;
  };
  recentActivities: FrozenActivity[];
  startingExecutionState?: JsonValue;
  executionState: JsonValue;
  inputs: Array<{
    id: string;
    kind: InputKind;
    payload: JsonValue;
    occurredAt: string;
  }>;
  turns: Array<{
    id: string;
    inputIds: string[];
    status: "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";
    startedAt: string;
    endedAt: string;
    transcriptAnchor?: TranscriptAnchor;
    executionRecord?: JsonValue;
    error?: string;
  }>;
  toolActivities: Array<{
    turnId: string;
    toolCallId: string;
    toolName: string;
    callArguments: JsonValue;
    result: JsonValue;
    completedAt: string;
  }>;
  effects: Array<{
    id: string;
    turnId: string;
    kind: string;
    payload: JsonValue;
    routeRef?: string;
    createdAt: string;
    endedAt?: string;
    status: RuntimeEffectStatus["status"];
  }>;
  deliveries: Array<{
    id: string;
    effectId: string;
    attempt: number;
    status: RuntimeDeliveryStatus["status"];
    startedAt: string;
    endedAt?: string;
    remoteId?: string;
    error?: string;
  }>;
}

export interface ActivityLifecycle {
  freeze(request: ActivityFreezeRequest): Promise<{
    activity: FrozenActivity;
    successorExecutionState: JsonValue;
  }>;
}

export interface ActivityRecorder {
  record(activity: FrozenActivity): Promise<LifeRecorderReceipt>;
}

export interface OrientationRequest {
  observedAt: string;
  localTime: string;
  lastHumanInputAt?: string;
  recentActivities: FrozenActivity[];
}

export type OrientationResult =
  | {
      outcome: "opportunity";
      runId: string;
      narrative: string;
      whyNow: string;
      evidence: string[];
    }
  | {
      outcome: "none";
      runId: string;
      whyNow: string;
      evidence: string[];
    };

export interface Orientation {
  form(request: OrientationRequest): Promise<OrientationResult>;
}

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

export interface VerifiedToolActivity {
  toolCallId: string;
  toolName: string;
  callArguments: JsonValue;
  result: JsonValue;
}

export interface TurnControl {
  includeInput(inputId: string): void;
  prepareExecutionState(state: JsonValue): void;
  replaceExecutionState(expected: JsonValue, replacement: JsonValue): void;
  recordToolActivity(activity: VerifiedToolActivity): void;
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

export interface RuntimeActivityStatus {
  id: string;
  openedAt: string;
  closedAt: string;
  status: "pending" | "recording" | "recorded";
  attempts: number;
  receipt?: LifeRecorderReceipt;
  lastError?: string;
}

export interface RuntimeStatus {
  inputs: RuntimeInputStatus[];
  turns: RuntimeTurnStatus[];
  effects: RuntimeEffectStatus[];
  deliveries: RuntimeDeliveryStatus[];
  activeSegment?: {
    id: string;
    openedAt: string;
  };
  activities: RuntimeActivityStatus[];
}

export interface RuntimeOptions {
  root: string;
  execution?: AgentExecution;
  outboundDelivery?: OutboundDelivery;
  activityLifecycle?: ActivityLifecycle;
  activityRecorder?: ActivityRecorder;
  orientation?: Orientation;
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
  | { disposition: "activity_recorded" }
  | { disposition: "activity_recording_failed" }
  | { disposition: "busy" };

export type CloseActivityResult =
  | { disposition: "no_activity" }
  | { disposition: "busy" }
  | { disposition: "activity_frozen"; activityId: string };

export type FormOpportunityResult =
  | { disposition: "accepted"; inputId: string; runId: string }
  | { disposition: "none"; runId: string }
  | { disposition: "busy" }
  | { disposition: "stale"; runId: string };

export interface Runtime {
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  formOpportunity(): Promise<FormOpportunityResult>;
  advance(): Promise<AdvanceResult>;
  closeActivity(): Promise<CloseActivityResult>;
  status(): RuntimeStatus;
  close(): void;
}
