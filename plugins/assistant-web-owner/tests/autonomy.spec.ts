import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { autonomyDockerPath, prepareAutonomyProfile as prepareProfile, validateAutonomyOptions, type AutonomyProfileInput } from '../src/autonomy.ts'

// /var is an OS symlink on macOS; use a virtual home beneath canonical /.
const input: AutonomyProfileInput = {
  dshHome: '/dsh-autonomy-fixture/home', profile: 'web', workspace: '/srv/workspace', preset: 'standard',
  isolation: { image: `sha256:${'a'.repeat(64)}`, maxRuns: 3, leaseMs: 60_000, maxTotalDurationMs: 120_000 },
}
const publishedUserHome = join(realpathSync(tmpdir()), `web-owner-published-defaults-${process.pid}`)
const rows = (home = join(publishedUserHome, '.dsh')) => `
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
- id: dsh-enhanced-assistant-skills
  name: '@dsh-enhanced/assistant-skills'
  config:
    databasePath: ${join(home, 'assistant-skills.sqlite')}
    allowedTools: [read, write]
- id: dsh-enhanced-assistant-proactive
  name: '@dsh-enhanced/assistant-proactive'
  config:
    databasePath: ${join(home, 'assistant-proactive.sqlite')}
    profiles: []
`
const owner = { id: 'owner-record', version: 7 }
function prepareWithHome(home: string, ...args: Parameters<typeof prepareProfile>): string {
  const previous = process.env.HOME; process.env.HOME = home
  try { return prepareProfile(...args) } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous }
}
function prepareAutonomyProfile(...args: Parameters<typeof prepareProfile>): string { return prepareWithHome(publishedUserHome, ...args) }
const object = (source: string): Array<Record<string, unknown>> => parseDocument(source).toJS() as Array<Record<string, unknown>>
const config = (source: string, id: string): Record<string, unknown> => object(source).find(row => row.id === id)?.config as Record<string, unknown>

describe('prepareAutonomyProfile', () => {
  it('materializes independent defaults and preserves custom YAML siblings', () => {
    const source = `# keep\n- id: custom\n  config: { expression: !!js dshHomePath('custom') }\n`
    const patch = prepareAutonomyProfile(input, source, rows(), owner, 1_000)
    expect(patch).toContain('!!js')
    expect(config(patch, 'dsh-enhanced-assistant-actions').grants).toEqual([])
    expect(config(patch, 'dsh-enhanced-assistant-isolation').stateRoot).toBe('/dsh-autonomy-fixture/home/assistant-isolation/web')
    expect(config(patch, 'dsh-enhanced-assistant-actions').stateRoot).toBe('/dsh-autonomy-fixture/home/assistant-actions/web')
    expect(config(patch, 'dsh-enhanced-credentials-keychain').databasePath).toBe('/dsh-autonomy-fixture/home/credentials-keychain/web.sqlite')
    expect(config(patch, 'dsh-enhanced-assistant-skills')).toEqual({ databasePath: '/dsh-autonomy-fixture/home/assistant-skills/skills.sqlite', allowedTools: ['read', 'write'] })
    expect(config(patch, 'dsh-enhanced-assistant-proactive')).toEqual({ databasePath: '/dsh-autonomy-fixture/home/assistant-proactive/proactive.sqlite', profiles: [] })
    expect(`${config(patch, 'dsh-enhanced-assistant-proactive').databasePath}.preparations`).toBe('/dsh-autonomy-fixture/home/assistant-proactive/proactive.sqlite.preparations')
    expect(config(patch, 'dsh-enhanced-assistant-isolation').grants).toEqual([{
      id: 'autonomy-web', revision: 1, principalDigest: createHash('sha256').update('web/web/local/operator').digest('hex'), principalRecordId: 'owner-record', principalVersion: 7,
      workspace: '/srv/workspace', agentPreset: 'standard', expiresAt: 61_000, maxRuns: 3, maxTotalDurationMs: 120_000,
    }])
  })

  it('rejects disabled, duplicate, custom image, and custom grant conflicts', () => {
    const effective = rows()
    expect(() => prepareAutonomyProfile(input, '[]', effective.replace('id: dsh-enhanced-assistant-actions', 'id: dsh-enhanced-assistant-actions\n  disabled: true'), owner)).toThrow(/disabled/)
    expect(() => prepareAutonomyProfile(input, '[]', `${effective}- id: dsh-enhanced-assistant-isolation\n`, owner)).toThrow(/duplicate/)
    const configured = prepareAutonomyProfile(input, '[]', effective, owner, 1_000)
    const image = configured.replace(input.isolation.image, `sha256:${'b'.repeat(64)}`)
    expect(() => prepareAutonomyProfile(input, image, image, owner, 2_000)).toThrow(/image differs/)
    const grants = configured.replace('maxRuns: 3', 'maxRuns: 4')
    expect(() => prepareAutonomyProfile(input, grants, grants, owner, 2_000)).toThrow(/managed isolation grant differs/)
  })

  it('does not renew an existing managed grant and requires an unchanged owner scope', () => {
    const first = prepareAutonomyProfile(input, '[]', rows(), owner, 1_000)
    const retry = prepareAutonomyProfile(input, first, first, owner, 9_000_000)
    expect(retry).toBe(first)
    expect(config(retry, 'dsh-enhanced-assistant-isolation').grants).toEqual(config(first, 'dsh-enhanced-assistant-isolation').grants)
    expect(() => prepareAutonomyProfile(input, first, first, { id: 'other', version: 7 }, 2_000)).toThrow(/managed isolation grant differs/)
  })

  it('does not create an isolation grant when owner identity is absent', () => {
    const patch = prepareAutonomyProfile(input, '[]', rows(), undefined, 1_000)
    expect(config(patch, 'dsh-enhanced-assistant-isolation').grants).toEqual([])
  })

  it('only replaces the published credential default and prevalidates grants without an owner', () => {
    const effective = rows()
    const inherited = prepareAutonomyProfile(input, '- id: dsh-enhanced-credentials-keychain\n  config: { handles: [] }\n', effective)
    expect(config(inherited, 'dsh-enhanced-credentials-keychain').databasePath).toBe('/dsh-autonomy-fixture/home/credentials-keychain/web.sqlite')
    const customPath = effective.replace("databasePath: !!js dshHomePath('credentials-keychain/ledger.sqlite')", 'databasePath: /dsh-autonomy-fixture/home/custom/credentials.sqlite')
    expect(config(prepareAutonomyProfile(input, '[]', customPath), 'dsh-enhanced-credentials-keychain').databasePath).toBe('/dsh-autonomy-fixture/home/custom/credentials.sqlite')
    const outside = effective.replace("databasePath: !!js dshHomePath('credentials-keychain/ledger.sqlite')", 'databasePath: /srv/credentials.sqlite')
    expect(() => prepareAutonomyProfile(input, '[]', outside)).toThrow(/Credential databasePath/)
    const arbitraryJs = effective.replace("dshHomePath('credentials-keychain/ledger.sqlite')", "dshHomePath('other.sqlite')")
    expect(() => prepareAutonomyProfile(input, '[]', arbitraryJs)).toThrow(/literal absolute path/)
    const malformed = prepareAutonomyProfile(input, '[]', effective, owner, 1_000).replace('maxRuns: 3', 'maxRuns: 0')
    expect(() => prepareAutonomyProfile(input, malformed, malformed)).toThrow(/managed isolation grant differs/)
  })

  it('preserves safe custom state databases and rejects paths outside DSH_HOME', () => {
    const custom = `
- id: dsh-enhanced-assistant-skills
  config: { databasePath: /dsh-autonomy-fixture/home/custom/learned.sqlite }
- id: dsh-enhanced-assistant-proactive
  config: { databasePath: /dsh-autonomy-fixture/home/custom/opportunities.sqlite }
`
    const effective = rows()
    const patch = prepareAutonomyProfile(input, custom, effective, owner, 1_000)
    expect(config(patch, 'dsh-enhanced-assistant-skills')).toEqual({ databasePath: '/dsh-autonomy-fixture/home/custom/learned.sqlite', allowedTools: ['read', 'write'] })
    expect(config(patch, 'dsh-enhanced-assistant-proactive')).toEqual({ databasePath: '/dsh-autonomy-fixture/home/custom/opportunities.sqlite', profiles: [] })
    for (const value of ['/srv/skills.sqlite', '/dsh-autonomy-fixture/home/assistant-skills/../skills.sqlite', "!!js dshHomePath('assistant-skills/skills.sqlite')"]) {
      const unsafe = effective.replace(join(publishedUserHome, '.dsh', 'assistant-skills.sqlite'), value)
      expect(() => prepareAutonomyProfile(input, '[]', unsafe, owner, 1_000)).toThrow(/Skills databasePath/)
    }
    const outsideProactive = effective.replace(join(publishedUserHome, '.dsh', 'assistant-proactive.sqlite'), '/srv/proactive.sqlite')
    expect(() => prepareAutonomyProfile(input, '[]', outsideProactive, owner, 1_000)).toThrow(/Proactive databasePath/)
  })

  it('materializes a missing state database field without overwriting explicit siblings', () => {
    const source = `
- id: dsh-enhanced-assistant-skills
  config: { allowedTools: [read] }
- id: dsh-enhanced-assistant-proactive
  config: { profiles: [{ id: custom }] }
`
    const patch = prepareAutonomyProfile(input, source, rows(), owner, 1_000)
    expect(config(patch, 'dsh-enhanced-assistant-skills')).toEqual({ databasePath: '/dsh-autonomy-fixture/home/assistant-skills/skills.sqlite', allowedTools: ['read'] })
    expect(config(patch, 'dsh-enhanced-assistant-proactive')).toEqual({ databasePath: '/dsh-autonomy-fixture/home/assistant-proactive/proactive.sqlite', profiles: [{ id: 'custom' }] })
  })

  it('rejects existing ancestor symlink escapes and accepts nonexistent nested state paths', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'web-owner-autonomy-paths-')))
    try {
      const dshHome = join(root, 'home'); const outside = join(root, 'outside')
      await mkdir(dshHome); await mkdir(outside); await symlink(outside, join(dshHome, 'link'))
      const localInput = { ...input, dshHome, workspace: join(root, 'workspace') }
      const cases = [
        ['assistant-isolation', 'stateRoot', 'Isolation stateRoot'],
        ['assistant-actions', 'stateRoot', 'Actions stateRoot'],
        ['credentials-keychain', 'databasePath', 'Credential databasePath'],
        ['assistant-skills', 'databasePath', 'Skills databasePath'],
        ['assistant-proactive', 'databasePath', 'Proactive databasePath'],
      ] as const
      for (const [slug, field, label] of cases) {
        const escaped = `- id: dsh-enhanced-${slug}\n  config: { ${field}: ${join(dshHome, 'link', 'outside.sqlite')} }\n`
        expect(() => prepareAutonomyProfile(localInput, escaped, rows(), owner, 1_000)).toThrow(label)
      }
      const safe = `
- id: dsh-enhanced-assistant-isolation
  config: { stateRoot: ${join(dshHome, 'new', 'isolation')} }
- id: dsh-enhanced-assistant-actions
  config: { stateRoot: ${join(dshHome, 'new', 'actions')} }
- id: dsh-enhanced-credentials-keychain
  config: { databasePath: ${join(dshHome, 'new', 'credentials.sqlite')} }
- id: dsh-enhanced-assistant-skills
  config: { databasePath: ${join(dshHome, 'new', 'skills.sqlite')} }
- id: dsh-enhanced-assistant-proactive
  config: { databasePath: ${join(dshHome, 'new', 'proactive.sqlite')} }
`
      expect(() => prepareAutonomyProfile(localInput, safe, rows(), owner, 1_000)).not.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('serializes canonical paths through safe ancestor aliases and rejects symbolic-link leaves', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'web-owner-autonomy-alias-')))
    try {
      const physical = join(root, 'physical'); const alias = join(root, 'alias')
      await mkdir(physical); await symlink(physical, alias)
      const aliasedInput = { ...input, dshHome: alias, workspace: join(root, 'workspace') }
      const patch = prepareAutonomyProfile(aliasedInput, '[]', rows(), owner, 1_000)
      const canonical = await realpath(physical)
      expect(config(patch, 'dsh-enhanced-assistant-isolation').stateRoot).toBe(join(canonical, 'assistant-isolation', 'web'))
      expect(config(patch, 'dsh-enhanced-assistant-actions').stateRoot).toBe(join(canonical, 'assistant-actions', 'web'))
      expect(config(patch, 'dsh-enhanced-credentials-keychain').databasePath).toBe(join(canonical, 'credentials-keychain', 'web.sqlite'))
      expect(config(patch, 'dsh-enhanced-assistant-skills').databasePath).toBe(join(canonical, 'assistant-skills', 'skills.sqlite'))
      expect(config(patch, 'dsh-enhanced-assistant-proactive').databasePath).toBe(join(canonical, 'assistant-proactive', 'proactive.sqlite'))

      const state = join(physical, 'state'); await mkdir(state); await symlink(join(state, 'target'), join(physical, 'leaf'))
      const leaf = `- id: dsh-enhanced-assistant-skills\n  config: { databasePath: ${join(physical, 'leaf')} }\n`
      expect(() => prepareAutonomyProfile({ ...aliasedInput, dshHome: physical }, leaf, rows(), owner, 1_000)).toThrow(/symbolic link/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('preserves explicit published defaults and refuses to orphan inherited SQLite state', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'web-owner-autonomy-existing-')))
    try {
      const home = join(root, 'home'); const dshHome = join(home, '.dsh'); await mkdir(home); await mkdir(dshHome)
      const effective = rows(dshHome); const localInput = { ...input, dshHome, workspace: join(root, 'workspace') }
      const explicit = `
- id: dsh-enhanced-assistant-skills
  config: { databasePath: ${join(home, '.dsh', 'assistant-skills.sqlite')} }
- id: dsh-enhanced-assistant-proactive
  config: { databasePath: ${join(home, '.dsh', 'assistant-proactive.sqlite')} }
`
      await writeFile(join(dshHome, 'assistant-skills.sqlite-wal'), 'old')
      await writeFile(join(dshHome, 'assistant-proactive.sqlite.preparations-shm'), 'old')
      const explicitPatch = prepareWithHome(home, localInput, explicit, effective, owner, 1_000)
      expect(config(explicitPatch, 'dsh-enhanced-assistant-skills').databasePath).toBe(join(home, '.dsh', 'assistant-skills.sqlite'))
      expect(config(explicitPatch, 'dsh-enhanced-assistant-proactive').databasePath).toBe(join(home, '.dsh', 'assistant-proactive.sqlite'))

      expect(() => prepareWithHome(home, localInput, '[]', effective, owner, 1_000)).toThrow(/offline migration/)
      await rm(join(dshHome, 'assistant-skills.sqlite-wal'))
      expect(() => prepareWithHome(home, localInput, '[]', effective, owner, 1_000)).toThrow(/offline migration/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('canonicalizes every nested Skills stateRoot and rejects nested escapes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'web-owner-autonomy-nested-')))
    try {
      const physical = join(root, 'physical'); const alias = join(root, 'alias'); const outside = join(root, 'outside')
      await mkdir(physical); await mkdir(outside); await symlink(physical, alias); await symlink(outside, join(physical, 'escape'))
      const localInput = { ...input, dshHome: alias, workspace: join(root, 'workspace') }
      const safe = `
- id: dsh-enhanced-assistant-skills
  config:
    comparisons: [{ id: local, stateRoot: ${join(alias, 'comparison', 'local')} }]
    externalHoldouts: [{ id: external, execution: { stateRoot: ${join(alias, 'holdout', 'external')} } }]
`
      const patch = prepareAutonomyProfile(localInput, safe, rows(), owner, 1_000)
      const skills = config(patch, 'dsh-enhanced-assistant-skills') as { comparisons: Array<{ stateRoot: string }>; externalHoldouts: Array<{ execution: { stateRoot: string } }> }
      expect(skills.comparisons[0]!.stateRoot).toBe(join(physical, 'comparison', 'local'))
      expect(skills.externalHoldouts[0]!.execution.stateRoot).toBe(join(physical, 'holdout', 'external'))
      const escaped = safe.replace(join(alias, 'holdout', 'external'), join(alias, 'escape', 'external'))
      expect(() => prepareAutonomyProfile(localInput, escaped, rows(), owner, 1_000)).toThrow(/Skills stateRoot/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('probes the same literal Docker path that the runtime will use', () => {
    const effective = rows()
    const custom = prepareAutonomyProfile(input, '[]', effective.replace('/usr/bin/docker', '/opt/docker'), owner, 1_000)
    expect(autonomyDockerPath(custom)).toBe('/opt/docker')
    expect(autonomyDockerPath(prepareAutonomyProfile(input, '[]', effective, owner, 1_000))).toBe('/usr/bin/docker')
    for (const value of ['docker', '/opt/../docker', '!!js getDocker()']) {
      expect(() => prepareAutonomyProfile(input, '[]', effective.replace('/usr/bin/docker', value), owner)).toThrow(/path/)
    }
  })

  it('validates bounded immutable options', () => {
    expect(() => validateAutonomyOptions({ ...input.isolation, image: 'latest' })).toThrow(/immutable/)
    expect(() => validateAutonomyOptions({ ...input.isolation, maxRuns: 10_001 })).toThrow(/maxRuns/)
    expect(() => validateAutonomyOptions({ ...input.isolation, maxTotalDurationMs: 1 })).toThrow(/maxTotalDurationMs/)
  })
})
