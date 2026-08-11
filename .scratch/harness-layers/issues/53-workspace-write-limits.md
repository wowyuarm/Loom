# 53 - Organ Workspace Write Limits (byte-level)

Status: in_progress
Type: feature

## Goal

Prevent Cognitive Organ maintained markdown files from unbounded growth (the
Xi threads/index.md case: a single失控 run pattern replicated 300+ times until
1.16MB, compacted to 192KB). Add byte-level hard limits on organ writes,
enforced at the write layer, without imposing structural constraints on md
content (models keep full freedom to write; only size is bounded).

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

## Implementation (Flash plan, reviewed by Docs)

- Single source of truth: `src/workspace/workspace-write-limits.ts`
  (WORKSPACE_WRITE_LIMITS path patterns → bytes + enforceWorkspaceWriteLimit
  root/relativePath/content → throw recoverable error on hit, pass otherwise).
- Enforce in BOTH `mutation.write()` AND each local atomicWrite —
  attention-maintainer replace_attention (attention-maintainer.ts:212/411)
  and thread-maintainer ThreadWorkspaceTransaction (index.ts:155) do NOT go
  through mutation.write (Docs' earlier claim corrected by Flash).
  memory-reflector atomicWrite (:684) is backup-only (backupMaterials).
- move_thread_path: move-only, naturally exempt.
- Recoverable error content: file path / limit bytes / actual bytes / excess /
  trim-and-retry hint. Rejects current write only; organ catch re-throws
  without whole-rollback (verified).
- Tests: over-limit rejects + recoverable semantics, exact boundary, unmatched
  path passes, each write path (attention/daily/episode/core/thread file)
  hit the limit, mutation continues after over-limit.
- Validation: typecheck + workspace/runtime suites + full; fixed candidate →
  Review.

## Acceptance

- Fixed candidate via Flash task workflow → Review → YuCreate approval → deploy.
- Xi index.md compaction: handed to Xi herself (YuCreate 8/11; Docs DM'd Xi).
