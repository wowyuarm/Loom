# Backup, Restore And Migration

This guide covers a complete Runtime Instance. Read
[Agent-guided Instance Operations](../agent-guided-instance-operations.md) first.

Backup and restore are Operator procedures, not Loom commands or scheduled
Harness jobs. Git or GitHub history of selected Workspace material is a separate
human review surface and never replaces a complete Instance backup. Workspace
Mirror（见 [Workspace Mirror Integration](../../integrations/workspace-mirror.md)）
是这一原则的实例级实现：定期把 Workspace 镜像到私有 Git remote 供人查看，
但它不包含 Runtime 状态，不能用于恢复，也不能替代本指南描述的完整备份。

## Backup Boundary

The backup unit is the complete Instance Root. It includes Workspace, Runtime
and Channel and Integration state, Transcripts, configuration, credentials, the Instance-level
attachment store (`runtime/attachments/`), and
protected Workspace-write recovery material. Do not select subdirectories.

Do not copy a live Instance Root. Loom has SQLite WAL databases and ordinary
files that must describe one point in time. The first supported consistency
boundary is a planned, graceful Host stop.

A local copy does not protect against host loss. Only an independently stored
copy can support that claim. The external tool, destination, encryption, key
custody, retention and schedule belong to the deployment; Loom does not choose
or manage them.

## Create A Backup

Obtain explicit authorization for the Instance, interruption, destination and
access to private material. Record the service name and Instance Root without
recording credentials.

1. Gracefully stop the matching service and verify that it is inactive.
2. Run the authorized external backup tool against the entire Instance Root.
3. Verify the artifact using that tool's own verification mechanism.
4. Start the original service, run `loom status`, and record the backup time,
   artifact identifier and verification result without secrets.

Do not claim success if the copy or its verification is unknown. A verified
archive is still not a tested recovery.

## Restore

A restore starts with a stopped target Host and a fresh target directory.
Restore the complete root, preserve its owner and permissions, and never merge
files from two Instance revisions.

Before starting it, verify the intended Unix account, service configuration,
Loom build and target-specific Channel and Integration dependencies. Do not run the original
and restored Instance with the same external channel credentials at once; that
can create duplicate external activity.

Start the restored Host only in the authorized environment, then use `loom
status` and the relevant Channel or Integration acceptance checks. A restore drill has
succeeded only to the extent those checks were actually performed. Loom does
not yet provide a separate read-only restore-validation command.

## Migrate

Migration uses the same complete backup and restore boundary. Keep the source
Host stopped after the final backup while validating the target. Review
host-specific paths, ownership, service configuration and Channel and Integration
dependencies on the target; do not edit private Runtime databases to adapt the
Instance.

Start only one side with external channel credentials. After the target passes
the authorized checks, record which host is now authoritative and whether the
source remains stopped or is retained as a rollback copy. Do not call a code
checkout, GitHub Workspace mirror or partial Workspace copy an Instance
migration.
