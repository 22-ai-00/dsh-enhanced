import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { CreationReviewStore } from '../plugins/assistant-verifier/src/creation-review-store.js'
import { compileLegacyCreationReviewIdentity,
  type CreationReviewConfig, type LegacyCreationReviewConfig } from '../plugins/assistant-verifier/src/creation-review.js'
import * as verifier from '../plugins/assistant-verifier/src/review-maintenance.js'
import { stageOwnerEmptyAdoptionHandoff } from '../scripts/install/owner-empty-adoption-handoff.mjs'
import { stageOwnerReviewGrantHandoffs, preflightOwnerReviewGrantHandoffs } from '../scripts/install/owner-review-grant-handoff.mjs'
import { ownerProgramReviewHandoffMetadata, ownerProgramReviewLanes, verifyOwnerProgramReviewHandoffs } from '../scripts/install/owner-program-update.mjs'
import { ownerFixture, api as baseApi } from './fixtures/empty-owner-fixture.js'

const api = { ...baseApi, verifier }
type F = Parameters<NonNullable<Parameters<typeof ownerFixture>[1]>['reviewSeed']>[1]
const binding = 'c'.repeat(64)
const cache = new WeakMap<object, { old: CreationReviewConfig; next: CreationReviewConfig }>()

/** Docker-era old and linux-native next creation-review configs that differ only in runner backend. */
function reviews(f: F, nextRunner: Partial<CreationReviewConfig['runner']> = {}) {
  const cached = cache.get(f)
  if (cached) return cached
  const keyPath = join(f.root, 'review.pem'), stateRoot = join(f.root, 'creation-review-runner')
  if (!existsSync(keyPath)) writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const bounds = { stateRoot: realpathSync(stateRoot), expiresAt: f.config.runner.expiresAt, maxRuns: 16,
    maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 }
  const common = { authorityId: 'owner-creation-review', owner: f.config.owner, namePrefix: 'generated-', keyId: 'review-key', keyPath,
    expiresAt: f.config.expiresAt, maxVerifications: 4, policy: 'Verify the owner task contract.', maxInputBytes: 65_536,
    maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2, receiptTtlMs: 30_000 }
  const { backend, runtime, cgroupRoots } = f.config.runner as unknown as Record<string, unknown>
  const value = {
    old: { ...common, runner: { ...bounds, image: 'sha256:' + 'a'.repeat(64), dockerPath: realpathSync(process.execPath) } },
    next: { ...common, runner: { ...bounds, backend, runtime, cgroupRoots, ...nextRunner } },
  } as { old: LegacyCreationReviewConfig; next: CreationReviewConfig }
  cache.set(f, value)
  return value
}
/** Real review history under the old Docker authority: one unknown and one crash-left review-claimed row. */
function seedHistory(path: string, f: F) {
  const { old } = reviews(f), digest = compileLegacyCreationReviewIdentity(old).authority.authorityDigest
  const store = new CreationReviewStore<unknown>(path)
  try {
    store.claim('unknown', binding, old.authorityId, digest, old.maxVerifications); store.unknown('unknown', binding, 'uncertain')
    store.claim('crashed', binding, old.authorityId, digest, old.maxVerifications)
    store.discovered('crashed', binding, {}); store.contract('crashed', binding, { cases: [] }); store.claimReview('crashed', binding)
  } finally { store.close() }
}
const query = <T>(file: string, sql: string) => { const db = new DatabaseSync(file); try { return db.prepare(sql).all() as T[] } finally { db.close() } }

async function seeded(nextRunner?: Partial<CreationReviewConfig['runner']>) {
  const f = await ownerFixture(undefined, { reviews: g => reviews(g, nextRunner), reviewSeed: seedHistory })
  const laneInput = { ownerUpdate: f.ownerUpdate, manifest: f.nextManifest, history: f.stageHistory,
    homePath: f.root, physicalHome: f.stageHome, source: f.source, api }
  return { f, laneInput }
}
const stageLanes = (lanes: ReturnType<typeof ownerProgramReviewLanes>['lanes'], transactionId = 'transaction-1') =>
  stageOwnerReviewGrantHandoffs({ lanes: lanes.map(({ logicalPath: _l, ...entry }) => entry), api, transactionId,
    installationId: 'installation-1', profileId: 'assistant', now: Date.now() })

test('adoption-empty v2 history with a sealable review lane hands off the lane in place and signs a bound summary', async () => {
  const { f, laneInput } = await seeded()
  expect(f.stageHistory).toMatchObject({ protocol: 'dsh-owner-creation-history/v2', status: 'sealable', adoption: { status: 'empty' } })
  const { lanes, sealable } = ownerProgramReviewLanes(laneInput)
  expect(sealable).toEqual(['creation-reviews'])
  expect(lanes[0]).toMatchObject({ lane: 'creation-reviews', logicalDatabaseScope: 'verifier/creation-reviews' })
  expect(lanes[0]!.oldIdentity.authority.authorityDigest).not.toBe(lanes[0]!.nextIdentity.authority.authorityDigest)
  const file = lanes[0]!.physicalPath, rows = query(file, 'SELECT * FROM verifications ORDER BY plan')
  const beforeGrant = query<{ maximum: number; used: number }>(file, 'SELECT maximum, used FROM grants')
  // The empty adoption seam accepts the v2 history only with the review lanes it is bound to.
  const adoption = await stageOwnerEmptyAdoptionHandoff({ ownerUpdate: f.ownerUpdate, stageHome: f.stageHome, transactionId: 'transaction-1',
    manifest: f.nextManifest, candidateCreation: f.candidateCreation, stageHistory: f.stageHistory, source: f.source,
    sourceBuild: f.sourceBuild, api, reviewHandoffLanes: sealable })
  expect(adoption.metadata.protocol).toBe('dsh-owner-empty-adoption-handoff/v1')
  const result = await stageLanes(lanes)
  expect(result.lanes).toEqual([{ lane: 'creation-reviews', status: 'handed-off', headDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    grants: [{ authority: 'owner-creation-review', maximum: 4, used: 2 }] }])
  expect(query(file, 'SELECT maximum, used FROM grants')).toEqual(beforeGrant)
  expect(query(file, 'SELECT * FROM verifications ORDER BY plan')).toEqual(rows)
  const signed = ownerProgramReviewHandoffMetadata(result)
  expect(signed).toEqual({ protocol: 'dsh-owner-review-grant-handoffs/v1', transactionId: 'transaction-1', digest: result.digest,
    lanes: [{ lane: 'creation-reviews', status: 'handed-off', headDigest: result.lanes[0]!.headDigest }] })
  const next = { transactionId: 'transaction-1', reviewGrantHandoffs: { lanes, result } }
  const verify = (over: Record<string, unknown> = {}) => verifyOwnerProgramReviewHandoffs({ ownerUpdate: f.ownerUpdate,
    ownerUpdateNext: next, manifest: f.nextManifest, signed, homePath: f.root, physicalHome: f.stageHome, stopped: true, api, ...over })
  await verify()
  // Tampered signed head or carried digest is refused.
  await expect(verify({ signed: { ...signed, lanes: [{ ...signed.lanes[0], headDigest: 'd'.repeat(64) }] } })).rejects.toThrow('signed review grant handoff differs')
  await expect(verify({ ownerUpdateNext: { ...next, reviewGrantHandoffs: { lanes, result: { ...result, digest: 'e'.repeat(64) } } } }))
    .rejects.toThrow('signed review grant handoff differs')
  await expect(verify({ signed: undefined })).rejects.toThrow('signed review grant handoff differs')
  // After cutover new business keeps counting: post-cutover acceptance passes, stopped re-read refuses.
  const store = new CreationReviewStore<unknown>(file)
  try { store.claim('fresh', binding, 'owner-creation-review', lanes[0]!.nextIdentity.authority.authorityDigest, 4) } finally { store.close() }
  expect(query<{ used: number }>(file, 'SELECT used FROM grants')[0]!.used).toBe(3)
  await verify({ stopped: false })
  await expect(verify()).rejects.toThrow()
})

test('adoption-empty v2 history is refused by the empty seam without a bound review handoff', async () => {
  const { f, laneInput } = await seeded()
  const input = { ownerUpdate: f.ownerUpdate, stageHome: f.stageHome, transactionId: 'transaction-1', manifest: f.nextManifest,
    candidateCreation: f.candidateCreation, stageHistory: f.stageHistory, source: f.source, sourceBuild: f.sourceBuild, api }
  const before = readFileSync(ownerProgramReviewLanes(laneInput).lanes[0]!.physicalPath)
  await expect(stageOwnerEmptyAdoptionHandoff(input)).rejects.toThrow('stopped empty history is not bound')
  await expect(stageOwnerEmptyAdoptionHandoff({ ...input, reviewHandoffLanes: [] })).rejects.toThrow('not covered')
  await expect(stageOwnerEmptyAdoptionHandoff({ ...input, reviewHandoffLanes: ['revision-reviews'] })).rejects.toThrow('not covered')
  expect(readFileSync(ownerProgramReviewLanes(laneInput).lanes[0]!.physicalPath)).toEqual(before)
})

test('a lane that already holds a v2 audit from another transaction refuses before any write', async () => {
  const { laneInput } = await seeded()
  const { lanes } = ownerProgramReviewLanes(laneInput)
  await stageLanes(lanes, 'transaction-1')
  const before = readFileSync(lanes[0]!.physicalPath)
  await expect(stageLanes(lanes, 'transaction-2')).rejects.toMatchObject({ code: 'review-lineage-chain-unsupported' })
  expect(readFileSync(lanes[0]!.physicalPath)).toEqual(before)
  // The same transaction's retry stays idempotent.
  expect((await stageLanes(lanes, 'transaction-1')).lanes[0]!.status).toBe('handed-off')
})

test('a changed projected runner bound is refused before any write', async () => {
  const { laneInput } = await seeded({ maxTotalDurationMs: 90_000 })
  const { lanes } = ownerProgramReviewLanes(laneInput)
  const before = readFileSync(lanes[0]!.physicalPath)
  expect(() => preflightOwnerReviewGrantHandoffs({ lanes: lanes.map(({ logicalPath: _l, ...entry }) => entry), api,
    transactionId: 'transaction-1', now: Date.now() })).toThrow('review-runner-projection-changed')
  await expect(stageLanes(lanes)).rejects.toMatchObject({ code: 'review-runner-projection-changed' })
  expect(readFileSync(lanes[0]!.physicalPath)).toEqual(before)
})

test('configured but empty review lanes need no review handoff and keep the exact v1 empty path', async () => {
  const f = await ownerFixture(undefined, { reviews: g => reviews(g) })
  expect(f.stageHistory.protocol).toBe('dsh-owner-empty-creation-history/v1')
  expect(ownerProgramReviewLanes({ ownerUpdate: f.ownerUpdate, manifest: f.nextManifest, history: f.stageHistory,
    homePath: f.root, physicalHome: f.stageHome, source: f.source, api })).toEqual({ lanes: [], sealable: [] })
  const adoption = await stageOwnerEmptyAdoptionHandoff({ ownerUpdate: f.ownerUpdate, stageHome: f.stageHome, transactionId: 'transaction-1',
    manifest: f.nextManifest, candidateCreation: f.candidateCreation, stageHistory: f.stageHistory, source: f.source, sourceBuild: f.sourceBuild, api })
  expect(adoption.metadata.protocol).toBe('dsh-owner-empty-adoption-handoff/v1')
  await verifyOwnerProgramReviewHandoffs({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: { transactionId: 'transaction-1' },
    manifest: f.nextManifest, signed: undefined, homePath: f.root, physicalHome: f.stageHome, stopped: true, api })
})
