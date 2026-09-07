import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { autonomyDockerPath, prepareAutonomyProfile, validateAutonomyOptions, type AutonomyProfileInput } from '../src/autonomy.ts'

const input: AutonomyProfileInput = {
  dshHome: '/var/lib/dsh', profile: 'web', workspace: '/srv/workspace', preset: 'standard',
  isolation: { image: `sha256:${'a'.repeat(64)}`, maxRuns: 3, leaseMs: 60_000, maxTotalDurationMs: 120_000 },
}
const rows = `
- id: dsh-enhanced-assistant-isolation
  name: '@dsh-enhanced/assistant-isolation'
  config: { dockerPath: /usr/bin/docker }
- id: dsh-enhanced-assistant-actions
  name: '@dsh-enhanced/assistant-actions'
  config: {}
- id: dsh-enhanced-credentials-keychain
  name: '@dsh-enhanced/credentials-keychain'
  config:
    databasePath: !!js dshHomePath('credentials-keychain/ledger.sqlite')
    handles: []
`
const owner = { id: 'owner-record', version: 7 }
const object = (source: string): Array<Record<string, unknown>> => parseDocument(source).toJS() as Array<Record<string, unknown>>
const config = (source: string, id: string): Record<string, unknown> => object(source).find(row => row.id === id)?.config as Record<string, unknown>

describe('prepareAutonomyProfile', () => {
  it('materializes independent defaults and preserves custom YAML siblings', () => {
    const source = `# keep\n- id: custom\n  config: { expression: !!js dshHomePath('custom') }\n`
    const patch = prepareAutonomyProfile(input, source, rows, owner, 1_000)
    expect(patch).toContain('!!js')
    expect(config(patch, 'dsh-enhanced-assistant-actions').grants).toEqual([])
    expect(config(patch, 'dsh-enhanced-assistant-isolation').stateRoot).toBe('/var/lib/dsh/assistant-isolation/web')
    expect(config(patch, 'dsh-enhanced-credentials-keychain').databasePath).toBe('/var/lib/dsh/credentials-keychain/web.sqlite')
    expect(config(patch, 'dsh-enhanced-assistant-isolation').grants).toEqual([{
      id: 'autonomy-web', revision: 1, principalDigest: createHash('sha256').update('web/web/local/operator').digest('hex'), principalRecordId: 'owner-record', principalVersion: 7,
      workspace: '/srv/workspace', agentPreset: 'standard', expiresAt: 61_000, maxRuns: 3, maxTotalDurationMs: 120_000,
    }])
  })

  it('rejects disabled, duplicate, custom image, and custom grant conflicts', () => {
    expect(() => prepareAutonomyProfile(input, '[]', rows.replace('id: dsh-enhanced-assistant-actions', 'id: dsh-enhanced-assistant-actions\n  disabled: true'), owner)).toThrow(/disabled/)
    expect(() => prepareAutonomyProfile(input, '[]', `${rows}- id: dsh-enhanced-assistant-isolation\n`, owner)).toThrow(/duplicate/)
    const configured = prepareAutonomyProfile(input, '[]', rows, owner, 1_000)
    const image = configured.replace(input.isolation.image, `sha256:${'b'.repeat(64)}`)
    expect(() => prepareAutonomyProfile(input, image, image, owner, 2_000)).toThrow(/image differs/)
    const grants = configured.replace('maxRuns: 3', 'maxRuns: 4')
    expect(() => prepareAutonomyProfile(input, grants, grants, owner, 2_000)).toThrow(/managed isolation grant differs/)
  })

  it('does not renew an existing managed grant and requires an unchanged owner scope', () => {
    const first = prepareAutonomyProfile(input, '[]', rows, owner, 1_000)
    const retry = prepareAutonomyProfile(input, first, first, owner, 9_000_000)
    expect(config(retry, 'dsh-enhanced-assistant-isolation').grants).toEqual(config(first, 'dsh-enhanced-assistant-isolation').grants)
    expect(() => prepareAutonomyProfile(input, first, first, { id: 'other', version: 7 }, 2_000)).toThrow(/managed isolation grant differs/)
  })

  it('does not create an isolation grant when owner identity is absent', () => {
    const patch = prepareAutonomyProfile(input, '[]', rows, undefined, 1_000)
    expect(config(patch, 'dsh-enhanced-assistant-isolation').grants).toEqual([])
  })

  it('only replaces the published credential default and prevalidates grants without an owner', () => {
    const inherited = prepareAutonomyProfile(input, '- id: dsh-enhanced-credentials-keychain\n  config: { handles: [] }\n', rows)
    expect(config(inherited, 'dsh-enhanced-credentials-keychain').databasePath).toBe('/var/lib/dsh/credentials-keychain/web.sqlite')
    const customPath = rows.replace("databasePath: !!js dshHomePath('credentials-keychain/ledger.sqlite')", 'databasePath: /srv/credentials.sqlite')
    expect(config(prepareAutonomyProfile(input, '[]', customPath), 'dsh-enhanced-credentials-keychain').databasePath).toBe('/srv/credentials.sqlite')
    const arbitraryJs = rows.replace("dshHomePath('credentials-keychain/ledger.sqlite')", "dshHomePath('other.sqlite')")
    expect(() => prepareAutonomyProfile(input, '[]', arbitraryJs)).toThrow(/literal absolute path/)
    const malformed = prepareAutonomyProfile(input, '[]', rows, owner, 1_000).replace('maxRuns: 3', 'maxRuns: 0')
    expect(() => prepareAutonomyProfile(input, malformed, malformed)).toThrow(/managed isolation grant differs/)
  })

  it('probes the same literal Docker path that the runtime will use', () => {
    const custom = prepareAutonomyProfile(input, '[]', rows.replace('/usr/bin/docker', '/opt/docker'), owner, 1_000)
    expect(autonomyDockerPath(custom)).toBe('/opt/docker')
    expect(autonomyDockerPath(prepareAutonomyProfile(input, '[]', rows, owner, 1_000))).toBe('/usr/bin/docker')
    for (const value of ['docker', '/opt/../docker', '!!js getDocker()']) {
      expect(() => prepareAutonomyProfile(input, '[]', rows.replace('/usr/bin/docker', value), owner)).toThrow(/path/)
    }
  })

  it('validates bounded immutable options', () => {
    expect(() => validateAutonomyOptions({ ...input.isolation, image: 'latest' })).toThrow(/immutable/)
    expect(() => validateAutonomyOptions({ ...input.isolation, maxRuns: 10_001 })).toThrow(/maxRuns/)
    expect(() => validateAutonomyOptions({ ...input.isolation, maxTotalDurationMs: 1 })).toThrow(/maxTotalDurationMs/)
  })
})
