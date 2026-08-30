import { describe, expect, test } from 'vitest'
import {
  feedbackSignalInput,
  parseFeedbackCommand,
} from '../src/feedback-command.ts'
import type { ConversationBinding, InboundEnvelope } from '../src/types.ts'

describe('Delivery feedback command grammar', () => {
  test.each([
    [' helpful ', [{ preferenceKey: 'feedback.response', candidateValue: 'helpful' }]],
    ['too-long', [
      { preferenceKey: 'feedback.response', candidateValue: 'too-long' },
      { preferenceKey: 'response.verbosity', candidateValue: 'concise' },
    ]],
    ['too-short', [
      { preferenceKey: 'feedback.response', candidateValue: 'too-short' },
      { preferenceKey: 'response.verbosity', candidateValue: 'detailed' },
    ]],
    ['verbosity concise', [{ preferenceKey: 'response.verbosity', candidateValue: 'concise' }]],
    ['structure\tbullets', [{ preferenceKey: 'response.structure', candidateValue: 'bullets' }]],
    ['language zh-CN', [{ preferenceKey: 'response.language', candidateValue: 'zh-CN' }]],
    ['explanation result-first', [
      { preferenceKey: 'response.explanation_depth', candidateValue: 'result-first' },
    ]],
    ['suggestions low', [{ preferenceKey: 'suggestion.frequency', candidateValue: 'low' }]],
    ['ranking evidence', [{ preferenceKey: 'recommendation.ranking', candidateValue: 'evidence' }]],
  ] as const)('maps only catalog syntax %j', (rawInput, selections) => {
    expect(parseFeedbackCommand(rawInput)).toEqual({ kind: 'signals', selections })
  })

  test.each([
    '',
    'unknown',
    'helpful extra',
    'verbosity',
    'verbosity tiny',
    'language zh_CN',
    'ranking evidence extra',
  ])('rejects arbitrary or incomplete input %j', rawInput => {
    expect(parseFeedbackCommand(rawInput)).toEqual({ kind: 'invalid' })
  })

  test('builds an immutable, scope-bound, hashed downstream event', () => {
    const binding: ConversationBinding = {
      id: 'binding-private',
      conversation: { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm', chat: 'chat' },
      principal: { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner-private' },
      workspace: '/work/exact',
      agentPreset: 'primary',
      sessionId: 'session-private',
      generation: 2,
      policyRef: 'owner-dm',
      status: 'active',
      createdAt: 1,
      updatedAt: 2,
      version: 3,
    }
    const envelope: InboundEnvelope = {
      channel: 'lark',
      account: 'bot',
      eventId: 'event-private',
      occurredAt: 123,
      principal: binding.principal,
      conversation: binding.conversation,
      kind: 'command',
      text: '/feedback structure bullets',
    }
    const event = feedbackSignalInput(binding, envelope, {
      preferenceKey: 'response.structure',
      candidateValue: 'bullets',
    }, 456)

    expect(event).toMatchObject({
      scope: { workspace: '/work/exact', preset: 'primary' },
      preferenceKey: 'response.structure',
      candidateValue: 'bullets',
      stance: 'support',
      actorTrust: 'owner-authenticated',
      interpretationTrust: 'typed-feedback',
      source: 'direct-owner-feedback',
      occurredAt: 456,
    })
    expect(event.idempotencyKey).toMatch(/^delivery-feedback-v1:[a-f0-9]{64}$/u)
    expect(event.idempotencyKey).not.toContain('event-private')
    expect(event.idempotencyKey).not.toContain('owner-private')
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.scope)).toBe(true)
    expect(feedbackSignalInput(binding, envelope, {
      preferenceKey: 'response.structure', candidateValue: 'bullets',
    }, 789).idempotencyKey).toBe(event.idempotencyKey)
  })
})
