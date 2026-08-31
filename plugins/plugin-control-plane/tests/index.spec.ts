import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { discover, exampleIntegrityPinnedCatalog, loadCatalog, loadCatalogWithMetadata, name, parseCatalog, version } from '../src/index.ts'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-enhanced-plugin-control-plane', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-plugin-control-plane')
    expect(version).toBe(manifest.version)
  })

  it('only returns exact, integrity-pinned catalog candidates for a capability', () => {
    const catalog = parseCatalog({ schemaVersion: 1, entries: [{
      id: 'memory-wiki-bridge', capabilities: ['memory knowledge promotion'], package: '@dsh-enhanced/memory-wiki-bridge',
      version: '0.1.3', integrity: 'sha512-aGVsbG8=', authorities: ['filesystem: dsh home only'], dshBaseline: '0.1.0-rc.8',
    }] })
    expect(discover(catalog, 'knowledge promotion')).toHaveLength(1)
    expect(() => parseCatalog({ schemaVersion: 1, entries: [{
      id: 'unsafe', capabilities: ['unsafe'], package: '@dsh-enhanced/unsafe', version: '^0.1.0',
      integrity: 'sha512-aGVsbG8=', authorities: ['none'], dshBaseline: '0.1.0-rc.8',
    }] })).toThrow('exact version')
  })

  it('does not treat an unsigned package example as a runtime trust source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-control-catalog-'))
    try {
      await expect(loadCatalogWithMetadata(join(root, 'missing.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      const lark = discover(exampleIntegrityPinnedCatalog, 'lark')
      expect(lark).toHaveLength(1)
      expect(lark[0]).toMatchObject({ id: 'lark-assistant', requires: [
        { package: '@dsh-enhanced/assistant-delivery', version: '0.1.3' },
        { package: '@dsh-enhanced/credentials-keychain', version: '0.1.3' },
      ] })
      expect(lark[0]?.integrity).toMatch(/^sha512-/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate bundles in a multi-bundle candidate', () => {
    expect(() => parseCatalog({ schemaVersion: 1, entries: [{
      id: 'duplicate', capabilities: ['test'], package: '@dsh-enhanced/assistant-health', version: '0.1.3',
      integrity: 'sha512-aGVsbG8=', authorities: ['none'], dshBaseline: '0.1.0-rc.8',
      requires: [{ package: '@dsh-enhanced/assistant-health', version: '0.1.3', integrity: 'sha512-aGVsbG8=' }],
    }] })).toThrow('duplicate package')
  })

  it('round-trips a canonical local registry artifact while preserving historical entries', () => {
    const registryPath = '/var/lib/dsh-registry'; const locator = pathToFileURL(registryPath).href
    const reference = pathToFileURL(join(registryPath, 'packages', encodeURIComponent('@dsh-enhanced/local'), '1.2.3', 'package.tgz')).href
    const catalog = parseCatalog({ schemaVersion: 1, entries: [
      { id: 'historical', capabilities: ['old'], package: '@dsh-enhanced/historical', version: '1.0.0',
        integrity: 'sha512-aGVsbG8=', authorities: ['none'], dshBaseline: '0.1.0-rc.8' },
      { id: 'local', capabilities: ['local'], package: '@dsh-enhanced/local', version: '1.2.3',
        integrity: 'sha512-aGVsbG8=', registry: { id: 'owner-local', locator, reference },
        authorities: ['none'], dshBaseline: '0.1.0-rc.8' },
    ] })
    expect(parseCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog)
    expect(catalog.entries[0]?.registry).toBeUndefined()
    expect(catalog.entries[1]?.registry).toEqual({ id: 'owner-local', locator, reference })
  })

  it('rejects local registry references that are non-canonical or escape the immutable package location', () => {
    const base = { id: 'local', capabilities: ['local'], package: '@dsh-enhanced/local', version: '1.2.3',
      integrity: 'sha512-aGVsbG8=', authorities: ['none'], dshBaseline: '0.1.0-rc.8' }
    const locator = 'file:///var/lib/dsh-registry'
    for (const reference of [
      'file:../escape.tgz',
      'file:///var/lib/dsh-registry/packages/%40dsh-enhanced%2Flocal/1.2.3/../escape.tgz',
      'file:///tmp/package.tgz',
      'https://registry.example.invalid/package.tgz',
    ]) expect(() => parseCatalog({ schemaVersion: 1, entries: [{ ...base, registry: { id: 'owner-local', locator, reference } }] })).toThrow()
  })

  it('accepts only owner-controlled regular catalog files and rejects writable aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-control-catalog-owner-'))
    try {
      const target = join(root, 'catalog.json')
      await writeFile(target, JSON.stringify({ schemaVersion: 1, entries: [] }), { mode: 0o600 })
      await expect(loadCatalog(target)).resolves.toMatchObject({ schemaVersion: 1, entries: [] })
      await chmod(target, 0o666)
      await expect(loadCatalog(target)).rejects.toThrow('owner-owned regular file')
      await chmod(target, 0o600)
      const alias = join(root, 'alias.json'); await symlink(target, alias)
      await expect(loadCatalog(alias)).rejects.toThrow('owner-owned regular file')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
