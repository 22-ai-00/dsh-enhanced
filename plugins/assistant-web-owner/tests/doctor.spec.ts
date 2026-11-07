import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deliverySchemaVersion, ensurePrincipalLocally } from '@dsh-enhanced/assistant-delivery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument, stringify } from 'yaml'
import { formatAutonomyReadiness, inspectAutonomyOwner, inspectAutonomyProfile, inspectAutonomyReadiness, runAutonomyDoctor } from '../src/doctor.js'

const roots: string[] = []
function databaseFingerprint(path: string) {
  const metadata = statSync(path, { bigint: true })
  return { device: metadata.dev, inode: metadata.ino, size: metadata.size, mtimeNs: metadata.mtimeNs,
    digest: createHash('sha256').update(readFileSync(path)).digest('hex') }
}
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
  it('reads a real Delivery schema 31 owner without changing identity, database or configured grant', () => {
    const { home, source, databasePath, grant } = fixture()
    const schema = new DatabaseSync(databasePath, { readOnly: true })
    try { expect(schema.prepare('PRAGMA user_version').get()?.user_version).toBe(31) } finally { schema.close() }
    const before = databaseFingerprint(databasePath)
    const profile = inspectAutonomyProfile(source, 'web', home)
    expect(profile.grant).toEqual(grant)
    expect(profile.dockerPath).toBe('/usr/bin/docker')
    expect(inspectAutonomyOwner(profile)).toEqual({ status: 'matched' })
    expect(profile.grant).toEqual(grant)
    expect(databaseFingerprint(databasePath)).toEqual(before)
    expect(existsSync(profile.stateRoot)).toBe(false)
  })

  it('accepts reviewed Delivery v24 through v31 owner snapshots without changing either database', () => {
    const { home, source, databasePath } = fixture()
    const profile = inspectAutonomyProfile(source, 'web', home)
    const configured = structuredClone(profile)
    for (const version of [24, 25, 26, 27, 28, 29, 30, 31]) {
      // These are minimal read-only version-gate fixtures, never migration inputs.
      // Keep the real current Delivery database untouched rather than relabelling it.
      const path = join(home, `owner-v${version}.sqlite`)
      const original = new DatabaseSync(databasePath, { readOnly: true })
      const db = new DatabaseSync(path)
      try {
        const ddl = original.prepare("SELECT sql FROM sqlite_schema WHERE name='delivery_principals'").get()!.sql as string
        const row = original.prepare('SELECT * FROM delivery_principals').get()!
        db.exec(ddl)
        db.prepare(`INSERT INTO delivery_principals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          row.id!, row.key_hash!, row.principal_json!, row.role!, row.status!, row.linked_to_id!, row.created_at!, row.updated_at!, row.version!)
        db.exec(`PRAGMA user_version=${version}`)
      } finally { db.close(); original.close() }
      const snapshot = { ...profile, databasePath: path }
      const before = databaseFingerprint(path)
      expect(inspectAutonomyOwner(snapshot)).toEqual({ status: 'matched' })
      expect(inspectAutonomyOwner({ ...snapshot, grant: { ...profile.grant, principalRecordId: 'foreign' } }))
        .toEqual({ status: 'mismatch' })
      expect(databaseFingerprint(path)).toEqual(before)
      expect(profile).toEqual(configured)
      const check = new DatabaseSync(path, { readOnly: true })
      try { expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(version) } finally { check.close() }
    }
  })

  it('does not use reply stream state as persisted owner authority', () => {
    const { home, source, databasePath } = fixture()
    const profile = inspectAutonomyProfile(source, 'web', home)
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare('INSERT INTO delivery_work_item_reply_streams VALUES (?, ?, ?)').run('a'.repeat(64), 'foreign-item', 99)
      const before = databaseFingerprint(databasePath)
      expect(inspectAutonomyOwner(profile)).toEqual({ status: 'matched' })
      expect(databaseFingerprint(databasePath)).toEqual(before)
      db.prepare("UPDATE delivery_principals SET status='revoked'").run()
      expect(inspectAutonomyOwner(profile)).toEqual({ status: 'mismatch' })
    } finally { db.close() }
  })

  it('rejects unreviewed older and future Delivery schemas without migrating them', () => {
    const { home, source, databasePath } = fixture()
    const profile = inspectAutonomyProfile(source, 'web', home)
    const db = new DatabaseSync(databasePath)
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(deliverySchemaVersion)
      for (const version of [23, 32]) {
        db.exec(`PRAGMA user_version=${version}`)
        const before = databaseFingerprint(databasePath)
        expect(inspectAutonomyOwner(profile)).toEqual({ status: 'unavailable' })
        expect(databaseFingerprint(databasePath)).toEqual(before)
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
/**
 * Static readiness fixtures. They are composed-YAML snapshots only: the doctor
 * never activates a Host, calls a model or reads a database for this section.
 */
const readinessBundles = `
- id: dsh-enhanced-personal-assistant
  name: '@dsh-enhanced/personal-assistant'
  config:
    personalMemory:
      automaticLearning:
        workItemExperiences: true
- id: dsh-enhanced-assistant-work-items
  name: '@dsh-enhanced/assistant-work-items'
  config:
    enabled: true
    mode: observe
    intakeLedger:
      enabled: true
      evaluation:
        enabled: true
- id: dsh-enhanced-assistant-delivery
  name: '@dsh-enhanced/assistant-delivery'
  config:
    schedulerEnabled: true
- id: dsh-enhanced-assistant-evaluation
  name: '@dsh-enhanced/assistant-evaluation'
  config:
    notificationOutcomesEnabled: true
- id: dsh-enhanced-assistant-verifier
  name: '@dsh-enhanced/assistant-verifier'
  config:
    memoryReviews:
      workItemExperiences: true
- id: dsh-enhanced-event-triggers
  name: '@dsh-enhanced/event-triggers'
  config:
    pollerEnabled: true
    triggers:
      - id: daily
- id: dsh-enhanced-assistant-memory-learning
  name: '@dsh-enhanced/assistant-memory-learning'
  config:
    workItemExperiences: true
- id: dsh-enhanced-assistant-growth-driver
  name: '@dsh-enhanced/assistant-growth-driver'
  config:
    enabled: true
    usageLearning:
      enabled: true
      workItemFailures: true
- id: dsh-enhanced-assistant-proactive
  name: '@dsh-enhanced/assistant-proactive'
  config:
    intakeEvaluation:
      enabled: true
      rules:
        - ruleId: triage
          ceiling: digest
      provider: deepseek-official
      model: deepseek-v4-flash
- id: dsh-enhanced-plugin-control-plane
  name: '@dsh-enhanced/plugin-control-plane'
  config:
    creationCapabilities:
      authorityId: create
    revisionVerifications:
      authority:
        authorityId: revision
    sourceBuild:
      stateRoot: /tmp/native-source-build
    sourceJobs:
      revision:
        authorityId: revision-jobs
    revisionCapabilities:
      authorityId: adopt-revision
      keyId: revision-key
      namePrefix: 'agent-'
      expiresAt: 4102444800000
`

function readinessCheck(report: ReturnType<typeof inspectAutonomyReadiness>, id: string) {
  const check = report.checks.find(candidate => candidate.id === id)
  expect(check, `missing readiness check ${id}`).toBeDefined()
  return check!
}

describe('autonomy doctor static readiness snapshot', () => {
  it('reports a fully assembled ordinary-use profile as ready with deterministic text and JSON', () => {
    const report = inspectAutonomyReadiness(readinessBundles, 'web')
    expect(report).toMatchObject({ protocol: 'dsh-enhanced/autonomy-readiness/v1', profile: 'web',
      scope: 'ordinary-use-learning', ready: true, runtime: { observed: false } })
    expect(report.checks.map(check => [check.id, check.status])).toEqual([
      ['bundles', 'ready'],
      ['work-items-observe-intake', 'ready'],
      ['intake-evaluator', 'ready'],
      ['delivery-natural-feedback', 'ready'],
      ['background-learning', 'ready'],
      ['revision-adoption', 'ready'],
      ['event-poller', 'ready'],
      ['ptc-presentation', 'ready'],
    ])
    const text = formatAutonomyReadiness(report)
    expect(text).toContain('READY')
    expect(text).toContain('runtime: not observed')
    expect(formatAutonomyReadiness(inspectAutonomyReadiness(readinessBundles, 'web'))).toBe(text)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('reports missing rings fail-closed instead of throwing', () => {
    const partial = `
- id: dsh-enhanced-assistant-delivery
  name: '@dsh-enhanced/assistant-delivery'
  config:
    schedulerEnabled: true
`
    const report = inspectAutonomyReadiness(partial, 'web')
    expect(report.ready).toBe(false)
    expect(readinessCheck(report, 'delivery-natural-feedback').status).toBe('ready')
    const codes = report.checks.flatMap(check => check.reasons.map(reason => reason.code))
    expect(codes).toEqual(expect.arrayContaining([
      'bundle-missing:assistant-work-items',
      'bundle-missing:assistant-proactive',
      'work-items-unavailable',
      'intake-evaluator-work-items-missing',
      'memory-learning-unavailable',
      'growth-driver-unavailable',
      'evaluation-unavailable',
      'control-plane-unavailable',
      'event-triggers-unavailable',
    ]))
    expect(report.checks.find(check => check.id === 'intake-evaluator')?.details).toMatchObject({ configured: false, runtimeRegistration: 'not-observed' })
    expect(() => formatAutonomyReadiness(report)).not.toThrow()
  })

  it('marks an unsafe or incomplete assembly not-ready with the exact reason', () => {
    const wrongMode = readinessBundles.replace('    mode: observe', '    mode: active')
    const mode = inspectAutonomyReadiness(wrongMode, 'web')
    expect(readinessCheck(mode, 'work-items-observe-intake').reasons.map(reason => reason.code))
      .toContain('work-items-not-observe')

    const invalidRules = readinessBundles.replace('          ceiling: digest', '          ceiling: execute')
    const rules = inspectAutonomyReadiness(invalidRules, 'web')
    expect(readinessCheck(rules, 'intake-evaluator').reasons.map(reason => reason.code))
      .toContain('intake-evaluator-rules-invalid')

    const noRevision = readinessBundles.replace(/\n    revisionCapabilities:[\s\S]*$/, '\n')
    const revision = inspectAutonomyReadiness(noRevision, 'web')
    expect(readinessCheck(revision, 'revision-adoption').reasons.map(reason => reason.code))
      .toContain('revision-capabilities-not-configured')

    const disabled = readinessBundles.replace("- id: dsh-enhanced-event-triggers\n  name: '@dsh-enhanced/event-triggers'",
      "- id: dsh-enhanced-event-triggers\n  name: '@dsh-enhanced/event-triggers'\n  disabled: true")
    const poller = inspectAutonomyReadiness(disabled, 'web')
    expect(readinessCheck(poller, 'event-poller').reasons.map(reason => reason.code)).toContain('event-triggers-unavailable')
    expect(readinessCheck(poller, 'bundles').reasons.map(reason => reason.code)).toContain('bundle-disabled:event-triggers')
  })

  it('keeps the optional PTC ring not-verified and out of the exit decision', () => {
    const ptc = readinessBundles.replace('    enabled: true\n    usageLearning:', '    enabled: true\n    toolPresentation: ptc\n    usageLearning:')
    const report = inspectAutonomyReadiness(ptc, 'web')
    const check = readinessCheck(report, 'ptc-presentation')
    expect(check).toMatchObject({ required: false, status: 'not-verified' })
    expect(check.details).toEqual({ toolPresentation: 'ptc' })
    expect(report.ready).toBe(true)
  })

  it('prints a parseable readiness JSON line, fails closed with an exit code and never throws', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'autonomy-doctor-cli-')))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const dumpPath = join(root, 'dump.yml')
    writeFileSync(dumpPath, readinessBundles)
    const host = join(bin, 'dsh')
    writeFileSync(host, '#!/bin/bash\ncat "$READINESS_FIXTURE"\n')
    chmodSync(host, 0o755)
    const savedPath = process.env.PATH
    const savedFixture = process.env.READINESS_FIXTURE
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { chunks.push(String(chunk)); return true }) as never)
    try {
      process.env.PATH = `${bin}:${savedPath ?? ''}`
      process.env.READINESS_FIXTURE = dumpPath
      await runAutonomyDoctor(['--readiness', '--dsh-home', root, '--profile', 'web'])
      const readyOutput = chunks.join('')
      expect(readyOutput).toContain('Autonomy readiness')
      expect(JSON.parse(readyOutput.trim().split('\n').at(-1)!)).toMatchObject({ protocol: 'dsh-enhanced/autonomy-readiness/v1', ready: true })
      expect(process.exitCode ?? 0).toBe(0)

      chunks.length = 0
      writeFileSync(dumpPath, "- id: dsh-enhanced-assistant-delivery\n  name: '@dsh-enhanced/assistant-delivery'\n  config: {}\n")
      await runAutonomyDoctor(['--readiness', '--dsh-home', root, '--profile', 'web'])
      const blocked = JSON.parse(chunks.join('').trim().split('\n').at(-1)!) as { ready: boolean; checks: Array<{ id: string }> }
      expect(blocked.ready).toBe(false)
      expect(blocked.checks.some(check => check.id === 'bundles')).toBe(true)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = undefined
      spy.mockRestore()
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedFixture === undefined) delete process.env.READINESS_FIXTURE
      else process.env.READINESS_FIXTURE = savedFixture
    }
  })
})
