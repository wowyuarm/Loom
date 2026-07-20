# 15 - Calibrate Orientation Framing

Status: completed
Type: Cognitive Organ prompt calibration

## Problem

Ticket 14 completed the mechanical `Orientation -> Opportunity -> Main Agent` lifecycle, but its first Orientation prompt described the role too generally. Saying that the Main Agent keeps judgment did not explain that the evidence belongs to the Agent Individual, or why Orientation must trust the Main Agent to inspect and interpret that evidence again from a fuller individual perspective.

Long-running source evidence showed a concrete failure mode: an Orientation agent can read memory and private work, complete a cross-domain interpretation itself, and leave the Main Agent with only repetition or silence. The problem is not exploration itself. It is unclear material ownership and an unclear stopping point.

## Confirmed Semantics

- Stable Facts, Identity, Memory, Behavior, Current Attention, Daily Narratives, Episodes, private work and Frozen Activity belong to the Agent Individual's life. Orientation reads them temporarily; they do not become its own memory, interest or relationship.
- Skills and tools are action space available to the Individual, not capabilities for Orientation to exercise on its behalf.
- Orientation carries forward enough facts and preceding context for the Main Agent to recognize a scene. It may point to a possible connection, but does not decide what the evidence means, complete the connection or prescribe the next action.
- The Main Agent receives the narrative alongside the Individual's own materials and recent evidence, and has its own Workspace and action access. Orientation should trust that later judgment without reducing its output to an unexplained name or path.
- Relationship care is a complete possible opening, not a fallback used only when no project is available. It must still be grounded in an actual relationship fact or interaction.
- A grounded `none` remains valid after actual exploration. Loom does not inherit a source-specific rule that every run must manufacture a direction.
- `<proactive_opportunity>` remains a model-visible Input contract. Orientation run details, `whyNow`, evidence, scheduling and audit material remain outside the Main Agent Context.

## Prompt Shape

The versioned system prompt now separates four concerns:

1. role and material ownership;
2. grounded exploration and possible sources of traction;
3. narrative quality and the fact/judgment stopping point;
4. structured output and audit-only fields.

Generic positive and negative examples demonstrate the stopping point without encoding one Individual's names, relationship, projects, paths, channel or timezone. The prompt remains in English while all output fields follow the predominant language of the evidence.

## Validation Boundary

- Existing faux-provider coverage verifies the isolated Context, Stable Facts, tool surface, evidence reading and structured result contract.
- Prompt text is not tested with string assertions. Narrative quality, language following, relationship judgment and resistance to over-analysis require later real-model evaluation.

## Validation

- `npm run typecheck`
- `npm run build`
- `npm test`
- `git diff --check`
