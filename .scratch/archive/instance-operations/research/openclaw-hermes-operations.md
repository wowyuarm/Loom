# OpenClaw And Hermes: Operations Research

Date: 2026-08-03

## Scope

This compares the two projects only on backup, restart recovery and
operator-facing state. Their products are broader than Loom; this is not a
proposal to adopt either Gateway or its architecture.

## OpenClaw

### What It Does

OpenClaw owns a broad, single-user Gateway control plane. Its first-class
backup command creates a local archive of state, configuration, credentials,
channel/provider data, sessions and optionally Workspaces. It also has a
separate SQLite snapshot command that uses SQLite's online backup API, verifies
the copied database, compacts the private copy, and never treats live database
files or their WAL sidecars as portable artifacts. Archive verification checks
the manifest and canonical database shapes. [backup.md](https://github.com/openclaw/openclaw/blob/main/docs/cli/backup.md)

The same document explicitly leaves scheduling, upload, retention, incremental
WAL bundles, failover and restore-on-boot outside this command. Therefore its
backup command is a good example of a narrow *local consistency artifact*, not
proof that an agent Harness should build its own backup repository or remote
operations system.

For live operations, OpenClaw separates fast, read-only `status` from live
`health` probes and larger diagnostics exports. All have machine-readable
forms; health reads the running Gateway rather than opening independent channel
connections. Its diagnostics bundle deliberately preserves bounded status,
health and stability evidence while excluding text, prompts, tool outputs and
secrets. [status.md](https://github.com/openclaw/openclaw/blob/main/docs/cli/status.md),
[health.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/health.md),
[diagnostics.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/diagnostics.md)

It also records restart-recovery facts in SQLite: interrupted session work,
subagents, scheduled work and delivery queues each have their own recovery
rules and retry limits. [restart-recovery.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/restart-recovery.md)

### What Loom Can Learn

- A whole-instance backup needs a deliberate handling rule for live SQLite
  databases; copying `*.db`, `-wal` and `-shm` files opportunistically is not
  a recovery contract.
- A fast status, an explicit live probe, and an exportable support artifact
  answer different operator questions. One JSONL stream cannot replace them.
- Privacy must be a property of every operator surface, not a later redaction
  pass.

### What Loom Should Not Copy

- Gateway control plane, dashboard, plugin ecosystem, multi-agent/session
  fleet, cron platform and metrics stack.
- A bespoke backup repository or a long list of operational switches before
  Loom has its first restore acceptance case.

## Hermes Agent

### What It Does

Hermes is also a wide Gateway product: its public source contains channel
platforms, cron, background work, delivery, restart and status subsystems. It
stores session state in SQLite and exposes session export/import, but its import
intentionally resets gateway routing, handoff and other live process state.
This is an important distinction: exported conversation history is not a safe
way to revive a live Gateway owner. [hermes_state_portability.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_portability.py)

Its delivery ledger writes a durable record before sending, distinguishes a
send that was in progress at a crash, limits recovery attempts, and marks a
possibly duplicated redelivery visibly instead of hiding that ambiguity.
[delivery_ledger.py](https://github.com/NousResearch/hermes-agent/blob/main/gateway/delivery_ledger.py)

Hermes also keeps a small lifecycle sentinel plus a last-heartbeat memory
sample to make a prior unclean exit observable on the next startup. Its
readiness collector returns only bounded status and counts, omitting paths,
commands, queue payloads, credentials and exception messages.
[lifecycle_ledger.py](https://github.com/NousResearch/hermes-agent/blob/main/gateway/lifecycle_ledger.py),
[readiness.py](https://github.com/NousResearch/hermes-agent/blob/main/gateway/readiness.py)

No dedicated complete-home backup command was found in the public README,
top-level layout or the operational modules inspected. That is not proof that
one does not exist elsewhere; it is simply not evidence on which to base a
Loom decision.

### What Loom Can Learn

- Keep historical export separate from live runtime ownership and channel
  routing. This supports the proposed GitHub review projection boundary.
- A small persisted previous-life marker can answer "did the process die
  cleanly?" without retaining private messages. It should only be considered
  after a concrete operator need is established.
- Delivery ambiguity needs an explicit policy. Loom's existing `unknown` /
  reconciliation state is stricter than Hermes' visible at-least-once replay;
  do not weaken it merely for symmetry.

### What Loom Should Not Copy

- The extensive built-in cron, automation, background-task and platform
  machinery.
- Process-wide state files becoming an alternative source of truth beside
  Loom's Runtime Store.

## Synthesis For Loom

The external evidence supports a small three-way split, without deciding its
implementation yet:

```text
Runtime Store and Workspace Mutation journal: recover one existing Instance
Encrypted off-host snapshot: restore a complete Instance after host loss
Optional GitHub review projection: let a human inspect selected Workspace history
```

The first two external projects reinforce, rather than weaken, the current
Loom direction: complete backup needs an explicit consistent-source boundary;
operator status needs a queryable snapshot and limited diagnostics; neither
requires Loom to become a general Gateway or backup service.

## Sources

- OpenClaw first-party documentation linked above, retrieved from its `main`
  branch with GitHub CLI on 2026-08-03.
- Hermes Agent first-party source linked above, retrieved from its `main`
  branch with GitHub CLI on 2026-08-03.
- Loom first-party [current state](current-state.md) and
  [backup mechanism options](backup-mechanism-options.md).
