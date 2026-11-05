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
  expect(f.service.authorizeAgentForPrincipal(unbound, 'inspect-work-items', resource, { idempotencyKey: 'k', principal: ALIAS }))
    .toMatchObject({ effect: 'deny', reasonCode: 'budget-principal-mismatch' })
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
