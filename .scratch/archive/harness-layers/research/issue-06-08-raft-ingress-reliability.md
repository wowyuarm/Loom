# Raft ingress reliability contract for issues #6 and #8

Status: proposed contract, 2026-08-07

## Conclusion

Issues #6 and #8 are one ingress reliability problem with two independent failure modes:

1. Raft server inbox eligibility can omit or delay a DM reply-thread message, so Loom has no message to pull.
2. Loom can receive a wake but fail while resolving it; the current global FIFO then blocks every later wake.

The final fix therefore needs both Raft and Loom changes. Relaxing the current text parser is not a final fix.

## Confirmed current state

- Loom already runs `raft message check` on startup and wake, persists a local spool, resolves canonical targets, and deduplicates aliases (`5924253`, `bcfa73a`, `5944609`).
- If a message is absent from the Raft inbox, Loom cannot recover it locally.
- Raft CLI `0.0.17` exposes only human-readable `message resolve`; it has no structured-output option.
- Loom parses the rendered sender/profile description to recover content. A later profile-description change therefore broke an old wake.
- `wakes` has only `pending | complete`. Any resolve or Runtime admission error leaves the oldest item pending and stops the drain loop.

## Raft contract

Raft must expose stable machine-readable output for both inbox enumeration and message resolution.

### `message check --json`

Each entry must contain, as separate fields:

- durable inbox receipt id;
- complete message id;
- canonical target;
- received timestamp.

The command must not require Loom to parse prose, short ids, profile descriptions, or separators. A DM reply-thread message that is eligible because of a mention/follow/task rule must enter the inbox independently of a later top-level DM or wake.

### `message resolve --json <message-id>`

The result must contain, as separate fields:

- complete message id and canonical target;
- occurred timestamp;
- sender member id, stable name, kind, and optional display fields;
- raw message content;
- task metadata when present.

Historical content and sender identity must not be reconstructed from the sender's current profile description. Human-readable output may continue for people, but it is not a machine contract.

## Loom contract

### Durable wake states

Extend the existing Raft state; do not create another queue or recovery authority.

```text
pending -> complete
pending -> retry_wait -> pending
pending -> failed
failed  -> pending        (explicit retry)
```

Persist attempt count, last-attempt time, next-retry time, failure category, and bounded error summary. The wake's local delivery order remains its operator-visible item id; raw target and content stay out of status.

### Failure handling

- Unsupported or invalid structured message data is a permanent item failure: mark `failed`, continue draining later wakes.
- CLI unavailable, timeout, connection failure, rate limit, and server 5xx are retryable: persist `retry_wait`, continue draining later wakes, and retry with bounded backoff.
- Runtime admission is retried only when the Runtime reports a shared/transient blocker. An explicit invalid Input is `failed`.
- Duplicate Runtime admission remains safe through the existing `source + sourceId` identity.
- A failed or delayed earlier wake never globally blocks a later independent DM, mention, or task. This deliberately chooses availability over global FIFO; the failed item remains visible and recoverable.

### Retry and status

- Add an operator action that moves one failed local wake item, or all failed items, back to `pending` without restarting the Host.
- Channel-neutral Host status exposes ingress pending count, retry-wait count, failed count, oldest outstanding time, and last failure category.
- Detailed Raft diagnostics may expose the local delivery-order item id and timestamps, but not message content, raw targets, credentials, or the full error string.

The Host must not reproduce the Raft state machine. Raft owns its wake transitions; the Host only forwards a small status view and an explicit recovery request.

## Implementation order

1. Raft server/CLI adds and tests both JSON contracts and fixes DM reply-thread inbox eligibility.
2. Loom replaces prose parsing with the structured contract.
3. Loom migrates `wakes`, isolates failures, continues the drain, and exposes status/retry.
4. Deploy once and run the combined acceptance matrix.

Loom can prepare fakes and state-machine tests before step 1, but production integration cannot finish against CLI `0.0.17`.

## Acceptance

1. Change a sender profile description after an old message was sent; old and new messages both resolve with the original content.
2. Inject one permanently invalid wake, then a valid DM; the DM becomes a Runtime Input while the invalid item remains failed and visible.
3. Explicitly retry the failed item after fixing the resolver; it completes without Host restart and without duplicating the later DM Input.
4. Send three mentioned DM reply-thread messages; each appears in the authoritative inbox and reaches Loom within the next check cycle (at most 2-3 minutes), without a top-level DM trigger.
5. Restart with pending, retry-wait, and failed items; each state and retry deadline is preserved.
6. Status shows counts, oldest age, and failure category while Runtime has no pending Input, so ingress failure cannot appear healthy.
7. Typecheck and the complete Loom and Raft test suites pass.

## External authority required

The current workspace contains only Loom. The installed Raft CLI has no JSON `message check` or `message resolve` option. Step 1 requires access and authorization for the Raft server/CLI codebase, or a named Raft owner who will deliver the contract. Loom-only work cannot close the combined task.
