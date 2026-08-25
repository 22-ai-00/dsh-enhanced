import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { registerLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import {
  AssistantPolicyService,
  AUTO_REVIEW_APPROVAL_REASON,
} from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CodingSubscriptionAdapter,
  Config as CodingSubscriptionConfig,
} from '../plugins/coding-subscription-provider/src/index.ts'
import type { AutomationRunnerInput } from '../plugins/assistant-automations/src/coordinator.ts'
import { DshAutomationRunner } from '../plugins/assistant-automations/src/runner.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function sse(events: Array<Record<string, unknown> | '[DONE]'>): Response {
  const source = events
    .map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(source, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function functionCallResponse(): Response {
  const item = {
    type: 'function_call',
    call_id: 'call-exact-42',
    name: 'approved_tool',
    arguments: '{"value":"from-codex"}',
  }
  return sse([
    { type: 'response.output_item.done', item },
    {
      type: 'response.completed',
      response: {
        id: 'resp-tool-call',
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    },
  ])
}

function finalTextResponse(): Response {
  const item = {
    type: 'message',
    id: 'msg-final-1',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Codex used the approved tool exactly once.', annotations: [] }],
  }
  return sse([
    {
      type: 'response.output_item.added',
      item: { type: 'message', id: item.id, role: 'assistant', content: [] },
    },
    {
      type: 'response.output_text.delta',
      delta: 'Codex used the approved tool exactly once.',
    },
    { type: 'response.output_item.done', item },
    {
      type: 'response.completed',
      response: {
        id: 'resp-final',
        usage: { input_tokens: 18, output_tokens: 8, total_tokens: 26 },
      },
    },
  ])
}

function automationInput(workspace: string): AutomationRunnerInput {
  return {
    automation: {
      id: 'codex-direct-e2e',
      definition: {
        name: 'Codex direct Agent Loop',
        prompt: 'Call approved_tool once, then report its result.',
        schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' },
        workspace,
        agentPreset: 'primary',
        provider: 'codex-subscription',
        model: 'default',
        allowedTools: ['approved_tool'],
        timeoutMs: 10_000,
        maxOutputTokens: 256,
        maxToolCalls: 1,
        misfire: { kind: 'latest' },
        overlap: 'skip',
        retrySafety: 'never',
        maxRetries: 0,
        principal: 'owner:test',
      },
      status: 'active',
      nextRunAt: undefined,
      createdAt: 1,
      updatedAt: 1,
      version: 1,
    },
    occurrence: {
      id: 'occ-codex-direct',
      automationId: 'codex-direct-e2e',
      triggerKind: 'manual',
      triggerKey: 'test',
      scheduledAt: 1,
      status: 'pending',
      dryRun: false,
      createdAt: 1,
      updatedAt: 1,
    },
    task: {
      id: 'task-codex-direct',
      occurrenceId: 'occ-codex-direct',
      automationId: 'codex-direct-e2e',
      status: 'running',
      cancelRequested: false,
      attemptCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    sessionId: 'codex-direct-agent-loop-session',
    signal: new AbortController().signal,
  }
}

describe('Codex direct private Responses Agent Loop', () => {
  test('replays the exact call_id through one policy-approved tool execution and completes the second turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-direct-agent-loop-'))
    roots.push(root)
    const ctx = new Context()
    let adapter: CodingSubscriptionAdapter | undefined

    try {
      await mountAgentLoopTestDependencies(ctx, {
        systemPrompt: { persona: '' },
        tools: { mode: 'native' },
      })
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        rules: [{
          id: 'allow-approved-tool-once',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: root },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'approved_tool' },
          context: { initiators: ['background'] },
        }],
      })

      let toolExecutions = 0
      ctx.tools.register({
        name: 'approved_tool',
        description: 'Return one deterministic value for the Codex direct E2E test.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { echoed: { type: 'string' } },
            required: ['echoed'],
            additionalProperties: false,
          },
          render: (_arguments, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(argumentsValue) {
          toolExecutions += 1
          return { echoed: (argumentsValue as { value: string }).value }
        },
      })

      const approvalRequests: Array<{
        sessionId: string
        toolName: string
        callId: string | undefined
        reason: string | undefined
        arguments: string | undefined
      }> = []
      ctx.on('approval/request', (request) => {
        if (String(request.agent.session.id) !== 'codex-direct-agent-loop-session'
          || request.toolName !== 'approved_tool'
          || String(request.callId) !== 'call-exact-42') {
          return Promise.resolve('rejected')
        }
        const call = request.agent.session.events.findLast(event => event.type === 'tool/call'
          && String(event.data.callId) === 'call-exact-42')
        approvalRequests.push({
          sessionId: String(request.agent.session.id),
          toolName: request.toolName,
          callId: request.callId === undefined ? undefined : String(request.callId),
          reason: request.reason,
          arguments: call?.type === 'tool/call' ? call.data.arguments : undefined,
        })
        return Promise.resolve('allowed-once')
      })

      const submittedBodies: Array<Record<string, unknown>> = []
      const requestResponses = vi.fn(async (body: string, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false)
        submittedBodies.push(JSON.parse(body) as Record<string, unknown>)
        return submittedBodies.length === 1 ? functionCallResponse() : finalTextResponse()
      })
      const forbiddenCliCall = () => {
        throw new Error('the Codex direct E2E test must never invoke a local CLI seam')
      }
      const config = CodingSubscriptionConfig()
      config.cwd = root
      config.timeoutMs = 10_000
      config.codex.transport = 'direct-responses'
      config.codex.directModel = 'gpt-codex-direct-e2e'
      adapter = new CodingSubscriptionAdapter(config, {
        codexCredentials: { requestResponses },
        liveSessions: ctx.sessions,
        runText: forbiddenCliCall,
        verifyAuth: forbiddenCliCall,
        discoverCodexModels: forbiddenCliCall,
      })
      ctx.llm.registerAdapter(['codex-subscription'], adapter)
      registerLlmRouteCapability(ctx.llm, {
        provider: 'codex-subscription',
        toolCalls: 'native',
      })
      await ctx.plugin(AgentLoop, { agents: [] })

      const runner = new DshAutomationRunner(ctx, ctx.assistantPolicy, {
        allowUnbudgetedExecution: true,
      })
      const result = await runner.run(automationInput(root))

      expect(result).toMatchObject({
        outcome: 'succeeded',
        output: 'Codex used the approved tool exactly once.',
      })
      expect(requestResponses).toHaveBeenCalledTimes(2)
      expect(approvalRequests).toEqual([{
        sessionId: 'codex-direct-agent-loop-session',
        toolName: 'approved_tool',
        callId: 'call-exact-42',
        reason: AUTO_REVIEW_APPROVAL_REASON,
        arguments: '{"value":"from-codex"}',
      }])
      expect(toolExecutions).toBe(1)

      const secondInput = submittedBodies[1]?.input as Array<Record<string, unknown>>
      const replayedCall = secondInput.find(item => item.type === 'function_call')
      const replayedResult = secondInput.find(item => item.type === 'function_call_output')
      expect(replayedCall).toEqual({
        type: 'function_call',
        call_id: 'call-exact-42',
        name: 'approved_tool',
        arguments: '{"value":"from-codex"}',
      })
      expect(replayedResult).toMatchObject({
        type: 'function_call_output',
        call_id: 'call-exact-42',
        output: expect.stringContaining('from-codex'),
      })
      expect(submittedBodies[1]).not.toHaveProperty('max_output_tokens')

      const policyExecutions = ctx.assistantPolicy.queryAudit({ limit: 100 }).filter(event =>
        event.action === 'execute'
        && event.outcome === 'allowed'
        && (event.details as { callId?: string } | null)?.callId === 'call-exact-42')
      expect(policyExecutions).toHaveLength(1)
    } finally {
      adapter?.shutdown()
      await ctx.fiber.restart()
    }
  })
})
