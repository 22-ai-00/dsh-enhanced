import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { linuxPluginBehaviorRuntimeDigest, type LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { CreationCapabilityJournal } from '../src/creation-capability-journal.js'
import type { CreationCapabilityConfig } from '../src/creation-capability-types.js'
import { planEmptyAdoptionHandoff, applyEmptyAdoptionHandoff, verifyEmptyAdoptionHandoff } from '../src/creation-capability-empty-handoff.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const d = (letter: string) => letter.repeat(64)
function fixture(maxAdoptions = 2, maxCalls = 3) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'creation-capability-')); roots.push(root); chmodSync(root, 0o700)
  const signing = generateKeyPairSync('ed25519'), verifier = generateKeyPairSync('ed25519')
  const keyPath = join(root, 'adoption.key')
  writeFileSync(keyPath, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const config: CreationCapabilityConfig = {
    authorityId: 'owner-adoption', keyId: 'adoption-key', keyPath,
    owner: { authorityId: 'owner', authorityHash: d('a'), principalId: 'provider/account/tenant/user',
      principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'default' },
    namePrefix: 'generated-', expiresAt: Date.now() + 120_000, maxAdoptions, maxTools: 2,
    maxCallsPerAdoption: maxCalls, maxCallRecords: maxCalls, maxInputBytes: 1024,
    runner: { stateRoot: root, image: `runner@sha256:${d('a')}`, dockerPath: '/usr/bin/docker',
      expiresAt: Date.now() + 120_000, maxRuns: 5, maxTotalDurationMs: 30_000,
      maxDurationMs: 10_000, maxOutputBytes: 65536 },
  }
  const path = join(root, 'creation-adoptions.sqlite')
  const artifact = Buffer.from('exact candidate tarball')
  function certificate(planId: string, lifetimeMs = 90_000, schemaDigest = d('5')): PluginCreationVerificationCertificate {
    const now = Date.now()
    const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
      protocol: 'assistant-growth/creation-verification/v1', verificationId: `verification-${planId}`,
      authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'independent-verifier',
        keyId: 'verifier-key', authorityDigest: d('b'), namePrefix: 'generated-', expiresAt: now + 120_000 },
      plan: { id: planId, digest: d('c'), name: `generated-${planId}`, sourceTreeDigest: d('d'),
        sourcePatchDigest: d('e'), artifactSha256: createHash('sha256').update(artifact).digest('hex'),
        artifactBytes: artifact.length, generatorDigest: d('f') },
      source: { referenceDigest: d('1'), ownerDigest: d('2'), growthRunDigest: d('3') },
      contractDigest: d('4'), schemaDigest, environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
      model: { provider: 'fixture', model: 'test' }, budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
      sessions: { contract: 'contract-session', sourceReview: 'review-session' },
      observations: [{ caseId: 'first', jobId: 'job-first', operationDigest: d('6'), observationDigest: d('7') },
        { caseId: 'second', jobId: 'job-second', operationDigest: d('8'), observationDigest: d('9') }],
      reviewDigest: d('0'), verifiedAt: now - 1000, expiresAt: now + lifetimeMs,
    }
    return { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), verifier.privateKey).toString('base64url') }
  }
  return { root, config, path, artifact, certificate, signing, verifier }
}

function linuxFixture(maxAdoptions = 2, maxCalls = 3) {
  const f = fixture(maxAdoptions, maxCalls), runtimeRoot = join(f.root, 'observer-runtime')
  const runtime: LinuxPluginBehaviorRuntime = { schemaVersion: 1, runtime: {
    schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64',
    sourceCommit: '1'.repeat(40), lockSha256: d('a'), root: { path: runtimeRoot, dev: 1, ino: 2, sha256: d('b') },
    nodePath: join(runtimeRoot, 'bin/node'), nodeSha256: d('c'), pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'),
    nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'), nativePnpmRoot: join(runtimeRoot, 'pnpm-native'),
    modulesPath: join(runtimeRoot, 'node_modules'), storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' },
  }, observer: { schemaVersion: 1, sourceSha256: d('d'), workerSha256: d('e'), candidateSha256: d('f'),
    launcherSha256: d('0'), parentProtectSha256: d('1'), childProtectSha256: d('2') } }
  const config: CreationCapabilityConfig = { ...f.config, runner: {
    backend: 'linux-native', runtime, cgroupRoots: { mode: 'v1', cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000',
      freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
    stateRoot: f.root, expiresAt: f.config.runner.expiresAt, maxRuns: 5,
    maxTotalDurationMs: 30_000, maxDurationMs: 10_000, maxOutputBytes: 65536,
  } }
  const certificate = (planId: string, lifetimeMs = 90_000, schemaDigest = d('5')): PluginCreationVerificationCertificate => {
    const { signature: _signature, ...legacy } = f.certificate(planId, lifetimeMs, schemaDigest)
    const body: Omit<PluginCreationVerificationCertificate, 'signature'> = { ...legacy,
      protocol: 'assistant-growth/creation-verification/v3', execution: {
        boundary: 'linux-native-process-seccomp-v1', runtimeDigest: linuxPluginBehaviorRuntimeDigest(runtime),
        buildRuntimeDigest: d('6'), buildEvidenceDigest: d('7'), observerPreparationDigest: d('8'),
      } }
    return { ...body, signature: sign(null, Buffer.from(canonicalGrowthJson(body)), f.verifier.privateKey).toString('base64url') }
  }
  return { ...f, oldConfig: f.config, config, runtime, legacyCertificate: f.certificate, certificate }
}


function staged() {
  const f = linuxFixture()
  new CreationCapabilityJournal({ path: f.path, config: f.oldConfig }).close()
  const stage = join(f.root, 'stage'); mkdirSync(stage, { mode: 0o700 })
  const physicalPath = join(stage, 'creation-adoptions.sqlite'); copyFileSync(f.path, physicalPath)
  const now = Date.now(), scope = { physicalPath, logicalPath: f.path, transactionId: 'stopped-transaction-1',
    hostAnchor: d('e'), oldConfig: f.oldConfig, nextConfig: f.config, now, expiresAt: now + 30_000 }
  return { ...f, physicalPath, scope }
}
const apply = (plan: ReturnType<typeof planEmptyAdoptionHandoff>, now = plan.createdAt) =>
  applyEmptyAdoptionHandoff(plan, { now, expectedPlanDigest: plan.digest, expectedHostAnchor: plan.hostAnchor })
function mutate(file: string, sql: string) { const db = new DatabaseSync(file); try { db.exec(sql) } finally { db.close() } }
function counts(file: string) { const uri = pathToFileURL(file); uri.searchParams.set('mode', 'ro'); uri.searchParams.set('immutable', '1'); const db = new DatabaseSync(uri, { readOnly: true }); try {
  return ['authority', 'adoptions', 'calls', 'source_archives'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)
} finally { db.close() } }

test('existing-only plan and same-transaction empty CAS preserve the grant and immutable proof', () => {
  const f = staged(), original = readFileSync(f.physicalPath)
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.config })).toThrow()
  const plan = planEmptyAdoptionHandoff(f.scope)
  expect(Object.isFrozen(plan.oldIdentity.config.owner)).toBe(true)
  expect(readFileSync(f.physicalPath)).toEqual(original)
  const proof = apply(plan)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(proof.plan.oldIdentity.config).toEqual(f.oldConfig)
  expect(proof.plan.nextIdentity.config).toEqual(f.config)
  expect(proof.plan.oldIdentity.publicKey).toBe(proof.plan.nextIdentity.publicKey)
  expect(Object.isFrozen(proof.plan)).toBe(true)
  expect(apply(plan, plan.expiresAt + 1)).toEqual(proof) // read-only idempotent acknowledgement
  expect(verifyEmptyAdoptionHandoff({ physicalPath: f.physicalPath, plan, expectedProofDigest: proof.digest })).toEqual(proof)
  expect(() => mutate(f.physicalPath, 'DELETE FROM creation_empty_authority_handoff')).toThrow('immutable')
  expect(() => mutate(f.physicalPath, "UPDATE creation_empty_authority_handoff SET proof_digest='" + d('f') + "'" )).toThrow('immutable')
})

test('rename verifies on the same inode and ordinary current constructor opens only after cutover', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope), proof = apply(plan)
  renameSync(f.path, f.path + '.old'); renameSync(f.physicalPath, f.path)
  expect(verifyEmptyAdoptionHandoff({ physicalPath: f.path, plan, expectedProofDigest: proof.digest })).toEqual(proof)
  new CreationCapabilityJournal({ path: f.path, config: f.config }).close()
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })).toThrow()
  expect(counts(f.path)).toEqual([1, 0, 0, 0])
})

test('rejects copies and untrusted external proof or plan anchors', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope)
  expect(() => applyEmptyAdoptionHandoff(plan, { now: plan.createdAt, expectedPlanDigest: d('f'), expectedHostAnchor: plan.hostAnchor })).toThrow('anchor')
  expect(() => applyEmptyAdoptionHandoff(plan, { now: plan.createdAt, expectedPlanDigest: plan.digest, expectedHostAnchor: d('f') })).toThrow('anchor')
  const proof = apply(plan), copied = join(f.root, 'copied'); mkdirSync(copied, { mode: 0o700 })
  const target = join(copied, 'creation-adoptions.sqlite'); copyFileSync(f.physicalPath, target)
  expect(() => verifyEmptyAdoptionHandoff({ physicalPath: target, plan, expectedProofDigest: proof.digest })).toThrow('identity')
  expect(() => verifyEmptyAdoptionHandoff({ physicalPath: f.physicalPath, plan, expectedProofDigest: d('f') })).toThrow('anchor')
})

test.each(['maxAdoptions', 'maxTools', 'maxCallsPerAdoption', 'maxCallRecords', 'maxInputBytes', 'expiresAt', 'keyId', 'namePrefix', 'owner', 'retention'])(
  'rejects stable %s changes', field => {
    const f = staged(), config = structuredClone(f.config) as unknown as Record<string, unknown>
    if (field === 'owner') config.owner = { ...f.config.owner, principalVersion: 2 }
    else if (field === 'retention') config.retention = { maximumLifetimeMs: 1000 }
    else if (typeof config[field] === 'number') config[field] = Number(config[field]) + 1
    else config[field] = field === 'namePrefix' ? 'other-' : 'other-key'
    expect(() => planEmptyAdoptionHandoff({ ...f.scope, nextConfig: config as unknown as CreationCapabilityConfig })).toThrow()
  })

test.each(['expiresAt', 'maxRuns', 'maxTotalDurationMs', 'maxDurationMs', 'stateRoot'])(
  'rejects runner stable %s changes', field => {
    const f = staged(), config = structuredClone(f.config)
    Object.assign(config.runner, { [field]: field === 'stateRoot' ? f.scope.oldConfig.keyPath : Number((config.runner as unknown as Record<string, unknown>)[field]) + 1 })
    expect(() => planEmptyAdoptionHandoff({ ...f.scope, nextConfig: config })).toThrow()
  })

test.each(['claimed','authorized','active','closed','unknown','rejected'])('rejects every adoption status including %s', status => {
  const f = staged()
  mutate(f.physicalPath, `PRAGMA ignore_check_constraints=ON; INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha) VALUES ('old','${status}','{}','${d('a')}',X'01','${d('b')}')`)
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow('nonempty')
})

test.each(['calls','source_archives'])('rejects %s even if the other business tables look empty', table => {
  const f = staged()
  mutate(f.physicalPath, 'PRAGMA foreign_keys=OFF;' + (table === 'calls'
    ? `INSERT INTO calls(plan_id,call_key,arguments_digest,status) VALUES ('orphan','key','${d('a')}','unknown')`
    : "INSERT INTO source_archives VALUES ('orphan','{}')"))
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow()
})

test.each(['authority','business','schema','header','bytes','copy','sidecar','permissions'])('rejects %s drift between plan and apply without accepting the next authority', mutation => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope)
  if (mutation === 'authority') mutate(f.physicalPath, `UPDATE authority SET authority_digest='${d('f')}'`)
  if (mutation === 'business') mutate(f.physicalPath, `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('old','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`)
  if (mutation === 'schema') mutate(f.physicalPath, 'CREATE TABLE alien (x)')
  if (mutation === 'header') mutate(f.physicalPath, 'PRAGMA user_version=2')
  if (mutation === 'bytes') mutate(f.physicalPath, 'PRAGMA user_version=3; VACUUM')
  if (mutation === 'copy') { renameSync(f.physicalPath, f.physicalPath + '.before'); copyFileSync(f.physicalPath + '.before', f.physicalPath) }
  if (mutation === 'sidecar') writeFileSync(f.physicalPath + '-wal', '', { mode: 0o600 })
  if (mutation === 'permissions') chmodSync(f.physicalPath, 0o644)
  expect(() => apply(plan)).toThrow()
})

test('missing file, relative path, parent alias, extra authority and stale plan fail closed', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope)
  expect(() => apply(plan, plan.expiresAt + 1)).toThrow('stale')
  const missing = join(f.root, 'absent', 'creation-adoptions.sqlite')
  expect(() => planEmptyAdoptionHandoff({ ...f.scope, physicalPath: missing })).toThrow()
  expect(existsSync(missing)).toBe(false)
  expect(() => planEmptyAdoptionHandoff({ ...f.scope, physicalPath: 'relative' })).toThrow()
  const alias = join(f.root, 'alias'); symlinkSync(join(f.root, 'stage'), alias, 'dir')
  expect(() => planEmptyAdoptionHandoff({ ...f.scope, physicalPath: join(alias, 'creation-adoptions.sqlite') })).toThrow()
  mutate(f.physicalPath, "INSERT INTO authority SELECT 'another',authority_digest,key_id,public_key,config_json FROM authority")
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow('singleton')
})


test.each(['authority_id','authority_digest','key_id','public_key','config_json'])('rejects hidden NUL bytes in authority %s before trusting its projected value', column => {
  const f = staged()
  mutate(f.physicalPath, `PRAGMA ignore_check_constraints=ON; UPDATE authority SET ${column}=CAST(CAST(${column} AS BLOB)||X'0068696464656e' AS TEXT)`)
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow('text bytes')
})

test('rejects invalid UTF-8 authority bytes and NUL-hidden sqlite_schema SQL', () => {
  const f = staged()
  mutate(f.physicalPath, "UPDATE authority SET key_id=CAST(X'ff' AS TEXT)")
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow('UTF-8')
  const other = staged()
  // Inject a literal NUL into the on-disk schema without relying on writable_schema
  // (newer Node builds deliberately forbid that pragma). No fixture length changes.
  const image = readFileSync(other.physicalPath)
  const start = image.indexOf(Buffer.from('CREATE TABLE authority ('))
  const tail = image.indexOf(Buffer.from(', WITHOUT ROWID'), start)
  expect(start).toBeGreaterThan(0); expect(tail).toBeGreaterThan(start)
  image[tail] = 0
  writeFileSync(other.physicalPath, image)
  expect(() => planEmptyAdoptionHandoff(other.scope)).toThrow()
})

test('rejects raw audit NUL bytes even if a tamperer restores the immutable trigger schema', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope), proof = apply(plan)
  mutate(f.physicalPath, `DROP TRIGGER creation_empty_handoff_no_update;
    UPDATE creation_empty_authority_handoff SET proof_json=CAST(CAST(proof_json AS BLOB)||X'0068696464656e' AS TEXT);
    CREATE TRIGGER creation_empty_handoff_no_update BEFORE UPDATE ON creation_empty_authority_handoff BEGIN SELECT RAISE(ABORT,'immutable empty authority handoff'); END`)
  expect(() => verifyEmptyAdoptionHandoff({ physicalPath: f.physicalPath, plan, expectedProofDigest: proof.digest })).toThrow('text bytes')
})

test('later business rows cannot qualify for stopped empty acceptance, apply retry or a new plan', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope), proof = apply(plan)
  mutate(f.physicalPath, `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('later','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`)
  expect(() => verifyEmptyAdoptionHandoff({ physicalPath: f.physicalPath, plan, expectedProofDigest: proof.digest })).toThrow('nonempty')
  expect(() => apply(plan)).toThrow('nonempty')
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow()
})

test.each(['-wal','-shm','-journal'])('rejects a stopped snapshot carrying %s before reading it', suffix => {
  const f = staged(); writeFileSync(f.physicalPath + suffix, '', { mode: 0o600 })
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow('sidecar')
})

test('binds actual existing keys and bounded runner expiry without generating replacement keys', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope)
  const old = readFileSync(f.config.keyPath)
  writeFileSync(f.config.keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  expect(() => apply(plan)).toThrow()
  writeFileSync(f.config.keyPath, old)
  const expiring = structuredClone(f.scope)
  expiring.oldConfig.runner.expiresAt = expiring.now + 1000
  expiring.nextConfig.runner.expiresAt = expiring.now + 1000
  expect(() => planEmptyAdoptionHandoff(expiring)).toThrow('invalid plan')
  expect(readFileSync(f.config.keyPath)).toEqual(old)
})


test.each(['table','trigger'])('rejects hidden sqliteX %s objects before writing', kind => {
  const f = staged()
  mutate(f.physicalPath, kind === 'table' ? 'CREATE TABLE sqliteXshadow (value TEXT)'
    : "CREATE TRIGGER sqliteXtrigger AFTER UPDATE ON authority BEGIN DELETE FROM adoptions; END")
  const before = readFileSync(f.physicalPath)
  expect(() => planEmptyAdoptionHandoff(f.scope)).toThrow('schema')
  expect(readFileSync(f.physicalPath)).toEqual(before)
})

test('rejects unknown plan fields even when a caller recomputes its self digest', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope)
  const { digest: _digest, ...body } = plan
  const altered = { ...body, extra: true }
  const candidate = { ...altered, digest: createHash('sha256').update(canonicalGrowthJson(altered)).digest('hex') }
  expect(() => apply(candidate)).toThrow('unexpected fields')
})


test('never plans direct mutation of the logical source and validates retry time', () => {
  const f = staged()
  expect(() => planEmptyAdoptionHandoff({ ...f.scope, physicalPath: f.path })).toThrow('separate')
  const plan = planEmptyAdoptionHandoff(f.scope); apply(plan)
  for (const value of [NaN, -1, plan.createdAt - 1, 'later']) {
    expect(() => apply(plan, value as number)).toThrow('time')
  }
})


test('rolls back an already executed authority CAS when the audit write fails, then retries the original plan once', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope), before = readFileSync(f.physicalPath)
  const original = DatabaseSync.prototype.exec
  const fault = new Error('injected failure after authority CAS before audit DDL')
  let sawNextAuthorityInsideTransaction = false
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('CREATE TABLE creation_empty_authority_handoff')) {
      sawNextAuthorityInsideTransaction = canonicalGrowthJson(this.prepare('SELECT * FROM authority').get())
        === canonicalGrowthJson({ authority_id: plan.nextIdentity.config.authorityId,
          authority_digest: plan.nextIdentity.authorityDigest, key_id: plan.nextIdentity.config.keyId,
          public_key: plan.nextIdentity.publicKey, config_json: canonicalGrowthJson(plan.nextIdentity.config) })
      throw fault
    }
    return original.call(this, sql)
  })
  try { expect(() => apply(plan)).toThrow(fault) } finally { exec.mockRestore() }
  expect(sawNextAuthorityInsideTransaction).toBe(true)
  expect(readFileSync(f.physicalPath)).toEqual(before)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  const unchanged = planEmptyAdoptionHandoff(f.scope)
  expect(unchanged.oldIdentity).toEqual(plan.oldIdentity)
  expect(unchanged.snapshot).toEqual(plan.snapshot)
  const proof = apply(plan)
  expect(apply(plan)).toEqual(proof)
  expect(verifyEmptyAdoptionHandoff({ physicalPath: f.physicalPath, plan, expectedProofDigest: proof.digest })).toEqual(proof)
})

test('rejects a different transaction rehashed over the original empty snapshot after one successful CAS', () => {
  const f = staged(), plan = planEmptyAdoptionHandoff(f.scope), proof = apply(plan)
  const { digest: _digest, ...original } = plan
  const body = { ...original, transactionId: 'another-transaction' }
  const other = { ...body, digest: createHash('sha256').update(canonicalGrowthJson(body)).digest('hex') }
  expect(() => apply(other)).toThrow('proof mismatch')
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(verifyEmptyAdoptionHandoff({ physicalPath: f.physicalPath, plan, expectedProofDigest: proof.digest })).toEqual(proof)
})
