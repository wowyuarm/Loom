# 11 - Close Activity without Blocking Continuity

Status: resolved
Type: cross-layer lifecycle

## Problem

Loom can persist Input, Turn, Effect and Delivery facts, rebuild a Main Agent Context Window from committed transcript evidence, and record a caller-supplied Frozen Activity into Daily and Episodes. These pieces are not connected: Runtime has no Active Segment or durable closing work, Main Agent has no operation that freezes and replaces a Context Window, and a failed Recorder call exists only as an error returned to its caller.

Life Recorder also receives Pi's built-in `read` and `ls`. Setting their `cwd` to the Agent Workspace does not prevent absolute paths, `..`, `~` or symlink traversal from reading outside it.

This ticket closes the existing Runtime, Main Agent, Workspace and Life Recorder slices. It does not begin a generic Cognitive Organ framework or a new Integration/Configuration phase.

## Existing Boundaries

- Runtime Store is authoritative for lifecycle, claims, leases, retry and recovery. It keeps Main Agent `executionState` opaque.
- Main Agent owns the Context Window schema, transcript branch verification, frozen seed, committed trace and any valid replacement of that state.
- Primary Agent Transcript is append-only execution evidence, not lifecycle authority.
- Life Recorder consumes one immutable Frozen Activity and returns a Receipt only after complete evidence reads and successful Workspace writes.
- A failed Recorder run rolls back Daily and Episodes, returns no Receipt, and must leave the same Frozen Activity available for retry.
- Agent Workspace is the Cognitive Organ filesystem boundary. It is not a closed schema and may contain Individual-owned private material unknown to Loom.

## Confirmed Activity Semantics

### Freeze and continue

When an Active Segment is eligible to close or split, Runtime first claims the close. Main Agent then derives a Frozen Activity and a successor Context projection from the last committed state and verified transcript evidence. Runtime atomically persists the immutable Activity, its pending recording state and the replacement execution state.

After that transaction, new Input may enter a successor Active Segment even while Life Recorder is pending or retrying. The Individual's interaction must not remain blocked on cognitive maintenance.

### Bridge before Receipt

Recent Activity Bridge is a deterministic projection of verified Frozen Activity evidence, not Life Recorder prose. It can therefore become part of the successor window-frozen seed when the Activity is durably frozen; it does not need to wait for Daily/Episode writes.

Life Recorder Receipt completes the Activity's cognitive-recording work. It does not create the evidence, authorize the raw bridge, or determine whether later Input can run.

### Ordered recording

Frozen Activities remain pending in chronological order. Life Recorder processes them FIFO so an older retry cannot rewrite a Daily after a later Activity has already been incorporated. Failure keeps the same Activity pending and records the failed attempt; later work may continue to accumulate, but later Activities do not overtake it in the Recorder queue.

## Cognitive Organ Relationship

- Cognitive Organ runs are internal maintenance with their own audit evidence; they do not create Active Segments and are not fed back into Life Recorder as lived Activity.
- Orientation creates an Opportunity. It becomes Activity only after Runtime accepts that Opportunity as Input and Main Agent actually acts on it.
- Now Maintainer, Thread Maintainer and Memory Reflector change Workspace materials that future Turns read. Their runs do not enter Recent Activity Bridge.
- Tool Trace Compactor remains an inline Context gate. It must settle before the Context Window can be frozen, but its own utility transcript is not Activity.
- Runtime may later reuse scheduling, lease and retry primitives across organs. This ticket does not introduce a shared organ job schema because their triggers, blocking behavior and completion evidence differ.

## Workspace Read Tools

- Introduce one reusable Workspace-confined implementation of Pi-compatible `read` and `ls` behavior.
- Reject lexical escapes and canonical paths outside the Agent Workspace, including absolute paths, `..`, `~` and symlinks that resolve outside it.
- Preserve Pi's normal read/list behavior and truncation rather than replacing it with a reduced ad hoc protocol.
- Life Recorder receives these custom tools with Pi built-ins disabled.
- Reuse of the implementation does not grant every Cognitive Organ the same tool set. `grep` is added when the first implemented organ needs it; `bash`, web and Integration tools are separate capabilities.
- Cognitive Organ writes remain role-specific protected tools rather than generic `write` or `edit`.

## Ownership Sketch

```text
Runtime Store
  owns Active Segment, close claim, pending Activity, attempt and Receipt state
        |
        v
Main Agent
  validates committed Context/Transcript and returns an opaque state replacement
        |
        +--> Frozen Activity --> Life Recorder --> Daily / Episodes
        |
        +--> deterministic Recent Activity Bridge --> successor Context Window
```

Runtime must not parse Context Window fields to perform this flow. The Main Agent lifecycle Interface and its test adapter cross the same seam.

## Confirmed Bridge Representation

- Durable Frozen Activity, rather than Life Recorder Receipt, allows new Input to enter a successor Active Segment.
- The successor keeps freshly loaded window-frozen material and adds one `<recent_activity>` evidence block for each still-pending prior Activity plus the newly frozen Activity. A bridge never replaces Daily or other window-frozen material.
- The block explicitly identifies past evidence rather than a new request, uses `human` / `individual` / `system` attribution, excludes thinking, and distinguishes generated output from confirmed Delivery.
- An Activity remains in future raw bridges until its Receipt is durable. Once recorded, later successor windows rely on the refreshed Daily/recent narrative instead of accumulating that raw bridge indefinitely.
- Cognitive Organ runs stay outside Active Segment Activity. Their audit evidence remains separate, while their Workspace changes affect later Main Agent Context through normal material loading.

## Test Seams

- Runtime Interface: accepted Input can continue after a durable freeze; a failed Recorder attempt remains pending across restart and retries without duplicate Activity or Receipt.
- Main Agent lifecycle Interface: only committed verified evidence can produce a Frozen Activity and valid successor Context replacement; Runtime treats both Context states as opaque.
- Activity ordering: later pending Activities cannot overtake an earlier failed Activity in the Recorder queue.
- Workspace read tools: relative in-Workspace reads retain Pi behavior; absolute, parent and symlink escapes are rejected.
- End-to-end local seam: interaction Activity freezes, successor Input runs with its deterministic bridge, Recorder writes Workspace records, and restart recovery reaches the same final state.

Tests do not evaluate model narrative quality or introduce a real model provider in this ticket.

## Out of Scope

- Other Cognitive Organ implementations or a generic organ runner.
- nmem, channel or web Integrations.
- logical day, configurable cadence, quiet hours or model policy.
- workspace initialization, migration and production Xi adaptation.
- real-provider behavioral evaluation.

## Result

Runtime now owns the durable Active Segment, close claim, immutable Frozen Activity, FIFO recording state, attempts, leases, failures and Receipt. A successful freeze atomically installs the opaque successor Main Agent state and releases the old Segment, so later Input can proceed while Life Recorder remains pending. Failed or interrupted recording returns the Activity to pending; expired close and recording leases recover after restart.

Main Agent closure verifies the committed Context anchor and transcript branch, then combines committed transcript evidence with Runtime Input, Effect and Delivery facts. Failed or interrupted Turns enter Frozen Activity as explicit system facts without treating their uncommitted transcript branches as evidence. The successor keeps freshly loaded window-frozen material, all older pending bridges and the current bridge; bridge text follows the confirmed model-visible representation above.

Life Recorder now disables Pi built-ins and receives shared Pi-compatible `read` / `ls` tools confined to the Agent Workspace, alongside its existing role-specific evidence and write tools. Lexical and symlink escapes are rejected while Pi pagination and truncation behavior remain intact.

The Xi source review confirmed why these jobs should not be collapsed into one generic organ runner: Tool Trace Compactor is an inline Context gate, Life Recorder consumes closed lived Activity, Orientation creates an Opportunity for the Main Agent, and the other maintainers react to Workspace or Integration evidence on their own cadence. Loom preserves those distinct relationships while allowing shared Pi/tool infrastructure where a real common seam exists.

Tests cover durable continuation, verified bridge contents, pending bridge retention, FIFO failure/retry, close and recording lease recovery, failed/interrupted Turn facts, Workspace confinement, and one local Main Agent -> Runtime -> Life Recorder flow. Faux providers verify mechanical Context and tool contracts only; they do not claim narrative or language quality.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` (70 passed)
- `git diff --check`
