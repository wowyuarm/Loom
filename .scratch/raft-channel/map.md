# Raft Channel Research

## Purpose

Assess whether Raft can become an explicit Loom Interaction Channel Integration
for human and multi-agent collaboration, without turning Raft into
an Individual's home, memory system, runtime owner, or generic Loom control
plane.

This work begins from one concrete Instance's exploratory Raft experience, but
defines and validates the external facts and Loom seams for the generic Channel
layer rather than for that Individual.

## Current Direction

- Raft is an Interaction Channel Integration in the same class as Local and
  Weixin. A Loom Instance runs as a Raft External Agent, using Raft's generic
  CLI path rather than any Pi-specific runtime integration.
- Loom Workspace, Identity, Transcript and Runtime Store remain authoritative.
  Raft is a collaborative surface for channels, DMs, tasks, reminders and
  visible member presence.
- A Raft message is not automatically Loom memory. Inbound material must enter
  through the existing durable Input path; outbound material remains a Loom
  Effect before Raft delivery.
- The first acceptance Instance makes Raft its only enabled interaction channel. Local, Weixin and
  multi-route selection remain outside this work rather than hidden scope for the Adapter.
- The initial Interaction Channel, bounded thread context, existing-task actions and explicit
  attention management are accepted through Tickets 04 and 05.
- Tickets 06 and 07 close the current Raft round: deliberate sends to a bounded set of previously
  known Raft places and the complete local endpoint contract expected by the pinned bridge are
  implemented, deployed and accepted. First-contact member discovery remains outside this work
  rather than being claimed by a partial Destination list.

## Confirmed Design Decisions

The following decisions are settled at the design level. They are not yet an
implementation contract or final prompt text:

- Direct signals (DM, `@mention`, a followed or already-participating reply
  thread, task and reminder addressed to the Individual) may become durable
  Loom Inputs. Ordinary joined-channel activity remains bounded attention
  evidence and is discovered by Loom's existing proactive pulse rather than
  creating a Turn for every message.
- Raft contributes an optional Channel Agent Surface: stable channel guidance,
  Main Agent tools and, when useful, an attention source. Channels that do not
  need an attention source do not implement an empty one.
- A Raft Attention Snapshot contains bounded place, count, time, member and
  signal information plus expandable refs, not ordinary message bodies. The
  presented position advances only after Orientation succeeds; new activity
  arriving during the run belongs to the next pulse.
- Orientation keeps its Harness-owned generic prompt and receives Raft only as
  one bounded External Attention Evidence index. A Snapshot is omitted when
  Raft is disabled or has no new ambient evidence. Counts, recency and unread
  state do not create priority, yet a specific unfamiliar external signal may
  still become a genuine opening without first matching an existing Thread or
  Current Attention.
- Main Agent context keeps stable Channel Guidance after Long-term Memory.
  `facts.json` remains a Cognitive Organ-only input. A Raft Input carries the
  sender, place, visibility, audience, message/thread/task refs and reply
  destination facts; the channel-use reminder is added once at the first
  Interaction of a Runtime Turn.
- Model-visible channel semantics are deliberately split three ways: stable
  Channel Guidance explains the external place and the Individual's judgment
  space; each current Input supplies its actual actor, place, audience and
  available destinations; tool descriptions state exact action effects. The
  current `<human_input>` assumption must become actor-aware Interaction
  Context rather than treating every Raft sender as the principal human.
- Raft-specific Main Agent guidance, tools and Orientation attention evidence
  exist only when the Instance explicitly enables and successfully assembles
  the Raft Integration. Disabled or unavailable Raft does not leave an empty
  prompt section or advertise unusable tools.
- Actor identity is explicit and namespaced: `individual`, `human`, `system`
  and `external:raft:<server-id>:<member-id>`. Only the configured principal
  relationship actor is `human`; display names never establish that mapping.
- Interaction Route selects the Channel Adapter and its connection boundary;
  Interaction Destination selects the concrete DM, channel or reply thread
  within that Route. Both are durable Effect facts. Destination refs are
  opaque Adapter-owned values, never model-composed CLI targets or mutable
  "most recent thread" state.
- A proactive Turn without a current Interaction may use an explicitly bound
  top-level DM with the principal relationship actor as its default Raft
  Destination. This exposes a place the Individual may contact; it does not
  create an obligation, a new cadence or a default for other members/places.
- The first successful Raft activation establishes the inbound ownership
  boundary. Earlier Raft history remains tool-readable external evidence and
  is not backfilled as Loom Inputs; activity after activation belongs to Loom
  ingress and must be recoverable even when the Host was offline.
- Different Raft audiences remain different external places, not different
  Individuals. Their Inputs may enter one Main Agent Turn as separately
  attributed Context; visibility and explicit Effect Destinations govern what
  is said where. Loom does not create per-channel minds to simulate privacy.
- The Raft self profile is an explicit public projection of the Individual,
  not a synchronized copy of Loom Identity. Neither profile changes nor
  Identity evolution automatically rewrite the other; any future profile
  mutation is a deliberate external action by the Individual or Operator.
- The accepted Channel exposes text Input/Delivery, generic `message`,
  `raft_places`, `raft_activity`, `raft_search`, `raft_open`, and the bounded
  Orientation Snapshot, plus existing-task and explicit attention actions.
  Reactions, task creation, reminders, membership/profile changes and
  attachments wait for real behavioral evidence and their own recovery semantics.

These decisions keep Raft generic and channel-scoped. They do not make Raft a
second Workspace, memory store, scheduler or transcript owner.

## Work

| Issue | Status | Purpose |
| --- | --- | --- |
| [01 - assess Raft as a Loom Integration](issues/01-assess-raft-as-a-loom-integration.md) | resolved | Established Raft's place and Loom ownership boundaries. |
| [02 - map Raft CLI and model context](issues/02-map-raft-cli-and-model-context.md) | resolved | Established the CLI reliability facts and three model-visible context layers. |
| [03 - design Individual Raft interaction](issues/03-design-individual-raft-interaction.md) | resolved | Accepted the actor, attention, tool, reply and activation model. |
| [04 - implement the Raft Interaction Channel](issues/04-implement-raft-interaction-channel.md) | resolved | Implementation, deployment and HaL's real multi-reply thread acceptance are complete. |
| [05 - implement Raft task and attention actions](issues/05-implement-task-and-attention-actions.md) | resolved | Added existing-task and explicit unfollow/mute actions through durable Effects. |
| [06 - use known Raft destinations](issues/06-use-known-raft-destinations.md) | resolved | Let the Individual explicitly send to a bounded recent set of previously observed places. |
| [07 - complete the Raft bridge local endpoints](issues/07-complete-bridge-local-endpoints.md) | resolved | Return the pinned bridge's valid empty activity-drain contract instead of repeated 404s. |

## Accepted Implementation Evidence

- The pinned CLI parser and profile binding run against the real server in HaL's Raft-only Instance.
- Real `raft_open` returned one anchor and 11 replies with body, sender, time, visibility and opaque
  reply Destinations; `raft_activity` and `raft_search` also returned real evidence.
- Mixed-case profile names no longer block read tools or inbound normalization: exact handle lookup
  runs first, lowercase is only a fallback, and both aliases share one cache entry.
- A previously blocked thread request entered HaL as a normal Input after `fa09d2f` deployment, and
  the durable backlog resumed processing.
- Commit `b2c9925` exposed `raft_task` and `raft_attention` only when Raft is enabled, while keeping
  task and place targets opaque and persisting each write as one Effect.
- HaL used the deployed Instance to open and claim real task #2, report progress, move it to
  `in_review`, unfollow a real completed reply thread, and mute then unmute `#all`; YuCreate moved
  the accepted task to `done`.
- Current Raft has no authoritative read command for one thread's follow state. `raft_open` must not
  synthesize that field from Loom's last action; the follow-state read remains blocked until Raft
  exposes it.
- Commit `4ae81e1` added bounded durable known Destinations, kept the current Interaction place as
  the sole implicit default, and exposed a top-level task message's reply thread without raw targets.
- In real task #3, HaL opened and claimed from the top-level Input, reported in its reply thread,
  then received a YuCreate DM and explicitly sent the requested result to the previously known
  top-level `#Loom-Main` Destination. The task reached `done` after acceptance.
- The same deployment completed the bridge's local activity-drain contract. Repeated live bridge
  events now report `outcome=no_events` instead of HTTP 404 while Raft remains connected.

These facts close Tickets 04 through 07 without claiming unrun fault injection, first-contact
member discovery, task creation, reminders, reactions, attachments, unrestricted history or a
nonexistent thread follow-state read.

## Non-goals

- Do not treat Raft as an alternative Workspace, memory system, transcript
  store, scheduler, model runtime or multi-Instance Host.
- Do not make Local, Weixin and Raft coexist through an unexamined fan-out
  abstraction.
- Do not derive a generic plugin system from this one concrete Integration.
