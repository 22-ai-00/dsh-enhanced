import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalEventWaitStore, type GoalEventWaitIntent } from '../src/event-wait-store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function intent(id = 'event-wait-a'): GoalEventWaitIntent {
  const objective = 'wait for a durable source event'; const scope = { principalId: 'owner-a', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/tmp/owner-a', preset: 'primary' }
  return { id, wake: { scope, goalId: 'goal-a', definition: { version: 1, objective, digest: acceptanceDigest({ objective }) }, native: { sessionId: 'session-a', goalId: 'native-a', revision: 2, objective, phase: 'paused', roundsStarted: 1, maxGoalRounds: 3, updatedAt: 1 }, attestation: { scope: { workspace: scope.workspace, preset: scope.preset }, principalId: scope.principalId, principalLineage: { principalRecordId: scope.principalRecordId, principalVersion: 1 }, bindingId: 'binding-a', bindingVersion: 1, bindingGeneration: 1, sessionId: 'session-a' }, ownerRouteId: 'route-a', budgetId: 'budget-a' }, source: { protocol: 'dsh-event-source/v1', sourceId: 'event-triggers:trigger-a', kind: 'file', version: '1', configDigest: 'a'.repeat(64), target: { automationId: 'automation-a' }, highWaterSequence: 7 }, createdAt: 1_000, expiresAt: 2_000, runTimeoutMs: 1_000 }
}
function envelope() { return { protocol: 'dsh-external-event/v1' as const, source: { id: 'event-triggers:trigger-a', kind: 'file' as const, version: '1', configDigest: 'a'.repeat(64) }, event: { id: 'event-a', occurredAt: 1_100, receivedAt: 1_100 }, observation: { digest: 'b'.repeat(64), revision: '1', timeBasis: 'observed' as const }, trust: { method: 'local-observation' as const, content: 'untrusted' as const }, target: { automationId: 'automation-a' }, deduplicationKey: 'event-triggers:trigger-a:event-a' } }

describe('goal event wait ledger', () => {
  it('CAS-freezes the first source sequence and original wake across connections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-wait-')); roots.push(root); const path = join(root, 'waits.sqlite')
    const first = new GoalEventWaitStore(path); const second = new GoalEventWaitStore(path); const value = intent(); first.prepare(value)
    const wake = { ...value.wake, id: 'goal-event-wake-event-wait-a', at: 1_100, expiresAt: 2_000 }
    expect(first.match(value.id, { sequence: 8, envelope: envelope(), wake })).toMatchObject({ state: 'matched', match: { sequence: 8, wake } })
    expect(() => second.match(value.id, { sequence: 9, envelope: envelope(), wake })).toThrow()
    first.close(); second.close(); const reopened = new GoalEventWaitStore(path)
    expect(reopened.get(value.id)).toMatchObject({ state: 'matched', match: { sequence: 8, wake } }); reopened.close()
  })
  it('retains immutable provenance while terminalizing a materialized wait', () => {
    const store = new GoalEventWaitStore(':memory:'); const value = intent(); store.prepare(value)
    const wake = { ...value.wake, id: 'goal-event-wake-event-wait-a', at: 1_100, expiresAt: 2_000 }
    store.match(value.id, { sequence: 8, envelope: envelope(), wake }); store.materialized(value.id)
    expect(store.terminal(value.id, 'source-changed')).toMatchObject({ state: 'terminal', reason: 'source-changed', match: { sequence: 8, wake } })
    store.close()
  })
  it('allows only one wait for the immutable native goal revision', () => {
    const store = new GoalEventWaitStore(':memory:'); store.prepare(intent())
    expect(() => store.prepare(intent('event-wait-b'))).toThrow(); store.close()
  })
  it('refuses a reopened ledger whose one-wait-per-revision constraint is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-wait-schema-')); roots.push(root)
    const path = join(root, 'waits.sqlite'); const store = new GoalEventWaitStore(path)
    store.prepare(intent()); store.close()
    const database = new DatabaseSync(path)
    database.exec('DROP INDEX goal_event_wait_native_once'); database.close()
    expect(() => new GoalEventWaitStore(path)).toThrow()
  })
})
