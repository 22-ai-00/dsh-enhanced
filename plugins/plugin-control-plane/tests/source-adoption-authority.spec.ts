import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'

const records = vi.hoisted(() => ({ value: undefined as unknown }))
vi.mock('../src/store.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/store.ts')>(),
  readOwnerSourceAdoptionPlan: () => records.value,
}))

import { Ed25519ApprovalAuthority } from '../src/approval.ts'
import { loadCatalogWithMetadata } from '../src/catalog.ts'
import { authorizeSourceAdoption, validateSourceAdoptionAuthorityConfig, type SourceAdoptionAuthorityConfig } from '../src/source-adoption-authority.ts'
import { controlPlaneDigest } from '../src/store.ts'
import type { CatalogEntry } from '../src/catalog.ts'
import type { OwnerTaskFailureReference } from '../src/owner-task-gap-types.ts'
import type { PluginActivationPlan, PluginSourcePlan } from '../src/types.ts'

const roots: string[] = []; const hex = (character: string) => character.repeat(64)
afterEach(async () => { records.value = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function owner(): OwnerTaskFailureReference {
  return { schemaVersion: 1, owner: { receiptVersion: 2, authorityId: 'owner', authorityHash: hex('a'), principalId: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', agentPreset: 'default', bindingVersion: 1, generation: 1 }, outcomeId: 'outcome', projection: { subjectKind: 'foreground-turn', subjectRef: 'turn', version: 1, digest: hex('b'), disposition: 'upsert' }, sourceDigest: hex('c') }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'source-adoption-authority-')); roots.push(root); const now = Date.now()
  const key = generateKeyPairSync('ed25519'); const keyPath = join(root, 'key.pem'); await writeFile(keyPath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const controlPath = join(root, 'control.sqlite'); const db = new DatabaseSync(controlPath); db.close(); await chmod(controlPath, 0o600)
  const candidate: CatalogEntry = { id: 'health-helper', package: '@dsh-enhanced/health-helper', version: '1.2.3', integrity: 'sha512-YQ==', dshBaseline: '0.1.0', registry: { id: 'registry', locator: 'https://registry.example/', reference: 'https://registry.example/health-helper-1.2.3.tgz' }, capabilities: ['health'], authorities: ['network'], requires: [] }
  const catalogPath = join(root, 'catalog.json'); await writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 1, entries: [candidate] })}\n`, { mode: 0o600 }); await chmod(catalogPath, 0o600)
  const loaded = await loadCatalogWithMetadata(catalogPath); const released = loaded.catalog.entries[0]!
  const source = owner(); const sourcePlan = { id: 'source-plan', status: 'release-complete' } as PluginSourcePlan
  const plan = { id: 'activation-plan', digest: hex('d'), status: 'pending-approval', expiresAt: now + 60_000, installationId: 'installation', ledger: { id: 'ledger', path: '/ledger' }, target: { dshHome: '/dsh', profile: 'default', profilePath: '/dsh/default.yml' }, executor: { id: 'executor', version: '1.0.0', path: '/bin/executor', sha256: hex('e') }, candidate: released, dossier: { catalogDigest: loaded.digest, catalogProvenance: 'owner-provided-integrity-pinned' } } as PluginActivationPlan
  records.value = { plan, sourcePlan, source, released }
  const config: SourceAdoptionAuthorityConfig = { schemaVersion: 1, authority: 'adoption-authority', keyId: 'key', keyPath, statePath: join(root, 'state.sqlite'), controlDatabasePath: controlPath, grant: { id: 'grant', expiresAt: now + 60_000, maxAdoptions: 1, owner: { authorityId: source.owner.authorityId, authorityHash: source.owner.authorityHash, principalId: source.owner.principalId, principalRecordId: source.owner.principalRecordId, principalVersion: source.owner.principalVersion, workspace: source.owner.workspace, agentPreset: source.owner.agentPreset }, installationId: plan.installationId, ledger: plan.ledger, target: plan.target, executor: plan.executor, catalogPath, receiptTtlMs: 30_000, policies: [{ candidateId: released.id, packageName: released.package, dshBaseline: released.dshBaseline, capabilities: released.capabilities, authorities: released.authorities, requires: released.requires, registryId: released.registry!.id, registryLocator: released.registry!.locator }] } }
  const request = { protocol: 'dsh-source-adoption/v1' as const, planId: plan.id, planDigest: plan.digest, sourceReferenceDigest: controlPlaneDigest(source) }
  return { config, request, key, plan, candidate, catalogPath }
}

test('signs one exact durable source adoption and replays its receipt', async () => {
  const value = await fixture(); const first = await authorizeSourceAdoption(value.config, value.request); const replay = await authorizeSourceAdoption(value.config, value.request)
  expect(replay).toEqual(first)
  const verifier = new Ed25519ApprovalAuthority(value.key.publicKey.export({ format: 'pem', type: 'spki' }), 'adoption-authority', 'key')
  await expect(verifier.verify(first, value.plan)).resolves.toMatchObject({ planId: value.plan.id, decision: 'approved' })
})

test('refuses fixed-policy, owner-binding, and current-catalog drift', async () => {
  const value = await fixture()
  await expect(authorizeSourceAdoption({ ...value.config, grant: { ...value.config.grant, policies: [{ ...value.config.grant.policies[0]!, authorities: [] }] } }, value.request)).rejects.toThrow('refused')
  await expect(authorizeSourceAdoption(value.config, { ...value.request, sourceReferenceDigest: hex('f') })).rejects.toThrow('refused')
  await writeFile(value.catalogPath, `${JSON.stringify({ schemaVersion: 1, entries: [{ ...value.candidate, version: '1.2.4' }] })}\n`, { mode: 0o600 })
  await expect(authorizeSourceAdoption(value.config, value.request)).rejects.toThrow('refused')
})

test('freezes the grant and rejects protected candidates', async () => {
  const value = await fixture(); await authorizeSourceAdoption(value.config, value.request)
  await expect(authorizeSourceAdoption({ ...value.config, grant: { ...value.config.grant, receiptTtlMs: 29_000 } }, value.request)).rejects.toThrow('refused')
  expect(() => validateSourceAdoptionAuthorityConfig({ ...value.config, grant: { ...value.config.grant, policies: [{ ...value.config.grant.policies[0]!, candidateId: 'plugin-control-plane', packageName: '@dsh-enhanced/plugin-control-plane' }] } })).toThrow('refused')
})


test('requires the owner grant to explicitly cover signed handoff terms', async () => {
  const value = await fixture()
  const handoff = { schemaVersion: 1 as const, coordinatorId: 'external-host', maximumWindowMs: 60_000, commit: 'target-host' as const }
  value.plan.dossier.handoff = handoff
  await expect(authorizeSourceAdoption(value.config, value.request)).rejects.toThrow('refused')
  const config = { ...value.config, grant: { ...value.config.grant, handoff: { ...handoff, coordinatorId: 'wrong-host' } } }
  await expect(authorizeSourceAdoption(config, value.request)).rejects.toThrow('refused')
  config.grant.handoff = handoff
  const receipt = await authorizeSourceAdoption(config, value.request)
  expect(receipt.planDigest).toBe(value.plan.digest)
  expect(receipt.expiresAt).toBeLessThanOrEqual(config.grant.expiresAt)
})
