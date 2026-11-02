import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import * as yaml from 'yaml'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { linuxPluginBehaviorRuntimeDigest, type LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { CreationCapabilityJournal } from '../../plugins/plugin-control-plane/src/creation-capability-journal.js'
import { CreationReviewStore } from '../../plugins/assistant-verifier/src/creation-review-store.js'
import type { CreationCapabilityConfig } from '../../plugins/plugin-control-plane/src/creation-capability-types.js'
import * as control from '../../plugins/plugin-control-plane/src/index.js'
import { inspectOwnerEmptyCreationHistory } from '../../scripts/install/owner-empty-creation-history.mjs'
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
  mkdirSync(join(root, 'control-plane'), { mode: 0o700 })
  const path = join(root, 'control-plane', 'creation-adoptions.sqlite')
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



export const api = { control, yaml }
export async function ownerFixture() {
  const f = linuxFixture()
  new CreationCapabilityJournal({ path: f.path, config: f.oldConfig }).close()
  const verifierPath = join(f.root, 'verifier.sqlite')
  new CreationReviewStore(verifierPath + '.creation-reviews').close()
  const resources = { installationId: 'installation-1', stateRoot: f.root, configRoot: join(f.root, 'config') }
  const manifest = { pluginCreation: { capabilities: f.oldConfig, reviews: { runner: f.oldConfig.runner } },
    sourceReviews: { authorityId: 'source' }, controlPlane: { statePath: join(f.root, 'control-plane'), creationCapabilities: f.oldConfig,
      sourceBuild: { schemaVersion: 1, sourceCommit: 'a'.repeat(40) } } }
  const ownerUpdate = { protocol: 'dsh-enhanced/host-owner-program-update/v1', homePath: f.root, profile: 'assistant',
    hostPlanDigest: d('e'), original: { build: { schemaVersion: 1 }, resources, receiptSource: 'owner-bootstrap',
      fileDigests: { [join(resources.configRoot, 'manifest.json')]: d('a') }, patchDigests: { assistant: d('b'), coordinator: d('c') },
      manifest, effective: { targetEffective: yaml.stringify([
        { id: 'dsh-enhanced-assistant-verifier', config: { databasePath: verifierPath,
          sourceReviews: manifest.sourceReviews, creationReviews: manifest.pluginCreation.reviews } },
        { id: 'dsh-enhanced-plugin-control-plane', config: manifest.controlPlane },
      ]) } } }
  const emptyCreationHistory = await inspectOwnerEmptyCreationHistory({ ownerUpdate, api })
  const stageHome = mkdtempSync(join(realpathSync(tmpdir()), 'empty-owner-stage-')); roots.push(stageHome); chmodSync(stageHome, 0o700)
  cpSync(f.root, stageHome, { recursive: true })
  // Node24's recursive cp creates this child as 0755 on this Mac; keep the intended private fixture.
  chmodSync(join(stageHome, 'control-plane'), 0o700)
  const stageHistory = await inspectOwnerEmptyCreationHistory({ ownerUpdate, physicalHome: stageHome, api })
  const nextManifest = structuredClone(manifest)
  nextManifest.controlPlane.creationCapabilities = f.config
  nextManifest.controlPlane.sourceBuild = { schemaVersion: 3, sourceCommit: 'b'.repeat(40), backend: 'linux-native' } as typeof nextManifest.controlPlane.sourceBuild
  nextManifest.pluginCreation.capabilities = f.config
  return { ...f, ownerUpdate, stageHome, stageHistory, nextManifest,
    candidateCreation: { backendTransition: 'docker->linux-native', backend: 'linux-native', receiptSha256: d('b'), emptyCreationHistory },
    source: { sourceCommit: 'b'.repeat(40) }, sourceBuild: { schemaVersion: 3, backend: 'linux-native', sourceCommit: 'b'.repeat(40) } }
}
