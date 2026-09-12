# 53 - Unified Cognitive Organ Session and Workspace Write Limits

Status: resolved
Type: feature

## Goal

Give all Pi Cognitive Organs one bounded session policy, and give the four
Workspace-writing organs one explicit completion protocol. Ordinary tool
rejections stay inside the same Pi session for correction; only a successful
`finish` durably commits the run. Prevent organ-maintained files from unbounded
growth with byte-level hard limits at the write layer, without imposing a
Markdown schema.

## Session Decisions (YuCreate 8/11, task #37)

- Orientation, Life Recorder, Attention Maintainer, Memory Reflector, Thread
  Maintainer and Tool Trace Compactor share one Loom-owned session Module while
  continuing to use Pi's native model/tool loop.
- Each session allows 50 Pi-native turns. Turn 50 completes normally; an
  unfinished organ fails before turn 51. Normal execution no longer has the
  historical 10-minute attempt or 45-minute logical-work deadline.
- Runtime keeps one logical work across at most three failed attempts. Human
  preemption, Host stop, explicit cancel and cancel-grace handling remain
  release controls rather than normal execution budgets.
- The four writing organs use the one `finish` tool created by
  `src/agents/session/finish.ts`. Each organ supplies only its own
  `validateAndCommit()` rules.
- A failed completion check is returned to the model as a correctable tool
  error. A durable commit failure or an uncertain write outcome stops the
  session and rolls back the whole run.
- If one Pi message contains `finish` and ordinary tools, `finish` is the
  authoritative commit request and every sibling tool is a terminating no-op.
  The committed result and finished latch appear only after durable commit
  succeeds, and no later provider call is allowed.
- Workspace writes return `applied`, `rejected` or `uncertain`. Callers update
  receipts and changed-file state only after `applied`; `rejected` is
  correctable in-session; `uncertain` is fatal for the run.

## Decisions (YuCreate 8/11, thread #Loom-Main:6a5ed1c2 / task #35)

- **Byte limits only, no structure constraints** on md files. Prompts guide
  agents to reference by need; no schema/tables.
- **Limits live in src constants**, not instance.yaml — harness-internal
  protection, uniform per file responsibility across instances.
- **Per-file limits by responsibility** (harness-owned table).
- **Recoverable tool error**: rejects only the current write; turn continues;
  model retries with trimmed content. No whole-mutation rollback.
- **No soft warning threshold** (YuCreate: hard limit + recoverable error is
  enough; extra threshold is unneeded mechanism).
- **Unmatched paths are not limited** (default pass) — only explicitly listed
  paths with limits are enforced; incremental list, avoids breaking future
  file types.
- Note: future memory layering may change memory.md limit.

## Limits Table (Docs 8/11, calibrated from real outputs)

| Path | Limit | Basis |
| --- | --- | --- |
| attention.md | 64 KiB | current 7KB (HaL) / 1.1KB (Xi) |
| identity.md | 64 KiB | current 2.8KB / 7.6KB |
| memory.md | 256 KiB | current 36KB / 24KB |
| daily/<day>.md | 128 KiB | max day 74KB (HaL 8/4) |
| episodes/<day>/<id>.md | 32 KiB | single 2-4KB |
| threads/index.md | 256 KiB | Xi 192KB after 8/9 compaction; 1.16MB runaway |
| facts.json | 64 KiB | structured, 803B actual |
| behavior/interactivity.md | 64 KiB | behavior rules, compact |
| behavior/proactivity.md | 64 KiB | same |
| threads/<line>/thread.md | 256 KiB | line body, allows accumulation; notes archived separately |
| threads/<line>/notes/*.md | not limited | small per-note, no need |

## Implementation

- Single source of truth: `src/workspace/workspace-write-limits.ts`
  (WORKSPACE_WRITE_LIMITS path patterns → bytes + enforceWorkspaceWriteLimit
  root/relativePath/content → throw recoverable error on hit, pass otherwise).
- Enforce in `mutation.write()` and at the staging boundary for local
  transactions. Attention Maintainer commits its staged replacement through
  `Workspace Mutation`; Thread Maintainer enforces the limit in
  `ThreadWorkspaceTransaction`. Memory Reflector's separate `atomicWrite` is
  backup-only.
- move_thread_path: move-only, naturally exempt.
- Recoverable error content: file path, attempted bytes, limit bytes, minimum
  reduction and retry guidance. It rejects the current write only.
- `src/agents/session/index.ts` owns the Pi turn boundary, reminders, fatal
  stop and tool gate; `finish.ts` owns the common tool and commit/result latch.
- Thread Maintainer captures `threads/` and `runtime/thread-evidence.json` in
  the same pending Workspace Mutation before recording the current Activity
  reference. Evidence moves are persisted before the completed journal, so
  either every change on both surfaces commits or all of them are restored.
- Runtime's legacy deadline columns are rebuilt once into the final
  attempt-only ledger; an old database fixture must reopen and continue the
  same logical work.
- Tests cover exact byte boundaries, UTF-8, unmatched paths, every write
  mechanism, rejected-write correction, uncertain-write fatal stop, rejected
  finish correction, durable commit latch, mixed finish batches and the exact
  turn 50/51 boundary.

## Acceptance

- task #37 fixes one exact candidate from the clean pre-ticket base, then
  independent Review verifies the complete session/runtime/write contract.
- No deployment is included in this ticket.
- Xi index.md compaction: handed to Xi herself (YuCreate 8/11; Docs DM'd Xi).
