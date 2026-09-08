import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantProactiveService, Config, name, version } from '../src/index.ts'
import type { OpportunityInput, OpportunityProfile } from '../src/types.ts'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
const profile: OpportunityProfile & { mode: 'execute' } = { id: 'report', mode: 'execute', expectedBenefit: 10, successPpm: 1_000_000, executionCost: 1, interruptionCost: 0, possibleLoss: 0, minimumUtility: 1, mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 60_000, maxDecisionsPerGoal: 10, maxExecutionsPerGoal: 2, maxRemindersPerGoal: 0 }
const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', preset: 'default' }
const opportunity = (): OpportunityInput => ({ waitId: 'wait', profileId: 'report', scope, goalId: 'goal', sessionId: 'session', definitionDigest: 'definition', objective: 'Update the report', nativeGoalId: 'native', nativeRevision: 1, ownerRouteId: 'route', sourceDigest: 'source-digest', sourceId: 'event-triggers:report', event: { id: 'event', sequence: 1, digest: 'digest', occurredAt: Date.now() }, expiresAt: Date.now() + 60_000 })
async function harness() {
  const ctx = new Context(); contexts.push(ctx)
  const agent = { id: 'agent', session: { header: { cwd: scope.workspace, agentPreset: scope.preset } } } as unknown as Agent
  let principalVersion = 1; let ownerTurn = true; let allowed = true
  const principal = () => ({ principalId: scope.principalId, principalLineage: { principalRecordId: scope.principalRecordId, principalVersion }, scope: { workspace: scope.workspace, preset: scope.preset } })
  ctx.provide('agents' as never, { get: () => agent } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: () => ownerTurn ? principal() : undefined } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: () => ({ effect: allowed ? 'allow' : 'deny' }) } as never)
  await ctx.plugin(AssistantProactiveService, { databasePath: ':memory:', profiles: [profile] })
  return { ctx, agent, service: ctx.assistantProactive, revoke: () => { principalVersion++ }, deny: () => { allowed = false }, background: () => { ownerTurn = false } }
}
describe('assistant-proactive bundle and owner access', () => {
  it('loads and disposes independently without optional execution services', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(name).toBe('dsh-enhanced-assistant-proactive'); expect(version).toBe(manifest.version)
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(AssistantProactiveService, { databasePath: ':memory:' })
    const service = ctx.assistantProactive
    expect(() => service.assertProfile('missing')).toThrow('configured active')
    await ctx.fiber.dispose(); expect(() => service.assertProfile('missing')).toThrow('configured active')
  })
  it('requires live owner identity, policy and a human turn for feedback, and does not transfer records across lineage changes', async () => {
    const f = await harness(); const decision = f.service.evaluate(opportunity()).decision
    expect(f.service.inspect(f.agent)).toHaveLength(1)
    expect(() => f.service.inspect({ ...f.agent } as Agent)).toThrow('exact live agent')
    f.background(); expect(() => f.service.feedback(f.agent, decision.id, 'rejected')).toThrow('current authenticated owner turn')
    f.revoke(); expect(f.service.inspect(f.agent)).toEqual([])
    f.deny(); expect(() => f.service.inspect(f.agent)).toThrow('policy denied')
  })
  it('owner rejection suppresses future execution and acceptance never grants new authority', async () => {
    const f = await harness(); const input = opportunity(); const first = f.service.evaluate(input)
    expect(f.service.feedback(f.agent, first.decision.id, 'rejected')).toMatchObject({ feedback: 'rejected' })
    expect(f.service.evaluate({ ...input, event: { ...input.event, id: 'second', sequence: 2, digest: 'second-digest' } })).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
  })
  it('configuration rejects unsupported reminder delivery and invalid probability estimates', () => {
    expect(() => Config({ profiles: [{ ...profile, mode: 'remind' }] } as never)).toThrow()
    expect(() => Config({ profiles: [{ ...profile, successPpm: 1_000_001 }] })).toThrow()
  })
})
