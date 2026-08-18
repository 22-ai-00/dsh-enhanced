import { describe, expect, it } from 'vitest'
import { CatalogObservationCache, catalogCacheKey, type CatalogCacheKeyParts } from '../src/catalog-cache.ts'
import type { CatalogObservation } from '../src/acp-client.ts'

function parts(overrides: Partial<CatalogCacheKeyParts> = {}): CatalogCacheKeyParts {
  return {
    route: 'traex-agent',
    command: 'traex',
    cwd: '/repo',
    configRevision: 'default',
    ...overrides,
  }
}

function observation(overrides: Partial<CatalogObservation> = {}): CatalogObservation {
  return {
    currentValue: 'default',
    modelValues: ['default', 'trae-fast'],
    observedAt: 1000,
    ...overrides,
  }
}

describe('non-authoritative catalog observation cache', () => {
  it('builds a key from non-sensitive parts only and never from env values', () => {
    const key = catalogCacheKey(parts())
    expect(key).toContain('traex-agent')
    expect(key).toContain('traex')
    expect(key).toContain('/repo')
    // The parts type has no place for env values; changing only the config revision changes the key.
    expect(catalogCacheKey(parts({ configRevision: 'a,b' }))).not.toBe(key)
  })

  it('records and returns the last observation within TTL', () => {
    let clock = 0
    const cache = new CatalogObservationCache({ ttlMs: 1_000, now: () => clock })
    cache.record(parts(), observation())
    clock = 999
    const cached = cache.peek(parts())
    expect(cached?.observation.modelValues).toEqual(['default', 'trae-fast'])
    expect(cache.size).toBe(1)
  })

  it('evicts an entry once TTL has elapsed', () => {
    let clock = 0
    const cache = new CatalogObservationCache({ ttlMs: 1_000, now: () => clock })
    cache.record(parts(), observation())
    clock = 1_000
    expect(cache.peek(parts())).toBeUndefined()
    // A stale peek drops the entry so it cannot linger.
    expect(cache.size).toBe(0)
  })

  it('overwrites a prior observation for the same key', () => {
    let clock = 0
    const cache = new CatalogObservationCache({ ttlMs: 10_000, now: () => clock })
    cache.record(parts(), observation({ modelValues: ['old'] }))
    clock = 5
    cache.record(parts(), observation({ modelValues: ['new'] }))
    expect(cache.peek(parts())?.observation.modelValues).toEqual(['new'])
    expect(cache.size).toBe(1)
  })

  it('keeps distinct keys separate', () => {
    const cache = new CatalogObservationCache({ ttlMs: 10_000, now: () => 0 })
    cache.record(parts({ cwd: '/a' }), observation({ modelValues: ['a'] }))
    cache.record(parts({ cwd: '/b' }), observation({ modelValues: ['b'] }))
    expect(cache.peek(parts({ cwd: '/a' }))?.observation.modelValues).toEqual(['a'])
    expect(cache.peek(parts({ cwd: '/b' }))?.observation.modelValues).toEqual(['b'])
  })

  it('invalidates one key without touching others', () => {
    const cache = new CatalogObservationCache({ ttlMs: 10_000, now: () => 0 })
    cache.record(parts({ cwd: '/a' }), observation())
    cache.record(parts({ cwd: '/b' }), observation())
    cache.invalidate(parts({ cwd: '/a' }))
    expect(cache.peek(parts({ cwd: '/a' }))).toBeUndefined()
    expect(cache.peek(parts({ cwd: '/b' }))).toBeDefined()
  })

  it('clears every observation on reload', () => {
    const cache = new CatalogObservationCache({ ttlMs: 10_000, now: () => 0 })
    cache.record(parts({ cwd: '/a' }), observation())
    cache.record(parts({ cwd: '/b' }), observation())
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
