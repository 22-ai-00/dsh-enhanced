import { Context } from '@deepseek-ai/cordis'
import type {
  HostAutomationDefinition,
  HostAutomationExecutor,
  HostAutomationExecutorInput,
  SystemAutomationReconcileInput,
} from '@dsh-enhanced/assistant-automations'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantDreamingService } from '../src/runtime.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class FakeAutomations {
  readonly executors: HostAutomationExecutor[] = []
  lastDefinition: HostAutomationDefinition | undefined

  registerHostExecutor(executor: HostAutomationExecutor): () => void {
    this.executors.push(executor)
    return () => {
      const idx = this.executors.indexOf(executor)
      if (idx >= 0) this.executors.splice(idx, 1)
    }
  }

  reconcileSystem(input: SystemAutomationReconcileInput): unknown {
    this.lastDefinition = input.definition as HostAutomationDefinition
    return Object.freeze({ id: input.automationId, status: input.desiredStatus ?? 'active' })
  }
}

describe('assistant-dreaming onIdeaChange host seam', () => {
  test('returns a safe no-op unsubscribe when dreaming is disabled', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dream-host-seam-disabled-'))
    roots.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('assistantAutomations' as never, new FakeAutomations() as never)
    ctx.provide('assistantDelivery' as never, {
      validateOwnerRoute: () => Object.freeze({}),
      resolveOwnerRoute: () => Object.freeze({}),
      enqueueOwnerNotification: () => Object.freeze({}),
    } as never)
    ctx.provide('assistantEvaluation' as never, {
      canonicalHostScope: (input: { workspace: string; preset: string }) => Object.freeze({ ...input }),
      listTrustedTaskLearningProjections: () => Object.freeze({ items: Object.freeze([]) }),
    } as never)
    ctx.provide('assistantGoals' as never, { inspectOwnerGoals: () => [] } as never)
    ctx.provide('assistantSkills' as never, { inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [] } as never)
    ctx.provide('agents' as never, {} as never)
    ctx.provide('sessions' as never, { flush: async () => {} } as never)
    ctx.provide('tools' as never, { schemas: () => [] } as never)

    await ctx.plugin(AssistantDreamingService, { databasePath: join(workspace, 'dream.sqlite') } as never)
    const unsub = ctx.assistantDreaming.onIdeaChange(() => {})
    expect(typeof unsub).toBe('function')
    unsub()
  })

  test('fires on idea creation, acknowledge, validate, reject, and retire with error isolation and cleanup', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dream-host-seam-'))
    roots.push(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    const automations = new FakeAutomations()
    const item = {
      situation: 'sample failure',
      objective: { status: 'not-achieved' },
      receipt: { objective: { status: 'not-achieved', occurredAt: Date.now() - 86_400_000 } },
    }
    const evidenceRef = acceptanceDigest(item).slice(0, 64)
    let ideaSummaryIndex = 0

    ctx.provide('assistantAutomations' as never, automations as never)
    ctx.provide('assistantDelivery' as never, {
      validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) =>
        Object.freeze({
          authorityId: input.authorityId,
          authorityHash: 'auth-hash-1',
          principalId: input.principalId,
          workspace: input.workspace,
          agentPreset: input.agentPreset,
          principalRecordId: 'principal-record',
          principalVersion: 1,
        }),
      resolveOwnerRoute: () => Object.freeze({ binding: { sessionId: 'owner-session' } }),
      enqueueOwnerNotification: () => Object.freeze({ id: 'out-1' }),
    } as never)
    ctx.provide('assistantEvaluation' as never, {
      canonicalHostScope: (input: { workspace: string; preset: string }) => Object.freeze({ ...input }),
      listTrustedTaskLearningProjections: () => Object.freeze({ items: Object.freeze([item]) }),
    } as never)
    ctx.provide('assistantGoals' as never, { inspectOwnerGoals: () => [] } as never)
    ctx.provide('assistantSkills' as never, { inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [] } as never)
    ctx.provide('assistantPolicy' as never, {
      getEmergencyStop: () => ({ enabled: false }),
      getBudgetConfig: () => ({ metric: 'automation-runs', limit: 10 }),
      evaluate: () => ({ effect: 'allow', reasonCode: 'ok' }),
      authorize: () => ({ effect: 'allow', reasonCode: 'ok' }),
    } as never)
    ctx.provide('agents' as never, {
      create: async (createOptions: { setup: (agentCtx: unknown, agent: unknown) => Promise<void> }) => {
        let submit: { execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> } | undefined
        const agentCtx = {
          effect: (callback: () => unknown) => { callback(); return () => {} },
          on: () => () => {},
          tools: {
            register: (definition: unknown) => { submit = definition as typeof submit },
            restrict: () => {},
            schemas: () => [{ name: 'dream_submit_ideas' }],
            guard: () => {},
          },
        }
        const agent = {
          session: {
            id: 'dream-session',
            header: { cwd: workspace, agentPreset: 'primary' },
            snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
          },
          model: { current: () => ({ provider: 'test-provider', model: 'test-model' }), select: () => {} },
          followup: () => {},
          whenIdle: async () => {
            ideaSummaryIndex += 1
            await submit!.execute({
              ideas: [{ summary: `Dream idea ${ideaSummaryIndex}`, detail: 'bounded detail', evidence_refs: [evidenceRef] }],
            }, { signal: new AbortController().signal })
          },
          cancel: () => {},
        }
        await createOptions.setup(agentCtx, agent)
        return { agent, dispose: async () => {} }
      },
    } as never)
    ctx.provide('sessions' as never, { flush: async () => {} } as never)
    ctx.provide('tools' as never, { schemas: () => [] } as never)

    await ctx.plugin(AssistantDreamingService, {
      enabled: true,
      scope: { workspace, preset: 'primary', principalId: 'owner-1', ownerRouteId: 'route-1' },
      databasePath: join(workspace, 'dream.sqlite'),
      provider: 'test-provider',
      model: 'test-model',
      budgetId: 'dream-budget',
      budgetAmount: 1,
      baseIntervalMs: 3_600_000,
      runProbabilityPpm: 1_000_000,
      lotteryWindow: 500_000,
    } as never)

    let changes = 0
    const unsubThrow = ctx.assistantDreaming.onIdeaChange(() => {
      throw new Error('listener boom')
    })
    const unsub = ctx.assistantDreaming.onIdeaChange(() => {
      changes += 1
    })

    const runSlot = async (occurrenceId: string) => {
      const def = automations.lastDefinition!
      const input: HostAutomationExecutorInput = {
        occurrenceId,
        automationId: `dsh-enhanced-assistant-dreaming:${'lane'.padEnd(40, '0')}`,
        definitionHash: 'a'.repeat(64),
        executionMode: 'production',
        targetScope: def.execution.targetScope,
        principal: def.principal,
        ownerRouteId: def.execution.ownerRouteId,
        activationNonce: def.execution.activationNonce,
        catalogDigest: def.execution.catalogDigest,
        signal: new AbortController().signal,
      }
      return automations.executors[0]!.execute(input)
    }

    // 1. Creation via dream slot
    expect((await runSlot('occ-1')).outcome).toBe('succeeded')
    expect(changes).toBe(1)

    const firstIdea = ctx.assistantDreaming.inspectIdeas()[0]!

    // 2. Acknowledge -> 3. Validate -> 4. Retire
    ctx.assistantDreaming.acknowledgeIdea({ ideaId: firstIdea.id, principalId: 'owner-1' })
    expect(changes).toBe(2)

    ctx.assistantDreaming.transitionIdea({ ideaId: firstIdea.id, transition: 'validate', principalId: 'owner-1' })
    expect(changes).toBe(3)

    ctx.assistantDreaming.transitionIdea({ ideaId: firstIdea.id, transition: 'retire', principalId: 'owner-1' })
    expect(changes).toBe(4)

    // 5. Create second idea and reject
    expect((await runSlot('occ-2')).outcome).toBe('succeeded')
    expect(changes).toBe(5)
    const secondIdea = ctx.assistantDreaming.inspectIdeas().find(idea => idea.id !== firstIdea.id)!
    ctx.assistantDreaming.transitionIdea({ ideaId: secondIdea.id, transition: 'reject', principalId: 'owner-1' })
    expect(changes).toBe(6)

    // Idempotent unsubscribe stops notifications
    unsub()
    unsub()
    unsubThrow()
    expect((await runSlot('occ-3')).outcome).toBe('succeeded')
    expect(changes).toBe(6)

    // Retire clears listeners and rejects new subscriptions
    ctx.assistantDreaming.retire()
    expect(() => ctx.assistantDreaming.onIdeaChange(() => {})).toThrow(/not active/i)
  })
})
