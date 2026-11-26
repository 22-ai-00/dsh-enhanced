import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { compilePolicy, evaluatePolicy } from '../src/evaluator.ts'
import {
  AUTONOMY_BUDGET_TIERS,
  AssistantPolicyService,
  buildWebOwnerDreamingPolicyGrants,
  buildWebOwnerGrowthPolicyGrants,
  buildWebOwnerMemoryPolicyGrants,
  mergeAssistantPolicyGrants,
  webOwnerBudgetIds,
  webOwnerGrowthRuleIds,
  webOwnerGrowthUsageRuleIds,
} from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const scope = {
  profile: 'web',
  workspace: '/work/owner-web',
  principalId: 'web/web/local/operator',
  ownerRouteId: 'web-owner-1234567890abcdef',
}

describe('web-owner autonomy policy grant helpers', () => {
  test('builds memory, dreaming, and growth bundles that satisfy real AssistantPolicyService & budget isolation', async () => {
    const ids = webOwnerBudgetIds(scope.profile)
    const memory = buildWebOwnerMemoryPolicyGrants({
      ...scope,
      learningAuthorityId: 'web-memory-extract-web',
      reviewAuthorityId: 'web-memory-review-web',
      adoptionAuthorityId: 'web-memory-adopt-web',
      learningBudgetId: ids.memoryLearning,
      scanBudgetId: ids.memoryScan,
      dailyExtractionBudget: 10,
    })
    const dreaming = buildWebOwnerDreamingPolicyGrants({
      ...scope,
      dreamingBudgetId: ids.dreaming,
      dailyDreamBudget: 2,
    })
    const growth = buildWebOwnerGrowthPolicyGrants({
      ...scope,
      preset: 'standard',
      growthBudgetId: ids.growthReviews,
      dailyGrowthBudget: 5,
      usageLearning: true,
      scanBudgetId: ids.growthScan,
    })

    const merged = mergeAssistantPolicyGrants(undefined, {
      rules: [...memory.rules, ...dreaming.rules, ...growth.rules],
      budgets: [...memory.budgets, ...dreaming.budgets, ...growth.budgets],
    })
    const compiled = compilePolicy(merged.rules)

    // UsageLearningRuntime reconciles as OWNER='assistant-growth-usage' and executes usage-scan-* / usage-* jobs.
    expect(evaluatePolicy(compiled, {
      subject: { kind: 'background', id: 'assistant-growth-usage', workspace: scope.workspace, principal: scope.principalId },
      action: 'reconcile',
      resource: { kind: 'automation', id: 'usage-scan-abcd1234' },
      context: { initiator: 'background' },
    }).effect).toBe('allow')
    expect(evaluatePolicy(compiled, {
      subject: { kind: 'background', id: 'assistant-growth-usage', workspace: scope.workspace, principal: scope.principalId },
      action: 'reconcile',
      resource: { kind: 'automation', id: 'usage-deadbeef' },
      context: { initiator: 'background' },
    }).effect).toBe('allow')
    expect(evaluatePolicy(compiled, {
      subject: { kind: 'background', id: 'usage-deadbeef', workspace: scope.workspace, principal: scope.principalId },
      action: 'execute',
      resource: { kind: 'automation', id: 'usage-deadbeef' },
      context: { initiator: 'background' },
    }).effect).toBe('allow')
    expect(evaluatePolicy(compiled, {
      subject: { kind: 'agent', id: 'standard', workspace: scope.workspace, principal: scope.principalId },
      action: 'draft',
      resource: { kind: 'evolution', id: 'verified-workflows' },
      context: { initiator: 'background' },
    }).effect).toBe('allow')
    expect(evaluatePolicy(compiled, {
      subject: { kind: 'agent', id: 'standard', workspace: scope.workspace, principal: scope.principalId },
      action: 'execute',
      resource: { kind: 'tool', id: 'growth_propose_skill_candidate' },
      context: { initiator: 'background' },
    }).effect).toBe('allow')
    expect(webOwnerGrowthRuleIds('web').length).toBeGreaterThan(webOwnerGrowthUsageRuleIds('web').length)

    // Memory actions require exact background subject + workspace + principal + authorityId resource.
    expect(evaluatePolicy(compiled, {
      subject: { kind: 'background', id: 'assistant-memory-learning', workspace: scope.workspace, principal: scope.principalId },
      action: 'extract',
      resource: { kind: 'memory', id: 'learning:web-memory-extract-web' },
      context: { initiator: 'background' },
    }).effect).toBe('allow')

    expect(evaluatePolicy(compiled, {
      subject: { kind: 'background', id: 'assistant-memory-learning', workspace: scope.workspace, principal: 'web/other/local/operator' },
      action: 'extract',
      resource: { kind: 'memory', id: 'learning:web-memory-extract-web' },
      context: { initiator: 'background' },
    }).effect).toBe('deny')

    // Foreground dream owner lifecycle actions.
    for (const action of ['dream.acknowledge', 'dream.validate', 'dream.reject', 'dream.retire']) {
      expect(evaluatePolicy(compiled, {
        subject: { kind: 'external', id: scope.principalId, workspace: scope.workspace, principal: scope.principalId },
        action,
        resource: { kind: 'evolution', id: 'assistant-dreaming:idea:idea-1' },
        context: { initiator: 'foreground' },
      }).effect).toBe('allow')

      // Background subject cannot forge owner dream transitions.
      expect(evaluatePolicy(compiled, {
        subject: { kind: 'background', id: 'assistant-dreaming', workspace: scope.workspace, principal: scope.principalId },
        action,
        resource: { kind: 'evolution', id: 'assistant-dreaming:idea:idea-1' },
        context: { initiator: 'background' },
      }).effect).toBe('deny')
    }

    // Real AssistantPolicyService runtime verifies budget exhaustion, idempotency, and emergency stop.
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-web-grants-'))
    roots.push(root)
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: join(root, 'policy.sqlite'),
      rules: merged.rules,
      budgets: merged.budgets,
    })

    const dreamAutomationId = `dsh-ray-assistant-dreaming:${scope.principalId}:${scope.ownerRouteId}`
    const dreamBg = { kind: 'background' as const, id: dreamAutomationId, workspace: scope.workspace, principal: scope.principalId }
    expect(service.getBudgetConfig(ids.dreaming)).toMatchObject({ metric: 'automation-runs', limit: 2, scope: 'subject' })

    const r1 = service.reserve({ budgetId: ids.dreaming, subject: dreamBg, amount: 1, idempotencyKey: 'dream:1' })
    expect(r1).toMatchObject({ status: 'reserved', remaining: 1, replayed: false })
    expect(service.reserve({ budgetId: ids.dreaming, subject: dreamBg, amount: 1, idempotencyKey: 'dream:1' }))
      .toMatchObject({ status: 'reserved', reservationId: r1.reservationId, replayed: true })
    expect(service.reserve({ budgetId: ids.dreaming, subject: dreamBg, amount: 1, idempotencyKey: 'dream:2' }))
      .toMatchObject({ status: 'reserved', remaining: 0, replayed: false })
    expect(() => service.reserve({ budgetId: ids.dreaming, subject: dreamBg, amount: 1, idempotencyKey: 'dream:3' }))
      .toThrow(/budget|exceed|exhaust/iu)

    expect(service.authorize({
      subject: { kind: 'external', id: scope.principalId, workspace: scope.workspace, principal: scope.principalId },
      action: 'dream.validate',
      resource: { kind: 'evolution', id: 'assistant-dreaming:idea:idea-42' },
      context: { initiator: 'foreground' },
    }).effect).toBe('allow')

    service.setEmergencyStop({ enabled: true, actor: 'operator', reason: 'owner halted' })
    expect(service.authorize({
      subject: { kind: 'external', id: scope.principalId, workspace: scope.workspace, principal: scope.principalId },
      action: 'dream.validate',
      resource: { kind: 'evolution', id: 'assistant-dreaming:idea:idea-42' },
      context: { initiator: 'foreground' },
    })).toMatchObject({ effect: 'deny', reasonCode: 'emergency-stop' })

    await ctx.fiber.restart()
  })

  test('mergeAssistantPolicyGrants preserves custom rules/budgets, updates idempotently, and removes disabled grants', () => {
    const customRule = {
      id: 'custom-deny-rm',
      effect: 'deny' as const,
      actions: ['execute'],
      resource: { kind: 'tool' as const, id: 'shell' },
    }
    const customBudget = {
      id: 'custom-tokens',
      metric: 'tokens' as const,
      limit: 5_000,
      periodMs: 86_400_000,
      scope: 'workspace' as const,
    }
    const ids = webOwnerBudgetIds(scope.profile)
    const initial = buildWebOwnerDreamingPolicyGrants({
      ...scope,
      dreamingBudgetId: ids.dreaming,
      dailyDreamBudget: AUTONOMY_BUDGET_TIERS.conservative.dreamingDailyBudget,
    })

    const firstMerge = mergeAssistantPolicyGrants(
      { rules: [customRule], budgets: [customBudget] },
      { rules: initial.rules, budgets: initial.budgets },
    )
    expect(firstMerge.rules.map(r => r.id)).toEqual(['custom-deny-rm', ...initial.managedRuleIds])
    expect(firstMerge.budgets.map(b => b.id)).toEqual(['custom-tokens', ids.dreaming])

    const updated = buildWebOwnerDreamingPolicyGrants({
      ...scope,
      dreamingBudgetId: ids.dreaming,
      dailyDreamBudget: AUTONOMY_BUDGET_TIERS.balanced.dreamingDailyBudget,
    })
    const secondMerge = mergeAssistantPolicyGrants(firstMerge, {
      rules: updated.rules,
      budgets: updated.budgets,
    })
    expect(secondMerge.rules).toHaveLength(firstMerge.rules.length)
    expect(secondMerge.budgets).toEqual([
      customBudget,
      expect.objectContaining({ id: ids.dreaming, limit: 6 }),
    ])

    const removed = mergeAssistantPolicyGrants(secondMerge, {
      removeRuleIds: initial.managedRuleIds,
      removeBudgetIds: initial.managedBudgetIds,
    })
    expect(removed.rules).toEqual([customRule])
    expect(removed.budgets).toEqual([customBudget])
  })

  test('fails closed on colliding authorityIds, invalid limits, or malformed existing rules', () => {
    const ids = webOwnerBudgetIds(scope.profile)
    expect(() => buildWebOwnerMemoryPolicyGrants({
      ...scope,
      learningAuthorityId: scope.ownerRouteId,
      reviewAuthorityId: 'review-1',
      adoptionAuthorityId: 'adopt-1',
      learningBudgetId: ids.memoryLearning,
      scanBudgetId: ids.memoryScan,
      dailyExtractionBudget: 10,
    })).toThrow(/distinct/)

    expect(() => buildWebOwnerDreamingPolicyGrants({
      ...scope,
      dreamingBudgetId: ids.dreaming,
      dailyDreamBudget: 0,
    })).toThrow(/between 1/)

    expect(() => buildWebOwnerGrowthPolicyGrants({
      ...scope,
      growthBudgetId: ids.growthReviews,
      dailyGrowthBudget: 5,
      usageLearning: true,
    })).toThrow(/scanBudgetId/)

    expect(() => mergeAssistantPolicyGrants({ rules: 'invalid' as unknown as [] }, {}))
      .toThrow(/existing rules must be an array/)
  })
})
