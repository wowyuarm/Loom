# 52 - Deploy HaL to a VPS Instance

Status: resolved
Type: deployment

## Goal

Deploy the existing HaL Runtime Instance to a VPS as `loom-hal`, preserving its
Instance Root rather than reconstructing its history. The Instance uses the
built-in Local Interaction Channel; Weixin and nmem remain disabled.

## Result

- Installed the verified Instance Root at `/home/loom-hal/.loom` under the
  dedicated `loom-hal` Unix account. A prior incomplete directory remains as
  `/home/loom-hal/.loom.incomplete-20260802-github` for rollback.
- Installed and enabled `loom@hal.service`. It runs the existing `/opt/loom`
  build as `loom-hal` and is now active with no restart attempts.
- Used a temporary private GitHub repository only to move an encrypted archive
  after the direct Tailscale transfer proved unreliable. The archive hash was
  verified before extraction; temporary VPS keys, clear archive, and staging
  directory were removed after activation.
- Verified Local enabled, Weixin disabled, and nmem disabled. The Local socket
  is owned by `loom-hal`, mode `0600`, and the read-only interaction view
  responds without exposing message contents or creating a new Input.

## Validation

- source and VPS archive SHA-256 matched before extraction
- attachment SQLite `PRAGMA integrity_check` returned `ok`
- `systemd-analyze verify /etc/systemd/system/loom@.service` passed; its only
  output was an unrelated system `snapd.service` warning
- `loom@hal.service` reports `active (running)` with `NRestarts=0`

## Operational Follow-up

The temporary GitHub repository is still private, but its temporary deploy key
has been revoked. Deleting the repository requires the local GitHub credential
to receive the `delete_repo` scope; no Instance credential or archive content
is recorded here.
