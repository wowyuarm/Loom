Type: implementation
Status: resolved

## Result

已由 task #46 / d9e8b15 执行完成并合并进 main（Review GO，YuCreate 确认）。
Blocked by: cleanup #42 is recommended first for a clean baseline

# Make Raft and Weixin teardown await completion

Raft task: #46

## Goal

Ensure Raft CLI child shutdown and Weixin remote shutdown have bounded, awaited completion without masking the original failure or allowing late callbacks to republish state.

## Contract

For Raft, wait after SIGTERM with an explicit upper bound and preserve timeout, signal and exit-code facts separately. For Weixin, await `remote.stop()` in stop and ingress finally paths while preserving original poll/abort error precedence.

## Non-goals

Do not add a generic Process Manager, automatic retry, restart policy or new configuration.

## Evidence and handoff

Add minimal failure, timeout and late-callback tests. Run typecheck, focused Raft/Weixin tests, serial host tests, and diff-check. Review the fixed SHA; no deployment.
