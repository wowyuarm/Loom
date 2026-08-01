# 46 - Correct First-use Operations

Status: resolved
Type: implementation

## Evidence

The first real HaL Turn was accepted at `2026-07-31T14:01:46.543Z` and delivered
at `14:04:29.416Z`. HaL used ordinary Workspace tools to inspect Loom and Xi,
then sent a valid reply after about 162.9 seconds. Local's fixed 120-second wait
reported `Timed out waiting for the local Input to finish` even though Runtime
continued and confirmed Delivery about 43 seconds later.

The same run exposed an observability gap: foreground `loom run` printed only
Host start and stop. Runtime transitions, an active Driver run, Main Agent tools,
Delivery, after-chat work, and failures were available only through in-memory
status, SQLite, or Primary Transcript inspection.

The deployed Instance also retained `templates/workspace/` after active HaL
materials existed. No runtime consumer reads those files. Writing their
placeholder contents directly into active Workspace would be worse because it
would present deployment instructions as an Individual's identity or memory.

The linked development CLI exposed one more first-use failure: every build
removed `dist/`, and TypeScript recreated `dist/src/cli.js` with mode `0644`.
The global `loom` symlink remained valid but could no longer execute its target,
so `loom run` repeatedly failed with `Permission denied` after a build.

## Confirmed Interface

- Local waits without a deadline by default. An embedding may explicitly set a
  finite internal wait limit; the built-in Host does not.
- A disconnected Local client stops its own wait but does not cancel or alter an
  accepted Runtime Input. Later clients recover through Interaction View.
- Loom exposes one operational event Interface. Runtime emits durable transition
  facts after persistence; Process Driver emits run start/completion/failure;
  Main Agent emits tool start/completion with only tool name, id, timing, and
  error status.
- `loom run` writes those events as one JSON object per line. It never logs Input
  or Effect content, tool arguments/results, prompt, thinking, credentials, or
  Workspace file contents.
- `loom init` creates Harness-owned configuration, Behavior, and directories. It
  reports the four required active Individual material paths but creates no
  templates and no placeholder active materials.
- Existing `templates/` directories are not runtime state. The deployed HaL
  Instance removes its unused initializer templates.
- The repository build leaves its linked CLI target executable. Rebuilding must
  not require another `npm link` or manual `chmod`.

## Test Seams

- Local Adapter test: an explicit no-deadline wait outlives a short delayed
  outcome; client disconnect does not retain the socket wait.
- Process Driver and Pi Execution public Interfaces: captured events show a run
  and ordinary tool lifecycle without content leakage.
- Foreground CLI test: JSONL output includes Host, model, Integration, Runtime,
  Driver, and tool progress during a real model-backed Local Turn.
- Initialization Interface: output and filesystem contain no template paths,
  while active Individual materials remain absent.
- Build artifact test: the compiled CLI retains at least one executable bit.

## Result

- Local now waits without a default deadline and releases a disconnected
  client's pending wait without changing the accepted Runtime Input.
- One thin operational event Interface crosses model revision, Runtime,
  Process Driver, and Main Agent tool lifecycle. The CLI renders it as JSONL;
  Local remains only an interaction channel and does not own logging.
- Operational events contain states, opaque ids, durations, and bounded failure
  kinds. End-to-end tests confirm that human Input and Individual reply text do
  not enter Host stdout.
- `loom init` now creates only configuration, Behavior, and required
  directories. It reports four active Individual material paths without
  creating templates or placeholder material.
- The unused `/home/yu/.loom/templates` tree was removed after confirming its
  four files were the old initializer output.
- Typecheck, the full test suite, focused success/failure/disconnect tests, and
  temporary-directory cleanup all pass.
- The build now restores executable mode on `dist/src/cli.js`; the linked
  `loom` command runs normally after repeated builds.

## Real Instance Acceptance

- The stale foreground Host was stopped and the latest build reopened the real
  `/home/yu/.loom` Instance. Its stdout showed model, Driver, Host, Local, and
  Runtime transition events without interaction content.
- A real Local Input was accepted at `2026-08-01T10:41:04.167Z`, entered its
  Main Agent Turn at `10:49:16.418Z`, and completed at `10:54:53.441Z`. The
  roughly 13 minute 49 second end-to-end wait exceeded the old deadline by more
  than eleven minutes and still completed normally without a Local timeout.
- The unusually long model and lifecycle latency remains useful operational
  evidence, but it is separate from the false client timeout corrected here.
