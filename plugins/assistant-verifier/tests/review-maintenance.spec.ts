import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { canonicalGrowthJson } from '@dsh-enhanced/assistant-growth-contract'
import { CreationReviewStore, lineageHash, reviewPublicIdentity } from '../src/review-maintenance.ts'
import { stableIdentity, validateIdentity, validateLane } from '../src/review-authority-lineage.ts'
import type { CreationReviewConfig } from '../src/creation-review.ts'
import type { RevisionRegressionReviewConfig } from '../src/revision-regression-review.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-maintenance-'))); roots.push(root); chmodSync(root, 0o700)
  const keyPath = join(root, 'signing.pem'), stateRoot = join(root, 'observer')
  mkdirSync(stateRoot, { mode: 0o700 })
  writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const now = Date.now()
  const config: CreationReviewConfig = { authorityId: 'creation-review',
    owner: { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
      principalVersion: 1, workspace: root, agentPreset: 'main' },
    namePrefix: 'owner-', keyId: 'key-1', keyPath, expiresAt: now + 120_000, maxVerifications: 2,
    runner: { stateRoot, image: 'sha256:' + 'a'.repeat(64), dockerPath: process.execPath, expiresAt: now + 120_000,
      maxRuns: 16, maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 },
    policy: 'Verify arithmetic specified by the owner.', maxInputBytes: 65_536, maxOutputTokens: 1024,
    maxDurationMs: 60_000, maxCases: 3, receiptTtlMs: 30_000 }
  const { policy: _p, maxInputBytes: _i, maxOutputTokens: _o, ...regression } = config
  return { config, regression: regression as RevisionRegressionReviewConfig, stateRoot }
}

test('each lane projects a validated public identity bound to its authority protocol', () => {
  const f = fixture()
  const lanes = [['creation-reviews', f.config, 'assistant-growth/creation-acceptance-authority/v1'],
    ['revision-reviews', f.config, 'assistant-growth/revision-acceptance-authority/v1'],
    ['revision-regressions', f.regression, 'assistant-growth/revision-regression-acceptance-authority/v1']] as const
  for (const [lane, config, protocol] of lanes) {
    const identity = reviewPublicIdentity(lane, config)
    expect(() => validateIdentity(identity)).not.toThrow()
    expect(() => validateLane(identity, lane)).not.toThrow()
    expect(identity.authority.protocol).toBe(protocol)
    expect(identity.maximum).toBe(2)
    expect(identity.runner).toEqual({ logicalStateRoot: f.stateRoot, maxRuns: 16, maxTotalDurationMs: 80_000,
      maxDurationMs: 10_000, maxOutputBytes: 65_536, expiresAt: f.config.runner.expiresAt })
    expect(Object.keys(identity.budget).sort()).toEqual(lane === 'revision-regressions'
      ? ['maxCases', 'maxDurationMs', 'receiptTtlMs'] : ['maxCases', 'maxDurationMs', 'maxInputBytes', 'maxOutputTokens', 'policy', 'receiptTtlMs'])
    expect(JSON.stringify(identity)).not.toContain(f.config.keyPath)
  }
})

test('a backend-only runner change moves only the authority digest', () => {
  const f = fixture()
  const before = reviewPublicIdentity('creation-reviews', f.config)
  const after = reviewPublicIdentity('creation-reviews', { ...f.config,
    runner: { ...f.config.runner, image: 'sha256:' + 'b'.repeat(64) } as CreationReviewConfig['runner'] })
  expect(after.authority.authorityDigest).not.toBe(before.authority.authorityDigest)
  expect(canonicalGrowthJson(stableIdentity(after))).toBe(canonicalGrowthJson(stableIdentity(before)))
  const bounded = reviewPublicIdentity('creation-reviews', { ...f.config, runner: { ...f.config.runner, maxRuns: 17 } })
  expect(canonicalGrowthJson(stableIdentity(bounded))).not.toBe(canonicalGrowthJson(stableIdentity(before)))
})

test('invalid lanes and configs fail closed; the maintenance surface re-exports store and hash', () => {
  const f = fixture()
  expect(() => reviewPublicIdentity('unknown' as 'creation-reviews', f.config)).toThrow()
  expect(() => reviewPublicIdentity('revision-regressions', f.config as unknown as RevisionRegressionReviewConfig)).toThrow()
  expect(() => reviewPublicIdentity('creation-reviews', { ...f.config, keyPath: join(f.stateRoot, 'missing.pem') })).toThrow()
  expect(typeof CreationReviewStore.openExistingForMaintenance).toBe('function')
  expect(lineageHash({ a: 1 })).toMatch(/^[a-f0-9]{64}$/u)
})
