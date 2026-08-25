import { describe, expect, test } from 'vitest'
import {
  AUTOMATION_RUN_BUDGET_METRIC,
  assertAutomationRunBudget,
} from '../src/runner.ts'

describe('fixed-cost budget declaration for one unattended run', () => {
  test('accepts only the trusted automation-runs metric', () => {
    const policy = {
      getBudgetConfig: (id: string) => id === 'daily-runs'
        ? { id, metric: 'automation-runs', limit: 10, periodMs: 86_400_000, scope: 'workspace' as const }
        : undefined,
    }

    expect(AUTOMATION_RUN_BUDGET_METRIC).toBe('automation-runs')
    expect(assertAutomationRunBudget(policy, 'daily-runs')).toMatchObject({
      id: 'daily-runs', metric: 'automation-runs', limit: 10,
    })
  })

  test('fails closed for a missing or incompatible-unit budget before reservation', () => {
    expect(() => assertAutomationRunBudget({ getBudgetConfig: () => undefined }, 'missing'))
      .toThrow(/budget.*not configured/i)
    expect(() => assertAutomationRunBudget({
      getBudgetConfig: id => ({ id, metric: 'tokens', limit: 10_000, periodMs: 86_400_000, scope: 'workspace' }),
    }, 'token-budget')).toThrow(/automation-runs.*tokens|tokens.*automation-runs/i)
  })
})
