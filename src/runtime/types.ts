import type { TimePolicy } from "../configuration/index.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type InputKind = "interaction" | "opportunity" | "continuation";
export type RuntimeInputKind = Exclude<InputKind, "continuation">;

export interface RuntimeInput {
  source: string;
  sourceId: string;
  kind: RuntimeInputKind;
  payload: JsonValue;
  occurredAt?: string;
}

export type TranscriptAnchor = {
  sourceId: string;
  sessionId: string;
  entryId: string;
};

export interface FrozenActivityEvent {
  eventId: string;
  turnId: string;
  at: string;
  actorRef: "individual" | "human" | "system";
  kind: "input" | "output" | "thinking" | "tool_call" | "tool_result" | "effect" | "delivery" | "system";
  content: JsonValue;
}

export interface FrozenActivityTurn {
  turnId: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";
  transcriptAnchor?: TranscriptAnchor;
}

export interface FrozenActivity {
  version: 1;
  segmentId: string;
  recordingDay: string;
  openedAt: string;
  closedAt: string;
  events: FrozenActivityEvent[];
  turns: FrozenActivityTurn[];
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

export interface ThreadActivityObservation {
  turnId: string;
  threadPath: string;
  relation: "changed" | "observed";
  paths: string[];
}

export interface ThreadMaintenanceRequest {
  observedAt: string;
  localTime: string;
  activity: FrozenActivity;
  observations: ThreadActivityObservation[];
}

export interface ThreadMaintenanceResult {
  outcome: "updated" | "no_change";
  runId: string;
  changedPaths: string[];
}

export interface ThreadMaintenance {
  observationsFor(activity: FrozenActivity): ThreadActivityObservation[];
  maintain(request: ThreadMaintenanceRequest): Promise<ThreadMaintenanceResult>;
}

export interface AttentionMaintenanceRequest {
  observedAt: string;
  localTime: string;
  recentActivities: FrozenActivity[];
}

export interface AttentionMaintenanceResult {
  outcome: "updated" | "no_change";
  runId: string;
  path: string;
}

export interface AttentionMaintenance {
  maintain(request: AttentionMaintenanceRequest): Promise<AttentionMaintenanceResult>;
}

export interface MemoryReflectionRequest {
  reflectionDay: string;
  observedAt: string;
  localTime: string;
  activities: FrozenActivity[];
}

export interface MemoryReflectionResult {
  outcome: "updated" | "no_change";
  runId: string;
  changedMaterials: string[];
}

export interface MemoryReflection {
  reflect(request: MemoryReflectionRequest): Promise<MemoryReflectionResult>;
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
  recordingDay: string;
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

export interface RuntimePulseStatus {
  lastPulseAt?: string;
  nextPulseAfter: string;
  consecutiveFailures: number;
  lastError?: string;
}

export interface RuntimeThreadMaintenanceStatus {
  activityId: string;
  status: "pending" | "running" | "completed";
  attempts: number;
  result?: ThreadMaintenanceResult;
  lastError?: string;
}

export interface RuntimeAttentionMaintenanceStatus {
  lastCompletedAt?: string;
  nextRunAfter: string;
  attempts: number;
  pendingActivityIds: string[];
  lastResult?: AttentionMaintenanceResult;
  lastError?: string;
}

export interface RuntimeMemoryReflectionStatus {
  nextDay: string;
  nextRunAfter: string;
  attempts: number;
  pendingActivityIds: string[];
  lastCompletedDay?: string;
  lastResult?: MemoryReflectionResult;
  lastError?: string;
}

export interface RuntimeAfterChatContinuationStatus {
  id: string;
  status: "pending" | "admitted" | "cancelled" | "expired" | "completed";
  sourceDeliveryId: string;
  sourceEffectId: string;
  sourceTurnId: string;
  sourceSegmentId: string;
  sourceBehavior: "interaction" | "background";
  deliveredAt: string;
  dueAt: string;
  expiresAt: string;
  inputId?: string;
  endedAt?: string;
  reason?: string;
}

export interface RuntimeStatus {
  inputs: RuntimeInputStatus[];
  turns: RuntimeTurnStatus[];
  effects: RuntimeEffectStatus[];
  deliveries: RuntimeDeliveryStatus[];
  activeSegment?: {
    id: string;
    openedAt: string;
    lastActivityAt: string;
  };
  activities: RuntimeActivityStatus[];
  threadMaintenance: RuntimeThreadMaintenanceStatus[];
  attentionMaintenance?: RuntimeAttentionMaintenanceStatus;
  memoryReflection?: RuntimeMemoryReflectionStatus;
  proactivePulse?: RuntimePulseStatus;
  afterChatContinuation?: RuntimeAfterChatContinuationStatus;
}

export interface RuntimeOptions {
  root: string;
  timePolicy?: TimePolicy;
  execution?: AgentExecution;
  outboundDelivery?: OutboundDelivery;
  activityLifecycle?: ActivityLifecycle;
  activityRecorder?: ActivityRecorder;
  threadMaintenance?: ThreadMaintenance;
  attentionMaintenance?: AttentionMaintenance;
  memoryReflection?: MemoryReflection;
  orientation?: Orientation;
  now?: () => Date;
  nextId?: () => string;
  ownerId?: string;
  leaseDurationMs?: number;
}

export interface AdvanceOptions {
  agentWork?: "allow" | "defer";
  observedAt?: Date;
}

export type AdvanceResult =
  | { disposition: "idle" }
  | { disposition: "turn_completed" }
  | { disposition: "delivery_completed" }
  | { disposition: "delivery_not_sent" }
  | { disposition: "delivery_requires_reconciliation" }
  | { disposition: "activity_recorded" }
  | { disposition: "activity_recording_failed" }
  | { disposition: "thread_maintenance_completed" }
  | { disposition: "thread_maintenance_failed" }
  | { disposition: "agent_work_deferred" }
  | { disposition: "busy" };

export type CloseActivityResult =
  | { disposition: "no_activity" }
  | { disposition: "not_due"; openedAt: string; lastActivityAt: string }
  | { disposition: "busy" }
  | { disposition: "activity_frozen"; activityId: string };

export interface CloseActivityOptions {
  inactiveBefore?: string;
  openedBefore?: string;
}

export type FormOpportunityResult =
  | { disposition: "accepted"; inputId: string; runId: string }
  | { disposition: "none"; runId: string }
  | { disposition: "busy" }
  | { disposition: "stale"; runId: string };

export interface RunOpportunityPulseOptions {
  observedAt: Date;
  initialDelayMs: number;
  cadenceMs: number;
  retryDelayMs: number;
  agentWork?: "allow" | "defer";
}

export interface RunAfterChatContinuationOptions {
  observedAt: Date;
  agentWork?: "allow" | "defer";
}

export type RunAfterChatContinuationResult =
  | { disposition: "none" }
  | { disposition: "waiting"; nextRunAt: string }
  | { disposition: "admitted"; inputId: string }
  | { disposition: "expired" }
  | { disposition: "agent_work_deferred"; nextRunAt: string }
  | { disposition: "busy" };

export interface RunAttentionMaintenanceOptions {
  observedAt: Date;
  initialDelayMs: number;
  cadenceMs: number;
  retryDelayMs: number;
  agentWork?: "allow" | "defer";
}

export type RunAttentionMaintenanceResult =
  | { disposition: "waiting"; nextRunAt: string }
  | { disposition: "completed"; result: AttentionMaintenanceResult; nextRunAt: string }
  | { disposition: "busy" }
  | { disposition: "agent_work_deferred"; nextRunAt: string }
  | { disposition: "failed"; nextRunAt: string; error: string };

export interface RunMemoryReflectionOptions {
  observedAt: Date;
  delayMs: number;
  retryDelayMs: number;
  agentWork?: "allow" | "defer";
}

export type RunMemoryReflectionResult =
  | { disposition: "waiting"; nextRunAt: string }
  | { disposition: "completed"; reflectionDay: string; result?: MemoryReflectionResult; nextRunAt: string }
  | { disposition: "busy" }
  | { disposition: "agent_work_deferred"; nextRunAt: string }
  | { disposition: "failed"; reflectionDay: string; nextRunAt: string; error: string };

export type RunOpportunityPulseResult =
  | { disposition: "waiting"; nextRunAt: string }
  | { disposition: "accepted"; inputId: string; runId: string; nextRunAt: string }
  | { disposition: "none"; runId: string; nextRunAt: string }
  | { disposition: "busy" }
  | { disposition: "stale"; runId: string }
  | { disposition: "agent_work_deferred"; nextRunAt: string }
  | { disposition: "failed"; nextRunAt: string; error: string };

export interface Runtime {
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  formOpportunity(): Promise<FormOpportunityResult>;
  runOpportunityPulse(options: RunOpportunityPulseOptions): Promise<RunOpportunityPulseResult>;
  runAfterChatContinuation(options: RunAfterChatContinuationOptions): Promise<RunAfterChatContinuationResult>;
  runAttentionMaintenance(options: RunAttentionMaintenanceOptions): Promise<RunAttentionMaintenanceResult>;
  runMemoryReflection(options: RunMemoryReflectionOptions): Promise<RunMemoryReflectionResult>;
  advance(options?: AdvanceOptions): Promise<AdvanceResult>;
  closeActivity(options?: CloseActivityOptions): Promise<CloseActivityResult>;
  frozenActivity(activityId: string): FrozenActivity | undefined;
  status(): RuntimeStatus;
  close(): void;
}
