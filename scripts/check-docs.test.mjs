/**
 * Contract tests for the docs gate: it must accept a well-formed maintained tree and
 * reject broken links, missing anchors, escaping paths, code-fence false positives,
 * repeated-heading anchors, and explicit HTML ids. Runs against temporary fixture
 * roots via the script's --root option, never against the live repo layout.
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-docs.mjs')

async function fixture(entries) {
  const root = await mkdtemp(join(tmpdir(), 'check-docs-'))
  for (const [rel, content] of Object.entries(entries)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content, 'utf8')
  }
  return root
}

async function check(root) {
  try {
    const { stdout, stderr } = await run('node', [script, '--root', root])
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

describe('check-docs', () => {
  it('accepts a tree with valid file links, anchors, repeats, html ids, and fenced code', async () => {
    const root = await fixture({
      'README.md': [
        '# 标题',
        '',
        '[去文档](<docs/guide.md#二级-标题>) [重复](<docs/guide.md#相同-1>)',
        '[自定义](<docs/guide.md#custom>) [本页](#标题)',
        '',
        '```',
        '[不检查](missing.md)',
        '```',
        '',
      ].join('\n'),
      'docs/guide.md': [
        '# 指南',
        '## 二级 标题',
        '## 相同',
        '## 相同',
        '<a id="custom"></a>',
        '',
      ].join('\n'),
    })
    try {
      const result = await check(root)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('OK')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects missing files, missing anchors, and repository escapes', async () => {
    // The escape target must exist so the check reaches the escape rule rather than
    // failing on existence first: fixture root is <parent>/repo, target is <parent>/outside.md.
    const parent = await mkdtemp(join(tmpdir(), 'check-docs-escape-'))
    const root = join(parent, 'repo')
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(parent, 'outside.md'), '# 外部\n', 'utf8')
    await writeFile(join(root, 'README.md'), [
      '# 标题',
      '[缺文件](nope.md)',
      '[缺锚](<docs/guide.md#不存在>)',
      '[逃逸](../outside.md)',
      '[本页缺](#没有)',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'docs/guide.md'), '# 指南\n', 'utf8')
    try {
      const result = await check(root)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('nope.md')
      expect(result.stderr).toContain('#不存在')
      expect(result.stderr).toContain('escapes')
      expect(result.stderr).toContain('#没有')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects CRLF and missing trailing newline', async () => {
    const root = await fixture({ 'README.md': '# 标题\r\n没有结尾' })
    try {
      const result = await check(root)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('newline')
      expect(result.stderr).toContain('LF')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes against the repository itself', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const result = await check(repoRoot)
    expect(result.code, result.stderr).toBe(0)
  })
})
