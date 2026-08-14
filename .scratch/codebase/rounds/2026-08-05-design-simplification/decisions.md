# Loom Design Simplification Decisions

Status: confirmed by YuCreate on 2026-08-05

## Q1 — Reflection and Runtime integrity

Decision: Reflection only waits for evidence it actually consumes. It does not prove that every terminal Turn maps to an Activity.

Reason: silent Orientation is a legal no-Activity outcome, and the extra coverage gate already caused permanent Reflection and Orientation starvation. Unexplained Turn/Segment relationships belong to a separate Runtime integrity diagnosis that can alert without stopping unrelated cognitive work.

Consequences:

- Remove the terminal-Turn-to-Activity requirement from Reflection readiness.
- Do not add a full persistent Segment history model for this purpose.
- Define integrity classification and operator/agent visibility separately.

## Q2 — Maintenance dependency scope

Decision: waiting or failed maintenance only blocks its own lane and work that consumes its unfinished material. It does not block unrelated maintenance or Orientation.

Reason: a focused reproduction showed that unrelated 8/5 Thread work could prevent an otherwise complete 8/4 Reflection from running at all. The global pending-work gate did not protect a real dependency.

Consequences:

- Keep one active Workspace-writing task at a time.
- Replace the global pending-work prerequisite with per-lane and per-material dependencies.
- Let the Scheduler continue checking independent lanes when one lane is waiting, retrying, or blocked.
- Preserve conservative stopping inside the core Input, Effect, Delivery, Activity freeze, and recovery chain where ordering or an unknown external result is real.

## Q3 — Input retry exit

Decision: an Input that explicitly fails without Effect or tool coverage must have a visible exit. It must not be retried forever by the Process Driver.

Reason: the same failing Input was reproduced across four failed Turns, returning immediately to pending each time. It had no attempt count, retry deadline, or terminal state and would continue occupying the only execution lane.

Consequences:

- Do not assume a new attempt counter, backoff table, or retry state machine is needed.
- First use the smaller rule: an explicit failed Turn moves its uncovered Input to the existing `blocked` state; an interrupted or outcome-unknown Turn may return it to pending for recovery.
- Require an explicit operator or recovery action before blocked work can run again.
- Add automatic retries only if a concrete failure class remains outside Agent Execution's existing retry/fallback and cannot be handled by shared dependency admission.

## Q4 — Failure ownership

Decision: classify failure by what must change to recover. A shared dependency failure belongs to the Runtime/Host and must not consume or block one Input; a failure after the Input is actually admitted belongs to that execution outcome.

Reason: model, authentication, or network unavailability would fail every queued Input. Treating each as an Input failure would turn a shared outage into many falsely blocked messages.

Consequences:

- Do not start a Turn while a known shared dependency is unavailable; leave Inputs pending and expose the shared blocker.
- Do not use the current error-message keyword classifier as lifecycle authority. The layer that detects the failure must report its ownership explicitly.
- Prefer the minimal explicit-failure-to-`blocked` rule over a new general retry framework.

## Q5 — Activity boundary and late Delivery

Decision: Activity freezes the facts that have happened within its time boundary. It does not remain open until every Effect reaches a final future outcome.

Reason: Xi already treats a failed outbound attempt as an established fact and allows Segment closure; it does not keep the Segment alive waiting for delivery. Loom's stronger Effect retry lifecycle does not make Segment the owner of that wait.

Consequences:

- A confirmed `not_sent` attempt is sufficient evidence to close the current Activity when its normal boundary is due.
- The Effect continues retrying independently under its existing identity and delivery safety rules.
- A later Delivery attempt or success is a later Runtime fact and must enter later life evidence rather than rewriting the frozen Activity.
- Remove pending-but-not-dispatching Delivery as a Segment close blocker. Keep active dispatch and unknown outcome protections.

## Q6 — Human Input and cognitive organ execution

Decision: a newly accepted human Input requests cancellation of a running cognitive organ so the Main Agent can run after the organ releases its isolated work. Loom keeps one execution lane rather than adopting Xi's concurrent utility-agent execution.

Reason: Xi launches Thread, Now, and Memory maintenance without awaiting them, so inbound chat can run concurrently; this avoids visible blocking but permits concurrent Workspace access. Loom's serial `runOnce` protects consistency but turned a 13-minute Life Recorder run into interaction delay. Life Recorder is the main overlap risk; Thread and Attention can also overlap daytime interaction, while Memory Reflection is mostly an overnight edge case.

Consequences:

- Add one cancellation capability shared by cognitive organs; do not add parallel Workspace writers or a second scheduler.
- Admit human Input durably before requesting cancellation.
- Do not steer human content into a utility session or reuse the aborted session.
- Roll back incomplete Workspace mutation, or observe an already complete commit, before the Main Agent reads its Workspace snapshot.
- Use a short release grace. If the organ does not release, expose the blocker rather than starting Main Agent concurrently.
- Reuse the same capability for Memory Reflection without designing a special nighttime execution model.
- Do not add a fairness scheduler, cancellation counter, checkpoint, or new quiet timer. Existing pending Input, Interaction Wave, Active Segment, after-chat delay, and FIFO organ queues already define when conversation is still active and when maintenance can resume.
- Expose the age of the oldest pending organ work from existing timestamps so sustained conversation delays are visible.

## Technical closures

These choices do not need further product decisions:

1. Remove the exact `UPDATED` / `NO_CHANGE` terminal-text gate from Thread, Attention, and Memory maintenance. Derive `updated` or `no_change` from durable tool mutations already observed by the system. Keep grounding, path checks, structural validation, and rollback.
2. Do not introduce a generic lane framework. Keep the current serial Scheduler and narrow only the predicates and early returns that incorrectly turn one lane's wait/failure into a global stop.
3. Compute Runtime integrity warnings from existing Turn, Activity, and transition facts. Do not persist a new Segment history model.
4. For explicit Main Agent failure, use the existing Input `blocked` state; for interruption or unknown outcome, keep existing recovery to pending. Add only the minimal explicit requeue operation needed to recover blocked work.
5. Keep Effect/Delivery identity, backoff, and unknown-result reconciliation. Change only their ownership of Segment closure and later life evidence.
6. Leave the Scheduler's two-stage maintenance calls alone in this round. They have no demonstrated harmful result.

## Removed proposals

- Full persistent Segment lifecycle/history table.
- Generic Input retry state machine with attempt budgets and several backoff classes.
- Parallel Workspace-writing organs or a versioned Workspace snapshot system.
- Rebuilding Xi's backlog queue batching beside Interaction Waves.
- Treating all pending work as a single global idle prerequisite.
- Treating exact model tail text as a transaction commit signal.
