# 04 - Implement the Raft Interaction Channel

Status: ready-for-human
Type: implementation
Blocked by: none

## Goal

Implement the accepted [Raft Interaction Channel design](../design/raft-individual-interaction-model.md)
as one complete Loom work unit: generic actor-aware Interaction facts, model-visible Channel behavior,
recoverable Raft ingress and Delivery, and one real Raft-only Instance acceptance pass.

This ticket does not add a generic plugin loader, multi-route policy, Raft task writes, reactions,
membership changes, profile synchronization, attachments, or a control plane.

## Implementation Stages

### 1. Runtime Interaction Facts

- Extend `actorRef` with stable namespaced external actors while preserving the principal `human`
  meaning and `lastHumanInputAt` behavior.
- Add explicit Interaction Context facts and opaque Interaction Destination refs to durable Input,
  Effect, Activity, status and recovery paths.
- Keep Route and Destination distinct. A prepared Effect fixes both and Delivery never reselects them.
- Preserve top-level and reply-thread default destinations exactly as defined by the design.

### 2. Main Agent and Orientation Surface

- Replace the fixed `<human_input>` presentation with actor-aware Interaction Context.
- Add conditional Channel Guidance after Long-term Memory and inject the channel-use reminder only
  for the first Interaction in a Runtime Turn.
- Make generic `message` accept or infer only Context-authorized Destinations; require an explicit
  choice when more than one is available.
- Add the four Raft read tools through the Channel Agent Surface.
- Add fixed-revision ambient Raft evidence to Orientation only when new evidence exists, and advance
  the presented revision only after a successful Opportunity or grounded `none`.

### 3. Raft Adapter and Host Lifecycle

- Pin and validate the Raft CLI behavior used by the Adapter.
- Implement activation boundary, credential/self binding validation, bridge wake ledger,
  `message resolve` normalization, wake recovery and Runtime message-ID deduplication. Do not
  invent an External Agent cursor that Raft 0.0.17 does not expose.
- Implement `raft_places`, `raft_activity`, `raft_search` and `raft_open` with bounded pagination and
  opaque refs. Unavailable or side-effecting Raft behavior must be reported honestly.
- Implement text Delivery with `delivered`, `not_sent` and `unknown` classification; `unknown` never
  auto-retries.
- Add explicit Instance Configuration and Host assembly. Disabled Raft contributes no lifecycle,
  prompt section, tool or attention evidence.

### 3a. Real-use thread context follow-up

The first real Raft use exposed one focused gap: a Main Agent that is mentioned in a reply thread
receives the triggering message, but cannot reliably recover the discussion it belongs to. This is a
follow-up to the mechanical implementation, not a reason to add a general Raft tool registry.

- Keep one `raft_open` surface and extend it for a known message or thread ref.
- Opening a message ref must return its actual bounded message evidence, including sender, time,
  body, place, audience and visibility. The result must not be only a generic success sentence.
- When the ref belongs to a reply thread, return the thread anchor and the nearest bounded set of
  replies. Each reply carries sender, time, body, actor/audience/visibility facts and an opaque
  reply Destination when one is available.
- Do not turn opened context into a Loom Input, follow the thread, acknowledge it, or expose raw
  Raft targets and cursors. The model receives enough context to decide whether and how to reply;
  it does not receive unrestricted history.
- Cover the contract with a public fake-remote test, then validate it in HaL's real Raft-only
  Instance against a thread with multiple replies. Keep task/reminder reads, reactions and write
  tools outside this follow-up until a separate real workflow requires them.

### 4. Real Acceptance and Hardening

- Run one Raft-only prepared test Instance with a separate non-personal Workspace and credential.
- Verify direct DM, mention or followed-thread ingress as available, ordinary ambient activity,
  reply Destination, proactive principal DM capability, real bridge behavior across Host downtime,
  and graceful restart. Claim offline-complete recovery only if the pilot proves it.
- Interrupt ingress before and after Runtime acceptance and interrupt Delivery around the remote
  send boundary. Verify no lost durable Input and no automatic duplicate after an unknown send.
- Inspect actual Main Agent Context, public Interaction history, Frozen Activity and Raft remote
  messages for actor, audience, visibility and Destination correctness.

## Test Seams

Tests cross only these confirmed public Interfaces:

1. **Runtime public Interface**: accepts actor-aware Inputs, exposes outcomes/status/Activity, and
   preserves Effect Route/Destination and recovery behavior.
2. **Main Agent public Interface**: receives Channel Guidance and Interaction Context, offers the
   conditional tools, and prepares Effects only for authorized Destinations.
3. **Raft Channel public Interface**: normalizes remote evidence, provides bounded reads, persists
   wake/cursor state and classifies Delivery without exposing credentials or CLI targets.
4. **Host public Interface**: assembles and owns enabled Raft lifecycle, ingress, status and graceful
   stop while leaving disabled Raft absent.

Tests must not inspect private SQLite tables, assert prompt strings, or claim model judgment quality
from a faux provider. Each stage proceeds as vertical TDD slices: one failing public behavior test,
the minimum implementation, then the next behavior.

## Acceptance

- `npm run typecheck`, `npm test` and `npm run build` pass.
- Public tests cover crash/restart behavior at the Runtime and Raft Channel seams.
- A real version-pinned Raft CLI and server complete the Stage 4 scenarios with saved non-secret
  evidence in this ticket or a linked evaluation directory.
- The design, `CONTEXT.md`, configuration docs and actual model-visible behavior agree.
- Mechanical implementation, tests and necessary documentation are reviewed and committed as one
  coherent work unit. Real acceptance is still required before this ticket can close.

## Current Evidence

Mechanical implementation is complete and committed with this ticket:

- Runtime preserves namespaced actors, Interaction Context, Route and Destination through Input,
  Effect, Delivery, Activity, recovery and Interaction View.
- Main Agent and Orientation receive the conditional Raft surface only when the Integration is
  enabled; four read tools and the principal proactive DM are assembled through the Host.
- `@botiverse/raft@0.0.17` is a pinned package dependency. The CLI Adapter validates the profile
  bindings, owns an ephemeral loopback wake endpoint and bridge process, persists wake handling,
  and classifies text Delivery as delivered, not sent or unknown.
- The full public test suite passes 314 tests together with typecheck, build and `git diff --check`.
  `npm audit --omit=dev` could not complete because the npm registry TLS connection ended before
  the advisory response; no security result is claimed.
- [Raft Interaction Channel](../../../docs/integrations/raft.md) records the actual configuration,
  lifecycle, tool surface, limits and Operator Agent acceptance procedure.
- The thread-context follow-up is mechanically implemented: `raft_open` now returns bounded message
  evidence and, for reply-thread refs, an anchor plus nearby replies. Public fake-remote and pinned
  CLI parser tests cover the body, audience/visibility facts and opaque reply Destinations. It does
  not follow, acknowledge, create a Loom Input, or expose raw targets/cursors.

The remaining gate is Stage 4 against a separate non-personal Raft credential and server. Until
that evidence exists, offline recovery, real CLI parsing, actor/audience projection and remote
reply behavior are not accepted, and this ticket stays open. The thread-context follow-up above is
also not implemented or accepted yet; the current four read tools remain the mechanical surface.
