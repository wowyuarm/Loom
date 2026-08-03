# 03 - Design Individual Raft Interaction

Status: resolved
Type: design

## Question

How should a Loom Agent Individual understand and use Raft as an external
collaboration place: which objects and identities are visible, which read tools
are available, how does an inbound signal become model context, and how can the
Individual participate without every channel or reply thread permanently
occupying attention?

## Evidence

- [Raft domain and agent collaboration](../research/raft-domain-and-agent-collaboration.md)
  establishes the official object, visibility, attention and External Agent
  behavior.
- [Raft CLI capabilities](../research/raft-cli-capabilities.md) establishes the
  published 0.0.17 command surface and its ingress, parsing and delivery gaps.
- Loom already owns durable Input, Effect/Delivery, Interaction Route, Primary
  Agent Transcript, Frozen Activity and private Thread semantics. Raft must not
  become a second owner of any of them.

## Result

The candidate model is in
[raft-individual-interaction-model.md](../design/raft-individual-interaction-model.md).
It defines:

- Raft objects and their distinct closure behavior;
- a four-tool read surface with proposed parameters and use cases;
- stable channel guidance, per-Input external facts and tool-result context;
- self and external member identity boundaries;
- behavior patterns for DMs, mentions, ordinary channel activity, reply
  threads, tasks and reminders;
- bounded discovery and attention management for many places;
- the current Loom actor implementation and reply-destination gaps that must
  be resolved before implementation.

## Confirmed Decisions

The following design decisions are accepted for the generic Channel layer:

- DM, `@mention`, followed or already-participating reply-thread updates,
  tasks and reminders addressed to the Individual may become durable Loom
  Inputs. Ordinary joined-channel activity is bounded attention evidence for a
  proactive pulse and does not create one Turn per message.
- Raft uses an optional Channel Agent Surface for stable channel guidance,
  Main Agent tools and attention snapshots. Local and Weixin do not need to
  provide an empty attention implementation.
- An Attention Snapshot is a fixed-revision, bounded summary of places,
  counts, times, members, signals and expandable refs. It omits ordinary
  message bodies. Loom advances the presented position only after Orientation
  succeeds; activity arriving during the run is left for the next pulse.
- Orientation retains one generic Harness-owned prompt. Raft contributes one
  bounded External Attention Evidence index only when enabled and when new
  ambient evidence exists. Message volume, recency and unread state do not
  rank it above Workspace or recent life. A concrete unfamiliar signal may
  still become a new curiosity opening without an existing Thread match.
- Stable Channel Guidance is placed after Long-term Memory in the Main Agent
  system prompt. `facts.json` is reserved for Cognitive Organs. Each Raft
  Input carries sender, place, visibility, audience, external refs and an
  explicit reply destination; the channel-use reminder is included only on
  the first Interaction of a Runtime Turn.
- Stable Channel Guidance describes Raft's place, visibility, evidence and
  judgment semantics; each current Input describes its actual actor, place,
  audience and available destinations; tool descriptions describe exact
  action effects. These layers do not duplicate one another. The existing
  `<human_input>` presentation must become actor-aware Interaction Context and
  may not imply that every direct sender is the principal human.
- Raft-specific guidance, tools and Orientation attention evidence are
  conditional on an explicitly enabled and successfully assembled Raft
  Integration. Disabled Raft contributes no empty section or unusable surface.
- Actor references distinguish `individual`, the configured principal
  `human`, `system` and namespaced Raft external members. A display label or
  handle cannot establish the principal-human mapping.
- Interaction Route chooses the Channel Adapter and connection boundary;
  Interaction Destination chooses the concrete DM, channel or reply thread
  inside that Route. A message Effect durably fixes both. The Adapter creates
  opaque destination refs; neither the model nor mutable Adapter state may
  reconstruct the destination at Delivery time.
- A proactive Turn with no current Interaction may use the explicitly bound
  principal relationship actor's top-level DM as the default Raft
  Destination. Other members, channels and threads require current evidence or
  a destination returned by a Raft tool.
- First activation fixes the inbound ownership boundary. Pre-activation Raft
  history remains available through read/search tools but is not replayed as
  Loom Inputs; post-activation activity remains Loom-owned ingress across Host
  downtime and restart.
- Inputs from different Raft audiences may enter one Main Agent Turn while
  remaining separately attributed and visibly scoped. The Agent Individual is
  one continuing subject across places; privacy and social judgment depend on
  explicit audience and Destination facts, not per-channel model isolation.
- The authenticated Raft member profile is a public projection, not an
  Identity source or synchronization target. Startup validates the configured
  self binding and shows the current public projection in Channel Guidance;
  profile mutation is a later explicit external action, never an automatic
  consequence of Workspace or Cognitive Organ changes.
- The first runnable surface includes text Interaction delivery, generic
  `message`, the bounded Attention Snapshot, and four read tools:
  `raft_places`, `raft_activity`, `raft_search`, and `raft_open`. All other
  Raft writes remain unavailable until real use establishes their need and
  their visibility, conflict and recovery behavior is designed.

These are design decisions, not a claim that the corresponding adapter or
prompt implementation already exists.

## Final Decisions

- The first version exposes no Raft attention or collaboration writes beyond generic text
  `message`; later candidates are evaluated from real behavior, beginning with `unfollow`, `mute`
  and task status.
- Ingress persists the content-free wake before exact `message resolve`, then commits normalized
  Input or ambient evidence before advancing its cursor. Delivery distinguishes `delivered`,
  `not_sent` and `unknown`; an unknown send does not auto-retry.
- A top-level DM/channel Input defaults to the same top-level place. A reply-thread Input defaults
  to its existing reply thread. The Individual may choose another Context-authorized Destination
  explicitly.

## Constraints

- Exact prompt wording remains an implementation review item, but it must preserve the confirmed
  three-layer split and judgment space in the final design.
- Do not expose raw credential-bearing Raft CLI access merely to avoid
  designing explicit tools.
- Do not collapse Raft reply threads, Loom private Threads or nmem Conversation
  Threads into one object.
- Do not implement multi-route delivery as hidden scope for the first pilot.

Ticket 04 owns implementation and real Raft acceptance. Until that acceptance passes, these design
decisions do not claim the Adapter or prompt behavior already exists.
