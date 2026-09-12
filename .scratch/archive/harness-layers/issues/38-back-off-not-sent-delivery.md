# 38 - Back Off a Confirmed Not-sent Delivery

Status: resolved
Type: Runtime lifecycle

## Problem

Runtime correctly keeps a confirmed `not_sent` Effect separate from its originating Input, but Scheduler currently requests another attempt at the same instant. A continuously driven Instance can therefore retry a failed channel without delay. The retry time also has no durable representation across restart.

This ticket closes the existing Delivery lifecycle before the first real channel is connected. It does not add a channel, generic job system, manual reconciliation UI, or provider-specific error taxonomy.

## Confirmed Behavior

- A confirmed `not_sent` Delivery keeps the same Effect pending and schedules a future attempt with bounded exponential backoff.
- The next attempt time is a Runtime Store fact and survives restart.
- New Input and other Runtime work may continue while Delivery waits.
- `unknown` remains stopped for explicit reconciliation and is never converted into an automatic retry.
- Every actual retry remains a distinct Delivery attempt with its own idempotency key.

## Test Seam

- `Scheduler.runOnce(...)` exposes the future retry time after `not_sent`.
- Reopening Runtime before that time does not call `OutboundDelivery`; running at or after it does.
- Tests observe Runtime and Scheduler Interfaces, not SQLite rows.

## Out of Scope

- Weixin response classification;
- route-specific retry intervals;
- abandoning or manually reconciling an Effect;
- hot configuration reload.

## Result

- Runtime Store now persists `nextDeliveryAt` for each pending Effect after a confirmed `not_sent` Delivery.
- A retry waits one minute, then doubles on each further confirmed failure up to one hour; a retry keeps the Effect and creates a new Delivery attempt with a new idempotency key.
- Scheduler derives its wake time from persisted Delivery state and combines it with other waiting lifecycle work, so restart does not turn a delayed retry into immediate polling.
- `unknown` remains reconciliation-required and never receives a retry time.
- Runtime Store schema v12 upgrades in place; the existing v11 upgrade chain remains valid when it reaches the new schema.

Validation:

- `npm run typecheck`
- `npm test` (232 tests passed)
- `npm run build`
- `git diff --check`
