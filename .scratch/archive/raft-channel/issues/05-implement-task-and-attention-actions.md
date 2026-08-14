# 05 - Implement Raft Task and Attention Actions

Status: resolved
Type: implementation
Blocked by: none

## Goal

Let an enabled Raft-backed Individual manage one existing external task and its own Raft attention
through model-visible tools, while preserving Loom's durable Effect boundary and opaque Raft refs.

The model-visible additions are exactly:

```text
raft_task({ action: "claim", taskRef })
raft_task({ action: "unclaim", taskRef })
raft_task({ action: "update", taskRef, status })

raft_attention({ action: "unfollow_thread", placeRef, reason? })
raft_attention({ action: "mute_channel", placeRef })
raft_attention({ action: "unmute_channel", placeRef })
```

Existing `raft_activity` remains the bounded source of task signals and `raft_open` gains task
detail reading. Each write invocation prepares exactly one durable Effect. Delivery resolves the
opaque ref inside the Raft Adapter and never exposes or reconstructs raw CLI targets in model code.

## Behavior

- Task work follows `todo -> claim -> in_progress -> in_review -> explicit acceptance -> done`.
  The claiming Individual reports progress in the task thread and explains before unclaiming.
- A task is an external public commitment and attention signal, not a Loom scheduler item or an
  instruction that must be obeyed.
- `unfollow_thread` accepts only a reply-thread place ref. It does not delete history, invalidate
  the ref, or happen automatically after `raft_open`, task completion, or Loom Thread closure.
- `mute_channel` and `unmute_channel` accept only a regular channel place ref. They do not change
  membership or delete thread follow records.
- Personal mentions may still pierce unfollow or mute according to Raft behavior. Sending into a
  thread may follow it again.
- Confirmed success is delivered, a confirmed refusal or conflict is not sent, and an outcome the
  Adapter cannot confirm is unknown and is never blindly retried.

## Interface And Test Seams

The Channel Agent Surface provides per-Turn tool factories with only the capability to prepare one
Effect. This lets channel action tools create durable Effects without giving the Raft Channel
Runtime ownership or introducing a generic action registry.

Tests cross only the already accepted public Interfaces:

1. **Main Agent public Interface**: a model tool call prepares one Effect with the configured Raft
   route and the opaque ref in its payload.
2. **Raft Channel public Interface**: Delivery validates the Effect, resolves the ref, invokes one
   remote action and classifies the observable result.
3. **Pinned Raft CLI Adapter Interface**: task detail and task/attention commands match the pinned
   CLI's actual output and error forms.
4. **Host public Interface**: enabled Raft exposes the two new tools; disabled Raft does not.

Tests do not inspect private SQLite state, assert exact prompt strings, or use a fake provider to
claim judgment quality. Implementation proceeds as vertical TDD slices.

## Non-goals

- Creating tasks, reminders, reactions, attachments, profile or membership writes.
- Deeper or unrestricted history.
- Raft-specific `loom status` fields or a generic Integration action/plugin registry.
- Automatic task claiming, automatic attention changes, or a Loom-internal task scheduler.

## Acceptance

- Focused tests, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check` pass.
- The ticket, map and Raft Integration docs describe only implemented behavior.
- One coherent commit is deployed to HaL's Raft-only Instance after confirming no active Turn.
- HaL completes a real existing-task claim/progress/review/acceptance/done flow, unfollows a real
  reply thread, and mutes then unmutes a real regular channel.

## Current Evidence

Implementation, deployment and real-use acceptance are complete:

- Main Agent creates the enabled Channel's six Raft tools per Turn and gives them only Effect
  preparation, while Orientation receives the same declared tool names.
- `raft_activity` and direct task Inputs expose opaque task refs; `raft_open` returns current task
  detail; `raft_task` prepares and delivers claim, unclaim and status-update Effects.
- `raft_attention` validates reply-thread versus regular-channel refs before Effect creation, then
  delivers unfollow, mute and unmute through the pinned CLI.
- Pinned CLI and public Channel tests distinguish confirmed success, confirmed rejection and
  unknown outcomes; unknown remains on Runtime's existing reconciliation path.
- `npm run typecheck`, all 319 tests, `npm run build`, and `git diff --check` passed locally.
- Commit `b2c9925` was deployed to HaL's Raft-only Instance as
  `0.0.0+gb2c9925c11d7`; the Host reported Raft connected with clear queues.
- In real task #2, HaL opened and claimed the task, reported progress, moved it to `in_review`,
  unfollowed a completed reply thread, and muted then unmuted `#all`. YuCreate accepted the result
  and moved the task to `done`.

The pinned Raft CLI has no read operation for one reply thread's current follow state:
`thread` exposes only `unfollow`, `channel info` rejects thread targets, and `channel members`
reports access/post authority rather than followers. Consequently `raft_open` does not claim a
`follow` field. Adding that field is blocked until Raft exposes an authoritative single-thread
follow query; Loom must not infer remote state from its last Effect because mentions or later posts
can follow the thread again outside that Effect.
