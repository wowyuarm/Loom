Type: implementation
Status: resolved

## Result

已由 task #42 / 6f396d2 执行完成并合并进 main（Review GO，YuCreate 确认）。
Blocked by: none

# Cleanup confirmed dead surfaces and simplify current code

Raft task: #42

## Goal

Remove the confirmed unreferenced validation script, dead methods and orphan type surfaces; simplify duplicate mappings/branches; move runtime-used `typebox` to `dependencies`; apply the conventions corrections that do not change behavior.

## Scope

- Delete `scripts/validate-instance.mjs` and `CognitiveOrganExecution.nextDue()` with its dedicated test.
- Remove or un-export only the verified orphan types, empty interfaces and dead alias.
- Collapse `currentWork`, Memory Reflector missing-material handling, the single-call error helper and repeated nmem enablement calculation.
- Remove the `workspaceMirror.intervalMinutes` field from TypeScript parsing, mirror validation, formal docs and configuration tests. Keep fail-fast validation for `enabled`, `remote` and `branch`; the operator-owned systemd timer remains authoritative.
- Apply the conventions-audit items for redundant checks, impossible-state handling, comments and duplicate test assertions.

## Non-goals

Do not change behavior, introduce a generic utility or Store, touch the R1/A2/M4/teardown tickets, or modify any `.scratch` content outside this issue file and the round summary/decision records.

## Evidence and handoff

Use an independent worktree from current main. Run typecheck, then serial `test:fast`, `test:runtime`, `test:host`, and diff-check. Do not run the shared-dist builds concurrently. Fixed SHA goes to Review and Docs; no deployment is authorized.
