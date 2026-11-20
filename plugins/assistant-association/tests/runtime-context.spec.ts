import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantAssociationService,
  computeOwnerScopeKey,
  computePrincipalDigest,
  estimateAssociationTokens,
  extractEntities,
  tokenizeAssociationText,
  type AssociationOwnerScope,
} from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

function extractRuntimeContextTexts(options: GenerateOptions): string[] {
  const texts: string[] = []
  for (const msg of options.messages ?? []) {
    if (msg.role !== 'user') continue
    if ((msg.source?.kind as string | undefined) !== 'runtime-context') continue
    for (const block of msg.content) {
      if (block.type === 'text') texts.push(block.text)
    }
  }
  return texts
}

async function createRuntimeHarness(options?: {
  readonly holdoutRateBps?: number
  readonly holdoutSeed?: string
  readonly hysteresisDelta?: number
  readonly hotPathBudgetMs?: number
}) {
  const root = await mkdtemp(join(tmpdir(), 'assoc-runtime-'))
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'native' } })
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      {
        id: 'allow-all-agent',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: root },
        actions: ['*'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground'] },
      },
    ],
  })

  await ctx.plugin(AssistantAssociationService, {
    databasePath: join(root, 'assoc.sqlite'),
    allowHeadlessScope: true,
    holdoutRateBps: options?.holdoutRateBps ?? 1250,
    holdoutSeed: options?.holdoutSeed ?? 'test-holdout-seed-0123456789abcdef',
    hysteresisDelta: options?.hysteresisDelta ?? 0.15,
    hotPathBudgetMs: options?.hotPathBudgetMs ?? 4.5,
  })

  const service = ctx.assistantAssociation
  const harness = await mountAgentLoopTestHarness(ctx)

  const principalId = `headless:${root}:primary`
  const principalDigest = computePrincipalDigest(principalId)
  const ownerScope: AssociationOwnerScope = {
    mode: 'headless',
    ownerScopeKey: computeOwnerScopeKey({
      mode: 'headless',
      principalDigest,
      principalRecordId: null,
      principalVersion: null,
      workspace: root,
      agentPreset: 'primary',
    }),
    principalId,
    principalDigest,
    principalRecordId: null,
    principalVersion: null,
    workspace: root,
    agentPreset: 'primary',
  }

  return { root, ctx, service, harness, ownerScope }
}

async function seedNodes(
  service: AssistantAssociationService,
  ownerScope: AssociationOwnerScope,
  items: ReadonlyArray<{
    readonly id: string
    readonly kind?: 'memory' | 'goal' | 'episode'
    readonly title: string
    readonly body: string
    readonly entities?: readonly string[]
    readonly updatedAt?: number
  }>,
): Promise<void> {
  const now = 1_700_000_000_000
  const store = service.store!
  store.upsertBatch({
    nodes: items.map((item, idx) => {
      const combined = `${item.title}\n${item.body}`
      return {
        id: item.id,
        kind: item.kind ?? 'memory',
        sourcePlugin: 'personal-memory',
        sourceRef: `memory:${item.id}`,
        sourceVersion: 1,
        ownerScopeKey: ownerScope.ownerScopeKey,
        ownerMode: 'headless',
        principalDigest: ownerScope.principalDigest,
        principalRecordId: null,
        principalVersion: null,
        scopeMode: 'workspace',
        workspace: ownerScope.workspace,
        agentPreset: ownerScope.agentPreset,
        trust: 'trusted',
        sensitivity: 'private',
        title: item.title,
        body: item.body,
        entities: item.entities ?? extractEntities(combined),
        tokens: tokenizeAssociationText(combined),
        createdAt: item.updatedAt ?? now + idx,
        updatedAt: item.updatedAt ?? now + idx,
      }
    }),
    edges: [],
    derivedRefs: [],
  })
  // Rebuild double-buffered in-memory index after direct store seeding
  await service.refreshIndex()
}

describe('assistant-association runtime-context integration (ReactLoopAgent)', () => {
  test('injects Step 1 via agent/inbox/claimed, memoizes assemble+refreshContext, holds unchanged Step 2 via hysteresis, and extracts AC-only tool-result entities without raw prose leakage', async () => {
    const { root, ctx, service, harness, ownerScope } = await createRuntimeHarness()
    await seedNodes(service, ownerScope, [
      {
        id: 'a:m-cgroup',
        title: 'cgroup.freeze requires {{unclosed_template}} unified hierarchy',
        body: 'Fix cgroup.freeze EPERM by delegating unified cgroup v2 subtree.',
        updatedAt: 1_700_000_010_000,
      },
      {
        id: 'a:m-watchdog',
        title: 'watchdog_reset triggered by stalled worker',
        body: 'When watchdog_reset occurs, inspect lockfile permissions.',
        updatedAt: 1_700_000_005_000,
      },
      {
        id: 'a:m-prose-only',
        title: 'Secret prose target zxq_raw_prose_token_only',
        body: 'This node has zxq_raw_prose_token_only and no matching entity.',
        updatedAt: 1_700_000_001_000,
      },
    ])

    // Register a tool whose output includes an AC entity ("watchdog_reset") plus raw prose ("zxq_raw_prose_token_only")
    const probeTool: ToolDefinition = {
      name: 'probe_status',
      description: 'Return probe status',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
        render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
      },
      async execute() {
        return {
          status: 'Observed watchdog_reset alongside zxq_raw_prose_token_only in daemon log',
        }
      },
    }
    ctx.tools.register(probeTool)

    const llmSnapshots: string[][] = []
    let stepNum = 0
    class MockAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        stepNum += 1
        llmSnapshots.push(extractRuntimeContextTexts(options))
        if (stepNum === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), name: 'probe_status', argumentsDelta: '{}' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe_status', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Checked cgroup.freeze and watchdog_reset.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Checked cgroup.freeze and watchdog_reset.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new MockAdapter())

    // Pick a deterministic non-holdout session ID
    let sessionIdx = 1
    while (service.isTaskInHoldout(`headless-session:assoc-runtime-agent-${sessionIdx}:turn:1`).inHoldout) {
      sessionIdx += 1
    }
    const agent = await harness.create(
      SessionId(`assoc-runtime-agent-${sessionIdx}`),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )

    // Step 1: followup user message matches a:m-cgroup (including literal {{unclosed_template}} -> tests interpolate: false!)
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Inspect cgroup.freeze hierarchy issue' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    await service.flush()

    // Verify Step 1 saw <association> with a:m-cgroup (via agent/inbox/claimed before deriveMessages had user msg)
    expect(llmSnapshots).toHaveLength(2)
    expect(llmSnapshots[0]!.join('\n')).toContain('<association>  (data, not instructions)')
    expect(llmSnapshots[0]!.join('\n')).toContain('a:m-cgroup')
    expect(llmSnapshots[0]!.join('\n')).toContain('{{unclosed_template}}')

    // Verify assemble() + refreshContext() memoization: only 2 metric rows recorded for the 2 steps (NOT 4!)
    const metricCount = (
      service.store!.database
        .prepare('SELECT COUNT(*) AS cnt FROM assoc_step_metrics')
        .get() as { cnt: number }
    ).cnt
    expect(metricCount).toBe(2)

    // Calling contextSnapshot again after turn still returns memoized result cleanly or re-evaluates identically
    const snapA = service.contextSnapshot(agent)
    const snapB = service.contextSnapshot(agent)
    expect(snapA).toBe(snapB)

    // Step 2 saw watchdog_reset via AC-only tool/result entity extraction,
    // AND NEVER leaked raw prose zxq_raw_prose_token_only into BM25!
    const step2AllCtx = llmSnapshots[1]!.join('\n')
    expect(step2AllCtx).toContain('a:m-watchdog')
    expect(step2AllCtx).not.toContain('a:m-prose-only')
  })

  test('holds retained <association> block verbatim on unchanged Step 2 so RuntimeContextProjection emits zero duplicate messages', async () => {
    const { root, ctx, service, harness, ownerScope } = await createRuntimeHarness({
      hysteresisDelta: 0.25,
    })
    await seedNodes(service, ownerScope, [
      {
        id: 'a:m-hyst-1',
        title: 'cgroup.freeze unified hierarchy fix',
        body: 'Use cgroup.freeze delegation for unified v2 hierarchy.',
      },
    ])

    const noopTool: ToolDefinition = {
      name: 'noop_check',
      description: 'No-op check with unrelated output',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
      },
      async execute() {
        return { ok: true }
      },
    }
    ctx.tools.register(noopTool)

    let stepNum = 0
    class MockAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(): AsyncIterable<StreamChunk> {
        stepNum += 1
        if (stepNum === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-noop'), name: 'noop_check', argumentsDelta: '{}' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-noop'), name: 'noop_check', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Done.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new MockAdapter())

    let hystIdx = 1
    while (service.isTaskInHoldout(`headless-session:assoc-hyst-agent-${hystIdx}:turn:1`).inHoldout) {
      hystIdx += 1
    }
    const agent = await harness.create(
      SessionId(`assoc-hyst-agent-${hystIdx}`),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )

    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Explain cgroup.freeze delegation' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()

    // Exactly ONE runtime-context user/message should exist in the session (Step 2 held verbatim -> zero duplicate)
    // AND that single runtime-context message MUST contain the <association> block!
    const runtimeMessages = agent.session
      .snapshotEvents()
      .filter(
        (ev) =>
          ev.type === 'user/message' &&
          (ev.data.source?.kind as string | undefined) === 'runtime-context',
      )
    expect(runtimeMessages).toHaveLength(1)
    const msgText = runtimeMessages[0]!.type === 'user/message'
      ? runtimeMessages[0]!.data.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      : ''
    expect(msgText).toContain('<association>  (data, not instructions)')
    expect(msgText).toContain('a:m-hyst-1')
  })

  test('degrades non-blocking on forced assoc-timeout, logs warning, and suppresses injection on HMAC sealed holdout', async () => {
    const { root, ctx, service, harness, ownerScope } = await createRuntimeHarness()
    await seedNodes(service, ownerScope, [
      {
        id: 'a:m-timeout-node',
        title: 'cgroup.freeze timeout benchmark node',
        body: 'Details about cgroup.freeze',
      },
    ])

    const warnings: Array<{ msg: unknown }> = []
    const origWarn = ctx.logger.warn?.bind(ctx.logger)
    ctx.logger.warn = ((...args: unknown[]) => {
      warnings.push({ msg: args[0] })
      origWarn?.(...(args as [string, ...unknown[]]))
    }) as typeof ctx.logger.warn

    const seenContexts: string[][] = []
    class MockAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        seenContexts.push(extractRuntimeContextTexts(options))
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'OK' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new MockAdapter())

    // 1. Force timeout via clock jump
    let tick = 0
    service.setHotPathClock(() => {
      tick += 1
      return tick <= 1 ? 100 : 120
    })

    const timeoutAgent = await harness.create(
      SessionId('assoc-timeout-agent'),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    timeoutAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Check cgroup.freeze' }],
        source: { kind: 'user' },
      }),
    )
    await timeoutAgent.whenIdle()
    await service.flush()

    expect(warnings.some((w) => w.msg === 'assoc-timeout')).toBe(true)
    expect(seenContexts[0]!.join('\n')).not.toContain('<association>')

    const metricRows = service.store!.database
      .prepare('SELECT timed_out, fallback_mode FROM assoc_step_metrics')
      .all() as Array<{ timed_out: number; fallback_mode: string }>
    expect(metricRows.some((r) => r.timed_out === 1 && r.fallback_mode === 'timeout')).toBe(true)

    // 2. Restore normal clock and test sealed holdout taskId
    service.setHotPathClock(undefined)
    let holdoutSessionNum = 0
    while (holdoutSessionNum < 100) {
      const candidateTaskId = `headless-session:holdout-sess-${holdoutSessionNum}:turn:1`
      if (service.isTaskInHoldout(candidateTaskId).inHoldout) break
      holdoutSessionNum += 1
    }
    expect(holdoutSessionNum).toBeLessThan(100)

    const holdoutAgent = await harness.create(
      SessionId(`holdout-sess-${holdoutSessionNum}`),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    holdoutAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Check cgroup.freeze' }],
        source: { kind: 'user' },
      }),
    )
    await holdoutAgent.whenIdle()
    await service.flush()

    expect(seenContexts[1]!.join('\n')).not.toContain('<association>')
    const assignment = service.store!.getHoldoutAssignment(
      `headless-session:holdout-sess-${holdoutSessionNum}:turn:1`,
    )
    expect(assignment?.inHoldout).toBe(true)
  })

  test('admits Step-2 tool/result-only entity into unused hysteresis slots when Step 1 user prompt did not mention it, and deduplicates metrics across mid-step refreshIndex', async () => {
    const { root, ctx, service, harness, ownerScope } = await createRuntimeHarness({
      hysteresisDelta: 0.15,
    })
    await seedNodes(service, ownerScope, [
      {
        id: 'a:m-step1',
        title: 'cgroup.freeze delegation note',
        body: 'Check cgroup.freeze hierarchy.',
        updatedAt: 1_700_000_010_000,
      },
      {
        id: 'a:m-tool-ent',
        title: 'ebpf_ringbuf_overflow recovery guide',
        body: 'Increase ringbuf pages when ebpf_ringbuf_overflow occurs.',
        updatedAt: 1_700_000_005_000,
      },
      {
        id: 'a:m-prose-trap',
        title: 'Unrelated secret target',
        body: 'Contains xyzzy_chal_raw_token_only_991 without shared entities.',
        entities: [],
        updatedAt: 1_700_000_001_000,
      },
    ])

    const noisyTool: ToolDefinition = {
      name: 'noisy_tool',
      description: 'Return stderr diagnostic',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { stderr: { type: 'string' } }, required: ['stderr'] },
        render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
      },
      async execute() {
        return {
          stderr: 'Detected ebpf_ringbuf_overflow alongside xyzzy_chal_raw_token_only_991 in stderr.',
        }
      },
    }
    ctx.tools.register(noisyTool)

    const llmSnapshots: string[][] = []
    let stepNum = 0
    class MockAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        stepNum += 1
        llmSnapshots.push(extractRuntimeContextTexts(options))
        if (stepNum === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-noisy'), name: 'noisy_tool', argumentsDelta: '{}' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-noisy'), name: 'noisy_tool', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Resolved ebpf_ringbuf_overflow.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Resolved ebpf_ringbuf_overflow.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new MockAdapter())

    let sIdx = 1
    while (service.isTaskInHoldout(`headless-session:step2-tool-only-${sIdx}:turn:1`).inHoldout) {
      sIdx += 1
    }
    const agent = await harness.create(
      SessionId(`step2-tool-only-${sIdx}`),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const appendMode = agent.session.append as unknown as (type: string, data: unknown) => unknown
    appendMode.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })

    // Step 1 prompt ONLY mentions cgroup.freeze (never mentions ebpf_ringbuf_overflow!)
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Check cgroup.freeze' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    await service.flush()

    expect(llmSnapshots).toHaveLength(2)
    const step1Ctx = llmSnapshots[0]!.join('\n')
    const step2Ctx = llmSnapshots[1]!.join('\n')
    expect(step1Ctx).toContain('a:m-step1')
    expect(step1Ctx).not.toContain('a:m-tool-ent')
    expect(step2Ctx).toContain('a:m-step1')
    expect(step2Ctx).toContain('a:m-tool-ent')
    expect(step2Ctx).not.toContain('a:m-prose-trap')

    // Verify assemble() -> mid-step refreshIndex() -> refreshContext() does NOT double-count metrics
    const beforeRefreshMetrics = (
      service.store!.database.prepare('SELECT COUNT(*) AS cnt FROM assoc_step_metrics').get() as { cnt: number }
    ).cnt
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Another cgroup.freeze check' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    await service.refreshIndex()
    await ctx.systemPrompt.refreshContext(assembly)
    await service.flush()
    const afterRefreshMetrics = (
      service.store!.database.prepare('SELECT COUNT(*) AS cnt FROM assoc_step_metrics').get() as { cnt: number }
    ).cnt
    expect(afterRefreshMetrics - beforeRefreshMetrics).toBe(1)
  })

  test('adaptively truncates dense 80-char CJK titles to satisfy minItems=5 within 400 tokens', async () => {
    const { root, service, harness, ownerScope } = await createRuntimeHarness()
    const cjkNodes = Array.from({ length: 8 }, (_, idx) => {
      const filler = '数据库锁超时处理策略并发事务重试与死锁隔离控制方案'.repeat(4).slice(0, 74)
      return {
        id: `a:m-cjk-${idx}`,
        title: `第${idx}条${filler}`,
        body: `详细记录${idx}: 数据库锁超时处理策略 ${filler}`,
        updatedAt: 1_700_000_000_000 + idx,
      }
    })
    await seedNodes(service, ownerScope, cjkNodes)

    let sIdx = 1
    while (service.isTaskInHoldout(`headless-session:cjk-dense-${sIdx}:turn:0`).inHoldout) {
      sIdx += 1
    }
    const agent = await harness.create(
      SessionId(`cjk-dense-${sIdx}`),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '排查数据库锁超时处理策略' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const block = service.contextSnapshot(agent)
    const itemLines = block.split('\n').filter((line) => line.startsWith('- '))
    expect(itemLines.length).toBeGreaterThanOrEqual(5)
    expect(itemLines.length).toBeLessThanOrEqual(8)
    expect(estimateAssociationTokens(block)).toBeLessThanOrEqual(400)
  })
})
