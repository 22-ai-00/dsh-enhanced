import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceJobRuntime } from '../src/source-jobs.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'
import type { SourceJobRecord } from '../src/source-job-types.ts'
import type { SourcePreparedEvidence } from '../src/types.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'

const roots: string[] = []
const hex = (value: string) => createHash('sha256').update(value).digest('hex')
const OWNER = { ownerRouteId: 'route-1', principalId: 'owner-1', principalRecordId: 'record-1', principalVersion: 1, workspace: '/workspace', preset: 'primary' }
const build = { dockerPath: '/usr/bin/docker', image: `example@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000, memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 } as const

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function trust(root: string): PluginControlTrustConfig {
  return { schemaVersion: 4, installationId: '00000000-0000-4000-8000-000000000001', dshHome: root, ledger: { id: 'ledger', path: join(root, 'ledger.json') },
    executor: { id: 'executor', version: '1', path: '/bin/true', sha256: 'b'.repeat(64), environmentAllowlist: [] },
    hostPolicy: { readinessMinimumChecks: 1, effectBlockedMinimumDeliveryAttempts: 1, effectBlockedMinimumToolExecutionAttempts: 1, shadowMinimumSamples: 1, shadowMaximumMismatches: 0, canaryMinimumSamples: 1, canaryMaximumFailures: 0, soakMinimumWindowMs: 60_000, soakMinimumSamples: 1, soakMaximumFailureRate: 0, healthMinimumChecks: 1, healthMaximumFailures: 0, receiptTtlMs: 30_000 },
    catalog: { id: 'catalog', path: join(root, 'catalog.json') }, releaseReceiptTtlMs: 30_000, approvalKeys: [], hostAttestationKeys: [], releaseKeys: [], releaseAuthorizationKeys: [] }
}

function evidence(): SourcePreparedEvidence {
  return { schemaVersion: 1, kind: 'dsh-source-prepared-evidence', environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'test', pnpmVersion: 'test' },
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: 'e'.repeat(64) }], pack: { name: 'health-helper', version: '1.0.0', sizeBytes: 1, sha256: 'd'.repeat(64) }, preparedAt: Date.now() }
}

async function fixture(options: { budget?: 'ok' | 'missing' | 'exhausted'; policyExecute?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-native-source-jobs-'))); roots.push(root)
  await mkdir(join(root, 'plugins', 'health-helper', 'src'), { recursive: true }); await writeFile(join(root, 'plugins', 'health-helper', 'src', 'index.ts'), 'export {}\n')
  execFileSync('/usr/bin/git', ['init', root]); execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'test@example.invalid']); execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Test']); execFileSync('/usr/bin/git', ['-C', root, 'add', '.']); execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'fixture'])
  const head = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const ctx = new Context()
  const budgetId = options.budget === 'missing' ? 'missing-budget' : 'source-budget'
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), budgets: options.budget === 'missing' ? [] : [{ id: budgetId, metric: 'automation-runs', limit: options.budget === 'exhausted' ? 0 : 2, periodMs: 60_000, scope: 'global' }], rules: [
    { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: OWNER.workspace, principal: OWNER.principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ...(options.policyExecute === false ? [] : [{ id: 'execute', effect: 'allow' as const, subject: { kind: 'background' as const, id: '*', workspace: OWNER.workspace, principal: OWNER.principalId }, actions: ['execute'], resource: { kind: 'automation' as const, id: '*' }, context: { initiators: ['background' as const] } }]),
  ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const store = new ControlPlaneStore({ path: join(root, 'control.sqlite') }); const gap = store.recordGap({ idempotencyKey: `gap:${options.budget ?? 'ok'}`, capability: 'health', context: 'native', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  const config = { authorityId: 'source-authority', expiresAt: Date.now() + 60_000, maxSubmissions: 2, repository: root, ownerRouteId: OWNER.ownerRouteId, principalId: OWNER.principalId, workspace: OWNER.workspace, preset: OWNER.preset, budgetId, budgetAmount: 1 }
  const prepare = async (job: SourceJobRecord) => store.createSourcePlan({ gapId: job.intent.gapId, repository: job.intent.repository, worktree: job.intent.worktree, baseCommit: job.intent.baseCommit, name: job.intent.name, generatorDigest: MODIFY_GENERATOR_DIGEST, scope: [`plugins/${job.intent.name}`], mode: 'modify', ttlMs: job.intent.ttlMs, idempotencyKey: `source-job-plan:${job.id}`, sourceJob: { jobId: job.id, jobRevision: job.revision, occurrenceId: job.occurrenceId! }, prepared: { treeDigest: 'b'.repeat(64), patchDigest: 'c'.repeat(64), checkedAt: Date.now(), evidence: evidence() } }).result
  const createRuntime = () => new SourceJobRuntime({ config, build, statePath: root, store, ports: { automations, delivery: { validateOwnerRoute: () => ({ receiptVersion: 2, authorityId: OWNER.ownerRouteId, authorityHash: hex('route'), principalId: OWNER.principalId, principalRecordId: OWNER.principalRecordId, principalVersion: 1, workspace: OWNER.workspace, agentPreset: OWNER.preset, bindingVersion: 1, generation: 1 }) } }, trust: async () => trust(root), prepare })
  const runtime = createRuntime()
  runtime.start()
  const enqueue = (key: string) => runtime.enqueue({ gapId: gap.id, name: 'health-helper', repository: root, files: [{ path: 'src/index.ts', content: 'export const changed = true\n' }], idempotencyKey: key, expectedBaseCommit: head, ttlMs: 900_000, owner: OWNER, signal: new AbortController().signal, assertCurrent: () => undefined })
  return { ctx, automations, store, gap, runtime, createRuntime, enqueue }
}

describe('native Automations + Policy source jobs', () => {
  it('runs the native Host scheduler to a checked modify plan without an Agent service', async () => {
    const f = await fixture()
    try { const queued = await f.enqueue('native:success'); await new Promise(resolve => setTimeout(resolve, 1_100)); await f.automations.tick(); await f.automations.whenIdle(); expect(f.store.getSourceJob(queued.id)).toMatchObject({ status: 'prepared' }) }
    finally { await f.runtime.close(); f.store.close() }
  })

  it('uses native Policy budget refusal before Host claim, then releases the outstanding slot', async () => {
    const f = await fixture({ budget: 'missing' })
    try {
      const queued = await f.enqueue('native:budget-denied')
      await new Promise(resolve => setTimeout(resolve, 1_100)); await f.automations.tick(); await f.automations.whenIdle()
      expect(f.runtime.inspect({ id: queued.id, owner: OWNER })).toMatchObject({ status: 'failed', failureCode: 'source-job-host-terminated-before-claim' })
      await expect(f.enqueue('native:after-denial')).resolves.toMatchObject({ status: 'queued' })
    } finally { await f.runtime.close(); f.store.close() }
  })

  it('restarts a queued past-due native automation and executes exactly one occurrence', async () => {
    const f = await fixture()
    let restarted: SourceJobRuntime | undefined
    try {
      const queued = await f.enqueue('native:restart')
      await f.runtime.close(); await new Promise(resolve => setTimeout(resolve, 1_100))
      restarted = f.createRuntime(); restarted.start()
      await f.automations.tick(); await f.automations.whenIdle()
      expect(f.store.getSourceJob(queued.id)).toMatchObject({ status: 'prepared' })
      await f.automations.tick(); await f.automations.whenIdle()
      expect(f.store.getSourceJob(queued.id)?.revision).toBe(4)
    } finally { await restarted?.close(); f.store.close() }
  })
})
