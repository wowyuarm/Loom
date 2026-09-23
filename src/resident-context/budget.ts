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
