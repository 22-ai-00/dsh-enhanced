import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, test, vi } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { feedbackFenceFixture } from './feedback-target-fence.fixture.ts'
afterEach(() => vi.restoreAllMocks())

test.each(['report','plan'] as const)('one source writer frame blocks B from changing A sealed %s on another SQLite connection', async kind => {
  const f = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b)
    expect(a).toBeDefined(); expect(b).toBeDefined()
    let blocked: unknown
    f.hook(id => {
      if (id !== 'occurrence-batch-item-b') return
      try { if (kind === 'report') f.mutateReport(); else f.mutatePlan() }
      catch (error) { blocked = error; throw error }
    })
    const result = f.targets.withTargetsFence([a, b], proofs => proofs)
    const actual = f.base.store.ownerRecallText(f.a.itemId, f.a.reportRevision)
    expect(String(blocked)).toMatch(/locked|busy/u)
    expect(result[0]?.itemId).toBe(f.a.itemId)
    expect(result[0]?.report.text).toBe(actual)
    expect(result[1]).toBeUndefined()
  } finally { f.targets.close() }
})

test('B cannot launder cached A when the owner configuration changes during its producer callback', async () => {
  const f = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b)
    f.hook(id => { if (id === 'occurrence-batch-item-b') f.dependencies.config = normalizeConfig({ ...f.raw,
      admission: { ...f.raw.admission, maxOpenItems: f.config.admission.maxOpenItems + 1 } }, f.base.now()) })
    expect(f.targets.withTargetsFence([a, b], proofs => proofs)).toEqual([undefined, undefined])
  } finally { f.targets.close() }
})

test('the final shared owner read invalidates A after B changes route authority', async () => {
  const f = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b), delivery = f.dependencies.delivery()
    const original = delivery.validateOwnerRoute
    f.hook(id => { if (id === 'occurrence-batch-item-b') delivery.validateOwnerRoute = input => ({ ...original(input), authorityHash: 'changed-authority-hash' }) })
    expect(f.targets.withTargetsFence([a, b], proofs => proofs)).toEqual([undefined, undefined])
  } finally { f.targets.close() }
})

test.each(['report','configuration','service'] as const)('the very last shared owner callback cannot invalidate A %s after the final local pass', async change => {
  const f = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b), delivery = f.dependencies.delivery(), original = delivery.validateOwnerRoute
    let reads = 0, blocked: unknown
    delivery.validateOwnerRoute = input => {
      if (++reads === 5) {
        if (change === 'report') { try { f.mutateReport() } catch (error) { blocked = error; throw error } }
        else if (change === 'configuration') f.dependencies.config = normalizeConfig({ ...f.raw,
          admission: { ...f.raw.admission, maxOpenItems: f.config.admission.maxOpenItems + 1 } }, f.base.now())
        else f.deactivate()
      }
      return original(input)
    }
    const consumer = vi.fn((proofs: readonly unknown[]) => { expect(reads).toBe(5); return proofs })
    if (change === 'service') {
      expect(() => f.targets.withTargetsFence([a, b], consumer)).toThrow(/no longer current/u)
      expect(consumer).not.toHaveBeenCalled()
    } else {
      expect(f.targets.withTargetsFence([a, b], consumer)).toEqual([undefined, undefined])
      if (change === 'report') expect(String(blocked)).toMatch(/locked|busy/u)
    }
    expect(reads).toBe(5)
  } finally { f.targets.close() }
})

test.each(['delivery','automations'] as const)('all slots recheck the current %s identity after every producer read', async peer => {
  const f = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b)
    f.hook(id => { if (id === 'occurrence-batch-item-b') { if (peer === 'delivery') f.replaceDelivery(); else f.replaceAutomations() } })
    expect(f.targets.withTargetsFence([a, b], proofs => proofs)).toEqual([undefined, undefined])
  } finally { f.targets.close() }
})

test.each(['reader','service','store'] as const)('does not call the consumer when B closes the current %s', async resource => {
  const f = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b), callback = vi.fn()
    f.hook(id => { if (id === 'occurrence-batch-item-b') {
      if (resource === 'reader') f.targets.close()
      else if (resource === 'service') f.deactivate()
      else f.base.store.close()
    } })
    expect(() => f.targets.withTargetsFence([a, b], callback)).toThrow(/no longer current|unavailable/u)
    expect(callback).not.toHaveBeenCalled()
  } finally { f.targets.close() }
})

test('invalid and foreign capabilities stay aligned while repeated capability objects share one inert proof read', async () => {
  const f = await feedbackFenceFixture(), foreign = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b), other = foreign.targets.issue(foreign.a)
    f.calls.length = 0
    const result = f.targets.withTargetsFence([a, undefined, {}, a, other, null, 7, b], proofs => {
      expect(Object.isFrozen(proofs)).toBe(true)
      expect(Object.isFrozen(proofs[0])).toBe(true)
      expect(Object.isFrozen(proofs[0]!.supplier)).toBe(true)
      expect(Object.isFrozen(proofs[0]!.report)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(proofs[0]!, 'report')?.get).toBeUndefined()
      return proofs
    })
    expect(result.map(proof => proof?.itemId)).toEqual([f.a.itemId, undefined, undefined, f.a.itemId, undefined, undefined, undefined, f.b.itemId])
    expect(result[0]).toBe(result[3])
    expect(f.calls).toEqual(['occurrence-batch-item-a','occurrence-batch-item-b'])
    const sameExact = f.targets.issue(f.a)
    expect(f.targets.withTargetsFence([a, sameExact], proofs => proofs.map(proof => proof?.proofDigest)))
      .toEqual([result[0]!.proofDigest, result[0]!.proofDigest])
  } finally { f.targets.close(); foreign.targets.close() }
})

test('caps at 1000 dense data values, supports empty groups, and does not invoke array accessors', async () => {
  const f = await feedbackFenceFixture()
  try {
    const cap = f.targets.issue(f.a)
    f.calls.length = 0
    expect(f.targets.withTargetsFence(Array(1000).fill(cap), proofs => proofs.every(proof => proof?.itemId === f.a.itemId))).toBe(true)
    expect(f.calls).toEqual(['occurrence-batch-item-a'])
    expect(f.targets.withTargetsFence([], proofs => proofs)).toEqual([])
    const callback = vi.fn(), getter = vi.fn(() => cap), accessor: unknown[] = []
    Object.defineProperty(accessor, '0', { get: getter, enumerable: true })
    for (const malformed of [Array(1001).fill(cap), Array(1), accessor, Object.assign([cap], { extra: true }), null]) {
      expect(() => f.targets.withTargetsFence(malformed as never, callback)).toThrow(/1000|data values|arguments/u)
    }
    expect(getter).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled()
  } finally { f.targets.close() }
})

test('callback exceptions and Promise/thenables roll back source writes and release the writer lock', async () => {
  const f = await feedbackFenceFixture()
  try {
    const cap = f.targets.issue(f.a), key = 'feedback-fence-test-marker'
    f.base.store.setMeta(key, 'before')
    expect(() => f.targets.withTargetsFence([cap], () => { f.base.store.setMeta(key, 'throwing'); throw new Error('consumer failed') })).toThrow(/consumer failed/u)
    expect(f.base.store.meta(key)).toBe('before')
    const getter = vi.fn(() => () => undefined)
    // eslint-disable-next-line unicorn/no-thenable -- intentional hostile callback result; its getter must stay unread
    const thenable = Object.defineProperty({}, 'then', { get: getter })
    // eslint-disable-next-line unicorn/no-thenable -- inherited thenable must also be rejected synchronously
    for (const value of [Promise.resolve('late'), Promise.reject(new Error('late rejection')), thenable, Object.create({ then() {} })]) {
      expect(() => f.targets.withTargetsFence([cap], () => { f.base.store.setMeta(key, 'async'); return value })).toThrow(/synchronous/u)
      expect(f.base.store.meta(key)).toBe('before')
    }
    expect(getter).not.toHaveBeenCalled()
    await new Promise<void>(resolve => setImmediate(resolve))
    f.sql(db => db.prepare('UPDATE work_item_schema_meta SET value=? WHERE key=?').run('external writer succeeded', key))
    expect(f.base.store.meta(key)).toBe('external writer succeeded')
    expect(f.targets.withTargetsFence([cap], proofs => proofs[0]?.itemId)).toBe(f.a.itemId)
  } finally { f.targets.close() }
})

test('an earlier genuine capability is not reused after its source changed before the group', async () => {
  const f = await feedbackFenceFixture()
  try {
    const a = f.targets.issue(f.a), b = f.targets.issue(f.b)
    expect(f.targets.resolve(a)).toBeDefined()
    f.mutateReport()
    expect(f.targets.withTargetsFence([a, b], proofs => proofs.map(proof => proof?.itemId))).toEqual([undefined, f.b.itemId])
  } finally { f.targets.close() }
})

test('the new group keeps existing individual proof bytes and expired execution grants unchanged', async () => {
  const f = await feedbackFenceFixture()
  try {
    const cap = f.targets.issue(f.a), before = f.targets.resolve(cap)
    f.base.advance(86400001)
    const after = f.targets.withTargetsFence([cap], proofs => proofs[0])
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(after?.task.brief).toContain('\0tail 😀')
    expect(after?.report.text).toContain('\0tail 😀')
    expect(f.ingestExternal).not.toHaveBeenCalled()
  } finally { f.targets.close() }
})

test('the service publishes a current-generation closure and rejects its borrowed function after close', async () => {
  const f = await feedbackFenceFixture(), ctx = new Context()
  try {
    f.base.advance(86400001)
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
    ctx.provide('assistantPolicy', f.base.policy.service as never)
    ctx.provide('assistantDelivery', f.dependencies.delivery() as never)
    ctx.provide('assistantAutomations', f.dependencies.automations() as never)
    await ctx.plugin(AssistantWorkItemsService, f.raw)
    const service = ctx.assistantWorkItems, cap = service.issueOwnerWorkItemFeedbackTarget(f.a)
    const borrowed = service.withOwnerWorkItemFeedbackTargetsFence
    expect(borrowed([cap], proofs => proofs[0]?.itemId)).toBe(f.a.itemId)
    service.close()
    expect(() => borrowed([cap], () => 'unsafe')).toThrow(/unavailable/u)
  } finally { await ctx.fiber.restart(); f.targets.close() }
})
