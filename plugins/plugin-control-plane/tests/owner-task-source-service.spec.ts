import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, test, vi } from 'vitest'
import { PluginControlPlaneService } from '../src/service.ts'
import * as workspace from '../src/source-workspace.ts'
import * as build from '../src/source-build.ts'
import { approvalSigningPayload } from '../src/approval.ts'
import * as approvalClient from '../src/source-approval-client.ts'
import * as trust from '../src/trust.ts'

// Host integration: real CP persistence, scripted Delivery/Evaluation and build
// ports. Native canonical fences have separate owner-task-gaps.spec coverage.
vi.mock('../src/source-workspace.ts', async original => ({ ...await original<typeof workspace>(),
  createIsolatedWorktree: vi.fn(), writeScopedPluginFiles: vi.fn(), runLocalCommand: vi.fn() }))
vi.mock('../src/source-build.ts', async original => ({ ...await original<typeof build>(), runDockerPreparedChecks: vi.fn() }))
vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trust>(), loadTrustConfig: vi.fn(), inheritedEnvironment: vi.fn(() => ({})) }))
vi.mock('../src/source-approval-client.ts', async original => ({ ...await original<typeof approvalClient>(), requestSourceApproval: vi.fn() }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.resetAllMocks() })

async function fixture(approvals = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-task-source-service-'))), ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const source: OwnerForegroundLearningTask = { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner,
    canonical: { scope: { workspace: root, preset: 'primary' }, scopeKey: 'scope', scopeWatermark: 1,
      triggerOutcomeId: 'outcome', situation: 'foreground:task',
      objective: { outcomeId: 'outcome', status: 'not-achieved', source: { kind: 'evaluator', id: 'assistant-verifier' },
        evaluator: { id: 'assistant-verifier', version: '1' }, evidence: [], occurredAt: Date.now() },
      projection: { subjectKind: 'foreground-turn', subjectRef: 'task', version: 1, digest: 'b'.repeat(64), disposition: 'upsert' } },
    judgement: 'independent-verifier', source: { sessionId: 'session', inboxId: 'task', objective: 'private task',
      quiescent: true, truncated: false, modelSelectionState: 'missing' } }
  const fence = vi.fn((_input: unknown, callback: () => unknown) => ({ matched: true, value: callback() }))
  ctx.provide('assistantDelivery' as never, { inspectOwnerForegroundLearningTask: () => structuredClone(source) })
  ctx.provide('assistantEvaluation' as never, { canonicalHostScope: (input: unknown) => input, withTrustedCanonicalTaskWriterFence: fence })
  const statePath = join(root, 'state'), catalogPath = join(root, 'catalog.json'), trustPath = join(root, 'trust.json')
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ledger: { path: join(statePath, 'control.sqlite') }, catalog: { path: catalogPath } } as Awaited<ReturnType<typeof trust.loadTrustConfig>>)
  const remove = vi.fn(async () => {}), worktree = join(root, 'worktree')
  vi.mocked(workspace.createIsolatedWorktree).mockResolvedValue({ worktree, remove } as Awaited<ReturnType<typeof workspace.createIsolatedWorktree>>)
  vi.mocked(workspace.runLocalCommand).mockResolvedValue('c'.repeat(40))
  const evidence = { schemaVersion: 1 as const, kind: 'dsh-source-prepared-evidence' as const,
    environment: { npmConfigIgnoreScripts: true as const, frozenLockfile: true as const, offline: true, nodeVersion: 'test', pnpmVersion: 'test' },
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0 as const, durationMs: 1, logDigest: 'e'.repeat(64) }],
    pack: { name: 'helper', version: '1.0.0', sizeBytes: 1, sha256: 'd'.repeat(64) }, preparedAt: Date.now() }
  const checked = { treeDigest: 'd'.repeat(64), patchDigest: 'e'.repeat(64), checkedAt: Date.now(), evidence }
  vi.mocked(build.runDockerPreparedChecks).mockResolvedValue(checked)
  const service = new PluginControlPlaneService(ctx, { statePath, catalogPath, trustPath,
    ...(approvals ? { sourceApprovals: { executable: { path: join(root, "authority.js"), sha256: "f".repeat(64) }, configPath: join(root, "authority.json"), timeoutMs: 1000 } } : {}),
    sourceBuild: { dockerPath: '/usr/bin/docker', image: `example@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
      memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 } })
  const gap = service.recordOwnerTaskFailureGap(structuredClone(source))
  const caller = { ownerRouteId: owner.authorityId, principalId: owner.principalId, principalRecordId: owner.principalRecordId,
    principalVersion: owner.principalVersion, workspace: root, preset: owner.agentPreset }
  const request = { gapId: gap.id, owner: caller, name: 'health-helper', repository: root,
    files: [{ path: 'src/index.ts', content: 'export {}' }], idempotencyKey: 'prepare-task-fix' }
  const count = () => { const db = new DatabaseSync(join(statePath, 'control.sqlite')); try {
    return (db.prepare('SELECT count(*) AS count FROM source_plans').get() as { count: number }).count
  } finally { db.close() } }
  return { service, source, owner, fence, remove, checked, request, count, ctx }
}

test('commits a checked task-bound proposal through the Host fence', async () => {
  const f = await fixture()
  expect((await f.service.prepareModifySourcePlan(f.request)).status).toBe('pending-approval')
  expect(f.count()).toBe(1)
  expect(f.remove).not.toHaveBeenCalled()
})

test('rejects a guessed task gap without caller ownership before acquiring a worktree', async () => {
  const f = await fixture()
  const { owner: _owner, ...request } = f.request
  await expect(f.service.prepareModifySourcePlan(request)).rejects.toThrow('caller')
  expect(workspace.createIsolatedWorktree).not.toHaveBeenCalled()
  expect(f.count()).toBe(0)
})

test('a source owner change during build removes the worktree without a plan', async () => {
  const f = await fixture()
  vi.mocked(build.runDockerPreparedChecks).mockImplementationOnce(async () => { f.owner.generation += 1; return f.checked })
  await expect(f.service.prepareModifySourcePlan(f.request)).rejects.toThrow('changed')
  expect(f.count()).toBe(0)
  expect(f.remove).toHaveBeenCalledOnce()
})

test('a final commit fence conflict removes the worktree and leaves no plan', async () => {
  const f = await fixture()
  vi.mocked(build.runDockerPreparedChecks).mockImplementationOnce(async () => {
    // The first fence checks post-build freshness; the second is the commit.
    let checks = 0
    f.fence.mockImplementation((_input, callback) => ++checks === 1
      ? { matched: true, value: callback() } : { matched: false, value: undefined })
    return f.checked
  })
  await expect(f.service.prepareModifySourcePlan(f.request)).rejects.toThrow('fence changed')
  expect(f.count()).toBe(0)
  expect(f.remove).toHaveBeenCalledOnce()
})

async function signedApprovalFixture() {
  const f = await fixture(true), plan = await f.service.prepareModifySourcePlan(f.request)
  const keys = generateKeyPairSync('ed25519')
  const bound = await trust.loadTrustConfig('ignored')
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ...bound, approvalKeys: [{ authority: 'authority', keyId: 'key',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] } as Awaited<ReturnType<typeof trust.loadTrustConfig>>)
  const unsigned = { schemaVersion: 1 as const, approvalId: 'approval', authority: 'authority', keyId: 'key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const receipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  vi.mocked(approvalClient.requestSourceApproval).mockResolvedValue(receipt)
  return { ...f, plan, receipt }
}

test('Host uses the finite authority receipt and current source fence, with idempotent completion', async () => {
  const f = await signedApprovalFixture()
  const approved = await f.service.requestOwnerSourceApproval({ planId: f.plan.id })
  expect(approved).toMatchObject({ status: 'approved', revision: 2 })
  expect(await f.service.requestOwnerSourceApproval({ planId: f.plan.id })).toEqual(approved)
  expect(approvalClient.requestSourceApproval).toHaveBeenCalledTimes(1)
  f.owner.generation += 1
  await expect(f.service.requestOwnerSourceApproval({ planId: f.plan.id })).rejects.toThrow('changed')
})

test.each(['source', 'cancel', 'trust'] as const)('rejects %s changes while authority is signing', async changed => {
  const f = await signedApprovalFixture(), abort = new AbortController()
  vi.mocked(approvalClient.requestSourceApproval).mockImplementationOnce(async () => {
    if (changed === 'source') f.owner.generation += 1
    if (changed === 'cancel') abort.abort()
    if (changed === 'trust') vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ...await trust.loadTrustConfig('ignored'), installationId: 'changed' })
    return f.receipt
  })
  await expect(f.service.requestOwnerSourceApproval({ planId: f.plan.id, signal: abort.signal })).rejects.toThrow()
  expect(f.count()).toBe(1)
})

test('Host disposal waits for the helper flight and suppresses its late signed response', async () => {
  const f = await signedApprovalFixture()
  let finish!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(approvalClient.requestSourceApproval).mockImplementationOnce(async () => {
    entered(); await new Promise<void>(resolve => { finish = resolve }); return f.receipt
  })
  const flight = f.service.requestOwnerSourceApproval({ planId: f.plan.id })
  const rejected = expect(flight).rejects.toThrow()
  await ready
  let disposed = false
  const disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  finish()
  await Promise.all([disposal, rejected])
})


test('durable approval rejects a changed frozen job trust before invoking the helper', async () => {
  const f = await signedApprovalFixture()
  await expect(f.service.requestOwnerSourceApproval({ planId: f.plan.id, expectedTrustDigest: '0'.repeat(64) })).rejects.toThrow('source job approval trust changed')
  expect(approvalClient.requestSourceApproval).not.toHaveBeenCalled()
})
