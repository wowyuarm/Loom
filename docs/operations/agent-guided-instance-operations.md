# Agent-guided Instance Operations

Loom is not a deployment product or an Individual generator. Its CLI exposes
repeatable Instance operations; a user-authorized Operator Agent uses those
operations after learning what the user wants to run and where. Do not add a
wizard, `loom deploy`, `loom add-agent`, shared control plane, or fixed
Individual template to replace this judgment.

## What Must Be Decided First

Before writing an Instance Root or changing a host, the Operator Agent confirms:

- whether this is a new Individual or an intentional migration;
- the Individual's initial Identity, Stable Facts, Long-term Memory and Current
  Attention, including the language and relationship context that should ground
  them;
- the target host, the Instance name, and whether the person authorizes host
  changes;
- the model configuration and the location of its credentials, without exposing
  credential contents in logs, tickets or conversation summaries;
- the desired interaction route and whether each Integration should be enabled.

Loom does not prescribe those answers. The Operator Agent asks for missing
information and writes only the materials that the user has authorized. It must
not treat an empty scaffold as a ready Individual or fabricate a first human
interaction merely to test a deployment.

## Available Loom Primitives

`loom init` creates a repeatable Instance scaffold: the minimal configuration,
Pi configuration directory, and Harness-owned Interaction and Background
Behavior. It reports, but does not create, the required Individual materials:

```text
workspace/facts.json
workspace/identity.md
workspace/memory.md
workspace/attention.md
```

The Operator Agent supplies these materials in the user's chosen form. Before a
Host can open, `facts.json` must be valid JSON with `version: 1` and object
sections named `individual` and `human`; the other required materials must be
non-empty. Model choices belong in `configuration/instance.yaml`; Pi credentials
belong in `configuration/pi/auth.json`. Optional Integrations remain disabled
until their configuration and credentials are deliberately supplied.

Integration-specific preparation belongs to the corresponding operational
document. For Raft, the Operator Agent follows [Raft Interaction Channel](../integrations/raft.md)
to create or select an External Agent profile, bind it to the intended server
and principal relationship actor, write the Instance configuration, and run
the first real acceptance checks. Loom does not perform Raft login or infer
these bindings from a credential.

`loom run` owns one prepared Instance Root. `loom chat` and `loom history` are
clients of its enabled Local Interaction Channel; they do not create another
Runtime owner or private history store. `loom run` accepts `SIGTERM` and waits
for current work to finish, so an external supervisor owns boot startup and
restart rather than Loom growing its own daemon manager.

## Operating One Instance

An Operator Agent works from small, independently checkable actions. It must
state both the evidence it obtained and the conclusion that evidence supports;
it must not turn an unknown state into a healthy one by inference.

| Need | Current action | What its result proves | What it does not prove |
| --- | --- | --- | --- |
| Is the Host process supervised? | Inspect `loom@<instance>.service` with systemd. | The service process is active, inactive, or has failed. | That the model, an Integration, or a Cognitive Organ is healthy. |
| What is the live Instance state? | Run `loom status` as the Instance account; use `--json` for structured output. | The running Host's current model, Runtime, Agent and enabled Integration state. | Why an unavailable Host stopped, or private activity content. |
| What happened during a period? | Read the matching service journal, with an explicit time range. | Content-free lifecycle, Runtime transition, model and tool events that the running Host emitted. | A complete history, a current Integration state, or an Agent's successful work when no event says so. |
| Can the Local channel answer? | Run `loom chat` or `loom history` as the Instance account when Local is enabled. | The Local client reached the running Host and received the requested result. | That another enabled Integration is connected, or that the Instance has no pending work. |
| Is a configured Raft bridge connected? | Read the Raft entry in `loom status`, then use Raft-specific acceptance checks when behavior must be proved. | The bridge's current live state and bounded failure category. | That DM, thread, ambient and replay behavior have all passed acceptance. |

Never open `runtime.db`, an Integration database, or a transcript as an
operator shortcut. They are private state, not an operator query interface.
Never start a second Host for the same Instance Root in order to inspect it.
If the available evidence is insufficient, report that state as `unknown` and
ask whether the user authorizes a restart, an Integration-specific check, or
further investigation.

### Loom Status

`loom status` queries a Host-owned, read-only local endpoint. It does not open a
second Instance, connect an Integration, or infer live state from files. The
default output is concise and human-readable; `loom status --json` returns the
same evidence with a versioned schema. `loom status --since <ISO timestamp>`
also returns content-free Agent run summaries that overlap the requested time
range.

The snapshot distinguishes Host, Model Runtime, pending Runtime work, each
Agent's latest result and every enabled Integration's live state. It contains
no message, prompt, tool trace, Workspace content, Effect payload, credential,
path, remote object id or raw provider error. A stopped or unreachable Host is
explicitly `unavailable`; use systemd and the service journal to determine why.
`operational-events` remains diagnostic output rather than a status fact source.

### Diagnosis And Recovery

For an incident, preserve the smallest useful evidence first: the Instance
name, root path, service state, time window, command result and relevant
content-free journal events. Do not include credentials, message bodies,
transcripts, or attachment contents in tickets or summaries.

When the service has failed or an enabled Integration is degraded, first read
the journal and identify whether the failure was during Host startup, model
work, Runtime work, or the Integration. A service restart is an authorized
recovery action, not proof of the cause. `SIGTERM` is graceful: the Host waits
for active work to finish and reconstructs durable pending Runtime work on its
next start. Do not delete a socket, database, replay data, or Workspace file to
make a restart appear clean.

An Integration can fail while the Host process remains active. In particular,
a Raft bridge becoming `degraded` is recovered by the external supervisor
restarting the Host; Loom does not create a replacement bridge in the existing
Host. An Operator Agent must obtain authorization before intentionally
interrupting a live Individual, and report the interruption's scope.

## Manual Whole-Instance Backup And Restore

This is an Operator procedure, not a Loom command or scheduled Harness job.
It protects against host loss only when the resulting copy is kept away from
that host. GitHub review history is separate: it may contain selected Workspace
materials, but it never replaces a complete Instance backup.

The backup unit is the complete Instance Root. It includes the Workspace,
Runtime and Integration state, transcripts, configuration, credentials,
attachments and protected Workspace-write recovery material. Do not select
subdirectories and do not copy the root while its Host is running: Loom has
SQLite WAL databases and ordinary files that must describe one point in time.

Before any backup or restore, the Operator Agent obtains the user's explicit
authorization for the affected Instance, host interruption, destination and
access to private material. It records the service name and root path, then
performs this procedure:

1. Gracefully stop the matching `loom@<instance>.service` and verify that it
   is inactive before copying any data.
2. Run the authorized external backup tool against the entire stopped Instance
   Root. The tool, destination, encryption, retention and scheduling policy
   belong to the deployment; Loom does not choose or manage them.
3. Verify the artifact using that tool's own verification mechanism, then
   start the service again and record the backup time, artifact identifier and
   verification result without recording secrets.

A successful archive is not a tested recovery. A restore always begins with a
stopped target Host and a fresh target directory; it restores the complete
root, preserves its owner and permissions, and never mixes files from two
Instance revisions. Do not run both the original and restored Instance with
the same external channel credentials at once: that can create duplicate
external activity. The specific isolated-host restore drill remains a required
deployment decision until Loom has a read-only restore-validation primitive.

## Multiple Individuals on One VPS

Use one Runtime Instance, Unix account and service instance per Agent
Individual. The shared Loom checkout may be `/opt/loom`, owned by the deployment
operator and not writable by runtime accounts. Each Individual then owns only
its home and Instance Root:

```text
/opt/loom/                         shared Loom code, read-only at runtime

loom-hal
  /home/loom-hal/.loom/            one Individual's Instance Root
  loom@hal.service                 one Host process

loom-aria
  /home/loom-aria/.loom/           another Individual's Instance Root
  loom@aria.service                another Host process
```

This is a deployment permission boundary, not part of an Individual's identity.
It matters because a Main Agent has ordinary shell tools and its Workspace is
not a host-level sandbox. Do not put unrelated Individuals under one Unix
account unless their operator deliberately allows them to read and alter each
other's files.

## systemd

[`loom@.service`](loom@.service) is a system service template for the layout
above. It runs `loom@hal` as `loom-hal`, with an explicit Instance Root. It
keeps graceful shutdown unbounded because Loom's Host contract waits for the
active run to finish; an operator may explicitly intervene after assessing an
incident, and Loom recovers durable work when restarted.

The following is an operational recipe for an authorized administrator, not a
new Loom command:

```bash
# Install or update the shared checkout as a deployment operator.
git clone <loom-repository> /opt/loom
cd /opt/loom
npm ci
npm run build

# Create an account for one Individual and create its blank Instance scaffold.
useradd --system --create-home --home-dir /home/loom-hal --shell /usr/sbin/nologin loom-hal
install -d -o loom-hal -g loom-hal -m 700 /home/loom-hal
sudo -u loom-hal -- /usr/bin/node /opt/loom/dist/src/cli.js init --root /home/loom-hal/.loom

# After supplying authorized Individual materials, model configuration and
# credentials, install and start the matching Host.
install -o root -g root -m 644 docs/operations/loom@.service /etc/systemd/system/loom@.service
systemctl daemon-reload
systemctl enable --now loom@hal.service
```

The administrator runs Local clients as the matching account:

```bash
sudo -u loom-hal -- /usr/bin/node /opt/loom/dist/src/cli.js chat --root /home/loom-hal/.loom "..."
sudo -u loom-hal -- /usr/bin/node /opt/loom/dist/src/cli.js history --root /home/loom-hal/.loom
journalctl -u loom@hal.service -f
```

When updating the shared checkout, first stop each affected service, update and
build `/opt/loom`, then start it again. A service restart intentionally waits
for current work to end. Instance Roots and their credentials are not replaced
by a code update. Backing up and restoring an Instance follows the procedure
above; do not claim this recipe provides a tested off-host recovery guarantee
until an actual restore drill has succeeded.
