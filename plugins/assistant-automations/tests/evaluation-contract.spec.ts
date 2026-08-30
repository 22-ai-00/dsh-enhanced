import { EvaluationStore, EvaluationStoreError } from '@dsh-enhanced/assistant-evaluation'
import { describe, expect, test } from 'vitest'
import { AutomationStore } from '../src/store.ts'

const now = Date.parse('2026-08-30T04:00:00.000Z')

function definition() {
  return {
    name: 'Evaluation contract', prompt: 'Run the bounded task.',
    schedule: { kind: 'at', at: '2027-08-30T04:00:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:lark:123',
  }
}

describe('assistant-evaluation contract', () => {
  test('accepts and exactly replays the immutable terminal outbox payload', () => {
    const automations = new AutomationStore({ path: ':memory:', now: () => now })
    const evaluation = new EvaluationStore({ path: ':memory:', now: () => now + 1 })
    try {
      automations.createApproved({
        automationId: 'contract-run', idempotencyKey: 'create:contract-run', definition: definition(),
      })
      automations.createManual({ automationId: 'contract-run', requestId: 'one', dryRun: false })
      const duty = automations.acquireDuty({ ownerId: 'owner-a', now, leaseMs: 10_000 })
      const claimed = automations.claimNextTask({
        ownerId: 'owner-a', fencingToken: duty.fencingToken, now, leaseMs: 5_000,
      })!
      automations.startTask({
        taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: now + 1, leaseMs: 5_000, sessionId: 'session-contract',
      })
      automations.completeTask({
        taskId: claimed.id, ownerId: 'owner-a', fencingToken: duty.fencingToken,
        now: now + 20, outcome: 'succeeded', sessionId: 'session-contract',
        outputPreview: 'done', usage: { inputTokens: 9, outputTokens: 3 },
      })

      const pending = automations.listPendingEvaluations(10)
      expect(pending).toHaveLength(1)
      const first = evaluation.append(pending[0]!.payload)
      expect(evaluation.append(pending[0]!.payload)).toEqual(first)
      expect(evaluation.query({ scope: { workspace: '/work/alpha', preset: 'primary' }, limit: 10 }))
        .toEqual([expect.objectContaining({
          id: first.id, situation: 'automation:contract-run', executionStatus: 'succeeded',
          objectiveStatus: 'unknown', deliveryStatus: 'not-required', trust: 'trusted',
        })])
      expect(() => evaluation.append({ ...pending[0]!.payload, objectiveStatus: 'partial' }))
        .toThrowError(expect.objectContaining<Partial<EvaluationStoreError>>({ code: 'idempotency-conflict' }))
    } finally {
      evaluation.close()
      automations.close()
    }
  })
})
