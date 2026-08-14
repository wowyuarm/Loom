# 01 - Assess Raft as a Loom Integration

Status: resolved
Type: research

## Question

Can Raft provide a useful Interaction Channel Integration
for a Loom Agent Individual, humans and other agents while preserving Loom's
ownership of the Individual's continuity, private workspace and durable runtime
facts?

## Evidence To Reconcile

- One concrete Individual has explored the External Agent path. That experience
  is input evidence only; the resulting Channel design must remain independent
  of any Individual's Identity, Workspace or relationship.
- Loom currently has Local and Weixin Integration seams, a single default
  interaction route, durable Input and Effect/Delivery contracts, and no
  generic multi-route or plugin framework.
- Raft is to be assessed as the same class of Integration as Local and Weixin,
  not as a control plane or a second agent runtime. The first pilot may replace
  Local with Raft for one Instance; coexistence and fan-out are out of scope.
- Raft's current documentation and source-owned interfaces must be checked
  directly, especially External Agents, bridge/wake behavior, workspace,
  messages, tasks, reminders, identity and server/data ownership.

## Deliverable

Write one cited research note that separates confirmed facts from one
Individual's exploratory interpretation, maps the concrete compatibility
boundaries, and ends with the small set of decisions required before any server
or Integration pilot.

## Constraints

- Do not quote or copy any Individual's private conversation content into this
  ticket or the research note.
- Do not create a Raft account, server, profile, token, External Agent or Loom
  code change.
- Treat Raft as an external collaboration system. Loom remains the source of
  truth for its own Runtime Instance and Agent Workspace.

## Result

Primary-source findings are in
[raft-primary-sources.md](../research/raft-primary-sources.md). Raft is accepted as a generic
Interaction Channel in the same class as Local and Weixin. Loom keeps ownership of the Individual,
Workspace, Runtime, Transcript, memory and recovery; Raft's reply thread, Loom private `Thread` and
nmem Conversation Thread remain distinct.

The first runnable scope, privacy model, Context semantics, ingress recovery and Delivery behavior
are fixed by the final [Raft Interaction Channel design](../design/raft-individual-interaction-model.md).
Real CLI and server acceptance remain implementation evidence under Ticket 04, not unanswered
product positioning.
