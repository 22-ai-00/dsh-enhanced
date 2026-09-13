import type { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import { DshDeliveryRuntime } from '../src/agent-runtime.js'
import type { ConversationBinding, InboundEnvelope } from '../src/types.js'

const binding: ConversationBinding = {
  id: 'binding-1', conversation: { channel: 'test', account: 'account', tenant: 'tenant', kind: 'dm', chat: 'chat' },
  principal: { channel: 'test', account: 'account', tenant: 'tenant', user: 'owner' }, workspace: '/tmp', agentPreset: 'standard',
  sessionId: 'delivery-cold-session', generation: 1, policyRef: 'policy-1', status: 'active', createdAt: 1, updatedAt: 1, version: 1,
}

const envelope: InboundEnvelope = {
  channel: 'test', account: 'account', eventId: 'event-1', occurredAt: 1, principal: binding.principal,
  conversation: binding.conversation, kind: 'text', text: 'continue the old session',
}

function unsupportedError(): Error {
  const error = new Error('untrusted persistence payload')
  error.name = 'SessionFormatUnsupportedError'
  return error
}

function runtime(replyCommand: ReturnType<typeof vi.fn>) {
  const resume = vi.fn(async () => { throw unsupportedError() })
  const lease = { signal: new AbortController().signal, dispatch: vi.fn(), close: vi.fn(), assert: vi.fn() }
  const sessionLeases = {
    open: vi.fn(() => lease), assert: lease.assert, resume,
  }
  const llm = { resolveCallConfig: vi.fn() }
  const ctx = {
    get: (name: string) => name === 'agents' || name === 'sessions' ? {} : name === 'llm' ? llm : undefined,
    logger: { warn: vi.fn() },
  } as unknown as Context
  const options = {
    sessionLeases, workspace: binding.workspace, agentPreset: binding.agentPreset, policyRef: binding.policyRef,
    provider: 'provider', model: 'model', maxOutputTokens: 100, maxAutoContinuationTurns: 0, goalContinuationTimeoutMs: 0,
    maxTextBytes: 1_000, permissionPickerTtlMs: 1_000, modelPickerTtlMs: 1_000,
    getAgentPresets: () => undefined, getModelSelection: () => undefined,
    clearStaleModelReasoningEffort: () => ({ applied: false }), imageMaterializer: { materialize: async () => [] },
    isInboundAuthorized: () => true, isPermissionController: () => false, isOwnerFeedbackController: () => false,
    authorizeOwnerPreferenceFeedback: () => undefined, dispatchPreferenceFeedback: async () => 'recorded',
    replyCompletedPreferenceTurn: () => 'recorded', dispatchObjectiveFeedback: async () => ({ status: 'recorded' }),
    dispatchWorkflowCommand: async () => 'recorded', dispatchLearningCommand: async () => 'forbidden',
    authorizePermissionReply: () => true, beginModelCommand: () => 1, commitModelCommand: () => ({ applied: false }),
    progress: async () => {}, prepareForegroundTaskAcceptance: () => undefined, completeForegroundTaskAcceptance: async () => {}, replyCommand,
  }
  return { runtime: new DshDeliveryRuntime(ctx, {} as never, options as never), resume, replyCommand, llm }
}

test('dead-letters an unsupported cold session after one owner reply without requesting a model', async () => {
  const replyCommand = vi.fn()
  const fixture = runtime(replyCommand)

  await expect(fixture.runtime.process(binding, envelope, new AbortController().signal, undefined, vi.fn())).resolves.toEqual({
    outcome: 'not-processed', failureCode: 'session-format-unsupported', retryable: false,
  })

  expect(fixture.resume).toHaveBeenCalledTimes(1)
  expect(fixture.llm.resolveCallConfig).not.toHaveBeenCalled()
  expect(replyCommand).toHaveBeenCalledTimes(1)
  expect(replyCommand).toHaveBeenCalledWith(binding, envelope.eventId, {
    text: '旧会话格式无法由当前 Host 恢复，记录已保留。请使用 /new 开启会话。', format: 'plain',
  })
})

test('keeps the unsupported-session diagnostic retryable until the durable reply path succeeds', async () => {
  const replyCommand = vi.fn()
    .mockImplementationOnce(() => { throw new Error('outbox write unavailable') })
  const fixture = runtime(replyCommand)

  await expect(fixture.runtime.process(binding, envelope, new AbortController().signal, undefined, vi.fn())).resolves.toEqual({
    outcome: 'not-processed', failureCode: 'session-format-unsupported-notice-failed', retryable: true,
  })
  await expect(fixture.runtime.process(binding, envelope, new AbortController().signal, undefined, vi.fn())).resolves.toEqual({
    outcome: 'not-processed', failureCode: 'session-format-unsupported', retryable: false,
  })

  expect(fixture.resume).toHaveBeenCalledTimes(2)
  expect(replyCommand).toHaveBeenCalledTimes(2)
  expect(replyCommand.mock.calls[1]).toEqual([binding, envelope.eventId, {
    text: '旧会话格式无法由当前 Host 恢复，记录已保留。请使用 /new 开启会话。', format: 'plain',
  }])
})
