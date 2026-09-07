import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { validateConfig } from '../src/config.ts'
import { defaultStoragePolicy, pruneResult, validateRetention, validateStoragePolicy } from '../src/storage-policy.ts'
import type { IsolationResult } from '../src/types.ts'

const result: IsolationResult = { jobId: 'job', status: 'succeeded', quiescent: true, stdout: '中文'.repeat(2000), stderr: 'err', artifacts: [{ path: 'a', content: '内容'.repeat(1000) }] }

describe('storage policy', () => {
  test('defaults to preserving result bodies', () => { expect(defaultStoragePolicy.resultRetentionMs).toBe(0) })
  test('prunes terminal quiescent output with UTF-8 byte digests', () => {
    const pruned = pruneResult(result, 100)
    expect(pruned?.stdout).toBe(''); expect(pruned?.artifacts).toEqual([])
    expect(pruned?.retention?.stdout.bytes).toBe(Buffer.byteLength(result.stdout))
    expect(pruned?.retention?.stdout.sha256).toBe(createHash('sha256').update(result.stdout, 'utf8').digest('hex'))
    expect(pruneResult(pruned!, 101)).toBeUndefined()
  })
  test('does not prune unknown, nonquiescent, or no-body results', () => {
    expect(pruneResult({ ...result, status: 'unknown' }, 1)).toBeUndefined()
    expect(pruneResult({ ...result, quiescent: false }, 1)).toBeUndefined()
    expect(pruneResult({ ...result, stdout: '', stderr: '', artifacts: [] }, 1)).toBeUndefined()
    expect(pruneResult({ ...result, stdout: 'x', stderr: '', artifacts: [] }, 1)).toBeUndefined()
    expect(pruneResult(result, -1)).toBeUndefined()
    expect(pruneResult({ ...result, artifacts: [{ path: '../legacy', content: result.stdout }] }, 1)).toBeUndefined()
  })
  test('rejects malicious retention metadata and policy boundaries', () => {
    expect(validateRetention({ kind: 'pruned' })).toBeUndefined()
    expect(validateRetention({ kind: 'pruned', version: 1, prunedAt: 1, original: { sha256: '0'.repeat(64), bytes: 0 }, stdout: { sha256: '0'.repeat(64), bytes: 0 }, stderr: { sha256: '0'.repeat(64), bytes: 0 }, artifacts: [{ sha256: '0'.repeat(64), bytes: 0, path: '../x' }] })).toBeUndefined()
    expect(validateRetention({ kind: 'pruned', version: 1, prunedAt: 1, original: { sha256: '0'.repeat(64), bytes: 0 }, stdout: { sha256: '0'.repeat(64), bytes: 0 }, stderr: { sha256: '0'.repeat(64), bytes: 0 }, artifacts: [{ sha256: '0'.repeat(64), bytes: 0, path: 'x' }, { sha256: '0'.repeat(64), bytes: 0, path: 'x' }] })).toBeUndefined()
    expect(() => validateStoragePolicy({ ...defaultStoragePolicy, maxStateBytes: 1 })).toThrow()
    expect(validateStoragePolicy(defaultStoragePolicy)).toEqual(defaultStoragePolicy)
    expect(validateConfig({ storage: { maxStateBytes: 16 * 1024 * 1024, maxJobRecords: 1, resultRetentionMs: 0 }, limits: { maxOutputBytes: 262_144, maxArtifactBytes: 1_048_576, maxInputBytes: 1_048_576 } }).storage.maxStateBytes).toBe(16 * 1024 * 1024)
  })
})
