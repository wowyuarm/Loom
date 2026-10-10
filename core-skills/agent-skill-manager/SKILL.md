---
name: agent-skill-manager
description: Create, revise, or retire the skills you keep in your own workspace, including how a skill keeps its configuration and credentials. Read this before creating, revising, or retiring any skill in your skills directory, or when the same careful sequence keeps coming back.
---

# Agent Skill Manager

A skill preserves a reusable way of working. It is not a memory, a preference, or a record of one event.

Your skills are yours alone — they live in the `skills/` directory of your own workspace, and nothing outside that directory and the few Loom ships is visible to you. When a reply or a message needs the method, restate the relevant content there; naming a skill does not transfer it to anyone.

## Decide

Create or revise a skill when the method has been demonstrated in real work and will make later work clearer or more reliable. Keep one-off work, changing facts, and personal continuity in your notes and memory index instead — those are read in every turn and belong there.

Retire a skill when it no longer describes how you actually work. A skill kept past its usefulness costs you attention every time the catalog lists it.

## Create Or Revise

Your skills live in your own workspace, in `skills/` — inside the sandbox your file tools are rooted at, so a path relative to the workspace is correct here. A skill is a directory there:

```
skills/my-skill/
  SKILL.md          # required, front matter plus the instructions
  references/       # optional, longer material only some uses need
  scripts/          # optional, runnable helpers the skill calls
```

The file opens with YAML front matter — `name` and `description` are required:

```markdown
---
name: <same as its directory>
description: What this is for and when to reach for it.
---
```

Keep `name` identical to the directory name, and do not reuse a name your catalog already lists, the shipped ones included. There is no registration step and no restart: the catalog picks the directory up on its own.

**Keep the description free of a bare colon.** The front matter is parsed, and a colon inside an unquoted value breaks it, on which the skill is dropped silently — no error, nothing in a log, it simply never appears in your catalog. If a description needs one, quote the whole value.

## Write

Describe the method the next turn needs, not general advice it already knows, and make the description name the real triggers. Keep the main instructions in `SKILL.md` short. Put substantial scripts, references, or templates beside it only when they are repeatedly useful.

For a substantial new or revised skill, read [Writing Great Skills](references/writing-great-skills.md).

## Review

Read the finished skill once. Check that its name, description, directory, and method agree, and that nothing already in your catalog owns the same method or name.

Writing or changing a skill adds no tools, permissions, or external services. The current turn keeps its existing skill list; a later turn discovers the change.

## Configuration and credentials

A skill that needs an API key, token, or other secret keeps it in its own `auth.json` inside that skill's directory and reads it from there at run time; it never puts the secret in `SKILL.md`, in scripts, in a message, in your notes, or in any other persisted text. Non-secret settings live in `config.json` beside it. Document the exact read convention in the skill's `SKILL.md` — file names, expected JSON shape, and how scripts consume them. See [Configuration and Credentials for Skills](references/auth-and-config.md).

## Keep It Honest

- One skill per method. Two methods in one skill means you will load it for half of it.
- Keep it short enough to read in one pass. A skill you skim is a skill you half-follow.
- Revise it the moment real work disagrees with it — a stale skill misleads you more than a missing one.

## What You Cannot Do Here

You cannot install skills from anywhere else. Project, user, and packaged directories are deliberately out of your reach: you find the skills Loom ships and the ones you wrote, and nothing else. If you want a method from outside, write it into your own words in your own directory.
