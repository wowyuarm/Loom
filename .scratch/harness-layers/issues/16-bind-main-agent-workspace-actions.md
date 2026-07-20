# 16 - Bind Main Agent Workspace Actions

Status: completed
Type: Main Agent and Agent Workspace

## Problem

Loom has closed the Main Agent Turn, Context, tool-evidence and proactive Activity lifecycles, but the real Pi Main Agent still has no ordinary Workspace tools. `PiAgentExecutionOptions.readOnlyTools` is currently only a caller-supplied test seam. Because every Turn also installs Harness tools such as `expand_tool_result` and sometimes `message`, Pi built-in tools are disabled and are never replaced with a real Main Agent action surface.

This makes the current lifecycle claim incomplete: an Opportunity may tell the Main Agent that it can inspect or change Workspace material and continue private work, while the real session cannot do so. Fake `AgentExecution` tests can prove how Runtime handles an ordinary tool result, but not that the Pi Main Agent can perform the action.

## Confirmed Direction

- Agent Workspace is the Main Agent's high-permission working area. Loom must give the Main Agent Pi's real coding action surface there rather than reducing the Individual to a read/write file editor.
- Reuse Pi `0.80.10` built-in `read`, `bash`, `edit` and `write`, and enable its `grep`, `find` and `ls`. Loom owns Main Agent wiring, not another implementation of these tool semantics.
- Set the Pi session `cwd` to the Agent Workspace so relative work naturally begins there. This is the Main Agent's default working scope, not a host-level security sandbox or a claim that absolute paths and shell commands cannot leave it.
- Runtime Store, credentials, channel state and Harness source remain outside the Agent Workspace by ownership and Instance Root layout. Their protection belongs to deployment permissions and any future sandbox policy, not to a reduced Main Agent tool set in this ticket.
- Keep Cognitive Organ tools separately constrained to their explicit responsibilities; the Main Agent's broad authority does not widen an organ's tool surface.
- Successful tools continue through the existing Pi `tool_execution_end -> TurnControl.recordToolActivity` path. This ticket must not create a second Activity or recovery path.

## Interface Direction

- Replace the misleading `readOnlyTools` option with an accurately named seam for additional Main Agent tools.
- `createPiAgentExecution` selects Pi built-ins `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` with `agentWorkspace.root` as `cwd`; callers should not need to remember the baseline action surface.
- Harness terminal tools and caller-supplied additional tools remain custom tools. Ordinary Activity tracking includes the selected Pi built-ins and additional tools, while excluding Harness terminal decisions such as `message`.
- Workspace tool construction remains reusable by read-only Cognitive Organs, but organ tool sets and Main Agent tool sets are explicit rather than inferred from one broad list.
- Loom-maintained tool names and duplicate caller-supplied names fail before a provider call.

## Acceptance

- A real Pi faux-provider Turn sees `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` together with the applicable Harness tools.
- The Main Agent can inspect, search, execute commands, edit and create material from a real temporary Agent Workspace using Pi's behavior.
- Pi receives the Agent Workspace as the session `cwd`; ordinary relative tool actions operate there without Loom replacing Pi's path or command semantics.
- A successful `edit` or `write` is persisted as ordinary tool Activity before the provider continues; a later Turn or Runtime recovery does not replay the covered Input.
- A successful `bash` command is handled by the same ordinary Activity path rather than a shell-specific lifecycle.
- Existing Orientation and Life Recorder read-only tool surfaces remain read-only and Workspace-confined.
- Existing Main Agent, proactive lifecycle, Context, Transcript and Cognitive Organ tests continue to pass.

## Out Of Scope

- A host-level sandbox, command allowlist, approval policy or claims of security isolation.
- Integration-provided tools, approval policy or per-tool user confirmation.
- Workspace init, templates or migration.
- Current Attention, Thread, Memory or other Cognitive Organ maintenance.
- Instance Configuration and final Runtime assembly.

## Source Evidence

- Loom `src/main-agent/pi-execution.ts`: caller-supplied `readOnlyTools`, Pi built-ins disabled whenever Harness tools exist, and existing ordinary-tool Activity recording.
- Loom `src/workspace/tools.ts`: current read-only Pi tool reuse and lexical/symlink confinement.
- Loom Ticket 14: the Main Agent may inspect or change Workspace material and proactive ordinary tools already have a closed Activity lifecycle.
- Pi `0.80.10`: the default coding surface is `read` / `bash` / `edit` / `write`, with `grep` / `find` / `ls` available as additional built-ins.
- Xi source implementation: the Main Agent retains Pi's default coding tools and explicitly adds `grep` / `find` / `ls`; its custom `message` / `recall` / evidence tools do not narrow that surface.

## Implementation

- `createPiAgentExecution` now owns a fixed Main Agent baseline of Pi `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, with the Agent Workspace root as the Pi session `cwd`.
- Caller tools are now named `additionalTools`. They may extend the Main Agent surface, but cannot replace Loom-maintained tools or reuse the same name.
- Pi built-ins and additional tools use the existing `tool_execution_end` Activity extension. Harness terminal tools remain excluded from ordinary lived Activity.
- Context planning measures the same active tool definitions that Pi supplies to the provider, including the complete baseline action surface.
- No host sandbox, path wrapper, command policy or new action lifecycle was added. Existing Cognitive Organ tools remain separately Workspace-confined.

## Validation

- Real Pi faux-provider Turns observed the complete baseline tool surface.
- Real temporary Workspace checks exercised `read`, `bash`, `grep`, `write` and `edit`, including relative `cwd` behavior, persisted file changes and ordinary Activity recording.
- Tool collision checks fail before a provider call.
- `npm run typecheck`
- `npm run build`
- `npm test` (95 passed)
- `git diff --check`
