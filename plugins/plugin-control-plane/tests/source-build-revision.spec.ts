// Engineering fixture: a local fake Docker executable records dispatch only.
// Git staging and the fixed public generator are real; OS isolation is not tested.
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginCreationVerificationCertificate, SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { captureCreationCapabilitySource } from '../src/creation-capability-source.js'
import { verifySourcePreparation } from '../src/source-build.js'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace } from '../src/source-creation.js'
import { prepareRevisedPluginWorkspace, type SourceRevisionBinding, type SourceRevisionGrant } from '../src/source-revision.js'
import { controlPlaneDigest } from '../src/store.js'
import { checkedSourceSnapshot, createIsolatedWorktree } from '../src/source-workspace.js'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.js'

import { runLinuxPreparedChecks } from '../src/linux-source-build.js'
import { linuxSourceConfig, linuxMockRunner } from './helpers/linux-source-build-fixture.js'

vi.mock('@dsh-enhanced/assistant-isolation', async importOriginal => {
  const actual = await importOriginal<typeof import('@dsh-enhanced/assistant-isolation')>()
  return { ...actual, verifyLinuxRuntime: vi.fn(async value => value) }
})

const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
let cloneRoot: string
let repository: string
let baseCommit: string
const roots: string[] = []
const worktrees: Array<{ remove: () => Promise<void> }> = []
beforeAll(async () => {
  cloneRoot = await realpath(await mkdtemp(join(tmpdir(), 'source-build-revision-clone-')))
  const created = await createSourceCreationFixture(sourceRoot, join(cloneRoot, 'repository'))
  repository = created.repository; baseCommit = created.baseCommit
})
afterAll(async () => { await rm(cloneRoot, { recursive: true, force: true }) })
afterEach(async () => {
  for (const worktree of worktrees.splice(0).reverse()) await worktree.remove()
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})
const h = (letter: string): string => letter.repeat(64)
const name = 'rsi-build-revision'
const scope = [`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml']

function certificate(generatorDigest: string, treeDigest: string, patchDigest: string): PluginCreationVerificationCertificate {
  const now = Date.now()
  return {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'build-parent-verification',
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'independent-parent',
      keyId: 'key', authorityDigest: h('a'), namePrefix: 'rsi-build-', expiresAt: now + 180_000 },
    plan: { id: 'build-parent-plan', digest: h('b'), name, sourceTreeDigest: treeDigest, sourcePatchDigest: patchDigest,
      artifactSha256: h('c'), artifactBytes: 1024, generatorDigest },
    source: { referenceDigest: h('1'), ownerDigest: h('2'), growthRunDigest: h('3') },
    contractDigest: h('4'), schemaDigest: h('5'),
    environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
    model: { provider: 'fixture', model: 'test' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: [{ caseId: 'case-1', jobId: 'job-1', operationDigest: h('6'), observationDigest: h('7') },
      { caseId: 'case-2', jobId: 'job-2', operationDigest: h('8'), observationDigest: h('9') }],
    reviewDigest: h('0'), verifiedAt: now - 1000, expiresAt: now + 120_000, signature: 'A'.repeat(86),
  }
}

function growthRun(grant: SourceRevisionGrant): SourceGrowthRunBinding {
  const now = Date.now()
  return {
    protocol: 'assistant-growth/source-run/v1', runId: 'build-revision-run', intentDigest: h('a'),
    configDigest: h('b'), ownerDigest: h('c'),
    source: { outcomeId: 'outcome-1', projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox-1',
      version: 1, digest: h('d'), disposition: 'upsert' }, sourceDigest: h('e') },
    model: { provider: 'fixture', model: 'test' }, modelOrigin: 'inherited-owner-task',
    revisionAcceptance: { protocol: 'assistant-growth/revision-acceptance-authority/v1',
      authorityId: 'revision-authority', keyId: 'key', authorityDigest: h('f'),
      namePrefix: grant.namePrefix, expiresAt: now + 120_000 },
    budget: { budgetId: 'revision-budget', amount: 1, maxModelCalls: 4, maxToolCalls: 16,
      maxOutputTokens: 2048, maxDurationMs: 60_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'build-revision-run',
      definitionHash: h('a'), occurrenceId: 'wake-1' },
    sessionId: 'session-1', toolContractDigest: h('b'), executionContractDigest: h('c'),
    createdAt: now - 1000, generationDeadlineAt: now + 30_000, expiresAt: now + 60_000,
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-build-revision-'))); roots.push(root)
  const environment = { ...process.env, HOME: root }
  const signal = new AbortController().signal
  const isolated = async () => {
    const stateRoot = await mkdtemp(join(root, 'state-'))
    await chmod(stateRoot, 0o700)
    const worktree = await createIsolatedWorktree({ stateRoot, repository, baseCommit, environment })
    worktrees.push(worktree)
    return worktree.worktree
  }
  const parentWorktree = await isolated()
  const creationGrant = { id: 'owner-build-create', expiresAt: Date.now() + 120_000,
    maxCreates: 1, namePrefix: 'rsi-build-' }
  const inspected = await inspectSourceCreationContext({ repository, name, paths: ['src/index.ts'], baseCommit,
    environment, signal, assertCurrent: () => undefined, grant: creationGrant })
  const creation = { grant: creationGrant, generatorDigest: inspected.generatorDigest }
  await prepareCreatedPluginWorkspace({ worktree: parentWorktree, baseCommit, name,
    files: [{ path: 'README.md', content: '# Parent source\n' },
      { path: 'src/index.ts', content: 'export const version = 1\n' }],
    environment, signal, assertCurrent: () => undefined, creation })
  const checked = await checkedSourceSnapshot(parentWorktree, baseCommit, scope, environment)
  const parentCertificate = certificate(inspected.generatorDigest, checked.checkedTreeDigest, checked.checkedPatchDigest)
  const parentSource = await captureCreationCapabilitySource({ worktree: parentWorktree, baseCommit,
    scope: [...scope].sort(), certificate: parentCertificate, environment, signal })
  const grant: SourceRevisionGrant = { id: 'owner-build-revision', expiresAt: Date.now() + 120_000,
    maxRevisions: 1, namePrefix: 'rsi-build-' }
  const binding: SourceRevisionBinding = { grant, generatorDigest: inspected.generatorDigest,
    parent: { planId: parentCertificate.plan.id, certificateDigest: controlPlaneDigest(parentCertificate),
      artifactSha256: parentCertificate.plan.artifactSha256, sourceArchiveDigest: h('a'), sourceDigest: parentSource.digest },
    growthRun: growthRun(grant) }
  const current = await isolated()
  const files = [{ path: 'src/index.ts', content: 'export const version = 2\n' }]
  await prepareRevisedPluginWorkspace({ worktree: current, baseCommit, name, files,
    environment, signal, assertCurrent: () => undefined, revision: binding, parentSource, parentCertificate })
  const config = linuxSourceConfig()
  const revision = { binding, parentSource, parentCertificate, files }
  const input = { config, worktree: current, baseCommit, name, scope, environment, signal,
    assertCurrent: async () => {}, preparedAt: Date.now(), revision }
  return { root, repository, worktree: current, baseCommit, creation, binding, revision, input }
}

test('preserves real revision proof and rejects parent drift before Linux dispatch', async () => {
  const f = await fixture(), config = linuxSourceConfig()
  const { runner, run } = linuxMockRunner(config, request => {
    expect(request.argv).toContain('DSH_SOURCE_TRUST_LOCKFILE=true')
  })
  const input = { ...f.input, config, runner, sourceJob: { id: 'source-job-' + '2'.repeat(64) } }
  // Revision proof and parent binding are portable source contracts; only the
  // Linux execution adapter requires a Linux Host.
  await verifySourcePreparation(input)
  await expect(verifySourcePreparation({ ...input, revision: { ...f.revision,
    binding: { ...f.binding, parent: { ...f.binding.parent, sourceDigest: h('0') } } } })).rejects.toThrow(/parent binding/u)
  if (process.platform !== 'linux') {
    await expect(runLinuxPreparedChecks(input)).rejects.toThrow('Linux source build durable authority is invalid')
    expect(run).not.toHaveBeenCalled()
    return
  }
  const result = await runLinuxPreparedChecks(input)
  expect(result.evidence.schemaVersion).toBe(3)
  expect(result.evidence.pack.version).toBe('0.1.0')
  expect(run).toHaveBeenCalledOnce()
  await expect(runLinuxPreparedChecks({ ...input, revision: { ...f.revision,
    binding: { ...f.binding, parent: { ...f.binding.parent, sourceDigest: h('0') } } } })).rejects.toThrow(/parent binding/u)
  expect(run).toHaveBeenCalledOnce()
}, 30000)
