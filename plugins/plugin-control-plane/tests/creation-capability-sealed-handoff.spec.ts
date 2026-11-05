import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs, { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { linuxPluginBehaviorRuntimeDigest, type LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { CreationCapabilityJournal, creationCapabilityAuthorityDigest } from '../src/creation-capability-journal.js'
import { creationCapabilitySourceDigest, type CreationCapabilitySourceSnapshot } from '../src/creation-capability-source.js'
import type { CreationCapabilityConfig, CreationCapabilityTool } from '../src/creation-capability-types.js'
import { planSealedAdoptionHandoff, applySealedAdoptionHandoff, verifySealedAdoptionHandoff,
  readSealedAdoptionHandoffDigest } from '../src/creation-capability-sealed-handoff.js'
import { planEmptyAdoptionHandoff, applyEmptyAdoptionHandoff } from '../src/creation-capability-empty-handoff.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const d = (letter: string) => letter.repeat(64)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const tools: CreationCapabilityTool[] = [{ originalName: 'echo', name: 'generated_echo', description: 'Echo', parameters: { type: 'object' } }]

function linuxFixture(maxAdoptions = 8, maxCalls = 8) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'creation-capability-')); roots.push(root); chmodSync(root, 0o700)
  const signing = generateKeyPairSync('ed25519'), verifier = generateKeyPairSync('ed25519')
  const keyPath = join(root, 'adoption.key')
  writeFileSync(keyPath, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const oldConfig: CreationCapabilityConfig = {
    authorityId: 'owner-adoption', keyId: 'adoption-key', keyPath,
    owner: { authorityId: 'owner', authorityHash: d('a'), principalId: 'provider/account/tenant/user',
      principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'default' },
    namePrefix: 'generated-', expiresAt: Date.now() + 120_000, maxAdoptions, maxTools: 2,
    maxCallsPerAdoption: maxCalls, maxCallRecords: maxCalls, maxInputBytes: 1024,
    runner: { stateRoot: root, image: `runner@sha256:${d('a')}`, dockerPath: '/usr/bin/docker',
      expiresAt: Date.now() + 120_000, maxRuns: 5, maxTotalDurationMs: 30_000,
      maxDurationMs: 10_000, maxOutputBytes: 65536 },
  }
  const path = join(root, 'creation-adoptions.sqlite'), artifact = Buffer.from('exact candidate tarball')
  function legacy(planId: string, treeDigest = d('d')): PluginCreationVerificationCertificate {
    const now = Date.now()
    const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
      protocol: 'assistant-growth/creation-verification/v1', verificationId: `verification-${planId}`,
      authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'independent-verifier',
        keyId: 'verifier-key', authorityDigest: d('b'), namePrefix: 'generated-', expiresAt: now + 120_000 },
      plan: { id: planId, digest: d('c'), name: `generated-${planId}`, sourceTreeDigest: treeDigest,
        sourcePatchDigest: d('e'), artifactSha256: sha(artifact), artifactBytes: artifact.length, generatorDigest: d('f') },
      source: { referenceDigest: d('1'), ownerDigest: d('2'), growthRunDigest: d('3') },
      contractDigest: d('4'), schemaDigest: d('5'), environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
      model: { provider: 'fixture', model: 'test' }, budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
      sessions: { contract: 'contract-session', sourceReview: 'review-session' },
      observations: [{ caseId: 'first', jobId: 'job-first', operationDigest: d('6'), observationDigest: d('7') },
        { caseId: 'second', jobId: 'job-second', operationDigest: d('8'), observationDigest: d('9') }],
      reviewDigest: d('0'), verifiedAt: now - 1000, expiresAt: now + 90_000,
    }
    return { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), verifier.privateKey).toString('base64url') }
  }
  const runtimeRoot = join(root, 'observer-runtime')
  const runtime: LinuxPluginBehaviorRuntime = { schemaVersion: 1, runtime: {
    schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64',
    sourceCommit: '1'.repeat(40), lockSha256: d('a'), root: { path: runtimeRoot, dev: 1, ino: 2, sha256: d('b') },
    nodePath: join(runtimeRoot, 'bin/node'), nodeSha256: d('c'), pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'),
    nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'), nativePnpmRoot: join(runtimeRoot, 'pnpm-native'),
    modulesPath: join(runtimeRoot, 'node_modules'), storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' },
  }, observer: { schemaVersion: 1, sourceSha256: d('d'), workerSha256: d('e'), candidateSha256: d('f'),
    launcherSha256: d('0'), parentProtectSha256: d('1'), childProtectSha256: d('2') } }
  const config: CreationCapabilityConfig = { ...oldConfig, runner: {
    backend: 'linux-native', runtime, cgroupRoots: { mode: 'v1', cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000',
      freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
    stateRoot: root, expiresAt: oldConfig.runner.expiresAt, maxRuns: 5,
    maxTotalDurationMs: 30_000, maxDurationMs: 10_000, maxOutputBytes: 65536,
  } }
  const certificate = (planId: string): PluginCreationVerificationCertificate => {
    const { signature: _signature, ...body0 } = legacy(planId)
    const body: Omit<PluginCreationVerificationCertificate, 'signature'> = { ...body0,
      protocol: 'assistant-growth/creation-verification/v3', execution: {
        boundary: 'linux-native-process-seccomp-v1', runtimeDigest: linuxPluginBehaviorRuntimeDigest(runtime),
        buildRuntimeDigest: d('6'), buildEvidenceDigest: d('7'), observerPreparationDigest: d('8'),
      } }
    return { ...body, signature: sign(null, Buffer.from(canonicalGrowthJson(body)), verifier.privateKey).toString('base64url') }
  }
  function archived(planId: string) {
    const name = `generated-${planId}`, baseCommit = '1'.repeat(40), content = 'export const answer = 42\n'
    const file = `plugins/${name}/src/index.ts`, bytes = Buffer.from(content)
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const scope = [`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'].sort()
    const entries = [{ path: 'plugins/README.md', mode: '100644' as const, oid: '2'.repeat(40) },
      { path: file, mode: '100644' as const, oid }, { path: 'pnpm-lock.yaml', mode: '100644' as const, oid: '3'.repeat(40) }]
    const treeDigest = createHash('sha256').update(`dsh-source-tree-v2\0${baseCommit}\0${JSON.stringify(scope)}\0`)
      .update(entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join('')).digest('hex')
    const payload: Omit<CreationCapabilitySourceSnapshot, 'digest'> = { protocol: 'dsh-created-capability-source/v1',
      baseCommit, scope, treeDigest, patchDigest: d('e'), entries,
      files: [{ path: file, mode: '100644', oid, bytes: bytes.length, sha256: sha(bytes), content }] }
    return { source: { ...payload, digest: creationCapabilitySourceDigest(payload) }, certificate: legacy(planId, treeDigest) }
  }
  return { root, path, artifact, oldConfig, config, legacy, certificate, archived, verifier }
}
type Fixture = ReturnType<typeof linuxFixture>

/** Settled history through the real Docker journal API: active (2 completed calls, signed source),
 * closed (1 completed call), rejected. */
function seedSettled(f: Fixture) {
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })
  try {
    const { source, certificate } = f.archived('active')
    journal.claim({ certificate, artifact: f.artifact, source }); journal.authorize('active', tools); journal.activate('active')
    for (const key of ['one', 'two']) {
      journal.claimCall({ planId: 'active', key, argumentsDigest: d('a') })
      journal.settleCall({ planId: 'active', key, status: 'completed', result: { key } })
    }
    journal.claim({ certificate: f.legacy('closed'), artifact: f.artifact }); journal.authorize('closed', tools); journal.activate('closed')
    journal.claimCall({ planId: 'closed', key: 'done', argumentsDigest: d('b') })
    journal.settleCall({ planId: 'closed', key: 'done', status: 'completed', result: 'ok' })
    journal.settle('closed', 'closed', 'owner-closed')
    journal.claim({ certificate: f.legacy('rejected'), artifact: f.artifact }); journal.settle('rejected', 'rejected', 'source-drift')
  } finally { journal.close() }
}
/** Unsettled history that a crash can leave behind; nothing here can be reconciled. */
function seedUnsettled(f: Fixture) {
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })
  try {
    journal.claim({ certificate: f.legacy('claimed'), artifact: f.artifact })
    journal.claim({ certificate: f.legacy('authorized'), artifact: f.artifact }); journal.authorize('authorized', tools)
    journal.claim({ certificate: f.legacy('unknown'), artifact: f.artifact }); journal.settle('unknown', 'unknown', 'runner-lost')
    journal.claim({ certificate: f.legacy('calls'), artifact: f.artifact }); journal.authorize('calls', tools); journal.activate('calls')
    journal.claimCall({ planId: 'calls', key: 'pending', argumentsDigest: d('a') })
    journal.claimCall({ planId: 'calls', key: 'lost', argumentsDigest: d('b') })
    journal.settleCall({ planId: 'calls', key: 'lost', status: 'unknown' })
  } finally { journal.close() }
}
function staged(seed: ((f: Fixture) => void) | null = seedSettled, maxAdoptions = 8, maxCalls = 8) {
  const f = linuxFixture(maxAdoptions, maxCalls)
  if (seed) seed(f); else new CreationCapabilityJournal({ path: f.path, config: f.oldConfig }).close()
  for (const suffix of ['-wal', '-shm']) rmSync(f.path + suffix, { force: true })
  const stage = join(f.root, 'stage'); mkdirSync(stage, { mode: 0o700 })
  const physicalPath = join(stage, 'creation-adoptions.sqlite'); copyFileSync(f.path, physicalPath)
  const oldDigest = creationCapabilityAuthorityDigest({ path: f.path, config: f.oldConfig })
  const archiveLogicalPath = join(f.root, 'creation-adoptions.sealed', `${oldDigest}.sqlite`)
  const archivePhysicalPath = join(stage, 'creation-adoptions.sealed', `${oldDigest}.sqlite`)
  const now = Date.now(), scope = { physicalPath, logicalPath: f.path, archiveLogicalPath, archivePhysicalPath,
    transactionId: 'stopped-transaction-1', hostAnchor: d('e'), oldConfig: f.oldConfig, nextConfig: f.config, now, expiresAt: now + 30_000 }
  return { ...f, stage, physicalPath, archivePhysicalPath, archiveLogicalPath, oldDigest, scope }
}
type Staged = ReturnType<typeof staged>
const apply = (plan: ReturnType<typeof planSealedAdoptionHandoff>, now = plan.createdAt) =>
  applySealedAdoptionHandoff(plan, { now, expectedPlanDigest: plan.digest, expectedHostAnchor: plan.hostAnchor })
const verify = (f: Staged, plan: ReturnType<typeof planSealedAdoptionHandoff>, digest: string,
  physicalPath = f.physicalPath, archivePhysicalPath = f.archivePhysicalPath) =>
  verifySealedAdoptionHandoff({ physicalPath, archivePhysicalPath, plan, expectedProofDigest: digest })
function mutate(file: string, sql: string) { const db = new DatabaseSync(file); try { db.exec(sql) } finally { db.close() } }
function counts(file: string) { const uri = pathToFileURL(file); uri.searchParams.set('mode', 'ro'); uri.searchParams.set('immutable', '1'); const db = new DatabaseSync(uri, { readOnly: true }); try {
  return ['authority', 'adoptions', 'calls', 'source_archives'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)
} finally { db.close() } }
/** Same-inode cutover of the sealed stage into the logical location. */
function cutover(f: Staged) {
  renameSync(f.path, f.path + '.old')
  renameSync(f.physicalPath, f.path); renameSync(dirname(f.archivePhysicalPath), dirname(f.archiveLogicalPath))
}

test('seals settled Docker history into an exact 0400 archive and leaves a same-inode empty live journal', () => {
  const f = staged(), original = readFileSync(f.physicalPath), inode = lstatSync(f.physicalPath).ino
  const plan = planSealedAdoptionHandoff(f.scope)
  expect(Object.isFrozen(plan.history.rows)).toBe(true)
  expect(readFileSync(f.physicalPath)).toEqual(original)
  expect(plan.history.counts).toEqual({ adoptions: 3, calls: 3, sourceArchives: 1 })
  expect(plan.history.byStatus).toEqual({ active: 1, closed: 1, rejected: 1, unknown: 0 })
  expect(plan.history.rows.map(row => [row.planId, row.status, row.reason, row.callCount, row.completedCalls, row.unknownCalls,
    row.sourceArchiveDigest !== null, row.receiptDigest !== null])).toEqual([
    ['active', 'active', null, 2, 2, 0, true, true], ['closed', 'closed', 'owner-closed', 1, 1, 0, false, true],
    ['rejected', 'rejected', 'source-drift', 0, 0, 0, false, false]])
  expect(plan.history.rows.every(row => row.certificate.protocol === 'assistant-growth/creation-verification/v1')).toBe(true)
  expect(plan.pendingReverification.map(row => row.planId)).toEqual(['active'])
  expect(plan.inheritedUsage).toEqual({ adoptions: 3, calls: 3 })
  expect(existsSync(f.archivePhysicalPath)).toBe(false)

  const proof = apply(plan)
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(lstatSync(f.archivePhysicalPath).mode & 0o777).toBe(0o400)
  expect(lstatSync(dirname(f.archivePhysicalPath)).mode & 0o777).toBe(0o700)
  expect(proof.archive).toMatchObject({ logicalPath: f.archiveLogicalPath, bytes: original.length, digest: sha(original), mode: 0o400 })
  expect(lstatSync(f.physicalPath).ino).toBe(inode)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(proof.liveBusiness).toEqual({ adoptions: 0, calls: 0, sourceArchives: 0 })
  expect(proof.inheritedUsage).toEqual({ adoptions: 3, calls: 3 })
  expect(apply(plan, plan.expiresAt + 1)).toEqual(proof) // read-only acknowledgement
  expect(verify(f, plan, proof.digest)).toEqual(proof)
  expect(() => mutate(f.physicalPath, 'DELETE FROM creation_sealed_adoption_handoff')).toThrow('immutable')
  expect(() => mutate(f.physicalPath, `UPDATE creation_sealed_adoption_handoff SET proof_digest='${d('f')}'`)).toThrow('immutable')

  cutover(f)
  expect(verify(f, plan, proof.digest, f.path, f.archiveLogicalPath)).toEqual(proof)
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })).toThrow()
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(journal.list()).toEqual([])
    expect(journal.usage()).toEqual({ adoptions: 3, calls: 3 })
  } finally { journal.close() }
})

test('unsettled adoptions and calls are sealed as unknown, never pending and always counted', () => {
  const f = staged(seedUnsettled), plan = planSealedAdoptionHandoff(f.scope)
  expect(plan.history.counts).toEqual({ adoptions: 4, calls: 2, sourceArchives: 0 })
  expect(plan.history.byStatus).toEqual({ active: 1, closed: 0, rejected: 0, unknown: 3 })
  expect(Object.fromEntries(plan.history.rows.map(row => [row.planId, [row.originalStatus, row.status]]))).toEqual({
    authorized: ['authorized', 'unknown'], calls: ['active', 'active'], claimed: ['claimed', 'unknown'], unknown: ['unknown', 'unknown'] })
  expect(plan.history.rows.find(row => row.planId === 'calls')).toMatchObject({ callCount: 2, completedCalls: 0, unknownCalls: 2 })
  expect(plan.pendingReverification.map(row => row.planId)).toEqual(['calls'])
  expect(plan.inheritedUsage).toEqual({ adoptions: 4, calls: 2 })
  const proof = apply(plan)
  expect(proof.inheritedUsage).toEqual({ adoptions: 4, calls: 2 })
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
})

test('refuses empty history and directs the caller to the empty handoff', () => {
  const f = staged(null)
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('empty adoption handoff')
})

test('refuses an active row whose receipt no longer verifies under the old authority', () => {
  const f = staged(), db = new DatabaseSync(f.physicalPath)
  try {
    const row = db.prepare("SELECT receipt_json FROM adoptions WHERE plan_id='active'").get() as { receipt_json: string }
    const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>
    const { signature: _signature, ...body } = receipt
    receipt.signature = sign(null, Buffer.from(canonicalGrowthJson(body)), generateKeyPairSync('ed25519').privateKey).toString('base64url')
    db.prepare("UPDATE adoptions SET receipt_json=? WHERE plan_id='active'").run(canonicalGrowthJson(receipt))
  } finally { db.close() }
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('receipt')
})

test('refuses an active row carrying a non-Docker certificate protocol', () => {
  const f = staged(), certificate = canonicalGrowthJson(f.certificate('active'))
  const db = new DatabaseSync(f.physicalPath)
  try { db.prepare("UPDATE adoptions SET certificate_json=?,certificate_digest=? WHERE plan_id='active'").run(certificate, sha(certificate)) }
  finally { db.close() }
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('Docker v1')
})

test.each(['adoptions', 'calls'])('refuses %s above the grant limits', table => {
  const f = staged(seedSettled, 3, 3)
  mutate(f.physicalPath, table === 'adoptions'
    ? `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('extra','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`
    : `INSERT INTO calls(plan_id,call_key,arguments_digest,status) VALUES ('closed','extra','${d('a')}','unknown')`)
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('limits')
})

test.each(['authority','business','schema','bytes','copy','sidecar','permissions'])('rejects %s drift before archiving or swapping authority', mutation => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  if (mutation === 'authority') mutate(f.physicalPath, `UPDATE authority SET authority_digest='${d('f')}'`)
  if (mutation === 'business') mutate(f.physicalPath, `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('later','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`)
  if (mutation === 'schema') mutate(f.physicalPath, 'CREATE TABLE alien (x)')
  if (mutation === 'bytes') mutate(f.physicalPath, 'PRAGMA user_version=3; VACUUM')
  if (mutation === 'copy') { renameSync(f.physicalPath, f.physicalPath + '.before'); copyFileSync(f.physicalPath + '.before', f.physicalPath) }
  if (mutation === 'sidecar') writeFileSync(f.physicalPath + '-wal', '', { mode: 0o600 })
  if (mutation === 'permissions') chmodSync(f.physicalPath, 0o644)
  expect(() => apply(plan)).toThrow()
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  if (mutation === 'sidecar') rmSync(f.physicalPath + '-wal')
  if (mutation === 'permissions') chmodSync(f.physicalPath, 0o600)
  expect(counts(f.physicalPath)[0]).toBe(1)
  expect(() => new CreationCapabilityJournal({ path: f.physicalPath, config: f.config })).toThrow()
})

test('archive paths must be the exact sealed placement for the old authority', () => {
  const f = staged(), other = join(f.root, 'creation-adoptions.sealed', `${d('0')}.sqlite`)
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archiveLogicalPath: other })).toThrow('placement')
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archivePhysicalPath: join(f.root, 'creation-adoptions.sealed', `${f.oldDigest}.sqlite`) })).toThrow('placement')
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archivePhysicalPath: `${f.stage}/creation-adoptions.sealed/../${f.oldDigest}.sqlite` })).toThrow()
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archiveLogicalPath: 'relative.sqlite' })).toThrow()
})

test('a pre-existing different archive is rejected and an identical one is accepted', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  mkdirSync(dirname(f.archivePhysicalPath), { mode: 0o700 })
  writeFileSync(f.archivePhysicalPath, 'other bytes', { mode: 0o400 })
  expect(() => apply(plan)).toThrow('differs')
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])
  rmSync(f.archivePhysicalPath)
  copyFileSync(f.physicalPath, f.archivePhysicalPath); chmodSync(f.archivePhysicalPath, 0o400)
  const proof = apply(plan)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('a failure between archive write and commit rolls back the live journal and the original plan retries once', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), before = readFileSync(f.physicalPath)
  const original = DatabaseSync.prototype.exec, fault = new Error('injected failure after archive write')
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('DELETE FROM calls')) throw fault
    return original.call(this, sql)
  })
  try { expect(() => apply(plan)).toThrow(fault) } finally { exec.mockRestore() }
  expect(readFileSync(f.archivePhysicalPath)).toEqual(before)
  expect(readFileSync(f.physicalPath)).toEqual(before)
  const proof = apply(plan)
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('verify rejects later business, archive chmod, rewrite or replacement and an untrusted proof digest', () => {
  const run = (change: (f: Staged) => void, message?: string) => {
    const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
    change(f)
    if (message) expect(() => verify(f, plan, proof.digest)).toThrow(message)
    else expect(() => verify(f, plan, proof.digest)).toThrow()
  }
  run(f => mutate(f.physicalPath, `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('later','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`), 'nonempty')
  run(f => chmodSync(f.archivePhysicalPath, 0o600), 'archive')
  run(f => { chmodSync(f.archivePhysicalPath, 0o600); writeFileSync(f.archivePhysicalPath, 'rewritten'); chmodSync(f.archivePhysicalPath, 0o400) }, 'archive')
  run(f => { const bytes = readFileSync(f.archivePhysicalPath); rmSync(f.archivePhysicalPath); writeFileSync(f.archivePhysicalPath, bytes, { mode: 0o400 }) }, 'archive identity')
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope); apply(plan)
  expect(() => verify(f, plan, d('f'))).toThrow('anchor')
})

test('a different transaction rehashed over the original snapshot cannot reuse the stored proof', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  const { digest: _digest, ...original } = plan
  const body = { ...original, transactionId: 'another-transaction' }
  const other = { ...body, digest: sha(canonicalGrowthJson(body)) }
  expect(() => apply(other)).toThrow('proof mismatch')
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

// Journal side: inherited usage is enforced at every limit and a damaged audit fails closed.
function sealedLive(seed: (f: Fixture) => void, maxAdoptions: number, maxCalls: number) {
  const f = staged(seed, maxAdoptions, maxCalls), plan = planSealedAdoptionHandoff(f.scope); apply(plan); cutover(f)
  return f
}

test('inherited usage blocks claim at the adoption limit', () => {
  const f = sealedLive(seedSettled, 4, 8)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(journal.usage()).toEqual({ adoptions: 3, calls: 3 })
    expect(journal.claim({ certificate: f.certificate('fresh'), artifact: f.artifact }).created).toBe(true)
    expect(journal.usage()).toEqual({ adoptions: 4, calls: 3 })
    expect(() => journal.claim({ certificate: f.certificate('over'), artifact: f.artifact })).toThrow()
    expect(journal.list().map(record => record.planId)).toEqual(['fresh'])
  } finally { journal.close() }
})

test('a sealed plan id is never claimable again under the next authority, even with budget left', () => {
  const f = sealedLive(seedSettled, 8, 8)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    for (const planId of ['active', 'closed', 'rejected']) {
      expect(() => journal.claim({ certificate: f.certificate(planId), artifact: f.artifact })).toThrow()
    }
    expect(journal.usage()).toEqual({ adoptions: 3, calls: 3 })
    expect(journal.claim({ certificate: f.certificate('active-reverified'), artifact: f.artifact }).created).toBe(true)
    expect(journal.list().map(record => record.planId)).toEqual(['active-reverified'])
  } finally { journal.close() }
})

test('inherited usage blocks claimCall at the call-record limit', () => {
  const f = sealedLive(seedSettled, 8, 4)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('fresh'), artifact: f.artifact }); journal.authorize('fresh', tools); journal.activate('fresh')
    expect(journal.claimCall({ planId: 'fresh', key: 'first', argumentsDigest: d('a') }).created).toBe(true)
    expect(journal.usage()).toEqual({ adoptions: 4, calls: 4 })
    expect(() => journal.claimCall({ planId: 'fresh', key: 'second', argumentsDigest: d('a') })).toThrow()
  } finally { journal.close() }
})

test.each(['drop-trigger', 'tamper-proof', 'tamper-usage', 'extra-object'])('journal fails closed on a %s sealed audit', kind => {
  const f = sealedLive(seedSettled, 8, 8)
  const restore = "CREATE TRIGGER creation_sealed_handoff_no_update BEFORE UPDATE ON creation_sealed_adoption_handoff BEGIN SELECT RAISE(ABORT,'immutable sealed adoption handoff'); END"
  if (kind === 'drop-trigger') mutate(f.path, 'DROP TRIGGER creation_sealed_handoff_no_delete')
  if (kind === 'tamper-proof') mutate(f.path, `DROP TRIGGER creation_sealed_handoff_no_update;
    UPDATE creation_sealed_adoption_handoff SET proof_json=CAST(CAST(proof_json AS BLOB)||X'0068696464656e' AS TEXT); ${restore}`)
  if (kind === 'tamper-usage') {
    // Recompute both self-digests so only the plan/history binding catches the refund.
    const db = new DatabaseSync(f.path)
    try {
      const proof = JSON.parse((db.prepare('SELECT proof_json FROM creation_sealed_adoption_handoff').get() as { proof_json: string }).proof_json)
      proof.inheritedUsage = { adoptions: 0, calls: 0 }
      const { digest: _digest, ...body } = proof
      proof.digest = sha(canonicalGrowthJson(body))
      db.exec('DROP TRIGGER creation_sealed_handoff_no_update')
      db.prepare('UPDATE creation_sealed_adoption_handoff SET proof_json=?,proof_digest=?').run(canonicalGrowthJson(proof), proof.digest)
      db.exec(restore)
    } finally { db.close() }
  }
  if (kind === 'extra-object') mutate(f.path, 'CREATE INDEX creation_sealed_extra ON creation_sealed_adoption_handoff(proof_digest)')
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.config })).toThrow()
})

test('journals without a sealed audit count only live rows, including empty-handoff journals', () => {
  const f = linuxFixture(8, 8)
  seedSettled(f)
  const plain = new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })
  try { expect(plain.usage()).toEqual({ adoptions: 3, calls: 3 }) } finally { plain.close() }
  const e = staged(null), plan = planEmptyAdoptionHandoff(e.scope)
  applyEmptyAdoptionHandoff(plan, { now: plan.createdAt, expectedPlanDigest: plan.digest, expectedHostAnchor: plan.hostAnchor })
  renameSync(e.path, e.path + '.old'); renameSync(e.physicalPath, e.path)
  const audited = new CreationCapabilityJournal({ path: e.path, config: e.config })
  try {
    expect(audited.usage()).toEqual({ adoptions: 0, calls: 0 })
    expect(audited.claim({ certificate: e.certificate('fresh'), artifact: e.artifact }).created).toBe(true)
    expect(audited.usage()).toEqual({ adoptions: 1, calls: 0 })
  } finally { audited.close() }
})

// Host cross-check: the journal alone cannot see an audit that was dropped as a whole.
test('readSealedAdoptionHandoffDigest returns the stored proof digest, also with later live business', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  const sealed = readFileSync(f.physicalPath)
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.physicalPath })).toBe(proof.digest)
  expect(readFileSync(f.physicalPath)).toEqual(sealed)
  // A stopped stage stays sidecar-free, so a later stopped verify still accepts it.
  for (const suffix of ['-wal', '-shm', '-journal']) expect(existsSync(f.physicalPath + suffix)).toBe(false)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
  cutover(f)
  const before = readFileSync(f.path)
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBe(proof.digest)
  expect(readFileSync(f.path)).toEqual(before)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('fresh'), artifact: f.artifact })
    // Live journal with WAL sidecars: an ordinary read-only connection sees the committed state.
    expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBe(proof.digest)
  } finally { journal.close() }
  const after = readFileSync(f.path)
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBe(proof.digest)
  expect(readFileSync(f.path)).toEqual(after)
})

test('readSealedAdoptionHandoffDigest returns null for a wholly dropped audit and throws on a partial one', () => {
  const f = sealedLive(seedSettled, 8, 8)
  mutate(f.path, 'DROP TRIGGER creation_sealed_handoff_no_delete')
  const before = readFileSync(f.path)
  expect(() => readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toThrow('unexpected audit schema')
  expect(readFileSync(f.path)).toEqual(before)
  mutate(f.path, 'DROP TRIGGER creation_sealed_handoff_no_update; DROP TABLE creation_sealed_adoption_handoff')
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBeNull()
  // The refund the Host must catch: the journal itself now sees no inherited usage.
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try { expect(journal.usage()).toEqual({ adoptions: 0, calls: 0 }) } finally { journal.close() }
  expect(() => readSealedAdoptionHandoffDigest({ physicalPath: 'relative/creation-adoptions.sqlite' })).toThrow('invalid path')
})

test('a failure mid archive write never leaves a partial final archive and the plan retries once', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  const original = fs.writeSync, fault = new Error('injected crash during archive write')
  ;(fs as { writeSync: unknown }).writeSync = (fd: number, buffer: Buffer, offset: number, length: number) => {
    original(fd, buffer, offset, Math.floor(length / 2)); throw fault
  }
  syncBuiltinESMExports()
  try { expect(() => apply(plan)).toThrow(fault) } finally { fs.writeSync = original; syncBuiltinESMExports() }
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  expect(readdirSync(dirname(f.archivePhysicalPath))).toEqual([])
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])
  const proof = apply(plan)
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('leftover archive temp files from a crash are removed and the plan retries exactly once', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), original = readFileSync(f.physicalPath)
  const dir = dirname(f.archivePhysicalPath), temp = (hex: string) => join(dir, `.${f.oldDigest}.sqlite.tmp-${hex.repeat(32)}`)
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(temp('a'), original.subarray(0, 100), { mode: 0o600 })
  const proof = apply(plan)
  expect(readdirSync(dir)).toEqual([`${f.oldDigest}.sqlite`])
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)

  // Crash between link() and unlink(temp): the temp is a second name of the complete 0400 archive.
  const g = staged(), gPlan = planSealedAdoptionHandoff(g.scope), gDir = dirname(g.archivePhysicalPath)
  mkdirSync(gDir, { mode: 0o700 }); copyFileSync(g.physicalPath, g.archivePhysicalPath); chmodSync(g.archivePhysicalPath, 0o400)
  linkSync(g.archivePhysicalPath, join(gDir, `.${g.oldDigest}.sqlite.tmp-${'b'.repeat(32)}`))
  const gProof = apply(gPlan)
  expect(readdirSync(gDir)).toEqual([`${g.oldDigest}.sqlite`])
  expect(verify(g, gPlan, gProof.digest)).toEqual(gProof)

  // Anything else under the temp prefix is not ours to remove.
  const h = staged(), hPlan = planSealedAdoptionHandoff(h.scope), hDir = dirname(h.archivePhysicalPath)
  mkdirSync(hDir, { mode: 0o700 }); mkdirSync(join(hDir, `.${h.oldDigest}.sqlite.tmp-${'c'.repeat(32)}`))
  expect(() => apply(hPlan)).toThrow('unsafe archive temp')
  expect(counts(h.physicalPath)).toEqual([1, 3, 3, 1])
})

/** Kill a writer inside BEGIN IMMEDIATE after it spilled the business DELETEs into the main file. */
function crashInsideTransaction(file: string) {
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size=1; PRAGMA cache_spill=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; DELETE FROM calls; DELETE FROM source_archives; DELETE FROM adoptions');
    process.kill(process.pid, 'SIGKILL')`
  const result = spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8' })
  expect(result.signal).toBe('SIGKILL')
}

test('a crash inside the apply transaction leaves a hot rollback journal that the retry rolls back', () => {
  const f = staged()
  // Rollback-journal mode so the in-transaction crash leaves a real hot -journal (WAL leaves -wal/-shm).
  mutate(f.physicalPath, 'PRAGMA journal_mode=DELETE')
  const plan = planSealedAdoptionHandoff(f.scope), original = readFileSync(f.physicalPath)
  crashInsideTransaction(f.physicalPath)
  expect(existsSync(f.physicalPath + '-journal')).toBe(true)
  expect(existsSync(f.physicalPath + '-wal')).toBe(false)
  expect(readFileSync(f.physicalPath).equals(original)).toBe(false)
  // Verify stays strict about any sidecar.
  expect(() => verify(f, plan, d('a'))).toThrow('sidecar')
  const proof = apply(plan)
  expect(existsSync(f.physicalPath + '-journal')).toBe(false)
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(proof.plan).toEqual(plan)
  expect(proof.inheritedUsage).toEqual({ adoptions: 3, calls: 3 })
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('a rollback journal beside WAL sidecars, or one that does not restore the plan snapshot, fails closed', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  writeFileSync(f.physicalPath + '-journal', '', { mode: 0o600 }); writeFileSync(f.physicalPath + '-wal', '', { mode: 0o600 })
  expect(() => apply(plan)).toThrow('sidecar')
  rmSync(f.physicalPath + '-wal'); rmSync(f.physicalPath + '-journal')
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])

  const g = staged()
  mutate(g.physicalPath, 'PRAGMA journal_mode=DELETE')
  const gPlan = planSealedAdoptionHandoff(g.scope)
  mutate(g.physicalPath, 'PRAGMA user_version=3; VACUUM') // drift before the crash
  crashInsideTransaction(g.physicalPath)
  expect(() => apply(gPlan)).toThrow('plan snapshot')
  expect(existsSync(g.archivePhysicalPath)).toBe(false)
})

test('a crash inside the apply transaction on a WAL stage leaves -wal/-shm that the retry discards', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), original = readFileSync(f.physicalPath)
  crashInsideTransaction(f.physicalPath)
  expect(existsSync(f.physicalPath + '-wal')).toBe(true)
  expect(existsSync(f.physicalPath + '-journal')).toBe(false)
  expect(() => verify(f, plan, d('a'))).toThrow('sidecar')
  const proof = apply(plan)
  for (const suffix of ['-wal', '-shm', '-journal']) expect(existsSync(f.physicalPath + suffix)).toBe(false)
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('a committed but uncheckpointed WAL apply is acknowledged on retry without a second handoff', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  // Re-create the post-commit, pre-checkpoint state: a held WAL connection that never checkpoints.
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE; UPDATE authority SET key_id=key_id; COMMIT');
    process.kill(process.pid, 'SIGKILL')`
  const result = spawnSync(process.execPath, ['-e', script, f.physicalPath], { encoding: 'utf8' })
  expect(result.signal).toBe('SIGKILL')
  expect(existsSync(f.physicalPath + '-wal')).toBe(true)
  expect(apply(plan)).toEqual(proof)
  for (const suffix of ['-wal', '-shm']) expect(existsSync(f.physicalPath + suffix)).toBe(false)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test.each([['-wal'], ['-shm']])('a lone %s sidecar still fails closed', suffix => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  writeFileSync(f.physicalPath + suffix, '', { mode: 0o600 })
  expect(() => apply(plan)).toThrow('sidecar')
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])
})

test('WAL recovery that does not restore the plan snapshot fails closed', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  mutate(f.physicalPath, "UPDATE adoptions SET reason=reason") // checkpointed drift after planning
  mutate(f.physicalPath, 'PRAGMA user_version=3; VACUUM')
  crashInsideTransaction(f.physicalPath)
  expect(() => apply(plan)).toThrow('plan snapshot')
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
})

test.each(['adoptions', 'calls'])('journal fails closed when inherited %s exceed the grant', field => {
  const f = sealedLive(seedSettled, 8, 8), db = new DatabaseSync(f.path)
  try {
    // Fully re-digested audit: only the grant comparison can reject it.
    const proof = JSON.parse((db.prepare('SELECT proof_json FROM creation_sealed_adoption_handoff').get() as { proof_json: string }).proof_json)
    const value = field === 'adoptions' ? { adoptions: 9, calls: 3 } : { adoptions: 3, calls: 9 }
    proof.plan.inheritedUsage = value; proof.plan.history.counts = { ...proof.plan.history.counts, ...value }
    const { digest: _plan, ...planBody } = proof.plan
    proof.plan.digest = sha(canonicalGrowthJson(planBody))
    proof.inheritedUsage = value
    const { digest: _proof, ...body } = proof
    proof.digest = sha(canonicalGrowthJson(body))
    db.exec('DROP TRIGGER creation_sealed_handoff_no_update')
    db.prepare('UPDATE creation_sealed_adoption_handoff SET proof_json=?,proof_digest=?').run(canonicalGrowthJson(proof), proof.digest)
    db.exec("CREATE TRIGGER creation_sealed_handoff_no_update BEFORE UPDATE ON creation_sealed_adoption_handoff BEGIN SELECT RAISE(ABORT,'immutable sealed adoption handoff'); END")
  } finally { db.close() }
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toMatch(/^[a-f0-9]{64}$/u)
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.config })).toThrow()
})
