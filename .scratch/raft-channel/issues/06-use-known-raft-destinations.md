# 06 - Use Known Raft Destinations

Status: resolved
Type: implementation
Blocked by: none
GitHub: issue #1

## Goal

Let a Raft-backed Individual deliberately send to a small set of previously known Raft places,
without exposing raw targets or making every historical place part of the current conversation.

Each Raft Interaction Context keeps its current place as the sole default Destination and adds at
most seven other recently observed Destinations. A Destination becomes known when Loom accepts an
Input from that place; the Adapter persists its opaque ref, kind, label and last-observed time.
The Main Agent may select one of those refs explicitly through the existing `message` tool.

For a top-level channel Input, the Input message's reply thread is also an available non-default
Destination. This keeps task progress and other message-scoped conversation in the thread the
guidance already requires, rather than telling the Individual to use a place absent from Context.

## Behavior

- The current Input place is always present and remains `defaultDestinationRef`.
- Up to seven other known places are ordered by most recent observation. Repeated Inputs refresh a
  place instead of creating another Destination.
- Known places survive Host restart. Existing opaque Destination refs are retained during the
  storage migration. Raw Raft targets remain inside the Adapter.
- A valid top-level channel message exposes its reply thread as an optional Destination while the
  top-level channel remains the sole default. The model does not construct the thread target.
- A Turn with only one current Interaction place may omit `destination_ref` and still reply there;
  known alternatives do not remove that default. If distinct current Interaction places enter the
  same Turn, the Main Agent must still choose explicitly.
- This ticket does not discover members or create a first DM with a member the Individual has never
  encountered. It closes deliberate reuse of known places only.

## Public Test Seams

1. **Raft Channel Interface**: after accepting Inputs from two places, a later Input exposes its
   current default plus the previously known opaque Destination, including across restart. A
   top-level task Input also exposes its own opaque reply-thread Destination.
2. **Main Agent Interface**: one current Interaction with known alternatives replies to its default
   when omitted and can explicitly prepare a message Effect for a known alternative; two distinct
   current Interaction places still require an explicit choice.
3. **Real Instance acceptance**: HaL receives a human request in DM and deliberately reports to one
   previously known shared channel without human forwarding.

## Non-goals

- Member directory, member discovery or first-contact DM creation.
- Unbounded Destination history, raw target exposure or automatic cross-place forwarding.
- A generic routing registry outside the enabled Interaction Channel.

## Acceptance

- Focused tests, `npm run typecheck`, `npm test`, `npm run build` and `git diff --check` pass.
- One coherent commit is deployed to HaL after confirming no active Turn.
- HaL completes the real cross-place send and reports the actual destination and result.

## Current Evidence

- Commit `4ae81e1` passed typecheck, build, `git diff --check` and all 325 tests, then deployed to
  HaL as `0.0.0+g4ae81e19aa36` with Raft connected and clear Runtime queues.
- Real task #3 entered as a top-level `#Loom-Main` Input. HaL opened and claimed it, then reported
  only in the task reply thread, proving the optional thread Destination was available.
- YuCreate then sent HaL a DM request. HaL explicitly selected the previously known top-level
  `#Loom-Main` Destination, posted the requested result there instead of replying in DM, reported
  the actual destination, moved the task to `in_review`, and marked it `done` after acceptance.
- GitHub issue #1 is closed. First-contact member discovery remains an explicit non-goal rather
  than an unverified part of this acceptance.
