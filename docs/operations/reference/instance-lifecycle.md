# Instance Lifecycle

This guide covers installing Loom, initializing and running one Runtime
Instance, updating shared code and hosting multiple Individuals. Read
[Agent-guided Instance Operations](../agent-guided-instance-operations.md) first.

## Prepare One Instance

Confirm whether this is a new Individual or an intentional migration. A
migration follows [Backup, Restore And Migration](backup-and-restore.md); do not
initialize over restored or existing material.

`loom init` creates a repeatable Instance scaffold: minimal configuration, the
Pi configuration directory, and Harness-owned Interactivity and Proactivity
Behavior. It reports, but does not create, the required Individual materials:

```text
workspace/facts.json
workspace/identity.md
workspace/memory.md
workspace/attention.md
```

The Operator Agent supplies these materials only in the form authorized by the
user. `facts.json` must contain `version: 1` and object sections named
`individual` and `human`; the other files must be non-empty. An empty scaffold
is not a ready Individual.

Follow [Configuration And Credentials](configuration-and-credentials.md) for
model selection, secret files, permissions and Channel or Integration enablement. Optional
Channels and Integrations remain disabled until every required file is deliberately supplied.
Then follow the matching guide under `docs/channels/` or `docs/integrations/` before enabling one.

`loom run` owns one prepared Instance Root. It accepts `SIGTERM` and waits for
current work to finish, so an external supervisor owns boot startup and restart.
After starting the Host, use `loom status` and the enabled Channel or Integration's real
acceptance checks. Startup alone does not prove that the Instance works.

## Multiple Individuals On One Host

Use one Runtime Instance, Unix account and service instance per Agent
Individual. Shared Loom code may be read-only at runtime:

```text
/opt/loom/                         shared Loom code

loom-hal
  /home/loom-hal/.loom/            one Individual's Instance Root
  loom@hal.service                 one Host process

loom-aria
  /home/loom-aria/.loom/           another Individual's Instance Root
  loom@aria.service                another Host process
```

This is a deployment permission boundary, not part of an Individual's identity.
The Main Agent has ordinary shell tools and its Workspace is not a host-level
sandbox. Do not place unrelated Individuals under one Unix account unless the
operator deliberately allows them to read and alter each other's files.

## systemd Deployment

[`loom@.service`](../loom@.service) is a system service template for this layout.
It runs `loom@hal` as `loom-hal`, with an explicit Instance Root. Its graceful
shutdown remains unbounded because the Host waits for active work to finish.

The following is a recipe for an authorized administrator, not a Loom command:

```bash
# Install the shared checkout.
git clone <loom-repository> /opt/loom
cd /opt/loom
npm ci
npm run build

# Create one account and its blank Instance scaffold.
useradd --system --create-home --home-dir /home/loom-hal --shell /usr/sbin/nologin loom-hal
install -d -o loom-hal -g loom-hal -m 700 /home/loom-hal
sudo -u loom-hal -- /usr/bin/node /opt/loom/dist/src/cli.js init --root /home/loom-hal/.loom --channel raft

# After supplying authorized Individual material, configuration and credentials,
# install and start the Host.
install -o root -g root -m 644 docs/operations/loom@.service /etc/systemd/system/loom@.service
systemctl daemon-reload
systemctl enable --now loom@hal.service
```

Run Loom clients as the matching Instance account:

```bash
sudo -u loom-hal -- /usr/bin/node /opt/loom/dist/src/cli.js status --root /home/loom-hal/.loom
sudo -u loom-hal -- /usr/bin/node /opt/loom/dist/src/cli.js history --root /home/loom-hal/.loom
```

## Update Loom

An already running Host continues to use its current build. For each affected
Instance, obtain authorization, gracefully stop its service, update and build
the shared checkout, then start the service and verify it with `loom status` and
the relevant Channel or Integration checks.

Do not replace Instance Roots or credentials during a code update. If the Host
does not stop normally, investigate before forcing it; durable recovery does not
make an unexplained interruption harmless.

After any migration, restore or manual copy that touches the Instance Root,
check file ownership before starting the Host. Every file and directory must
belong to the Instance account; root-owned leftovers (a common migration
artifact) stay latent until a configuration or runtime write path hits
`EACCES`. Verify with `find <instance-root> ! -user <instance-account>` and
`chown` the leftovers back to the Instance account.
