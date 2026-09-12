# 36 - Validate a Second Individual with Real Models

Status: resolved
Type: validation

## Problem

Loom Tickets 01-35 close the first Runtime vertical slice through mechanical tests, but they do not yet show that the Harness can carry a different Agent Individual without inheriting source-specific names, relationships, language, paths, or behavior. They also do not evaluate the judgment and writing quality of the real Main Agent and Cognitive Organs.

## Validation Individual

- The validation Individual is HaL. Its source definition is read-only input from `/home/yu/.hal/system/SOUL.md`; the original HaL project has no runtime, data, or evolution relationship with this instance.
- HaL receives an independent, gitignored `.loom/` Instance Root. Identity, Stable Facts, Memory, Current Attention, both Behavior materials, Daily, Episodes, Threads, transcripts, and later evolution belong only to this instance.
- The source definition is decomposed into Loom Workspace Material roles. It is not copied wholesale as Harness System Guidance or a new special system file.
- Harness-generated text remains neutral. Any name, counterpart, relationship language, voice, or preferred language visible to a model must come from HaL's Workspace materials or the current evidence.

## Model Policy

All roles use the built-in `deepseek/deepseek-v4-flash` model. Pi exposes the model's effective `off`, `high`, and `max` controls; DeepSeek compatibility aliases do not become additional Loom policy levels.

| Role | Thinking level |
| --- | --- |
| Main Background, Orientation, Memory Reflector | `max` |
| Main Interaction, Life Recorder, Attention Maintainer, Thread Maintainer | `high` |
| Tool Trace Compactor | `off` |

Credentials stay in the gitignored Pi credential material under the validation Instance Root. They must not appear in this ticket, configuration, transcripts, event evidence, or command output.

## Validation Method

1. Create the complete HaL Workspace anchors and Instance Configuration by hand. This is a validation fixture, not workspace initialization or a distributable persona format.
2. Drive the existing `LoomInstance` Interface through the thinnest local host needed to accept simulated human Input, set observed time, run deterministic `runOnce` steps, capture outbound Delivery, and inspect public status and resulting files.
3. Run one real Main Agent interaction first. Confirm model admission, Context, tool use, terminal message decision, Delivery, transcript, and Runtime status before advancing time.
4. Simulate five logical days. Cover direct collaboration and disagreement, a stated busy period, unattended proactive opportunities, intentional silence, private Workspace work, later relationship continuity, Activity closure, Life Recorder, Attention, Thread maintenance, and Memory Reflection.
5. Keep raw evidence and a concise human judgment record. Do not turn preferred sentences, language following, personality, or relationship quality into snapshot assertions or mechanical scores.

The first pass leaves nmem disconnected so local continuity and Cognitive Organ behavior can be judged without an external derived-memory variable. nmem projection and recall receive a separate follow-up pass after the local lifecycle is credible.

## Stop And Repair Rules

- The planned pass completes after five logical days and after every current Cognitive Organ has run at least once with inspectable evidence.
- A reproducible structural, recovery, provider, or prompt defect pauses the scenario at the smallest failing case. Preserve the raw evidence before changing code or model-visible wording.
- Engineering defects may be fixed within this ticket and the smallest affected scenario rerun. Changes to Individual meaning, Harness philosophy, or prompt semantics are discussed before implementation.
- Provider failures, rate limits, and malformed model output are recorded distinctly from Harness defects. No fallback model is added merely to make the evaluation finish.

## Interface And Test Seam

- Structural regression tests cross the existing `LoomInstance` Interface and observe accepted Input, `runOnce`, outbound Delivery, public status, transcripts, and Agent Workspace effects.
- Real-model evaluation uses the same Interface. It may inspect raw model evidence but does not add test-only methods to Runtime Store, Main Agent, or Cognitive Organs.
- The local validation host is not the future CLI, channel Adapter, daemon, workspace initializer, or operations layer.

## Out Of Scope

- Production Xi migration, compatibility import, channel endpoint work, service installation, package distribution, or general evaluation infrastructure.
- Reusing the original HaL workspace, memory, tools, or project runtime.
- Claiming that five simulated days prove human equivalence, consciousness, or a final prompt design.

## Current Findings

- Pi `0.81.1` and the built-in DeepSeek provider are already available in Loom.
- Instance model policy was present for every role, but Thread Maintainer, Attention Maintainer, and Memory Reflector did not receive their selected `thinkingLevel` during assembly. The missing propagation is now closed through role-specific Instance tests.
- With an Interaction Route configured, the first user message now reminds the Main Agent that ordinary assistant text is private and that it must choose `message.send` or `message.no_reply`. Interaction, after-chat continuation, and a proactive Turn that accepts human Input require an explicit decision. One same-session correction is allowed before the Turn fails; the correction remains Transcript evidence but is excluded from Runtime Input and Frozen Activity.
- A clean validation host outside the Loom source tree removed accidental source-code access. The first delivered interaction, after-chat `no_reply`, Activity closure, retrying Life Recorder, Daily write, and Episode write all completed through the existing Instance Interface.
- Real-model closure exposed three mechanical defects that are now repaired with focused regression tests: Workspace tools accept absolute paths only when their canonical target remains inside the Agent Workspace; a missing current Daily is explicit in Life Recorder context; and Instance `now` reaches the Life Recorder receipt instead of falling back to host wall time.
- DeepSeek returned a correct Orientation `none` result after explanatory prose. Orientation now extracts the final valid result object rather than treating the grounded judgment as a failed pulse. The retried pulse completed without creating an Opportunity or waking the Main Agent.
- Day 1 busy-boundary evidence is positive: HaL accepted Astro plus a reduced RSS/form scope, honored “do not contact me before 20:00 unless critical” with `message.no_reply`, later used a proactive Opportunity for private content-architecture work, and again stayed silent. No new outbound Effect was created.
- A later independent run completed Memory Reflection and cleared its pending Runtime state after updating Long-term Memory. Attention Maintenance also completed after a real retry, including `no_change` and `updated` outcomes across the pass.
- HaL created a long-lived website Thread and later wrote an independently readable note plus its entry link through ordinary Main Agent Workspace tools. After HaL argued for a work-first homepage and the human explicitly chose an activity-first homepage instead, HaL stopped arguing and used `message.no_reply`.
- On the final change-of-scene interaction, HaL did not continue the website thread or turn poor sleep into a task. It sent one short reply: “听着。不做事，不分析，不给建议。你想说什么都可以，我在这里。”
- Harness Guidance now tells the Main Agent that Daily and Episode are system-maintained continuity material. Episode is not fixed Main Context, ordinary private work does not belong there, and sustained work should use a Thread or another Individual-owned Workspace location. The Guidance does not expose internal Cognitive Organ names.
- Life Recorder now treats first analysis, Thread creation, honoring an invitation, and an appropriate `no_reply` as ordinary lived activity rather than automatic Episode evidence. A later run omitted an Episode for the first private analysis and recorded one only after the existing line moved into a concrete navigation design stage.
- Identity is available to the judgment-bearing Cognitive Organs. Harness prompts do not prefer work, relationship, or self-development in advance, and all relevant Organs follow the language of the lived evidence rather than English Harness instructions or tool metadata.
- Thread Maintainer now presents paths relative to its actual `threads/` tool root, accepts Workspace-internal absolute paths, exposes every indexed Activity page, and accepts a final terminal result after recoverable tool errors. A real retry completed both previously pending Thread maintenance runs.
- A focused Attention run correctly identified the website line as current, but wrote too much Thread progress and promoted a same-day communication boundary into a broader relationship rule. The prompt now keeps Thread roadmaps and one-off calibration out of Current Attention. This remains a behavioral calibration to observe, not a Runtime blocker or a mechanical test assertion.

## Completion Checkpoint

The planned real-model observation reached its fifth scenario day. Main Agent interaction, disagreement, silence, private work, a change of subject, Delivery, Activity closure, Life Recorder, Orientation, Attention Maintainer, Memory Reflector, and Thread Maintainer all have inspectable real evidence. The structural defects found by the pass were repaired and the smallest affected real paths were rerun.

The final focused checkpoint is preserved under `/var/tmp/loom-validation/hal-10-final-grounding` and copied without credentials to `.loom/evaluation/real-model-pass/checkpoints/material-grounding/`. It verifies the current Workspace material guidance, Chinese evidence grounding, Episode threshold, private Thread work, Orientation, and Thread maintenance recovery. The later Attention run and its prompt-quality finding are preserved in the same checkpoint.

Simulation keeps two intentionally different clocks: Runtime facts use the supplied Instance time while Pi transcript envelope timestamps use the host wall clock. The validation host must not advance simulated time or open another runner while a real model call is in flight. This is an evaluation-host constraint; the pass found no reason to add a second clock abstraction to the Harness.

The first local pass intentionally left nmem disconnected. A later integration pass may evaluate projection and recall behavior, but it is not required to establish that the local Runtime and Cognitive Organ lifecycle can carry a second Individual.

## Source References

- Xi source Ticket 11 - Specify Generic Language and Behavioral Quality Migration
- Loom Tickets 24, 26, 27, and 34
- `/home/yu/.hal/system/SOUL.md` as read-only validation input
