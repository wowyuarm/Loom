Type: implementation
Status: resolved

## Result

已由 task #44 / 8abdf04 执行完成并合并进 main（Review GO，YuCreate 确认）。
Blocked by: cleanup #42 is recommended first for a clean baseline

# Use the durable WorkspaceMutation write path for Thread Maintainer

Raft task: #44

## Goal

Replace Thread Maintainer's direct writeFile-plus-rename path with the existing WorkspaceMutation durable handle, preserving its tree transaction and recovery boundary.

## Contract

Audit every Thread Maintainer write, move and rollback path. Keep before-images, mutation journal, structural actions and rollback behavior unchanged; use the existing fsync-capable seam rather than adding another atomic-write utility.

## Non-goals

Do not change Thread content semantics, ordinary Main Agent writes, or introduce a generic file transaction.

## Evidence and handoff

Independent worktree; add or adjust tests for success, failure recovery and restart state. Run typecheck, focused Thread/Workspace tests, serial Runtime tests as needed, and diff-check. Review the fixed SHA; no deployment.
