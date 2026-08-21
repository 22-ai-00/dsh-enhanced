import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { WikiVault } from '../src/vault.ts'
import type { WikiPageInput } from '../src/types.ts'

const temporaryRoots: string[] = []

async function vault() {
  const root = await mkdtemp(join(tmpdir(), 'personal-wiki-lint-'))
  temporaryRoots.push(root)
  return new WikiVault({ root: join(root, 'vault'), now: () => Date.parse('2026-08-20T00:00:00.000Z') })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function input(title: string, body: string, overrides: Partial<WikiPageInput> = {}): WikiPageInput {
  return {
    title,
    type: 'concept',
    authority: 'curated',
    status: 'active',
    tags: [],
    aliases: [],
    sources: [{ uri: `https://example.test/${encodeURIComponent(title)}`, sha256: 'c'.repeat(64) }],
    body,
    ...overrides,
  }
}

describe('personal wiki lint', () => {
  test('reports malformed pages and caps deterministic findings without aborting', async () => {
    const wiki = await vault()
    const concepts = join(wiki.root, 'wiki', 'concepts')
    await writeFile(join(concepts, 'bad-a.md'), '---\nnot-json\n---\nbody')
    await writeFile(join(concepts, 'bad-b.md'), 'missing frontmatter')

    const report = wiki.lint({ limit: 1 })

    expect(report.truncated).toBe(true)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({
      code: 'malformed-frontmatter',
      severity: 'error',
      relativePath: 'wiki/concepts/bad-a.md',
    })
  })

  test('finds duplicate identity/name, dead links, orphans, invalid provenance, and source hashes', async () => {
    const wiki = await vault()
    const linked = wiki.createPage(input('Linked target', 'Target body', { aliases: ['Shared name'] }))
    const source = wiki.createPage(input('Curated source', 'Source body'))
    const derived = wiki.createPage(input('Derived summary', `Uses wiki://${source.metadata.id}`, {
      authority: 'derived',
      derivedFrom: [source.metadata.id],
    }))
    const origin = wiki.createPage(input('Origin', [
      `Links wiki://${linked.metadata.id}.`,
      'Links wiki://01K00000000000000000000000.',
    ].join('\n\n'), { aliases: ['Shared name'] }))
    const orphan = wiki.createPage(input('Lonely page', 'No page links here.'))

    await copyFile(
      join(wiki.root, linked.relativePath),
      join(wiki.root, 'wiki', 'concepts', 'duplicate-id.md'),
    )
    const derivedPath = join(wiki.root, derived.relativePath)
    const derivedText = await readFile(derivedPath, 'utf8')
    await writeFile(derivedPath, derivedText.replace(source.metadata.id, derived.metadata.id))
    const orphanPath = join(wiki.root, orphan.relativePath)
    const orphanText = await readFile(orphanPath, 'utf8')
    await writeFile(orphanPath, orphanText.replace('c'.repeat(64), 'not-a-hash'))

    const report = wiki.lint({ limit: 100 })
    const codes = report.findings.map(finding => finding.code)

    expect(codes).toEqual(expect.arrayContaining([
      'duplicate-id',
      'duplicate-title-or-alias',
      'dead-link',
      'orphan-page',
      'derived-provenance',
      'source-hash',
      'index-drift',
    ]))
    expect(report.findings.find(finding => finding.code === 'dead-link')).toMatchObject({
      pageId: origin.metadata.id,
      severity: 'error',
    })
  })

  test('is side-effect free and reports external index drift', async () => {
    const wiki = await vault()
    const page = wiki.createPage(input('Stable page', 'Original body'))
    const path = join(wiki.root, page.relativePath)
    const before = await stat(path)
    const markdown = await readFile(path, 'utf8')
    await writeFile(path, markdown.replace('Original body', 'Externally edited and longer body'))
    const edited = await stat(path)

    const first = wiki.lint({ limit: 20 })
    const second = wiki.lint({ limit: 20 })
    const after = await stat(path)

    expect(first).toEqual(second)
    expect(first.findings).toContainEqual(expect.objectContaining({
      code: 'index-drift',
      pageId: page.metadata.id,
      relativePath: page.relativePath,
    }))
    expect(after.size).toBe(edited.size)
    expect(after.mtimeMs).toBe(edited.mtimeMs)
    expect(before.size).not.toBe(after.size)
  })
})
