/**
 * Resident files share a small total context budget, so each has a byte cap. When a
 * a file exceeds its cap the projection truncates it on a UTF-8 boundary and appends a
 * visible marker, which both bounds the injected size and signals the agent to prune.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface BudgetResult {
  text: string
  usedBytes: number
  capBytes: number
  truncated: boolean
}

export function applyBudget(text: string, capBytes: number): BudgetResult {
  const bytes = encoder.encode(text)
  if (bytes.length <= capBytes) {
    return { text, usedBytes: bytes.length, capBytes, truncated: false }
  }
  // Slicing at capBytes may cut a multi-byte code point; TextDecoder replaces the trailing
  // partial bytes with U+FFFD, so the result stays valid text rather than invalid UTF-8.
  const kept = decoder.decode(bytes.subarray(0, capBytes))
  const marker = `\n\n[truncated: ${bytes.length}/${capBytes} bytes over budget — prune this file]`
  return { text: kept + marker, usedBytes: bytes.length, capBytes, truncated: true }
}

/** Byte length of `text` in UTF-8 — the unit every cap is measured in. */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

// Show a file's usage only once it is this full; below it the file has ample room and a notice
// would be noise.
export const USAGE_NOTICE_FRACTION = 0.5

function kib(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}

/**
 * A one-line usage notice for a budgeted file, or `undefined` while it has ample room. Shared by
 * two feedback surfaces so both speak the same language: the projection appends it to a material
 * as it fills toward its cap, and the write path returns it the moment a write pushes a file over.
 * Over the cap, it names the consequence (the projection truncates at the cap) rather than
 * refusing the write — feedback over rejection (DESIGN §7).
 */
export function budgetNotice(name: string, usedBytes: number, capBytes: number): string | undefined {
  if (usedBytes > capBytes) {
    return `[${name}: ${kib(usedBytes)}/${kib(capBytes)} KiB over budget — prune this file; it is truncated at the cap when read into context]`
  }
  if (usedBytes < capBytes * USAGE_NOTICE_FRACTION) return undefined
  return `[${name}: ${kib(usedBytes)}/${kib(capBytes)} KiB]`
}
