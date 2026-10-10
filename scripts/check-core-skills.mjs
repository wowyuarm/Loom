/**
 * Mechanical gate for the skills Loom ships.
 *
 * `core-skills/**` is product content, not repository documentation: it is copied into the
 * built package by `npm run build` and read by the agent's own catalog. Three properties hold
 * by construction, and this script is what keeps them holding:
 *
 *   1. the front matter names the skill exactly as its directory does;
 *   2. the description is a real routing entry, and carries no bare colon — the front matter is
 *      parsed, and a colon inside an unquoted value breaks the parse, on which the whole skill
 *      is dropped silently with no error anywhere. This one is invisible in every other test:
 *      the skill simply never appears in a catalog, and nothing says why.
 *   3. every relative link stays inside the skill directory — only that directory is shipped,
 *      so a link that leaves it resolves here and is dead in the catalog.
 *
 * Runs standalone, like the other checks: `npm run check:core-skills`, also part of `npm test`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIRECTORY = 'core-skills'
const SKILL_FILE = 'SKILL.md'
/** Below this a description names no trigger and the catalog cannot route to it. */
const DESCRIPTION_MIN_CHARACTERS = 40

const skillsRoot = join(repositoryRoot, SKILLS_DIRECTORY)
const failures = []
const fail = (file, message) =>
  failures.push(`${relative(repositoryRoot, file).replaceAll('\\', '/')}: ${message}`)

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g

for (const name of readdirSync(skillsRoot)) {
  const directory = join(skillsRoot, name)
  if (!statSync(directory).isDirectory()) continue
  const file = join(directory, SKILL_FILE)
  if (!existsSync(file)) {
    fail(directory, `has no ${SKILL_FILE}`)
    continue
  }
  const text = readFileSync(file, 'utf8')

  // Front matter: the block between the leading `---` and the next `---`.
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  if (match === null) {
    fail(file, 'has no YAML front matter')
    continue
  }
  const fields = new Map(
    match[1]
      .split('\n')
      .map(line => /^([A-Za-z_-]+):\s*([\s\S]*)$/.exec(line))
      .filter(entry => entry !== null)
      .map(entry => [entry[1], entry[2]]),
  )

  if (fields.get('name') !== name) {
    fail(file, `front matter name ${JSON.stringify(fields.get('name'))} is not its directory name`)
  }

  const description = fields.get('description')
  if (description === undefined) {
    fail(file, 'has no description, which is the catalog\'s only routing entry')
  } else {
    if (description.trim().length < DESCRIPTION_MIN_CHARACTERS) {
      fail(file, `description is ${description.trim().length} characters, under ${DESCRIPTION_MIN_CHARACTERS}`)
    }
    // Measured against the parser, not guessed: a `": "` inside an unquoted value, or a value
    // ending in `:`, breaks the parse and the skill is dropped silently. A colon with no space
    // after it is fine, and quoting the whole value exempts it.
    const value = description.trim()
    const quoted = /^["']/.test(value)
    if (!quoted && (/:(\s|$)/.test(value) || value.endsWith(':'))) {
      fail(file, 'description carries a bare colon, which breaks the front matter parse and drops the skill silently')
    }
  }

  for (const [, target] of text.matchAll(linkPattern)) {
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
    if (!existsSync(join(directory, target))) {
      fail(file, `links to ${target}, which does not exist inside the skill directory`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(`\n${failures.length} core-skill problem(s).`)
  process.exit(1)
}
console.log(`core-skills: ${readdirSync(skillsRoot).length} skill(s) OK.`)
