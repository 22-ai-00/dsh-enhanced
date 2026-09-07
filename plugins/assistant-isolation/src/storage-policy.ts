import { createHash } from 'node:crypto'
import type { IsolationLimits, IsolationResult, IsolationRetention, IsolationStoragePolicy } from './types.js'

const DAY = 24 * 60 * 60 * 1000
export const defaultStoragePolicy: IsolationStoragePolicy = Object.freeze({
  maxStateBytes: 256 * 1024 * 1024,
  maxJobRecords: 10_000,
  resultRetentionMs: 0,
})

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).length === keys.length && keys.every(key => key in value)
}

export function validateStoragePolicy(value: unknown): IsolationStoragePolicy {
  if (value === undefined) return { ...defaultStoragePolicy }
  if (!exact(value, ['maxStateBytes', 'maxJobRecords', 'resultRetentionMs'])) throw new Error('assistant-isolation: invalid storage policy')
  const { maxStateBytes, maxJobRecords, resultRetentionMs } = value
  if (typeof maxStateBytes !== 'number' || typeof maxJobRecords !== 'number' || typeof resultRetentionMs !== 'number'
    || !Number.isSafeInteger(maxStateBytes) || maxStateBytes < 16 * 1024 * 1024 || maxStateBytes > 16 * 1024 * 1024 * 1024
    || !Number.isSafeInteger(maxJobRecords) || maxJobRecords < 1 || maxJobRecords > 1_000_000
    || !Number.isSafeInteger(resultRetentionMs) || resultRetentionMs < 0 || resultRetentionMs > 365 * DAY) throw new Error('assistant-isolation: invalid storage policy')
  return { maxStateBytes, maxJobRecords, resultRetentionMs }
}

export function plannedStorageBytes(limits: IsolationLimits): number {
  return 6 * (limits.maxOutputBytes + limits.maxArtifactBytes) + limits.maxInputBytes + 2 * 1024 * 1024
}

function digest(content: string): { sha256: string, bytes: number } {
  const bytes = Buffer.byteLength(content, 'utf8')
  return { sha256: createHash('sha256').update(content, 'utf8').digest('hex'), bytes }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function validateRetention(value: unknown): IsolationRetention | undefined {
  if (!exact(value, ['kind', 'version', 'prunedAt', 'original', 'stdout', 'stderr', 'artifacts'])) return undefined
  const item = (entry: unknown, path = false): { sha256: string, bytes: number, path?: string } | undefined => {
    if (!exact(entry, path ? ['sha256', 'bytes', 'path'] : ['sha256', 'bytes'])) return undefined
    const record = entry
    if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256) || typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0
      || (path && (typeof record.path !== 'string' || record.path.length === 0 || record.path.length > 4096 || record.path.startsWith('/') || /[\p{Cc}\\]/u.test(record.path) || record.path.split('/').some(part => part === '' || part === '.' || part === '..')))) return undefined
    return path ? { sha256: record.sha256, bytes: record.bytes, path: record.path as string } : { sha256: record.sha256, bytes: record.bytes }
  }
  const record = value
  if (record.kind !== 'pruned' || record.version !== 1 || typeof record.prunedAt !== 'number' || !Number.isSafeInteger(record.prunedAt) || record.prunedAt < 0 || !Array.isArray(record.artifacts) || record.artifacts.length > 128) return undefined
  const original = item(record.original); const stdout = item(record.stdout); const stderr = item(record.stderr)
  const artifacts = record.artifacts.map(entry => item(entry, true))
  if (!original || !stdout || !stderr || artifacts.some(entry => entry === undefined) || new Set(artifacts.map(entry => entry?.path)).size !== artifacts.length) return undefined
  return { kind: 'pruned', version: 1, prunedAt: record.prunedAt, original, stdout, stderr, artifacts: artifacts as IsolationRetention['artifacts'] }
}

export function pruneResult(result: IsolationResult, now: number): IsolationResult | undefined {
  if (!Number.isSafeInteger(now) || now < 0 || !result.quiescent
    || !['succeeded', 'failed', 'cancelled', 'timed-out'].includes(result.status) || result.retention !== undefined) return undefined
  const bodyBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) + result.artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.path) + Buffer.byteLength(artifact.content), 0)
  if (bodyBytes === 0) return undefined
  // Result creation time is not carried by the result itself; callers pass a
  // result only once it is eligible under their job's retention deadline.
  const original = digest(canonical(result))
  const retention: IsolationRetention = { kind: 'pruned', version: 1, prunedAt: now, original,
    stdout: digest(result.stdout), stderr: digest(result.stderr), artifacts: result.artifacts.map(artifact => ({ path: artifact.path, ...digest(artifact.content) })) }
  // Older trusted Host writers accepted broader artifact paths. Preserve such
  // bodies rather than persisting a marker the current reader cannot decode.
  if (!validateRetention(retention)) return undefined
  const pruned: IsolationResult = { jobId: result.jobId, status: result.status, quiescent: true, stdout: '', stderr: '', artifacts: [], ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), ...(result.reason === undefined ? {} : { reason: result.reason }), retention }
  return Buffer.byteLength(canonical(pruned)) < Buffer.byteLength(canonical(result)) ? pruned : undefined
}
