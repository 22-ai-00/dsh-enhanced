// Real public generator, Git worktrees, Control Plane/Automations/Policy and
// SQLite. Delivery/Evaluation and Docker are fixtures, not live acceptance.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginControlPlaneService } from '../src/service.ts'
import { ControlPlaneStore } from '../src/store.ts'
import * as build from '../src/source-build.ts'
import * as trust from '../src/trust.ts'
import { defaultHostAttestationPolicy } from '../src/trust.ts'
import type { SourcePreparedEvidence } from '../src/types.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'

vi.mock('../src/source-build.ts', async original => ({ ...await original<typeof build>(), runDockerPreparedChecks: vi.fn() }))
vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trust>(), loadTrustConfig: vi.fn() }))
const baselineRepository = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.resetAllMocks() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-created-service-')))
  const { repository } = await createSourceCreationFixture(baselineRepository, join(root, 'source'))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' }).trim()
  const ctx = new Context(), statePath = join(root, 'control'), catalogPath = join(root, 'catalog.json')
  cleanup.push(async () => {
    await ctx.fiber.dispose()
    // Test cleanup proves registration ownership before removing its own tree.
    const listing = git('worktree', 'list', '--porcelain')
    for (const line of listing.split('\n')) if (line.startsWith(`worktree ${statePath}/source-worktrees/`)) {
      git('worktree', 'remove', '--force', line.slice('worktree '.length))
    }
    await rm(root, { recursive: true, force: true })
  })
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const source: OwnerForegroundLearningTask = { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner,
    canonical: { scope: { workspace: root, preset: 'primary' }, scopeKey: 'scope', scopeWatermark: 1,
      triggerOutcomeId: 'feedback', situation: 'foreground:task',
      objective: { outcomeId: 'feedback', status: 'not-achieved', source: { kind: 'evaluator', id: 'assistant-verifier' },
        evaluator: { id: 'assistant-verifier', version: '1' }, evidence: [], occurredAt: now },
      projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox', version: 1, digest: 'b'.repeat(64), disposition: 'upsert' } },
    judgement: 'independent-verifier', source: { sessionId: 'session', inboxId: 'inbox', objective: 'ordinary failed task',
      quiescent: true, truncated: false, modelSelectionState: 'frozen', modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } } }
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => structuredClone(owner), inspectOwnerForegroundLearningTask: () => structuredClone(source) })
  ctx.provide('assistantEvaluation' as never, { canonicalHostScope: (input: unknown) => input,
    withTrustedCanonicalTaskWriterFence: (_input: unknown, callback: () => unknown) => ({ matched: true, value: callback() }) })
  const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'source-budget', metric: 'automation-runs', limit: 3, periodMs: 60_000, scope: 'global' }], rules: [
      { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: root, principal: 'owner' }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ schemaVersion: 4,
    installationId: '00000000-0000-4000-8000-000000000001', dshHome: root,
    ledger: { id: 'ledger', path: join(statePath, 'control.sqlite') }, catalog: { id: 'catalog', path: catalogPath },
    executor: { id: 'executor', version: '1', path: '/bin/true', sha256: 'a'.repeat(64), environmentAllowlist: [] },
    hostPolicy: defaultHostAttestationPolicy, releaseReceiptTtlMs: 30_000, approvalKeys: [], hostAttestationKeys: [], releaseKeys: [], releaseAuthorizationKeys: [] })
  const service = new PluginControlPlaneService(ctx, { statePath, catalogPath, trustPath: join(root, 'trust.json'),
    sourceBuild: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000, versioning: 'patch',
      memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
    sourceJobs: { authorityId: 'source-grant', expiresAt: now + 600_000, maxSubmissions: 3, repository,
      ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'primary', budgetId: 'source-budget', budgetAmount: 1,
      creation: { id: 'owner-create', expiresAt: now + 600_000, maxCreates: 2, namePrefix: 'rsi-service-' } } })
  await vi.waitFor(() => expect(service.canEnqueueSource()).toBe(true))
  const store = new ControlPlaneStore({ path: join(statePath, 'control.sqlite') })
  cleanup.push(async () => store.close())
  const gap = service.recordOwnerTaskFailureGap(structuredClone(source))
  const caller = { ownerRouteId: 'route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  const request = { repository, gapId: gap.id, name: 'rsi-service-helper', mode: 'create' as const, owner: caller,
    files: [{ path: 'README.md', content: '# Created plugin\n' }], expectedBaseCommit: git('rev-parse', 'HEAD'),
    ttlMs: 900_000, idempotencyKey: 'create-from-task', signal: new AbortController().signal, assertCurrent: () => undefined }
  // Docker remains a fixture: these bytes exercise the Host handoff, not npm
  // publication or real package behavior.
  const packArtifact = Buffer.from('fixture-package-bytes')
  const evidence: SourcePreparedEvidence = { schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'fixture', pnpmVersion: 'fixture' },
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: 'c'.repeat(64) }],
    pack: { name: 'dsh-enhanced-rsi-service-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: packArtifact.length,
      sha256: createHash('sha256').update(packArtifact).digest('hex') }, preparedAt: now }
  const checked: build.SourceBuildResult = { treeDigest: 'e'.repeat(64), patchDigest: 'f'.repeat(64), checkedAt: now, evidence, packArtifact }
  vi.mocked(build.runDockerPreparedChecks).mockResolvedValue(checked)
  return { root, repository, git, service, automations, policy, store, source, owner, request, checked, advance: () => { now += 1_100 } }
}

it('runs an ordinary owner failure through native scheduling into a checked new-plugin plan', async () => {
  const f = await fixture(), originalCatalog = await readFile(join(f.repository, 'plugins/README.md'), 'utf8')
  const reserve = vi.spyOn(f.policy, 'reserve')
  expect(f.service.getSourceCreationNamespace()).toEqual({ namePrefix: 'rsi-service-' })
  const view = await f.service.inspectCreateSource({ repository: f.repository, name: f.request.name, paths: ['src/index.ts'] })
  expect(view.baseCommit).toBe(f.request.expectedBaseCommit)
  const job = await f.service.enqueueSourceJob(f.request)
  expect(job).toMatchObject({ mode: 'create', status: 'queued' })
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const completed = f.service.inspectSourceJob({ id: job.id, owner: f.request.owner })
  expect(completed.status).toBe('prepared')
  const plan = f.store.getSourcePlan(completed.planId!)
  expect(plan).toMatchObject({ mode: 'prepared-create', status: 'pending-approval', creation: { grant: { id: 'owner-create' } } })
  expect(plan.scope).toEqual(['plugins/README.md', 'plugins/rsi-service-helper', 'pnpm-lock.yaml'])
  expect(plan.preparedEvidence).toEqual(f.checked.evidence)
  const candidate = f.service.inspectPreparedCreation(plan.id)
  expect(candidate.protocol).toBe('dsh-prepared-creation/v1')
  expect(candidate.artifact).toEqual(f.checked.packArtifact)
  expect(candidate.job.id).toBe(job.id)
  expect(candidate.source.source.modelSelection).toEqual(f.source.source.modelSelection)
  expect(candidate.reference.projection).toEqual(f.source.canonical.projection)
  expect(JSON.parse(await readFile(join(plan.worktree, 'plugins', plan.name, 'package.json'), 'utf8')).version).toBe('0.1.0')
  expect(await readFile(join(f.repository, 'plugins/README.md'), 'utf8')).toBe(originalCatalog)
  expect(reserve).toHaveBeenCalledOnce()
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  expect(vi.mocked(build.runDockerPreparedChecks).mock.calls[0]![0].capturePack).toBe(true)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  f.owner.generation += 1
  expect(() => f.service.inspectPreparedCreation(plan.id)).toThrow('task repair source or owner changed')
}, 30_000)

it.each(['manifest', 'lock', 'owner', 'artifact', 'missing-pack', 'pack-bytes'] as const)('rejects late %s drift before committing a creation plan', async drift => {
  const f = await fixture()
  vi.mocked(build.runDockerPreparedChecks).mockImplementationOnce(async input => {
    if (drift === 'manifest') await writeFile(join(input.worktree, 'plugins', input.name, 'package.json'), '{}\n')
    if (drift === 'lock') await writeFile(join(input.worktree, 'pnpm-lock.yaml'), 'tampered\n')
    if (drift === 'owner') f.owner.generation += 1
    if (drift === 'artifact') f.checked.evidence.pack.version = '9.9.9'
    if (drift === 'missing-pack') delete f.checked.packArtifact
    if (drift === 'pack-bytes') f.checked.packArtifact = Buffer.from('different-package-bytes')
    return f.checked
  })
  const job = await f.service.enqueueSourceJob(f.request)
  const worktree = f.store.getSourceJob(job.id)!.intent.worktree
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  // A claimed build with an unusable late result is unknown; it cannot replay
  // without reconciling the independently owned container outcome.
  expect(f.store.getSourceJob(job.id)?.status).toBe('unknown')
  expect(f.store.getSourceJob(job.id)?.planId).toBeUndefined()
  expect(f.git('worktree', 'list', '--porcelain')).not.toContain(`worktree ${worktree}\n`)
  expect(f.store.getGap(f.request.gapId).status).toBe('open')
}, 30_000)
