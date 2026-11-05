import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, test } from 'vitest'
import { WorkItemOwnerContinuation } from '../src/owner-continuation.ts'
import { WorkItemOwnerRecall } from '../src/owner-recall.ts'
import type { OwnerWorkItemExecution } from '../src/owner-access.ts'
import type { WorkItemContinuation } from '../src/continuation.ts'
import type { PeerDeliveryService, PeerOwnerAliasReceipt, PeerPolicyService } from '../src/peers.ts'
import { admitted, claim, harness, receipt, PRINCIPAL, PRESET, ROUTE, WORKSPACE } from './fixtures.ts'

// Real ledger/SQL owner filter with narrow Delivery/Policy peers. The Delivery
// side of the alias receipt (link/unlink/version/handoff) is covered in
// assistant-delivery/tests/owner-alias.spec.ts; here we prove Work Items only
// accepts that receipt for inspect-work-items and never in a v2 owner slot.
const ALIAS = 'telegram/bot/personal/alias'
async function setup(linkedAliases: string[] | null = [ALIAS]) {
  const expiresAt = Date.now() + 600000
  const f = await harness({ ownerRecall: { enabled: true, ...(linkedAliases ? { linkedAliases } : {}) }, scope: { workspace: WORKSPACE, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: ROUTE, expiresAt },
    admission: { allowedKinds: ['review', 'owner-continuation'], maxOpenItems: 8, maxAdmitsPerHour: 20, cooldownMs: 0 },
    ownerContinuation: { enabled: true, automationId: 'continuation-worker', allowedTools: ['work_item_claim', 'work_item_report', 'work_item_read_context'], budgetId: 'continuation-budget', budgetAmount: 1, maxModelCalls: 3, maxToolCalls: 6, maxOutputTokens: 512, timeoutMs: 10000, expiresAt } })
  const item = await admitted(f, { title: '原任务', brief: '跨渠道可读😀' }); claim(f, item.id)
  f.ledger.report({ itemId: item.id, runId: `occ-${item.id}`, status: 'ready', summary: 'owner report', artifactPaths: [], idempotencyKey: 'ready' })
  const agentOf = (id: string) => ({ id, session: { id, header: { cwd: WORKSPACE, agentPreset: PRESET } } }) as unknown as Agent
  const owner = agentOf('lark-owner-session'), alias = agentOf('telegram-alias-session')
  let route = { ...receipt({ authorityId: ROUTE, principalId: PRINCIPAL, workspace: WORKSPACE, agentPreset: PRESET }), generation: 3, bindingVersion: 4 }
  let linked = true, v2Leak = false, ownerProofForAlias = false, extra: Record<string, unknown> = {}
  let open: { callId: string; name: string; argumentsJson: string } | undefined
  let allowed = true, onEvaluate = () => {}, counter = 0, admits = 0, aliasLookups = 0
  const evaluated: string[] = []
  const aliasReceipt = (): PeerOwnerAliasReceipt => Object.freeze({ protocol: 'assistant-delivery/owner-alias-receipt/v1' as const,
    authorityId: ROUTE, authorityHash: route.authorityHash, workspace: WORKSPACE, agentPreset: PRESET,
    alias: { principalId: ALIAS, principalRecordId: 'alias-record', principalVersion: 2,
      bindingId: 'alias-binding', bindingVersion: 1, bindingGeneration: 1, sessionId: String(alias.session.id) },
    root: { principalId: route.principalId, principalRecordId: route.principalRecordId, principalVersion: route.principalVersion,
      bindingVersion: route.bindingVersion, generation: route.generation }, ...extra })
  const matches = (input: { callId: string; toolName: string; argumentsJson: string }) =>
    open?.callId === input.callId && open.name === input.toolName && open.argumentsJson === input.argumentsJson
  const delivery: PeerDeliveryService = {
    enqueueBackground: () => { throw new Error('unexpected background delivery') },
    validateOwnerRoute: () => route,
    // The v2 slot: exact owner only. v2Leak simulates a peer that wrongly hands the alias receipt here.
    validateOwnerAgentForRoute: agent => agent === owner ? route : agent === alias && v2Leak && linked ? aliasReceipt() as never : undefined,
    inspectOwnerForegroundToolCall: input => (input.agent === owner || ownerProofForAlias && input.agent === alias) && matches(input)
      ? { protocol: 'assistant-delivery/foreground-tool-call/v1', call: { ...open } } : undefined,
    inspectOwnerAliasRoute: agent => { aliasLookups++; return agent === alias && linked ? aliasReceipt() : undefined },
    inspectOwnerAliasForegroundToolCall: input => input.agent === alias && linked && matches(input)
      ? (ownerProofForAlias ? { protocol: 'assistant-delivery/foreground-tool-call/v1' } : { protocol: 'assistant-delivery/owner-alias-foreground-tool-call/v1', receipt: aliasReceipt(), call: { ...open } }) : undefined,
    readOwnerForegroundToolInput: () => { throw new Error('alias must not reach continuation input') },
  }
  const policy: PeerPolicyService = {
    authorize: () => ({ effect: 'allow', reasonCode: 'fixture-admission' }),
    evaluateAgent: (agent, action) => { evaluated.push(`${String(agent?.id)}:${action}`); onEvaluate(); return { effect: allowed ? 'allow' : 'deny', reasonCode: 'read-rule' } },
    authorizeAgent: () => ({ effect: allowed ? 'allow' : 'deny', reasonCode: 'read-rule' }),
  }
  const deps = { config: f.config, store: () => f.store, delivery: () => delivery, policy: () => policy }
  const recall = new WorkItemOwnerRecall(deps)
  const continuation = new WorkItemOwnerContinuation({ ...deps, runtime: () => ({ wakePending() {} }) as unknown as WorkItemContinuation,
    admit: () => { admits++; throw new Error('alias must not admit') } })
  function execution(agent: Agent, name: string, args: Record<string, unknown>): OwnerWorkItemExecution {
    const callId = `call-${++counter}`
    open = { callId, name, argumentsJson: JSON.stringify(args) }
    return { agent, name, callId, arguments: args, signal: new AbortController().signal } as OwnerWorkItemExecution
  }
  return { f, item, owner, alias, recall, continuation, execution, evaluated, admits: () => admits, aliasLookups: () => aliasLookups,
    route: () => route, setRoute: (next: typeof route) => { route = next }, unlink: () => { linked = false },
    leakV2: () => { v2Leak = true }, ownerProofForAlias: () => { ownerProofForAlias = true },
    setExtra: (next: Record<string, unknown>) => { extra = next }, deny: () => { allowed = false },
    onEvaluate: (callback: () => void) => { onEvaluate = callback } }
}

test('a Lark owner and its linked alias list and recall the same owner items', async () => {
  const h = await setup()
  const ownerList = h.recall.list(h.execution(h.owner, 'work_item_list', {}), {})
  const aliasExec = h.execution(h.alias, 'work_item_list', {})
  expect(h.recall.preauthorize(aliasExec)).toBe(true)
  const aliasList = h.recall.list(aliasExec, {})
  expect(aliasList.items.map(row => row.itemId)).toEqual([h.item.id])
  expect(aliasList.items.map(row => row.itemId)).toEqual(ownerList.items.map(row => row.itemId))
  const args = { item_id: h.item.id }
  expect(h.recall.recall(h.execution(h.alias, 'work_item_recall', args), args).content).toMatchObject({ kind: 'brief', text: '跨渠道可读😀' })
  // Policy is evaluated for the alias Agent itself; it needs its own inspect rule.
  expect(h.evaluated).toContain('telegram-alias-session:inspect-work-items')
  h.deny()
  expect(() => h.recall.list(h.execution(h.alias, 'work_item_list', {}), {})).toThrow('read permission denied')
})

test('the alias is denied continuation, approval and worker mutations', async () => {
  const h = await setup(), args = { item_id: h.item.id }
  const exec = h.execution(h.alias, 'work_item_continue', args)
  expect(h.continuation.preauthorize(exec)).toBe(false)
  expect(() => h.continuation.continue(exec, args)).toThrow('owner continuation requires the current exact owner')
  expect(h.admits()).toBe(0)
  expect(h.evaluated.some(entry => entry.endsWith(':continue-work-items'))).toBe(false)
  // The alias path only exists for the two read tools; mutation tool identities never reach it.
  // (Approval preparation is Delivery-owned and owner-only; see assistant-delivery owner-alias.spec.ts.)
  for (const name of ['work_item_claim', 'work_item_report', 'work_item_continue']) {
    expect(() => h.recall.list(h.execution(h.alias, name, {}), {})).toThrow('tool identity mismatch')
  }
  // An alias read leaves the owner rows untouched.
  const scope = { principalId: PRINCIPAL, principalRecordId: 'principal-1', principalVersion: 7, workspace: WORKSPACE, preset: PRESET,
    ownerRouteId: ROUTE, workerAutomationId: h.f.config.workerAutomationId!, generation: 3, bindingVersion: 4 }
  const before = JSON.stringify(h.f.store.listOwnerItems(scope, undefined, 10))
  h.recall.list(h.execution(h.alias, 'work_item_list', {}), {})
  expect(JSON.stringify(h.f.store.listOwnerItems(scope, undefined, 10))).toBe(before)
  const recallExec = h.execution(h.alias, 'work_item_recall', { item_id: h.item.id, path: '/etc/passwd' })
  expect(() => h.recall.recall(recallExec, { item_id: h.item.id, path: '/etc/passwd' } as never)).toThrow()
})

test('unlink and a root owner version change revoke alias reads, including mid-call (ABA)', async () => {
  const unlinked = await setup()
  unlinked.unlink()
  expect(() => unlinked.recall.list(unlinked.execution(unlinked.alias, 'work_item_list', {}), {})).toThrow('requires the current exact owner')

  const midUnlink = await setup()
  midUnlink.onEvaluate(() => midUnlink.unlink())
  expect(() => midUnlink.recall.list(midUnlink.execution(midUnlink.alias, 'work_item_list', {}), {})).toThrow()

  const bumped = await setup()
  bumped.onEvaluate(() => bumped.setRoute({ ...bumped.route(), principalVersion: bumped.route().principalVersion + 1 }))
  expect(() => bumped.recall.list(bumped.execution(bumped.alias, 'work_item_list', {}), {})).toThrow('owner/call changed')
  // After the change settles, items admitted under the old owner version are no longer visible to the alias.
  bumped.onEvaluate(() => {})
  expect(bumped.recall.list(bumped.execution(bumped.alias, 'work_item_list', {}), {}).items).toEqual([])
  const args = { item_id: bumped.item.id }
  expect(() => bumped.recall.recall(bumped.execution(bumped.alias, 'work_item_recall', args), args)).toThrow('no owner work item')
})

test('v2 owner checks reject the alias receipt and alias receipts reject foreign shapes', async () => {
  const leaked = await setup()
  leaked.leakV2()
  expect(() => leaked.recall.list(leaked.execution(leaked.alias, 'work_item_list', {}), {})).toThrow('requires the current exact owner')
  const args = { item_id: leaked.item.id }
  expect(() => leaked.continuation.continue(leaked.execution(leaked.alias, 'work_item_continue', args), args)).toThrow('requires the current exact owner')

  for (const extra of [{ receiptVersion: 2 }, { root: { principalId: 'someone-else', principalRecordId: 'principal-1', principalVersion: 7, bindingVersion: 4, generation: 3 } },
    { alias: { principalId: 'x', principalRecordId: 'principal-1', principalVersion: 2, bindingId: 'b', bindingVersion: 1, bindingGeneration: 1, sessionId: 'telegram-alias-session' } },
    { alias: { principalId: 'x', principalRecordId: 'alias-record', principalVersion: 2, bindingId: 'b', bindingVersion: 1, bindingGeneration: 1, sessionId: 'other-session' } },
    { workspace: '/other' }]) {
    const h = await setup(); h.setExtra(extra)
    expect(() => h.recall.list(h.execution(h.alias, 'work_item_list', {}), {})).toThrow('requires the current exact owner or its linked alias')
  }

  // An owner-protocol proof is not an alias proof, and an alias proof never satisfies the owner path.
  const wrongProof = await setup()
  wrongProof.ownerProofForAlias()
  expect(() => wrongProof.recall.list(wrongProof.execution(wrongProof.alias, 'work_item_list', {}), {})).toThrow('requires an actual human foreground tool call')
})

test('a Delivery link alone is not consent: alias reads need the owner allowlist', async () => {
  // No allowlist: Delivery is never consulted for an alias and Policy never sees the alias call,
  // so an owner inspect rule without a principal match can no longer leak to a linked account.
  const absent = await setup(null)
  expect(absent.f.config.ownerRecall).toEqual({ enabled: true })
  expect(absent.recall.preauthorize(absent.execution(absent.alias, 'work_item_list', {}))).toBe(false)
  expect(() => absent.recall.list(absent.execution(absent.alias, 'work_item_list', {}), {})).toThrow('requires the current exact owner')
  expect(absent.aliasLookups()).toBe(0)
  expect(absent.evaluated).toEqual([])
  // The exact owner is unaffected.
  expect(absent.recall.list(absent.execution(absent.owner, 'work_item_list', {}), {}).items.map(row => row.itemId)).toEqual([absent.item.id])

  // Allowlist names a different linked principal: the valid receipt is still refused before Policy.
  const other = await setup(['lark/app/other/alias'])
  expect(() => other.recall.list(other.execution(other.alias, 'work_item_list', {}), {})).toThrow('linked alias is not allowlisted by the owner')
  expect(other.evaluated).toEqual([])
  const args = { item_id: other.item.id }
  expect(() => other.recall.recall(other.execution(other.alias, 'work_item_recall', args), args)).toThrow('linked alias is not allowlisted by the owner')

  // Allowlisting never widens continuation.
  const listed = await setup()
  expect(() => listed.continuation.continue(listed.execution(listed.alias, 'work_item_continue', args), args)).toThrow('requires the current exact owner')
  expect(listed.aliasLookups()).toBe(0)
})
