import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * Durable local state for one deployment, kept outside the session log and the workspace
 * files. v1 holds exactly two facts that must survive a restart:
 * - currentSession pointer (global singleton): which session the agent currently is,
 *   updated at rollover commit, read at boot to resume the live agent.
 * - acceptedInput ledger (table): external Inputs already durably accepted, keyed by
 *   (channel, providerMessageId), so a redelivery is not processed twice.
 */

export const currentSessionSchema = z.object({
  sessionId: z.string(),
  parentLineage: z.array(z.string()).optional(),
})
export type CurrentSession = z.infer<typeof currentSessionSchema>

export const acceptedInputSchema = z.object({
  channel: z.string(),
  providerMessageId: z.string(),
  actor: z.string(),
  place: z.string(),
  visibility: z.string(),
  route: z.string(),
  // epoch ms, supplied by the caller at accept time. The store never reads the clock —
  // this keeps time injectable at the boundary (eval seam).
  acceptedAt: z.number(),
})
export type AcceptedInput = z.infer<typeof acceptedInputSchema>

// The global slot cannot store null (the medium's "never written" sentinel), so wrap the
// pointer in a thin object; an absent `current` field means "no current session yet",
// with initial `{}`.
const globalSchema = z.object({ current: currentSessionSchema.optional() })
type RuntimeGlobal = z.infer<typeof globalSchema>

// Domain and table names must match /^[a-z][a-z0-9_]*$/ (no hyphens).
export const runtimeStateDomain = defineDomain({
  name: 'loom_runtime_state',
  version: 1,
  global: { schema: globalSchema, initial: {} as RuntimeGlobal },
  tables: {
    accepted_input: domainTable<string, AcceptedInput>(acceptedInputSchema),
  },
})

// Dedup key. Record keys are arbitrary strings but must avoid NUL (sqlite truncates at it),
// so encode the pair as JSON — unambiguous and separator-collision-free.
export function acceptedInputKey(channel: string, providerMessageId: string): string {
  return JSON.stringify([channel, providerMessageId])
}
