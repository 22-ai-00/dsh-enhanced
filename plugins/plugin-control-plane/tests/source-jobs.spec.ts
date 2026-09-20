import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HostAutomationExecutor, SystemAutomationReconcileInput } from '@dsh-enhanced/assistant-automations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { Ed25519SourceReleaseAuthorizationAuthority, sourceReleaseAuthorizationSigningPayload } from '../src/release.ts'
import { SourceJobRuntime } from '../src/source-jobs.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST, controlPlaneDigest } from '../src/store.ts'
import type { SourceJobRecord } from '../src/source-job-types.ts'
import type { PluginSourcePlan } from '../src/types.ts'
import * as sourceBuild from '../src/source-build.ts'

const roots: string[] = []
const hex = (value: string) => createHash('sha256').update(value).digest('hex')
const OWNER = { ownerRouteId: 'route-1', principalId: 'owner-1', principalRecordId: 'record-1', principalVersion: 1, workspace: '/workspace', preset: 'primary' }
const receipt = () => ({ receiptVersion: 2 as const, authorityId: OWNER.ownerRouteId, authorityHash: hex('route-1'), principalId: OWNER.principalId,
  principalRecordId: OWNER.principalRecordId, principalVersion: OWNER.principalVersion, workspace: OWNER.workspace, agentPreset: OWNER.preset, bindingVersion: 1, generation: 1 })
const build = { dockerPath: '/usr/bin/docker', image: `example@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000, memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 } as const
const evidence = () => ({ schemaVersion: 1 as const, kind: 'dsh-source-prepared-evidence' as const, environment: { npmConfigIgnoreScripts: true as const, frozenLockfile: true as const, offline: true, nodeVersion: 'test', pnpmVersion: 'test' }, commands: [{ command: 'pnpm', args: ['check'], exitCode: 0 as const, durationMs: 1, logDigest: 'e'.repeat(64) }], pack: { name: 'health-helper', version: '1.0.0', sizeBytes: 1, sha256: 'd'.repeat(64) }, preparedAt: Date.now() })

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(options: { typed?: boolean; fence?: boolean; approvals?: boolean; versioning?: boolean; releases?: boolean; execution?: boolean; adoption?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-source-jobs-runtime-'))); roots.push(root)
  await mkdir(join(root, 'plugins', 'health-helper', 'src'), { recursive: true })
  await writeFile(join(root, 'plugins', 'health-helper', 'src', 'index.ts'), 'export const committed = true\n')
  execFileSync('/usr/bin/git', ['init', root]); execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'test@example.invalid']); execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Test'])
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.']); execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'fixture'])
  const head = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const store = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
  const gap = options.typed === true
    ? store.recordOwnerTaskFailureGap({ schemaVersion: 1, owner: receipt(), outcomeId: 'outcome-source-job',
      projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox-source-job', version: 1, digest: hex('projection-source-job'), disposition: 'upsert' },
      sourceDigest: hex('source-job-reference') })
    : store.recordGap({ idempotencyKey: 'gap:source-job', capability: 'health', context: 'runtime', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  const executors = new Map<string, HostAutomationExecutor>()
  const activations = new Map<string, { definitionHash: string; activationNonce: string; ownerRouteId: string }>()
  const reconciles: SystemAutomationReconcileInput[] = []
  const automations = {
    registerHostExecutor: vi.fn((value: HostAutomationExecutor) => { executors.set(value.descriptor.executorId, value); return () => { executors.delete(value.descriptor.executorId) } }),
    reconcileSystem: vi.fn((request: SystemAutomationReconcileInput) => {
      reconciles.push(request)
      if (request.definition.execution === undefined) throw new Error('fixture requires Host execution')
      activations.set(request.automationId, { definitionHash: hex(JSON.stringify(request.definition)), activationNonce: request.definition.execution.activationNonce, ownerRouteId: request.definition.execution.ownerRouteId })
      return {}
    }),
    inspectSystemOwnedActivation: vi.fn((input: { automationId: string }) => activations.get(input.automationId)),
    inspectSystemOwned: vi.fn(() => ({ latestTerminalRuns: {} })),
  }
  const trust = { dshHome: '/dsh', executor: { environmentAllowlist: [] } }
  let sourceCurrent = true
  // This fixture models the service gateway only: production obtains this
  // proof from Evaluation's canonical writer fence, never from this boolean.
  const gapSourceFence = <T>(gapId: string, owner: ReturnType<typeof receipt>, callback: () => T): T => {
      if (!store.getOwnerTaskFailureReference(gapId) || controlPlaneDigest(owner) !== controlPlaneDigest(receipt()) || !sourceCurrent) {
        throw new Error('typed source is no longer current')
      }
      return store.withOwnerTaskFailureGapAdmission(gapId, callback)
    }
  const withGapSourceFence: typeof gapSourceFence | undefined = options.typed === true && options.fence !== false
    ? vi.fn(gapSourceFence) as typeof gapSourceFence
    : undefined
  const prepare = vi.fn(async (job: SourceJobRecord, _signal: AbortSignal, assertCurrent: () => Promise<void>): Promise<PluginSourcePlan> => {
    await assertCurrent()
    const create = () => store.createSourcePlan({ gapId: job.intent.gapId, repository: job.intent.repository, worktree: job.intent.worktree,
      baseCommit: job.intent.baseCommit, name: job.intent.name, generatorDigest: MODIFY_GENERATOR_DIGEST, scope: [`plugins/${job.intent.name}`], mode: 'modify', ttlMs: job.intent.ttlMs,
      idempotencyKey: `source-job-plan:${job.id}`, sourceJob: { jobId: job.id, jobRevision: job.revision, occurrenceId: job.occurrenceId! },
      prepared: { treeDigest: 'b'.repeat(64), patchDigest: 'c'.repeat(64), checkedAt: Date.now(), evidence: evidence() } }).result
    return options.typed === true ? withGapSourceFence!(job.intent.gapId, job.intent.owner, create) : create()
  })
  const config = { authorityId: 'source-authority', expiresAt: Date.now() + 60_000, maxSubmissions: 2, repository: root,
    ownerRouteId: OWNER.ownerRouteId, principalId: OWNER.principalId, workspace: OWNER.workspace, preset: OWNER.preset, budgetId: 'source-runs', budgetAmount: 1 }
  const delivery = { validateOwnerRoute: vi.fn(receipt) }
  const approvePrepared = vi.fn(async (job: SourceJobRecord, _signal: AbortSignal) => {
    if (!options.releases) return
    const plan = store.getSourcePlan(job.planId!), keys = generateKeyPairSync('ed25519')
    const unsigned = { schemaVersion: 1 as const, approvalId: 'runtime-approval', authority: 'source-authority', keyId: 'source-key',
      planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: OWNER.principalId, decidedAt: Date.now(), expiresAt: plan.expiresAt }
    const signed = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') }
    await store.approveSource({ planId: plan.id, expectedRevision: plan.revision, receipt: signed,
      resolveAuthority: () => new Ed25519ApprovalAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), unsigned.authority, unsigned.keyId),
      idempotencyKey: `runtime-approval:${plan.id}`, withSourceFence: callback => gapSourceFence(job.intent.gapId, job.intent.owner, callback) })
  })
  const releasePrepared = vi.fn(async (_job: SourceJobRecord, _signal: AbortSignal) => {})
  const advanceReleased = vi.fn(async (_job: SourceJobRecord, _signal: AbortSignal) => {})
  const adoptionForward = vi.fn()
  const adoptReleased = vi.fn(async (_job: SourceJobRecord, _signal: AbortSignal, assertCurrent: () => Promise<void>) => {
    await assertCurrent(); adoptionForward()
  })
  const createRuntime = () => new SourceJobRuntime({ config, build: { ...build, ...(options.versioning ? { versioning: 'patch' as const } : {}) }, statePath: root, store, ports: { automations: automations as never, delivery },
    ...(withGapSourceFence === undefined ? {} : { withGapSourceFence }), trust: async () => trust as any, prepare, ...(options.approvals ? { approvePrepared } : {}), ...(options.releases ? { releasePrepared } : {}), ...(options.execution ? { advanceReleased, releaseTimeoutMs: 60_000 } : {}), ...(options.adoption ? { adoptReleased, adoptionTimeoutMs: 60_000 } : {}) })
  const runtime = createRuntime()
  runtime.start()
  const enqueue = (signal = new AbortController().signal, key = 'job:one', gapId = gap.id) => runtime.enqueue({ gapId, name: 'health-helper', repository: root, files: [{ path: 'src/index.ts', content: 'export const changed = true\n' }], idempotencyKey: key, expectedBaseCommit: head, ttlMs: 900_000, owner: OWNER, signal, assertCurrent: () => undefined })
  return { root, store, gap, runtime, createRuntime, delivery, trust, automations, reconciles, prepare, approvePrepared, releasePrepared, advanceReleased, adoptReleased, adoptionForward, withGapSourceFence,
    setSourceCurrent: (value: boolean) => { sourceCurrent = value }, get executor() { return executors.get('plugin-control-plane-source-check') },
    get continuation() { return executors.get('plugin-control-plane-source-continuations-v1') }, activation: (id: string) => activations.get(id)!,
    tickContinuation: async (occurrenceId = 'prepared-continuation') => {
      const continuation = executors.get('plugin-control-plane-source-continuations-v1')!, active = activations.get('source-job-prepared-continuations')!
      return continuation.execute({ occurrenceId, automationId: 'source-job-prepared-continuations', definitionHash: active.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: continuation.descriptor.catalogDigest, signal: new AbortController().signal })
    }, enqueue, head }
}

describe('durable source-job runtime', () => {
  it('deduplicates concurrent continuation calls and drains an aborted late result on close', async () => {
    const f = await fixture({ typed: true, approvals: true })
    let release!: () => void
    try {
      f.approvePrepared.mockRejectedValueOnce(new Error('temporary outage'))
      const job = await f.enqueue(), active = f.activation(job.id)
      await f.executor!.execute({ occurrenceId: 'prepare-drain', automationId: job.id, definitionHash: active.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      let started!: () => void, executionSignal: AbortSignal | undefined
      const entered = new Promise<void>(resolve => { started = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      f.approvePrepared.mockImplementationOnce(async (_job, signal) => { executionSignal = signal; started(); await gate })
      const pending = f.tickContinuation('continuation-drain')
      await entered
      await f.tickContinuation('continuation-overlap')
      expect(f.approvePrepared).toHaveBeenCalledTimes(2)
      let closed = false
      const closing = f.runtime.close().then(() => { closed = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(executionSignal?.aborted).toBe(true)
      expect(closed).toBe(false)
      expect(f.reconciles.at(-1)?.desiredStatus).toBe('paused')
      release()
      expect(await pending).toMatchObject({ outcome: 'unknown', failureCode: 'source-continuation-unsettled' })
      await closing
      expect(f.prepare).toHaveBeenCalledOnce()
      expect(f.store.getSourceJob(job.id)?.status).toBe('prepared')
    } finally { release?.(); await f.runtime.close(); f.store.close() }
  })

  it('recovers a temporary approval outage, pauses, and reactivates for another real prepared job', async () => {
    const f = await fixture({ typed: true, approvals: true })
    try {
      f.approvePrepared.mockImplementation(async job => {
        const plan = f.store.getSourcePlan(job.planId!), keys = generateKeyPairSync('ed25519')
        const unsigned = { schemaVersion: 1 as const, approvalId: `approve-${plan.id}`, authority: 'owner', keyId: 'key',
          planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: OWNER.principalId,
          decidedAt: Date.now(), expiresAt: plan.expiresAt }
        await f.store.approveSource({ planId: plan.id, expectedRevision: plan.revision,
          receipt: { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') },
          resolveAuthority: () => new Ed25519ApprovalAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), 'owner', 'key'),
          idempotencyKey: unsigned.approvalId, withSourceFence: callback => f.withGapSourceFence!(job.intent.gapId, job.intent.owner, callback) })
      })
      const execute = async (id: string) => {
        const active = f.activation(id)
        await f.executor!.execute({ occurrenceId: `execute-${id}`, automationId: id, definitionHash: active.definitionHash,
          executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
          ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      }
      f.approvePrepared.mockRejectedValueOnce(new Error('first temporary outage'))
      const first = await f.enqueue()
      await execute(first.id)
      expect(f.reconciles.at(-1)?.desiredStatus).toBe('active')
      await f.tickContinuation('first-recovery')
      expect(f.store.getSourcePlan(f.store.getSourceJob(first.id)!.planId!).status).toBe('approved')
      expect(f.reconciles.at(-1)?.desiredStatus).toBe('paused')
      const secondGap = f.store.recordOwnerTaskFailureGap({ schemaVersion: 1, owner: receipt(), outcomeId: 'second-outcome',
        projection: { subjectKind: 'foreground-turn', subjectRef: 'second-inbox', version: 1, digest: hex('second-projection'), disposition: 'upsert' }, sourceDigest: hex('second-source') })
      f.approvePrepared.mockRejectedValueOnce(new Error('second temporary outage'))
      const second = await f.enqueue(undefined, 'job:second', secondGap.id)
      await execute(second.id)
      expect(f.reconciles.at(-1)?.desiredStatus).toBe('active')
      await f.tickContinuation('second-recovery')
      expect(f.store.getSourcePlan(f.store.getSourceJob(second.id)!.planId!).status).toBe('approved')
      const transitions = f.reconciles.filter(item => item.automationId === 'source-job-prepared-continuations')
      expect(transitions.map(item => item.desiredStatus)).toEqual(['paused', 'active', 'paused', 'active', 'paused'])
      expect(new Set(transitions.map(item => item.idempotencyKey)).size).toBe(transitions.length)
      expect(f.prepare).toHaveBeenCalledTimes(2)
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('pauses expired prepared work without rebuilding or calling its authority', async () => {
    const f = await fixture({ typed: true, approvals: true })
    try {
      f.approvePrepared.mockRejectedValueOnce(new Error('temporary outage'))
      const job = await f.enqueue(), active = f.activation(job.id)
      await f.executor!.execute({ occurrenceId: 'prepare-expiry', automationId: job.id, definitionHash: active.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      vi.spyOn(Date, 'now').mockReturnValue(f.store.getSourceJob(job.id)!.expiresAt + 1)
      await f.tickContinuation('after-expiry')
      expect(f.approvePrepared).toHaveBeenCalledOnce()
      expect(f.prepare).toHaveBeenCalledOnce()
      expect(f.reconciles.at(-1)?.desiredStatus).toBe('paused')
    } finally { await f.runtime.close(); f.store.close() }
  })

  it.each([{ changed: false, adoption: false }, { changed: true, adoption: false }, { changed: false, adoption: true }, { changed: true, adoption: true }])('continues native prepared work without rebuilding on restart (%j)', async ({ changed, adoption }) => {
    const f = await fixture({ typed: true, approvals: true, releases: true, execution: true, adoption })
    if (adoption) f.advanceReleased.mockImplementationOnce(async job => {
      // Release signatures are tested by source-release-runner; isolate the native job continuation boundary here.
      const db = new DatabaseSync(join(f.root, 'control.sqlite'))
      try { db.prepare("UPDATE source_plans SET status = 'release-complete' WHERE id = ?").run(job.planId!) } finally { db.close() }
    })
    let restarted: SourceJobRuntime | undefined
    try {
      f.releasePrepared.mockImplementationOnce(async job => {
        let plan = f.store.getSourcePlan(job.planId!)
        const withSourceFence = <T>(callback: () => T): T => f.withGapSourceFence!(job.intent.gapId, job.intent.owner, callback)
        plan = f.store.verifyPreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision,
          recheckedTreeDigest: plan.sourceCheck!.treeDigest, recheckedPatchDigest: plan.sourceCheck!.patchDigest, withSourceFence }).result
        const keys = generateKeyPairSync('ed25519')
        const unsigned = { schemaVersion: 1 as const, kind: 'dsh-source-release-authorization' as const, authorizationId: 'native-release',
          authority: 'release', keyId: 'release', planId: plan.id, planDigest: plan.digest, baseCommit: plan.baseCommit, scope: plan.scope,
          checkedTreeDigest: plan.sourceCheck!.treeDigest, checkedPatchDigest: plan.sourceCheck!.patchDigest,
          releasePolicy: { targetBranch: 'main', candidateId: plan.name, packageName: `@dsh-enhanced/${plan.name}`, packageVersion: '1.0.0',
            packagePath: `plugins/${plan.name}`, dshBaseline: '0.1.5', capabilities: ['health'], authorities: ['filesystem'], requires: [],
            registryId: 'registry', registryLocator: 'file:///registry', registryReference: 'file:///registry/pkg.tgz',
            catalogId: 'catalog', catalogPath: '/catalog.json', minimumReproducibleBuilds: 2 }, authorizedAt: Date.now(), expiresAt: plan.expiresAt }
        const authorization = { ...unsigned, signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
        await f.store.startSourceRelease({ planId: plan.id, expectedRevision: plan.revision, authorization, idempotencyKey: 'release', withSourceFence,
          resolveAuthority: () => new Ed25519SourceReleaseAuthorizationAuthority(keys.publicKey.export({ format: 'pem', type: 'spki' }), 'release', 'release') })
      })
      const queued = await f.enqueue(), active = f.activation(queued.id)
      const outcome = await f.executor!.execute({ occurrenceId: 'native-release', automationId: queued.id, definitionHash: active.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(outcome.outcome).toBe('succeeded'); expect(f.advanceReleased).toHaveBeenCalledTimes(1)
      await f.runtime.close(); f.setSourceCurrent(!changed)
      restarted = f.createRuntime(); restarted.start()
      await f.tickContinuation(); await restarted.close()
      expect(f.advanceReleased).toHaveBeenCalledTimes(adoption || changed ? 1 : 2)
      if (adoption) {
        // A source change only retains post-release recovery after a durable
        // exposed adoption record exists; this fixture has not created one.
        expect(f.adoptReleased).toHaveBeenCalledTimes(changed ? 1 : 2)
        expect(f.adoptionForward).toHaveBeenCalledTimes(changed ? 1 : 2)
      }
      expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.approvePrepared).toHaveBeenCalledTimes(1); expect(f.releasePrepared).toHaveBeenCalledTimes(1)
    } finally { await restarted?.close(); await f.runtime.close(); f.store.close() }
  })

  it('freezes Host versioning in the native job and rejects model-owned version files before enqueue', async () => {
    const f = await fixture({ versioning: true })
    try {
      for (const path of ['package.json', 'src/version.ts']) {
        expect(() => f.runtime.enqueue({ gapId: f.gap.id, name: 'health-helper', repository: f.root,
          files: [{ path, content: 'caller version' }], idempotencyKey: `reserved:${path.replaceAll('/', '-')}`,
          expectedBaseCommit: f.head, ttlMs: 900_000, owner: OWNER, signal: new AbortController().signal,
          assertCurrent: () => undefined })).toThrow()
      }
      expect(f.store.listSourceJobs()).toEqual([])
      const queued = await f.enqueue()
      expect(f.store.getSourceJob(queued.id)?.intent.build.versioning).toBe('patch')
      await f.runtime.close()
      const restarted = f.createRuntime(); restarted.start()
      try { expect(f.store.getSourceJob(queued.id)?.intent.build.versioning).toBe('patch') }
      finally { await restarted.close() }
    } finally { await f.runtime.close(); f.store.close() }
  })

  it.each([false, true])('recovers a prepared approval without replaying its build (source changed: %s)', async changed => {
    const f = await fixture({ typed: true, approvals: true })
    let restarted: SourceJobRuntime | undefined
    try {
      const queued = await f.enqueue(), active = f.activation(queued.id)
      f.approvePrepared.mockRejectedValueOnce(new Error('authority response unavailable'))
      const outcome = await f.executor!.execute({ occurrenceId: 'prepared-approval', automationId: queued.id, definitionHash: active.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(outcome.outcome).toBe('unknown')
      expect(f.store.getSourceJob(queued.id)).toMatchObject({ status: 'prepared' })
      expect(f.prepare).toHaveBeenCalledTimes(1)
      expect(f.approvePrepared).toHaveBeenCalledTimes(1)
      await f.runtime.close()
      f.setSourceCurrent(!changed)
      restarted = f.createRuntime(); restarted.start()
      await f.tickContinuation()
      await restarted.close()
      expect(f.prepare).toHaveBeenCalledTimes(1)
      expect(f.approvePrepared).toHaveBeenCalledTimes(changed ? 1 : 2)
    } finally { await restarted?.close(); await f.runtime.close(); f.store.close() }
  })

  it.each(['approved', 'ready', 'source-change', 'trust-change'] as const)('resumes finite release authorization from %s without rebuilding or reapproving', async boundary => {
    const f = await fixture({ typed: true, approvals: true, releases: true })
    let restarted: SourceJobRuntime | undefined
    try {
      f.releasePrepared.mockImplementationOnce(async job => {
        if (boundary === 'ready') {
          const plan = f.store.getSourcePlan(job.planId!)
          f.store.verifyPreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision,
            recheckedTreeDigest: plan.sourceCheck!.treeDigest, recheckedPatchDigest: plan.sourceCheck!.patchDigest,
            withSourceFence: callback => f.withGapSourceFence!(job.intent.gapId, job.intent.owner, callback) })
        }
        throw new Error('release helper response unavailable')
      })
      const queued = await f.enqueue(), active = f.activation(queued.id)
      const outcome = await f.executor!.execute({ occurrenceId: 'prepared-release', automationId: queued.id, definitionHash: active.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(outcome.outcome).toBe('unknown')
      const job = f.store.getSourceJob(queued.id)!
      expect(f.store.getSourcePlan(job.planId!).status).toBe(boundary === 'ready' ? 'ready-for-human-review' : 'approved')
      expect(f.releasePrepared).toHaveBeenCalledTimes(1)
      await f.runtime.close()
      if (boundary === 'source-change') f.setSourceCurrent(false)
      if (boundary === 'trust-change') Object.assign(f.trust, { installationId: 'changed' })
      restarted = f.createRuntime(); restarted.start()
      await f.tickContinuation(); await restarted.close()
      expect(f.prepare).toHaveBeenCalledTimes(1)
      expect(f.approvePrepared).toHaveBeenCalledTimes(1)
      expect(f.releasePrepared).toHaveBeenCalledTimes(boundary.endsWith('change') ? 1 : 2)
    } finally { await restarted?.close(); await f.runtime.close(); f.store.close() }
  })

  it('rejects a typed task-failure gap when the Host provenance fence is unavailable', async () => {
    const f = await fixture({ typed: true, fence: false })
    try {
      await expect(f.enqueue()).rejects.toThrow(/provenance service unavailable/)
      expect(f.store.listSourceJobs()).toEqual([])
      expect(f.prepare).not.toHaveBeenCalled()
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('settles a queued typed task-failure source job before dispatch when its source is no longer current', async () => {
    const f = await fixture({ typed: true })
    try {
      const queued = await f.enqueue()
      f.setSourceCurrent(false)
      const activation = f.activation(queued.id)
      const outcome = await f.executor!.execute({ occurrenceId: 'typed-preflight', automationId: queued.id, definitionHash: activation.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: activation.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(outcome.outcome).toBe('failed')
      expect(f.store.getSourceJob(queued.id)).toMatchObject({ status: 'failed' })
      expect(f.prepare).not.toHaveBeenCalled()
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('marks a claimed typed task-failure job unknown when the source changes during preparation', async () => {
    const f = await fixture({ typed: true })
    try {
      const queued = await f.enqueue()
      f.prepare.mockImplementationOnce(async (_job, _signal, assertCurrent) => {
        f.setSourceCurrent(false)
        await assertCurrent()
        throw new Error('unreachable after source fence rejection')
      })
      const activation = f.activation(queued.id)
      const outcome = await f.executor!.execute({ occurrenceId: 'typed-claimed', automationId: queued.id, definitionHash: activation.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: activation.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(outcome.outcome).toBe('unknown')
      expect(f.store.getSourceJob(queued.id)).toMatchObject({ status: 'unknown' })
      expect(f.store.getSourceJob(queued.id)?.planId).toBeUndefined()
      expect(f.prepare).toHaveBeenCalledTimes(1)
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('settles a queued typed task-failure job on restart when its source is no longer current', async () => {
    const f = await fixture({ typed: true })
    try {
      const queued = await f.enqueue()
      await f.runtime.close()
      f.setSourceCurrent(false)
      const restarted = f.createRuntime()
      restarted.start()
      expect(f.store.getSourceJob(queued.id)).toMatchObject({ status: 'failed' })
      expect(f.store.getSourceJob(queued.id)?.planId).toBeUndefined()
      expect(f.prepare).not.toHaveBeenCalled()
      await restarted.close()
    } finally { try { await f.runtime.close() } catch {} f.store.close() }
  })

  it('aborts and drains a claimed Host execution before closing its ledger', async () => {
    const f = await fixture()
    try {
      const queued = await f.enqueue()
      let started!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      f.prepare.mockImplementationOnce(async (_job, signal, assertCurrent) => {
        started()
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        await assertCurrent()
        throw new Error('late preparation must not reach here')
      })
      const activation = f.activation(queued.id)
      const running = f.executor!.execute({ occurrenceId: 'cancelled', automationId: queued.id, definitionHash: activation.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: activation.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      await entered
      await f.runtime.close()
      expect((await running).outcome).toBe('unknown')
      expect(f.store.getSourceJob(queued.id)?.status).toBe('unknown')
      expect(f.store.getGap(f.gap.id).status).toBe('open')
    } finally { await f.runtime.close(); f.store.close() }
  })
  it('lets the same owner in a new binding inspect and reconcile unknown work without replay', async () => {
    const f = await fixture()
    try {
      const queued = await f.enqueue()
      const current = f.store.getSourceJob(queued.id)!
      f.store.claimSourceJob({ id: current.id, revision: current.revision, definitionHash: current.definitionHash!, occurrenceId: 'interrupted' })
      f.store.interruptSourceJobs()
      f.delivery.validateOwnerRoute.mockReturnValue({ ...receipt(), generation: 2, bindingVersion: 2, authorityHash: 'f'.repeat(64) })
      expect(f.runtime.inspect({ id: queued.id, owner: OWNER }).status).toBe('unknown')
      expect(() => f.runtime.inspect({ id: queued.id, owner: { ...OWNER, principalRecordId: 'another' } })).toThrow(/scope mismatch/)
      // OS ownership is separately exercised in source-build/resources tests.
      const cleanup = vi.spyOn(sourceBuild, 'removeSourceJobContainer').mockResolvedValue()
      const result = await f.runtime.reconcileUnknown({ id: queued.id, owner: OWNER })
      expect(result.status).toBe('failed')
      expect(cleanup).toHaveBeenCalledWith(build, { id: queued.id, containerName: `dsh-${queued.id}` })
      expect(f.prepare).not.toHaveBeenCalled()
    } finally { await f.runtime.close(); f.store.close() }
  })
  it.each(['owner', 'trust', 'gap'] as const)('rejects changed %s before source preparation', async changed => {
    const f = await fixture()
    try {
      const queued = await f.enqueue()
      if (changed === 'owner') f.delivery.validateOwnerRoute.mockReturnValue({ ...receipt(), generation: 2 })
      if (changed === 'trust') f.trust.dshHome = '/changed'
      if (changed === 'gap') {
        const database = new DatabaseSync(join(f.root, 'control.sqlite'))
        try { database.prepare('UPDATE capability_gaps SET revision = revision + 1 WHERE id = ?').run(f.gap.id) } finally { database.close() }
      }
      const activation = f.activation(queued.id)
      const outcome = await f.executor!.execute({ occurrenceId: 'drift', automationId: queued.id, definitionHash: activation.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: activation.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(outcome.outcome).not.toBe('succeeded')
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.store.getGap(f.gap.id).status).toBe('open')
      expect(f.store.getSourceJob(queued.id)?.planId).toBeUndefined()
    } finally { await f.runtime.close(); f.store.close() }
  })
  it('persists queued intent, registers paused then active, and returns a content-free projection', async () => {
    const f = await fixture()
    try {
      const result = await f.enqueue()
      expect(result).toMatchObject({ status: 'queued', gapId: f.gap.id, baseCommit: f.head })
      expect(result).not.toHaveProperty('files')
      expect(f.reconciles.map(item => item.desiredStatus)).toEqual(['paused', 'active'])
      expect(f.automations.inspectSystemOwnedActivation).toHaveBeenCalled()
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.runtime.inspect({ id: result.id, owner: OWNER })).toEqual(result)
      expect(() => f.runtime.inspect({ id: result.id, owner: { ...OWNER, principalRecordId: 'other' } })).toThrow(/scope mismatch/)
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('cleans up the source executor when continuation registration fails', async () => {
    const f = await fixture({ typed: true, approvals: true })
    try {
      await f.runtime.close()
      let unregistered = 0
      f.automations.registerHostExecutor
        .mockImplementationOnce((_value: HostAutomationExecutor) => () => { unregistered++ })
        .mockImplementationOnce(() => { throw new Error('continuation executor conflict') })
      const failed = f.createRuntime()
      expect(() => failed.start()).toThrow(/continuation executor conflict/)
      expect(unregistered).toBe(1)
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('rejects a forged continuation occurrence before its authority hook', async () => {
    const f = await fixture({ typed: true, approvals: true })
    try {
      f.approvePrepared.mockRejectedValueOnce(new Error('temporary approval outage'))
      const queued = await f.enqueue(), active = f.activation(queued.id)
      await f.executor!.execute({ occurrenceId: 'prepare-forged-continuation', automationId: queued.id, definitionHash: active.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(f.store.getSourceJob(queued.id)?.status).toBe('prepared')
      f.approvePrepared.mockClear()
      const continuation = f.continuation!, continuationActive = f.activation('source-job-prepared-continuations')
      const result = await continuation.execute({ occurrenceId: 'forged-continuation', automationId: 'source-job-prepared-continuations', definitionHash: continuationActive.definitionHash,
        executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId,
        ownerRouteId: OWNER.ownerRouteId, activationNonce: 'forged', catalogDigest: continuation.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(result.outcome).toBe('failed')
      expect(f.approvePrepared).not.toHaveBeenCalled()
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('fences exact executor identity and commits a prepared plan after caller abort', async () => {
    const f = await fixture()
    try {
      const queued = await f.enqueue()
      const first = f.activation(queued.id)
      const bad = await f.executor!.execute({ occurrenceId: 'bad', automationId: queued.id, definitionHash: first.definitionHash, executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId, ownerRouteId: OWNER.ownerRouteId, activationNonce: 'wrong', catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(bad.outcome).toBe('failed'); expect(f.prepare).not.toHaveBeenCalled()
      const caller = new AbortController()
      const second = await f.enqueue(caller.signal, 'job:two')
      const active = f.activation(second.id)
      caller.abort(new Error('model wake ended'))
      const outcome = await f.executor!.execute({ occurrenceId: 'occurrence-2', automationId: second.id, definitionHash: active.definitionHash, executionMode: 'production', targetScope: { workspace: OWNER.workspace, preset: OWNER.preset }, principal: OWNER.principalId, ownerRouteId: OWNER.ownerRouteId, activationNonce: active.activationNonce, catalogDigest: f.executor!.descriptor.catalogDigest, signal: new AbortController().signal })
      expect(outcome.outcome).toBe('succeeded')
      expect(f.prepare).toHaveBeenCalledTimes(1)
      expect(f.store.getSourceJob(second.id)).toMatchObject({ status: 'prepared' })
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('keeps accepted work after caller abort, and restart reconciles queued without replaying running work', async () => {
    const f = await fixture()
    try {
      const caller = new AbortController(); const job = await f.enqueue(caller.signal); caller.abort(new Error('model wake ended'))
      expect(f.store.getSourceJob(job.id)?.status).toBe('queued')
      await f.runtime.close()
      const bound = f.store.getSourceJob(job.id)!
      f.store.claimSourceJob({ id: job.id, revision: bound.revision, definitionHash: bound.definitionHash!, occurrenceId: 'claimed' })
      const runtime = new SourceJobRuntime({ config: { authorityId: 'source-authority', expiresAt: Date.now() + 60_000, maxSubmissions: 2, repository: f.root,
        ownerRouteId: OWNER.ownerRouteId, principalId: OWNER.principalId, workspace: OWNER.workspace, preset: OWNER.preset, budgetId: 'source-runs', budgetAmount: 1 }, build, statePath: f.root, store: f.store,
        ports: { automations: f.automations as any, delivery: { validateOwnerRoute: receipt } }, trust: async () => ({ dshHome: '/dsh', executor: { environmentAllowlist: [] } } as any), prepare: f.prepare })
      runtime.start()
      expect(f.store.getSourceJob(job.id)?.status).toBe('unknown')
      expect(f.prepare).not.toHaveBeenCalled()
      await runtime.close()
    } finally { try { await f.runtime.close() } catch {} f.store.close() }
  })
})
