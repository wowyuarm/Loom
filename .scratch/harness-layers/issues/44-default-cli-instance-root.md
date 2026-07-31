# 44 - Default CLI to the User Instance Root

Status: resolved
Type: implementation

## Problem

The first local deployment is intended to live at `~/.loom`, but every CLI
command required an explicit `--root`. That made the normal entrypoint look like
a multi-instance administration interface and made `loom chat "..."` needlessly
awkward.

## Confirmed Interface

- `loom init`, `loom run`, `loom chat`, and `loom history` use `~/.loom` when
  `--root` is omitted.
- `--root <instance-root>` remains available for tests, temporary Instances, and
  an explicitly selected deployment location.
- The default is resolved from the process user's home directory; it is not a
  second configuration source and does not change Instance Root ownership.

## Result

- CLI root parsing now defaults to `path.join(os.homedir(), ".loom")` and keeps
  explicit root overrides.
- Local usage documentation presents the default commands and explains the
  override.
- The real foreground Host and Local chat/history test runs without `--root`
  under an isolated HOME, while existing explicit-root coverage remains.

Validation:

- Passed `npm run typecheck`.
- Passed `npm test`.
- Passed `npm run build`.
- Passed `git diff --check`.
