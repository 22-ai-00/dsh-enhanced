import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import {
  AssistantPolicyService,
  AUTO_REVIEW_APPROVAL_REASON,
} from '@dsh-enhanced/assistant-policy'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CodingSubscriptionAdapter,
  Config as CodingSubscriptionConfig,
} from '../plugins/coding-subscription-provider/src/index.ts'
import { DSH_TOOL_CALL_PROTOCOL } from '../plugins/coding-subscription-provider/src/prompt.ts'
import type {
  CliInvocation,
  ProviderId,
} from '../plugins/coding-subscription-provider/src/providers.ts'
import type { AutomationRunnerInput } from '../plugins/assistant-automations/src/coordinator.ts'
import { DshAutomationRunner } from '../plugins/assistant-automations/src/runner.ts'
import { createAgentLoopRequestAttestor } from '../packages/llm-route-capabilities/src/index.ts'

const routes = [
  { provider: 'codex-subscription', cli: 'codex' },
  { provider: 'claude-subscription', cli: 'claude' },
  { provider: 'cursor-subscription', cli: 'cursor' },
  { provider: 'grok-subscription', cli: 'grok' },
] as const

type SubscriptionRoute = (typeof routes)[number]['provider']

const TEST_SKILL_NAME = 'route-proof-skill'
const TEST_SKILL_BODY = 'Route parity proof: after loading this skill, call approved_tool exactly once.'
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

interface SerializedBlock {
  readonly type: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: string
  readonly toolCallId?: string
  readonly isError?: boolean
  readonly content?: readonly SerializedBlock[]
}

interface DelegatedRequest {
  readonly instruction: string
  readonly conversation: readonly {
    readonly role: string
    readonly content: readonly SerializedBlock[]
  }[]
  readonly constraints: {
    readonly tools: {
      readonly available: readonly {
        readonly name: string
        readonly description: string
        readonly parameters: unknown
      }[]
    }
    readonly purpose: string | null
  }
}

interface ReplayObservation {
  readonly cli: ProviderId
  readonly toolName: 'skill' | 'approved_tool'
  readonly callId: string
  readonly resultCallId: string
  readonly resultContent: string
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function delegatedRequest(invocation: CliInvocation): DelegatedRequest {
  const prompt = invocation.prompt
  const start = prompt.indexOf('{')
  if (start < 0) throw new Error(`missing delegated JSON request for ${invocation.provider}`)
  return JSON.parse(prompt.slice(start)) as DelegatedRequest
}

function blocks(request: DelegatedRequest): readonly SerializedBlock[] {
  return request.conversation.flatMap(message => message.content)
}

function skillCatalogText(request: DelegatedRequest | undefined): string | undefined {
  return request?.conversation
    .flatMap(message => message.content)
    .find(block => block.type === 'text' && block.text?.includes('<available_skills>'))
    ?.text
}

function automationInput(
  workspace: string,
  provider: SubscriptionRoute,
  cli: ProviderId,
  overrides: Partial<AutomationRunnerInput['automation']['definition']> = {},
): AutomationRunnerInput {
  const id = `cli-agent-loop-${cli}`
  return {
    automation: {
      id,
      definition: {
        name: `${cli} CLI Agent Loop`,
        prompt: `Load ${TEST_SKILL_NAME}, follow it, then report the exact approved_tool result.`,
        schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' },
        workspace,
        agentPreset: 'primary',
        provider,
        model: 'default',
        allowedTools: ['skill', 'approved_tool', 'catalog_only_tool'],
        timeoutMs: 10_000,
        maxOutputTokens: 256,
        maxToolCalls: 2,
        misfire: { kind: 'latest' },
        overlap: 'skip',
        retrySafety: 'never',
        maxRetries: 0,
        principal: 'owner:test',
        ...overrides,
      },
      status: 'active',
      nextRunAt: undefined,
      createdAt: 1,
      updatedAt: 1,
      version: 1,
    },
    occurrence: {
      id: `occ-${id}`,
      automationId: id,
      triggerKind: 'manual',
      triggerKey: 'test',
      scheduledAt: 1,
      status: 'pending',
      dryRun: false,
      createdAt: 1,
      updatedAt: 1,
    },
    task: {
      id: `task-${id}`,
      occurrenceId: `occ-${id}`,
      automationId: id,
      status: 'running',
      cancelRequested: false,
      attemptCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    sessionId: `session-${id}`,
    signal: new AbortController().signal,
  }
}

describe('coding subscription CLI bridges through the real Agent Loop', () => {
  test('all four routes share DSH tools and Skills, load the same skill, execute a tool, and finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cli-agent-loop-'))
    roots.push(root)
    const ctx = new Context()
    let adapter: CodingSubscriptionAdapter | undefined

    try {
      await mountAgentLoopTestDependencies(ctx, {
        systemPrompt: { persona: '' },
        tools: { mode: 'native' },
      })
      await ctx.plugin(SkillRegistry)
      ctx.skills.register({
        name: TEST_SKILL_NAME,
        description: 'Proves that every subscription route receives the same DSH Skill catalog and loader.',
        source: 'runtime',
        content: TEST_SKILL_BODY,
      })
      await ctx.plugin(SkillTool)
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        rules: [
          {
            id: 'allow-skill-loader-on-every-model-route',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: root },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'skill' },
            context: { initiators: ['background'] },
          },
          {
            id: 'allow-approved-tool-on-every-model-route',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: root },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'approved_tool' },
            context: { initiators: ['background'] },
          },
        ],
      })

      const toolExecutions: string[] = []
      ctx.tools.register({
        name: 'approved_tool',
        description: 'Return one deterministic route value.',
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
          const value = (argumentsValue as { value: string }).value
          toolExecutions.push(value)
          return { echoed: value }
        },
      })
      let catalogOnlyExecutions = 0
      ctx.tools.register({
        name: 'catalog_only_tool',
        description: 'Remain visible to prove every route receives the same complete catalog.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          render: () => [],
        },
        async execute() {
          catalogOnlyExecutions += 1
          return {}
        },
      })

      const approvalRequests: Array<{
        sessionId: string
        toolName: string
        callId: string
        reason: string | undefined
      }> = []
      const expectedSessions = new Set(routes.map(route => `session-cli-agent-loop-${route.cli}`))
      ctx.on('approval/request', (request) => {
        const sessionId = String(request.agent.session.id)
        if (!expectedSessions.has(sessionId) || !['skill', 'approved_tool'].includes(request.toolName)) {
          return Promise.resolve('rejected')
        }
        approvalRequests.push({
          sessionId,
          toolName: request.toolName,
          callId: String(request.callId),
          reason: request.reason,
        })
        return Promise.resolve('allowed-once')
      })

      const requests = new Map<ProviderId, DelegatedRequest[]>()
      const replayedSkills: ReplayObservation[] = []
      const replayedTools: ReplayObservation[] = []
      const runText = vi.fn((invocation: CliInvocation) => {
        const request = delegatedRequest(invocation)
        const providerRequests = requests.get(invocation.provider) ?? []
        providerRequests.push(request)
        requests.set(invocation.provider, providerRequests)
        const transcript = blocks(request)
        const replayedSkillCall = transcript.find(block =>
          block.type === 'tool-call' && block.name === 'skill')
        const replayedSkillResult = transcript.find(block =>
          block.type === 'tool-result' && block.toolCallId === replayedSkillCall?.id)
        const replayedToolCall = transcript.find(block =>
          block.type === 'tool-call' && block.name === 'approved_tool')
        const replayedToolResult = transcript.find(block =>
          block.type === 'tool-result' && block.toolCallId === replayedToolCall?.id)

        return (async function* () {
          if (replayedSkillCall === undefined) {
            const response = JSON.stringify({
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{
                name: 'skill',
                arguments: { name: TEST_SKILL_NAME },
              }],
            })
            const split = Math.floor(response.length / 2)
            yield response.slice(0, split)
            yield response.slice(split)
            return
          }

          if (replayedSkillResult === undefined) throw new Error(`missing skill result for ${invocation.provider}`)
          const skillResultContent = JSON.stringify(replayedSkillResult.content)
          if (!skillResultContent.includes(`<skill_content name=\\"${TEST_SKILL_NAME}\\">`)
            || !skillResultContent.includes(TEST_SKILL_BODY)) {
            throw new Error(`missing loaded Skill content for ${invocation.provider}`)
          }

          if (replayedToolCall === undefined) {
            replayedSkills.push({
              cli: invocation.provider,
              toolName: 'skill',
              callId: replayedSkillCall.id!,
              resultCallId: replayedSkillResult.toolCallId!,
              resultContent: skillResultContent,
            })
            yield JSON.stringify({
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{
                name: 'approved_tool',
                arguments: { value: `from-${invocation.provider}` },
              }],
            })
            return
          }

          if (replayedToolResult === undefined) throw new Error(`missing approved tool result for ${invocation.provider}`)
          const toolResultContent = JSON.stringify(replayedToolResult.content)
          replayedTools.push({
            cli: invocation.provider,
            toolName: 'approved_tool',
            callId: replayedToolCall.id!,
            resultCallId: replayedToolResult.toolCallId!,
            resultContent: toolResultContent,
          })
          if (!toolResultContent.includes(`from-${invocation.provider}`)) {
            throw new Error(`missing executed tool result for ${invocation.provider}`)
          }
          yield `final-${invocation.provider}:`
          yield `from-${invocation.provider}`
        })()
      })
      const verifyAuth = vi.fn(async () => {})
      const config = CodingSubscriptionConfig()
      config.cwd = root
      config.timeoutMs = 10_000
      config.codex.transport = 'cli'
      config.claude.enabled = true
      config.cursor.enabled = true
      config.grok.enabled = true
      config.grok.userVerifiedSubscription = true
      adapter = new CodingSubscriptionAdapter(config, {
        liveSessions: ctx.sessions,
        runText,
        verifyAuth,
      })
      ctx.llm.registerAdapter(routes.map(route => route.provider), adapter)
      await ctx.plugin(AgentLoop, { agents: [] })

      const runner = new DshAutomationRunner(ctx, ctx.assistantPolicy, {
        allowUnbudgetedExecution: true,
      })
      for (const route of routes) {
        const result = await runner.run(automationInput(root, route.provider, route.cli))
        expect(result).toMatchObject({
          outcome: 'succeeded',
          output: `final-${route.cli}:from-${route.cli}`,
        })
      }

      expect(runText).toHaveBeenCalledTimes(routes.length * 3)
      expect(verifyAuth).toHaveBeenCalledTimes(routes.length * 3)
      expect(toolExecutions).toEqual(routes.map(route => `from-${route.cli}`))
      expect(catalogOnlyExecutions).toBe(0)

      const firstToolCatalog = requests.get(routes[0].cli)?.[0]?.constraints.tools.available
      expect(firstToolCatalog?.map(tool => tool.name).sort()).toEqual([
        'approved_tool',
        'catalog_only_tool',
        'skill',
      ])
      for (const route of routes) {
        const routeRequests = requests.get(route.cli)
        expect(routeRequests).toHaveLength(3)
        for (const request of routeRequests ?? []) {
          expect(request.constraints.tools.available).toEqual(firstToolCatalog)
        }
      }

      const skillCatalogs = routes.map(route => skillCatalogText(requests.get(route.cli)?.[0]))
      expect(skillCatalogs[0]).toContain(`<available_skills>\n- \`${TEST_SKILL_NAME}\`: `)
      expect(skillCatalogs[0]).toContain('Proves that every subscription route receives the same DSH Skill catalog')
      for (const catalog of skillCatalogs.slice(1)) expect(catalog).toBe(skillCatalogs[0])

      expect(replayedSkills).toHaveLength(routes.length)
      expect(replayedTools).toHaveLength(routes.length)
      expect(new Set(replayedSkills.map(observation => observation.resultContent)).size).toBe(1)
      const replayed = [...replayedSkills, ...replayedTools]
      for (const observation of replayed) {
        expect(observation.callId).toMatch(new RegExp(`^${observation.cli}-[0-9a-f-]{36}$`, 'u'))
        expect(observation.resultCallId).toBe(observation.callId)
        if (observation.toolName === 'skill') {
          expect(observation.resultContent).toContain(TEST_SKILL_BODY)
        } else {
          expect(observation.resultContent).toContain(`from-${observation.cli}`)
        }
      }
      expect(new Set(replayed.map(observation => observation.callId)).size).toBe(routes.length * 2)
      expect(approvalRequests).toHaveLength(routes.length * 2)
      expect(approvalRequests.every(request => request.reason === AUTO_REVIEW_APPROVAL_REASON)).toBe(true)
      for (const route of routes) {
        expect(approvalRequests
          .filter(request => request.sessionId === `session-cli-agent-loop-${route.cli}`)
          .map(request => request.toolName)
          .sort()).toEqual(['approved_tool', 'skill'])
      }
      expect(new Set(approvalRequests.map(request => request.callId))).toEqual(
        new Set(replayed.map(observation => observation.callId)),
      )

      const replayedIds = new Set(replayed.map(observation => observation.callId))
      const policyExecutions = ctx.assistantPolicy.queryAudit({ limit: 100 }).filter(event =>
        event.action === 'execute'
        && event.outcome === 'allowed'
        && replayedIds.has(String((event.details as { callId?: string } | null)?.callId)))
      expect(policyExecutions).toHaveLength(routes.length * 2)
    } finally {
      adapter?.shutdown()
      await ctx.fiber.restart()
    }
  })

  test('assigns unique Host ids to two bridged calls, executes them sequentially, and replays each result by id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cli-agent-loop-batch-'))
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
        rules: ['ordered_first', 'ordered_second'].map(name => ({
          id: `allow-${name}`,
          effect: 'allow' as const,
          subject: { kind: 'agent' as const, id: 'primary', workspace: root },
          actions: ['execute' as const],
          resource: { kind: 'tool' as const, id: name },
          context: { initiators: ['background' as const] },
        })),
      })
      const executionLifecycle: string[] = []
      for (const name of ['ordered_first', 'ordered_second'] as const) {
        ctx.tools.register({
          name,
          description: `Record the execution boundary for ${name}.`,
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
            executionLifecycle.push(`${name}:start`)
            if (name === 'ordered_first') {
              await new Promise<void>(resolve => setImmediate(resolve))
            }
            executionLifecycle.push(`${name}:end`)
            return { echoed: (argumentsValue as { value: string }).value }
          },
        })
      }

      const approvalCallIds: string[] = []
      ctx.on('approval/request', (request) => {
        if (String(request.agent.session.id) !== 'session-cli-agent-loop-codex'
          || !['ordered_first', 'ordered_second'].includes(request.toolName)) {
          return Promise.resolve('rejected')
        }
        approvalCallIds.push(String(request.callId))
        return Promise.resolve('allowed-once')
      })

      const requests: DelegatedRequest[] = []
      let replayedBatch: Array<{
        name: string
        callId: string
        resultCallId: string
        resultContent: string
      }> = []
      const runText = vi.fn((invocation: CliInvocation) => {
        const request = delegatedRequest(invocation)
        requests.push(request)
        const transcript = blocks(request)
        const toolCalls = transcript.filter(block => block.type === 'tool-call'
          && ['ordered_first', 'ordered_second'].includes(block.name ?? ''))

        return (async function* () {
          if (toolCalls.length === 0) {
            yield JSON.stringify({
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [
                { name: 'ordered_first', arguments: { value: 'first-result' } },
                { name: 'ordered_second', arguments: { value: 'second-result' } },
              ],
            })
            return
          }

          replayedBatch = toolCalls.map((call) => {
            const result = transcript.find(block => block.type === 'tool-result'
              && block.toolCallId === call.id)
            if (result === undefined) throw new Error(`missing result for ${String(call.id)}`)
            return {
              name: call.name!,
              callId: call.id!,
              resultCallId: result.toolCallId!,
              resultContent: JSON.stringify(result.content),
            }
          })
          yield 'ordered-batch-complete'
        })()
      })
      const verifyAuth = vi.fn(async () => {})
      const config = CodingSubscriptionConfig()
      config.cwd = root
      config.timeoutMs = 10_000
      config.codex.transport = 'cli'
      adapter = new CodingSubscriptionAdapter(config, {
        liveSessions: ctx.sessions,
        runText,
        verifyAuth,
      })
      ctx.llm.registerAdapter(['codex-subscription'], adapter)
      await ctx.plugin(AgentLoop, { agents: [] })

      const runner = new DshAutomationRunner(ctx, ctx.assistantPolicy, {
        allowUnbudgetedExecution: true,
      })
      const result = await runner.run(automationInput(root, 'codex-subscription', 'codex', {
        prompt: 'Call ordered_first and ordered_second together, then report both results.',
        allowedTools: ['ordered_first', 'ordered_second'],
        maxToolCalls: 2,
      }))

      expect(result).toMatchObject({ outcome: 'succeeded', output: 'ordered-batch-complete' })
      expect(runText).toHaveBeenCalledTimes(2)
      expect(verifyAuth).toHaveBeenCalledTimes(2)
      expect(requests).toHaveLength(2)
      expect(executionLifecycle).toEqual([
        'ordered_first:start',
        'ordered_first:end',
        'ordered_second:start',
        'ordered_second:end',
      ])
      expect(replayedBatch.map(item => item.name)).toEqual(['ordered_first', 'ordered_second'])
      expect(replayedBatch.map(item => item.resultContent)).toEqual([
        expect.stringContaining('first-result'),
        expect.stringContaining('second-result'),
      ])
      const callIds = replayedBatch.map(item => item.callId)
      expect(callIds).toHaveLength(2)
      expect(new Set(callIds).size).toBe(2)
      expect(callIds.every(callId => /^codex-[0-9a-f-]{36}$/u.test(callId))).toBe(true)
      expect(replayedBatch.map(item => item.resultCallId)).toEqual(callIds)
      expect(approvalCallIds).toEqual(callIds)
    } finally {
      adapter?.shutdown()
      await ctx.fiber.restart()
    }
  })

  test('returns a real ToolRuntime schema error to the next model turn before the tool body side effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cli-agent-loop-invalid-args-'))
    roots.push(root)
    const ctx = new Context()
    let adapter: CodingSubscriptionAdapter | undefined

    try {
      await mountAgentLoopTestDependencies(ctx, {
        systemPrompt: { persona: '' },
        tools: { mode: 'native' },
      })
      await ctx.plugin(SkillRegistry)
      ctx.skills.register({
        name: TEST_SKILL_NAME,
        description: 'Must not be loaded when the model supplies schema-invalid arguments.',
        source: 'runtime',
        content: TEST_SKILL_BODY,
      })
      await ctx.plugin(SkillTool)
      const skillBodySideEffect = vi.spyOn(ctx.skills, 'list')
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        rules: [{
          id: 'allow-invalid-skill-probe-through-policy',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: root },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'skill' },
          context: { initiators: ['background'] },
        }],
      })

      const approvalCallIds: string[] = []
      ctx.on('approval/request', (request) => {
        if (String(request.agent.session.id) !== 'session-cli-agent-loop-codex'
          || request.toolName !== 'skill') {
          return Promise.resolve('rejected')
        }
        approvalCallIds.push(String(request.callId))
        return Promise.resolve('allowed-once')
      })
      const runtimeErrors: Array<{
        callId: string
        code: string | undefined
        content: string
      }> = []
      ctx.on('tools/result', (execution, runtimeResult) => {
        if (execution.name !== 'skill' || !runtimeResult.isError) return
        runtimeErrors.push({
          callId: String(execution.callId),
          code: runtimeResult.error.info?.code,
          content: JSON.stringify(runtimeResult.content),
        })
      })

      const requests: DelegatedRequest[] = []
      let replayedError: {
        callId: string
        resultCallId: string
        isError: boolean | undefined
        content: string
      } | undefined
      const runText = vi.fn((invocation: CliInvocation) => {
        const request = delegatedRequest(invocation)
        requests.push(request)
        const transcript = blocks(request)
        const toolCall = transcript.find(block => block.type === 'tool-call' && block.name === 'skill')

        return (async function* () {
          if (toolCall === undefined) {
            yield JSON.stringify({
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{ name: 'skill', arguments: { name: 42 } }],
            })
            return
          }

          const toolResult = transcript.find(block => block.type === 'tool-result'
            && block.toolCallId === toolCall.id)
          if (toolResult === undefined) throw new Error('missing schema-invalid skill result')
          replayedError = {
            callId: toolCall.id!,
            resultCallId: toolResult.toolCallId!,
            isError: toolResult.isError,
            content: JSON.stringify(toolResult.content),
          }
          if (!replayedError.content.includes('invalid arguments')
            || !replayedError.content.includes('name')
            || !replayedError.content.includes('must be a string')) {
            throw new Error('next model turn did not receive the ToolRuntime schema error')
          }
          yield 'schema-error-observed'
        })()
      })
      const verifyAuth = vi.fn(async () => {})
      const config = CodingSubscriptionConfig()
      config.cwd = root
      config.timeoutMs = 10_000
      config.codex.transport = 'cli'
      adapter = new CodingSubscriptionAdapter(config, {
        liveSessions: ctx.sessions,
        runText,
        verifyAuth,
      })
      ctx.llm.registerAdapter(['codex-subscription'], adapter)
      await ctx.plugin(AgentLoop, { agents: [] })

      const runner = new DshAutomationRunner(ctx, ctx.assistantPolicy, {
        allowUnbudgetedExecution: true,
      })
      const result = await runner.run(automationInput(root, 'codex-subscription', 'codex', {
        prompt: 'Call skill once with an intentionally invalid numeric name, then report the error.',
        allowedTools: ['skill'],
        maxToolCalls: 1,
      }))

      expect(result).toMatchObject({ outcome: 'succeeded', output: 'schema-error-observed' })
      expect(runText).toHaveBeenCalledTimes(2)
      expect(verifyAuth).toHaveBeenCalledTimes(2)
      expect(requests).toHaveLength(2)
      expect(skillBodySideEffect).not.toHaveBeenCalled()
      expect(replayedError).toEqual(expect.objectContaining({
        resultCallId: replayedError?.callId,
        isError: true,
        content: expect.stringContaining('invalid arguments'),
      }))
      expect(runtimeErrors).toEqual([{
        callId: replayedError?.callId,
        code: 'INVALID_ARGS',
        content: expect.stringContaining('invalid arguments'),
      }])
      expect(approvalCallIds).toEqual([replayedError?.callId])
    } finally {
      adapter?.shutdown()
      await ctx.fiber.restart()
    }
  })

  test('projects a rendered tool-result image to bounded omission text and completes the next CLI step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cli-agent-loop-image-result-'))
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
          id: 'allow-image-result-tool',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: root },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'image_result_tool' },
          context: { initiators: ['background'] },
        }],
      })

      const attachmentData = Uint8Array.from(Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'))
      const attachment = {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png' as const,
        bytes: attachmentData.byteLength,
        width: 1,
        height: 1,
        name: `${'long-tool-image-name-'.repeat(100)}.png`,
      }
      const readImage = vi.fn(async () => ({ ref: attachment, data: attachmentData }))
      const getAttachments = vi.fn(() => ({ readImage }))
      let toolExecutions = 0
      ctx.tools.register({
        name: 'image_result_tool',
        description: 'Render one durable image reference as the tool result.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { rendered: { type: 'boolean' } },
            required: ['rendered'],
            additionalProperties: false,
          },
          render: () => [{ type: 'image', attachment }],
        },
        async execute() {
          toolExecutions += 1
          return { rendered: true }
        },
      })

      const approvalCallIds: string[] = []
      ctx.on('approval/request', (request) => {
        if (String(request.agent.session.id) !== 'session-cli-agent-loop-codex'
          || request.toolName !== 'image_result_tool') {
          return Promise.resolve('rejected')
        }
        approvalCallIds.push(String(request.callId))
        return Promise.resolve('allowed-once')
      })

      const serializedRequests: string[] = []
      let replayedImageResult: {
        callId: string
        resultCallId: string
        isError: boolean | undefined
        omission: SerializedBlock
      } | undefined
      const runText = vi.fn((invocation: CliInvocation) => {
        const request = delegatedRequest(invocation)
        serializedRequests.push(JSON.stringify(request))
        const transcript = blocks(request)
        const toolCall = transcript.find(block => block.type === 'tool-call'
          && block.name === 'image_result_tool')

        return (async function* () {
          if (toolCall === undefined) {
            yield JSON.stringify({
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{ name: 'image_result_tool', arguments: {} }],
            })
            return
          }

          const toolResult = transcript.find(block => block.type === 'tool-result'
            && block.toolCallId === toolCall.id)
          if (toolResult === undefined) throw new Error('missing rendered image tool result')
          const [omission] = toolResult.content ?? []
          if (omission === undefined || omission.type !== 'text' || omission.text === undefined) {
            throw new Error('CLI bridge did not replace the tool-result image with text')
          }
          replayedImageResult = {
            callId: toolCall.id!,
            resultCallId: toolResult.toolCallId!,
            isError: toolResult.isError,
            omission,
          }
          yield 'image-omission-observed'
        })()
      })
      const verifyAuth = vi.fn(async () => {})
      const config = CodingSubscriptionConfig()
      config.cwd = root
      config.timeoutMs = 10_000
      config.codex.transport = 'cli'
      adapter = new CodingSubscriptionAdapter(config, {
        liveSessions: ctx.sessions,
        runText,
        verifyAuth,
        getAttachments,
      })
      ctx.llm.registerAdapter(['codex-subscription'], adapter)
      await ctx.plugin(AgentLoop, { agents: [] })

      const runner = new DshAutomationRunner(ctx, ctx.assistantPolicy, {
        allowUnbudgetedExecution: true,
      })
      const result = await runner.run(automationInput(root, 'codex-subscription', 'codex', {
        prompt: 'Call image_result_tool once, inspect its result, then finish.',
        allowedTools: ['image_result_tool'],
        maxToolCalls: 1,
      }))

      expect(result).toMatchObject({ outcome: 'succeeded', output: 'image-omission-observed' })
      expect(toolExecutions).toBe(1)
      expect(runText).toHaveBeenCalledTimes(2)
      expect(verifyAuth).toHaveBeenCalledTimes(2)
      expect(getAttachments).not.toHaveBeenCalled()
      expect(readImage).not.toHaveBeenCalled()
      expect(replayedImageResult).toEqual(expect.objectContaining({
        resultCallId: replayedImageResult?.callId,
        isError: false,
        omission: expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('[DSH image attachment omitted by text-only backend;'),
        }),
      }))
      expect(replayedImageResult?.omission.text).toContain(`attachmentId="${attachment.attachmentId}"`)
      expect(replayedImageResult?.omission.text).toContain('mediaType="image/png"')
      expect(replayedImageResult?.omission.text).toContain(`bytes=${attachmentData.byteLength}`)
      expect(replayedImageResult?.omission.text).toContain('width=1; height=1')
      expect(replayedImageResult?.omission.text).toContain('…')
      expect(replayedImageResult?.omission.text?.length).toBeLessThanOrEqual(640)
      expect(approvalCallIds).toEqual([replayedImageResult?.callId])

      const finalPrompt = serializedRequests.at(-1)!
      expect(finalPrompt).not.toContain('"type":"image"')
      expect(finalPrompt).not.toContain(ONE_PIXEL_PNG_BASE64)
      expect(finalPrompt).not.toContain(`data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`)
      expect(finalPrompt).not.toContain(JSON.stringify(attachmentData))
      expect(finalPrompt).not.toContain('long-tool-image-name-'.repeat(20))
    } finally {
      adapter?.shutdown()
      await ctx.fiber.restart()
    }
  })

  test('uses the real rc.8 compaction pipeline to prune, summarize, checkpoint, and resume a CLI tool loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cli-compaction-'))
    roots.push(root)
    const ctx = new Context()
    let adapter: CodingSubscriptionAdapter | undefined

    try {
      await mountAgentLoopTestDependencies(ctx, {
        systemPrompt: { persona: '' },
        tools: { mode: 'native' },
      })
      await ctx.plugin(TokenMeter)
      await ctx.plugin(ToolResultPruner, {
        thresholdChars: 8_192,
        headChars: 4_096,
        tailChars: 1_024,
      })
      await ctx.plugin(BasicCompactionEngine, {
        thresholdRatio: 0.5,
        retainTokens: 0,
        maxTokens: 256,
        compactionRetries: 0,
        maxOverflowRetries: 1,
      })
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        rules: ['large_context_tool', 'small_context_tool'].map(name => ({
          id: `allow-${name}`,
          effect: 'allow' as const,
          subject: { kind: 'agent' as const, id: 'primary', workspace: root },
          actions: ['execute' as const],
          resource: { kind: 'tool' as const, id: name },
          context: { initiators: ['background' as const] },
        })),
      })
      let observedSession: ReturnType<typeof ctx.sessions.get>
      ctx.on('session/event', (session) => {
        if (String(session.id) === 'session-cli-agent-loop-codex') observedSession = session
      })

      const largePayload = `large-result-start:${'x'.repeat(30_000)}:large-result-end`
      const smallPayload = `small-result-observed:${'s'.repeat(5_000)}:small-result-end`
      let largeExecutions = 0
      let smallExecutions = 0
      for (const name of ['large_context_tool', 'small_context_tool'] as const) {
        ctx.tools.register({
          name,
          description: name === 'large_context_tool'
            ? 'Return a deliberately large result that forces context maintenance.'
            : 'Return a small result after the large result has been observed.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: {
              type: 'object',
              properties: { payload: { type: 'string' } },
              required: ['payload'],
              additionalProperties: false,
            },
            render: (_arguments, value) => [{ type: 'text', text: value.payload }],
          },
          async execute() {
            if (name === 'large_context_tool') {
              largeExecutions += 1
              return { payload: largePayload }
            }
            smallExecutions += 1
            return { payload: smallPayload }
          },
        })
      }

      ctx.on('approval/request', request => Promise.resolve(
        String(request.agent.session.id) === 'session-cli-agent-loop-codex'
          && ['large_context_tool', 'small_context_tool'].includes(request.toolName)
          ? 'allowed-once'
          : 'rejected',
      ))

      const summaryRequests: DelegatedRequest[] = []
      const normalRequests: DelegatedRequest[] = []
      const runText = vi.fn((invocation: CliInvocation) => {
        const request = delegatedRequest(invocation)
        if (request.constraints.purpose === 'compaction') {
          summaryRequests.push(request)
          return (async function* () {
            yield [
              '## Primary Request and Intent',
              '- Continue the two-tool context-maintenance regression.',
              '',
              '## Key Technical Concepts',
              '- DSH tool replay and compaction.',
              '',
              '## Files and Code',
              '- (none)',
              '',
              '## Errors and Fixes',
              '- The large result was observed and safely pruned.',
              '',
              '## Pending Jobs',
              '- Finish after the small tool result.',
              '',
              '## Current Work',
              '- The large tool call completed.',
              '',
              '## Next Step',
              '- Observe the small tool result and answer.',
              '',
              '## Critical Context',
              '- Preserve DSH-owned tool execution.',
            ].join('\n')
          })()
        }

        normalRequests.push(request)
        const transcript = blocks(request)
        return (async function* () {
          if (normalRequests.length === 1) {
            yield JSON.stringify({
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{ name: 'large_context_tool', arguments: {} }],
            })
            return
          }
          if (normalRequests.length === 2) {
            const largeResult = transcript.find(block => block.type === 'tool-result')
            const rendered = JSON.stringify(largeResult?.content)
            if (!rendered.includes('large-result-start:')
              || !rendered.includes(':large-result-end')
              || !rendered.includes('tool result middle pruned')) {
              throw new Error('the second model step did not receive the safely pruned large tool result')
            }
            yield JSON.stringify({
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{ name: 'small_context_tool', arguments: {} }],
            })
            return
          }
          const serialized = JSON.stringify(request.conversation)
          if (!serialized.includes('<compacted-summary>')
            || !serialized.includes('small-result-observed')) {
            throw new Error('the resumed model step did not receive the checkpoint and retained tool result')
          }
          yield 'compaction-resume-complete'
        })()
      })

      const config = CodingSubscriptionConfig()
      config.cwd = root
      config.timeoutMs = 10_000
      config.codex.transport = 'cli'
      config.codex.contextWindow = 4_096
      const requestAttestor = createAgentLoopRequestAttestor(ctx.agents, ['codex-subscription'])
      adapter = new CodingSubscriptionAdapter(config, {
        liveSessions: ctx.sessions,
        requestAttestor,
        runText,
        verifyAuth: async () => {},
      })
      ctx.llm.registerAdapter(['codex-subscription'], adapter)
      await ctx.plugin(AgentLoop, { agents: [] })

      const runner = new DshAutomationRunner(ctx, ctx.assistantPolicy, {
        allowUnbudgetedExecution: true,
      })
      const result = await runner.run(automationInput(root, 'codex-subscription', 'codex', {
        prompt: 'Call large_context_tool, then small_context_tool, then finish.',
        allowedTools: ['large_context_tool', 'small_context_tool'],
        maxToolCalls: 2,
      }))

      expect({
        result,
        normalRequestCount: normalRequests.length,
        summaryRequestCount: summaryRequests.length,
        eventTypes: observedSession?.events.map(event => event.type),
        turnEnds: observedSession?.events.filter(event => event.type === 'turn/end'),
      }).toMatchObject({
        result: { outcome: 'succeeded', output: 'compaction-resume-complete' },
        normalRequestCount: 3,
        summaryRequestCount: 1,
        eventTypes: expect.any(Array),
        turnEnds: [expect.objectContaining({
          data: expect.objectContaining({ reason: { kind: 'completed' } }),
        })],
      })
      expect(largeExecutions).toBe(1)
      expect(smallExecutions).toBe(1)
      expect(normalRequests).toHaveLength(3)
      expect(summaryRequests).toHaveLength(1)
      expect(summaryRequests[0]?.instruction).toContain('Do not request or invoke any tool')
      expect(summaryRequests[0]?.constraints.tools.available.map(tool => tool.name).sort()).toEqual([
        'large_context_tool',
        'small_context_tool',
      ])
      expect(summaryRequests[0]?.conversation.some(message =>
        JSON.stringify(message.content).includes('tool result middle pruned'))).toBe(true)

      expect(observedSession?.events.filter(event => event.type === 'compaction/prune')).toHaveLength(1)
      expect(observedSession?.events.filter(event => event.type === 'compaction/start')).toHaveLength(1)
      expect(observedSession?.events.filter(event => event.type === 'compaction/end')).toHaveLength(1)
      expect(JSON.stringify(observedSession?.deriveMessages())).toContain('<compacted-summary>')
    } finally {
      adapter?.shutdown()
      await ctx.fiber.restart()
    }
  })
})
