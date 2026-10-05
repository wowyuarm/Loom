import { describe, expect, it } from 'vitest'
import { createContinuityTools, type ContinuityToolAdapter } from '@wowyuarm/dsh-context-continuity'
import { LOOM_CONTINUITY_TOOL_TEXT } from '../src/context-continuity/host.ts'

/**
 * The descriptions are built by the engine from a text record, and every field is optional: a
 * field this deployment stops passing silently reverts to the engine's domain-neutral default
 * with no type error and no test failure anywhere else. These assertions read the descriptions
 * the model actually receives, so a dropped field fails here rather than in production prose.
 */
const adapter: ContinuityToolAdapter = {
  requestRollover: () => Promise.resolve({ mode: 'scheduled' }),
  isRestorableRef: () => Promise.resolve(false),
  recordCheckpoint: () => Promise.reject(new Error('not exercised')),
  timeline: () => Promise.reject(new Error('not exercised')),
  compactionFor: () => undefined,
}

const tools = createContinuityTools(adapter, LOOM_CONTINUITY_TOOL_TEXT)
const descriptionOf = (tool: { readonly description?: string }): string => tool.description ?? ''

describe('Loom continuity tool text', () => {
  it('addresses the agent as an Individual rather than a generic agent', () => {
    expect(descriptionOf(tools.rollover)).toContain('the same Individual')
    expect(descriptionOf(tools.checkpoint)).toContain("Individual's context lineage")
  })

  it('names the channels a fresh generation already receives', () => {
    // Without this the engine's "seeded only by your handoff" sentence reads as "restate
    // everything", which is exactly the context a handoff exists to save.
    const text = descriptionOf(tools.rollover)
    expect(text).toContain('identity, memory and its notes, threads, and attention')
    expect(text).toContain('do not restate any of it')
  })

  it('asks the handoff for what the person has already been told', () => {
    // Loom-specific: a checkpoint return reopens a prefix from before a reply, but it does not
    // unsend that reply. The engine's default checklist cannot know a person is on the other end.
    expect(descriptionOf(tools.rollover)).toContain('what you have already told the person')
  })

  it('explains that an empty anchor list is the absence of the agent’s own checkpoints', () => {
    // Loom registers no domain boundaries, so this list is empty until the agent records one;
    // without the note, an empty list reads as a broken capability rather than an unused one.
    expect(descriptionOf(tools.status)).toContain('Loom contributes no automatic anchors')
  })

  it('promises no rollover refusal, because Loom performs none', () => {
    // Loom mounts the background-job registry, and disposing the agent cancels the jobs it owned.
    // The engine's default sentence promises a refusal that no Loom code performs; keeping it
    // would state a guarantee this host does not honour.
    const text = descriptionOf(tools.rollover)
    expect(text).not.toContain('a rollover is refused')
    expect(text).not.toContain('background jobs')
  })

  it('keeps the engine’s own safety text intact', () => {
    // The host fills vocabulary only. If a rewrite ever displaces these, the tool would be
    // inviting the model to fabricate a ref rather than reading one from context_status.
    const text = descriptionOf(tools.rollover)
    expect(text).toContain('never synthesize, guess, or reconstruct one')
    expect(text).toContain('Neither move deletes anything')
  })
})
