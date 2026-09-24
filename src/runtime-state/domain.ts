import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AcceptedInput } from '../contracts/index.ts'

/**
 * The runtime-state domain. v1 holds the facts that must survive a restart:
 * - currentSession pointer (global singleton), updated at rollover commit, read at boot.
 * - acceptedInput ledger (table), keyed by (channel, providerMessageId), so a redelivery is
 *   not processed twice.
 * - owned-session ledger (table), keyed by session id: the search-authorization set, every
 *   generation the subject created including archived off-lineage branches.
 */

// Zod schemas for the two facts. domainTable/global type the values to the contracts, so a
// schema that drifts from a contract is a compile error at the domain definition below.
const currentSessionSchema = z.object({
  sessionId: z.string(),
})

const acceptedInputSchema = z.object({
  channel: z.string(),
  providerMessageId: z.string(),
  actor: z.string(),
  place: z.string(),
  visibility: z.string(),
  route: z.string(),
  acceptedAt: z.number(),
})

// One owned session. The key is the session id; the value restates it so a dumped record is
// self-describing. No timestamp: the ledger authorizes search, and result ordering is the
// engine's job from event times, not this ledger's.
const ownedSessionSchema = z.object({
  sessionId: z.string(),
})

// The global slot cannot store null (the medium's "never written" sentinel), so wrap the
// pointer in a thin object; an absent `current` field means "no current session yet".
const globalSchema = z.object({ current: currentSessionSchema.optional() })
type RuntimeGlobal = z.infer<typeof globalSchema>

// Domain and table names must match /^[a-z][a-z0-9_]*$/. Domains share one storage backend
// across bundles, so the `loom_` prefix keeps Loom's domains distinct in that shared namespace.
export const runtimeStateDomain = defineDomain({
  name: 'loom_runtime_state',
  version: 1,
  global: { schema: globalSchema, initial: {} as RuntimeGlobal },
  tables: {
    accepted_input: domainTable<string, AcceptedInput>(acceptedInputSchema),
    owned_session: domainTable<string, { sessionId: string }>(ownedSessionSchema),
  },
})

// Dedup key. Record keys are arbitrary strings but must avoid NUL (sqlite truncates at it),
// so encode the pair as JSON — unambiguous and separator-collision-free.
export function acceptedInputKey(channel: string, providerMessageId: string): string {
  return JSON.stringify([channel, providerMessageId])
}
