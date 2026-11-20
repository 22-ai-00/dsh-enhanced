import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_HOLDOUT_RATE_BPS,
  HoldoutSeedError,
  evaluateHoldout,
  resolveHoldoutSeedKey,
} from '../src/holdout.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assoc-holdout-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('sealed HMAC(seed, taskId) holdout', () => {
  test('partitions 10-15% of tasks deterministically across calls', () => {
    const seed = resolveHoldoutSeedKey({
      databasePath: ':memory:',
      holdoutSeed: 'test-holdout-secret-seed-material-v1',
    })

    let inHoldoutCount = 0
    const total = 2_000
    for (let i = 0; i < total; i += 1) {
      const taskId = `foreground-turn:inbox-${i}`
      const d1 = evaluateHoldout(seed, taskId, DEFAULT_HOLDOUT_RATE_BPS)
      const d2 = evaluateHoldout(seed, taskId, DEFAULT_HOLDOUT_RATE_BPS)
      expect(d1).toEqual(d2)
      expect(d1.bucketBps).toBeGreaterThanOrEqual(0)
      expect(d1.bucketBps).toBeLessThan(10_000)
      expect(d1.hmacDigest).toMatch(/^[0-9a-f]{64}$/u)
      if (d1.inHoldout) inHoldoutCount += 1
    }

    const ratio = inHoldoutCount / total
    expect(ratio).toBeGreaterThanOrEqual(0.1)
    expect(ratio).toBeLessThanOrEqual(0.15)
  })

  test('rejects holdout rates outside [1000, 1500] bps', () => {
    const seed = Buffer.alloc(32, 7)
    expect(() => evaluateHoldout(seed, 'task-1', 999)).toThrow(HoldoutSeedError)
    expect(() => evaluateHoldout(seed, 'task-1', 1501)).toThrow(HoldoutSeedError)
    expect(() => evaluateHoldout(seed, 'task-1', 1250.5)).toThrow(HoldoutSeedError)
  })

  test('persists 0o600 holdout.seed sibling file deterministically across restarts and fails closed on unsafe files', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'state.sqlite')
    const seedPath = join(dir, 'holdout.seed')

    const key1 = resolveHoldoutSeedKey({ databasePath: dbPath })
    expect(key1.length).toBe(32)
    expect(statSync(seedPath).mode & 0o777).toBe(0o600)

    const key2 = resolveHoldoutSeedKey({ databasePath: dbPath })
    expect(key2.equals(key1)).toBe(true)

    const decision1 = evaluateHoldout(key1, 'foreground-turn:abc')
    const decision2 = evaluateHoldout(key2, 'foreground-turn:abc')
    expect(decision1).toEqual(decision2)

    // Unsafe permission fails closed
    chmodSync(seedPath, 0o644)
    expect(() => resolveHoldoutSeedKey({ databasePath: dbPath })).toThrow(/permissions/)
    chmodSync(seedPath, 0o600)

    // Malformed hex seed fails closed
    writeFileSync(seedPath, 'not-hex\n', { mode: 0o600 })
    expect(() => resolveHoldoutSeedKey({ databasePath: dbPath })).toThrow(/64 lowercase hex/)

    // Symlink fails closed
    const linkSeed = join(dir, 'link.seed')
    symlinkSync(seedPath, linkSeed)
    expect(() =>
      resolveHoldoutSeedKey({ databasePath: dbPath, holdoutSeedPath: linkSeed }),
    ).toThrow(/regular, unlinked file/)
  })
})
