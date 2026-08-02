# 49 - Explain an unavailable Local Host

Type: bug
Status: resolved
Blocked by: None

## Problem

`loom chat` and `loom history` are Local clients, not alternate Runtime owners.
When no `loom run` Host is listening, including after an ungraceful stop leaves
a stale Unix socket pathname, the client exposed Node's `ECONNREFUSED` or
`ENOENT` detail. That neither explains that history remains intact nor gives the
user the next action.

## Confirmed Interface

- A Local client that cannot connect because the socket is absent or refuses a
  connection reports: `Loom Host is not running; start it with loom run before
  using Local chat or history`.
- The client does not remove the socket. Only the live Host owns its socket
  lifecycle, so a client cannot race a Host that is starting.
- Other Local protocol and server errors remain unchanged.

## Result

- Local connection refusal and a missing socket are translated at the Local
  client boundary. `loom chat` and `loom history` now give the same actionable
  result whether a stale pathname exists or no socket exists.
- A public Local client test covers both commands against an unlistened socket.
- The existing graceful Host stop coverage remains the socket cleanup contract;
  this change does not make a client a Runtime or Host owner.

## Verification

- Focused Local integration test suite passed.
- Full repository test suite passed.
- A real HaL Host started, served `loom history`, and stopped under the existing
  foreground Host lifecycle.
