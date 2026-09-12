# 10 - Define Replayable Episodes and the Life Recorder Method

Status: resolved
Type: cognitive organ

## Problem

Life Recorder had the right evidence and write boundaries, but its prompt reduced Daily candidates and Episodes to short labels. It did not teach the Cognitive Organ how to recognize a changed scene, preserve it as a replay rather than a summary, distinguish interaction from autonomous activity, or assign importance. The glossary also described Episode mainly through future external-memory import, which made a Workspace-native record appear dependent on an Integration.

## Confirmed Direction

- Episode is an Agent Workspace-native memory replay for the Agent Individual's future continuity. An external memory Integration may later consume it, but neither Episode creation nor meaning depends on that Integration.
- The deciding question is whether something concretely changed. Calibration, relational change, self-discovery, growth, a meaningful limit, a jointly formed decision, and consequential autonomous exploration may warrant an Episode.
- Routine greetings, ordinary tool outcomes, inconsequential thinking and repeated scenes without change do not warrant an Episode.
- A scene preserves chronology, decisive actions, supported tone and important exact words. It says what happened, not what the event demonstrates or what long-term pattern it belongs to.
- Interaction scenes preserve attribution and Delivery distinctions. Autonomous scenes preserve the motivating evidence, actual exploration or work, and the resulting change in understanding, direction or action without inventing reasons for silence.
- Importance guides selection rather than mechanical validation: `0.85+` is defining, `0.70-0.84` clearly changes understanding or behavior, `0.50-0.69` is narrower but worth replaying, and lower scenes are omitted.
- Daily candidates remain concise evidence leads for later Cognitive Organs. Their labels are `fact`, `calibration`, `self-discovery`, `growth`, `attention`, `limit`, `observation` and `structural`; no count is required.
- Prompt language remains English, while every record follows the language of its actual evidence and preserves quotations without translation.

## Prompt Design

- System prompt owns the Recorder's role, evidence discipline, working method, Daily/Episode distinction, selection judgment, quality bar and examples.
- Stable Facts are appended to the system prompt for attribution, natural names and language grounding.
- The first user message remains a run-specific index. It identifies the Frozen Activity and relevant Workspace entry points without preloading evidence or long-term material.
- Tool descriptions state the concrete write effect and field meaning. Protected tools enforce evidence and persistence contracts, not narrative quality.
- Source examples are evidence about a useful teaching method, not text to copy. Loom keeps their contrast between replay and summary while replacing source-specific people, paths, time policy and Integration assumptions.

## Test Seam

No new model-quality unit test is added. Existing Life Recorder Interface tests remain responsible for observable Context, the visible tool surface, complete Activity reads, evidence-bound Episode writes, stable Episode identity and whole-run rollback. Language choice, scene quality and selection judgment require actual-model evaluation only when there is a concrete behavior to assess.

## Out of Scope

- Runtime ownership of Active Segment closure, durable Frozen Activity, persistent Life Recorder Receipt and retry.
- Constraining Pi `read` and `ls` to the Agent Workspace.
- External memory import or nmem-specific Episode fields.
- Memory Reflector maintenance of Stable Facts or Daily candidates.

## Result

- Life Recorder now has a complete, generic working method derived from the useful distinctions in the source implementation.
- Daily candidate labels and boundaries are explicit without imposing a rigid Daily template or count.
- Episode is defined and prompted as a Workspace-native replayable scene, with separate interaction and autonomous-activity guidance, selection exclusions, importance bands and fictional examples.
- `record_episode` documents the meaning of every model-authored field while preserving the existing protected write contract.
- Loom's collaboration rules now explain how Cognitive Organ prompts are adapted and how their semantic quality differs from mechanical tests.
- The next Runtime slice retains a failed run's Frozen Activity as pending and retries it without a Receipt; this ticket records that boundary but does not implement the lifecycle.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test`
- `git diff --check`
