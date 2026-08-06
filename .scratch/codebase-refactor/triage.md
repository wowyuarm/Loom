# Codebase Refactor Candidate Triage

Status: completed
Date: 2026-08-06

## Result

The original review correctly found repeated code, but several candidates confused
textual duplication with a shared responsibility. The accepted work is split by
module seam; there will be no repository-wide generic utility sweep.

| Candidate | Result | Reason |
| --- | --- | --- |
| 1. `withoutImagePixels` | Downgrade; no bug ticket | Pi's `ToolResultMessage.content` interface is `(TextContent \| ImageContent)[]`. `tool-trace` maps the redactor over each top-level block, so image pixels are removed. The two implementations are duplicated, but the claimed nested-image leak is outside the dependency contract. Consolidate only when this Main Agent area is next changed. |
| 2. Shared generic utils | Reject as proposed | The same names hide different interfaces and failure policies. A repository-wide `guards/io/errors` module would be shallow and create wide churn. Extract only domain modules with multiple real callers. |
| 3. Final outcome parsing | Already completed | `6dd5a1e` removed the unused `UPDATED` / `NO_CHANGE` parsing contract while retaining stop-reason validation. |
| 4. Raft state compatibility | Remove obsolete compatibility | `refs` is still live Delivery state and must remain. The only deployed Raft database already has `delivery_order`, `known_destinations`, and the completed backfill, so startup schema probing and backfill can be removed without retaining a migration path. |
| 5. nmem retry delay | Reject | Both callers pass `attempts + 1`, so the effective domain starts at 1. The formulas are identical across that domain after the one-hour cap; the claimed `attempt=0` divergence is unreachable. |
| 6. Atomic writes | Reject as proposed | Workspace Mutation needs crash-durable file and directory fsync. Cognitive Organ file replacement needs atomic visibility inside an already journaled Workspace mutation. Forcing all callers through the heaviest implementation would erase a real semantic distinction. Revisit only with an explicit durability interface. |
| 7. nmem connection setup | Accept | Thread export, Episode export, and Working Memory repeat the same client construction, connection identity hash, and error classification. One nmem-internal module can hide this policy behind a small interface and provide locality without crossing domain seams. |
| 8. Episode YAML writing | Accept | The project already depends on `yaml` and the reader uses `yaml.parse`. Use `yaml.stringify` for frontmatter so quoting and escaping have one library-owned contract. |
| 9. Scattered guards | Do not batch | Some are unreachable fallbacks, some are TypeScript narrowing, and some protect real external-input or recovery invariants. Review only with the owning module's next change. Keep the Raft profile casing fallback: production acceptance proved the identity behavior is real. |
| 10. Missing Instance Configuration | Accept | YuCreate confirmed the contract: a missing `instance.yaml` is an error. `loom init` owns creation, so Host startup must not silently appear healthy with every Integration disabled. |

## Proposed Tickets

### A. Require Instance Configuration

- Change `loadInstanceConfiguration` to reject `ENOENT` with a clear configuration error.
- Update callers and tests so `loom init` remains the only normal creation path.
- Acceptance: Host/open and model revision paths fail closed; initialized Instances still open normally.

### B. Deepen nmem connection setup and Episode YAML

- Add one nmem-internal connection module returning the optional client and stable connection hash, with shared error classification.
- Migrate Thread, Episode, and Working Memory callers; keep their reconciliation policies separate.
- Write Episode frontmatter with `yaml.stringify` and preserve the current parsed contract.
- Acceptance: existing projection/retry tests remain green, plus quoted labels/titles round-trip through Episode parsing.

### C. Remove obsolete Raft startup compatibility

- Remove the startup `wakes.delivery_order` probe and repeated `known_destinations` backfill.
- Keep `refs` as the opaque reference/Delivery lookup store.
- Keep the current schema creation path for fresh state; do not add a version or migration abstraction for a database shape that is no longer deployed.
- Acceptance: fresh state opens normally and the verified LoomHaL database already matches the required schema before deployment.

## Deferred

- Main Agent image-redaction consolidation is local cleanup, not a current defect.
- A shared atomic-write interface needs a separate durability design before code moves.
- Generic guard/error/time helpers remain local until a domain module proves a common interface.
