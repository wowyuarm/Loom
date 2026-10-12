# .scratch Work Rules

This subtree holds cross-session work items: design snapshots, research, implementation tickets, prototypes, and acceptance evidence. It is not an implementation or API authority — current behavior is defined by source and tests once they exist. This file only governs how to work here.

While the codebase does not yet exist, `.scratch/active/` is the primary authority for in-progress design. As source lands, code and tests take precedence over these notes.

## Work-item structure

Each `active/<work>/` is one directory with a short `README.md` as its single continuation entry, covering five items: status, last-checked date, current frontier (who is doing what and what is blocked), completion conditions, and the formal-doc exit.

```
active/<work>/
├── README.md      # continuation entry (the five items above)
├── DESIGN.md      # converged design snapshot — the shape we build to
├── issues/        # tracer-bullet implementation tickets, one file per ticket
│   ├── 01-<slug>.md
│   └── 02-<slug>.md
├── materials/     # research and external material (keep only what is worth re-reading)
└── validation/    # human-confirmed acceptance evidence
```

## Ticket discipline

Each `issues/NN-<slug>.md` uses a fixed skeleton, numbered from `01` in dependency order (blockers first):

```markdown
# NN — title

**What to build:** the end-to-end behavior this ticket demonstrably delivers once done (user perspective, not a layered task list)
**Blocked by:** the tickets blocking it, or "None — can start immediately"
**Status:** ready | in-progress | complete

- [ ] acceptance criterion 1
- [ ] acceptance criterion 2
```

- **Vertical slices**: each ticket cuts one narrow, complete path through every layer, independently verifiable when done; no horizontal division of labor by layer.
- **Self-contained tickets**: each ticket can start in a new context without reading the whole work-item history. Avoid concrete file paths and code snippets (they go stale); exception: decision-dense fragments (state machines, type shapes) may be inlined with their source noted.
- **Frontier workflow**: tickets whose blockers are all done form the frontier and are ready to start; a serial chain runs top to bottom.

## Lifecycle

- **Closing a work item**: close or delete unfinished tickets -> move durable conclusions into the maintained docs (once `docs/` exists) -> delete process material without provenance value -> move into `archive/YYYY-MM/`.
- **Archive is history**: archived states and terminology only represent the working context of their time and never override current implementation; do not rewrite archives to match new code.
- **Transient artifacts**: logs, debug output, and downloads go in `local/` (gitignored), never into active or archive.

## Git tracking

Only finished work records are committed; in-progress ones are not.

- **`active/` stays untracked** while a work item is still in progress. It holds live notes that change many times a day, and its conclusions are not yet desensitized; committing it freezes half-formed state and leaks material into history that was never cleaned.
- **A work record is desensitized, archived, and only then committed** — normally amended into the commit holding the substantive work it belongs to (`git commit --amend`), so the record lands with the change it explains rather than as a standalone "docs" commit. See [docs/AGENTS.md](../docs/AGENTS.md) for the one-line commit rule.
- A file in `active/` is not durable: its work item is still moving, and once it closes the files move to `archive/`. So links pointing into `active/` are not safe to depend on — point at `archive/` or at maintained docs instead. `.scratch/README.md` may name active items, as prose rather than as links.

## Directory index

See [README.md](README.md).
