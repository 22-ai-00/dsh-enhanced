import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deliverySchemaVersion, ensurePrincipalLocally } from '@dsh-enhanced/assistant-delivery'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument, stringify } from 'yaml'
import { inspectAutonomyOwner, inspectAutonomyProfile } from '../src/doctor.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'autonomy-doctor-'))); roots.push(home)
  const workspace = join(home, 'workspace'); mkdirSync(workspace)
  const databasePath = join(home, 'delivery', 'state.sqlite')
  const principal = { channel: 'web', account: 'web', tenant: 'local', user: 'operator' }
  const owner = ensurePrincipalLocally({ databasePath, principal })
  const grant = { id: 'autonomy-web', revision: 1, principalDigest: createHash('sha256').update('web/web/local/operator').digest('hex'),
    principalRecordId: owner.id, principalVersion: owner.version, workspace, agentPreset: 'standard', expiresAt: Date.now() + 60_000, maxRuns: 2, maxTotalDurationMs: 120_000 }
  const source = stringify([
    { id: 'dsh-enhanced-assistant-isolation', name: '@dsh-enhanced/assistant-isolation', config: { stateRoot: join(home, 'isolation'), image: `sha256:${'a'.repeat(64)}`, grants: [grant] } },
    { id: 'dsh-enhanced-assistant-web-owner', name: '@dsh-enhanced/assistant-web-owner', config: { workspace, preset: 'standard', principal: { account: 'web', tenant: 'local', user: 'operator' } } },
    { id: 'dsh-enhanced-assistant-delivery', name: '@dsh-enhanced/assistant-delivery', config: { databasePath } },
  ])
  return { home, source, databasePath, grant }
}

describe('autonomy doctor profile and persisted owner checks', () => {
  it('reads a matched live owner without changing identity, database or configured grant', () => {
    const { home, source, databasePath, grant } = fixture()
    const before = readFileSync(databasePath)
    const profile = inspectAutonomyProfile(source, 'web', home)
    expect(profile.grant).toEqual(grant)
    expect(profile.dockerPath).toBe('/usr/bin/docker')
    expect(inspectAutonomyOwner(profile)).toEqual({ status: 'matched' })
    expect(readFileSync(databasePath)).toEqual(before)
    expect(existsSync(profile.stateRoot)).toBe(false)
  })

  it('accepts reviewed Delivery v24 and v25 owner snapshots without changing either database', () => {
    const { home, source, databasePath } = fixture()
    const profile = inspectAutonomyProfile(source, 'web', home)
    for (const version of [24, 25]) {
      const db = new DatabaseSync(databasePath)
      try { db.exec(`PRAGMA user_version=${version}`) } finally { db.close() }
      const before = readFileSync(databasePath)
      expect(inspectAutonomyOwner(profile)).toEqual({ status: 'matched' })
      expect(inspectAutonomyOwner({ ...profile, grant: { ...profile.grant, principalRecordId: 'foreign' } }))
        .toEqual({ status: 'mismatch' })
      expect(readFileSync(databasePath)).toEqual(before)
      const check = new DatabaseSync(databasePath, { readOnly: true })
      try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(version) } finally { check.close() }
    }
  })

  it('rejects unreviewed older and future Delivery schemas without migrating them', () => {
    const { home, source, databasePath } = fixture()
    const profile = inspectAutonomyProfile(source, 'web', home)
    const db = new DatabaseSync(databasePath)
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(deliverySchemaVersion)
      for (const version of [deliverySchemaVersion - 2, deliverySchemaVersion + 1]) {
        db.exec(`PRAGMA user_version=${version}`)
        expect(inspectAutonomyOwner(profile)).toEqual({ status: 'unavailable' })
        expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(version)
      }
    } finally { db.close() }
  })

  it('reports revoked owners, version changes and foreign lineage without pairing or migration', () => {
    const { home, source, databasePath } = fixture()
    const profile = inspectAutonomyProfile(source, 'web', home)
    expect(inspectAutonomyOwner({ ...profile, grant: { ...profile.grant, principalRecordId: 'foreign' } })).toEqual({ status: 'mismatch' })
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare('UPDATE delivery_principals SET version=version+1').run()
      expect(inspectAutonomyOwner(profile)).toEqual({ status: 'mismatch' })
      db.prepare("UPDATE delivery_principals SET version=version-1, status='revoked'").run()
      expect(inspectAutonomyOwner(profile)).toEqual({ status: 'mismatch' })
      expect(db.prepare('SELECT status FROM delivery_principals').get()?.status).toBe('revoked')
      db.exec('PRAGMA user_version=18')
      expect(inspectAutonomyOwner(profile)).toEqual({ status: 'unavailable' })
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(18)
    } finally { db.close() }
  })

  it('does not create missing state or follow database/workspace symlinks', () => {
    const { home, source, databasePath } = fixture()
    const profile = inspectAutonomyProfile(source, 'web', home)
    const absent = join(home, 'missing', 'state.sqlite')
    expect(inspectAutonomyOwner({ ...profile, databasePath: absent })).toEqual({ status: 'unavailable' })
    expect(existsSync(join(home, 'missing'))).toBe(false)
    const link = join(home, 'db-link'); symlinkSync(databasePath, link)
    expect(inspectAutonomyOwner({ ...profile, databasePath: link })).toEqual({ status: 'unavailable' })
    const workspaceLink = join(home, 'workspace-link'); symlinkSync(profile.grant.workspace, workspaceLink)
    expect(inspectAutonomyOwner({ ...profile, grant: { ...profile.grant, workspace: workspaceLink } })).toEqual({ status: 'unavailable' })
  })

  it('rejects disabled/shadowed components, broadened grants, owner changes and unsafe image/path values', () => {
    const { home, source } = fixture()
    const invalid = [
      (doc: ReturnType<typeof parseDocument>) => doc.setIn([0, 'disabled'], true),
      (doc: ReturnType<typeof parseDocument>) => doc.add({ id: 'shadow', name: '@dsh-enhanced/assistant-isolation' }),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn([0, 'config', 'image'], 'latest'),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn([0, 'config', 'dockerPath'], '/usr/../bin/docker'),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn([0, 'config', 'grants', 0, 'workspace'], '/other'),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn([0, 'config', 'grants', 0, 'maxRuns'], 0),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn([0, 'config', 'grants', 0, 'extraAuthority'], true),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn([1, 'config', 'principal', 'user'], 'other'),
    ]
    for (const mutate of invalid) { const doc = parseDocument(source); mutate(doc); expect(() => inspectAutonomyProfile(String(doc), 'web', home)).toThrow() }
  })

  it('recognizes only the published Delivery path helper and never evaluates YAML code', () => {
    const { home, source, databasePath } = fixture()
    const known = source.replace(`databasePath: ${databasePath}`, "databasePath: !!js dshHomePath('delivery/state.sqlite')")
    expect(inspectAutonomyProfile(known, 'web', home).databasePath).toBe(databasePath)
    for (const expression of ["process.exit(0)", "dshHomePath('../foreign')", "dshHomePath('/foreign')"]) {
      expect(() => inspectAutonomyProfile(known.replace("dshHomePath('delivery/state.sqlite')", expression), 'web', home)).toThrow()
    }
    expect(() => inspectAutonomyProfile(source.replace('preset: standard', 'preset: !!js standard'), 'web', home)).toThrow(/literal/)
  })
})
