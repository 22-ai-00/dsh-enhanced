import type { SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import type { OwnerTaskFailureReference } from '../../src/owner-task-gap-types.js'
import { controlPlaneDigest } from '../../src/store.js'

export function sourceGrowthRunFixture(reference: OwnerTaskFailureReference, now: number,
  model: SourceGrowthRunBinding['model'] = { provider: 'growth-provider', model: 'growth-override' },
  modelOrigin: SourceGrowthRunBinding['modelOrigin'] = 'explicit-growth-override'): SourceGrowthRunBinding {
  return {
    protocol: 'assistant-growth/source-run/v1', runId: 'usage-source-create', intentDigest: '1'.repeat(64),
    configDigest: '2'.repeat(64), ownerDigest: controlPlaneDigest(reference.owner),
    source: { outcomeId: reference.outcomeId, projection: reference.projection, sourceDigest: reference.sourceDigest },
    model, modelOrigin,
    budget: { budgetId: 'growth-model-budget', amount: 2, maxModelCalls: 3, maxToolCalls: 5,
      maxOutputTokens: 4000, maxDurationMs: 30_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'usage-source-create',
      definitionHash: '3'.repeat(64), occurrenceId: 'growth-native-occurrence' },
    sessionId: 'growth-real-session', toolContractDigest: '4'.repeat(64), executionContractDigest: '5'.repeat(64),
    createdAt: now - 1_000, generationDeadlineAt: now + 20_000, expiresAt: now + 600_000,
  }
}
