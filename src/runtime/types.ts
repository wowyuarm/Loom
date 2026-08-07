import type { TimePolicy } from "../configuration/index.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type InputKind = "interaction" | "opportunity" | "continuation";
export type RuntimeInputKind = Exclude<InputKind, "continuation">;

export type ActorReference = "individual" | "human" | "system" | `external:${string}`;

export interface InteractionActor {
  actorRef: ActorReference;
  kind: "individual" | "human" | "agent" | "system";
  label?: string;
}

export interface InteractionPlace {
  placeRef: string;
  kind: "direct" | "channel" | "reply_thread";
  label?: string;
  visibility: "private" | "restricted" | "public";
}

export interface InteractionAudience {
  visibility: "private" | "restricted" | "public";
  description: string;
  actorRefs?: ActorReference[];
}

export interface InteractionReference {
  kind: "message" | "thread" | "task" | "reminder" | "other";
  ref: string;
}

export interface InteractionDestination {
  destinationRef: string;
  routeRef: string;
  kind: "top_level" | "reply_thread";
  label?: string;
}

export interface InteractionContext {
  routeRef: string;
  signal: "direct_message" | "mention" | "thread_reply" | "task" | "reminder" | "channel_activity" | "other";
  actor: InteractionActor;
  place: InteractionPlace;
  audience: InteractionAudience;
  references: InteractionReference[];
  destinations: InteractionDestination[];
  defaultDestinationRef?: string;
}

export interface RuntimeInput {
  source: string;
  sourceId: string;
  kind: RuntimeInputKind;
  payload: JsonValue;
  interaction?: InteractionContext;
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
  actorRef: ActorReference;
  kind: "input" | "output" | "thinking" | "tool_call" | "tool_result" | "effect" | "delivery" | "system";
  content: JsonValue;
  interaction?: InteractionContext;
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
    interaction?: InteractionContext;
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
    destinationRef?: string;
    createdAt: string;
    endedAt?: string;
    status: RuntimeEffectStatus["status"];
  }>;
  deliveries: Array<{
    id: string;
    effectId: string;
    turnId: string;
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
  cancel?(reason: string): Promise<void>;
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
  cancel?(reason: string): Promise<void>;
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
  cancel?(reason: string): Promise<void>;
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
  cancel?(reason: string): Promise<void>;
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
      acknowledgeExternalEvidence?: () => Promise<void>;
    }
  | {
      outcome: "none";
      runId: string;
      whyNow: string;
      evidence: string[];
      acknowledgeExternalEvidence?: () => Promise<void>;
    };

export interface Orientation {
  form(request: OrientationRequest): Promise<OrientationResult>;
}

export interface ExecutionInput {
  id: string;
  kind: InputKind;
  payload: JsonValue;
  interaction?: InteractionContext;
  occurredAt: string;
  inclusionPosition: number;
  /**
   * True when this Interaction arrived after the previous reply of its
   * scope was committed (its reply gate closed) but before that reply's
   * Delivery was confirmed. The mark is fixed at accept time and persists
   * even if the Delivery is confirmed later. The next Turn carries it so
   * the agent can answer in context instead of treating the message as a
   * fresh, unrelated one. An unconfirmed Delivery only means the human
   * may not have seen the reply yet, not that they certainly had not.
   */
  lateArriving?: boolean;
  /**
   * True when this Interaction joined a running Turn only because its
   * reply gate was still open: it arrived after its wave was sealed but
   * before the first reply commit. The agent is told it arrived before
   * the reply was committed and should re-evaluate the current reply.
   */
  lateSteered?: boolean;
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
  destinationRef?: string;
}

export interface EffectReceipt {
  effectId: string;
}

export type InteractionDecisionRequest =
  | { outcome: "send"; effect: EffectRequest }
  | { outcome: "no_reply" };

export type InteractionDecisionReceipt =
  | { outcome: "send"; effect: EffectReceipt }
  | { outcome: "no_reply" };

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
  commitInteractionDecision?(
    decision: InteractionDecisionRequest,
  ): Promise<InteractionDecisionReceipt>;
}

export interface DeliveryAttemptRequest {
  attemptId: string;
  effectId: string;
  kind: string;
  payload: JsonValue;
  routeRef: string;
  destinationRef?: string;
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
  interaction?: InteractionContext;
  interactionWaveId?: string;
  status: "pending" | "active" | "consumed" | "blocked";
}

export interface InteractionViewEntry {
  id: string;
  at: string;
  actorRef: ActorReference;
  source: string;
  inputIds: string[];
  content: JsonValue;
}

export interface InteractionViewOptions {
  after?: string;
  limit?: number;
}

export interface InteractionViewPage {
  entries: InteractionViewEntry[];
  cursor?: string;
  hasMore: boolean;
}

export type RuntimeInputOutcome =
  | { state: "pending" }
  | { state: "completed"; outcome: "completed" | "no_reply" }
  | { state: "failed"; reason: string }
  | { state: "blocked"; reason: string };

export type RequeueInputResult =
  | { disposition: "requeued" }
  | { disposition: "not_blocked" };

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
  destinationRef?: string;
  coveredInputPosition: number;
  status: "pending" | "completed" | "reconciliation_required" | "abandoned";
  nextDeliveryAt?: string;
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
  oldestPendingOrganAt?: string;
  oldestPendingOrganAgeMs?: number;
  integrityWarnings: RuntimeIntegrityWarning[];
}

export interface RuntimeIntegrityWarning {
  kind: "unexplained_terminal_turn_segment";
  segmentId: string;
  turnIds: string[];
}

export type RuntimeAgentName =
  | "main-agent"
  | "orientation"
  | "life-recorder"
  | "attention-maintainer"
  | "memory-reflector"
  | "thread-maintainer";

export interface RuntimeAgentRunSummary {
  runId: string;
  name: RuntimeAgentName;
  startedAt: string;
  endedAt?: string;
  result: "running" | "succeeded" | "failed" | "interrupted";
  outcome?: string;
  failureCategory?: string;
}

export interface RuntimeAgentOperationalStatus {
  name: RuntimeAgentName;
  state: "running" | "retrying" | "never_run" | "succeeded" | "failed";
  latest?: RuntimeAgentRunSummary;
  nextRunAt?: string;
  history?: RuntimeAgentRunSummary[];
}

export interface RuntimeOperationalStatus {
  agents: RuntimeAgentOperationalStatus[];
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
  observe?: import("../operational-events.js").OperationalEventObserver;
  /** Model Runtime Revision provider; the revision id is fixed per Cognitive Organ attempt. */
  revisions?: { current(): { id: string } };
  /** Cognitive Organ execution policy; defaults to the module constant. */
  cognitiveOrganPolicy?: import("./cognitive-organ-execution.js").CognitiveOrganPolicy;
  /** Injectable soft-deadline timer factory (testing); defaults to setTimeout/clearTimeout. */
  organCancelTimer?: (
    delayMs: number,
    callback: () => void,
  ) => { clear(): void };
}

export interface AdvanceOptions {
  agentWork?: "allow" | "defer";
  observedAt?: Date;
}

export type AdvanceResult =
  | { disposition: "idle" }
  | { disposition: "turn_completed" }
  | { disposition: "delivery_completed" }
  | { disposition: "delivery_not_sent"; nextRunAt: string }
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
  | { disposition: "stale"; runId?: string }
  | { disposition: "agent_work_deferred"; nextRunAt: string }
  | { disposition: "failed"; nextRunAt: string; error: string };

export interface Runtime {
  acceptInput(input: RuntimeInput): Promise<AcceptedInput>;
  requeueInput(inputId: string): RequeueInputResult;
  formOpportunity(): Promise<FormOpportunityResult>;
  runOpportunityPulse(options: RunOpportunityPulseOptions): Promise<RunOpportunityPulseResult>;
  runAfterChatContinuation(options: RunAfterChatContinuationOptions): Promise<RunAfterChatContinuationResult>;
  runAttentionMaintenance(options: RunAttentionMaintenanceOptions): Promise<RunAttentionMaintenanceResult>;
  runMemoryReflection(options: RunMemoryReflectionOptions): Promise<RunMemoryReflectionResult>;
  advance(options?: AdvanceOptions): Promise<AdvanceResult>;
  closeActivity(options?: CloseActivityOptions): Promise<CloseActivityResult>;
  frozenActivity(activityId: string): FrozenActivity | undefined;
  interactionView(options?: InteractionViewOptions): InteractionViewPage;
  inputOutcome(inputId: string): RuntimeInputOutcome;
  status(): RuntimeStatus;
  operationalStatus(options?: { since?: string }): RuntimeOperationalStatus;
  close(): void;
}
