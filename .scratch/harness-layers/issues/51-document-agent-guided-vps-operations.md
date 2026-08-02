# 51 - Document Agent-guided VPS Operations

Status: resolved
Type: operations documentation

## Problem

Loom can initialize and run one prepared Instance, but its first local Instance
does not establish how an authorized agent should prepare several independent
Individuals on one VPS. Encoding deployment, account creation, Identity design
or credential choices in new CLI commands would turn the Harness into a rigid
operator product and take those judgments away from the user.

## Confirmed Direction

- Loom remains a single source repository with a `loom` CLI; it is not a
  released package, multi-Instance Host, deployment controller or interactive
  wizard.
- The CLI stays a set of composable primitives. A user-authorized Operator Agent
  reads the operating documentation, asks for the actual Individual and host
  decisions, then performs the authorized work with those primitives.
- One VPS may share a root-owned, runtime-read-only `/opt/loom` checkout. Each
  Agent Individual has a distinct Unix account, Instance Root and
  `loom@<instance>.service` Host.
- `loom init` continues to create only the repeatable Harness scaffold and
  generic Harness Behavior. It reports the Individual-owned materials rather
  than inventing their contents.
- `systemd` owns boot startup and restart. `loom run` remains the single live
  owner of an Instance Root and receives `SIGTERM` for its existing graceful
  stop path.

## Result

- Added ADR 0002 to make the Operator Agent / Harness split explicit for future
  CLI, deployment and initialization decisions.
- Added an agent-readable operations guide: its prerequisites, Instance
  readiness contract, multiple-Individual permission model and normal VPS
  commands are all documented without becoming a Loom workflow engine.
- Added a `loom@.service` template. It runs a named Instance as its matching
  `loom-<name>` account, restarts only after failures, and leaves normal stop
  unbounded so the Host can finish active work.

## Validation

- `systemd-analyze verify docs/operations/loom@.service`
- target VPS 的 `systemd-analyze verify /tmp/loom@.service`（仅上传临时模板后删除，未安装、未启动或创建用户）
- reviewed every command against the existing CLI and Host interfaces
