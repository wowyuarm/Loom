Type: implementation
Status: resolved

## Result

已由 task #43 / 1f1b6ab 执行完成并合并进 main（Review GO，YuCreate 确认）。
Blocked by: cleanup #42 is recommended first for a clean baseline

# Parameterize the Cognitive Organ lifecycle driver

Raft task: #43

## Goal

Reduce the four repeated Cognitive Organ claim, lease, run, heartbeat and settle loops to one private Runtime driver while preserving each organ's real domain differences.

## Contract

Start with the interface and migration seam in the task thread. Keep the driver private to `SqliteRuntime`; use existing `#beginCognitiveOrganAttempt` and `#runCognitiveOrgan` seams. Organ adapters retain readiness, scheduling math, FIFO/domain grounding and finish semantics.

## Non-goals

No public API, generic Store/framework, shared domain queue, or change to 50-turn Session, cancellation grace, requeue, attempts/results, status projection or persistence semantics.

## Evidence and handoff

Independent worktree; typecheck, focused Runtime tests, serial `test:runtime`, and diff-check. Review the fixed SHA; no deployment.
