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
by a code update. Backing up and restoring an Instance is a separate Loom work
item; do not claim this recipe provides that guarantee.
