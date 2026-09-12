# 43 - Run a Local Interaction Channel

Status: resolved
Type: implementation

## Problem

Loom can run a prepared Instance, but it has no built-in local interaction route. A
first real `~/.loom` deployment therefore has no client that can submit human
Input or read the same interaction history that a future channel will use.

The local route must remain a transport Adapter. It must not create a private
inbox, transcript, or relationship history. The Runtime Store remains the only
recovery authority; a channel-neutral Interaction View is rebuilt from Runtime
Input, message Effect, and confirmed Delivery facts.

## Confirmed Interface

- Local is a built-in interaction channel and the explicit default enabled by
  `loom init`; its route reference is `local`.
- Weixin and nmem implementations remain package-provided but disabled unless
  Instance Configuration explicitly enables them. This ticket only assembles
  the currently usable interaction routes; nmem credentials and activation
  details remain a later deployment work item.
- `loom run --root <path>` remains the sole live owner of the Instance Root and
  starts the local Unix socket.
- `loom chat --root <path> <text>` is a client. It submits one local Input and
  prints the confirmed Individual entries produced for that Input. It does not
  open the Runtime Store or persist a client inbox.
- `loom history --root <path>` reads the same channel-neutral Interaction View
  through the local socket. Entries retain source/route provenance for display,
  but provenance does not partition continuity.
- Local Delivery is confirmed when the message Effect is durably available in
  the Instance's Interaction View. A later client can read it after reconnect.

## Interaction View

The view is a rebuildable read model, not another fact source. It includes human
interaction Input and confirmed `message` Effect/Delivery entries, excludes
thinking, tool traces, internal maintenance, and unconfirmed output, and carries
an opaque cursor for bounded reads. Frozen Activity and Cognitive Organs remain
the path that evolves Agent Workspace material.

## Out of Scope

- Weixin and local multi-route fan-out;
- a plugin registry, remote RPC, HTTP gateway, interactive terminal UI, or OS
  service installation;
- a second persistent local history store;
- nmem endpoint/auth configuration and enabling nmem in the CLI.

## Test Seam

- Runtime Interaction View and Input outcome are observed through the public
  Runtime Interface.
- Local Adapter socket lifecycle, request normalization, durable local Delivery,
  and reconnect-safe history are observed through its public Interface.
- CLI tests use a foreground Host process and the local client protocol; they do
  not inspect SQLite tables or socket implementation details.

## Result

- Added a channel-neutral Runtime Interaction View rebuilt from human interaction
  Input and confirmed message Delivery transitions. It exposes bounded forward
  pagination and Input outcomes without adding another history table.
- Added the built-in Local Interaction Channel over a private Unix socket. Local
  Delivery makes an existing Effect readable through the same Runtime view; the
  Adapter persists no message body or client inbox.
- Added explicit `integrations.local`, `integrations.weixin`, and
  `integrations.nmem` enablement. `loom init` explicitly enables Local and sets
  route `local`; disabled Weixin files are not read, and disabled nmem no longer
  exposes Main Agent or Memory Reflector tools and guidance.
- Added `loom chat` and `loom history` as clients of the running Host. A real
  child-process test starts `loom run`, calls a model-backed local Turn, then
  reconstructs the same history from a separate client.
- Added the operator contract in `docs/integrations/local.md` and updated Weixin
  activation documentation.

Validation:

- Passed `npm run typecheck`.
- Passed the complete `npm test` suite, including the real foreground Host,
  model-backed Local chat, reconnecting history client, disabled Integration,
  and Runtime Interaction View paths.
- Passed `npm run build`.
- Passed `git diff --check`.
