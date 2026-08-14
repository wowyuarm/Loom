# Sentinel Runtime Evidence

Status: first pass received; prescriptions not yet accepted

## 1. Reflection treats legal silence as missing evidence

Production evidence:

- 2026-08-04: 47 `completed/completed`, 31 `completed/no_reply`, 2 failed Turns.
- One `completed/no_reply` segment is intentionally absent from `activities` and has `silent_opportunity` discard evidence.
- `memory_reflection` remained at `next_day=2026-08-04`, `last_completed_day=2026-08-03`; no 2026-08-05 Memory Reflector run.
- `#reflectionDayComplete` hard-gates all terminal Turn segment ids against `activities`.

Value intended: do not silently omit real activity whose recording failed.

Observed cost: one legal silent Opportunity blocks an entire day and all later days.

Open decision: whether a genuinely unexplained orphan should block Reflection or be reported by a separate integrity check. Sentinel initially favors blocking only Turns with a save obligation; Xi comparison and Codex's first pass favor separating integrity diagnosis from Reflection. Resolve by grilling; do not implement either assumption yet.

## 2. One maintenance lane blocks unrelated later lanes

Production evidence:

- 2026-08-05 15:25:12-18:34:03 CST had no active segment, running Turn, pending/active Input, or Delivery.
- Thread Maintenance failed 15:27-15:32 and succeeded 15:40-15:43; Attention completed 17:49-17:51. Neither explains the full idle window.
- Orientation ran zero times that day. Pulse `last_pulse_at` remained at 2026-08-04 02:49:24 CST.
- Scheduler returns immediately when Reflection yields `busy`, before `runOpportunityPulse()`.

Value intended: serialize model work and preserve stable maintenance ordering.

Observed cost: a persistent local block in Reflection prevents an independent due Pulse from even being considered.

Current direction: preserve serial model execution, but distinguish dependency blocking from local lane inability so independent due work can still be selected.

## 3. Active Segment is a hard gate for all maintenance

Production evidence:

- Two long active segments on 2026-08-05: 11:57:52-14:09:03 and 14:16:27-15:25:12 CST.
- No Orientation ran during them.
- Scheduler only reaches Pulse and maintenance after there is no active segment; `closeActivity()` folds active Turn, pending Input, Delivery, Activity recording, Thread maintenance and close ownership into `busy`.

Value intended: do not freeze or mutate a lived activity while it is still changing; keep Main Agent and Cognitive Organ model work serial.

Observed cost: long conversation/activity can delay all maintenance, and the reason is not visible.

Sentinel's follow-up narrowed this candidate:

- During both long production segments, no already-due maintenance was observed attempting to write Workspace concurrently.
- Life Recorder and Thread Maintainer began only after each segment froze.
- Current evidence therefore supports a real protection: later Turns in one lived segment do not observe mid-segment Daily/Thread mutations.

Remaining questions:

- Which maintenance had already-closed evidence ready during these windows?
- Which of those can safely mutate Workspace while the current segment remains active and later Turns may read that Workspace?
- Is the missing behavior fairness, preemption, a maximum run budget, or only better observability?

Do not accept “run maintenance during any active segment” without answering these. Current candidate is blocker observability and long-running work budgets, not removing the active-segment gate.

## 4. `busy` collapses materially different states

`busy` currently covers model execution, maintenance not idle, incomplete reflection day, pending Input/Delivery/recording/thread work, close ownership, and other guarded transitions. Most results carry neither a reason nor `nextRunAt`.

Production consequence: the absence of Orientation could not be distinguished as active-segment waiting, short maintenance, or permanent reflection blockage without raw SQLite/transitions inspection.

Direction: results need enough reason and timing for callers to choose wait, run other work, retry, or alert. This is a behavioral contract change, not a naming cleanup.

## 5. Thread Maintainer exact terminal token

Production evidence:

- 15:27:49-15:32:02 run failed with `Thread Maintainer must return UPDATED after structural writes`.
- Retry 15:40:11-15:43:33 succeeded.
- The failure added about eleven minutes and another model run, but did not cause the afternoon-wide outage.

Value intended: distinguish a successful structural revision from a no-change run and reject incomplete model behavior.

Observed cost: one natural-language terminal token can turn otherwise valid structural writes into a failed run.

Open questions:

- Confirmed: durable Workspace Tree Mutation rolled back the first run before retry. Production has one final completed manifest and one evidence reference per affected Activity; no duplicate Workspace revision remained.
- Confirmed: Thread Maintainer already knows whether mutation occurred and which paths changed; grounding/read coverage checks are separate.
- Confirmed by source inspection: Xi Thread Maintainer has no equivalent `UPDATED` / `NO_CHANGE` terminal token contract.
- The Thread Evidence Index is written before Workspace Mutation starts and is not rolled back with the tree. This may be intentional because it indexes immutable source evidence rather than a committed Thread revision; verify consumer semantics before calling it an atomicity defect.

Priority: lower than the scheduler/reflection chain until these are verified.

## Integrity status follow-up

Runtime `status()` exposes raw Inputs, Turns, Activities, maintenance and pending Activity ids; `operationalStatus()` exposes recent agent runs. Neither classifies a terminal Turn whose segment has no Activity, distinguishes legal silent discard, nor explains why reflection readiness failed. The only classifier is private `#reflectionDayComplete(): boolean`, and its false result becomes generic `busy`.

This supports a missing operational classification, not a pre-decided policy that a true orphan must block Reflection.
