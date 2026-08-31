import { describe, expect, test } from 'vitest'
import {
  classifyNaturalPreferenceDirective,
  feedbackSignalInput,
  isOneShotPreferenceRequest,
  parseNaturalPreferenceCorrection,
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
    const parsed = parseFeedbackCommand(rawInput)
    expect(parsed.kind).toBe('signals')
    expect(parsed.kind === 'signals'
      ? parsed.selections.map(({ interpretationTrust: _interpretationTrust, ...selection }) => selection)
      : []).toEqual(selections)
  })

  test('marks direct key/value feedback explicit while derived response feedback remains typed', () => {
    expect(parseFeedbackCommand('language zh-CN')).toMatchObject({
      kind: 'signals', selections: [{ interpretationTrust: 'explicit-selection' }],
    })
    expect(parseFeedbackCommand('too-long')).toMatchObject({
      kind: 'signals',
      selections: [
        { interpretationTrust: 'typed-feedback' },
        { interpretationTrust: 'typed-feedback' },
      ],
    })
  })

  test('recognizes only closed whole-message natural corrections', () => {
    expect(parseNaturalPreferenceCorrection('以后简短一点。')).toMatchObject({
      preferenceKey: 'response.verbosity', candidateValue: 'concise',
      interpretationTrust: 'explicit-selection',
    })
    expect(parseNaturalPreferenceCorrection('from now on, respond in Chinese')).toMatchObject({
      preferenceKey: 'response.language', candidateValue: 'zh-CN',
    })
    expect(parseNaturalPreferenceCorrection('answer in chinese')).toBeUndefined()
    expect(parseNaturalPreferenceCorrection('请用英文回答')).toBeUndefined()
    expect(isOneShotPreferenceRequest('answer in chinese')).toBe(true)
    expect(isOneShotPreferenceRequest('请用英文回答。')).toBe(true)
    expect(isOneShotPreferenceRequest('Please answer in Chinese')).toBe(true)
    expect(isOneShotPreferenceRequest('please respond in English')).toBe(true)
    expect(isOneShotPreferenceRequest('Please be concise.')).toBe(true)
    expect(isOneShotPreferenceRequest('Please use more bullet points.')).toBe(true)
    expect(isOneShotPreferenceRequest('Could you please answer in Chinese?')).toBe(true)
    expect(isOneShotPreferenceRequest('麻烦用英文回答')).toBe(true)
    expect(isOneShotPreferenceRequest('请回答得简短一点')).toBe(true)
    expect(isOneShotPreferenceRequest('这次请用中文回答')).toBe(true)
    expect(isOneShotPreferenceRequest('本次回答简短些')).toBe(true)
    expect(isOneShotPreferenceRequest('this time, answer in Chinese')).toBe(true)
    expect(isOneShotPreferenceRequest('for this response be concise')).toBe(true)
    expect(isOneShotPreferenceRequest('from now on, respond in Chinese')).toBe(false)
    expect(isOneShotPreferenceRequest('always answer in English')).toBe(false)
    expect(isOneShotPreferenceRequest('麻烦以后用英文回答')).toBe(false)
    expect(isOneShotPreferenceRequest('他说“这次请用中文回答”')).toBe(false)
    expect(isOneShotPreferenceRequest('背景\nthis time, answer in Chinese')).toBe(false)
    expect(isOneShotPreferenceRequest('`this time, answer in Chinese`')).toBe(false)
    expect(parseNaturalPreferenceCorrection('他说“以后简短一点”')).toBeUndefined()
    expect(parseNaturalPreferenceCorrection('背景很多\n以后简短一点')).toBeUndefined()
    expect(parseNaturalPreferenceCorrection('`以后简短一点`')).toBeUndefined()
  })

  test.each([
    ['麻烦以后用英文回答', 'response.language', 'en'],
    ['从现在起用英文回复', 'response.language', 'en'],
    ['from now on answer in Chinese', 'response.language', 'zh-CN'],
    ['In the future, please be more concise', 'response.verbosity', 'concise'],
  ] as const)(
    'classifies a supported durable whole-message directive %j as one exact selection',
    (text, preferenceKey, candidateValue) => {
      expect(classifyNaturalPreferenceDirective(text)).toMatchObject({
        kind: 'durable-exact-selection',
        selection: { preferenceKey, candidateValue, interpretationTrust: 'explicit-selection' },
      })
    },
  )

  test.each([
    '请用中文回答这个问题',
    'Can you answer this in Chinese',
    'Could you please respond to this question in English?',
    '本次请用英文回复这个问题',
  ])('classifies a supported per-turn whole-message directive %j without learning it', text => {
    expect(classifyNaturalPreferenceDirective(text)).toEqual({ kind: 'one-turn-directive' })
  })

  test.each([
    '请用中文回答这个问题，并总结这份文档',
    'Can you answer this in Chinese and summarize the document?',
    'from now on answer in Chinese, then summarize this document',
    'Please be concise and summarize the document',
    '请简短一点，并总结这份文档',
    '他说“以后请用英文回答”但我不同意',
    '请用西班牙语回答',
  ])('keeps mixed or unsupported directive-like content %j out of behavior observation', text => {
    expect(classifyNaturalPreferenceDirective(text)).toEqual({
      kind: 'ambiguous-or-unsupported-directive',
    })
  })

  test.each([
    '请总结这份文档',
    'Can you summarize this document?',
    '以后我们再讨论这个问题',
    'Explain why the sky appears blue.',
  ])('admits only confidently ordinary task content %j to behavior observation', text => {
    expect(classifyNaturalPreferenceDirective(text)).toEqual({ kind: 'ordinary-content' })
  })

  test.each(['achieved', 'partial', 'not-achieved'] as const)(
    'parses explicit per-run objective status %j separately from preferences',
    objectiveStatus => {
      expect(parseFeedbackCommand(objectiveStatus)).toEqual({ kind: 'objective', objectiveStatus })
    },
  )

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
    }, {
      occurredAt: 456,
      principalLineage: { principalRecordId: 'principal-record-1', principalVersion: 4 },
      admissionCursor: { epoch: '0123456789abcdef0123456789abcdef', sequence: 7 },
    })

    expect(event).toMatchObject({
      scope: { workspace: '/work/exact', preset: 'primary' },
      principalLineage: { principalRecordId: 'principal-record-1', principalVersion: 4 },
      admissionCursor: { epoch: '0123456789abcdef0123456789abcdef', sequence: 7 },
      preferenceKey: 'response.structure',
      candidateValue: 'bullets',
      stance: 'support',
      actorTrust: 'owner-authenticated',
      interpretationTrust: 'typed-feedback',
      source: 'direct-owner-feedback',
      occurredAt: 456,
    })
    expect(event.idempotencyKey).toMatch(/^delivery-feedback-v3:[a-f0-9]{64}$/u)
    expect(event.idempotencyKey).not.toContain('event-private')
    expect(event.idempotencyKey).not.toContain('owner-private')
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.scope)).toBe(true)
    expect(feedbackSignalInput(binding, envelope, {
      preferenceKey: 'response.structure', candidateValue: 'bullets',
    }, {
      occurredAt: 789,
      principalLineage: { principalRecordId: 'principal-record-1', principalVersion: 4 },
      admissionCursor: { epoch: '0123456789abcdef0123456789abcdef', sequence: 7 },
    }).idempotencyKey).toBe(event.idempotencyKey)
    expect(feedbackSignalInput(binding, envelope, {
      preferenceKey: 'response.structure', candidateValue: 'bullets',
    }, {
      occurredAt: 789,
      principalLineage: { principalRecordId: 'principal-record-1', principalVersion: 5 },
      admissionCursor: { epoch: '0123456789abcdef0123456789abcdef', sequence: 7 },
    }).idempotencyKey).not.toBe(event.idempotencyKey)
  })
})
