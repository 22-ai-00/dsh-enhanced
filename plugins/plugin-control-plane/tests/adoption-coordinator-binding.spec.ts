import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { afterEach, expect, test, vi } from 'vitest'
import * as trustModule from '../src/trust.ts'

vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trustModule>(), loadTrustConfig: vi.fn() }))

import { PluginControlPlaneService, normalizeControlPlaneConfig } from '../src/service.ts'
import { ControlPlaneStore } from '../src/store.ts'

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  vi.resetAllMocks()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'cp-adoption-binding-')))
  const ctx = new Context()
  fixtures.push({ ctx, root })
  const statePath = join(root, 'coordinator'), targetState = join(root, 'target')
  await mkdir(statePath, { mode: 0o700 }); await mkdir(targetState, { mode: 0o700 })
  const ledgerPath = join(targetState, 'control.sqlite'), catalogPath = join(root, 'catalog.json')
  const trustPath = join(root, 'trust.json'), automationPath = join(root, 'automations.sqlite')
  await writeFile(trustPath, '{}\n', { mode: 0o600 })
  const target = new ControlPlaneStore({ path: ledgerPath })
  target.close()
  vi.mocked(trustModule.loadTrustConfig).mockResolvedValue({ ledger: { path: ledgerPath },
    catalog: { path: catalogPath } } as Awaited<ReturnType<typeof trustModule.loadTrustConfig>>)
  const adoptionCoordinator = { coordinatorId: 'coordinator', scope: { workspace: root,
    preset: 'primary', principalId: 'owner', ownerRouteId: 'owner-route' },
    timeoutMs: 30_000, budgetId: 'coordinator-budget', budgetAmount: 1 }
  const config = { statePath, catalogPath, trustPath, adoptionCoordinator }
  return { ctx, root, statePath, ledgerPath, catalogPath, trustPath, automationPath, config }
}

test('separate coordinator state uses signed target ledger and registers a fresh native automation', async () => {
  const value = await fixture()
  await value.ctx.plugin(AssistantPolicyService, { databasePath: join(value.root, 'policy.sqlite'),
    budgets: [{ id: 'coordinator-budget', metric: 'automation-runs', limit: 10, periodMs: 60_000, scope: 'subject' }],
    rules: [{ id: 'allow-coordinator-reconcile', effect: 'allow', subject: { kind: 'background', id: '*' },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } }],
  })
  await value.ctx.plugin(AssistantAutomationsService, { databasePath: value.automationPath,
    runsPath: join(value.root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0,
    allowUnbudgetedExecution: false, proposalDefaults: { provider: 'test', model: 'test', allowedTools: [],
      timeoutMs: 30_000, maxOutputTokens: 32, maxToolCalls: 0, misfireKind: 'latest', misfireLimit: 1,
      overlap: 'skip', retrySafety: 'never', maxRetries: 0, budgetId: 'coordinator-budget', budgetAmount: 1 } })
  const owner = 'plugin-control-plane-adoption-coordinator'
  expect(value.ctx.assistantAutomations.listSystemOwned({ owner })).toEqual([])
  await value.ctx.plugin(PluginControlPlaneService, value.config)
  await vi.waitFor(() => {
    const records = value.ctx.assistantAutomations.listSystemOwned({ owner })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ owner, automationStatus: 'active',
      definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(value.ctx.assistantAutomations.inspectSystemOwnedActivation({ owner,
      automationId: records[0]!.automationId })).toMatchObject({
      definitionHash: records[0]!.definitionHash,
      activationNonce: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ownerRouteId: value.config.adoptionCoordinator.scope.ownerRouteId,
    })
  })
})

test('ordinary Control Plane keeps same-ledger trust binding and rejects mismatched catalog', async () => {
  const value = await fixture()
  const service = new PluginControlPlaneService(value.ctx, {
    statePath: value.statePath, catalogPath: value.catalogPath, trustPath: value.trustPath })
  await expect((service as unknown as { boundTrust(): Promise<unknown> }).boundTrust())
    .rejects.toThrow('configured ledger/catalog do not match')
  vi.mocked(trustModule.loadTrustConfig).mockResolvedValue({ ledger: { path: join(value.statePath, 'control.sqlite') },
    catalog: { path: join(value.root, 'other-catalog.json') } } as Awaited<ReturnType<typeof trustModule.loadTrustConfig>>)
  await expect((service as unknown as { boundTrust(): Promise<unknown> }).boundTrust())
    .rejects.toThrow('configured ledger/catalog do not match')
})

test('coordinator rejects shared local ledger, mismatched catalog, and mixed-role configuration', async () => {
  const value = await fixture()
  const service = new PluginControlPlaneService(value.ctx, value.config)
  vi.mocked(trustModule.loadTrustConfig).mockResolvedValue({ ledger: { path: join(value.statePath, 'control.sqlite') },
    catalog: { path: value.catalogPath } } as Awaited<ReturnType<typeof trustModule.loadTrustConfig>>)
  await expect((service as unknown as { boundTrust(): Promise<unknown> }).boundTrust())
    .rejects.toThrow('configured ledger/catalog do not match')
  vi.mocked(trustModule.loadTrustConfig).mockResolvedValue({ ledger: { path: value.ledgerPath },
    catalog: { path: join(value.root, 'other-catalog.json') } } as Awaited<ReturnType<typeof trustModule.loadTrustConfig>>)
  await expect((service as unknown as { boundTrust(): Promise<unknown> }).boundTrust())
    .rejects.toThrow('configured ledger/catalog do not match')
  expect(() => normalizeControlPlaneConfig({ ...value.config, sourceJobs: {} as never }))
    .toThrow('adoptionCoordinator requires a separate Host')
  expect(() => normalizeControlPlaneConfig({ ...value.config, adoptionCoordinator: {} as never }))
    .toThrow('invalid adoption coordinator')
})
