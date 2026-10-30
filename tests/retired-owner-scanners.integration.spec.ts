import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { AssistantDeliveryService } from '../plugins/assistant-delivery/src/service.ts'
import type { DeliveryStore } from '../plugins/assistant-delivery/src/store.ts'
import { AssistantAutomationsService } from '../plugins/assistant-automations/src/service.ts'
import { normalizeConfig } from '../plugins/assistant-growth-driver/src/config.ts'
import { UsageLearningRuntime, type UsageReviewInput, type UsageReviewResult } from '../plugins/assistant-growth-driver/src/usage-runtime.ts'

const scannerOwner = 'assistant-growth-usage'
const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner-a' }
const other = { ...principal, user: 'owner-b' }
const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'chat-a' }
const otherConversation = { ...conversation, chat: 'chat-b' }
const principalId = 'lark/bot/tenant/owner-a'

function histories(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return ['automation_occurrences', 'automation_tasks', 'automation_attempts', 'automation_runs']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])
  } finally { db.close() }
}

async function mount(root: string) {
  const ctx = new Context()
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [{ id: 'scanner-reconcile', effect: 'allow',
      subject: { kind: 'background', id: scannerOwner, workspace: root, principal: principalId },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' },
      context: { initiators: ['background'] } }],
  })
  const authority = { id: 'route-a', principal, conversation, workspace: root,
    agentPreset: 'primary', policyRef: 'owner', minimumGeneration: 1 }
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    ownerRoutes: [authority, { ...authority, id: 'route-b', principal: other, conversation: otherConversation }],
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
    schedulerEnabled: false, reconcileIntervalMs: 0,
  })
  await ctx.plugin(AssistantEvaluationService, {
    databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0,
  })
  const delivery = ctx.assistantDelivery
  const store = (delivery as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const review = vi.fn<(input: UsageReviewInput) => Promise<UsageReviewResult>>(async () => 'reviewed')
  const config = normalizeConfig({ enabled: true,
    scope: { workspace: root, preset: 'primary', principalId, ownerRouteId: authority.id },
    budgetId: 'review-budget', budgetAmount: 1,
    usageLearning: { enabled: true, scanBudgetId: 'scan-budget', scanBudgetAmount: 1,
      databasePath: join(root, 'usage.sqlite') },
  })
  let runtime: UsageLearningRuntime | undefined
  const start = async () => {
    const fiber = ctx.plugin({
      name: 'test-owner-scanner-lifecycle',
      inject: ['assistantDelivery', 'assistantAutomations', 'assistantEvaluation'],
      apply(scope: Context) {
        scope.effect(() => {
          runtime = new UsageLearningRuntime(config, { delivery: scope.assistantDelivery,
            automations: scope.assistantAutomations, evaluation: scope.assistantEvaluation, review })
          runtime.start()
          const owned = runtime
          return () => owned.close()
        })
      },
    })
    await fiber
    return fiber
  }
  const bind = (selected: typeof principal, selectedConversation: typeof conversation, sessionId: string) => {
    store.handoffOwner(selected)
    return store.createBinding({ principal: selected, conversation: selectedConversation,
      workspace: root, agentPreset: 'primary', policyRef: 'owner', sessionId })
  }
  return { ctx, delivery, store, start, bind, review, get runtime() { return runtime! },
    automations: ctx.assistantAutomations,
    scope: { authorityId: authority.id, principalId, workspace: root, agentPreset: 'primary' } }
}

it('keeps a revoked owner scanner retired across real service restart and A→B→A while Delivery stays usable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retired-owner-scanner-')))
  let current: Awaited<ReturnType<typeof mount>> | undefined
  try {
    const first = current = await mount(root)
    first.bind(principal, conversation, 'owner-a-session-1')
    await first.start()
    const [identity] = first.automations.listSystemOwned({ owner: scannerOwner })
    expect(identity?.automationStatus).toBe('active')
    const before = histories(join(root, 'automations.sqlite'))

    first.bind(other, otherConversation, 'owner-b-session')
    expect(first.delivery.inspectOwnerRouteState(first.scope).status).toBe('revoked')
    first.runtime.scan()
    const retirement = first.automations.inspectSystemOwnedRetirement({ owner: scannerOwner, automationId: identity!.automationId })
    expect(retirement).toMatchObject({ owner: scannerOwner, automationId: identity!.automationId,
      reason: 'owner-revoked', automationStatus: 'paused' })
    expect(first.automations.inspectSystemOwned({ owner: scannerOwner, automationId: identity!.automationId }).automationStatus).toBe('paused')
    expect(first.delivery.validateOwnerRoute({ ...first.scope, authorityId: 'route-b', principalId: 'lark/bot/tenant/owner-b' }).principalId)
      .toBe('lark/bot/tenant/owner-b')
    expect(first.review).not.toHaveBeenCalled()
    await first.ctx.fiber.restart()
    current = undefined

    const second = current = await mount(root)
    second.bind(principal, conversation, 'owner-a-session-2')
    expect(second.delivery.inspectOwnerRouteState(second.scope).status).toBe('active')
    await second.start()
    second.runtime.scan()
    await second.automations.tick()
    await second.automations.whenIdle()
    expect(second.automations.inspectSystemOwnedRetirement({ owner: scannerOwner, automationId: identity!.automationId }))
      .toEqual(retirement)
    expect(second.automations.listSystemOwned({ owner: scannerOwner })).toMatchObject([
      { automationId: identity!.automationId, automationStatus: 'paused' },
    ])
    expect(second.review).not.toHaveBeenCalled()
    expect(histories(join(root, 'automations.sqlite'))).toEqual(before)
    expect(second.delivery.validateOwnerRoute(second.scope).principalId).toBe(principalId)
  } finally {
    await current?.ctx.fiber.restart()
    await rm(root, { recursive: true, force: true })
  }
})
