/**
 * Per-entry ages for the dynamic materials.
 *
 * The materials are free markdown the agent rewrites whole, so any time it writes down by hand is
 * gone by the next save — which is why the age has to be derived rather than recorded. The workspace
 * repository already knows it (a whole-file rewrite still blames each unchanged line to the commit
 * that last touched it), and this module turns those line times into the few characters the agent
 * sees after an entry: `(14 days untouched)`.
 *
 * Nothing here changes behavior: the text is the material plus markers, the budget still governs the
 * result, and an entry the agent rewrote reads as touched no matter how small the edit — which is the
 * right meaning, because editing an entry means it is still being thought about.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** ATX headings are the file's own structure, not an entry the agent carries. */
const HEADING = /^#{1,6}\s/

/** How long a line has been untouched, in the shortest form that stays true. */
export function ageMarker(elapsedMs: number): string {
  const days = Math.floor(Math.max(0, elapsedMs) / DAY_MS)
  if (days < 1) return '(untouched today)'
  return days === 1 ? '(1 day untouched)' : `(${days} days untouched)`
}

/**
 * Append an age to every entry, using the line times of the file as it is on disk.
 *
 * The agent writes one entry per line — long lines, usually separated by a blank one and sometimes
 * not (its attention held two such neighbours the day this was built) — so a line is an entry, and
 * blame line by line is blame entry by entry without parsing anything. Blank lines and headings
 * carry the file's structure rather than an entry, and a line with no known time (a file with no
 * commit yet) is left exactly as it is rather than guessed at.
 */
export function attachEntryAges(text: string, times: ReadonlyMap<number, number>, now: number): string {
  if (text === '' || times.size === 0) return text
  return text
    .split('\n')
    .map((line, index) => {
      if (line.trim() === '' || HEADING.test(line.trim())) return line
      const time = times.get(index + 1)
      return time === undefined ? line : `${line.trimEnd()} ${ageMarker(now - time)}`
    })
    .join('\n')
}
