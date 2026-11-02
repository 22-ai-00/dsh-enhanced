import { Context, Service, symbols } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerWorkItemTools } from '../src/tools.ts'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { AssistantWorkItemsService } from '../src/service.ts'
import type { OwnerWorkItemExecution } from '../src/owner-recall.ts'
import { admitted, claim, harness, receipt } from './fixtures.ts'
import type { WorkItemRecord } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.restart() })

// Real Cordis/service/SQLite, with explicit identity/Policy peer doubles. These
// tests do not certify a native human-turn attestation; integration covers it.
async function setup(reportCount = 1, tracedPeers = false) {
  const f = await harness()
  const item = await admitted(f, { title: 'Original task', brief: '原始😀任务\nsecond line' })
  claim(f, item.id)
  let saved = { item }
  for (let revision = 1; revision <= reportCount; revision++) saved = f.ledger.report({ itemId: item.id, runId: `occ-${item.id}`, status: revision === reportCount ? 'ready' : 'progress', summary: revision === reportCount ? '旧报告😀 conclusion' : `intermediate-${revision}`, artifactPaths: [], idempotencyKey: `old-report-${revision}` })
  const ctx = new Context(); contexts.push(ctx)
  let currentAgent = { id: 'new-session', session: { id: 'new-session', header: { cwd: f.config.scope!.workspace, agentPreset: 'primary' } } } as unknown as Agent
  let route = { ...receipt({ authorityId: f.config.scope!.ownerRouteId, principalId: f.config.scope!.principalId,
    workspace: f.config.scope!.workspace, agentPreset: f.config.scope!.preset }), generation: 3, bindingVersion: 4 }
  let allowed = true, onAuthorize = () => {}, onEvaluate = () => {}
  let openCall: { id: string; name: string; argumentsJson: string } | undefined
  let counter = 0, authorizeCalls = 0
  const charges = new Set<string>()
  const delivery = {
    validateOwnerRoute: () => route,
    validateOwnerAgentForRoute: (agent: Agent) => agent === currentAgent ? route : undefined,
    inspectOwnerForegroundToolCall: (input: { agent: Agent; callId: string; toolName: string; argumentsJson: string }) =>
      input.agent === currentAgent && openCall?.id === input.callId && openCall.name === input.toolName && openCall.argumentsJson === input.argumentsJson
        ? { protocol: 'assistant-delivery/foreground-tool-call/v1', task: { inboxId: 'human-inbox', sessionId: String(currentAgent.session.id) }, call: { ...openCall } } : undefined,
  }
  const policy = {
    authorize: () => ({ effect: 'deny', reasonCode: 'old-admit-mandate-revoked' }),
    authorizeAgent: (_agent: Agent, action: string, resource: { kind: string; id: string }, options: { idempotencyKey: string }) => {
      expect(action).toBe('inspect-work-items'); expect(resource).toEqual({ kind: 'automation', id: f.config.workerAutomationId })
      authorizeCalls++; charges.add(options.idempotencyKey); onAuthorize()
      return { effect: allowed ? 'allow' : 'deny', reasonCode: 'read-rule' }
    },
    evaluateAgent: () => { onEvaluate(); return { effect: allowed ? 'allow' : 'deny', reasonCode: 'read-rule' } },
  }
  if (tracedPeers) {
    class Peer extends Service { constructor(context: Context, name: string, methods: object) { super(context, name as never); Object.assign(this, methods) } }
    new Peer(ctx, 'assistantDelivery', delivery); new Peer(ctx, 'assistantPolicy', policy)
  } else { ctx.provide('assistantDelivery' as never, delivery as never); ctx.provide('assistantPolicy' as never, policy as never) }
  const config = { enabled: true, mode: 'active' as const, databasePath: f.config.databasePath, workRoot: f.config.workRoot,
    workerAutomationId: f.config.workerAutomationId!, scope: { ...f.config.scope!, expiresAt: Date.now() + 600_000 },
    admission: { allowedKinds: ['repair'] }, ownerRecall: { enabled: true } }
  const service = new AssistantWorkItemsService(ctx, config)
  function execution(name: 'work_item_list' | 'work_item_recall', args: Record<string, unknown>): OwnerWorkItemExecution {
    const id = `call-${++counter}`
    openCall = { id, name, argumentsJson: JSON.stringify(args) }
    return { agent: currentAgent, name, callId: id, arguments: args, signal: new AbortController().signal } as OwnerWorkItemExecution
  }
  function insert(id: string, changes: Partial<WorkItemRecord> = {}) {
    const row = { ...saved.item, id, externalId: id, dedupKey: id, createdAt: item.createdAt + counter + 1, updatedAt: item.updatedAt, ...changes }
    const dispatch = f.store.getDispatch(item.id)!
    f.store.admitItem(row, { kind: 'admitted', actor: 'unit-fixture' }, { ...dispatch, itemId: id, eventId: id })
    return row
  }
  function snapshot() {
    const db = new DatabaseSync(f.config.databasePath, { readOnly: true })
    try {
      const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'work_item%' ORDER BY name").all() as { name: string }[]
      return JSON.stringify(names.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]))
    } finally { db.close() }
  }
  return { f, ctx, service, item: saved.item, execution, insert, snapshot,
    route: () => route, setRoute: (next: typeof route) => { route = next },
    replaceAgent: () => { currentAgent = { ...currentAgent, id: 'newer-session', session: { ...currentAgent.session, id: 'newer-session' } } as Agent },
    deny: () => { allowed = false }, onAuthorize: (callback: () => void) => { onAuthorize = callback },
    onEvaluate: (callback: () => void) => { onEvaluate = callback }, policy, delivery,
    charged: () => charges.size, authorizeCalls: () => authorizeCalls }
}

test('same owner in a new Session recalls expired task/report history without worker authority or state writes', async () => {
  const h = await setup(), before = h.snapshot()
  const listArgs = {}, listExec = h.execution('work_item_list', listArgs)
  expect(h.service.preauthorizeTool(listExec as ToolExecution)).toBe(true)
  expect(h.authorizeCalls()).toBe(0)
  expect(h.service.listForOwner(listExec, listArgs).items.map(row => row.itemId)).toEqual([h.item.id])
  const args = { item_id: h.item.id }, exec = h.execution('work_item_recall', args)
  const page = h.service.recallForOwner(exec, args)
  expect(page.content).toMatchObject({ kind: 'brief', text: '原始😀任务\nsecond line' })
  expect(page.reports).toMatchObject([{ revision: 1, status: 'ready', summary: '旧报告😀 conclusion' }])
  expect(page.latestOutcome?.objectiveStatus).toBe('unknown')
  expect(JSON.stringify(page)).not.toContain('authority'); expect(JSON.stringify(page)).not.toContain('workDir')
  h.service.recallForOwner(exec, args)
  expect(h.charged()).toBe(2) // list + recall; identical call replay stays one Policy key
  expect(h.snapshot()).toBe(before)
  expect(() => h.service.claim(exec.agent)).toThrow()
})

test('SQL owner filtering precedes pagination and cursor is scoped/canonical', async () => {
  const h = await setup()
  for (let index = 0; index < 35; index++) h.insert(`foreign-${index}`, { owner: { ...h.item.owner, principalVersion: 99 }, createdAt: h.item.createdAt + 1000 + index })
  h.insert('own-a'); h.insert('own-b')
  const firstArgs = { limit: 1 }, first = h.service.listForOwner(h.execution('work_item_list', firstArgs), firstArgs)
  expect(first.items).toHaveLength(1); expect(first.items[0]!.itemId).toBe('own-a')
  const nextArgs = { limit: 1, after: first.nextCursor! }, next = h.service.listForOwner(h.execution('work_item_list', nextArgs), nextArgs)
  expect(next.items.map(row => row.itemId)).toEqual(['own-b'])
  for (const after of ['bad!', Buffer.from('{"createdAt":1,"id":"x","owner":"foreign"}').toString('base64url'),
    Buffer.from(' {"createdAt":1,"id":"x","owner":"foreign"}').toString('base64url')]) {
    const args = { after }; expect(() => h.service.listForOwner(h.execution('work_item_list', args), args)).toThrow()
  }
})

test('all persisted owner/route/scope/worker identities and generation/version fence historical reads', async () => {
  const h = await setup()
  const variants: Partial<WorkItemRecord>[] = [
    { scope: { ...h.item.scope, principalId: 'other' } }, { scope: { ...h.item.scope, principalId: `${h.item.scope.principalId}\0suffix` } }, { scope: { ...h.item.scope, ownerRouteId: 'other' } },
    { scope: { ...h.item.scope, workspace: '/other' } }, { scope: { ...h.item.scope, preset: 'other' } },
    { owner: { ...h.item.owner, principalRecordId: 'other' } }, { owner: { ...h.item.owner, principalVersion: 8 } },
    { workerAutomationId: 'other' }, { owner: { ...h.item.owner, generation: 4 } },
    { owner: { ...h.item.owner, generation: 3, bindingVersion: 3 } },
  ]
  for (const [index, variant] of variants.entries()) {
    const row = h.insert(`excluded-${index}`, variant), args = { item_id: row.id }
    expect(() => h.service.recallForOwner(h.execution('work_item_recall', args), args)).toThrow('no owner work item')
  }
  h.insert('same-generation', { owner: { ...h.item.owner, generation: 3, bindingVersion: 4 } })
  const args = { item_id: 'same-generation' }
  expect(h.service.recallForOwner(h.execution('work_item_recall', args), args).item.itemId).toBe('same-generation')
})

test('brief and exact report pages reconstruct UTF-8 and reject invalid boundaries/selectors', async () => {
  const h = await setup()
  for (const report_revision of [undefined, 1]) {
    let offset = 0, text = ''
    for (;;) {
      const args = { item_id: h.item.id, max_bytes: 4, offset, ...(report_revision === undefined ? {} : { report_revision }) }
      const page = h.service.recallForOwner(h.execution('work_item_recall', args), args)
      expect(Buffer.byteLength(page.content.text)).toBe(page.content.returnedBytes)
      text += page.content.text
      if (page.content.nextOffset === undefined) { expect(Buffer.byteLength(text)).toBe(page.content.fullBytes); break }
      offset = page.content.nextOffset
    }
    expect(text).toBe(report_revision === undefined ? '原始😀任务\nsecond line' : '旧报告😀 conclusion')
  }
  for (const more of [{ offset: 1 }, { offset: 999 }, { max_bytes: 3 }, { max_bytes: 8193 }, { report_revision: 99 }, { item_id: '../other' }, { path: '/etc/passwd' }]) {
    const args = { item_id: h.item.id, ...more }
    expect(() => h.service.recallForOwner(h.execution('work_item_recall', args), args as never)).toThrow()
  }
})

test('foreign Agents, missing foreground call and mutated arguments cannot borrow owner read permission', async () => {
  const h = await setup(), args = { item_id: h.item.id }, actual = h.execution('work_item_recall', args)
  expect(() => h.service.recallForOwner({ ...actual, agent: { ...actual.agent } as Agent }, args)).toThrow()
  expect(() => h.service.recallForOwner({ ...actual, callId: 'not-pending' as never }, args)).toThrow()
  expect(() => h.service.recallForOwner(actual, { item_id: 'different' })).toThrow('arguments')
  expect(h.authorizeCalls()).toBe(0)
})

test.each(['revoke', 'owner', 'peer', 'arguments', 'reentrant'] as const)('Policy callback %s cannot return task contents after invalidation', async change => {
  const h = await setup(), args = { item_id: h.item.id }, exec = h.execution('work_item_recall', args)
  let nestedDenied = false
  h.onAuthorize(() => {
    if (change === 'revoke') h.deny()
    if (change === 'owner') h.setRoute({ ...h.route(), principalVersion: 8 })
    if (change === 'peer') h.ctx.provide('assistantPolicy' as never, { ...h.policy } as never)
    if (change === 'arguments') (exec as { arguments: unknown }).arguments = { item_id: 'other' }
    if (change === 'reentrant') {
      try { h.service.recallForOwner(exec, args) } catch { nestedDenied = true }
      h.deny()
    }
  })
  expect(() => h.service.recallForOwner(exec, args)).toThrow()
  expect(h.authorizeCalls()).toBe(1)
  if (change === 'reentrant') expect(nestedDenied).toBe(true)
})

test('exact Delivery proof preserves native JSON argument order, not sorted key order', async () => {
  const h = await setup()
  const args = { max_bytes: 8192, report_revision: 1, item_id: h.item.id, offset: 0 }
  expect(h.service.recallForOwner(h.execution('work_item_recall', args), args).content.text).toBe('旧报告😀 conclusion')
})

test('withdrawn history remains readable while the current read route and active human call remain mandatory', async () => {
  const h = await setup(), row = h.insert('withdrawn-history', { state: 'dropped', stateReason: 'signal-withdrawn' })
  const args = { item_id: row.id }
  expect(h.service.recallForOwner(h.execution('work_item_recall', args), args).item.state).toBe('dropped')
  h.deny()
  expect(() => h.service.recallForOwner(h.execution('work_item_recall', args), args)).toThrow()
})

test('list report preview and recall revision links expose bounded worker conclusions separately from outcomes', async () => {
  const h = await setup(), listArgs = {}
  const page = h.service.listForOwner(h.execution('work_item_list', listArgs), listArgs)
  expect(page.items[0]?.lastReport).toMatchObject({ revision: 1, status: 'ready', summary: '旧报告😀 conclusion' })
  const args = { max_bytes: 8192, report_revision: 1, item_id: h.item.id }
  expect(h.service.recallForOwner(h.execution('work_item_recall', args), args).content).toMatchObject({
    kind: 'report', reportRevision: 1, status: 'ready', recordedAt: expect.any(Number) })
})

test('owner content uses full SQLite UTF-8 bytes including NUL and rejects malformed bytes', async () => {
  const h = await setup(), db = new DatabaseSync(h.f.config.databasePath)
  try {
    db.prepare('UPDATE work_item SET brief=? WHERE id=?').run('前😀\u0000后', h.item.id)
    const args = { item_id: h.item.id }
    expect(h.service.recallForOwner(h.execution('work_item_recall', args), args).content).toMatchObject({ text: '前😀\u0000后', fullBytes: Buffer.byteLength('前😀\u0000后') })
    db.prepare("UPDATE work_item SET brief=CAST(x'ff' AS TEXT) WHERE id=?").run(h.item.id)
    expect(() => h.service.recallForOwner(h.execution('work_item_recall', args), args)).toThrow('UTF-8')
  } finally { db.close() }
})

test('recall follows neighboring revisions beyond the five inline reports without guessing', async () => {
  const h = await setup(8), args = { item_id: h.item.id, report_revision: 2 }
  const page = h.service.recallForOwner(h.execution('work_item_recall', args), args)
  expect(page.reports.map(report => report.revision)).toEqual([4, 5, 6, 7, 8])
  expect(page.content).toMatchObject({ reportRevision: 2, text: 'intermediate-2', status: 'progress', previousRevision: 1, nextRevision: 3 })
})

test('owner tool registration is opt-in and leaves the diagnosis five-tool definitions byte-identical', () => {
  function definitions(ownerRecallEnabled: boolean, diagnosisEnabled: boolean, oldPolicy = false) {
    const tools: ToolDefinition[] = [], preauthorized: string[] = []
    const policy = { workItemToolPreauthorizationVersion: () => 1,
      registerPreauthorizedTool: (_ctx: unknown, definition: ToolDefinition) => {
        if (oldPolicy && !['work_item_claim', 'work_item_report', 'work_item_status', 'work_item_read_report'].includes(definition.name)) throw new Error('unsupported name')
        preauthorized.push(definition.name)
      } }
    const ctx = { tools: { register: (definition: ToolDefinition) => tools.push(definition) },
      inject: (_names: unknown, callback: (ctx: unknown) => unknown) => callback({ get: () => policy, logger: { warn() {} } }) }
    const service = { ownerRecallEnabled, diagnosisEnabled, preauthorizeTool: () => true }
    registerWorkItemTools(ctx as unknown as Context, service as unknown as AssistantWorkItemsService)
    return { tools, preauthorized }
  }
  const original = definitions(false, true), extended = definitions(true, true)
  expect(original.tools.map(tool => tool.name)).not.toContain('work_item_list')
  expect(extended.tools.map(tool => tool.name)).toContain('work_item_recall')
  const wire = (tool: ToolDefinition) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output?.schema })
  expect(extended.tools.slice(0, 5).map(wire)).toEqual(original.tools.map(wire))
  expect(definitions(true, true, true).preauthorized).toEqual(['work_item_claim', 'work_item_report', 'work_item_status', 'work_item_read_report'])
})

test('Cordis traceable peer proxies remain stable providers while actual replacements revoke reads', async () => {
  const h = await setup(1, true)
  const first = h.ctx.get('assistantDelivery' as never, false) as unknown as Record<symbol, unknown>
  const second = h.ctx.get('assistantDelivery' as never, false) as unknown as Record<symbol, unknown>
  expect(first).not.toBe(second)
  expect(first[symbols.original]).toBe(second[symbols.original])
  const args = { item_id: h.item.id }, exec = h.execution('work_item_recall', args)
  expect(h.service.preauthorizeTool(exec as ToolExecution)).toBe(true)
  expect(h.service.recallForOwner(exec, args).content.kind).toBe('brief')
  h.onEvaluate(() => { h.ctx.set('assistantDelivery' as never, { ...h.delivery } as never) })
  expect(() => h.service.recallForOwner(exec, args)).toThrow('authority changed')
})
