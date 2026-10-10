---
name: agent-skill-manager
description: Create, revise, or retire the skills you keep in your own workspace, including when a repeated way of working has earned a skill. Read this before creating, revising, or retiring any skill in your skills directory, or when the same careful sequence keeps coming back.
---

# Agent Skill Manager

A skill preserves a reusable way of working. It is not a memory, a preference, or a record of one event.

Your skills are yours alone — they live in the `skills/` directory of your own workspace, and nothing outside that directory and the few Loom ships is visible to you. When a message or a reply needs the method, restate the relevant content there; naming a skill does not transfer it to anyone.

## Decide

Create or revise a skill when the method has been demonstrated in real work and will make later work clearer or more reliable. Keep one-off work, changing facts, and personal continuity in your notes and memory index instead — those are read in every turn and belong there.

Retire a skill when it no longer describes how you actually work. A skill kept past its usefulness costs you attention every time the catalog lists it.

## Create Or Revise

A skill is a directory in your own `skills/` directory:

```
skills/<name>/SKILL.md
```

The file opens with YAML front matter — `name` and `description` are required:

```markdown
---
name: <same as its directory>
description: What this is for and when to reach for it — the catalog's only index entry, so it has to name the trigger.
---
```

Keep `name` identical to the directory name. Write the `description` as a real routing entry: what it is for, and the situation that should make you reach for it. A one-word description cannot route anything.

The body is the method, written to be followed: the steps, the judgement calls, and the traps that cost you before. Aim for something you can act on directly, not a description of the topic.

Supporting detail goes beside `SKILL.md` under `references/` and is linked from it. Only the skill's own directory is yours to use, so a link that leaves it will break.

## Keep It Honest

- One skill per method. Two methods in one skill means you will load it for half of it.
- Keep it short enough to read in one pass. A skill you skim is a skill you half-follow.
- Revise it the moment real work disagrees with it — the skill is the record of the method, and a stale one misleads you more than a missing one.

## What You Cannot Do Here

You cannot install skills from anywhere else. Project, user, and packaged directories are deliberately out of your reach: you find the skills Loom ships and the ones you wrote, and nothing else. If you want a method from outside, write it into your own words in your own directory.
