import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.js'
import { ControlPlaneStore, ControlPlaneStoreError } from '../src/store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const DIGEST = 'a'.repeat(64)

test('fresh control-plane ledgers carry the P1-4 benefit outcome table at schema 36', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-benefit-')); roots.push(root)
  const path = join(root, 'cp.sqlite')
  const database = openControlPlaneDatabase(path)
  try {
    expect(Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version))
      .toBe(controlPlaneSchemaVersion)
    const columns = (database.prepare("SELECT name FROM sqlite_schema WHERE name='source_revision_benefit_outcomes'").all()) as unknown[]
    expect(columns).toHaveLength(1)
  } finally { database.close() }
})

test('benefit outcomes reject invalid fields before touching the ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-benefit-')); roots.push(root)
  const store = new ControlPlaneStore({ path: join(root, 'cp.sqlite') })
  try {
    expect(() => store.recordRevisionBenefit('plan-1', {
      contractDigest: 'short', status: 'non-inferior', reason: 'ok', evaluation: {},
    })).toThrow(ControlPlaneStoreError)
    expect(() => store.recordRevisionBenefit('plan-1', {
      contractDigest: DIGEST, status: 'superior' as never, reason: 'ok', evaluation: {},
    })).toThrow(ControlPlaneStoreError)
    expect(() => store.recordRevisionBenefit('plan-1', {
      contractDigest: DIGEST, status: 'non-inferior', reason: 'Bad Reason', evaluation: {},
    })).toThrow(ControlPlaneStoreError)
    expect(store.getRevisionBenefitStatus('plan-1')).toBeUndefined()
    expect(store.inspectRevisionBenefitOutcome('plan-1')).toBeUndefined()
  } finally { store.close() }
})

test('benefit outcomes are foreign-keyed to a verified revision verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-benefit-')); roots.push(root)
  const store = new ControlPlaneStore({ path: join(root, 'cp.sqlite') })
  try {
    expect(() => store.recordRevisionBenefit('missing-plan', {
      contractDigest: DIGEST, status: 'non-inferior', reason: 'ok', evaluation: { verdict: 'non-inferior' },
    })).toThrow()
    expect(store.getRevisionBenefitStatus('missing-plan')).toBeUndefined()
  } finally { store.close() }
})
