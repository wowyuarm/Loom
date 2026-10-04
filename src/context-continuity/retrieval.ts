import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  createSearchTools,
  foldContextProjection,
  readContextTimeline,
  compactibleNow,
  StoredSessionReadError,
  type ContextProjectionConfig,
  type ContextSearchAdapter,
  type ContextSearchPort,
  type ContextComposition,
  type ContextTimeline,
  type ContextTimelineSource,
  type ContinuityToolAdapter,
  type CheckpointToolRequest,
  type RolloverToolRequest,
  type ContextSearchTools,
  type ContextCompactionScope,
  type StoredSessionReadResult,
} from '@wowyuarm/dsh-context-continuity'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { LOOM_SUBJECT_ID, type LoomSubjectId, type LoomContextContinuityHost } from './host.ts'

// Loom's context-budget bounds, matching DSH's compaction/handoff shape: the handoff budget is
// where a return anchor stops being worth selecting, the hard limit is the working wall. Both
// are capped so an unusually large route window does not price an oversized return as fine.
const CONTEXT_HARD_LIMIT_CAP = 256_000
const CONTEXT_HANDOFF_AT_CAP = 200_000
const CONTEXT_SAFE_OUTPUT_RESERVE = 16_000
const CONTEXT_HANDOFF_RESERVE = 8_000
/** How many archived ancestors the timeline walk and the seed resolution follow. */
const MAX_LINEAGE_ANCESTORS = 64

/** The context budget one generation is priced against; derived from the route's context window. */
export interface ContextBudget {
  readonly usageTokens: number
  readonly handoffAt: number
  readonly hardLimit: number
}

/** Derive the handoff and hard-limit budgets from a route's context window, DSH's own formula. */
export function contextBudgetFrom(usageTokens: number, contextWindow: number): ContextBudget {
  const hardLimit = Math.min(CONTEXT_HARD_LIMIT_CAP, Math.max(0, contextWindow - CONTEXT_SAFE_OUTPUT_RESERVE))
  const handoffAt = Math.min(CONTEXT_HANDOFF_AT_CAP, Math.max(0, hardLimit - CONTEXT_HANDOFF_RESERVE))
  return { usageTokens, handoffAt, hardLimit }
}

/** One resolved checkpoint seed: the exact contiguous prefix through the anchor and its source. */
export interface CheckpointSeed {
  readonly checkpointRef: string
  readonly sourceSessionId: SessionId
  readonly prefix: readonly SessionEvent[]
}

export interface LoomRetrievalDeps {
  /** The live agent whose lineage is read; undefined when not activated. */
  readonly agentForSubject: () => Agent | undefined
  /** The projection host, for its checkpoint ref naming and its fold contribution. */
  readonly host: LoomContextContinuityHost
  /** The fold configuration shared with the registered projection unit. */
  readonly config: ContextProjectionConfig
  /** Read one archived ancestor's stored log. */
  readonly readAncestor: (sessionId: SessionId) => Promise<StoredSessionReadResult>
  /** The process token meter, or undefined when none is mounted. */
  readonly meter: () => TokenMeter | undefined
  /** The current generation's context budget, or undefined when the route window is unknown. */
  readonly budgetOf: (agent: Agent) => Promise<ContextBudget | undefined>
  /** Every session id the subject ever lived in: the search-authorization set. */
  readonly ownedSessions: () => readonly string[]
  /** The session-query capability the search ladder runs on. */
  readonly query: ContextSearchPort
  /** The compaction engine in one agent's own scope, for `context_compact`. */
  readonly compactionFor?: (agent: Agent) => CompactionEngine | undefined
  /** The live session's context breakdown, for `context_status`'s composition line. */
  readonly compositionOf?: (agent: Agent) => ContextComposition | undefined
}

/**
 * The retrieval and return surface over Loom's single-agent lineage: it completes the model-facing
 * continuity tool adapter (checkpoint, timeline, restorable-ref verdict) and the search adapter,
 * and resolves a cited checkpoint ref to the exact seed prefix a return rolls the successor onto.
 * Every read walks the current generation and its `parentSession` ancestors; the search set also
 * covers off-lineage branches through the owned-session ledger.
 */
export class LoomContextRetrieval {
  constructor(private readonly deps: LoomRetrievalDeps) {}

  /** Build the current generation as a timeline/seed source. */
  private currentSource(agent: Agent): ContextTimelineSource {
    return {
      sessionId: agent.session.id,
      header: agent.session.header,
      inheritedEventCount: agent.session.inheritedEventCount,
      events: agent.session.snapshotEvents(),
    }
  }

  /**
   * One source's replayed token count in its own tokens: the live generation through the meter
   * directly, an ancestor through a detached rebuild so a small current generation never disguises
   * a large ancestor's real cost. Undefined when no meter exists or a rebuild fails — priced as
   * unknown, never as free.
   */
  private measure(source: ContextTimelineSource, agent: Agent): number | undefined {
    const meter = this.deps.meter()
    if (meter === undefined) return undefined
    if (String(source.sessionId) === String(agent.session.id)) return meter.measure(agent.session)?.totalTokens
    try {
      return meter.measure(Session.create(source.sessionId, source.events, source.header, source.inheritedEventCount))?.totalTokens
    } catch {
      return undefined
    }
  }

  private requireAgent(): Agent {
    const agent = this.deps.agentForSubject()
    if (agent === undefined) throw new Error('loom: no live agent to read the context timeline')
    return agent
  }

  /** Read the subject's bounded return-anchor timeline across the current generation and ancestors. */
  async timeline(limit?: number): Promise<ContextTimeline> {
    const agent = this.requireAgent()
    const budget = await this.deps.budgetOf(agent)
    const usageTokens = budget?.usageTokens ?? this.deps.meter()?.measure(agent.session)?.totalTokens ?? 0
    const timeline = await readContextTimeline({
      current: this.currentSource(agent),
      config: this.deps.config,
      readAncestor: id => this.deps.readAncestor(id),
      measureSource: source => this.measure(source, agent),
      currentUsageTokens: usageTokens,
      handoffAt: budget?.handoffAt ?? CONTEXT_HANDOFF_AT_CAP,
      ...(budget?.hardLimit === undefined ? {} : { hardLimit: budget.hardLimit }),
      maxAncestors: MAX_LINEAGE_ANCESTORS,
      ...(limit === undefined ? {} : { limit }),
    })
    // What a compaction started now could replace is priced by the status read only, so the
    // anti-forgery verdict below never depends on the compaction scope resolving.
    return timeline
  }

  /**
   * What `context_status` reports: the anchors plus what a compaction started now could replace,
   * priced by the same selection `context_compact` runs so the status and the action it announces
   * cannot disagree. Absent when this scope mounts no engine — the status then promises no
   * capability the subject does not have.
   */
  async status(limit?: number): Promise<ContextTimeline> {
    const agent = this.requireAgent()
    const timeline = await this.timeline(limit)
    const scope = this.compactionScope(agent)
    const priced = scope === undefined ? undefined : compactibleNow(agent.session, scope)
    // Composition and compactible are independent optional lines: each is dropped when it cannot
    // be answered, so the status never states a capability the subject does not have.
    const composition = this.deps.compositionOf?.(agent)
    return {
      ...timeline,
      ...(composition === undefined ? {} : { composition }),
      ...(priced === undefined ? {} : { compactible: priced }),
    }
  }

  /**
   * The compaction capability `context_compact` acts through: the engine mounted in this agent's
   * own preset scope plus the meter that prices the range it would keep. Resolving it is host
   * addressing (a preset service is invisible to `ctx.get('compaction')`); `undefined` means this
   * composition mounts no engine, which the tool reports rather than rejects.
   */
  private compactionScope(agent: Agent): ContextCompactionScope | undefined {
    const engine = this.deps.compactionFor?.(agent)
    if (engine === undefined) return undefined
    const meter = this.deps.meter()
    return meter === undefined ? { engine } : { engine, meter }
  }

  /**
   * Whether one checkpoint ref is a restorable return target — the same verdict the timeline
   * shows, read from it, so the two surfaces cannot disagree. The engine turns a false into a
   * model-visible rejection.
   */
  async isRestorableRef(checkpointRef: string): Promise<boolean> {
    const timeline = await this.timeline()
    return timeline.items.some(item => item.ref === checkpointRef && item.restorable)
  }

  /** The context-continuity tool adapter, with rollover scheduling plus checkpoint/timeline. */
  toolAdapter(): ContinuityToolAdapter {
    return {
      // The tool's successful result is the durable fact the projection folds; the swap follows
      // at the next idle boundary. Nothing to do here but acknowledge.
      requestRollover: (_request: RolloverToolRequest, _exec: ToolRunContext) => Promise.resolve({ mode: 'scheduled' }),
      isRestorableRef: (ref: string) => this.isRestorableRef(ref),
      recordCheckpoint: (request: CheckpointToolRequest, exec: ToolRunContext) => this.recordCheckpoint(request, exec),
      timeline: (request: { readonly limit?: number }) => this.status(request.limit),
      compactionFor: (agent: Agent) => this.compactionScope(agent),
    }
  }

  /**
   * Record one checkpoint: the ref is derived from the recording session and the successful call,
   * so it is stable and collision-resistant across generations. The engine writes the returned
   * ref and name as the tool result, which the projection folds into a resolved checkpoint.
   */
  private recordCheckpoint(request: CheckpointToolRequest, exec: ToolRunContext): Promise<{ readonly checkpointRef: string; readonly name: string }> {
    const agent = this.requireAgent()
    const checkpointRef = this.deps.host.checkpointRefFor(String(agent.session.id), exec.callId)
    return Promise.resolve({ checkpointRef, name: request.name })
  }

  /**
   * Resolve a cited checkpoint ref to its seed prefix: walk the current generation and its
   * `parentSession` ancestors, fold each source respecting its inherited cut, and find the
   * checkpoint recorded in that source's own span. The seed is the contiguous prefix through the
   * anchor's completed turn. A return that would not shrink the working set, or would retain a
   * context at or above the handoff budget, or whose source cannot be priced, is refused so the
   * old generation stays intact — never a guessed seed over a wrong prefix.
   */
  async resolveCheckpointSeed(checkpointRef: string): Promise<CheckpointSeed> {
    const agent = this.requireAgent()
    const budget = await this.deps.budgetOf(agent)
    const handoffAt = budget?.handoffAt ?? CONTEXT_HANDOFF_AT_CAP

    let sessionId: SessionId | undefined = agent.session.id
    let live = true
    for (let walked = 0; sessionId !== undefined && walked <= MAX_LINEAGE_ANCESTORS; walked += 1) {
      let events: readonly SessionEvent[]
      let inheritedEventCount: SessionLogOffset
      let parentSession: SessionId | undefined
      let header: SessionHeader
      const sourceIsCurrent = live
      if (live) {
        events = agent.session.snapshotEvents()
        inheritedEventCount = agent.session.inheritedEventCount
        parentSession = agent.session.header.parentSession
        header = agent.session.header
        live = false
      } else {
        const read = await this.deps.readAncestor(sessionId)
        if (!read.ok) {
          throw new StoredSessionReadError(
            `checkpoint '${checkpointRef}' could not be resolved: its source session is unreadable (${read.failure.kind}: ${read.failure.detail})`,
            read.failure,
          )
        }
        events = read.inspection.events
        inheritedEventCount = read.inspection.inheritedEventCount
        parentSession = read.inspection.header.parentSession
        header = read.inspection.header
      }

      const state = foldContextProjection(events, this.deps.config, { sessionId, inheritedEventCount })
      const entry = state.checkpoints.find(candidate => candidate.checkpointRef === checkpointRef)
      if (entry !== undefined && entry.turnEndSeq !== -1) {
        const throughSeq = entry.turnEndSeq + 1
        const prefix = events.slice(0, throughSeq)
        if (prefix.length >= events.length) {
          throw new Error(`checkpoint '${checkpointRef}' return does not shrink the working set; use a fresh handoff instead`)
        }
        const sourceUsage = sourceIsCurrent
          ? this.deps.meter()?.measure(agent.session)?.totalTokens
          : this.measure({ sessionId, events, inheritedEventCount, header }, agent)
        if (sourceUsage === undefined) {
          throw new Error(`checkpoint '${checkpointRef}' could not be priced: its source session's context cost cannot be measured; use a fresh handoff instead`)
        }
        const retained = retainedEstimate(sourceUsage, events.length, entry.turnEndSeq)
        if (retained >= handoffAt) {
          throw new Error(`checkpoint '${checkpointRef}' return would retain a context at or above the handoff budget; use a fresh handoff instead`)
        }
        return { checkpointRef, sourceSessionId: sessionId, prefix }
      }
      sessionId = parentSession
    }
    throw new Error(`checkpoint '${checkpointRef}' does not resolve in this agent's lineage`)
  }

  /** The retrieval-ladder tools (`context_search`, `context_read`) over the subject's history. */
  searchTools(): ContextSearchTools {
    const adapter: ContextSearchAdapter<LoomSubjectId> = {
      subject: () => LOOM_SUBJECT_ID,
      activeSessionId: () => this.requireAgent().session.id,
      scope: {
        ownedSessions: () => this.deps.ownedSessions().map(id => SessionId(id)),
      },
      query: this.deps.query,
      config: this.deps.config,
      measureSource: source => {
        const agent = this.deps.agentForSubject()
        return agent === undefined ? undefined : this.measure(source, agent)
      },
      handoffAt: async () => {
        const agent = this.deps.agentForSubject()
        if (agent === undefined) return CONTEXT_HANDOFF_AT_CAP
        const budget = await this.deps.budgetOf(agent)
        return budget?.handoffAt ?? CONTEXT_HANDOFF_AT_CAP
      },
      maxAncestors: MAX_LINEAGE_ANCESTORS,
    }
    return createSearchTools(adapter)
  }
}

/** Retained-token estimate: the source's own usage scaled by the prefix share through the anchor. */
function retainedEstimate(sourceUsageTokens: number, sourceLength: number, anchorTurnEndSeq: number): number {
  if (sourceLength <= 0) return sourceUsageTokens
  const share = Math.min(1, Math.max(0, (anchorTurnEndSeq + 1) / sourceLength))
  return Math.round(sourceUsageTokens * share)
}
