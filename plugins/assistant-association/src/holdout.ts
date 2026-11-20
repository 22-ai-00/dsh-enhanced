import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { HoldoutDecision } from './types.js'

export const ASSOCIATION_HOLDOUT_PROTOCOL = 'assistant-association/holdout/v1'
export const HOLDOUT_MODULUS_BPS = 10_000
export const MIN_HOLDOUT_RATE_BPS = 1_000
export const MAX_HOLDOUT_RATE_BPS = 1_500
export const DEFAULT_HOLDOUT_RATE_BPS = 1_250

export class HoldoutSeedError extends Error {
  constructor(
    readonly code: 'invalid-path' | 'unsafe-file' | 'invalid-seed' | 'invalid-rate',
    message: string,
  ) {
    super(message)
    this.name = 'HoldoutSeedError'
  }
}

export function assertSafeSeedFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new HoldoutSeedError('unsafe-file', 'holdout seed must be one regular, unlinked file')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new HoldoutSeedError('unsafe-file', 'holdout seed permissions must not allow group or other access')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new HoldoutSeedError('unsafe-file', 'holdout seed must be owned by the current OS user')
  }
}

export function resolveHoldoutSeedKey(options: {
  readonly databasePath: string
  readonly holdoutSeed?: string | null
  readonly holdoutSeedPath?: string | null
}): Buffer {
  if (options.holdoutSeed !== undefined && options.holdoutSeed !== null) {
    if (options.holdoutSeed.length < 16) {
      throw new HoldoutSeedError('invalid-seed', 'holdoutSeed must be at least 16 characters')
    }
    return createHash('sha256').update(options.holdoutSeed, 'utf8').digest()
  }

  if (options.databasePath === ':memory:') {
    return randomBytes(32)
  }

  if (!isAbsolute(options.databasePath) || resolve(options.databasePath) !== options.databasePath) {
    throw new HoldoutSeedError('invalid-path', 'databasePath must be a canonical absolute path')
  }

  const seedPath = options.holdoutSeedPath ?? join(dirname(options.databasePath), 'holdout.seed')
  if (!isAbsolute(seedPath) || resolve(seedPath) !== seedPath) {
    throw new HoldoutSeedError('invalid-path', 'holdoutSeedPath must be a canonical absolute path')
  }

  mkdirSync(dirname(seedPath), { recursive: true, mode: 0o700 })

  let created = false
  try {
    const fd = openSync(seedPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    try {
      const generated = randomBytes(32)
      const payload = Buffer.from(`${generated.toString('hex')}\n`, 'utf8')
      let offset = 0
      while (offset < payload.length) {
        offset += writeSync(fd, payload, offset, payload.length - offset)
      }
      fsyncSync(fd)
      created = true
      assertSafeSeedFile(seedPath)
      return generated
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (created) throw error
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error
    }
  }

  assertSafeSeedFile(seedPath)
  const raw = readFileSync(seedPath, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/u.test(raw)) {
    throw new HoldoutSeedError('invalid-seed', 'holdout.seed must contain 64 lowercase hex characters')
  }
  return Buffer.from(raw, 'hex')
}

export function evaluateHoldout(
  seedKey: Buffer,
  taskId: string,
  rateBps: number = DEFAULT_HOLDOUT_RATE_BPS,
): HoldoutDecision {
  if (!Number.isInteger(rateBps) || rateBps < MIN_HOLDOUT_RATE_BPS || rateBps > MAX_HOLDOUT_RATE_BPS) {
    throw new HoldoutSeedError(
      'invalid-rate',
      `assistant-association: holdoutRateBps must be an integer in [${MIN_HOLDOUT_RATE_BPS}, ${MAX_HOLDOUT_RATE_BPS}]`,
    )
  }
  const hmacDigest = createHmac('sha256', seedKey)
    .update(`${ASSOCIATION_HOLDOUT_PROTOCOL}\0${taskId}`, 'utf8')
    .digest('hex')
  const bucketBps = Number.parseInt(hmacDigest.slice(0, 8), 16) % HOLDOUT_MODULUS_BPS
  return Object.freeze({
    taskId,
    inHoldout: bucketBps < rateBps,
    bucketBps,
    rateBps,
    hmacDigest,
  })
}
