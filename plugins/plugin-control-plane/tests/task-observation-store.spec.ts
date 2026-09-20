import { describe, expect, test } from 'vitest'
import { assertTaskObservationBatch, taskObservationDigest, taskObservationId } from '../src/task-observation-store.ts'

describe('task observation batch identity', () => {
  test('binds the lane, plan, owner, policy, generation and votes', () => {
    const core = { lane: '0'.repeat(64), configDigest: 'a'.repeat(64), trustDigest: 'b'.repeat(64), planId: 'plan', planDigest: 'c'.repeat(64),
      installationId: 'installation', profilePath: '/tmp/profile', owner: { authorityId: 'authority', authorityHash: 'd'.repeat(64), principalId: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp', agentPreset: 'preset' },
      policy: { id: 'policy', expiresAt: 20, maximumObservations: 1, minimumChecks: 1, maximumChecks: 1, lookbackMs: 1000 }, hostGeneration: 1,
      votes: [{ inboxId: 'inbox', outcomeId: 'outcome', projection: { subjectKind: 'foreground-turn' as const, subjectRef: 'inbox', version: 1, digest: '1'.repeat(64), disposition: 'upsert' as const }, sourceDigest: 'e'.repeat(64), deploymentDigest: 'f'.repeat(64), status: 'achieved' as const, completedAt: 9 }] }
    const batch = { schemaVersion: 1 as const, kind: 'dsh-task-observation' as const, ...core, id: taskObservationId(core), createdAt: 10, expiresAt: 19, digest: '' }
    batch.digest = taskObservationDigest(batch)
    expect(() => assertTaskObservationBatch(batch)).not.toThrow()
    expect(taskObservationId({ ...core, hostGeneration: 2 })).not.toBe(batch.id)
    for (const invalid of [
      { ...batch, votes: [] },
      { ...batch, votes: [...batch.votes, ...batch.votes] },
      { ...batch, expiresAt: 21 },
      { ...batch, owner: { ...batch.owner, principalVersion: 0 } },
      { ...batch, votes: [{ ...batch.votes[0]!, completedAt: 12 }] },
    ]) {
      invalid.id = taskObservationId(invalid)
      invalid.digest = taskObservationDigest(invalid)
      expect(() => assertTaskObservationBatch(invalid)).toThrow()
    }
  })
})
