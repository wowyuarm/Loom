import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { turnRecordSchema } from './timeline.ts'

const checkSchema = z.object({
  at: z.number(),
  state: z.string(),
  model: z.string().optional(),
  attend: z.number().optional(),
  outcome: z.enum(['quiet', 'queued', 'failed', 'cancelled', 'withdrawn']),
})
export type PulseCheckRow = z.infer<typeof checkSchema>

const stateSchema = z.object({
  lastActivityTime: z.number().nullable(),
  lastHumanInputTime: z.number().nullable(),
  lastCheckTime: z.number().nullable(),
  lastCheck: checkSchema.optional(),
  lastTurn: turnRecordSchema.optional(),
  lastWake: turnRecordSchema.optional(),
})
export type PulseState = z.infer<typeof stateSchema>

// A separate domain keeps scheduling facts with their owning plugin, not in subject-owned files.
export const pulseStateDomain = defineDomain({
  name: 'loom_pulse_state', version: 1,
  global: { schema: stateSchema, initial: {
    lastActivityTime: null, lastHumanInputTime: null, lastCheckTime: null,
  } as PulseState },
  tables: { check: domainTable<string, PulseCheckRow>(checkSchema) },
})
