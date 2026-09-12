# 37 - Run a Prepared Instance Host

Status: resolved
Type: implementation

## Problem

Loom can assemble and continuously drive a Runtime Instance, but it has no formal process host. Validation scripts still open the Instance directly, while `openLoomInstance` also creates Instance directories and default Behavior material and silently replaces malformed Instance Configuration with defaults. A production entry must not run a different policy than the file on disk, and two processes must not own the same Instance Root.

This ticket establishes the smallest foreground Host for an already prepared Instance Root. It does not add a channel, initializer, service installer, or control plane.

## Confirmed Interface

- `openLoomHost(...)` acquires exclusive live ownership of one Instance Root and opens its `LoomInstance`.
- The Host exposes `start`, `acceptInput`, `wake`, `status`, and `stop`; it delegates continuous lifecycle work to the existing `ProcessDriver` rather than adding another scheduler.
- `stop` waits for the active Instance run to finish, closes the Instance, then releases root ownership.
- Host status keeps Host, Driver, and Instance state distinct.
- A malformed or invalid `instance.yaml` prevents the Instance and Host from opening. A missing file continues to mean the documented default Instance Configuration.
- `openLoomInstance` may create operational Runtime/Transcript/backup directories, but it does not create Workspace, Configuration, Pi, Identity, Stable Facts, Memory, Attention, or Behavior material.

## Foreground Entry

- The first CLI surface is `loom run --root <instance-root>`.
- `SIGINT` and `SIGTERM` request the same graceful Host stop path.
- The foreground entry does not daemonize, install a service, expose RPC, or implement restart. An external supervisor will own crash restart and boot startup later.

## Test Seam

- Instance configuration failure is observed through `openLoomInstance`.
- Host ownership, status, Input ingress, and graceful stop are observed through the public `LoomHost` Interface.
- Signal handling is verified through the foreground CLI process, without inspecting lock files or Runtime Store tables.

## Out of Scope

- Weixin or another Channel Adapter;
- `loom init`, Workspace templates, onboarding, or first-run identity generation;
- systemd/launchd installation and service status;
- HTTP/RPC health endpoints, remote control, hot restart, or multi-instance hosting;
- credential management beyond the existing Pi files.

## Source References

- Loom Tickets 27 and 34
- Xi source Tickets 04, 06, and 07
- Xi research `10-openclaw-hermes-host-channel-and-operations.md`

## Result

- Added a foreground `loom run --root <instance-root>` entry that owns one prepared Instance Root, starts the existing Process Driver, and follows the same graceful stop path for `SIGINT` and `SIGTERM`.
- Added a public Host Interface for lifecycle, Input ingress, wake, and distinct Host / Driver / Instance status without introducing another scheduler or control plane.
- Enforced one live Host per Instance Root with an OS-released SQLite transaction lock.
- Changed Instance opening to reject malformed configuration and incomplete Workspace materials while continuing to create only operational Runtime, Transcript, and backup directories.
- Verified Host ownership and release, running-only Input ingress, failed-open recovery, and a real foreground child-process signal path.

Validation:

- `npm run typecheck`
- `npm test` (228 tests passed)
- `npm run build`
- `git diff --check`
