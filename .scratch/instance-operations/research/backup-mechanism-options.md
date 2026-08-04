# Whole-Instance Backup Mechanisms

Date: 2026-08-03

## Question

How can a single Loom Instance gain encrypted, off-host, versioned recovery
without building a backup product into the Harness?

## Non-negotiable Constraint

The backup source is the complete Instance Root, not only `workspace/` and not
only `runtime/`. Runtime recovery facts, channel cursors/replay data, attachment
objects, configuration and Individual material must describe one compatible
point in time. Directly reading a live directory is therefore not yet an
accepted consistency method: Loom uses several SQLite databases in WAL mode and
also writes regular files. [Current state](current-state.md),
[schema.ts](../../../src/runtime/schema.ts), [layout.ts](../../../src/instance/layout.ts)

## Candidate Roles

| Candidate | Good at | Not sufficient for | Assessment |
| --- | --- | --- | --- |
| Git/GitHub | Human-readable selected Workspace history, review, comparison and collaboration. | Whole-instance consistency, private runtime data, credentials, attachments, retention or disaster recovery. | A future optional `workspace review` Integration is coherent: it exports an explicitly selected Workspace view to a separate private repository. It must never restore an Instance, decide backup success, or run by default. |
| Encrypted snapshot repository, using a mature tool such as restic | Immutable snapshots, client-side encryption, deduplication, retention, repository checking and restoring to a fresh directory. | Choosing a consistent source point, key ownership, backup destination, service scheduling and a real Loom restore acceptance check. | Strongest minimal candidate. It keeps this machinery outside Loom rather than reimplementing it in TypeScript. |
| VPS provider disk snapshot | Fast recovery from some host failures. | Independence from the provider account, granular version history, portable restore procedure and human review. | May be a secondary safety net, but provider capabilities are unknown and it should not be the first Loom contract. |
| Handwritten archive plus upload script | Very small initial command surface. | Encryption, deduplication, retention, integrity checking, retries and restore ergonomics unless those are all rebuilt. | Reject as a default direction: apparent simplicity relocates the hard part into untested scripts. |

## What Restic Covers, And What It Does Not

Restic's official documentation defines a directory backup as a snapshot;
subsequent snapshots are deduplicated, snapshots can be retained by policy and
restored to a target directory. Its scripting interface also exposes backup,
check and snapshot results as JSON lines. This is enough for storage lifecycle
and machine-readable operational evidence.

It does **not** make a live Loom Instance consistent. The first usable
procedure must obtain a known safe source point before invoking the backup
tool. The simplest candidate is a brief, controlled Host stop followed by a
backup and restart. Whether that interruption is acceptable, and whether Loom
needs a purpose-built quiesce/checkpoint command later, must be determined from
real Instance behavior. Do not introduce a filesystem snapshot layer or a
general backup scheduler before that evidence exists.

## GitHub Review Projection Boundary

The desired GitHub feature has a distinct owner and direction:

```text
selected Workspace material -> optional review projection -> private GitHub repository

complete Instance Root -> coordinated snapshot -> encrypted off-host backup repository
```

The review projection may create readable commits after stable Workspace
changes, but it has no authority over Runtime state and must not feed changes
back into a live Instance. A human may use GitHub to inspect or discuss the
Individual's material; restoring it remains a separate, explicit operation.

## Questions Still Open

1. Is a short planned Host stop acceptable for the first backup procedure, or
   must backups be non-disruptive from the beginning?
2. Which independent destination and key custody does the operator authorize?
3. How often is a full restore to an isolated directory required, and what
   minimal acceptance proves the restored Instance can open safely?
4. Does the review projection need only Workspace Markdown/JSON, or should
   daily, episode and thread material be included from the first version?

## Sources

- Loom first-party code and documentation cited above, inspected 2026-08-03.
- [restic: Backing up](https://restic.readthedocs.io/en/stable/040_backup.html)
  - snapshots, deduplication, change handling and scriptable backup output,
  inspected 2026-08-03.
- [restic: Removing backup snapshots](https://restic.readthedocs.io/en/stable/060_forget.html)
  - retention and pruning, inspected 2026-08-03.
- [restic: Restoring from backup](https://restic.readthedocs.io/en/stable/050_restore.html)
  - restoring a snapshot to a target directory, inspected 2026-08-03.
- [restic: Scripting](https://restic.readthedocs.io/en/stable/075_scripting.html)
  - JSON-lines support and its limits, inspected 2026-08-03.

`restic` is not installed in the local development environment. VPS
availability and any chosen remote backend have not been assumed or changed.
