# 50 - Let human Input supersede a running Orientation

Type: implementation
Status: resolved
Blocked by: None

## Problem

The Process Driver is intentionally serial, but a Proactive Pulse currently
waits for the Orientation model call inside `runOnce`. A human Input can be
accepted durably while that call is running, yet the Main Agent cannot start
until the Orientation promise settles. A completed-but-unclaimed Opportunity
can also be selected before a newer human Input.

Xi's validated lifecycle gives human interaction precedence at this seam:
the Main Agent can be steered when a Turn is live, while a pure Orientation
result is discarded when human activity wins the idle race. Loom must preserve
the same distinction without interrupting Workspace-writing Cognitive Organs.

## Confirmed Semantics

- Accepting an `interaction` Input immediately invalidates any in-flight
  Orientation admission. The pending call remains read-only and may finish
  later, but its result cannot create an Opportunity.
- A pending Opportunity that has not been claimed by a Main Agent Turn is an
  internal, un-lived possibility. A newer human Input removes it in the same
  acceptance transaction; the Runtime transition records why it was
  discarded, without exposing it as a failed human Input.
- A human Input arriving during a live Main Agent Turn keeps using the
  existing `steer` interface and remains in that Active Segment.
- Life Recorder, Attention Maintainer, Memory Reflector, Thread Maintainer,
  Delivery, and Activity close remain serialized. This ticket does not bypass
  their writes or external effects.
- No generic priority queue, model fallback, or provider cancellation is
  introduced. The special case exists because Orientation is a read-only
  pre-admission exploration whose result is already guarded by Runtime
  transition evidence.

## Test Seam

Tests use the public Runtime interface:

- A deferred Orientation is superseded by a human Input; `runOpportunityPulse`
  returns a stale result before the Orientation promise resolves, and the
  next `advance` runs the human Input.
- An already admitted but unclaimed Opportunity is removed when a human Input
  arrives; the next Turn claims only the human Input.
- Existing live-Turn steering and Activity-close behavior remain covered by
  their current Runtime tests.

Tests do not inspect SQLite, call private methods, assert prompt text, or
claim that a real model responds in a particular language or latency.

## Out of Scope

- Interrupting a live Main Agent Turn or changing Pi steering semantics.
- Interrupting Workspace-writing Cognitive Organs or Delivery.
- A general scheduler priority model, concurrent arbitrary `runOnce` calls,
  provider health policy, or runtime model fallback.

## Source References

- Xi `src/runtime/actions.ts` and `src/runtime/daemon.ts`
- Xi `docs/daemon-scheduling.md` and `docs/recovery-model.md`
- Loom Tickets 14, 25, 28, 34 and 35

## Comments

- 2026-08-02: Xi source and production event review found 593 real
  `chat.steered` events, while queueing was reserved for lifecycle boundaries
  such as activity recording. Loom already supports live-Turn steering and
  stale-result rejection; the missing seam is Process Driver waiting on a
  read-only Orientation call and pending Opportunity admission ordering.
- 2026-08-02: Completed. An accepted human Input now invalidates the live
  Orientation admission and removes unclaimed Opportunities in its acceptance
  transaction. The Pulse returns stale immediately while the read-only model
  call is allowed to settle in the background; direct Orientation formation
  retains its completed stale result. Runtime seam tests cover both paths.
