Type: implementation
Status: resolved

## Result

已由 task #45 / 75bd0c0 执行完成并合并进 main（Review GO，YuCreate 确认）。
Blocked by: cleanup #42 is recommended first for a clean baseline

# Unify recursive image-pixel stripping

Raft task: #45

## Goal

Make the Main Agent's tool-activity and tool-trace paths remove image pixels recursively with one behavior, so nested image blocks cannot remain in expanded tool evidence.

## Contract

Preserve text, metadata and non-image JSON values. Add a nested-image regression through the assembled visible-result paths before changing the implementation.

## Non-goals

Do not split the tool-trace module or change compaction/expansion contracts beyond removing pixels that are already intended to be removed.

## Evidence and handoff

Independent worktree; run focused Main Agent/tool-trace tests, typecheck, serial fast tests as needed, and diff-check. Review the fixed SHA; no deployment.
