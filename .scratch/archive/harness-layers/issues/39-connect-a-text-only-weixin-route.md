# 39 - Connect a Text-only Weixin Route

Status: resolved
Type: Integration

## Problem

Loom has a foreground Host, a single default Interaction Route, and a durable `OutboundDelivery` lifecycle, but no real channel owns either side of that route. The first Weixin Integration must connect inbound and outbound without moving Runtime recovery, Individual relationship material, or model execution into the Adapter.

This ticket closes one configured Weixin account and one counterpart as a text-only route. It does not establish a channel plugin registry or the eventual attachment/media contract.

## Confirmed Interface

- Presence of both `configuration/integrations/weixin/config.json` and `auth.json` enables the Integration; absence of both leaves the Host channel-free. A partial pair, invalid document, route mismatch, or missing required value prevents the Host from opening.
- `config.json` contains versioned non-secret connection material: one `routeRef`, one `peerId`, and an optional `baseUrl`. `auth.json` contains only the versioned token.
- Dynamic cursor, peer context token, last successful poll, and last remote error live in `runtime/integrations/weixin.db`, outside the Agent Workspace.
- The Adapter accepts only completed text messages from the configured peer. It calls Host ingress with stable `source: "weixin"` and a remote message identity, then advances the Weixin cursor only after Runtime reports the Input accepted or duplicate.
- The Adapter implements the existing `OutboundDelivery` Interface. It accepts only a text `message` Effect on its configured route and sends the Runtime attempt `idempotencyKey` as Weixin `client_id`.
- A successful Weixin API result becomes `delivered`. An explicit API rejection becomes `not_sent`. Timeout, transport failure, malformed response, or an HTTP result that does not prove non-delivery becomes `unknown`.
- Remote polling failure makes the channel `degraded` and retries with bounded delay; it does not stop the Host, Process Driver, or private Runtime activity. Local configuration errors remain opening failures.
- Host start and graceful stop own channel start/abort/close. Host status keeps channel state distinct from Host, Driver, Instance, and model state.

## State and Recovery

- Cursor persistence is atomic with the Adapter's local state update, but Runtime Input durability is the acceptance gate.
- Redelivered messages before cursor advancement are harmless because Runtime deduplicates `(source, sourceId)`.
- Context token is updated only from an accepted or duplicate message from the configured peer and is reused for outbound text.
- A session-expired API rejection may clear the stored context token and retry once inside the same Delivery attempt, using the same `client_id`; any later retry remains Runtime-owned.

## Test Seam

- Weixin Adapter lifecycle, normalized Input, durable cursor, context token, delivery classification, and `client_id` are observed through its public Interface with a fake remote transport.
- Host configuration, lifecycle, ingress, degraded status, and graceful channel stop are observed through `openLoomHost(...)`.
- Tests do not inspect Runtime Store or Weixin SQLite rows.

## Out of Scope

- images, voice, files, video, quoted-media extraction, upload, download, ASR, or media retention;
- typing indicators, Markdown filtering, send throttling, QR login, pairing, or token acquisition;
- multiple accounts, multiple peers, multiple routes, route registry, plugin discovery, or hot reload;
- manual Delivery reconciliation UI or assumptions that Weixin `client_id` makes an unknown send safe to retry;
- `loom init`, service installation, or OS supervisor integration.

## Source References

- Loom Tickets 13, 27, 34, 37, and 38
- Xi source Ticket 07
- Xi `docs/channels.md` and `src/channels/weixin-*.ts`
- Xi research `10-openclaw-hermes-host-channel-and-operations.md`

## Result

- Added a text-only Weixin Integration with strict split configuration/auth files and a private SQLite state store for cursor, peer context, poll health, and remote errors.
- Normalized only completed text messages from the configured peer into Runtime Input; cursor advancement now follows accepted or duplicate Runtime durability, while redelivery remains Runtime-deduplicated.
- Implemented the real Weixin iLink HTTP calls for lifecycle, long polling, and text send. Runtime Delivery idempotency becomes `client_id`; explicit API rejection, unknown transport result, and one same-attempt retry without an expired context token remain distinct.
- Wired optional Weixin opening, inbound ingress, outbound Delivery, degraded status, and graceful stop into the foreground Host. Missing configuration keeps the Host channel-free; incomplete or mismatched local configuration prevents opening.
- Added the stable operator-facing file contract in `docs/integrations/weixin.md`; media and attachment semantics remain outside this ticket.

Validation:

- `npm run typecheck`
- `npm test` (241 tests passed)
- `npm run build`
- `git diff --check`
