import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { assertUniqueFoldedPaths, WikiVault, WikiVaultError } from '../src/vault.ts'
import type { WikiPageInput } from '../src/types.ts'

const temporaryRoots: string[] = []

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'personal-wiki-vault-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function pageInput(title = 'DeepSeek Harness', overrides: Partial<WikiPageInput> = {}): WikiPageInput {
  return {
    title,
    type: 'concept',
    authority: 'curated',
    status: 'active',
    tags: ['dsh', 'agent'],
    aliases: ['Harness'],
    sources: [{ uri: 'https://example.test/source', sha256: 'a'.repeat(64) }],
    body: '# DeepSeek Harness\n\nA durable agent harness.',
    ...overrides,
  }
}

describe('personal wiki vault', () => {
  test('creates a private canonical vault with only the fixed page directories', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'vault')
    const vault = new WikiVault({ root, now: () => Date.parse('2026-08-20T00:00:00.000Z') })

    expect(vault.root).toBe(await realpath(root))
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'wiki'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'wiki', 'concepts'))).isDirectory()).toBe(true)
    expect(vault.pageDirectories()).toEqual([
      'concepts', 'decisions', 'meta', 'people', 'projects', 'questions', 'sources',
    ])
  })

  test('rejects relative roots and roots reached through a symlink', async () => {
    expect(() => new WikiVault({ root: 'relative/vault' }))
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'invalid-path' }))
    const parent = await temporaryRoot()
    const real = join(parent, 'real')
    const linked = join(parent, 'linked')
    await mkdir(real)
    await symlink(real, linked)

    expect(() => new WikiVault({ root: linked }))
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'symlink' }))
  })

  test('writes and reads a strict canonical page with stable id and revision', async () => {
    const root = join(await temporaryRoot(), 'vault')
    const vault = new WikiVault({ root, now: () => Date.parse('2026-08-20T00:00:00.000Z') })

    const page = vault.createPage(pageInput())
    const loaded = vault.get(page.metadata.id)
    const markdown = await readFile(join(root, page.relativePath), 'utf8')

    expect(page.metadata.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(page.relativePath).toMatch(/^wiki\/concepts\/deepseek-harness--[0-9a-z]{26}\.md$/)
    expect((await stat(join(root, page.relativePath))).mode & 0o777).toBe(0o600)
    expect(markdown).toMatch(/^---\n\{\n/)
    expect(markdown).toContain('"title": "DeepSeek Harness"')
    expect(loaded).toEqual(page)
    expect(page.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(page.metadata.created).toBe('2026-08-20T00:00:00.000Z')
    expect(page.metadata.updated).toBe(page.metadata.created)
  })

  test('rejects malformed/unknown frontmatter and invalid derived provenance', async () => {
    const root = join(await temporaryRoot(), 'vault')
    const vault = new WikiVault({ root })
    const conceptDir = join(root, 'wiki', 'concepts')
    await writeFile(join(conceptDir, 'bad.md'), '---\nnot-json\n---\nbody', { mode: 0o600 })

    expect(() => vault.rebuild())
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'invalid-frontmatter' }))
    await rm(join(conceptDir, 'bad.md'))
    expect(() => vault.createPage(pageInput('Derived without evidence', {
      authority: 'derived',
      sources: [],
    }))).toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'invalid-page' }))
  })

  test('rejects symlink pages, case-fold path collisions, and oversized files', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'vault')
    const vault = new WikiVault({ root, maxPageBytes: 256 })
    const concepts = join(root, 'wiki', 'concepts')
    const outside = join(parent, 'outside.md')
    await writeFile(outside, 'secret')
    await symlink(outside, join(concepts, 'escape.md'))
    expect(() => vault.rebuild())
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'symlink' }))
    await rm(join(concepts, 'escape.md'))

    expect(() => assertUniqueFoldedPaths(['wiki/concepts/Alpha.md', 'wiki/concepts/alpha.md']))
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'path-collision' }))

    await writeFile(join(concepts, 'large.md'), 'x'.repeat(257))
    expect(() => vault.rebuild())
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'page-too-large' }))
  })

  test('fails closed if a page directory is swapped or a prepared path is forged', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'vault')
    const vault = new WikiVault({ root })
    const prepared = vault.prepareWrite({ op: 'create', input: pageInput('Contained') })
    expect(() => vault.applyPreparedWrite({ ...prepared, relativePath: '../../outside.md' }))
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'invalid-path' }))

    const concepts = join(root, 'wiki', 'concepts')
    const moved = join(root, 'wiki', 'concepts-moved')
    const outside = join(parent, 'outside')
    await mkdir(outside)
    await rename(concepts, moved)
    await symlink(outside, concepts)

    expect(() => vault.applyPreparedWrite(prepared))
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'symlink' }))
    await expect(stat(join(outside, 'contained.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects non-regular markdown entries instead of silently ignoring them', async () => {
    const root = join(await temporaryRoot(), 'vault')
    const vault = new WikiVault({ root })
    await mkdir(join(root, 'wiki', 'concepts', 'directory.md'))

    expect(() => vault.rebuild())
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'invalid-path' }))
  })

  test('uses revision CAS and leaves no temp files after competing updates', async () => {
    const root = join(await temporaryRoot(), 'vault')
    let now = Date.parse('2026-08-20T00:00:00.000Z')
    const vault = new WikiVault({ root, now: () => now })
    const original = vault.createPage(pageInput())
    now += 1_000

    const updated = vault.updatePage(original.metadata.id, original.revision, pageInput('Renamed concept', {
      body: '# Renamed\n\nUpdated body.',
    }))
    expect(updated.metadata.id).toBe(original.metadata.id)
    expect(updated.relativePath).toBe(original.relativePath)
    expect(updated.metadata.created).toBe(original.metadata.created)
    expect(updated.metadata.updated).toBe('2026-08-20T00:00:01.000Z')
    expect(() => vault.updatePage(original.metadata.id, original.revision, pageInput('Stale')))
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'revision-conflict' }))

    const names = await import('node:fs/promises').then(({ readdir }) => readdir(join(root, 'wiki', 'concepts')))
    expect(names.filter(name => name.includes('.tmp-'))).toEqual([])
  })

  test('reclaims only an expired lock owned by a dead process', async () => {
    const root = join(await temporaryRoot(), 'vault')
    let now = 100_000
    const vault = new WikiVault({ root, now: () => now, lockStaleMs: 10_000 })
    const lockPath = join(root, '.write.lock')
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, acquiredAt: 1, owner: 'dead' }), { mode: 0o600 })

    expect(vault.createPage(pageInput('Recovered lock')).metadata.title).toBe('Recovered lock')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    now += 20_000
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: 1, owner: 'live' }), { mode: 0o600 })
    expect(() => vault.createPage(pageInput('Must stay blocked')))
      .toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'busy' }))
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ owner: 'live' })
  })

  test('refuses to derive a page from another derived page', async () => {
    const root = join(await temporaryRoot(), 'vault')
    const vault = new WikiVault({ root })
    const derived = vault.createPage(pageInput('Derived source', {
      authority: 'derived',
      derivedFrom: [],
    }))

    expect(() => vault.createPage(pageInput('Second-order summary', {
      authority: 'derived',
      derivedFrom: [derived.metadata.id],
    }))).toThrowError(expect.objectContaining<Partial<WikiVaultError>>({ code: 'derived-chain' }))
  })
})
