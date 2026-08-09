# Agent-guided Instance Operations

This is the starting point for a user-authorized Operator Agent such as Claude
Code or Codex. The agent may use shell access to install, initialize, inspect,
update, back up, restore or migrate Loom after it understands the user's goal
and the target environment.

The Operator Agent is external to Loom. Loom provides small, repeatable Instance
operations; it does not provide a deployment wizard, control plane, fixed
Individual template or `loom deploy` command.

## Start With The User's Need

Before changing anything, establish:

- whether the request concerns a new Individual, an existing Instance or an
  intentional migration;
- the target host, Unix account, Instance Root and service name;
- which host changes, interruptions and private materials the user authorizes;
- which model, Channels and Integrations the Instance should use, and where
  their credentials already live;
- what observable result will count as completion.

Do not invent Identity, Stable Facts, Long-term Memory, Current Attention or a
first interaction. Ask only for information that cannot be learned safely from
the authorized environment.

## Follow The Relevant Guide

| User need | Guide |
| --- | --- |
| Install Loom, initialize an Instance, configure systemd, update code or host multiple Individuals | [Instance Lifecycle](reference/instance-lifecycle.md) |
| Configure models, credentials, schedules, Interaction Channels, routes or enabled Integrations | [Configuration And Credentials](reference/configuration-and-credentials.md) |
| View live state, understand recent Agent runs, investigate failure or recover a process | [Status And Diagnosis](reference/status-and-diagnosis.md) |
| Back up, restore or migrate a complete Instance | [Backup, Restore And Migration](reference/backup-and-restore.md) |
| Enable or verify an Interaction Channel | [Weixin](../channels/weixin.md) or [Raft](../channels/raft.md) |
| Enable or verify an Integration | [nmem](../integrations/nmem.md), [Web Access](../integrations/web.md) or [Workspace Mirror](../integrations/workspace-mirror.md) |

Read only the guides needed for the user's request. Login, configuration and
acceptance specifics belong to the corresponding Channel or Integration guide.

## Common Operating Contract

- Inspect before writing. Preserve existing Instance material and unrelated
  host state.
- Run Loom commands as the matching Instance account. One Individual normally
  has one Unix account, one Instance Root and one Host service.
- Use `~/.loom` by default. Supply `--root` only when the deployment deliberately
  uses a non-default Instance Root.
- Never start a second Host for an active Instance Root or open its private
  Runtime, Channel, Integration or Transcript stores as an operator shortcut.
- Never expose credentials, message bodies, Transcripts, attachment contents or
  private Workspace material in logs, tickets or summaries.
- Treat unavailable or insufficient evidence as `unknown`. Do not infer that a
  running service means its models, Agents, Channels or Integrations are working.
- Obtain explicit authorization before interrupting a live Host, changing host
  configuration, accessing private backup material, restoring or migrating.

## Loom Primitives

- `loom init` creates the Harness-owned scaffold but does not create Individual
  material.
- `loom run` owns one prepared Instance Root and stops gracefully on `SIGTERM`.
- `loom status` queries the running Host; `--json` is the structured form and
  `--since <ISO timestamp>` adds bounded Agent run history.
- `loom requeue <input-id>` returns one repaired, explicitly blocked Input to
  pending through the running Host.
- `loom requeue-organ <work-id>` starts a fresh budget cycle for Cognitive
  Organ work stuck in `intervention_required` or `blocked` (work id is listed
  in `loom status`); it is refused while that work has an active attempt or
  its domain input has moved on, and the successor runs through the organ's
  normal entry path.
- `loom history` reads the Interaction View of enabled Channels through the
  Host status socket; `loom status` reports each enabled Channel and
  Integration with a bounded failure category when one is failing.

Finish by reporting what changed, what evidence was actually observed, what
remains unknown, and whether the work interrupted the Individual. Do not claim
deployment, Channel or Integration enablement, backup or recovery success
beyond the checks that were performed.
