# 13 - Bind Main Agent Message Decisions

Status: resolved
Type: Main Agent action contract

## Problem

Runtime already persists Effect and Delivery facts, but the Pi Main Agent cannot create them. It also cannot explicitly finish a Turn with `no_reply`. This leaves interaction and proactive execution dependent on assistant text that is not an external action.

This ticket closes the Main Agent side of the existing message contract before Orientation begins producing proactive Opportunity Inputs.

## Confirmed Semantics

- `message` is a Harness-maintained Main Agent tool, available when the Runtime Instance is assembled with a default Interaction Route reference.
- `send` accepts message text and asks Runtime to durably prepare one `message` Effect for that route. Tool success means the Effect was accepted; it does not mean Delivery succeeded or the human received it.
- `no_reply` prepares no Effect and returns the explicit Turn outcome `no_reply`.
- The Main Agent never sees channel type, endpoint, credentials or the human's identity through this tool.
- The default action is `send`. `after_send=end_turn` ends model execution after the tool result; `after_send=continue` permits more work or another message in the same Turn.
- This ticket supports text only. Media requires a real Integration contract and is not inferred from the source implementation.
- A Main Agent without an assembled Interaction Route does not receive the `message` tool. Configuration file format and route loading remain deferred.

## Interface And Test Seam

- `PiAgentExecution`: a `message.send` tool call prepares the expected Effect and returns a completed execution; `message.no_reply` prepares no Effect and returns `no_reply`.
- `Runtime`: existing Effect and Delivery interfaces remain authoritative. Tests do not inspect SQLite or assert prompt wording.

## Out Of Scope

- Channel adapters, media, credentials and Instance Configuration parsing.
- Requiring every interaction Turn to call `message`; that policy needs the final model-visible Input/tool guidance to be discussed with the proactive Context.
- Orientation, Opportunity generation, scheduling, quiet hours and silent Opportunity cleanup.

## Result

Main Agent assembly may now provide one opaque default Interaction Route. That adds a Harness-maintained `message` tool to each Turn without exposing channel or endpoint details.

`send` prepares a durable `message` Effect through `TurnControl` before reporting acceptance, and the tool result states that Delivery is still pending. `no_reply` prepares no Effect and returns the explicit Runtime Turn outcome. `after_send` controls whether Pi stops at the tool result or continues the same Turn.

Primary Transcript verification now permits a successful tool result to close a Turn only when Main Agent assembly explicitly authorizes that Harness terminal tool and the result has a matching committed call. Other tool-result leaves and incomplete interactions remain invalid.

The action surface remains absent when no Interaction Route is assembled. Media, channel adapters, route configuration and forced interaction follow-up remain deferred to their real consumers.

## Verification

- `npm run typecheck`
- `npm test` (75 passed)
- `git diff --check`
