/** Shared Docker-era sealed-history fixtures for the sealed adoption handoff spec and the env-gated
 * real-model re-adoption acceptance. Callers own cleanup: remove every path pushed to `roots`. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { linuxPluginBehaviorRuntimeDigest, type LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { CreationCapabilityJournal, creationCapabilityAuthorityDigest } from '../../src/creation-capability-journal.js'
import { creationCapabilitySourceDigest, type CreationCapabilitySourceSnapshot } from '../../src/creation-capability-source.js'
import type { CreationCapabilityConfig, CreationCapabilityTool } from '../../src/creation-capability-types.js'
import { planSealedAdoptionHandoff, applySealedAdoptionHandoff, verifySealedAdoptionHandoff } from '../../src/creation-capability-sealed-handoff.js'

export const roots: string[] = []
export const d = (letter: string) => letter.repeat(64)
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const tools: CreationCapabilityTool[] = [{ originalName: 'echo', name: 'generated_echo', description: 'Echo', parameters: { type: 'object' } }]

export function linuxFixture(maxAdoptions = 8, maxCalls = 8) {
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
  function archived(planId: string, extra: ExtraFile[] = []) {
    const name = `generated-${planId}`, baseCommit = '1'.repeat(40)
    const blob = (path: string, content: string, mode: '100644' | '100755' = '100644') => {
      const bytes = Buffer.from(content)
      return { path: `plugins/${name}/${path}`, mode, bytes: bytes.length, sha256: sha(bytes), content,
        oid: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }
    }
    const files = [blob('src/index.ts', 'export const answer = 42\n'), ...extra.map(file => blob(file.path, file.content, file.mode))]
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    const scope = [`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'].sort()
    const entries = [{ path: 'plugins/README.md', mode: '100644' as const, oid: '2'.repeat(40) },
      ...files.map(({ path, mode, oid }) => ({ path, mode, oid })), { path: 'pnpm-lock.yaml', mode: '100644' as const, oid: '3'.repeat(40) }]
    const treeDigest = createHash('sha256').update(`dsh-source-tree-v2\0${baseCommit}\0${JSON.stringify(scope)}\0`)
      .update(entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join('')).digest('hex')
    const payload: Omit<CreationCapabilitySourceSnapshot, 'digest'> = { protocol: 'dsh-created-capability-source/v1',
      baseCommit, scope, treeDigest, patchDigest: d('e'), entries, files }
    return { source: { ...payload, digest: creationCapabilitySourceDigest(payload) }, certificate: legacy(planId, treeDigest) }
  }
  return { root, path, artifact, oldConfig, config, legacy, certificate, archived, verifier }
}
export type Fixture = ReturnType<typeof linuxFixture>
/** Extra archived plugin file; mode defaults to 100644. */
export type ExtraFile = { path: string; content: string; mode?: '100644' | '100755' }

/** Settled history through the real Docker journal API: active (2 completed calls, signed source),
 * closed (1 completed call), rejected. */
export function seedSettled(f: Fixture, extra: ExtraFile[] = []) {
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })
  try {
    const { source, certificate } = f.archived('active', extra)
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
export function seedUnsettled(f: Fixture) {
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
export function staged(seed: ((f: Fixture) => void) | null = seedSettled, maxAdoptions = 8, maxCalls = 8) {
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
export type Staged = ReturnType<typeof staged>
export const apply = (plan: ReturnType<typeof planSealedAdoptionHandoff>, now = plan.createdAt) =>
  applySealedAdoptionHandoff(plan, { now, expectedPlanDigest: plan.digest, expectedHostAnchor: plan.hostAnchor })
export const verify = (f: Staged, plan: ReturnType<typeof planSealedAdoptionHandoff>, digest: string,
  physicalPath = f.physicalPath, archivePhysicalPath = f.archivePhysicalPath) =>
  verifySealedAdoptionHandoff({ physicalPath, archivePhysicalPath, plan, expectedProofDigest: digest })
export function mutate(file: string, sql: string) { const db = new DatabaseSync(file); try { db.exec(sql) } finally { db.close() } }
export function counts(file: string) { const uri = pathToFileURL(file); uri.searchParams.set('mode', 'ro'); uri.searchParams.set('immutable', '1'); const db = new DatabaseSync(uri, { readOnly: true }); try {
  return ['authority', 'adoptions', 'calls', 'source_archives'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)
} finally { db.close() } }
/** Same-inode cutover of the sealed stage into the logical location. */
export function cutover(f: Staged) {
  renameSync(f.path, f.path + '.old')
  renameSync(f.physicalPath, f.path); renameSync(dirname(f.archivePhysicalPath), dirname(f.archiveLogicalPath))
}

export function sealedLive(seed: (f: Fixture) => void, maxAdoptions: number, maxCalls: number) {
  const f = staged(seed, maxAdoptions, maxCalls), plan = planSealedAdoptionHandoff(f.scope); apply(plan); cutover(f)
  return f
}
