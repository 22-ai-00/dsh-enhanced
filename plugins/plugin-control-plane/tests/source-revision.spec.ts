import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginCreationVerificationCertificate, SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { captureCreationCapabilitySource, creationCapabilitySourceDigest,
  type CreationCapabilitySourceSnapshot } from '../src/creation-capability-source.js'
import { controlPlaneDigest } from '../src/store.js'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace } from '../src/source-creation.js'
import { inspectSourceRevisionContext, prepareRevisedPluginWorkspace, validateSourceRevisionBinding,
  validateSourceRevisionGrant, verifyRevisedPluginWorkspace, type SourceRevisionBinding,
  type SourceRevisionGrant } from '../src/source-revision.js'
import { checkedSourceSnapshot, createIsolatedWorktree } from '../src/source-workspace.js'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.js'

const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
const environment = process.env
const signal = new AbortController().signal
const hash = 'a'.repeat(64)
const now = () => Date.now()
let repository: string
let baseCommit: string
let cloneRoot: string
const workers: { remove: () => Promise<void> }[] = []
const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('/usr/bin/git', args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeAll(async () => {
  cloneRoot = await mkdtemp(join(tmpdir(), 'dsh-revision-clone-'))
  const fixture = await createSourceCreationFixture(sourceRoot, join(cloneRoot, 'repository'))
  repository = fixture.repository; baseCommit = fixture.baseCommit
})
afterAll(async () => { await rm(cloneRoot, { recursive: true, force: true }) })
afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.remove()
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})

async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-revision-worktree-')); roots.push(root)
  const worker = await createIsolatedWorktree({ stateRoot: root, repository, baseCommit, environment })
  workers.push(worker)
  return worker.worktree
}

const name = 'rsi-created-revised'
const scope = [`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml']
const grant = (): SourceRevisionGrant => ({ id: 'owner-revision-1', expiresAt: now() + 120_000,
  maxRevisions: 2, namePrefix: 'rsi-created-' })
const creationGrant = () => ({ id: 'owner-creation-1', expiresAt: now() + 120_000,
  maxCreates: 2, namePrefix: 'rsi-created-' })

function certificate(generatorDigest: string, treeDigest: string, patchDigest: string): PluginCreationVerificationCertificate {
  const time = now()
  return {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'parent-verification-1',
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'parent-verifier',
      keyId: 'verifier-key', authorityDigest: hash, namePrefix: 'rsi-created-', expiresAt: time + 180_000 },
    plan: { id: 'parent-plan-1', digest: hash, name, sourceTreeDigest: treeDigest,
      sourcePatchDigest: patchDigest, artifactSha256: hash, artifactBytes: 1024, generatorDigest },
    source: { referenceDigest: hash, ownerDigest: hash, growthRunDigest: hash },
    contractDigest: hash, schemaDigest: hash,
    environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
    model: { provider: 'fixture', model: 'model' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: [{ caseId: 'case-1', jobId: 'job-1', operationDigest: hash, observationDigest: hash },
      { caseId: 'case-2', jobId: 'job-2', operationDigest: hash, observationDigest: hash }],
    reviewDigest: hash, verifiedAt: time - 1000, expiresAt: time + 120_000, signature: 'A'.repeat(86),
  }
}

function growthRun(revisionGrant: SourceRevisionGrant): SourceGrowthRunBinding {
  const time = now()
  return {
    protocol: 'assistant-growth/source-run/v1', runId: 'revision-run-1', intentDigest: hash,
    configDigest: hash, ownerDigest: hash,
    source: { outcomeId: 'outcome-1', projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox-1',
      version: 1, digest: hash, disposition: 'upsert' }, sourceDigest: hash },
    model: { provider: 'fixture', model: 'model' }, modelOrigin: 'inherited-owner-task',
    revisionAcceptance: { protocol: 'assistant-growth/revision-acceptance-authority/v1',
      authorityId: 'revision-verifier', keyId: 'verifier-key', authorityDigest: hash,
      namePrefix: revisionGrant.namePrefix, expiresAt: time + 120_000 },
    budget: { budgetId: 'revision-budget', amount: 1, maxModelCalls: 4, maxToolCalls: 16,
      maxOutputTokens: 2048, maxDurationMs: 60_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'revision-run-1', definitionHash: hash, occurrenceId: 'wake-1' },
    sessionId: 'session-1', toolContractDigest: hash, executionContractDigest: hash,
    createdAt: time - 1000, generationDeadlineAt: time + 30_000, expiresAt: time + 60_000,
  }
}

async function parentFixture(): Promise<{ source: CreationCapabilitySourceSnapshot;
  cert: PluginCreationVerificationCertificate; binding: SourceRevisionBinding }> {
  const created = await worktree()
  const inspected = await inspectSourceCreationContext({ repository, name, paths: ['src/index.ts'], baseCommit,
    environment, signal, assertCurrent: () => undefined, grant: creationGrant() })
  const creation = { grant: creationGrant(), generatorDigest: inspected.generatorDigest }
  await prepareCreatedPluginWorkspace({ worktree: created, baseCommit, name, environment, signal,
    assertCurrent: () => undefined, creation, files: [
      { path: 'README.md', content: '# Parent owner plugin\n' },
      { path: 'src/index.ts', content: 'export const version = 1\n' },
      { path: 'tests/index.spec.ts', content: 'export const checked = true\n' },
    ] })
  const checked = await checkedSourceSnapshot(created, baseCommit, scope, environment)
  const cert = certificate(inspected.generatorDigest, checked.checkedTreeDigest, checked.checkedPatchDigest)
  const source = await captureCreationCapabilitySource({ worktree: created, baseCommit,
    scope: [...scope].sort(), certificate: cert, environment, signal })
  const revisionGrant = grant()
  const binding: SourceRevisionBinding = { grant: revisionGrant, generatorDigest: inspected.generatorDigest,
    parent: { planId: cert.plan.id, certificateDigest: controlPlaneDigest(cert), artifactSha256: cert.plan.artifactSha256,
      sourceArchiveDigest: hash, sourceDigest: source.digest }, growthRun: growthRun(revisionGrant) }
  return { source, cert, binding }
}

const overlay = [{ path: 'src/index.ts', content: 'export const version = 2\n' },
  { path: 'tests/new.spec.ts', content: 'export const newCheck = true\n' }]

describe('revision of archived created plugin through the real Git generator', () => {
  it('rebuilds the parent in a fresh private worktree and verifies the entire final source', async () => {
    const parent = await parentFixture()
    const view = await inspectSourceRevisionContext({ repository, name, paths: ['README.md', 'src/index.ts'],
      baseCommit, environment, signal, assertCurrent: () => undefined, grant: parent.binding.grant,
      parent: parent.binding.parent, parentSource: parent.source, parentCertificate: parent.cert })
    expect(view.contents).toEqual([{ path: 'README.md', content: '# Parent owner plugin\n' },
      { path: 'src/index.ts', content: 'export const version = 1\n' }])
    const current = await worktree()
    const input = { worktree: current, baseCommit, name, files: overlay, environment, signal,
      assertCurrent: () => undefined, revision: parent.binding, parentSource: parent.source, parentCertificate: parent.cert }
    const result = await prepareRevisedPluginWorkspace(input)
    expect(result).toEqual({ scope, generatorDigest: parent.binding.generatorDigest })
    expect(await readFile(join(current, 'plugins', name, 'README.md'), 'utf8')).toBe('# Parent owner plugin\n')
    expect(await readFile(join(current, 'plugins', name, 'src/index.ts'), 'utf8')).toBe(overlay[0]!.content)
    await expect(verifyRevisedPluginWorkspace(input)).resolves.toEqual(result)
    await writeFile(join(current, 'plugins', name, 'README.md'), '# malicious unsubmitted edit\n')
    await expect(verifyRevisedPluginWorkspace(input)).rejects.toThrow('actual source changed')
    await writeFile(join(current, 'plugins', name, 'README.md'), '# Parent owner plugin\n')
    await chmod(join(current, 'plugins', name, 'src/index.ts'), 0o755)
    await expect(verifyRevisedPluginWorkspace(input)).rejects.toThrow('candidate mode changed')
    await chmod(join(current, 'plugins', name, 'src/index.ts'), 0o644)
    await writeFile(join(current, 'plugins', name, 'ignored-extra.txt'), 'extra\n')
    await expect(verifyRevisedPluginWorkspace(input)).rejects.toThrow('actual source file set changed')
  })

  it('rejects no-op, altered parent digest, protected metadata and baseline collision', async () => {
    const parent = await parentFixture()
    const current = await worktree()
    const base = { worktree: current, baseCommit, name, files: [{ path: 'src/index.ts', content: 'export const version = 1\n' }],
      environment, signal, assertCurrent: () => undefined, revision: parent.binding,
      parentSource: parent.source, parentCertificate: parent.cert }
    await expect(prepareRevisedPluginWorkspace(base)).rejects.toThrow('no source change')
    const another = await worktree()
    await expect(prepareRevisedPluginWorkspace({ ...base, worktree: another, files: overlay,
      revision: { ...parent.binding, parent: { ...parent.binding.parent, sourceDigest: hash } } })).rejects.toThrow('parent binding')
    const protectedSource = JSON.parse(JSON.stringify(parent.source)) as CreationCapabilitySourceSnapshot
    const reserved = protectedSource.files.find(file => file.path.endsWith('/package.json'))!
    const replacement = Buffer.from(reserved.content.replace('0.1.0', '0.2.0'))
    const oid = createHash('sha1').update(`blob ${replacement.length}\0`).update(replacement).digest('hex')
    Object.assign(reserved, { content: replacement.toString('utf8'), bytes: replacement.length,
      sha256: createHash('sha256').update(replacement).digest('hex'), oid })
    Object.assign(protectedSource.entries.find(entry => entry.path === reserved.path)!, { oid })
    const index = protectedSource.entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join('')
    const treeDigest = createHash('sha256').update(`dsh-source-tree-v2\0${protectedSource.baseCommit}\0${JSON.stringify(protectedSource.scope)}\0${index}`).digest('hex')
    protectedSource.treeDigest = treeDigest
    protectedSource.digest = creationCapabilitySourceDigest({ protocol: protectedSource.protocol,
      baseCommit: protectedSource.baseCommit, scope: protectedSource.scope, treeDigest,
      patchDigest: protectedSource.patchDigest, entries: protectedSource.entries, files: protectedSource.files })
    const protectedCert = { ...parent.cert, plan: { ...parent.cert.plan, sourceTreeDigest: treeDigest } }
    const protectedBinding = { ...parent.binding, parent: { ...parent.binding.parent,
      certificateDigest: controlPlaneDigest(protectedCert), sourceDigest: protectedSource.digest } }
    const third = await worktree()
    await expect(prepareRevisedPluginWorkspace({ ...base, worktree: third, files: overlay,
      revision: protectedBinding, parentSource: protectedSource,
      parentCertificate: protectedCert })).rejects.toThrow('parent protected metadata changed')
    const collisionRoot = await mkdtemp(join(tmpdir(), 'dsh-revision-collision-')); roots.push(collisionRoot)
    const collision = await createSourceCreationFixture(sourceRoot, join(collisionRoot, 'repository'))
    await mkdir(join(collision.repository, 'plugins', name))
    await writeFile(join(collision.repository, 'plugins', name, 'package.json'), '{}\n')
    git(collision.repository, 'add', '--all')
    git(collision.repository, '-c', 'user.name=Collision', '-c', 'user.email=collision@example.invalid', 'commit', '-qm', 'occupied name')
    const collisionBase = git(collision.repository, 'rev-parse', 'HEAD')
    const collisionState = await mkdtemp(join(tmpdir(), 'dsh-revision-collision-worktree-')); roots.push(collisionState)
    const collisionWorker = await createIsolatedWorktree({ stateRoot: collisionState, repository: collision.repository,
      baseCommit: collisionBase, environment })
    workers.push(collisionWorker)
    await expect(prepareRevisedPluginWorkspace({ ...base, worktree: collisionWorker.worktree,
      baseCommit: collisionBase, files: overlay })).rejects.toThrow('already exists at base')
  })

  it('rejects wrong base, generator digest, primary worktree and unsafe bindings', async () => {
    const parent = await parentFixture()
    const current = await worktree()
    const input = { worktree: current, baseCommit, name, files: overlay, environment, signal,
      assertCurrent: () => undefined, revision: parent.binding, parentSource: parent.source, parentCertificate: parent.cert }
    await expect(prepareRevisedPluginWorkspace({ ...input, baseCommit: 'b'.repeat(40) })).rejects.toThrow()
    await expect(prepareRevisedPluginWorkspace({ ...input, revision: { ...parent.binding,
      generatorDigest: 'b'.repeat(64) } })).rejects.toThrow('generator inputs changed')
    await expect(prepareRevisedPluginWorkspace({ ...input, worktree: repository })).rejects.toThrow('private linked')
    const unsafe = await worktree()
    await chmod(dirname(unsafe), 0o777)
    await expect(prepareRevisedPluginWorkspace({ ...input, worktree: unsafe })).rejects.toThrow('private linked')
    await chmod(dirname(unsafe), 0o700)
    const expired = { ...parent.binding.grant, expiresAt: now() - 1 }
    expect(() => validateSourceRevisionGrant(expired)).not.toThrow()
    await expect(inspectSourceRevisionContext({ repository, name, paths: [], baseCommit, environment, signal,
      assertCurrent: () => undefined, grant: expired, parent: parent.binding.parent,
      parentSource: parent.source, parentCertificate: parent.cert })).rejects.toThrow('grant expired')
    await expect(prepareRevisedPluginWorkspace({ ...input, revision: { ...parent.binding,
      grant: expired } })).rejects.toThrow('grant expired')
    expect(() => validateSourceRevisionGrant({ ...grant(), maxRevisions: 0 })).toThrow()
    expect(() => validateSourceRevisionBinding({ ...parent.binding, growthRun: {
      ...parent.binding.growthRun, revisionAcceptance: undefined } })).toThrow()
    const getter = { ...parent.binding }
    let read = false
    Object.defineProperty(getter, 'parent', { enumerable: true, get() { read = true; return parent.binding.parent } })
    expect(() => validateSourceRevisionBinding(getter)).toThrow()
    expect(read).toBe(false)
  })
})
