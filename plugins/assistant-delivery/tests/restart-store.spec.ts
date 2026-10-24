import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { RestartStore, type RestartTaskInput } from '../src/restart-store.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const input: RestartTaskInput = {
  inboxId: 'inbox_owner_task', eventId: 'om_owner_task',
  binding: {
    id: 'binding_owner', version: 2, generation: 4,
    sessionId: 'delivery-session-g4', workspace: '/work/owner', preset: 'assistant',
    policyRef: 'owner-dm', authorityHash: 'e'.repeat(64),
    conversation: { channel: 'lark', account: 'owner-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc-owner' },
    principal: { channel: 'lark', account: 'owner-bot', tenant: 'tenant-a', user: 'ou-owner' },
  },
  owner: { principalRecordId: 'owner-row', principalVersion: 3 },
  sourceInvocationId: 'boot-source', maxModelRequests: 2, maxToolCalls: 1,
  maxOutputTokens: 512, capabilityDigest: 'd'.repeat(64), deadline: 10_000,
}
const checkpoint = {
  sessionEventCount: 42, sessionDigest: 'a'.repeat(64),
  continuationMessageId: 'message-stable', continuationTextDigest: 'b'.repeat(64),
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'assistant-restart-store-'))
  roots.push(root)
  let now = 100
  const path = join(root, 'restart.sqlite')
  const store = new RestartStore({ path, now: () => now })
  return { store, path, advance(value: number) { now = value }, clock: () => now }
}

function prepared(store: RestartStore) {
  store.beginTask(input)
  store.captureModel(input.inboxId, { provider: 'relay', model: 'model-a', reasoningEffort: 'medium' })
  const request = store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' })
  store.checkpoint(request.id, checkpoint)
  store.ready(request.id)
  return request.id
}

describe('durable foreground restart journal', () => {
  test('observes normal work without enforcing restart budget or deadline across reopen', () => {
    const { store, path, advance } = fixture()
    expect(store.beginTask(input)).toMatchObject({ inboxId: input.inboxId, maxModelRequests: 2, toolCalls: 0 })
    expect(store.beginTask(input).createdAt).toBe(100)
    expect(() => store.beginTask({ ...input, owner: { ...input.owner, principalVersion: 4 } }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.observeModel(input.inboxId, { provider: 'relay', model: 'model-a', reasoningEffort: 'medium' })
    store.observeModel(input.inboxId, { provider: 'relay', model: 'model-a', reasoningEffort: 'medium' })
    expect(() => store.captureModel(input.inboxId, { provider: 'relay', model: 'model-b' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.observe(input.inboxId, 'model', 'native-turn-1').modelRequests).toBe(1)
    expect(store.observe(input.inboxId, 'model', 'native-turn-1').modelRequests).toBe(1)
    store.observe(input.inboxId, 'tool', 'native-tool-1')
    expect(store.observe(input.inboxId, 'tool', 'native-tool-2').toolCalls).toBe(2)
    expect(store.isEligible(input.inboxId)).toBe(false)
    expect(() => store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'budget' }))
    store.close()
    const resumed = new RestartStore({ path, now: () => 101 })
    expect(resumed.getTask(input.inboxId)).toMatchObject({ modelRequests: 1, toolCalls: 2,
      model: { provider: 'relay', model: 'model-a', reasoningEffort: 'medium' } })
    expect(resumed.hasReservation(input.inboxId, 'model', 'native-turn-1')).toBe(false)
    expect(resumed.observe(input.inboxId, 'model', 'native-turn-2').modelRequests).toBe(2)
    expect(resumed.observe(input.inboxId, 'model', 'native-turn-3').modelRequests).toBe(3)
    expect(() => resumed.reserve(input.inboxId, 'model', 'native-turn-4'))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    resumed.close()
    advance(10_000)
    const expired = new RestartStore({ path, now: () => 10_000 })
    expect(expired.observe(input.inboxId, 'tool', 'native-tool-late').toolCalls).toBe(3)
    expect(() => expired.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'deadline' }))
    expired.close()
  })

  test('gives one durable restart dispatch claim across two connections and observes new invocation', () => {
    const { store, path, clock } = fixture()
    const id = prepared(store)
    const second = new RestartStore({ path, now: clock })
    expect(second.listRequests({ statuses: ['ready'] })).toHaveLength(1)
    expect(store.claimRestart(id, { holderId: 'supervisor-a', invocationId: 'boot-source' }))
      .toMatchObject({ status: 'restarting', restartHolderId: 'supervisor-a' })
    expect(second.countDispatchedSince(100)).toBe(1)
    expect(() => second.claimRestart(id, { holderId: 'supervisor-b', invocationId: 'boot-source' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.claimRestart(id, { holderId: 'supervisor-a', invocationId: 'boot-source' }).status)
      .toBe('restarting')
    expect(store.countDispatchedSince(100)).toBe(1)
    expect(() => second.markRestarted(id, { invocationId: 'boot-source' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(second.markRestarted(id, { invocationId: 'boot-new' })).toMatchObject({
      status: 'restarted', sourceInvocationId: 'boot-source', restartInvocationId: 'boot-new',
    })
    expect(() => store.claimRestart(id, { holderId: 'supervisor-a', invocationId: 'boot-source' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.claimContinuation(id, { holderId: 'worker-new', invocationId: 'boot-new' }))
      .toMatchObject({ status: 'resuming', continuationHolderId: 'worker-new' })
    expect(() => second.claimContinuation(id, { holderId: 'worker-other', invocationId: 'boot-new' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.complete(id).status).toBe('completed')
    expect(store.complete(id).status).toBe('completed')
    expect(() => second.markRestarted(id, { invocationId: 'boot-new' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    second.close()
    store.close()
  })

  test('reconciles a lost supervisor ACK by observation without granting a second dispatch', () => {
    const { store, path, clock } = fixture()
    const id = prepared(store)
    const second = new RestartStore({ path, now: clock })
    expect(second.markRestarted(id, { invocationId: 'boot-observed' }).status).toBe('restarted')
    expect(store.countDispatchedSince(0)).toBe(0)
    expect(() => store.claimRestart(id, { holderId: 'late-supervisor', invocationId: 'boot-source' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    second.close(); store.close()
  })

  test('marks normal work permanently ineligible while observations continue', () => {
    const { store, path } = fixture()
    store.beginTask(input)
    store.observeModel(input.inboxId, { provider: 'relay', model: 'model-a' })
    expect(store.isEligible(input.inboxId)).toBe(true)
    expect(() => store.markIneligible(input.inboxId, 'x'.repeat(121)))
      .toThrowError(expect.objectContaining({ code: 'invalid' }))
    store.markIneligible(input.inboxId, 'uncertain-outcome')
    store.markIneligible(input.inboxId, 'later-uncertain-outcome')
    expect(store.isEligible(input.inboxId)).toBe(false)
    expect(() => store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.observe(input.inboxId, 'model', 'normal-1').modelRequests).toBe(1)
    expect(store.observe(input.inboxId, 'model', 'normal-2').modelRequests).toBe(2)
    expect(store.observe(input.inboxId, 'model', 'normal-3').modelRequests).toBe(3)
    store.close()
    const reopened = new RestartStore({ path, readOnly: true })
    expect(reopened.isEligible(input.inboxId)).toBe(false)
    expect(reopened.getTask(input.inboxId)?.modelRequests).toBe(3)
    reopened.close()
    const raw = new DatabaseSync(path)
    expect(() => raw.prepare('UPDATE restart_ineligible SET reason = ?').run('forged'))
      .toThrow(/immutable restart ineligibility/u)
    raw.close()
  })

  test('an expired recovery window does not prevent admitting or observing ordinary work', () => {
    const { store, advance } = fixture()
    advance(20_000)
    expect(store.beginTask(input).inboxId).toBe(input.inboxId)
    store.observeModel(input.inboxId, { provider: 'relay', model: 'model-a' })
    expect(store.observe(input.inboxId, 'model', 'after-window').modelRequests).toBe(1)
    expect(store.isEligible(input.inboxId)).toBe(false)
    expect(() => store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'deadline' }))
    store.close()
  })

  test('ordinary tool observation can precede the first model route', () => {
    const { store } = fixture()
    store.beginTask(input)
    expect(store.observe(input.inboxId, 'tool', 'pre-model-tool').toolCalls).toBe(1)
    expect(store.isEligible(input.inboxId)).toBe(false)
    store.observeModel(input.inboxId, { provider: 'relay', model: 'model-a' })
    expect(store.isEligible(input.inboxId)).toBe(true)
    store.close()
  })

  test('restart requires one unused model request after normal work', () => {
    const { store } = fixture()
    store.beginTask(input)
    store.observeModel(input.inboxId, { provider: 'relay', model: 'model-a' })
    store.observe(input.inboxId, 'model', 'normal-model-1')
    expect(store.isEligible(input.inboxId)).toBe(true)
    store.observe(input.inboxId, 'model', 'normal-model-2')
    expect(store.isEligible(input.inboxId)).toBe(false)
    expect(() => store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'budget' }))
    expect(store.observe(input.inboxId, 'model', 'normal-model-3').modelRequests).toBe(3)
    store.close()
  })

  test('model drift only removes recovery eligibility before a request', () => {
    const { store, path } = fixture()
    store.beginTask(input)
    store.observeModel(input.inboxId, { provider: 'relay', model: 'model-a' })
    expect(store.observeModel(input.inboxId, { provider: 'relay', model: 'model-b' }).model)
      .toMatchObject({ provider: 'relay', model: 'model-a' })
    expect(store.isEligible(input.inboxId)).toBe(false)
    store.close()
    const reopened = new RestartStore({ path, now: () => 101 })
    expect(reopened.isEligible(input.inboxId)).toBe(false)
    expect(() => reopened.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    reopened.close()
  })

  test('only an accepted continuation can enforce finite reservations', () => {
    const { store, path } = fixture()
    const id = prepared(store)
    expect(store.isEligible(input.inboxId)).toBe(false)
    expect(() => store.reserve(input.inboxId, 'model', 'too-early'))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.markRestarted(id, { invocationId: 'boot-new' })
    store.claimContinuation(id, { holderId: 'worker-new', invocationId: 'boot-new' })
    expect(store.reserve(input.inboxId, 'model', 'resume-model-1').modelRequests).toBe(1)
    expect(store.reserve(input.inboxId, 'model', 'resume-model-1').modelRequests).toBe(1)
    expect(store.reserve(input.inboxId, 'model', 'resume-model-2').modelRequests).toBe(2)
    expect(() => store.reserve(input.inboxId, 'model', 'resume-model-3'))
      .toThrowError(expect.objectContaining({ code: 'budget' }))
    expect(store.reserve(input.inboxId, 'tool', 'resume-tool-1').toolCalls).toBe(1)
    expect(() => store.reserve(input.inboxId, 'tool', 'resume-tool-2'))
      .toThrowError(expect.objectContaining({ code: 'budget' }))
    expect(store.hasReservation(input.inboxId, 'model', 'resume-model-1')).toBe(true)
    store.close()
    const reopened = new RestartStore({ path, readOnly: true })
    expect(reopened.getTask(input.inboxId)).toMatchObject({ modelRequests: 2, toolCalls: 1 })
    reopened.close()
  })

  test('keeps one exact request key and checkpoint; terminal unknown and cancel never revive', () => {
    const { store } = fixture()
    store.beginTask(input)
    expect(() => store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.captureModel(input.inboxId, { provider: 'relay', model: 'model-a' })
    const first = store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' })
    expect(store.request(input.inboxId, { reason: 'refresh wiki catalog', requestKey: 'maintenance-owner-task' }).id).toBe(first.id)
    expect(() => store.reserve(input.inboxId, 'model', 'after-request'))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => store.request(input.inboxId, { reason: 'other reason', requestKey: 'maintenance-owner-task' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.checkpoint(first.id, checkpoint)
    expect(store.checkpoint(first.id, checkpoint).status).toBe('checkpoint')
    expect(() => store.checkpoint(first.id, { ...checkpoint, sessionDigest: 'c'.repeat(64) }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.fail(first.id, 'dispatch-unknown').status).toBe('failed')
    expect(store.fail(first.id, 'dispatch-unknown').status).toBe('failed')
    expect(() => store.ready(first.id)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => store.claimRestart(first.id, { holderId: 'supervisor', invocationId: 'boot-source' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.cancelForBinding(input.binding.id)).toEqual([])
    store.close()
  })

  test('revokes active binding requests and refuses private journal tampering', () => {
    const { store, path } = fixture()
    const id = prepared(store)
    expect(store.activeRequestForBinding(input.binding.id)?.id).toBe(id)
    expect(store.cancelForBinding(input.binding.id)).toMatchObject([{ id, status: 'cancelled' }])
    expect(() => store.ready(id)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect((lstatSync(path).mode & 0o077)).toBe(0)
    store.close()
    const raw = new DatabaseSync(path)
    expect(() => raw.prepare('UPDATE restart_events SET event = ?').run('forged'))
      .toThrow(/immutable restart event/u)
    raw.prepare('UPDATE restart_tasks SET task_json = ? WHERE inbox_id = ?').run('{}', input.inboxId)
    raw.close()
    const reopened = new RestartStore({ path, readOnly: true })
    expect(() => reopened.getTask(input.inboxId)).toThrowError(expect.objectContaining({ code: 'corrupt' }))
    reopened.close()
  })

  test('rejects an existing unowned schema and a changed reservation counter', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-restart-forged-'))
    roots.push(root)
    const unrelated = join(root, 'unrelated.sqlite')
    const raw = new DatabaseSync(unrelated)
    raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY) STRICT;')
    raw.close()
    chmodSync(unrelated, 0o600)
    expect(() => new RestartStore({ path: unrelated }))
      .toThrowError(expect.objectContaining({ code: 'corrupt' }))

    const { store, path } = fixture()
    store.beginTask(input)
    store.captureModel(input.inboxId, { provider: 'relay', model: 'model-a' })
    store.observe(input.inboxId, 'model', 'request-one')
    store.close()
    const tamper = new DatabaseSync(path)
    tamper.prepare('UPDATE restart_tasks SET model_requests = 0 WHERE inbox_id = ?').run(input.inboxId)
    tamper.close()
    const reopened = new RestartStore({ path })
    expect(() => reopened.getTask(input.inboxId)).toThrowError(expect.objectContaining({ code: 'corrupt' }))
    reopened.close()
  })

  test('refuses a version-one sidecar missing the reviewed ineligibility table', () => {
    const { store, path } = fixture()
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec('DROP TRIGGER restart_ineligible_no_update; DROP TRIGGER restart_ineligible_no_delete; DROP TABLE restart_ineligible;')
    raw.close()
    expect(() => new RestartStore({ path }))
      .toThrowError(expect.objectContaining({ code: 'corrupt' }))
  })
})
