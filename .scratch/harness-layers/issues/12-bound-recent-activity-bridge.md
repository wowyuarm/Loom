# 12 - Bound the Recent Activity Bridge

Status: resolved
Type: Main Agent Context correction

## Problem

Ticket 11 connected Frozen Activity to the successor Context, but used the Life Recorder queue as the bridge index. That makes recorded Activity disappear from later windows even when it is still recent, while a Recorder outage can make every pending Activity accumulate in the model Context.

The current projection also renders complete JSON for tool calls and results, gives each Activity an independently droppable Context message, and provides no authorization for the existing `expand_tool_result` tool to recover a compacted bridge interaction. These choices do not preserve the fixed, bounded recent-activity behavior already validated by the source implementation.

## Confirmed Semantics

- Recent Activity and cognitive recording are separate lifecycles. Recorder status controls FIFO recording only; it does not select Context history.
- A successor Context selects the latest four Frozen Activities, including the Activity being frozen, then presents them oldest to newest.
- The selected bridge and its expansion authorization are fixed for the lifetime of the successor Active Segment. Later Recorder Receipts do not mutate it.
- Frozen Activity remains complete in Runtime Store. Recent Activity Bridge is a deterministic compact projection, not a summary and not a new Input.
- One bridge Context message contains the selected Activity ranges. Thinking never enters it.
- Human Input text remains complete. Individual output uses a 200 Unicode-character preview.
- Ordinary tool calls and their results appear only as complete pairs. Call arguments and results each use a 200-character preview, and all such pairs share a 1,000-token bridge allowance.
- Each included ordinary tool pair exposes a stable Primary Agent Transcript reference. The existing `expand_tool_result` tool accepts references authorized by the fixed bridge as well as active-trace compaction references.
- Outbound `message` Effects preserve their complete payload and Delivery evidence. They do not consume the ordinary-tool allowance, but the complete bridge still counts against the normal Context Planner limits.
- System stop evidence remains visible with a bounded 200-character preview. Other Effects use bounded previews because their payloads are not known to be human-visible messages.

The numeric limits are Harness defaults modeled on observed source behavior. They remain implementation constants until Instance Configuration has a real use for them.

## Interface And Test Seam

The public seam remains the Main Agent Activity Lifecycle Interface. Given recent Frozen Activities and the closing Activity, `freeze()` returns the immutable Activity and a complete opaque successor Context state. Runtime supplies recent Activity independently from the Recorder queue and does not parse the successor state.

Tests through this seam verify:

- newest-four selection and oldest-to-newest presentation;
- recorded status cannot remove a still-recent Activity from a later successor;
- ordinary tool call/result pairs are never split and obey the local allowance;
- previews, thinking exclusion, message Effect fidelity and Delivery evidence;
- bridge references authorize the existing expansion tool;
- one successor seed stays unchanged throughout its Active Segment.

Runtime tests verify only that the lifecycle request receives the latest prior Activities regardless of recording status. Faux-provider tests continue to verify mechanical Context and tool behavior, not narrative quality.

## Out Of Scope

- Changing Life Recorder FIFO, retry or Receipt behavior.
- An LLM-generated bridge summary.
- Logical-day rotation, configurable Context budgets or a generic history browser.
- Migration or compatibility with a deployed Runtime Instance.

## Source Evidence

- Xi `src/harness/context-bridge.ts`
- Xi `src/state/closed-activity-windows.ts`
- Xi `.scratch/context-planner/issues/10-fixed-window-seed-and-bridge.md`
- Xi `.scratch/context-planner/spec.md`

## Result

Runtime now supplies the latest prior Frozen Activities without filtering on Recorder status. Main Agent combines them with the closing Activity, selects the newest four and fixes one oldest-to-newest `<recent_activity>` message into the successor Context.

The bridge keeps complete human Input and outbound `message` Effect evidence, bounds individual output and system/ordinary Effect previews to 200 Unicode characters, excludes thinking, and admits ordinary tool interactions only as complete call/result pairs within a shared 1,000-token allowance. Included pairs carry stable transcript references; the successor Context persists their authorization and the existing `expand_tool_result` reads the complete original interaction.

Context Window replacement and Turn completion preserve both the fixed bridge and its authorization. Life Recorder FIFO, retries and Receipts are unchanged.

## Verification

- `npm run typecheck`
- `npm test` (73 passed before final review)
- `git diff --check`
