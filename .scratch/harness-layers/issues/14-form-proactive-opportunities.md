# 14 - Form Proactive Opportunities

Status: completed
Type: Cognitive Organ and proactive lifecycle

## Problem

Loom can accept an `opportunity` Input and select Background Behavior for its Main Agent Turn, but nothing forms that Input from the Individual's actual life. A naive prompt containing only the time and elapsed time since human contact would leave both Orientation and the Main Agent without enough grounded continuity.

When a prior Active Segment freezes, Main Agent Activity Lifecycle installs the latest four Frozen Activities into the successor Context as one fixed Recent Activity Bridge. A later Opportunity starts from that successor state, so its new Active Segment already carries the recent evidence. Copying the latest Activity into the current Opportunity message would present the same past twice in two different roles. Orientation instead needs a reliable way to inspect recent raw Activity before it forms a narrow narrative for the Main Agent.

## Confirmed Architecture

### Evidence placement

- Main Agent keeps the existing Recent Activity Bridge: up to four latest Frozen Activities, fixed for the new Active Segment, with authorized expansion for included tool evidence. The bridge is previous lived evidence; the Opportunity is the current Input that may begin new activity.
- Opportunity Input does not copy raw Frozen Activity. It adds one current possible point of attention to the already grounded Main Agent Context.
- Orientation receives a bounded index of the latest four Frozen Activities and a dedicated read-only `read_recent_activity` tool. The tool pages immutable events for one indexed Activity; it cannot inspect arbitrary Runtime Store state or Transcript ranges.
- Orientation may also use Workspace-confined `read`, `ls` and `grep`. Missing optional material such as Daily, Episodes or private work does not block the run.
- Stable Facts are appended in full to the Orientation system prompt. They ground identity, attribution, natural forms of address and language, but do not prove that a current event occurred.

### Orientation role

- Orientation explores the current scene and returns one possible point of attention. It is not a gate, planner, task dispatcher or substitute for the Main Agent's judgment.
- It may draw from relationship evidence, current attention, long-term memory, recent Activity, skills, private Workspace work and configured Integration evidence.
- Discovering private Workspace material does not grant Orientation write or maintenance ownership.
- The result contains `narrative`, `whyNow` and concise `evidence`. The Main Agent receives only `narrative`; `whyNow`, evidence and the complete organ transcript remain audit material.
- The source `self|human|world|mixed` classification is omitted because it does not drive behavior and can force an unnecessary taxonomy onto a natural point of attention.

### Active Segment outcomes

- The Opportunity message states that it is neither a human message nor a task. The Main Agent may ignore it, act privately, inspect or change Workspace material, or use `message` when something is genuinely worth sending.
- Current local time and recent human-contact timing may accompany the Opportunity, but they do not replace recent Activity evidence already present in Context.
- Runtime opens a provisional Active Segment when it claims the Opportunity for a Main Agent Turn. Orientation itself remains an internal organ run outside lived Activity.
- If the Turn completes with no ordinary tool action and no Effect, Runtime consumes the Opportunity as a silent judgment, restores the pre-Turn Main Agent state and removes the provisional Segment. The Pi branch remains audit evidence but creates no Frozen Activity, Recent Activity or Life Recorder work.
- If the Turn performs ordinary tool activity without a message Effect, the Segment is real lived Activity. After the Turn, Runtime immediately attempts to freeze this standalone activity; if a human Input races in first, closure yields and the interaction continues in the same Segment.
- If the Turn creates a message Effect, the Segment remains active across Delivery and a possible human response. It closes later through the normal idle/split lifecycle rather than being treated as standalone private work.
- An interaction Input that arrives during the Main Agent Turn joins the same Active Segment and makes it lived Activity even if the original Opportunity would otherwise have stayed silent. Background Behavior remains the Turn-frozen material, so the steered Input must explicitly tell the Main Agent that a real human message has arrived.
- If execution fails after an ordinary tool action or Effect, that activity must be preserved and must not be blindly replayed. Loom currently preserves failed Turn stop facts but not verified tool activity from the failed branch; this ticket must close that gap for the proactive path.

### Admission and failure

- An Orientation result may become an Opportunity only while Runtime is still idle. Human Input accepted while Orientation is running wins; the stale Opportunity is not steered into or queued behind that interaction.
- Orientation failure, invalid structured output or insufficient evidence exploration creates no Opportunity. A later scheduler may retry the pulse; Loom does not invent a generic fallback narrative.
- This ticket adds only the admission and lifecycle primitives required by this path. Durable cadence, quiet hours, logical day and generic job scheduling remain deferred.

### Existing system relationships to preserve

- An open Active Segment prevents another Orientation pulse. The next pulse is not allowed to create parallel background life.
- Frozen Activity schedules Life Recorder independently; Recorder pending or failure does not block later Input or remove recent bridge evidence.
- Workspace changes under `threads/` may later trigger Thread Maintainer; Orientation and the proactive coordinator do not call it directly.
- Current Attention and Memory maintenance remain separately triggered Cognitive Organs. A background Turn may create their future evidence, but does not synchronously invoke them.
- Tool Trace Compactor remains an inline Main Agent Context gate and never becomes Orientation work.
- A future after-chat continuation is caused by a real outbound message, not by every proactive Turn. Its lifecycle must grow from the same message Effect/Delivery evidence rather than Orientation output.
- Logical-day close and future cadence policy must respect an open Active Segment, but are not implemented by this ticket.

## Prompt Design Method

- System prompt: role, evidence discipline, exploration method, distinction between traction and task assignment, quality bar, output contract and carefully chosen generic examples.
- Stable Facts: appended to the system prompt for grounding and language choice.
- First user message: run time, recent human-contact timing, Frozen Activity index, Workspace index and available action-space index. It does not preload Workspace prose or raw Activity events.
- Tool descriptions: exact read scope, pagination and evidence meaning. They do not repeat the Orientation working method.
- Mechanical tests verify the final Context, tool surface, evidence confinement, output validation, idle admission and silent-branch handling. They do not claim to test narrative quality, language following or judgment.

The final system prompt, first user message and Main Agent Opportunity wrapper must be reviewed with the user before implementation.

The existing Main Agent `message` description is also refined in this ticket so its model-visible meaning matches the proactive lifecycle: assistant output is private, `send` accepts one durable outbound Effect without claiming Delivery, repeated calls may form separate natural messages, `after_send=continue` keeps the Turn open for further work, and `no_reply` naturally closes an interaction but is not required merely to let a proactive Opportunity pass.

Orientation may also return a validated `none` result after actual evidence exploration. This creates no Input and avoids manufacturing a generic direction merely to make a pulse productive.

## Planned Interface Seams

- Runtime recent Activity query and idle-only Opportunity admission.
- Orientation: given run metadata and bounded Activity evidence, return one validated Opportunity result through a fresh isolated Pi session.
- Main Agent execution: render Opportunity distinctly from interaction Input and report whether a proactive Turn performed an actual action.
- Runtime lifecycle: open a provisional Segment, discard a silent Opportunity branch, immediately freeze standalone private activity, keep messaged activity open, and preserve verified pre-failure activity without blind replay.

## Out Of Scope

- Persistent scheduler, configurable cadence, quiet hours and logical day.
- nmem, web or channel Integration implementation.
- Thread Maintainer, Now Maintainer and Memory Reflector.
- Real-provider behavioral evaluation until the mechanical path is complete.

## Implemented

- Runtime takes one idle snapshot containing local time, latest accepted human Input timing and the latest four Frozen Activities, then atomically rejects a stale Orientation result if any Runtime transition occurred before admission.
- Orientation runs in a fresh isolated Pi session with complete Stable Facts, an index-only first message, Workspace-confined `read` / `ls` / `grep`, and `read_recent_activity` limited to the indexed immutable Activities. It returns validated `opportunity` or `none`; failed exploration and invalid output create no Input.
- Main Agent renders Opportunity as a distinct non-human, non-task Input and explicitly identifies a real human Input steered into the same proactive Turn. Recent Activity remains in the fixed successor bridge and is not duplicated in the Opportunity payload.
- A silent Opportunity consumes its Input but restores the pre-Turn Main Agent state and removes the provisional Segment. Ordinary tool activity freezes immediately, message Effect keeps the Segment open, and human Input arriving during Turn or Activity close continues in the same Segment.
- Successful ordinary tools are persisted at Pi `tool_execution_end` through `TurnControl`. A failed Turn can therefore preserve complete verified call/result pairs plus its stop fact without committing unverified thinking or output, and the covered Opportunity is not replayed.
- The common Cognitive Organ Workspace read surface now includes `grep` under the same lexical and symlink confinement as `read` and `ls`.

## Validation

- `npm run typecheck`
- `npm run build`
- `npm test`: 89 tests passed
- `git diff --check`
