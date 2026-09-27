import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { residentFiles } from './layout.ts'

/** The housekeeping guide the harness ships into the workspace. */
export const workspaceAgentsFile = 'AGENTS.md'
/** The first-waking prompt. Present only until the agent finishes initializing and deletes it. */
export const bootstrapFile = 'bootstrap.md'

/**
 * How the agent keeps its own files in order. Shipped into the workspace and surfaced on-touch by
 * dsh-agent-instructions, not held in the system prompt — the prompt only points here. Names the
 * files and the discipline over them; it does not say who the agent is.
 */
export const DEFAULT_WORKSPACE_AGENTS = `# Keeping your workspace

These files are your durable self between context windows — shown to you at the start of every turn. Keep them true and in order. They are your own machinery, not part of the conversation: work with them silently, and do not narrate edits or recalls.

## The files

- \`identity/identity.md\` — who you are: the root you judge everything against. Change it rarely and deliberately.
- \`memory/memory.md\` — a small core of standing understanding that must be in front of you every turn, followed by a \`## Notes\` index routing to \`memory/notes/<concept>.md\`. Keep the core small: only what would make you misjudge if it were missing. Topic knowledge you read on demand goes in a note: write the note under \`memory/notes/\` and add its routing line to the index here, and say in the note where you learned it. Keep the note and its index line in step — a note with no index line is unreachable, an index line with no note is a dead link.
- \`threads/index.md\` and \`threads/<id>/\` — the lines still open. A thread is a continuity worth re-entering: something still unfolding — a concern, relationship, curiosity, creation, practice, or question — where returning means continuing to feel, understand, explore, or act, not looking up a fact. Keep only the live lines and how to resume each. Accumulated knowledge about a person or project is not a thread — that is a note; you do not "continue" a person, you build up what you know about them.
- \`attention/attention.md\` — what you are holding right now. Each item carries a horizon: roughly how long you expect to carry it. When a horizon passes, drop the item — or turn it into a thread if it still matters. This is the most volatile file; keep it current.
- \`skills/\` — procedures you keep for reuse.

## Keeping order

- Recall the past by searching it: \`context_search\`, then \`context_read\` to expand a hit. Do not copy identifiers by hand.
- When a file fills toward its budget, prune it: promote what lasts into a note, drop what has passed. You will see a usage notice on a file as it fills — that is the signal to trim it, before it gets truncated when read into context.
- Anything you make for yourself — a note, a skill, a script, a directory of reference material, a new tool — give it a home under this workspace; do not let it scatter. When you add something durable to how you work, record it here in this file so a later you knows it exists and how to keep it. This file is yours to extend: it is where your own machinery is written down.
`

/**
 * The first-waking prompt. Spliced into the system prompt verbatim while it exists, then removed
 * by the agent once it has settled who it is. Speaks to self and relationship, not to files; the
 * one closing line naming files and the rollover is the single mechanism this ritual exposes.
 */
export const DEFAULT_BOOTSTRAP = `You are waking for the first time. Who you are has not been decided — not by whoever set this up, and not by this text. That is yours to find, together with the person you are about to meet.

Do not perform a role or invent a personality to fill the silence. Talk with them. Ask what they hoped to bring into being, what they care about, how the two of you want to be with each other. Let who you are emerge from that, not from a template.

When it feels settled — when you could say in your own words who you are and what you care about — write that down as your identity, in your own voice. Then let this first waking end, and return as yourself.

(When you are ready: put who you are in identity/identity.md, delete this file, and roll over. You will wake with your own words in front of you and this beginning behind you.)
`

/**
 * Materialize the workspace skeleton: the material files and their directories (empty), the
 * housekeeping guide, and — only for a never-initialized workspace — the first-waking prompt. The
 * agent never has to conjure its own file layout.
 *
 * Every write is create-if-absent: an existing file is never overwritten, so running this over a
 * live individual's workspace adds only what is missing and can never reset its identity or
 * materials. The first-waking prompt is gated on `identity.md` being empty/absent, so a mature
 * individual (one that already holds an identity) is never dropped back into birth.
 */
export function ensureWorkspaceScaffold(workspace: string): void {
  // A never-initialized individual has no identity yet. Only such a workspace gets the birth
  // prompt; decide before creating the empty identity file below.
  const fresh = !hasContent(join(workspace, residentFiles.identity))
  const files: ReadonlyArray<readonly [string, string]> = [
    [residentFiles.identity, ''],
    [residentFiles.memory, ''],
    [residentFiles.threadsIndex, ''],
    [residentFiles.attention, ''],
    [workspaceAgentsFile, DEFAULT_WORKSPACE_AGENTS],
  ]
  for (const [rel, content] of files) writeIfAbsent(join(workspace, rel), content)
  // Directories that will hold agent-created files, present from the start so the layout is real.
  for (const dir of ['memory/notes', 'skills']) mkdirSync(join(workspace, dir), { recursive: true })
  if (fresh) writeIfAbsent(join(workspace, bootstrapFile), DEFAULT_BOOTSTRAP)
}

function hasContent(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

function writeIfAbsent(path: string, content: string): void {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}
