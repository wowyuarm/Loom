# Instance Operations Research

## Purpose

Define the operational contract for one Loom Runtime Instance: whole-instance
backup and recovery, operator-readable status, and the minimum sustainable
maintenance practice. This is separate from the Raft Channel work. It does not
make a control plane, a multi-Instance Host, or an Operator Agent part of the
Harness.

## Current Phase

The first operator-readable primitive is complete. Backup recovery promises and
recurring maintenance checks remain discussion work; no implementation ticket
is active.

## Confirmed Direction

- The first whole-instance backup takes its consistent source point during a
  planned, short Host stop. Do not build online snapshot coordination, a
  general backup scheduler or an operations control plane before real use
  proves that interruption unacceptable.
- GitHub Workspace review is a distinct, optional future Integration; it is
  neither enabled by default nor a recovery mechanism.
- The Operator-facing surface must be composed of independently usable Loom
  primitives with explicit evidence boundaries. `loom status` now provides the
  live, content-free Instance snapshot and bounded Agent run history without
  turning diagnostic logs into a fact source.

## Questions To Resolve

1. What is the recovery promise: process restart, host loss, accidental
   deletion, or a defined combination?
2. What must a whole-instance backup include, where may it live, and how is a
   restore proved without exposing private material?
3. Which states must an operator see immediately, and which evidence belongs
   in a history rather than a live status view?
4. Which recurring checks are Loom behavior, and which remain an authorized
   operator procedure?
5. What is the smallest coherent command and data boundary that supports those
   answers for a single Instance?

## Completed Work

- [01 - Add live Instance status](issues/01-add-live-instance-status.md)

## Evidence

- [Current-state research](research/current-state.md)
- [Backup mechanism options](research/backup-mechanism-options.md)
- [OpenClaw and Hermes operations research](research/openclaw-hermes-operations.md)
- [Agent-guided Instance Operations](../../../docs/operations/agent-guided-instance-operations.md)
- [Raft operational status boundary](../../../docs/channels/raft.md)

## Non-goals

- No generic deployment controller, dashboard, plugin system, job framework,
  or multi-Instance control plane.
- No automatic copying of an Individual's private material to an unspecified
  remote service.
- No claim that a running systemd service proves Integration health or that
  internal write-ahead recovery replaces whole-instance backup.
