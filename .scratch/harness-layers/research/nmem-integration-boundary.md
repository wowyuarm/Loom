# nmem Integration Boundary Research

Status: incorporated into Tickets 19-20
Date: 2026-07-21

## Question

What should Loom's first nmem Integration own, which Loom evidence should enter nmem, and which nmem results should return to the Main Agent or Cognitive Organs without making nmem a Runtime prerequisite?

## Existing Loom Constraints

- An Episode is a Workspace-native replayable scene. Its existence and Life Recorder Receipt do not depend on external import.
- Frozen Activity is immutable Runtime evidence. It may contain raw thinking, tool calls/results, Effects and Delivery facts; it is not itself a memory summary.
- Primary Agent Transcript is append-only execution evidence, not Runtime or memory authority.
- Runtime Store owns durable Integration receipts and recovery facts. Agent Workspace remains the semantic source for Daily, Episodes, Threads and Individual material.
- nmem is a maintained Cognitive Integration, but Main Agent execution, Workspace continuity, Transcript, Activity recording and recovery must continue while it is offline.

Sources: Loom tickets [08](../issues/08-run-life-recorder-from-frozen-activity.md), [10](../issues/10-define-replayable-episodes-and-recorder-method.md), [11](../issues/11-close-activity-lifecycle.md), and Xi source tickets [08](../../../../Xi/.scratch/harness-generalization/issues/08-define-nmem-cognitive-integration-boundary.md), [09](../../../../Xi/.scratch/harness-generalization/issues/09-set-runtime-store-storage-and-recovery-boundaries.md).

## Xi Source Findings

Xi currently has separate paths for:

1. Episode -> nmem Memory upsert.
2. One logical day's cleaned session/outbox -> nmem Thread import.
3. Explicit `recall` -> nmem Memory search.
4. Manual nightly triggers -> graph extraction, communities, crystallization, daily briefing and compaction.
5. Working Memory server file -> Workspace mirror.
6. Feed event auto-confirmation.

Useful inherited contracts:

- Episode IDs are suitable external idempotency keys.
- Recall is explicit, bounded and failure-soft; Life Recorder does not receive it.
- Full conversation evidence and curated Episodes serve different purposes.
- External output is evidence for later organ judgment, not a behavior command.

Xi-specific implementation should not be copied:

- Episode frontmatter currently carries `pending` / `failed` / `synced`, mixing Integration state into Workspace memory.
- Activity import reconstructs participants and daily boundaries from Xi-specific transcript strings, filenames, outbox and timezone.
- Nightly requires all triggers to succeed before writing a marker, making partial external failure block later reflection.
- Working Memory is copied from a server-local filesystem path even though the current API exposes it directly.
- The current recall request/response compatibility code predates the current REST schema.

Source snapshot: Xi `944ff72c8a0064e79703a87c889dbde1da5964ed`, especially `src/memory/nmem/`, `src/memory/episodes/nmem-sync.ts`, `src/tools/recall.ts`, and `src/runtime/cognitive-maintenance.ts`.

## Current First-Party nmem Findings

Observed locally on 2026-07-21:

- CLI `0.10.25`, server `0.10.31`, healthy local REST endpoint at `http://127.0.0.1:14242`.
- The server's OpenAPI document advertises API version `0.9.15`, so Loom should validate capabilities and response shapes rather than equate that field with the server release.
- `POST /memories` supports a caller-owned `id` as an upsert key and accepts provenance, event date, type, labels and metadata.
- `POST /threads/{thread_id}/append` supports message deduplication and a stable `idempotency_key`.
- Memory search and Thread search/fetch are distinct APIs. A tool claiming to recall both must call both deliberately rather than relabel Memory search results as Threads.
- `GET /agent/working-memory` is the supported read surface; no shared server filesystem is required.
- The server performs reactive processing after a saved/imported Thread and schedules crystallization and other periodic maintenance itself. A host normally does not need to manually trigger the whole pipeline.
- The official Pi package uses direct REST for automatic Thread synchronization and the CLI for interactive skills/startup convenience. The official OpenClaw plugin also uses REST for Thread capture and makes automatic per-prompt recall optional.
- There is no first-party general TypeScript SDK package. The published packages are host connectors; adopting one would import Pi/OpenClaw lifecycle policy rather than just an API client.

Primary sources:

- [Nowledge Mem repository](https://github.com/nowledge-co/nowledge-mem)
- [Official community connectors](https://github.com/nowledge-co/community/tree/692a23727bf9e70e5b15adab96aae0333ff140d3)
- [Official Pi package](https://github.com/nowledge-co/community/tree/692a23727bf9e70e5b15adab96aae0333ff140d3/nowledge-mem-pi-package)
- [Official OpenClaw connector](https://github.com/nowledge-co/community/tree/692a23727bf9e70e5b15adab96aae0333ff140d3/nowledge-mem-openclaw-plugin)
- [Headless server background processing](https://github.com/nowledge-co/community/blob/692a23727bf9e70e5b15adab96aae0333ff140d3/docker/README.md#background-intelligence-throughput)
- Local server `GET /openapi.json` and `GET /capabilities`, server `0.10.31`.

## Recommended Boundary

### Transport

Use a small Loom-owned REST adapter built on Node `fetch`. Do not require the `nmem` CLI at Runtime, adopt a host connector, add a third-party partial SDK, or prebuild a generic `MemoryProvider`.

The adapter owns authentication headers, timeout, capability probing, request/response validation, error classification and redacted diagnostics. Higher modules see nmem-specific operations, not URLs or wire schemas.

### First Vertical Slice

Implement Episode export and explicit `nmem-recall` together:

- Episode export proves Loom can contribute its own durable memory evidence.
- Explicit recall proves the returned evidence can be used without automatic per-Turn injection.
- Stable Episode IDs make export retries idempotent.
- The round trip is useful even before logical day, scheduler, Memory Reflector or Working Memory projection exist.

Do not make Life Recorder call nmem. The Integration reconciler may only discover Episodes through durable Life Recorder Receipts in Runtime Store, then read the listed Workspace files, compare them with nmem Integration receipts and upsert missing or changed Episodes. A directory scan alone is unsafe: an Episode can exist temporarily during a Recorder run and then be rolled back when that run fails. Failure records a bounded retry state but does not alter the Episode or Recorder Receipt.

### Evidence Ingress

- **Episode:** yes, as a typed nmem Memory with stable ID and Workspace provenance.
- **Frozen Activity:** yes through a deterministic nmem Conversation Thread projection, never as a raw upload. Each closed Segment keeps human input, delivered replies and compact private activity while excluding thinking, raw tool results and unconfirmed outbound content.
- **Primary Agent Transcript:** no direct raw import for the same reason and because it is an execution log rather than a memory contract.
- **Conversation Thread projection:** yes. One closed Active Segment becomes one stable nmem Thread, independent of Life Recorder completion. Compact private activity complements Episodes so ordinary autonomous life is not absent from nmem. Do not reuse Xi's daily transcript parser.
- **Daily / Current Attention / Long-term Memory / Threads:** do not bulk sync in the first slice. Their later use should be justified by a concrete nmem capability rather than treating every Workspace file as ingestion material.

### Evidence Egress

- Main Agent and selected Cognitive Organs receive explicit `nmem-recall`, not automatic search on every Turn.
- Life Recorder does not receive recall because it records current evidence.
- Memory results and Thread results remain distinguishable, carry stable references/provenance, and are described as untrusted historical evidence.
- Working Memory is a later Integration evidence surface for Attention Maintainer and Memory Reflector. It should be fetched via REST and cached with source time/freshness; whether that cache is exposed as a Workspace projection or an Integration-only tool remains a product boundary decision.

### Degraded Behavior

- Unconfigured: `nmem-recall` reports unavailable; reconciliation does no external work; the rest of Loom is healthy.
- Temporary timeout/5xx: return a short unavailable result to the model, record one observable degraded state, retain pending reconciliation and retry with backoff.
- Authentication or incompatible API: mark the Integration blocked until configuration/service changes; do not retry every Turn.
- Stale Working Memory: later organs may use the last successful projection only with explicit freshness metadata; it cannot be a gate for Main Agent or Activity recording.
- Recovery is source-driven: durable Life Recorder Receipt establishes that an Episode is committed, the listed Workspace Episode plus stable ID supplies its semantic content, and Integration receipts prevent repeat work without replacing either source.

## Interface Review

The implemented nmem Module presents three nmem-specific narrow Interfaces rather than exposing a generic provider or wire client:

- a recall Interface used to build the `nmem-recall` tool;
- an Episode reconciliation Interface that consumes committed Episode references and owns idempotent export, receipts, backoff and diagnostics.
- a Conversation Thread reconciliation Interface that consumes immutable Frozen Activity and owns deterministic projection, idempotent creation, receipts, backoff and diagnostics.

HTTP, auth, capability checks, response normalization and receipt schema remain internal to the nmem Module. Tests and callers cross these Interfaces; they do not call the REST client or inspect nmem tables directly. Working Memory should add its own evidence Interface only when implemented.

## Decisions Still Worth Discussing

1. Should cached nmem Working Memory be a clearly marked derived file inside Agent Workspace, or remain Integration state exposed to organs through a dedicated tool?
2. Should Loom ever manually trigger nmem maintenance, or rely on nmem's reactive and periodic processing and only observe freshness? Current evidence favors observation, with manual triggering deferred until a real unmet need appears.

The first vertical slice was completed by [Ticket 19](../issues/19-integrate-nmem-episodes-and-recall.md). Conversation Thread projection, including compact private activity, was completed by [Ticket 20](../issues/20-project-conversation-activities-to-nmem-threads.md). The questions above remain follow-up decisions.
