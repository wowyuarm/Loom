# 07 - Complete The Raft Bridge Local Endpoints

Status: resolved
Type: implementation
Blocked by: none
GitHub: issue #3

## Goal

Complete the local endpoint contract implied by the pinned `raft agent bridge` invocation without
letting Raft absorb Loom's private Runtime activity.

Raft CLI 0.0.17 automatically derives `/activity/drain` from every configured wake endpoint.
Loom previously exposed only `/wake`, so the bridge called a guaranteed 404 on every polling loop.
Loom now returns the valid empty `raft-activity-drain.v1` response because it has no Raft channel
plugin activity to forward. This keeps the wake path and optional activity telemetry distinct.

## Behavior

- Both local endpoints require the same process-local bridge token.
- `POST /wake` keeps the existing content-free wake validation and retry behavior.
- `GET /activity/drain` returns an empty valid drain result; it does not read or acknowledge Raft
  messages and does not export Loom Workspace, Transcript, Life Recorder or private activity.
- Unknown paths and methods remain rejected.

## Public Test Seam

The pinned CLI Adapter test starts the bridge through the public `RaftRemote` interface. Its fake
bridge calls the derived endpoint and requires the exact valid empty drain contract before sending
a wake.

## Acceptance

- Focused tests and the repository's complete checks pass.
- Deployment removes new `agent_comms.activity_drain` failures while Raft messaging remains healthy.

## Current Evidence

- Commit `4ae81e1` passed the pinned bridge test and the repository's complete 325-test suite, then
  deployed to HaL as `0.0.0+g4ae81e19aa36`.
- After restart, repeated `agent_comms.activity_drain` bridge events reported `outcome=no_events`,
  `drainedCount=0` and no error. Raft remained connected and normal wake/message work continued.
- GitHub issue #3 is closed.
