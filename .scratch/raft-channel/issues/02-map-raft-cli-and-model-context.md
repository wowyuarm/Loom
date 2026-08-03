# 02 - Map Raft CLI and Model Context

Status: resolved
Type: research

## Question

What capabilities does the published Raft agent CLI expose, how does an
External Agent receive enough context to choose among them, and what model
context seam should Loom discuss before implementing a third Interaction
Channel?

## Result

The version-pinned capability map is in
[raft-cli-capabilities.md](../research/raft-cli-capabilities.md).

Raft exposes much more than inbound and outbound text: message history and
search, reply threads, channel membership and attention, tasks, reminders,
attachments, reactions, profiles, server inspection, and third-party
integrations. The published CLI is agent-facing, but its message path is a text
protocol rather than a machine JSON contract. `message check` acknowledges
server delivery before Loom can durably accept the Input, while `message send`
has no idempotency key and may hold a draft when newer messages exist.

Therefore the following are separate decisions:

- the Raft Adapter's private use of CLI/API operations to implement durable
  ingress and outbound Delivery;
- the Main Agent's optional access to Raft read/search/collaboration tools;
- channel-wide system guidance about the external place and available actions;
- durable per-Input facts about sender, audience, target and reply location;
- tool descriptions that state the exact effect and visibility of each action.

The official Claude channel plugin uses a short SessionStart orientation, a
content-free wake notice, then CLI stdout for detailed context. Loom can borrow
that layering, but not its generic prompt wording or its assumption that the
model itself owns message checking and sending.

## Final Decisions

- The Main Agent receives generic `message` and four explicit read tools, not credential-bearing raw
  CLI access.
- Stable Channel Guidance, actor-aware per-Input Interaction Context and tool effects remain three
  separate model-visible layers.
- Route and Destination are distinct durable Effect facts; Delivery never uses mutable Adapter state
  to infer a reply target.
- Ingress persists a bridge wake and then uses exact `message resolve`; `message check` is excluded
  because it acknowledges before Loom can commit the corresponding Input.

The complete contracts are collected in the
[Raft Interaction Channel design](../design/raft-individual-interaction-model.md). Ticket 04 owns
implementation and real CLI validation.

## Constraints

- Do not expose a credential-bearing `RAFT_PROFILE` to Main Agent shell merely
  because the Host needs it for the Raft Adapter.
- Do not bypass Loom Input, Effect or Delivery by asking the model to run raw
  `raft message check` or `raft message send` as the primary channel path.
- Prompt wording may be finalized only as part of Ticket 04 against the accepted design and actual
  Main Agent Interface.
