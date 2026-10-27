import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test, vi } from 'vitest'
import type {
  DeliveryProgressIntent, DeliveryProgressJournal, DeliveryProgressRecord,
} from '@dsh-enhanced/assistant-delivery'
import { LarkProgressPresenter } from '../src/progress.ts'
import type { LarkTransport } from '../src/types.ts'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'

const target = {
  conversation: { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'oc-chat' },
  principal: { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'ou-user' },
}
const base = { bindingId: 'binding', eventId: 'evt', target }
const fingerprint = 'a'.repeat(64)
const roots: string[] = []

async function cleanupRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

function sqliteJournal(store: DeliveryStore): DeliveryProgressJournal {
  return {
    begin: async (intent, credential, sequence, showDetails) =>
      store.beginProgress(intent, credential, sequence, showDetails),
    get: async (intent, credential) => store.getProgress(intent, credential),
    created: async (intent, credential, handle) => store.attachProgressHandle(intent, credential, handle),
    advance: async (intent, credential) => store.advanceProgress(intent, credential),
    stageTerminal: async (intent, credential) => store.stageProgressTerminal(intent, credential),
    delivered: async (intent, credential) => store.confirmProgressTerminal(intent, credential),
    recover: async (channel, account, credential, limit) =>
      store.recoverProgress(channel, account, credential, limit),
  }
}

function journalFixture() {
  let record: DeliveryProgressRecord | undefined
  const journal: DeliveryProgressJournal = {
    begin: async (_intent, _fingerprint, sequence, showDetails) => {
      if (record !== undefined) return { record, created: false }
      record = { ...base, sequence, step: 0, showDetails, state: 'creating' }
      return { record, created: true }
    },
    get: async () => record,
    created: async (_intent, _fingerprint, providerHandle) => {
      record = { ...record!, providerHandle, state: 'active' }
      return record
    },
    advance: async () => {
      if (record?.state !== 'active') return undefined
      record = { ...record, step: record.step + 1 }
      return record
    },
    stageTerminal: async intent => {
      if (record?.state === 'active') record = { ...record, state: 'pending',
        terminal: intent.update as NonNullable<DeliveryProgressRecord['terminal']>, step: record.step + 1 }
      return record
    },
    delivered: async () => { record = { ...record!, state: 'delivered' } },
    recover: async () => record?.state === 'pending' ? [record] : [],
  }
  return { journal, record: () => record }
}

describe('Lark durable progress presentation', () => {
  test('closes the original provider handle from real SQLite after a Host rebuild without replaying Inbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-progress-sqlite-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    let now = 1_000
    const open = () => new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
    const firstStore = open()
    try {
      const issued = firstStore.issuePairing(target.principal, { ttlMs: 5_000, maxAttempts: 3 })
      firstStore.confirmPairing({ challengeId: issued.challenge.id, principal: target.principal, code: issued.code })
      const binding = firstStore.createBinding({ conversation: target.conversation, principal: target.principal,
        workspace: '/work/progress', agentPreset: 'primary', sessionId: 'session-progress', policyRef: 'owner-dm' })
      const inbox = firstStore.acceptInbound({ channel: 'lark', account: 'bot', eventId: 'evt-sqlite',
        occurredAt: 1, principal: target.principal, conversation: target.conversation,
        kind: 'text', text: 'complex request' }).record
      firstStore.queueInbox(inbox.id, binding.id)
      const claim = firstStore.claimInbox({ ownerId: 'worker-sqlite', leaseMs: 30_000, limit: 1, maxAttempts: 3 })[0]!
      const owner = firstStore.getPrincipal(target.principal)!
      firstStore.bindForegroundTaskExecution({ inboxId: inbox.id,
        scope: { workspace: '/work/progress', preset: 'primary' },
        owner: { principalRecordId: owner.id, principalVersion: owner.version },
        binding, dispatchedAt: now })
      const started: DeliveryProgressIntent = { bindingId: binding.id, eventId: inbox.eventId,
        target, update: { kind: 'started' } }
      const handle = { cotId: 'cot-sqlite', messageId: 'om-sqlite' }
      const createProgress = vi.fn(async () => handle)
      const writeProgress = vi.fn(async () => {})
      const transport = { createProgress, writeProgress } as unknown as LarkTransport
      const failures = vi.fn()
      const first = new LarkProgressPresenter(transport, true, 'off', failures)
      first.bindJournal(sqliteJournal(firstStore), fingerprint)
      await first.publish(started)
      expect(firstStore.getProgress(started, fingerprint)).toMatchObject({
        state: 'active', providerHandle: JSON.stringify(handle),
      })
      firstStore.finishInbox({ inboxId: inbox.id, ownerId: 'worker-sqlite',
        fencingToken: claim.fencingToken, outcome: 'dead_letter', failureCode: 'dispatch-ambiguous' })
      firstStore.close()

      now = 1_001
      const reopened = open()
      try {
        const second = new LarkProgressPresenter(transport, true, 'off', failures)
        second.bindJournal(sqliteJournal(reopened), fingerprint)
        await second.recover('lark', 'bot')
        expect(failures).not.toHaveBeenCalled()
        expect(createProgress).toHaveBeenCalledOnce()
        expect(writeProgress).toHaveBeenCalledTimes(2)
        const writes = writeProgress.mock.calls as unknown as Array<[unknown, unknown]>
        expect(writes.at(-1)?.[0]).toEqual(handle)
        expect(JSON.stringify(writes.at(-1)?.[1])).toContain('RUN_ERROR')
        expect(reopened.getProgress(started, fingerprint)).toMatchObject({
          state: 'delivered', providerHandle: JSON.stringify(handle),
          terminal: { kind: 'failed', code: 'INTERRUPTED_RESULT_UNKNOWN' },
        })
        expect(reopened.getInbox(inbox.id)).toMatchObject({ status: 'dead_letter', attemptCount: 1 })
        const raw = new DatabaseSync(path)
        try {
          expect(raw.prepare('SELECT state, provider_handle FROM delivery_progress WHERE inbox_id = ?')
            .get(inbox.id)).toEqual({ state: 'delivered', provider_handle: JSON.stringify(handle) })
        } finally { raw.close() }
      } finally { reopened.close() }
    } finally {
      firstStore.close()
      await cleanupRoots()
    }
  })

  test('retries a failed terminal update against the same provider handle after a presenter restart', async () => {
    const state = journalFixture()
    const createProgress = vi.fn(async () => ({ cotId: 'cot-1', messageId: 'om-progress' }))
    const writeProgress = vi.fn(async () => {})
    const transport = { createProgress, writeProgress } as unknown as LarkTransport
    const failures = vi.fn()
    const first = new LarkProgressPresenter(transport, true, 'direct', failures)
    first.bindJournal(state.journal, fingerprint)
    await first.publish({ ...base, update: { kind: 'started' } })
    writeProgress.mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    await first.publish({ ...base, update: { kind: 'failed', code: 'agent-task-timeout' } })
    expect(failures).toHaveBeenCalledOnce()
    expect(state.record()).toMatchObject({ state: 'pending', terminal: { kind: 'failed', code: 'agent-task-timeout' } })

    const second = new LarkProgressPresenter(transport, true, 'direct', failures)
    second.bindJournal(state.journal, fingerprint)
    await second.recover('lark', 'bot')
    expect(createProgress).toHaveBeenCalledOnce()
    const writes = writeProgress.mock.calls as unknown as Array<[unknown, unknown]>
    expect(writes.at(-1)?.[0]).toEqual({ cotId: 'cot-1', messageId: 'om-progress' })
    expect(JSON.stringify(writes.at(-1)?.[1])).toContain('任务已超时，处理已停止')
    expect(state.record()?.state).toBe('delivered')
    await second.recover('lark', 'bot')
    expect(writeProgress).toHaveBeenCalledTimes(3)
  })

  test('does not create a second progress message while the first creation result is unknown', async () => {
    const state = journalFixture()
    const createProgress = vi.fn(async () => { throw new Error('timeout after request dispatch') })
    const transport = { createProgress, writeProgress: vi.fn(async () => {}) } as unknown as LarkTransport
    const first = new LarkProgressPresenter(transport, true, 'off', vi.fn())
    first.bindJournal(state.journal, fingerprint)
    const started: DeliveryProgressIntent = { ...base, update: { kind: 'started' } }
    await first.publish(started)
    expect(state.record()?.state).toBe('creating')
    const restarted = new LarkProgressPresenter(transport, true, 'off', vi.fn())
    restarted.bindJournal(state.journal, fingerprint)
    await restarted.publish(started)
    expect(createProgress).toHaveBeenCalledOnce()
  })
})
