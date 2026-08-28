import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { discover, firstPartyCatalog, loadCatalogWithFirstPartyFallback, name, parseCatalog, version } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('offers a fixed first-party fallback catalog before an owner creates a local catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-control-catalog-'))
    try {
      const catalog = await loadCatalogWithFirstPartyFallback(join(root, 'missing.json'))
      expect(catalog).toBe(firstPartyCatalog)
      const lark = discover(catalog, 'lark')
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
})
