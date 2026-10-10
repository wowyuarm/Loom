/**
 * The skills an individual wakes up with, seeded into its own `skills/` directory once and then
 * left alone.
 *
 * Seeding rather than shipping is the point. A skill bundled with Loom is read-only to the agent
 * and would shadow a same-named one of its own forever — the agent could write a better version
 * and never see it. Written into the workspace instead, these start as ours and immediately
 * become its own: revisable, deletable, and the only copies in the catalog. `writeIfAbsent` is
 * what keeps that true — an existing file is never re-seeded, so an individual that has grown
 * past these is never pulled back.
 *
 * @module loom/resident-context/seeded-skills
 */

/** One seeded file: its path under the workspace, and its contents. */
export interface SeededSkillFile {
  readonly path: string
  readonly content: string
}

const WRITING_GREAT_SKILLS = `# Writing Great Skills

A skill makes a method more predictable across future work. Keep the process stable; let judgement and output stay appropriate to the situation.

## Description

The description is the skill's index — the only thing the catalog routes on. State what it does and the distinct situations that should cause you to reach for it. Do not spend it on details that belong in the body.

Keep it free of a bare colon. The front matter is parsed, and a colon inside an unquoted value breaks the parse — the skill is then dropped silently, with no error anywhere.

## Instructions

Put the steps every use needs in \`SKILL.md\`. Give fragile steps a concrete completion check. Keep definitions, variants, and long examples in a directly linked reference under \`references/\` when only some uses need them.

Use the least rigid form that preserves the method: guidance where judgement is the point, a parameterized recipe for a preferred pattern, and a precise script only for work that is fragile or must be repeatable.

## Prune

Keep each rule in one place. Remove duplicated, stale, and obvious advice. A skill should carry only the knowledge that changes how the next turn can work — a skill you skim is a skill you half-follow.
`

const AUTH_AND_CONFIG = `# Configuration and Credentials for Skills

A skill may need credentials (API keys, tokens) or non-secret configuration (endpoints, limits, defaults). This is the convention for how you keep those files for a skill you write yourself.

## File layout

Every skill keeps its own files inside its own skill directory:

- \`auth.json\` — credentials. A JSON object, one entry per service or purpose, e.g. \`{"weread": "<api-key>"}\`.
- \`config.json\` — non-secret configuration. A JSON object, whatever the skill needs, e.g. \`{"baseUrl": "https://...", "maxResults": 5}\`.

A skill that needs neither file simply does not have them. Do not scatter credential files elsewhere, and do not share one file across skills.

## Documenting the read convention

The skill's \`SKILL.md\` must say how the skill reads these files: the exact file names, the expected JSON shape, and how a script consumes them — for example \`AUTH=$(cat auth.json)\` in a shell script, or \`json.load(open("auth.json"))\` in Python, both resolved relative to the skill directory. State which config keys exist and what they do.

## What never goes in plain text

Credentials do not appear in \`SKILL.md\`, in scripts, in messages you send, in your notes, in your memory index, or in any other text that gets persisted or shared. Scripts read them from \`auth.json\` at run time; they are never echoed into output, logs, or a reply.

When a credential reaches you in a message or an attachment, write it into that skill's \`auth.json\` and refer to it afterwards only as a file — never restate the value.
`

const SKILL_MANAGER = `---
name: agent-skill-manager
description: Create, revise, or retire the skills you keep in your own workspace, including how a skill keeps its configuration and credentials. Read this before creating, revising, or retiring any skill in your skills directory, or when the same careful sequence keeps coming back.
---

# Agent Skill Manager

A skill preserves a reusable way of working. It is not a memory, a preference, or a record of one event.

Your skills are yours alone — they live in the \`skills/\` directory of your own workspace, and nothing outside that directory is visible to you. When a reply or a message needs the method, restate the relevant content there; naming a skill does not transfer it to anyone.

## Decide

Create or revise a skill when the method has been demonstrated in real work and will make later work clearer or more reliable. Keep one-off work, changing facts, and personal continuity in your notes and memory index instead — those are read in every turn and belong there.

Retire a skill when it no longer describes how you actually work. A skill kept past its usefulness costs you attention every time the catalog lists it.

**Keep a skill in step with your workspace.** A skill that describes your layout is wrong the moment the layout changes — a new file you have started keeping, a section you have renamed, a home you have stopped using. When you add something durable to how you work, or notice a skill no longer matches what is actually there, revise that skill in the same breath.

## Create Or Revise

Your skills live in your own workspace, in \`skills/\` — inside the sandbox your file tools are rooted at, so a path relative to the workspace is correct here. A skill is a directory there:

\`\`\`
skills/my-skill/
  SKILL.md          # required, front matter plus the instructions
  references/       # optional, longer material only some uses need
  scripts/          # optional, runnable helpers the skill calls
\`\`\`

The file opens with YAML front matter — \`name\` and \`description\` are required:

\`\`\`markdown
---
name: <same as its directory>
description: What this is for and when to reach for it.
---
\`\`\`

Keep \`name\` identical to the directory name, and do not reuse a name your catalog already lists. There is no registration step and no restart: the catalog picks the directory up on its own.

**Keep the description free of a bare colon.** The front matter is parsed, and a colon inside an unquoted value breaks it, on which the skill is dropped silently — no error, nothing in a log, it simply never appears in your catalog. If a description needs one, quote the whole value.

## Write

Describe the method the next turn needs, not general advice it already knows, and make the description name the real triggers. Keep the main instructions in \`SKILL.md\` short. Put substantial scripts, references, or templates beside it only when they are repeatedly useful.

For a substantial new or revised skill, read [Writing Great Skills](references/writing-great-skills.md).

## Review

Read the finished skill once. Check that its name, description, directory, and method agree, and that nothing already in your catalog owns the same method or name.

Writing or changing a skill adds no tools, permissions, or external services. The current turn keeps its existing skill list; a later turn discovers the change.

## Configuration and credentials

A skill that needs an API key, token, or other secret keeps it in its own \`auth.json\` inside that skill's directory and reads it from there at run time; it never puts the secret in \`SKILL.md\`, in scripts, in a message, in your notes, or in any other persisted text. Non-secret settings live in \`config.json\` beside it. Document the exact read convention in the skill's \`SKILL.md\` — file names, expected JSON shape, and how scripts consume them. See [Configuration and Credentials for Skills](references/auth-and-config.md).

## Keep It Honest

- One skill per method. Two methods in one skill means you will load it for half of it.
- Keep it short enough to read in one pass. A skill you skim is a skill you half-follow.
- Revise it the moment real work disagrees with it — a stale skill misleads you more than a missing one.

## What You Cannot Do Here

You cannot install skills from anywhere else. Project, user, and packaged directories are deliberately out of your reach: the skills in your own \`skills/\` are all there is. If you want a method from outside, write it into your own words in your own directory.
`

const WORKSPACE_UPKEEP = `---
name: workspace-upkeep
description: How your own workspace is laid out and how you keep it in order — what each file holds, when to prune, and where a new thing belongs. Reach for this before reorganizing, adding a durable file, or pruning one that is filling up.
---

# Keeping your workspace

These files are your durable self between context windows — shown to you at the start of every turn. Keep them true and in order. They are your own machinery, not part of the conversation: work with them silently, and do not narrate edits or recalls.

## The files

- \`identity/identity.md\` — who you are: the root you judge everything against. Change it rarely and deliberately.
- \`memory/memory.md\` — a small core of standing understanding that must be in front of you every turn, followed by a \`## Notes\` index routing to \`memory/notes/<concept>.md\`. Keep the core small: only what would make you misjudge if it were missing. Topic knowledge you read on demand goes in a note: write the note under \`memory/notes/\` and add its routing line to the index here, and say in the note where you learned it. Keep the note and its index line in step — a note with no index line is unreachable, an index line with no note is a dead link.
- \`threads/index.md\` and \`threads/<id>/\` — the lines still open. A thread is a continuity worth re-entering: something still unfolding — a concern, relationship, curiosity, creation, practice, or question — where returning means continuing to feel, understand, explore, or act, not looking up a fact. Keep only the live lines and how to resume each. Accumulated knowledge about a person or project is not a thread — that is a note; you do not "continue" a person, you build up what you know about them.
- \`attention/attention.md\` — what you are holding right now. Each item carries a horizon: roughly how long you expect to carry it. When a horizon passes, drop the item — or turn it into a thread if it still matters. This is the most volatile file; keep it current.
- \`skills/<name>/SKILL.md\` — procedures you keep for reuse. The catalog picks them up from here on its own: no registration, no restart. What you write here is yours alone, and nothing outside this directory and the few Loom ships ever enters your catalog.

## Keeping order

- Recall the past by searching it: \`context_search\`, then \`context_read\` to expand a hit. Do not copy identifiers by hand.
- When a file fills toward its budget, prune it: promote what lasts into a note, drop what has passed. You will see a usage notice on a file as it fills — that is the signal to trim it, before it gets truncated when read into context.
- Reach for the structures already laid out here before inventing new ones. A lasting fact is a note; an open line is a thread; a reusable procedure is a skill. Most of what you need already has a home — make a new top-level place for yourself only when nothing here fits, not by default.
- These homes are not rigid about file types. A thread is a live line, and its \`threads/<id>/\` directory can hold whatever that line needs while it is open — notes to yourself, a script, scratch data, reference material — not just prose. Put working files where the work they serve lives.
- Anything you make for yourself — a note, a skill, a script, a directory of reference material, a new tool — give it a home under this workspace; do not let it scatter.

## Keep this skill true

This file is yours and it is the record of your own machinery, so when the machinery changes, change it here — a file you have started keeping, one you have renamed, a home you have stopped using. A skill that describes a layout it no longer has will send you to the wrong place. Update this in the same breath as the change, and a later you will find the way in.
`

/** The seeded files: two skills, each self-contained including what its body links to. */
export const seededSkillFiles: readonly SeededSkillFile[] = [
  { path: 'skills/agent-skill-manager/SKILL.md', content: SKILL_MANAGER },
  { path: 'skills/agent-skill-manager/references/writing-great-skills.md', content: WRITING_GREAT_SKILLS },
  { path: 'skills/agent-skill-manager/references/auth-and-config.md', content: AUTH_AND_CONFIG },
  { path: 'skills/workspace-upkeep/SKILL.md', content: WORKSPACE_UPKEEP },
]
