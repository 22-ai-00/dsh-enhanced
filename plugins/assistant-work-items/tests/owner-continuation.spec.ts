import type { Agent } from '@deepseek-ai/dsh-agent'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { WorkItemAdmission } from '../src/admission.ts'
import { WorkItemOwnerContinuation } from '../src/owner-continuation.ts'
import { WorkItemOwnerRecall } from '../src/owner-recall.ts'
import type { OwnerWorkItemExecution } from '../src/owner-access.ts'
import type { WorkItemContinuation } from '../src/continuation.ts'
import { continuationDigest, continuationSourceKey, type WorkItemContinuationAdmission } from '../src/continuation-record.ts'
import type { ContinuationSource } from '../src/continuation-contract.ts'
import type { PeerDeliveryService, PeerOwnerForegroundToolInput, PeerPolicyService } from '../src/peers.ts'
import { admitted, claim, harness, receipt, PRINCIPAL, PRESET, ROUTE, WORKSPACE } from './fixtures.ts'

// Actual ledger, SQL owner filter and admission. Native call/Delivery/Policy and
// production-runtime checks are narrow peers, not native Host E2E evidence.
async function setup(text = '真实主人续办指令🧭\0完整输入。'.repeat(600)) {
  const expiresAt = Date.now() + 600000
  const f = await harness({ ownerRecall: { enabled: true }, scope: { workspace: WORKSPACE, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: ROUTE, expiresAt },
    admission: { allowedKinds: ['review', 'owner-continuation'], maxOpenItems: 8, maxAdmitsPerHour: 20, cooldownMs: 0 },
    ownerContinuation: { enabled: true, automationId: 'continuation-worker', allowedTools: ['work_item_claim', 'work_item_report', 'work_item_read_context'], budgetId: 'continuation-budget', budgetAmount: 1, maxModelCalls: 3, maxToolCalls: 6, maxOutputTokens: 512, timeoutMs: 10000, expiresAt } })
  const parent = await admitted(f, { title: '原任务', brief: 'parent context' }); claim(f, parent.id)
  f.ledger.report({ itemId: parent.id, runId: `occ-${parent.id}`, status: 'ready', summary: 'prior terminal report', artifactPaths: [], idempotencyKey: 'parent-ready' })
  let agent = { id: 'new-session', session: { id: 'new-session', header: { cwd: WORKSPACE, agentPreset: PRESET } } } as unknown as Agent
  let route = { ...receipt({ authorityId: ROUTE, principalId: PRINCIPAL, workspace: WORKSPACE, agentPreset: PRESET }), generation: 3, bindingVersion: 4 }
  let open: { callId: string; name: string; args: Record<string, unknown> } | undefined
  let inputText = text, sourceDigest = acceptanceDigest({ text }), modelState: PeerOwnerForegroundToolInput['modelSelectionState'] = 'frozen'
  let allowed = true, available = true, onEvaluate = () => {}, onRead = (_offset: number) => {}, onPrepare = () => {}
  let prepares = 0, wakes = 0, admits = 0
  const sources: ContinuationSource[] = [], charges = new Set<string>()
  const proof = () => ({ protocol: 'assistant-delivery/foreground-tool-call/v1' as const,
    task: { protocol: 'assistant-delivery/foreground-task/v1' as const, inboxId: 'human-inbox', sessionId: String(agent.session.id), scope: { workspace: WORKSPACE, preset: PRESET },
      owner: { principalRecordId: route.principalRecordId, principalVersion: route.principalVersion }, binding: { id: 'human-binding', version: route.bindingVersion, generation: route.generation }, dispatchedAt: 1700000000000 },
    turn: 1, call: { id: open!.callId, toolName: open!.name, eventSeq: 11, eventDigest: continuationDigest(open!.callId), argumentsDigest: continuationDigest(JSON.stringify(open!.args)) } })
  const delivery: PeerDeliveryService = { enqueueBackground: () => { throw new Error('unexpected background delivery') }, validateOwnerRoute: () => route, validateOwnerAgentForRoute: value => value === agent ? route : undefined,
    inspectOwnerForegroundToolCall: input => input.agent === agent && input.callId === open?.callId && input.toolName === open.name && input.argumentsJson === JSON.stringify(open.args) ? proof() : undefined,
    readOwnerForegroundToolInput: input => {
      onRead(input.offset ?? 0); if (!open || !delivery.inspectOwnerForegroundToolCall!(input)) return undefined
      const bytes = Buffer.from(inputText), offset = input.offset ?? 0; let end = Math.min(bytes.length, offset + (input.maxBytes ?? 4096))
      while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
      return { protocol: 'assistant-delivery/foreground-tool-input/v1', attestation: proof(), sourceDigest, modelSelectionState: modelState,
        ...(modelState === 'frozen' ? { modelSelection: { provider: 'recorded-provider', model: 'recorded-model', reasoningEffort: 'high' } } : {}),
        input: { text: bytes.subarray(offset, end).toString('utf8'), fullTextDigest: continuationDigest(inputText), fullBytes: bytes.length, returnedBytes: end - offset, offset, ...(end < bytes.length ? { nextOffset: end } : {}) } }
    } }
  const policy: PeerPolicyService = { authorize: () => ({ effect: 'allow', reasonCode: 'fixture-admission' }),
    evaluateAgent: (_agent, action, resource) => { expect(['continue-work-items', 'inspect-work-items']).toContain(action); expect(resource.id).toBe(action === 'continue-work-items' ? f.config.ownerContinuation!.automationId : f.config.workerAutomationId); onEvaluate(); return { effect: allowed ? 'allow' : 'deny', reasonCode: 'current-rule' } },
    authorizeAgent: (_agent, _action, _resource, options) => { charges.add(options!.idempotencyKey!); return { effect: allowed ? 'allow' : 'deny', reasonCode: 'current-rule' } } }
  const runtime = { prepare(parentItemId: string, source: ContinuationSource, assertCurrent: () => void): WorkItemContinuationAdmission {
    prepares++; assertCurrent(); onPrepare(); assertCurrent(); sources.push(source)
    const sourceKey = continuationSourceKey(parentItemId, source.sourceDigest), parentReportRevision = f.store.lastReport(parentItemId)?.revision ?? null, parentOutcomeRevision = f.store.latestOutcome(parentItemId)?.revision ?? null
    return { parentItemId, sourceDigest: source.sourceDigest, sourceKey, create: item => {
      assertCurrent(); const planJson = acceptanceCanonicalJson({ parent: parentItemId, source: source.sourceDigest, supplier: source.modelSelection })
      return { itemId: item.id, parentItemId, rootItemId: f.store.getContinuation(parentItemId)?.rootItemId ?? parentItemId, sourceKey, sourceDigest: source.sourceDigest, inputText: source.inputText,
        inputSha256: continuationDigest(source.inputText), parentReportRevision, parentOutcomeRevision, planJson, planDigest: continuationDigest(planJson), createdAt: item.createdAt }
    } }
  }, wakePending() { wakes++ } } as unknown as WorkItemContinuation
  let token: WorkItemContinuationAdmission | undefined
  const childAdmission = new WorkItemAdmission({ config: { ...f.config, workerAutomationId: f.config.ownerContinuation!.automationId, limits: { ...f.config.limits, maxAttempts: 1 } }, store: f.store, ledger: f.ledger, workspace: f.ledger.workspace,
    policy, delivery, continuationFor: () => token, now: f.now })
  const deps = { config: f.config, store: () => f.store, delivery: () => delivery, policy: () => policy }
  const entry = new WorkItemOwnerContinuation({ ...deps, runtime: () => available ? runtime : undefined, admit: (input, continuation) => {
    admits++; token = continuation; try { return childAdmission.admit(input) } finally { token = undefined }
  } })
  function execution(args: Record<string, unknown> = { item_id: parent.id }, name = 'work_item_continue'): OwnerWorkItemExecution {
    open = { callId: 'actual-call', name, args }; return { agent, name, arguments: args, callId: open.callId, signal: new AbortController().signal } as OwnerWorkItemExecution
  }
  return { f, parent, entry, recall: new WorkItemOwnerRecall(deps), execution, sources, delivery, charges, counts: () => ({ prepares, wakes, admits }),
    setText: (text: string) => { inputText = text; sourceDigest = acceptanceDigest({ text }) }, setState: (state: typeof modelState) => { modelState = state },
    newSession: () => { agent = { ...agent, id: 'later-session', session: { ...agent.session, id: 'later-session' } } as Agent; route = { ...route, generation: route.generation + 1, bindingVersion: route.bindingVersion + 1 } },
    deny: () => { allowed = false }, hideRuntime: () => { available = false }, revoke: () => { route = { ...route, principalVersion: route.principalVersion + 1 } },
    onRead: (callback: typeof onRead) => { onRead = callback }, onEvaluate: (callback: typeof onEvaluate) => { onEvaluate = callback }, onPrepare: (callback: typeof onPrepare) => { onPrepare = callback } }
}

test('freezes complete authenticated UTF-8 pages and actual supplier, then reuses one linked child', async () => {
  const h = await setup(), exec = h.execution()
  expect(h.entry.preauthorize(exec)).toBe(true); expect(h.counts()).toEqual({ prepares: 0, admits: 0, wakes: 0 }); expect(h.charges.size).toBe(0)
  const first = h.entry.continue(exec, { item_id: h.parent.id }), record = h.f.store.getContinuation(first.itemId)!
  expect(first).toMatchObject({ parentItemId: h.parent.id, rootItemId: h.parent.id, state: 'queued', replayed: false })
  expect(Buffer.byteLength(record.inputText)).toBeGreaterThan(8192); expect(record.inputText).toContain('\0'); expect(record.inputSha256).toBe(continuationDigest(record.inputText))
  expect(h.sources[0]!.modelSelection).toEqual({ provider: 'recorded-provider', model: 'recorded-model', reasoningEffort: 'high' })
  expect(h.f.store.findItemById(first.itemId)).toMatchObject({ kind: 'owner-continuation', originBindingId: 'human-binding', workerAutomationId: h.f.config.ownerContinuation!.automationId, maxAttempts: 1 })
  expect(h.f.store.findItemById(first.itemId)!.brief).not.toContain('真实主人续办指令')
  expect(h.entry.continue(exec, { item_id: h.parent.id })).toMatchObject({ itemId: first.itemId, replayed: true }); expect(h.counts().wakes).toBe(2); expect(h.charges.size).toBe(1)
  const args = {}, list = h.recall.list(h.execution(args, 'work_item_list'), args)
  expect(list.items.map(item => item.itemId)).toEqual(expect.arrayContaining([h.parent.id, first.itemId]))
})

test('requires exact owner parent/call arguments, independent Policy permission and live runtime', async () => {
  const unknown = await setup(); expect(() => unknown.entry.continue(unknown.execution({ item_id: 'not-owner-item' }), { item_id: 'not-owner-item' })).toThrow('no owner work item'); expect(unknown.counts().prepares).toBe(0)
  const denied = await setup(); denied.deny(); const exec = denied.execution(); expect(denied.entry.preauthorize(exec)).toBe(false)
  expect(() => denied.entry.continue(exec, { item_id: denied.parent.id })).toThrow('permission denied'); expect(denied.counts().admits).toBe(0)
  const absent = await setup(); absent.hideRuntime(); expect(absent.entry.preauthorize(absent.execution())).toBe(false); expect(() => absent.entry.continue(absent.execution(), { item_id: absent.parent.id })).toThrow('runtime is unavailable')
  const args = await setup(), actual = args.execution(); expect(() => args.entry.continue(actual, { item_id: 'different' })).toThrow('arguments do not match')
  expect(() => args.entry.continue(actual, { item_id: args.parent.id, brief: 'model replacement' } as never)).toThrow('unknown owner continuation argument')
})

test.each(['missing', 'inconsistent'] as const)('rejects %s supplier without fallback or admission', async state => {
  const h = await setup(); h.setState(state); const exec = h.execution()
  expect(h.entry.preauthorize(exec)).toBe(false); expect(() => h.entry.continue(exec, { item_id: h.parent.id })).toThrow('actual supplier is unproven'); expect(h.counts().admits).toBe(0)
})

test('refuses changed source during pagination and prepare, and owner revocation', async () => {
  const paged = await setup(); paged.onRead(offset => { if (offset > 0) paged.setText('changed owner message'.repeat(1000)) })
  expect(() => paged.entry.continue(paged.execution(), { item_id: paged.parent.id })).toThrow('changed during pagination'); expect(paged.counts().admits).toBe(0)
  const late = await setup(); late.onPrepare(() => late.setText('replacement after plan'))
  expect(() => late.entry.continue(late.execution(), { item_id: late.parent.id })).toThrow('source or runtime changed'); expect(late.counts().admits).toBe(0)
  const revoked = await setup(); revoked.onPrepare(() => revoked.revoke())
  expect(() => revoked.entry.continue(revoked.execution(), { item_id: revoked.parent.id })).toThrow('owner/call changed'); expect(revoked.counts().admits).toBe(0)
})

test('refuses over-limit/empty/malformed page streams before creating a child', async () => {
  const large = await setup('x'.repeat(262145)); expect(() => large.entry.continue(large.execution(), { item_id: large.parent.id })).toThrow('input page binding differs'); expect(large.counts().admits).toBe(0)
  const empty = await setup(''); expect(() => empty.entry.continue(empty.execution(), { item_id: empty.parent.id })).toThrow('input page binding differs')
  const malformed = await setup(), read = malformed.delivery.readOwnerForegroundToolInput!
  malformed.delivery.readOwnerForegroundToolInput = input => { const page = read(input)!; return { ...page, input: { ...page.input, returnedBytes: page.input.returnedBytes + 1 } } }
  expect(() => malformed.entry.continue(malformed.execution(), { item_id: malformed.parent.id })).toThrow('input page binding differs'); expect(malformed.counts().admits).toBe(0)
})

test('shared access rejects cross-feature reentry and remains usable', async () => {
  const h = await setup(), exec = h.execution(); let checked = false
  h.onEvaluate(() => { if (checked) return; checked = true
    expect(() => h.entry.continue(exec, { item_id: h.parent.id })).toThrow('non-reentrant')
    expect(() => h.recall.list({ ...exec, name: 'work_item_list', arguments: {} }, {})).toThrow('non-reentrant')
  })
  expect(h.entry.continue(exec, { item_id: h.parent.id }).replayed).toBe(false); expect(checked).toBe(true)
})


test('later owner Session lists and recalls minimal continuation ancestry with no ledger or dispatch mutation', async () => {
  const h = await setup(), child = h.entry.continue(h.execution(), { item_id: h.parent.id }), record = h.f.store.getContinuation(child.itemId)!
  h.newSession()
  const snapshot = () => {
    const db = new DatabaseSync(h.f.config.databasePath, { readOnly: true })
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'work_item%' ORDER BY name").all() as { name: string }[]
      return JSON.stringify(tables.map(({ name }) => { if (!/^[a-z_]+$/u.test(name)) throw new Error('unsafe fixture table'); return [name, db.prepare(`SELECT * FROM ${name}`).all()] }))
    } finally { db.close() }
  }
  const before = snapshot(), actorCounts = h.counts(), listArgs = {}
  const listed = h.recall.list(h.execution(listArgs, 'work_item_list'), listArgs).items.find(item => item.itemId === child.itemId)!
  const args = { item_id: child.itemId }, recalled = h.recall.recall(h.execution(args, 'work_item_recall'), args)
  const expected = { parentItemId: h.parent.id, rootItemId: h.parent.id }
  expect(listed.continuation).toEqual(expected); expect(recalled.item.continuation).toEqual(expected)
  expect(Object.keys(recalled.item.continuation!).sort()).toEqual(['parentItemId', 'rootItemId'])
  expect(Object.isFrozen(recalled.item.continuation)).toBe(true)
  const parentArgs = { item_id: recalled.item.continuation!.parentItemId }
  const parent = h.recall.recall(h.execution(parentArgs, 'work_item_recall'), parentArgs)
  expect(parent.item.itemId).toBe(h.parent.id); expect(parent.item.continuation).toBeUndefined(); expect(parent.content.text).toBe('parent context')
  const summaries = JSON.stringify([listed, recalled.item])
  for (const secret of [record.sourceDigest, record.inputText, record.planJson, 'sourceDigest', 'inputText', 'planJson', 'authority']) expect(summaries).not.toContain(secret)
  expect(snapshot()).toBe(before); expect(h.counts()).toEqual(actorCounts)
})
