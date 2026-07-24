# 40 - Define Attachment and Media Semantics

Status: resolved
Type: Main Agent + Integration

## Problem

The first Weixin route deliberately closes text only. Adding images, voice, files, video, or quoted media would otherwise force Weixin wire fields directly into Runtime Input and the Main Agent message tool. Loom first needs one channel-neutral attachment contract that preserves durable evidence and lets each model receive only representations it can actually use.

This ticket begins with semantics and one end-to-end attachment slice. It does not authorize copying Xi's media directory, ASR provider, retention policy, or Weixin payload types.

## Already Determined

- Runtime still accepts one durable Input identity; attachments are content carried by that Input, not extra Inputs and not channel-owned turns.
- Channel Adapter owns remote download/upload, integrity checks, protocol metadata, and remote errors. Runtime owns Input/Effect/Delivery recovery; Main Agent owns whether and how to respond.
- The Harness contract must describe an attachment by meaning needed across channels, never by Weixin `item_list`, CDN encryption fields, or provider-specific message types.
- Raw bytes and credentials are not stored in Runtime Store, Primary Transcript JSON, Stable Facts, Daily, Episode, or nmem projection by default. Those surfaces retain bounded references and derived evidence appropriate to their role.
- An attachment must be durably available before inbound cursor advancement. A remote metadata record without the promised local content cannot be treated as accepted unless the contract explicitly represents an unavailable attachment.
- Outbound media remains an Effect followed by Delivery. Upload or send failure never replays the originating Input or model Turn.
- Text-only behavior remains valid when attachment support is absent, a selected model cannot consume a representation, or a remote attachment is unsupported.

## Confirmed Decisions

### 1. Durable Content Location

Raw content lives in an Integration-owned durable Attachment Store under the Instance Root, outside the Agent Workspace. Main Agent receives a bounded attachment tool and may deliberately copy content worth keeping into the Workspace. Channel traffic therefore does not silently mutate Individual-owned files, while Input acceptance and restart recovery do not depend on temporary storage.

### 2. Model-visible Representation

An image enters the Pi user message as native image content only when the selected model explicitly declares image input support. Otherwise Main Agent receives bounded metadata, a stable reference, and an honest statement that image content was not shown to this model. Loom does not ask another model to inspect it automatically.

The same generic reference can later represent other attachment kinds, but voice transcription, document parsing and video understanding remain outside this slice. Unsupported or unavailable content is never replaced by invented text.

### 3. Outbound Authoring

Main Agent may nominate an existing file inside the Agent Workspace. Before `message.send` accepts the Effect, Loom snapshots the bytes into the Attachment Store and places only the immutable reference and bounded metadata in the Effect. Later Workspace edits cannot change an already accepted Delivery.

### 4. Retention and Evidence

This slice accepts one inbound image and one outbound attachment per message. Raw content remains available while an active Input or Effect references it and for 30 days after the last such reference ends. Activity and other durable evidence retain bounded metadata after content deletion. Content the Individual wants permanently belongs in the Agent Workspace.

Per-channel size and protocol limits remain Adapter concerns. The generic Attachment Store validates declared size and digest but does not encode Weixin limits into the Harness contract.

## First Slice

Implement one inbound image and one outbound existing-file attachment through the same generic contract. Defer voice/ASR, general document parsing, video, quoted-message reconstruction, typing, multi-attachment authoring and general retention scheduling until the durable content and representation paths have been exercised end to end.

Implementation order:

1. A public Attachment Store Interface persists immutable content-addressed bytes and can copy them into the Agent Workspace.
2. Generic attachment metadata enters Runtime Input/Effect and Activity without embedding bytes.
3. Main Agent receives native Pi image content only for models declaring image input support, plus a bounded attachment tool and outbound Workspace snapshot semantics.
4. Weixin downloads an inbound image before `acceptInput`, uploads an outbound snapshot during Delivery, and advances its cursor only after durable acceptance.

## Test Seam

- Adapter tests prove download/upload classification and that cursor advancement follows durable attachment acceptance.
- Runtime/Main Agent tests observe the generic Input, model-visible representation, Effect snapshot, and Activity evidence through public Interfaces.
- Real-model evaluation checks whether supported and unsupported attachments are understood and described honestly; faux-provider tests do not claim semantic understanding.

## Resolution

- A content-addressed Attachment Store under `runtime/integrations/attachments/` owns immutable bytes, Workspace copy/snapshot actions, integrity checks and 30-day unreferenced retention. Host and Instance share one live Store so inbound writes and cleanup cannot race.
- Runtime Input, Effect, Activity and Transcript surfaces retain only validated Attachment references and bounded metadata. Native image blocks exist only in the current model call; persisted Transcript, Context state and ordinary tool activity omit pixels.
- Main Agent receives `attachment.copy_to_workspace`; `message.send` accepts one optional Agent Workspace path and snapshots it before Effect acceptance. Orientation sees the same real action space.
- Weixin persists one inbound image before Input acceptance/cursor advancement and uploads one outbound snapshot during Delivery. A caption delivered before attachment failure produces `unknown`, preserving Runtime reconciliation rather than replaying text.
- Retention reconciliation treats pending/active Inputs and pending/reconciliation-required Effects as active references. The timer begins only after the last such reference ends; durable metadata remains after bytes are removed.

Validated with the full TypeScript build and 256 tests, including store reopen/integrity, model capability representation, Workspace confinement, immutable outbound snapshot, bounded inbound decrypt, outbound encrypt/upload, partial Delivery, retention and raw-byte exclusion.

## Source References

- Loom Tickets 02, 13, 23, 27, and 39
- Loom `docs/integrations/weixin.md`
- Xi `docs/channels.md`, `src/channels/weixin-media.ts`, and observed media failure handling
