import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LinuxCgroupRoots, LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { prepareAutonomyProfile as prepareProfile, validateAutonomyOptions, type AutonomyLinuxConfig, type AutonomyProfileInput, type FiniteAutonomyTerms } from '../src/autonomy.ts'

// /var is an OS symlink on macOS; use a virtual home beneath canonical /.
const fixtureHome = '/dsh-autonomy-fixture/home'
const cgroupRoots: LinuxCgroupRoots = { mode: 'v1', cpu: '/sys/fs/cgroup/cpu/uid-1000', memory: '/sys/fs/cgroup/memory/uid-1000', pids: '/sys/fs/cgroup/pids/uid-1000', freezer: '/sys/fs/cgroup/freezer/uid-1000' }
function linuxFor(home: string): AutonomyLinuxConfig {
  const root = join(home, 'rsi-linux-runtimes', 'web', 'runtime')
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64',
    sourceCommit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), root: { path: root, dev: 1, ino: 2, sha256: 'c'.repeat(64) },
    nodePath: join(root, 'bin/node'), nodeSha256: 'd'.repeat(64), pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(root, 'pnpm-native'), nativePnpmPath: join(root, 'pnpm-native/pnpm'), modulesPath: join(root, 'node_modules'),
    storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '5.9.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
  return { runtime, cgroupRoots }
}
const input: AutonomyProfileInput = {
  dshHome: fixtureHome, profile: 'web', workspace: '/srv/workspace', preset: 'standard',
  isolation: { backend: 'linux-native', linux: linuxFor(fixtureHome), maxRuns: 3, leaseMs: 60_000, maxTotalDurationMs: 120_000 },
}
const finite: FiniteAutonomyTerms = { maxRuns: 3, leaseMs: 60_000, maxTotalDurationMs: 120_000 }
const publishedUserHome = join(realpathSync(tmpdir()), `web-owner-published-defaults-${process.pid}`)
const rows = (home = join(publishedUserHome, '.dsh')) => `
- id: dsh-enhanced-assistant-isolation
  name: '@dsh-enhanced/assistant-isolation'
  config: {}
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
function localInputAt(home: string, workspace: string): AutonomyProfileInput {
  return { ...input, dshHome: home, workspace, isolation: { ...input.isolation, linux: linuxFor(home) } }
}
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

  it('rejects disabled, duplicate, drifted Linux descriptor, and custom grant conflicts', () => {
    const effective = rows()
    expect(() => prepareAutonomyProfile(input, '[]', effective.replace('id: dsh-enhanced-assistant-actions', 'id: dsh-enhanced-assistant-actions\n  disabled: true'), owner)).toThrow(/disabled/)
    expect(() => prepareAutonomyProfile(input, '[]', `${effective}- id: dsh-enhanced-assistant-isolation\n`, owner)).toThrow(/duplicate/)
    const configured = prepareAutonomyProfile(input, '[]', effective, owner, 1_000)
    const drifted = configured.replace('c'.repeat(64), 'e'.repeat(64))
    expect(() => prepareAutonomyProfile(input, drifted, drifted, owner, 2_000)).toThrow(/descriptor differs/)
    const grants = configured.replace('maxRuns: 3', 'maxRuns: 4')
    expect(() => prepareAutonomyProfile(input, grants, grants, owner, 2_000)).toThrow(/managed isolation grant differs/)
  })

  it('refuses to rewrite an existing Docker profile', () => {
    const effective = rows()
    for (const config of [`{ image: 'sha256:${'a'.repeat(64)}' }`, '{ backend: docker }', '{ dockerPath: /usr/bin/docker }', '{ socketPath: /var/run/docker.sock }']) {
      const docker = effective.replace("name: '@dsh-enhanced/assistant-isolation'\n  config: {}", `name: '@dsh-enhanced/assistant-isolation'\n  config: ${config}`)
      expect(() => prepareAutonomyProfile(input, '[]', docker, owner)).toThrow(/existing Docker isolation requires explicit migration/)
    }
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
      const localInput = localInputAt(dshHome, join(root, 'workspace'))
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
      const aliasedInput = { ...input, dshHome: alias, workspace: join(root, 'workspace'), isolation: { ...input.isolation, linux: linuxFor(physical) } }
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
      const effective = rows(dshHome); const localInput = localInputAt(dshHome, join(root, 'workspace'))
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
      const localInput = { ...input, dshHome: alias, workspace: join(root, 'workspace'), isolation: { ...input.isolation, linux: linuxFor(physical) } }
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

  it('rejects Docker-era options and profile settings with an explicit migration error', () => {
    for (const value of [
      { ...finite, image: `sha256:${'a'.repeat(64)}` },
      { ...finite, backend: 'docker' },
    ]) expect(() => validateAutonomyOptions(value as never)).toThrow(/Docker isolation was removed; use the linux-native backend/)
    const effective = rows()
    for (const config of [`{ image: 'sha256:${'a'.repeat(64)}' }`, '{ backend: docker }']) {
      const docker = effective.replace("name: '@dsh-enhanced/assistant-isolation'\n  config: {}", `name: '@dsh-enhanced/assistant-isolation'\n  config: ${config}`)
      expect(() => prepareAutonomyProfile(input, '[]', docker, owner)).toThrow(/existing Docker isolation requires explicit migration/)
    }
  })

  it('validates bounded linux-native options', () => {
    expect(() => validateAutonomyOptions({ ...finite, maxRuns: 10_001 })).toThrow(/maxRuns/)
    expect(() => validateAutonomyOptions({ ...finite, maxTotalDurationMs: 1 })).toThrow(/maxTotalDurationMs/)
    expect(() => validateAutonomyOptions({ ...finite, backend: 'linux-native', source: { kind: 'local-head', repository: 'relative' } })).toThrow(/canonical absolute path/)
  })
})
