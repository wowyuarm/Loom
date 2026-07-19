# 09 - Correct Life Recorder Context and Grounding

Status: resolved
Type: cognitive organ

## Problem

The first Life Recorder implementation mixed immutable event attribution with natural names and relationship labels, preloaded broad Workspace material instead of giving the organ an annotated index, and tested prompt wording as though scripted model output proved behavior. That made the model Context less faithful to the established Cognitive Organ pattern and made tests depend on prose rather than the Recorder Interface.

## Confirmed Direction

- `facts.json` lives at the Agent Workspace root. It is a small required Stable Facts material for Cognitive Organs, alongside but distinct from Identity and Long-term Memory.
- Its only fixed structure is `version: 1` plus object sections named `individual` and `human`. Other fields and sections remain open so Cognitive Organs can represent names, forms of address, identities, relationship, places and languages without a rigid domain schema.
- Life Recorder receives the complete Stable Facts material in its system prompt. Stable Facts ground attribution and language but are not evidence that an event occurred and do not override an explicit correction in current evidence.
- Frozen Activity carries only immutable ordered evidence. Event attribution uses the fixed references `individual`, `human` and `system`; it does not repeat names, display labels or relationship descriptions.
- The first user message is an annotated run index: Activity identity and range, Transcript Anchors, event count, the current Daily path and the meaning of relevant Workspace paths. It does not preload Long-term Memory, old episodes, the current Daily or raw Activity events.
- Life Recorder keeps `read_activity` because complete evidence consumption must remain mechanically observable. It also receives Pi `read` and `ls` so it can follow the Workspace index. Daily and Episode writes still use the protected `write_daily` and `record_episode` tools.
- The prompt requires source-language fidelity and correct distinction between input, output, thinking, tool activity, Effect and Delivery. Scripted faux-provider tests do not claim to verify those model semantics.
- Daily remains natural narrative rather than a mechanically validated template. Chronological time sections are useful but optional; summary is optional; candidates appear only for explicit corrections, stable-fact candidates, meaningful changes or observations needed by a later Cognitive Organ.
- Life Recorder identifies stable-fact candidates from first-hand evidence but does not rewrite `facts.json`. Memory Reflector will reconcile evidence and maintain the authoritative file.

## Test Seams

- Life Recorder Interface: Stable Facts reach the system prompt, the user message contains an index rather than raw evidence, and only the agreed read and protected write tools are visible.
- Frozen Activity: unsupported attribution and incomplete evidence reads prevent a receipt; Episode citations cannot escape the Activity.
- Workspace writes: a failed run rolls back Daily and Episodes together, and a retried Activity keeps stable Episode identity.

Prompt phrases, output language and narrative quality are not unit-test seams. They are prompt responsibilities and may later be assessed through an actual model evaluation only when observed behavior makes that useful.

## Out of Scope

- Memory Reflector implementation and direct Stable Facts maintenance.
- Runtime Active Segment lifecycle and persistent recorder receipts.
- Workspace initialization templates.
- A shared framework for all Cognitive Organs.

## Result

- Agent Workspace now validates and loads root-level `facts.json` as the Recorder's complete Stable Facts material. The JSON contract fixes only `version: 1` and object sections `individual` and `human`.
- Life Recorder embeds Stable Facts in its system prompt and sends an annotated run index as the first user message. Identity, Long-term Memory, current Daily, old Episodes and raw Activity events are no longer preloaded.
- Frozen Activity no longer carries an actor registry. Every event uses one of the typed references `individual`, `human` or `system`; names and relationship terms come from Stable Facts.
- The Recorder tool surface is `read`, `ls`, `read_activity`, `write_daily` and `record_episode`. Complete Activity reads, protected writes, evidence citations, stable Episode identity and whole-run rollback remain mechanical contracts.
- The Life Recorder prompt now defines source-language fidelity, attribution and Delivery distinctions, loose Daily structure, optional summaries and candidates, and the boundary between first-hand recording and later reflection.
- Prompt phrase checks, source-project blacklists, duplicate rollback cases and dependency-level parameter checks were removed. The remaining tests cover only observable Context, evidence and persistence contracts.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test`: 58 tests passed
- `git diff --check`
