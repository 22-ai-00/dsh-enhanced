import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import type { OwnerWorkItemLearningTask } from '@dsh-enhanced/assistant-delivery'
import { OwnerTaskFailureGaps } from '../src/owner-task-gaps.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import type { OwnerWorkItemFailureReference } from '../src/owner-task-gap-types.ts'
import { normalizeSourceCreationGrant } from '../src/source-creation.ts'
import { workItemFailureReference, type WorkItemEngineeringDelivery, type WorkItemEngineeringSource } from '../src/work-item-creation-contract.ts'

// Real CP SQLite/transactions; Delivery's already-authenticated frame is a narrow
// seam. These tests do not establish a native owner/WorkItem production proof.
const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn() })
const hex = (text: string) => createHash('sha256').update(text).digest('hex')
const owner = { receiptVersion: 2 as const, authorityId: 'owner', authorityHash: hex('owner'), principalId: 'person', principalRecordId: 'principal', principalVersion: 1, workspace: '/workspace', agentPreset: 'primary', bindingVersion: 1, generation: 1 }
function reference(): OwnerWorkItemFailureReference {
  return { schemaVersion: 2, sourceProtocol: 'assistant-delivery/work-item-engineering-context/v1', owner: { ...owner }, outcomeId: 'outcome',
    projection: { subjectKind: 'work-item', subjectRef: 'work-item-1', version: 1, digest: hex('canonical'), disposition: 'upsert' },
    sourceDigest: hex('source'), presentationDigest: hex('presentation'), context: { manifestDigest: hex('manifest'), objectiveDigest: hex('objective'), objectiveBytes: 20 } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cp-work-item-creation-')), path = join(root, 'cp.sqlite')
  const store = new ControlPlaneStore({ path })
  close.push(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  return { store, path }
}
const generic = (key: string, context = key) => ({ idempotencyKey: key, capability: 'probe', context, expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })

test('schema2 remains private and replays the original owner bytes across /new and cold reopen', async () => {
  const f = await fixture(), ref = reference(), first = f.store.recordOwnerTaskFailureGap(ref)
  expect(f.store.listGaps()).toEqual([])
  expect(first.context).not.toContain(ref.projection.subjectRef)
  const current = { ...ref, owner: { ...ref.owner, generation: 2, bindingVersion: 2 } }
  expect(f.store.recordOwnerTaskFailureGap(current)).toEqual(first)
  expect(f.store.getOwnerTaskFailureReference(first.id)).toEqual(ref)
  const cold = new ControlPlaneStore({ path: f.path })
  try { expect(cold.recordOwnerTaskFailureGap(current)).toEqual(first); expect(cold.getOwnerTaskFailureReference(first.id)).toEqual(ref) } finally { cold.close() }
  expect(f.store.recordOwnerTaskFailureGap({ ...current, sourceDigest: hex('changed source') }).id).not.toBe(first.id)
})

test('schema2 admission owns a real writer, permits nested local mutations and excludes a second connection', async () => {
  const f = await fixture(), gap = f.store.recordOwnerTaskFailureGap(reference()), other = new ControlPlaneStore({ path: f.path })
  const db = new DatabaseSync(f.path); db.exec('PRAGMA busy_timeout=0')
  try {
    f.store.withOwnerTaskFailureGapAdmission(gap.id, () => {
      expect(() => db.exec("INSERT INTO capability_gaps SELECT * FROM capability_gaps LIMIT 0")).toThrow(/locked/u)
      f.store.recordGap(generic('first'))
      expect(() => f.store.recordGap(generic('first', 'conflict'))).toThrow()
      f.store.recordGap(generic('second'))
      const nested = { ...reference(), outcomeId: 'nested-outcome', owner: { ...owner, generation: 2, bindingVersion: 2 } }
      const nestedGap = f.store.recordOwnerTaskFailureGap(nested)
      // This fails after #beginMutation: rollback only the inner SAVEPOINT.
      expect(() => f.store.recordOwnerTaskFailureGap({ ...nested, owner: { ...owner } })).toThrow('generation regressed')
      const after = f.store.recordOwnerTaskFailureGap({ ...reference(), outcomeId: 'after-inner-rollback' })
      expect(f.store.getOwnerTaskFailureReference(nestedGap.id)).toEqual(nested)
      expect(f.store.getOwnerTaskFailureReference(after.id)?.outcomeId).toBe('after-inner-rollback')
      expect(() => f.store.withOwnerTaskFailureGapAdmission(gap.id, () => 1)).toThrow('already active')
    })
    expect(other.listGaps().map(value => value.context).sort()).toEqual(['first', 'second'])
  } finally { other.close(); db.close() }
})

test('outer failures and thenables roll back mutations and retire the writer marker', async () => {
  const f = await fixture(), gap = f.store.recordOwnerTaskFailureGap(reference())
  expect(() => f.store.withOwnerTaskFailureGapAdmission(gap.id, () => { f.store.recordGap(generic('rolled-back')); throw new Error('outer failure') })).toThrow('outer failure')
  expect(f.store.listGaps()).toEqual([])
  // Deliberately exercise the synchronous API's thenable refusal.
  // eslint-disable-next-line unicorn/no-thenable
  expect(() => f.store.withOwnerTaskFailureGapAdmission(gap.id, () => { f.store.recordGap(generic('thenable')); return { then() {} } })).toThrow('synchronous')
  expect(f.store.listGaps()).toEqual([])
  f.store.withOwnerTaskFailureGapAdmission(gap.id, () => f.store.recordGap(generic('survives')))
  expect(f.store.listGaps().map(value => value.context)).toEqual(['survives'])
})

function context(): Omit<WorkItemEngineeringSource, 'protocol'> {
  const objective = '{"original":"完整任务"}'
  const task = { protocol: 'assistant-delivery/owner-work-item-learning/v1', owner: { ...owner }, judgement: 'owner-feedback', sourceDigest: hex('source'), presentationDigest: hex('presentation'),
    canonical: { triggerOutcomeId: 'outcome', objective: { status: 'not-achieved' }, projection: reference().projection }, proofIdentity: { itemId: 'work-item-1', proofDigest: hex('proof') } } as unknown as OwnerWorkItemLearningTask
  const unsigned = { protocol: 'assistant-delivery/work-item-engineering-context/v1' as const, itemId: 'work-item-1', rootItemId: 'work-item-1', feedbackProofDigest: hex('proof'), materialDigest: hex('material'), nodes: [], reports: [], objective: { protocol: 'work-item-owner-objective/v1' as const, fullTextDigest: hex(objective), fullBytes: Buffer.byteLength(objective) } }
  return { task, objective, manifest: { ...unsigned, manifestDigest: growthObjectDigest(unsigned) } }
}

test('freeze before /new then first record and replay preserve the first expected owner reference', async () => {
  const f = await fixture(), expected = context(), current = structuredClone(expected)
  current.task = { ...current.task, owner: { ...current.task.owner, generation: 2, bindingVersion: 2 } }
  const delivery: WorkItemEngineeringDelivery = { inspectOwnerWorkItemEngineeringContext: () => current,
    withOwnerWorkItemEngineeringContextFence: (_input, callback) => callback(current) }
  const gateway = new OwnerTaskFailureGaps(f.store, () => ({ delivery: delivery as never, evaluation: {} as never }))
  const first = gateway.recordWorkItem(expected), original = f.store.getOwnerTaskFailureReference(first.id)
  expect(original?.owner).toEqual(expected.task.owner)
  expect(gateway.recordWorkItem(current)).toEqual(first)
  expect(f.store.getOwnerTaskFailureReference(first.id)).toEqual(original)
  expect(gateway.engineeringSnapshot(first.id, current.task.owner).objective).toBe(expected.objective)
  current.task = { ...current.task, owner: { ...current.task.owner, principalRecordId: 'other-person' } }
  expect(() => gateway.recordWorkItem(expected)).toThrow('source changed')
})

test('rejects changed manifests, text, getters and final source-frame mutation before recording', async () => {
  const f = await fixture(), expected = context()
  expect(() => workItemFailureReference({ ...expected, objective: 'substituted text' })).toThrow()
  expect(() => workItemFailureReference({ ...expected, manifest: { ...expected.manifest, rootItemId: 'substituted' } })).toThrow('manifest digest')
  let evaluated = false
  const malicious = Object.defineProperty({}, 'task', { enumerable: true, get() { evaluated = true; return expected.task } })
  expect(() => workItemFailureReference(malicious as never)).toThrow('accessors'); expect(evaluated).toBe(false)
  const delivery: WorkItemEngineeringDelivery = { inspectOwnerWorkItemEngineeringContext: () => expected,
    withOwnerWorkItemEngineeringContextFence: (_input, callback) => callback({ ...expected, task: { ...expected.task, sourceDigest: hex('changed') } }) }
  const gateway = new OwnerTaskFailureGaps(f.store, () => ({ delivery: delivery as never, evaluation: {} as never }))
  expect(() => gateway.recordWorkItem(expected)).toThrow('final frame')
  expect(f.store.health().gaps).toBe(0)
  expect(controlPlaneDigest(reference())).not.toBe(controlPlaneDigest({ ...reference(), schemaVersion: 1 }))
})

test('absent and false creation flags retain old canonical grant bytes, true is explicit and strict', () => {
  const grant = { id: 'creation', namePrefix: 'owner-', expiresAt: 1_900_000_000_000, maxCreates: 2 }
  expect(normalizeSourceCreationGrant({ ...grant, workItemFailures: false })).toEqual(grant)
  expect(controlPlaneDigest(normalizeSourceCreationGrant({ ...grant, workItemFailures: false }))).toBe(controlPlaneDigest(grant))
  expect(controlPlaneDigest(normalizeSourceCreationGrant({ ...grant, workItemFailures: true }))).not.toBe(controlPlaneDigest(grant))
  expect(() => normalizeSourceCreationGrant({ ...grant, workItemFailures: 'true' } as never)).toThrow()
  let touched = false
  const proxy = new Proxy({}, { ownKeys() { touched = true; return [] } })
  expect(() => workItemFailureReference(proxy as never)).toThrow('inert')
  expect(touched).toBe(false)
})

test('v2 refuses native Promise rejection without leaking it and never reads then getters or Proxy traps', async () => {
  const f = await fixture(), gap = f.store.recordOwnerTaskFailureGap(reference())
  const unhandled: unknown[] = [], onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    expect(() => f.store.withOwnerTaskFailureGapAdmission(gap.id, () => {
      f.store.recordGap(generic('promise-rollback'))
      return Promise.reject(new Error('rejected native callback'))
    })).toThrow('synchronous')
    let touched = false
    // eslint-disable-next-line unicorn/no-thenable
    const getter = Object.defineProperty({}, 'then', { get() { touched = true; throw new Error('getter must not run') } })
    expect(() => f.store.withOwnerTaskFailureGapAdmission(gap.id, () => getter)).toThrow('synchronous')
    const proxy = new Proxy({}, { get() { touched = true; throw new Error('proxy must not run') }, getPrototypeOf() { touched = true; return null } })
    expect(() => f.store.withOwnerTaskFailureGapAdmission(gap.id, () => proxy)).toThrow('synchronous')
    expect(() => f.store.withOwnerTaskFailureGapAdmission(gap.id, () => Object.create(proxy))).toThrow('synchronous')
    expect(touched).toBe(false)
    await new Promise(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
    expect(f.store.listGaps()).toEqual([])
    expect(f.store.withOwnerTaskFailureGapAdmission(gap.id, () => 'writer retired')).toBe('writer retired')
  } finally { process.removeListener('unhandledRejection', onUnhandled) }
})

test('passes the exact required owner authority scope to both engineering inspect and final fence', async () => {
  const f = await fixture(), source = context()
  const required = { authorityHash: source.task.owner.authorityHash, principalRecordId: source.task.owner.principalRecordId, principalVersion: source.task.owner.principalVersion }
  const observations: string[] = []
  const assertScope = (input: unknown, phase: string) => {
    const scope = input as {expectedOwner?: unknown}
    if (controlPlaneDigest(scope.expectedOwner) !== controlPlaneDigest(required)) throw new Error('foreground source owner authority changed')
    observations.push(phase)
  }
  // The real Delivery inspector catches foregroundSourceFence rejection and
  // returns undefined. A permissive "always current" stub hid this omission.
  const delivery: WorkItemEngineeringDelivery = {
    inspectOwnerWorkItemEngineeringContext: input => { try { assertScope(input, 'inspect'); return source } catch { return undefined } },
    withOwnerWorkItemEngineeringContextFence: (input, callback) => { assertScope(input, 'fence'); return callback(source) },
  }
  const gateway = new OwnerTaskFailureGaps(f.store, () => ({ delivery: delivery as never, evaluation: {} as never }))
  const gap = gateway.recordWorkItem(source)
  expect(observations).toEqual(['inspect', 'fence'])
  expect(f.store.getOwnerTaskFailureReference(gap.id)?.owner).toEqual(source.task.owner)
  expect(gateway.engineeringSnapshot(gap.id, source.task.owner).objective).toBe(source.objective)
  expect(observations).toEqual(['inspect', 'fence', 'inspect', 'fence'])
  expect(() => gateway.recordWorkItem({ ...source, task: { ...source.task, owner: { ...source.task.owner, principalVersion: source.task.owner.principalVersion + 1 } } })).toThrow('source changed')
  expect(f.store.health().gaps).toBe(1)
})
