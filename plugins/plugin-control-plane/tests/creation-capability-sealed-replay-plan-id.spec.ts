import { rmSync } from 'node:fs'
import { afterEach, expect, test } from 'vitest'
import { CreationCapabilityJournal } from '../src/creation-capability-journal.js'
import { assertSealedReplayPlanIdIsolated, planSealedAdoptionHandoff } from '../src/creation-capability-sealed-handoff.js'
import { roots, d, staged, apply, cutover } from './helpers/sealed-handoff-fixture.js'

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function sealed() {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  cutover(f)
  const check = (planId: string, expectedProofDigest = proof.digest) =>
    assertSealedReplayPlanIdIsolated({ physicalPath: f.path, expectedProofDigest, planId })
  return { ...f, plan, proof, check }
}

test('accepts a fresh replay plan id and binds the result to the signed proof', () => {
  const s = sealed()
  const result = s.check('source-replay-1')
  expect(result).toEqual({ protocol: 'dsh-sealed-replay-plan-id-isolation/v1', planId: 'source-replay-1', proofDigest: s.proof.digest,
    sealedRows: s.plan.history.rows.length })
  expect(Object.isFrozen(result)).toBe(true)
})

test('refuses every sealed history row, not only the ones pending reverification', () => {
  const s = sealed()
  const sealedIds = s.plan.history.rows.map(row => row.planId)
  expect(sealedIds).toEqual(expect.arrayContaining(['active', 'closed', 'rejected']))
  expect(s.plan.pendingReverification.map(row => row.planId)).toEqual(['active'])
  for (const planId of sealedIds) expect(() => s.check(planId)).toThrow(/plan id names a sealed row/u)
})

test('refuses a plan id that equals a sealed row ignoring case, and non-ASCII look-alikes', () => {
  const s = sealed()
  for (const planId of ['ACTIVE', 'Closed', 'reJected']) expect(() => s.check(planId)).toThrow(/collides with a sealed row/u)
  // Look-alikes outside the ASCII plan id alphabet never reach the comparison.
  for (const planId of ['ａctive', 'аctive']) expect(() => s.check(planId)).toThrow(/invalid plan id/u)
})

test('refuses a plan id already used by the live journal under the next authority', () => {
  const s = sealed()
  const journal = new CreationCapabilityJournal({ path: s.path, config: s.config })
  try { journal.claim({ certificate: s.certificate('fresh'), artifact: s.artifact }) } finally { journal.close() }
  expect(() => s.check('fresh')).toThrow(/already names a live adoption/u)
  expect(() => s.check('FRESH')).toThrow(/already names a live adoption/u)
  expect(s.check('fresh-2').planId).toBe('fresh-2')
})

test('fails closed on a wrong proof anchor, malformed input or a journal without a sealed proof', () => {
  const s = sealed()
  expect(() => s.check('source-replay-1', d('9'))).toThrow(/external proof anchor mismatch/u)
  expect(() => s.check('source-replay-1', 'not-a-digest')).toThrow(/invalid expected proof digest/u)
  expect(() => s.check('')).toThrow(/invalid plan id/u)
  expect(() => assertSealedReplayPlanIdIsolated(undefined as never)).toThrow(/invalid expected proof digest/u)
  const unsealed = staged()
  expect(() => assertSealedReplayPlanIdIsolated({ physicalPath: unsealed.path, expectedProofDigest: s.proof.digest, planId: 'x' }))
    .toThrow(/missing immutable proof|unexpected audit schema|sealed adoption handoff/u)
})

test('is exported from the package entry', async () => {
  expect((await import('../src/index.js')).assertSealedReplayPlanIdIsolated).toBe(assertSealedReplayPlanIdIsolated)
})
