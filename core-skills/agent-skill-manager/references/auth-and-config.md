# Configuration and Credentials for Skills

A skill may need credentials (API keys, tokens) or non-secret configuration (endpoints, limits, defaults). This is the convention for how you keep those files for a skill you write yourself.

## File layout

Every skill keeps its own files inside its own skill directory:

- `auth.json` — credentials. A JSON object, one entry per service or purpose, e.g. `{"weread": "<api-key>"}`.
- `config.json` — non-secret configuration. A JSON object, whatever the skill needs, e.g. `{"baseUrl": "https://...", "maxResults": 5}`.

A skill that needs neither file simply does not have them. Do not scatter credential files elsewhere, and do not share one file across skills.

## Documenting the read convention

The skill's `SKILL.md` must say how the skill reads these files: the exact file names, the expected JSON shape, and how a script consumes them — for example `AUTH=$(cat auth.json)` in a shell script, or `json.load(open("auth.json"))` in Python, both resolved relative to the skill directory. State which config keys exist and what they do.

## What never goes in plain text

Credentials do not appear in `SKILL.md`, in scripts, in messages you send, in your notes, in your memory index, or in any other text that gets persisted or shared. Scripts read them from `auth.json` at run time; they are never echoed into output, logs, or a reply.

When a credential reaches you in a message or an attachment, write it into that skill's `auth.json` and refer to it afterwards only as a file — never restate the value.
