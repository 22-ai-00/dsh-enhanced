import { describe, expect, test } from 'vitest'
import {
  MODEL_PROPOSAL_PROTECTED_PLUGINS,
  OWNER_REPAIR_PROTECTED_PLUGINS,
  assertProtectedSetsConsistent,
} from '../src/plugin-protection.ts'

describe('protected plugin trust boundaries', () => {
  test('the owner-repair set is a strict subset of the model-proposal set', () => {
    expect(() => assertProtectedSetsConsistent()).not.toThrow()
    for (const name of OWNER_REPAIR_PROTECTED_PLUGINS) {
      expect(MODEL_PROPOSAL_PROTECTED_PLUGINS.has(name)).toBe(true)
    }
    expect(MODEL_PROPOSAL_PROTECTED_PLUGINS.size).toBe(23)
    expect(OWNER_REPAIR_PROTECTED_PLUGINS.size).toBe(12)
  })

  test('governance machinery is model-proposal protected but stays owner-repairable', () => {
    for (const name of ['assistant-growth-driver', 'assistant-recovery', 'owner-console', 'assistant-actions',
      'assistant-work-items', 'assistant-goals', 'event-triggers', 'assistant-heartbeat',
      'assistant-proactive', 'assistant-memory-learning', 'assistant-evolution']) {
      expect(MODEL_PROPOSAL_PROTECTED_PLUGINS.has(name)).toBe(true)
      expect(OWNER_REPAIR_PROTECTED_PLUGINS.has(name)).toBe(false)
    }
  })

  test('the immutable safety roots stay out of owner repair', () => {
    for (const name of ['plugin-control-plane', 'assistant-policy', 'assistant-verifier', 'credentials-keychain',
      'assistant-isolation', 'assistant-web-owner']) {
      expect(OWNER_REPAIR_PROTECTED_PLUGINS.has(name)).toBe(true)
    }
  })
})
