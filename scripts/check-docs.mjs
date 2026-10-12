#!/usr/bin/env node
/**
 * Mechanical gate for the maintained documentation tree.
 *
 * Checks every Markdown file in the two tracked trees: the maintained set (repo root
 * README/AGENTS/CONTEXT and everything under docs/) and the work-record tree (.scratch,
 * except the gitignored .scratch/local/). For both it enforces that local links resolve to
 * files that exist, that fragment anchors match a heading or an explicit <a id>, and that no
 * local link leaves the repository.
 *
 * The two trees keep different disciplines: docs/ is maintained, so its prose must describe
 * current behavior; .scratch is history and working material, so its conclusions are allowed
 * to be superseded by later source. Links are the one rule shared by both — a work record
 * that is tracked in git should still point at things a reader can open.
 *
 * Anchors follow GitHub's slug rule (github-slugger), including the -1, -2 suffixes
 * for repeated headings, plus explicit HTML ids. Fenced code is ignored.
 *
 * Usage: node scripts/check-docs.mjs [--root <dir>]   (part of npm test via test:docs)
 */
import { readFile, readdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lexer } from 'marked'
import GithubSlugger from 'github-slugger'
import { decodeHTML } from 'entities'

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const repositoryRoot = rootFlag >= 0 && args[rootFlag + 1]
  ? resolve(args[rootFlag + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const fail = (where, message) => failures.push(`${where}: ${message}`)

/**
 * Markdown files this gate owns: maintained entries plus the work-record tree. `.scratch/local/`
 * is gitignored private scratch and is never checked — its links may dangle on purpose.
 */
async function maintainedFiles(root) {
  const files = []
  for (const name of ['README.md', 'AGENTS.md', 'CONTEXT.md']) {
    if (existsSync(join(root, name))) files.push(name)
  }
  for (const tree of ['docs', '.scratch']) {
    const base = join(root, tree)
    if (!existsSync(base)) continue
    const walk = async (dir, prefix) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (tree === '.scratch' && prefix === '' && entry.name === 'local') continue
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
        else if (entry.isFile() && entry.name.endsWith('.md')) files.push(`${tree}/${rel}`)
      }
    }
    await walk(base, '')
  }
  return files.sort()
}

/** Heading text without inline markup, with HTML entities decoded — what GitHub slugs. */
function plainHeading(tokens) {
  const parts = []
  const collect = (list) => {
    for (const token of list ?? []) {
      if (token.type === 'text' || token.type === 'codespan') parts.push(token.text)
      else if (token.tokens) collect(token.tokens)
      else if (token.type === 'html') parts.push(token.text)
    }
  }
  collect(tokens)
  return decodeHTML(parts.join(''))
}

/** All anchor ids one file exposes: heading slugs (with repeat suffixes) and HTML ids. */
function anchorsOf(markdown) {
  const slugger = new GithubSlugger()
  const anchors = new Set()
  const tokens = lexer(markdown)
  const visit = (list) => {
    for (const token of list) {
      if (token.type === 'heading') anchors.add(slugger.slug(plainHeading(token.tokens)))
      else if (token.type === 'html') {
        for (const match of token.text.matchAll(/<a\s+[^>]*?id\s*=\s*["']([^"']+)["']/gi)) {
          anchors.add(decodeHTML(match[1]))
        }
      }
      if (token.tokens) visit(token.tokens)
    }
  }
  visit(tokens)
  return anchors
}

/**
 * Every local link/image target, excluding fenced code (lexer does that for us).
 * List items live on `items` and table cells on `header` / `rows`, not `tokens` — without
 * those four recursions every link inside a list or a table escapes the check.
 */
function linksOf(markdown) {
  const links = []
  const visit = (list) => {
    if (!Array.isArray(list)) return
    for (const token of list) {
      if ((token.type === 'link' || token.type === 'image') && token.href) links.push(token.href)
      visit(token.tokens)
      visit(token.items)
      visit(token.header)
      if (Array.isArray(token.rows)) for (const row of token.rows) visit(row)
    }
  }
  visit(lexer(markdown))
  return links
}

const files = await maintainedFiles(repositoryRoot)
if (files.length === 0) fail('check-docs', 'no maintained Markdown files found')

const anchorCache = new Map()
async function anchorsFor(absPath) {
  if (!anchorCache.has(absPath)) anchorCache.set(absPath, anchorsOf(await readFile(absPath, 'utf8')))
  return anchorCache.get(absPath)
}

for (const rel of files) {
  const abs = join(repositoryRoot, rel)
  const text = await readFile(abs, 'utf8')
  if (!text.endsWith('\n')) fail(rel, 'file must end with a newline')
  if (text.includes('\r')) fail(rel, 'file must use LF line endings')

  for (const href of linksOf(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue // external
    const [target, fragment] = href.split('#')
    if (target === '') {
      const anchors = await anchorsFor(abs)
      if (fragment && !anchors.has(decodeURIComponent(fragment))) {
        fail(rel, `anchor #${fragment} not found in this file`)
      }
      continue
    }
    const resolved = resolve(dirname(abs), decodeURIComponent(target))
    // Never follow a link out of the repository, and compare real paths so a
    // symlinked docs file still checks against its true neighbors.
    const realRoot = await realpath(repositoryRoot)
    if (!existsSync(resolved)) {
      fail(rel, `link target ${target} does not exist`)
      continue
    }
    const realTarget = await realpath(resolved)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      fail(rel, `link target ${target} escapes the repository`)
      continue
    }
    if (fragment && resolved.endsWith('.md')) {
      const anchors = await anchorsFor(resolved)
      if (!anchors.has(decodeURIComponent(fragment))) {
        fail(rel, `anchor #${fragment} not found in ${relative(repositoryRoot, resolved)}`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`docs check failed (${failures.length} problem${failures.length === 1 ? '' : 's'}):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`docs: ${files.length} file(s) OK.`)
