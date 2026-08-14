# Loom Instance Operations: Current State

Date: 2026-08-03

## Scope

This records what Loom currently guarantees and exposes. It is evidence for a
later decision, not a proposed design.

## Findings

| Concern | What exists now | Gap relevant to operations |
| --- | --- | --- |
| Process interruption | Runtime facts are stored in `runtime/runtime.db`; its schema uses WAL and `synchronous = FULL`. Pending turns, Effects, Deliveries and maintenance lanes can be reconstructed after the Host restarts. [runtime.ts](../../../../src/runtime/runtime.ts), [schema.ts](../../../../src/runtime/schema.ts) | This protects an existing Instance Root. It does not create an independent copy for host loss, deletion, disk failure, or operator error. |
| Cognitive writes | Life Recorder, Thread Maintainer and Memory Reflector use a Runtime-owned before-image journal. Instance open recovers a pending mutation before resuming. [loom-instance.ts](../../../../src/instance/loom-instance.ts), [workspace-mutation.ts](../../../../src/workspace/workspace-mutation.ts) | This is a narrow interrupted-write guarantee, not a restorable history of the Workspace. |
| Whole-instance contents | The root holds Individual Workspace, runtime databases and Integration state, transcripts, configuration and credentials, attachment contents, and organ write-before backups. [README.md](../../../README.md), [layout.ts](../../../../src/instance/layout.ts) | There is no whole-instance backup command, retention policy, remote target, consistency protocol, restore command, or restore drill. |
| Host supervision | `loom run` is a foreground Host. The provided systemd unit restarts it after failure and retains graceful shutdown without a timeout. [agent-guided-instance-operations.md](../../../../docs/operations/agent-guided-instance-operations.md), [loom@.service](../../../../docs/operations/loom@.service) | systemd can restart one process; it cannot prove the health of the model, channels, data integrity, backup freshness, or external delivery state. |
| Live status | Runtime, Instance, Host and channel objects each expose in-process status: queue/turn/effect/delivery state, cognitive maintenance, model state, driver state and channel state. [types.ts](../../../../src/runtime/types.ts), [loom-instance.ts](../../../../src/instance/loom-instance.ts), [loom-host.ts](../../../../src/host/loom-host.ts) | The CLI has `init`, `run`, `chat`, `history` only. An operator cannot request this status from the running Host. [cli.ts](../../../../src/cli.ts) |
| Event history | `loom run` writes safe JSONL startup, driver, runtime transition, tool and model events to stdout. [operational-events.ts](../../../../src/operational-events.ts), [cli.ts](../../../../src/cli.ts) | Events do not directly state a Cognitive Organ start/completion, and later Integration state changes are not pushed as events. |
| Raft | Raft keeps bridge replay data and channel state under the Instance Root; the Host owns `connecting`, `connected`, `degraded` and `stopped` status. [raft.md](../../../../docs/channels/raft.md) | The documentation explicitly says no `loom status` client exists. A running Host must not be read as Raft being connected. |

## Assessment Of Operational Events

`operational-events.ts` was the right narrow answer to the Local first-use
problem: `loom run` can emit content-free JSONL to the service journal without
making Runtime behavior depend on logging. Runtime transitions are emitted only
after their transaction commits. [operational-events.ts](../../../../src/operational-events.ts),
[runtime.ts](../../../../src/runtime/runtime.ts)

It is not yet an operational interface:

- it has no documented version, stable per-entity vocabulary, sequence cursor
  or snapshot relationship;
- most lifecycle facts are collapsed into generic strings, so an operator
  cannot reliably ask which Cognitive Organ ran, failed, is pending, or will
  retry next;
- a Process Driver retains its full last error only in memory, while the
  journal event intentionally emits only the error type;
- `loom run` emits Integration state at startup, but does not subscribe to
  later channel state changes;
- stdout and systemd's journal are transport/storage choices, not a queryable
  status or durable audit contract.

The likely direction is therefore to preserve these safe diagnostic events,
but derive a separate, explicitly versioned operator status and history
surface from Host and durable Runtime facts. Whether either needs remote access
is still a product decision.

## Recovery Layers Already Distinguished By Code

1. **Runtime recovery**: restart the same Instance Root and resume durable
   lifecycle facts.
2. **Cognitive write recovery**: roll back or replay one interrupted protected
   Workspace mutation.
3. **External-delivery recovery**: retry only an explicitly `not_sent`
   Delivery; preserve `unknown` for reconciliation to avoid duplicate remote
   actions.

None of these is an off-host, operator-initiated Instance restore.

## Production Evidence Boundary

The local HaL Instance contains timestamps and transcripts showing that its
major Cognitive Organs have run. That evidence cannot establish the present
state of VPS HaL. The VPS currently cannot be inspected over SSH, and current
Loom provides no remote-safe status client. Any future operational contract
must make the evidence source and its scope visible.

## Questions That Need A User Decision

- Is the first promised recovery target only the latest valid Instance, or is
  versioned return to a previous point also required?
- Is an encrypted off-host copy required from the first release, and who owns
  its destination and encryption keys?
- Does `status` have to work only on the Instance host, or must an authorized
  operator retrieve it remotely without shell access?
- Should ordinary transcript and attachment retention be part of backup, or
  should each be explicitly classified as disposable history?

## Sources

All claims above are from Loom's first-party code and documentation at the
listed paths. The investigation intentionally did not read private Instance
material, credential files, transcript bodies, or production databases.
