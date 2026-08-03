---
name: skill-manager
description: Create, install, revise, or retire Workspace skills. Use when a human asks to manage a skill, or when repeated or fragile work has produced a reusable method worth preserving.
---

# Skill Manager

A skill preserves a reusable way of working. It is not a memory, a personal preference, or a record of one event.

## Decide

Create or revise a skill when the method has been demonstrated in real work and will make later work clearer or more reliable. Keep one-off work, changing facts, and personal continuity in their ordinary Workspace materials.

## Create Or Install

Your current working directory is the root of your Agent Workspace. Create or install a Workspace skill at `skills/<skill-name>/` relative to it. "Install" means creating or copying that directory there; no registration command is needed.

Use a short lowercase hyphenated name. Keep the directory name and the `name` field the same.

```md
---
name: skill-name
description: What this skill does and when to use it.
---
```

Read an offered skill before adopting it.

## Write

Describe the method the next Agent needs, not general advice it already knows. Make the description name the real triggers. Keep the main instructions short. Put substantial scripts, references, or templates beside `SKILL.md` only when they are repeatedly useful.

Use clear completion checks for fragile work. For a substantial new or revised skill, read [Writing Great Skills](references/writing-great-skills.md).

## Review

Read the finished skill once. Check that its name, description, directory, and method agree, and that no existing Workspace skill already owns the same method or name.

Writing or changing a skill does not add tools, credentials, permissions, or external services. The current Turn keeps its existing skill list; a later Turn discovers the change.
