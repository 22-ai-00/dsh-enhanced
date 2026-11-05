import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { AssistantPolicyService, principalPartitionScope } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const OWNER = 'lark/bot/tenant/owner'
const ALIAS = 'telegram/bot-tg/personal/alias'
const resource = { kind: 'automation' as const, id: 'worker' }

function agent(id: string): Agent {
  const sid = SessionId(id)
  const session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: 1, isSeeded: false,
    cwd: '/work/owner', agentPreset: 'primary' })
  return { id: sid, options: { provider: 'test-provider', model: 'test-model' }, session, inbox: createInboxStub(),
    status: 'idle', ctx: new Context(), cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
}

async function fixture(budget: { id: string; amount: number } | null = { id: 'reads', amount: 1 }) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-principal-budget-'))
  roots.push(root)
  const ctx = new Context()
  const databasePath = join(root, 'policy.sqlite')
  const service = new AssistantPolicyService(ctx, { databasePath,
    rules: [OWNER, ALIAS].map(principal => ({ id: `inspect-${principal}`, effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: 'primary', workspace: '/work/owner', principal },
      actions: ['inspect-work-items'], resource: { kind: 'automation' as const, id: 'worker' },
      context: { initiators: ['external' as const] }, ...(budget ? { budget } : {}) })),
    // 'subject' scope is agent:primary for both principals: the shared quota slice 1 documented.
    budgets: [{ id: 'reads', metric: 'reads', limit: 2, periodMs: 60_000, scope: 'subject' }] })
  const owner = agent('owner-session'), alias = agent('alias-session')
  service.bindInitiator(owner, 'external', OWNER)
  service.bindInitiator(alias, 'external', ALIAS)
  return { ctx, service, owner, alias, databasePath }
}

test('a principal-partitioned charge never spends the shared rule scope used by the owner', async () => {
  const f = await fixture()
  const forAlias = (key: string) => f.service.authorizeAgentForPrincipal(f.alias, 'inspect-work-items', resource,
    { idempotencyKey: key, principal: ALIAS })
  expect(forAlias('alias-1')).toMatchObject({ effect: 'allow', budgetPrincipal: ALIAS, budget: { id: 'reads', amount: 1 } })
  expect(forAlias('alias-1')).toMatchObject({ effect: 'allow', budgetPrincipal: ALIAS })
  expect(forAlias('alias-2')).toMatchObject({ effect: 'allow', budgetPrincipal: ALIAS })
  // Bounded: the alias partition has the rule's own limit.
  expect(forAlias('alias-3')).toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })
  expect(forAlias('alias-3')).not.toHaveProperty('budgetPrincipal')

  // The owner still has its full quota in the unpartitioned scope.
  const forOwner = (key: string) => f.service.authorizeAgent(f.owner, 'inspect-work-items', resource, { idempotencyKey: key })
  expect(forOwner('owner-1')).toMatchObject({ effect: 'allow' })
  expect(forOwner('owner-1')).not.toHaveProperty('budgetPrincipal')
  expect(forOwner('owner-2')).toMatchObject({ effect: 'allow' })
  expect(forOwner('owner-3')).toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })

  const database = new DatabaseSync(f.databasePath, { readOnly: true })
  const scopes = database.prepare('SELECT DISTINCT scope FROM budget_reservations ORDER BY scope').all().map(row => row.scope)
  database.close()
  expect(scopes).toEqual(['agent:primary', principalPartitionScope('agent:primary', ALIAS)].sort())
  await f.ctx.fiber.restart()
})

test('the partition principal must be the principal bound to the Agent', async () => {
  const f = await fixture()
  for (const principal of [OWNER, '', 'x'.repeat(257), `${ALIAS}\n`, undefined as unknown as string]) {
    expect(f.service.authorizeAgentForPrincipal(f.alias, 'inspect-work-items', resource, { idempotencyKey: 'k', principal }))
      .toMatchObject({ effect: 'deny', reasonCode: 'budget-principal-mismatch' })
  }
  const unbound = agent('unbound-session')
  // An unbound Agent is a foreground subject without principal: the rule itself
  // does not match, so the denial reason is the one authorizeAgent returns.
  expect(f.service.authorizeAgentForPrincipal(unbound, 'inspect-work-items', resource, { idempotencyKey: 'k', principal: ALIAS }))
    .toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
  expect(f.service.authorizeAgentForPrincipal(undefined, 'inspect-work-items', resource, { idempotencyKey: 'k', principal: ALIAS }))
    .toMatchObject({ effect: 'deny', reasonCode: 'missing-agent' })
  // Mismatches charge nothing.
  expect(f.service.authorizeAgentForPrincipal(f.alias, 'inspect-work-items', resource, { idempotencyKey: 'a', principal: ALIAS }).effect).toBe('allow')
  expect(f.service.authorizeAgentForPrincipal(f.alias, 'inspect-work-items', resource, { idempotencyKey: 'b', principal: ALIAS }).effect).toBe('allow')
  expect(f.service.authorizeAgentForPrincipal(f.alias, 'inspect-work-items', resource, { idempotencyKey: 'c', principal: ALIAS }).effect).toBe('deny')
  await f.ctx.fiber.restart()
})

test('an unbudgeted allow is returned without budgetPrincipal; idempotency is still required when budgeted', async () => {
  const unbudgeted = await fixture(null)
  expect(unbudgeted.service.authorizeAgentForPrincipal(unbudgeted.alias, 'inspect-work-items', resource, { principal: ALIAS }))
    .toEqual({ effect: 'allow', reasonCode: 'rule-allow', ruleId: `inspect-${ALIAS}` })
  await unbudgeted.ctx.fiber.restart()
  const budgeted = await fixture()
  expect(budgeted.service.authorizeAgentForPrincipal(budgeted.alias, 'inspect-work-items', resource, { principal: ALIAS }))
    .toMatchObject({ effect: 'deny', reasonCode: 'budget-idempotency-required' })
  await budgeted.ctx.fiber.restart()
})

test('authorizeAgentForPrincipal evaluates exactly like authorizeAgent; denials are audited and charge nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-principal-parity-'))
  roots.push(root)
  const ctx = new Context()
  const databasePath = join(root, 'policy.sqlite')
  const service = new AssistantPolicyService(ctx, { databasePath, rules: [
    { id: 'budgeted', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/owner' },
      actions: ['read-budgeted'], resource: { kind: 'automation', id: 'worker' }, context: { initiators: ['external'] },
      budget: { id: 'reads', amount: 1 } },
    { id: 'free', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/owner' },
      actions: ['read-free'], resource: { kind: 'automation', id: 'worker' }, context: { initiators: ['external'] } },
    { id: 'blocked', effect: 'deny', subject: { kind: 'agent', id: 'primary', workspace: '/work/owner' },
      actions: ['read-blocked'], resource: { kind: 'automation', id: 'worker' } },
    { id: 'owner-only', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/owner', principal: OWNER },
      actions: ['read-owner'], resource: { kind: 'automation', id: 'worker' }, context: { initiators: ['external'] },
      budget: { id: 'reads', amount: 1 } },
    { id: 'background-only', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/owner' },
      actions: ['read-background'], resource: { kind: 'automation', id: 'worker' }, context: { initiators: ['background'] },
      budget: { id: 'reads', amount: 1 } },
  ], budgets: [{ id: 'reads', metric: 'reads', limit: 100, periodMs: 60_000, scope: 'global' }] })
  const alias = agent('alias-session'), twin = agent('twin-session')
  service.bindInitiator(alias, 'external', ALIAS)
  service.bindInitiator(twin, 'external', ALIAS)
  const strip = <T extends { budgetPrincipal?: string }>({ budgetPrincipal: _ignored, ...rest }: T) => rest
  let key = 0
  for (const action of ['read-budgeted', 'read-free', 'read-blocked', 'read-owner', 'read-background', 'read-unknown']) {
    const expected = service.authorizeAgent(twin, action, resource, { idempotencyKey: `twin-${key}` })
    const actual = service.authorizeAgentForPrincipal(alias, action, resource, { idempotencyKey: `alias-${key++}`, principal: ALIAS })
    expect(strip(actual), action).toEqual(expected)
    expect(actual.budgetPrincipal, action).toBe(expected.effect === 'allow' && expected.budget !== undefined ? ALIAS : undefined)
  }
  // Emergency stop wins over a principal mismatch, exactly as for authorizeAgent.
  service.setEmergencyStop({ enabled: true, actor: 'test', reason: 'parity' })
  expect(service.authorizeAgentForPrincipal(alias, 'read-budgeted', resource, { idempotencyKey: 'stop', principal: OWNER }))
    .toEqual(service.authorizeAgent(twin, 'read-budgeted', resource, { idempotencyKey: 'stop-twin' }))
  service.setEmergencyStop({ enabled: false, actor: 'test', reason: 'parity' })

  const database = new DatabaseSync(databasePath, { readOnly: true })
  const charged = () => (database.prepare('SELECT COUNT(*) AS count FROM budget_reservations WHERE scope = ?')
    .get(principalPartitionScope('global', ALIAS)) as { count: number }).count
  const audits = () => (database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE reason_code = 'budget-principal-mismatch'")
    .get() as { count: number }).count
  // Only the one budgeted allow above was charged to the alias partition.
  expect(charged()).toBe(1)
  expect(service.authorizeAgentForPrincipal(alias, 'read-budgeted', resource, { idempotencyKey: 'mismatch', principal: OWNER }))
    .toMatchObject({ effect: 'deny', reasonCode: 'budget-principal-mismatch' })
  expect(audits()).toBe(1)
  expect(charged()).toBe(1)
  database.close()
  await ctx.fiber.restart()
})
