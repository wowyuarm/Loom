# 41 - Recover Cognitive Workspace Mutations

Status: resolved
Type: Workspace + Cognitive Organs

## Problem

Life Recorder, Thread Maintainer, and Memory Reflector can each change several Agent Workspace files in one run. They restore their prior state when a tool, model, validation, or ordinary process error reaches their `catch` path, but their rollback state exists only in memory. If the process exits after one file has changed and before the run finishes, Runtime can retry the Cognitive Organ while the Agent Workspace already exposes a partial revision.

That failure crosses Loom's continuity boundary: Runtime Store still says the work is pending, while the Individual may wake with only part of a Daily/Episode, Thread structure, or core-material revision.

## Confirmed Interface

- A small Workspace Mutation Module owns durable before-images and completed run results outside the Agent Workspace.
- Before the first live mutation, enough prior state is durable to restore the complete run after process exit.
- Opening a Runtime Instance restores every incomplete Workspace mutation before validating or exposing Individual materials.
- Once a Cognitive Organ has completely validated its result, the Module records that result durably. If Runtime has not yet recorded the result when the process exits, retry returns the same completed result without another model call.
- Life Recorder uses the Frozen Activity segment id as its stable operation identity; Thread Maintainer uses the source Activity id; Memory Reflector uses the logical reflection day.
- Existing Cognitive Organ Interfaces, prompts, tools, Runtime scheduling, receipts, and failure retry policies do not change.

## Scope

- Life Recorder Daily/Episode writes.
- Thread Maintainer writes and moves under `threads/`.
- Memory Reflector replacements of Stable Facts, Identity, Memory, and Behavior.
- Instance-open recovery before Agent Workspace materials are loaded.

Attention Maintainer is excluded because one atomic rename leaves either the complete old file or the complete new file, never a partial multi-file revision. Main Agent Workspace actions remain Individual-owned ordinary activity and are not converted into a Harness transaction.

## Test Seam

- Workspace Mutation Module tests observe begin, mutation, process-reopen recovery, completed-result replay, and Workspace contents only through its public Interface.
- Existing Cognitive Organ tests continue to cross each organ's public Interface and verify normal rollback and stable results.
- Instance tests prove incomplete mutation recovery happens before required Workspace material validation.

Tests do not inspect journal files, internal tables, or implementation-private state.

## Non-goals

- A general database transaction framework or filesystem overlay.
- Atomicity between arbitrary Main Agent writes and Runtime Store.
- Workspace backup, Git history, migration, `loom init`, supervisor, or remote disaster recovery.
- Cognitive Organ prompt or model-visible Context changes.

## Resolution

- `Workspace Mutation` now stores durable before-images under the Runtime Root before a Cognitive Organ can expose its first live write. File revisions cover Life Recorder and Memory Reflector; one bounded tree snapshot covers Thread Maintainer's intentionally flexible merge, archive, split, and move surface.
- Instance opening restores every pending mutation before loading or validating Individual materials. Recovery rejects mismatched or malformed journal identities and paths rather than applying uncertain state.
- A fully validated organ run durably replaces its pending record with a compact completed result. If the process exits before Runtime records its Receipt or maintenance result, the same operation replays that result and does not call the model again. Completed records remain as small idempotency evidence; this ticket does not add a second Runtime acknowledgement protocol merely to collect them.
- Existing in-process rollback is now the same durable recovery path. Attention Maintainer remains outside the Module because its single-file atomic replacement already has the required crash behavior; Main Agent writes remain ordinary Individual-owned Workspace activity.

Validated with `npm run typecheck`, a clean build, and the full 260-test suite. Coverage includes pending file recovery, completed-result replay, complete Thread tree restoration, normal organ rollback/retry, and recovery before Instance material validation.

## Source References

- Loom Tickets 08, 17, 18, 24, 25, 27, and 37
- Loom ADR 0001
- Xi source Ticket 09 - Runtime Store, Storage, and Recovery Boundaries
