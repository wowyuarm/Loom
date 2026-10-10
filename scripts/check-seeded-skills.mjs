/**
 * Mechanical gate for the skills an individual wakes up with.
 *
 * These live in `src/resident-context/seeded-skills.ts` and are written into the workspace once
 * by the scaffold, after which they belong to the agent. Three properties hold by construction,
 * and this script is what keeps them holding:
 *
 *   1. the front matter names the skill exactly as its directory does;
 *   2. the description is a real routing entry, and carries no bare colon — the front matter is
 *      parsed, and a colon inside an unquoted value breaks the parse, on which the whole skill
 *      is dropped silently with no error anywhere. This one is invisible in every other test:
 *      the skill simply never appears in a catalog, and nothing says why;
 *   3. every relative link stays inside the skill directory — only that directory is seeded, so
 *      a link that leaves it resolves here and is dead in the workspace.
 *
 * Runs standalone, like the other checks: `npm run check:seeded-skills`, also part of `npm test`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEEDED_SKILLS = 'src/resident-context/seeded-skills.ts'
const SKILL_FILE_SUFFIX = '/SKILL.md'
/** Below this a description names no trigger and the catalog cannot route to it. */
const DESCRIPTION_MIN_CHARACTERS = 40

const failures = []
const fail = (where, message) => failures.push(`${where}: ${message}`)
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g

/**
 * Read the seeded files straight out of the module source: each entry is a path plus a template
 * literal, so the content is recovered by slicing between the backticks rather than by importing
 * (the module is TypeScript, and this check runs on plain node).
 */
function readSeededSkills() {
  const source = readFileSync(join(repositoryRoot, SEEDED_SKILLS), 'utf8')
  const files = []
  const entryPattern = /\{\s*path:\s*'([^']+)',\s*content:\s*([A-Z_]+)\s*\}/g
  for (const [, path, constName] of source.matchAll(entryPattern)) {
    const declaration = new RegExp(`const ${constName} = \`([\\s\\S]*?)\`\\n`)
    const body = declaration.exec(source)
    if (body === null) {
      fail(SEEDED_SKILLS, `seeds ${path} from ${constName}, which cannot be read`)
      continue
    }
    files.push({ path, content: body[1] })
  }
  return files
}

const files = readSeededSkills()
if (files.length === 0) fail(SEEDED_SKILLS, 'no seeded skills were found')

for (const { path, content } of files) {
  if (!path.startsWith('skills/')) {
    fail(path, 'a seeded skill must live under skills/')
    continue
  }
  if (!path.endsWith(SKILL_FILE_SUFFIX)) continue
  const directory = relative('skills', dirname(path))
  const name = directory.split('/').pop()

  const match = /^---\n([\s\S]*?)\n---/.exec(content)
  if (match === null) {
    fail(path, 'has no YAML front matter')
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
    fail(path, `front matter name ${JSON.stringify(fields.get('name'))} is not its directory name ${JSON.stringify(name)}`)
  }

  const description = fields.get('description')
  if (description === undefined) {
    fail(path, "has no description, which is the catalog's only routing entry")
  } else {
    if (description.trim().length < DESCRIPTION_MIN_CHARACTERS) {
      fail(path, `description is ${description.trim().length} characters, under ${DESCRIPTION_MIN_CHARACTERS}`)
    }
    // Measured against the parser, not guessed: a `": "` inside an unquoted value, or a value
    // ending in `:`, breaks the parse and the skill is dropped silently. A colon with no space
    // after it is fine, and quoting the whole value exempts it.
    const value = description.trim()
    if (!/^["']/.test(value) && (/:(\s|$)/.test(value) || value.endsWith(':'))) {
      fail(path, 'description carries a bare colon, which breaks the front matter parse and drops the skill silently')
    }
  }

  for (const [, target] of content.matchAll(linkPattern)) {
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
    const seeded = files.find(file => file.path === join(dirname(path), target))
    if (seeded === undefined) {
      fail(path, `links to ${target}, which is not seeded beside it`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(`\n${failures.length} seeded-skill problem(s).`)
  process.exit(1)
}
console.log(`seeded-skills: ${files.filter(f => f.path.endsWith(SKILL_FILE_SUFFIX)).length} skill(s) OK.`)
