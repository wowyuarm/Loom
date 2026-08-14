# 01 - Add live Instance status

Status: resolved
Type: implementation

## Need

An authorized Operator Agent cannot currently answer whether a live Loom Host,
its model runtime, Cognitive Organs, Runtime work, and enabled Integrations are
actually operating. Startup JSONL is diagnostic output and cannot answer a
later query. Existing Runtime facts also lose older Orientation, Attention, and
Memory Reflector runs, so the question "what ran since deployment" cannot be
answered reliably.

## Confirmed Interface

- `loom status` gives a concise human view. `loom status --json` gives a stable
  machine-readable view. Both use `~/.loom` unless an optional `--root` is
  supplied.
- `loom status --since <ISO timestamp>` adds bounded Agent run history from that
  time. Current/latest status remains the default.
- A Host-owned read-only Unix socket serves status independently of Local,
  Weixin, Raft, or any other Integration. It queries only the live Host. There
  is no Runtime database fallback, stale-state inference, control command,
  network port, or added authentication surface.
- When no Host is reachable, the command reports `unavailable` without reading
  private Instance state.
- The Host view includes version, process run id, startup time, model state,
  Runtime counts, each Agent's latest run, and enabled Integration state.
- Agent summaries live in `runtime/runtime.db`. A compact run ledger records
  Agent name, timing, result, and a stable failure category. It contains no
  prompt, message, tool trace, Workspace content, raw provider response, path,
  credential, or remote object id. It has no separate retention policy.
- Existing facts remain authoritative for Runtime recovery. The run ledger is
  operational evidence, not a second lifecycle state machine. Historical
  coverage begins when this version first records runs; older facts are shown
  only where Loom can prove them without inference.
- Enabled Integrations provide their own live status when assembled. Host
  presents a small common view without a second registry or changed ownership.

## Output Contract

- JSON contains `schemaVersion`, `observedAt`, and, for a live Host, `runId`,
  version, startup time, Model Runtime Revision, Runtime counts, Agent entries,
  and Integration entries.
- Agent state distinguishes `running`, `retrying`, `never_run`, `succeeded`,
  and `failed`. `nextRunAt` appears only while waiting or retrying.
- There is no synthetic overall `healthy` value. Integration and Agent failures
  expose stable categories rather than raw errors.
- Human output is a projection of the same report and does not expose fields
  forbidden from JSON.

## Test Seams

- Runtime public status Interface: real Agent runs create content-free latest
  summaries and bounded history across reopen.
- Host public Interface and status socket: a running Host returns its process
  identity, Runtime/model state, and only enabled Integration states.
- Foreground CLI: human and JSON forms work against a real child Host; invalid
  `--since` is rejected and an absent Host reports unavailable.

## Completion

- Public types and schema are versioned and migrations preserve existing
  Runtime databases.
- Focused tests, `npm run typecheck`, `npm test`, and real built CLI probes pass.
- Thin user and operations documentation matches the implemented commands.

## Result

- Added `loom status`, `loom status --json`, and bounded `--since` history over
  a Host-owned `0600` Unix socket that exists independently of Interaction
  Channels. An absent Host returns structured `unavailable` without opening
  Instance state.
- Added a compact `runtime.db` Agent run ledger for Main Agent, Orientation,
  Life Recorder, Attention Maintainer, Memory Reflector, and Thread Maintainer.
  It records only timing, result, stable outcome and failure category; current
  and historical queries contain no activity content or raw errors.
- Host output now combines model revision state, Runtime work counts, Agent
  latest/history, and only enabled Integration states. Human output omits run
  ids; JSON uses schema version 1.
- Runtime schema migration backfills only provable older Main Agent, Life
  Recorder, and completed Thread Maintainer runs. Interrupted executions are
  recovered as interrupted rather than left falsely running.
- `npm run typecheck`, all 308 tests, built CLI unavailable probes, and a real
  child-Host Local Turn with both human and JSON status output passed.
