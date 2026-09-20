import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../src/catalog.ts', () => ({ loadCatalogWithMetadata: vi.fn(), discover: vi.fn() }))
vi.mock('../src/cli.ts', () => ({ activatePluginPlan: vi.fn(), probePluginPlan: vi.fn() }))
vi.mock('../src/source-approval-client.ts', () => ({ validateSourceApprovalClientConfig: vi.fn(), requestSourceAuthorityReceipt: vi.fn() }))
vi.mock('../src/trust.ts', () => ({ resolveTrustKey: vi.fn(() => ({ authority: 'approval', keyId: 'key', publicKeyPem: 'unused' })) }))

import { loadCatalogWithMetadata, discover } from '../src/catalog.ts'
import { activatePluginPlan, probePluginPlan } from '../src/cli.ts'
import { requestSourceAuthorityReceipt } from '../src/source-approval-client.ts'
import { adoptSourceRelease, validateSourceAdoptionConfig, type SourceAdoptionConfig } from '../src/source-adoption-runner.ts'
import { controlPlaneDigest } from '../src/store.ts'
import type { CatalogEntry } from '../src/catalog.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import type { PluginActivationPlan } from '../src/types.ts'

const roots: string[] = []; const hex = (character: string) => character.repeat(64)
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(status: PluginActivationPlan['status'] = 'pending-approval', rollbackProfileRestored = false) {
  const root = await mkdtemp(join(tmpdir(), 'source-adoption-runner-')); roots.push(root); const dshHome = join(root, 'dsh'); await mkdir(join(dshHome, 'profiles'), { recursive: true })
  const candidate: CatalogEntry = { id: 'health-helper', package: '@dsh-enhanced/health-helper', version: '1.2.3', integrity: 'sha512-YQ==', dshBaseline: '0.1.0', registry: { id: 'registry', locator: 'https://registry.example/', reference: 'https://registry.example/health-helper-1.2.3.tgz' }, capabilities: ['health'], authorities: ['network'], requires: [] }
  const target = { dshHome, profile: 'default', profilePath: join(dshHome, 'profiles', 'default') }
  const trust = { installationId: 'installation', dshHome, ledger: { id: 'ledger', path: '/ledger' }, executor: { id: 'executor', version: '1.0.0', path: '/bin/executor', sha256: hex('a') }, catalog: { id: 'catalog', path: '/catalog' } } as unknown as PluginControlTrustConfig
  const source = { id: 'source-plan', status: 'release-complete', mode: 'modify', gapId: 'gap', gapSnapshot: { capability: 'health' } }
  let plan: PluginActivationPlan = { schemaVersion: 4, kind: 'activation', id: 'activation-plan', gapId: 'gap',
    gapSnapshot: { revision: 1, inputDigest: hex('f'), roi: 1, capability: 'health' }, digest: hex('b'), status, revision: 1, createdAt: 1, expiresAt: Date.now() + 60_000,
    profile: target.profile, candidate, dossier: { catalogDigest: hex('c'), catalogProvenance: 'owner-provided-integrity-pinned', matchedCapabilities: ['health'], authorities: ['network'], packages: [{ package: candidate.package, version: candidate.version, integrity: candidate.integrity, registry: candidate.registry! }] }, installationId: 'installation', ledger: trust.ledger, target,
    executor: trust.executor, ...(status === 'pending-approval' ? {} : { activation: { id: 'activation', fence: 1, updatedAt: 1, ...(rollbackProfileRestored ? { rollbackProfileRestored: true } : {}) } }) }
  const store = {
    getSourcePlan: vi.fn(() => source), sourceReleaseCandidate: vi.fn(() => candidate), findSourceAdoption: vi.fn<() => PluginActivationPlan | undefined>(() => undefined),
    createPlan: vi.fn(() => ({ result: plan })), getPlan: vi.fn(() => plan), getOwnerTaskFailureReference: vi.fn(() => ({ owner: 'owner' })),
    approve: vi.fn(async () => { plan = { ...plan, status: 'approved', revision: 2 } as PluginActivationPlan; return { result: plan } }),
    prepareAdoptionHandoff: vi.fn(), assertAdoptionHandoff: vi.fn(), revokeAdoptionHandoff: vi.fn(),
    requestActivationRollback: vi.fn(input => { plan = { ...plan, status: 'rollback-pending', revision: plan.revision + 1, activation: { ...plan.activation!, fence: input.fence } }; return plan }),
  }
  const config: SourceAdoptionConfig = { profile: 'default', planTtlMs: 60_000, timeoutMs: 10_000, authority: { executable: { path: '/authority', sha256: hex('d') }, configPath: '/authority.json', timeoutMs: 1_000 } }
  vi.mocked(loadCatalogWithMetadata).mockResolvedValue({ catalog: { schemaVersion: 1, entries: [candidate] }, digest: hex('c'), provenance: 'owner-provided-integrity-pinned' })
  vi.mocked(discover).mockReturnValue([candidate])
  vi.mocked(requestSourceAuthorityReceipt).mockImplementation(async (_config, request, parse) => parse({ schemaVersion: 1, approvalId: 'receipt', authority: 'approval', keyId: 'key', planId: request.planId, planDigest: request.planDigest, decision: 'approved', principal: 'principal', decidedAt: 1, expiresAt: 2, signature: 'YQ==' }))
  vi.mocked(activatePluginPlan).mockImplementation(async () => { plan = { ...plan, status: 'awaiting-reload', revision: plan.revision + 1, activation: { id: 'activation', fence: 1 } } as PluginActivationPlan; return plan })
  vi.mocked(probePluginPlan).mockImplementation(async () => { plan = { ...plan, status: 'activated', revision: plan.revision + 1, activation: { id: 'activation', fence: 1 } } as PluginActivationPlan; return plan })
  return { store, source, candidate, trust, config, state: () => plan }
}

test('creates one exact linked plan, obtains one receipt, then uses the shared activation and probe engine', async () => {
  const value = await fixture(); const output = await adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust,
    config: value.config, assertCurrent: async () => {}, withSourceFence: callback => callback() })
  expect(output.status).toBe('activated'); expect(value.store.createPlan).toHaveBeenCalledWith(expect.objectContaining({ sourcePlanId: value.source.id, candidate: value.candidate, idempotencyKey: `source-adoption:${value.source.id}` }))
  expect(requestSourceAuthorityReceipt).toHaveBeenCalledTimes(1); expect(value.store.approve).toHaveBeenCalledTimes(1)
  expect(activatePluginPlan).toHaveBeenCalledTimes(1); expect(probePluginPlan).toHaveBeenCalledTimes(1)
  expect(vi.mocked(requestSourceAuthorityReceipt).mock.calls[0]![1]).toMatchObject({ protocol: 'dsh-source-adoption/v1', sourceReferenceDigest: controlPlaneDigest({ owner: 'owner' }) })
})

test('refuses catalog candidate drift before asking the signer', async () => {
  const value = await fixture(); vi.mocked(loadCatalogWithMetadata).mockResolvedValueOnce({ catalog: { schemaVersion: 1, entries: [{ ...value.candidate, version: '9.9.9' }] }, digest: hex('c'), provenance: 'owner-provided-integrity-pinned' })
  await expect(adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust, config: value.config, assertCurrent: async () => {}, withSourceFence: callback => callback() })).rejects.toThrow('exact applicable')
  expect(requestSourceAuthorityReceipt).not.toHaveBeenCalled()
})

test('checks current authority after preflight and before making a durable plan claim', async () => {
  const value = await fixture(); const controller = new AbortController()
  await expect(adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust, config: value.config, signal: controller.signal,
    assertCurrent: async () => { controller.abort() }, withSourceFence: callback => callback() })).rejects.toThrow()
  expect(value.store.createPlan).not.toHaveBeenCalled(); expect(requestSourceAuthorityReceipt).not.toHaveBeenCalled()
})

test('withdrawal while awaiting recovery requests rollback and lets the engine restore without the aborted signal', async () => {
  const value = await fixture('awaiting-reload'); value.store.findSourceAdoption.mockReturnValue(value.state())
  const controller = new AbortController(); vi.mocked(activatePluginPlan).mockImplementation(async input => { expect(input.signal).toBeInstanceOf(AbortSignal); expect(input.signal).not.toBe(controller.signal); return { ...value.state(), status: 'rolled-back' } })
  await expect(adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust, config: value.config, signal: controller.signal,
    assertCurrent: async () => { controller.abort() }, withSourceFence: callback => callback() })).rejects.toThrow()
  expect(value.store.requestActivationRollback).toHaveBeenCalledTimes(1); expect(requestSourceAuthorityReceipt).not.toHaveBeenCalled()
})

test('catalog drift on an existing exposed plan enters recovery instead of forward approval', async () => {
  const value = await fixture('awaiting-reload'); value.store.findSourceAdoption.mockReturnValue(value.state())
  vi.mocked(loadCatalogWithMetadata).mockResolvedValueOnce({ catalog: { schemaVersion: 1, entries: [{ ...value.candidate, version: '9.9.9' }] }, digest: hex('c'), provenance: 'owner-provided-integrity-pinned' })
  await expect(adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust, config: value.config, assertCurrent: async () => {}, withSourceFence: callback => callback() })).rejects.toThrow('exact applicable')
  expect(value.store.requestActivationRollback).toHaveBeenCalledTimes(1); expect(requestSourceAuthorityReceipt).not.toHaveBeenCalled()
})

test('a physically restored rollback requests the shared signed recovery probe without another source signature', async () => {
  const value = await fixture('rollback-pending', true); value.store.findSourceAdoption.mockReturnValue(value.state())
  const output = await adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust, config: value.config, assertCurrent: async () => {}, withSourceFence: callback => callback() })
  expect(output.status).toBe('activated'); expect(activatePluginPlan).not.toHaveBeenCalled(); expect(probePluginPlan).toHaveBeenCalledTimes(1); expect(requestSourceAuthorityReceipt).not.toHaveBeenCalled()
})

test('validates bounded, exact runner config synchronously', () => {
  const config = { profile: 'default', planTtlMs: 60_000, timeoutMs: 1_000, authority: { executable: { path: '/authority', sha256: hex('a') }, configPath: '/config', timeoutMs: 1_000 } }
  expect(() => validateSourceAdoptionConfig(config)).not.toThrow()
  expect(() => validateSourceAdoptionConfig({ ...config, profile: '../bad' })).toThrow('invalid source adoption config')
  expect(() => validateSourceAdoptionConfig({ ...config, timeoutMs: 999 })).toThrow('invalid source adoption config')
})

const handoff = { schemaVersion: 1 as const, coordinatorId: 'external-host', maximumWindowMs: 60_000, commit: 'target-host' as const }

test('target signs and hands off an approved repair without restarting itself', async () => {
  const value = await fixture()
  value.config.handoff = handoff; value.state().dossier.handoff = handoff
  const output = await adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust,
    config: value.config, assertCurrent: async () => {}, withSourceFence: callback => callback() })
  expect(output.status).toBe('approved')
  expect(value.store.createPlan).toHaveBeenCalledWith(expect.objectContaining({ handoff }))
  expect(value.store.prepareAdoptionHandoff).toHaveBeenCalledWith({ planId: output.id, expectedRevision: output.revision })
  expect(activatePluginPlan).not.toHaveBeenCalled(); expect(probePluginPlan).not.toHaveBeenCalled()
})

test('target alone confirms commit after current feedback and live handoff checks', async () => {
  const value = await fixture('commit-pending')
  value.config.handoff = handoff; value.state().dossier.handoff = handoff
  value.store.findSourceAdoption.mockReturnValue(value.state())
  const current = vi.fn(async () => {})
  vi.mocked(activatePluginPlan).mockResolvedValue({ ...value.state(), status: 'activated' })
  const output = await adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust,
    config: value.config, assertCurrent: current, withSourceFence: callback => callback() })
  expect(output.status).toBe('activated'); expect(current).toHaveBeenCalled()
  expect(value.store.assertAdoptionHandoff).toHaveBeenCalledWith(output.id)
  expect(activatePluginPlan).toHaveBeenCalledTimes(1); expect(probePluginPlan).not.toHaveBeenCalled()
})

test.each([false, true])('handoff withdrawal revokes, target unload preserves delegation (unload=%s)', async unload => {
  const value = await fixture('awaiting-reload'), controller = new AbortController()
  value.config.handoff = handoff; value.state().dossier.handoff = handoff
  value.store.findSourceAdoption.mockReturnValue(value.state())
  await expect(adoptSourceRelease({ store: value.store as never, sourcePlanId: value.source.id, trust: value.trust,
    config: value.config, signal: controller.signal, assertCurrent: async () => {
      if (unload) controller.abort()
      throw new Error('source unavailable')
    }, withSourceFence: callback => callback() })).rejects.toThrow('source unavailable')
  expect(value.store.revokeAdoptionHandoff).toHaveBeenCalledTimes(unload ? 0 : 1)
  expect(activatePluginPlan).not.toHaveBeenCalled(); expect(value.store.requestActivationRollback).not.toHaveBeenCalled()
})
