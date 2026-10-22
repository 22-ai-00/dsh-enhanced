import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { reviewOwnerRequest, reviewOwnerRequestDetailed } from '../src/owner-request-review.ts'
import { AssistantPolicyService } from '../src/service.ts'

const base = {
  ownerText: '请记住我叫 Rui', toolName: 'memory_manage', arguments: { op: 'add', content: 'Rui' },
  resourceKind: 'memory' as const, operation: 'add' as const,
  provider: 'current-provider', model: 'current-model', timeoutMs: 20, maxTokens: 64,
  signal: new AbortController().signal,
}

function runtime(response: string | 'freeze', replay = false) {
  const calls: unknown[] = []
  const llm = { async * stream(options: unknown): AsyncIterable<StreamChunk> {
    calls.push(options)
    if (response === 'freeze') { await new Promise<void>(() => {}); return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'finish', reason: { kind: 'stop' }, ...(replay ? { replayState: {
      response: { id: 'response-1', status: 'completed' }, blocks: [{ index: 0 }],
    } } : {}) }
  } } as LlmRuntime
  return { llm, calls }
}

describe('isolated owner request review', () => {
  test('accepts a stopped text decision with adapter replay metadata', async () => {
    const llm = { async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: {
        response: { id: 'response-1', status: 'completed' }, blocks: [{ index: 0 }],
      } }
    } } as unknown as LlmRuntime
    expect(await reviewOwnerRequest(llm, base)).toBe(true)
  })

  test.each([
    { name: 'missing finish', finish: false, trailing: [] as StreamChunk[] },
    { name: 'second finish', finish: true, trailing: [{ type: 'finish', reason: { kind: 'stop' } }] as StreamChunk[] },
    { name: 'text after finish', finish: true, trailing: [{ type: 'text-delta', index: 0, text: 'more' }] as StreamChunk[] },
    { name: 'tool after finish', finish: true, trailing: [{ type: 'tool-call-delta', index: 1,
      id: 'call-1' as never, argumentsDelta: '{}', name: 'untrusted-tool' }] as StreamChunk[] },
  ])('rejects $name even when the visible text says execute', async ({ finish, trailing }) => {
    const llm = { async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
      if (finish) yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {} } }
      for (const chunk of trailing) yield chunk
    } } as unknown as LlmRuntime
    expect(await reviewOwnerRequestDetailed(llm, base)).toBe('stream-invalid')
  })
  test('accepts only strict execute JSON on the frozen session route with no tools', async () => {
    const { llm, calls } = runtime('{"decision":"execute"}')
    expect(await reviewOwnerRequest(llm, base)).toBe(true)
    expect(calls).toMatchObject([{ provider: 'current-provider', model: 'current-model', tools: [], maxTokens: 64 }])
  })

  test.each([
    { output: '{"decision":"ask"}', reason: { kind: 'stop' } as const },
    { output: '{"decision":"execute","extra":1}', reason: { kind: 'stop' } as const },
    { output: '{"decision":"execute"}', reason: { kind: 'max-tokens' } as const },
    { output: '{"decision":"execute"}', reason: { kind: 'tool-calls' } as const },
  ])('replay metadata cannot authorize a $reason.kind or malformed response', async ({ output, reason }) => {
    const llm = { async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      yield { type: 'finish', reason, replayState: {
        response: { id: 'response-1', status: 'completed', decision: 'execute' }, blocks: [{ index: 0 }],
      } }
    } } as unknown as LlmRuntime
    expect(await reviewOwnerRequest(llm, base)).toBe(false)
  })

  test('replay metadata cannot authorize a tool-call stream', async () => {
    const llm = { async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
      yield { type: 'tool-call-delta', index: 1, id: 'call-1' as never, argumentsDelta: '{}', name: 'untrusted-tool' }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {}, blocks: [] } }
    } } as unknown as LlmRuntime
    expect(await reviewOwnerRequest(llm, base)).toBe(false)
  })

  test.each(['{"decision":"ask"}', '{"decision":"execute","extra":true}', '```json\n{"decision":"execute"}\n```'])
  ('falls back for %s', async response => {
    expect(await reviewOwnerRequest(runtime(response).llm, base)).toBe(false)
  })

  test('bounds non-cooperating streams and ignores their late result', async () => {
    const start = Date.now()
    expect(await reviewOwnerRequest(runtime('freeze').llm, base)).toBe(false)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  test('categorizes a timeout, ask, malformed JSON, and invalid stream without retaining content', async () => {
    expect(await reviewOwnerRequestDetailed(runtime('freeze').llm, base)).toBe('timeout')
    expect(await reviewOwnerRequestDetailed(runtime('{"decision":"ask"}', true).llm, base)).toBe('ask')
    expect(await reviewOwnerRequestDetailed(runtime('invalid', true).llm, base)).toBe('malformed')
    const failed = { async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      throw new Error('adapter failed')
    } } as unknown as LlmRuntime
    expect(await reviewOwnerRequestDetailed(failed, base)).toBe('error')
    const incomplete = { async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' }, replayState: { response: {} } }
    } } as unknown as LlmRuntime
    expect(await reviewOwnerRequestDetailed(incomplete, base)).toBe('stream-invalid')
  })

  test('bounds output while it is still streaming', async () => {
    let emitted = 0
    const llm = { async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (let index = 0; index < 1000; index += 1) {
        emitted += 1
        yield { type: 'text-delta', index: 0, text: 'x'.repeat(1024) }
      }
    } } as unknown as LlmRuntime
    expect(await reviewOwnerRequest(llm, base)).toBe(false)
    expect(emitted).toBeLessThan(20)
  })
})

test('service scopes one reviewed owner request to its exact proposal and persists approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-request-policy-'))
  const ctx = new Context()
  try {
    ctx.provide('llm' as never, runtime('{"decision":"execute"}', true).llm as never)
    const policy = new AssistantPolicyService(ctx, {
      databasePath: join(root, 'policy.sqlite'), autoReview: { enabled: true }, rules: [],
    })
    const route = { routeVersion: 2 as const, sourceId: 'lark', bindingId: 'binding',
      bindingVersion: 1, bindingGeneration: 1, workspace: '/work/alpha',
      principal: 'owner:lark:123', principalRecordId: 'owner-row', principalVersion: 1 }
    const agent = { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] } }
    const controller = new AbortController()
    const execution = { agent, signal: controller.signal, name: 'memory_manage',
      callId: 'call-one', arguments: { op: 'add', content: 'Rui' } }
    const context = { route, text: '请记住我叫 Rui', receiptDigest: 'a'.repeat(64) }
    const proposal = { idempotencyKey: 'personal-memory:owner-request-one', requester: 'agent:primary',
      principal: route.principal, action: 'memory.add', resource: { kind: 'memory', id: 'fact:one' },
      diff: '+ name: Rui', summary: 'Remember name', notAfter: Date.now() + 30_000,
      dispatch: Object.fromEntries(Object.entries(route).sort(([left], [right]) => left.localeCompare(right))) as typeof route }
    const result = await policy.runOwnerRequestedChange({ execution: execution as never,
      resourceKind: 'memory', operation: 'add', policyIdempotencyKey: proposal.idempotencyKey,
      resolveOwnerRequest: () => context }, () => policy.recoverOrCreateProposal(proposal))
    expect(result).toMatchObject({ kind: 'proposal', proposal: { status: 'approved', version: 2 } })
    expect(policy.listPendingApprovalDispatches()).toEqual([])
    expect(policy.queryAudit().filter(event => event.action === 'owner-request.review'))
      .toMatchObject([{ outcome: 'reviewed', reasonCode: 'scope-matched' }])
    expect(policy.recoverOrCreateProposal({ ...proposal, idempotencyKey: 'second' }))
      .toMatchObject({ kind: 'proposal', proposal: { status: 'pending' } })
    ctx.set('llm' as never, runtime('{"decision":"ask"}', true).llm as never)
    const askProposal = { ...proposal, idempotencyKey: 'ask-key' }
    expect(await policy.runOwnerRequestedChange({ execution: execution as never,
      resourceKind: 'memory', operation: 'add', policyIdempotencyKey: askProposal.idempotencyKey,
      resolveOwnerRequest: () => context }, () => policy.recoverOrCreateProposal(askProposal)))
      .toMatchObject({ kind: 'proposal', proposal: { status: 'pending' } })
    ctx.set('llm' as never, runtime('{"decision":"execute"}', true).llm as never)
    const wrongProposal = { ...proposal, idempotencyKey: 'wrong-key' }
    expect(await policy.runOwnerRequestedChange({ execution: execution as never,
      resourceKind: 'memory', operation: 'add', policyIdempotencyKey: 'expected-key',
      resolveOwnerRequest: () => context }, () => policy.recoverOrCreateProposal(wrongProposal)))
      .toMatchObject({ kind: 'proposal', proposal: { status: 'pending' } })
    expect(policy.queryAudit().filter(event => event.action === 'owner-request.review').map(event => event.reasonCode))
      .toEqual(['scope-matched', 'review-ask', 'scope-mismatch'])
    expect(JSON.stringify(policy.queryAudit())).not.toContain('请记住')
    expect(JSON.stringify(policy.queryAudit())).not.toContain('Rui')
    await ctx.fiber.restart()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelled owner review stops promptly without calling the old commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-request-cancel-'))
  const ctx = new Context()
  try {
    ctx.provide('llm' as never, runtime('freeze').llm as never)
    const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
      autoReview: { enabled: true, timeoutMs: 30_000 }, rules: [] })
    const controller = new AbortController()
    const route = { routeVersion: 2 as const, sourceId: 'lark', bindingId: 'binding',
      bindingVersion: 1, bindingGeneration: 1, workspace: '/work/alpha',
      principal: 'owner:lark:123', principalRecordId: 'owner-row', principalVersion: 1 }
    const agent = { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] } }
    let committed = false
    const pending = policy.runOwnerRequestedChange({
      execution: { agent, signal: controller.signal, name: 'memory_manage', callId: 'call-cancel',
        arguments: { op: 'add', content: 'Rui' } } as never,
      resourceKind: 'memory', operation: 'add', policyIdempotencyKey: 'cancel-key',
      resolveOwnerRequest: () => ({ route, text: '请记住我叫 Rui', receiptDigest: 'b'.repeat(64) }),
    }, () => { committed = true })
    controller.abort()
    await expect(pending).rejects.toThrow(/changed|cancelled/)
    expect(committed).toBe(false)
    await ctx.fiber.restart()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Policy disposal aborts a frozen review without calling commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-request-dispose-'))
  const ctx = new Context()
  try {
    ctx.provide('llm' as never, runtime('freeze').llm as never)
    const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
      autoReview: { enabled: true, timeoutMs: 30_000 }, rules: [] })
    const route = { routeVersion: 2 as const, sourceId: 'lark', bindingId: 'binding',
      bindingVersion: 1, bindingGeneration: 1, workspace: '/work/alpha',
      principal: 'owner:lark:123', principalRecordId: 'owner-row', principalVersion: 1 }
    const agent = { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] } }
    let committed = false
    const pending = policy.runOwnerRequestedChange({
      execution: { agent, signal: new AbortController().signal, name: 'memory_manage',
        callId: 'dispose-call', arguments: { op: 'add', content: 'Rui' } } as never,
      resourceKind: 'memory', operation: 'add', policyIdempotencyKey: 'dispose-key',
      resolveOwnerRequest: () => ({ route, text: '请记住我叫 Rui', receiptDigest: 'd'.repeat(64) }),
    }, () => { committed = true })
    const rejected = expect(pending).rejects.toThrow(/disposed/)
    await ctx.fiber.restart()
    await rejected
    expect(committed).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing model uses the proposal path; a changed owner receipt cannot commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-request-fallback-'))
  const ctx = new Context()
  try {
    let receipt = 'c'.repeat(64)
    const llm = { async * stream(): AsyncIterable<StreamChunk> {
      receipt = 'd'.repeat(64)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '{"decision":"execute"}' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } as unknown as LlmRuntime
    ctx.provide('llm' as never, llm as never)
    const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
      autoReview: { enabled: true }, rules: [] })
    const route = { routeVersion: 2 as const, sourceId: 'lark', bindingId: 'binding',
      bindingVersion: 1, bindingGeneration: 1, workspace: '/work/alpha',
      principal: 'owner:lark:123', principalRecordId: 'owner-row', principalVersion: 1 }
    let model: string | undefined = 'm'
    const agent = { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' },
      requestHeader: () => ({ config: { provider: 'p', model } }), snapshotEvents: () => [] } }
    const execution = { agent, signal: new AbortController().signal, name: 'memory_manage',
      callId: 'call-one', arguments: { op: 'add', content: 'Rui' } }
    const owner = () => ({ route, text: '请记住我叫 Rui', receiptDigest: receipt })
    const proposal = { idempotencyKey: 'fallback-one', requester: 'agent:primary',
      principal: route.principal, action: 'memory.add', resource: { kind: 'memory', id: 'fact:one' },
      diff: '+ name: Rui', summary: 'Remember name', notAfter: Date.now() + 30_000, dispatch: route }
    let committed = false
    await expect(policy.runOwnerRequestedChange({ execution: execution as never, resourceKind: 'memory',
      operation: 'add', policyIdempotencyKey: proposal.idempotencyKey, resolveOwnerRequest: owner },
    () => { committed = true; return policy.recoverOrCreateProposal(proposal) })).rejects.toThrow(/changed/)
    expect(committed).toBe(false)
    model = undefined
    expect(await policy.runOwnerRequestedChange({ execution: execution as never, resourceKind: 'memory',
      operation: 'add', policyIdempotencyKey: proposal.idempotencyKey, resolveOwnerRequest: owner },
    () => policy.recoverOrCreateProposal(proposal))).toMatchObject({ kind: 'proposal', proposal: { status: 'pending' } })
    expect(policy.queryAudit().filter(event => event.action === 'owner-request.review').map(event => [event.outcome, event.reasonCode]))
      .toEqual([['interrupted', 'request-changed-or-error'], ['reviewed', 'route-missing']])
    await ctx.fiber.restart()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['permission/preset', 'assistant-policy/approval-reviewer'])(
  'rejects %s event ABA during review even if the effective value returns', async type => {
    const root = await mkdtemp(join(tmpdir(), 'owner-request-permission-'))
    const ctx = new Context()
    try {
      const events: Array<{ seq: number; type: string; data: Record<string, string> }> = []
      const data = type === 'permission/preset' ? { preset: 'workspace-write' } : { reviewer: 'user' }
      events.push({ seq: 1, type, data })
      ctx.provide('llm' as never, { async * stream(): AsyncIterable<StreamChunk> {
        events.push({ seq: 2, type, data: type === 'permission/preset' ? { preset: 'auto' } : { reviewer: 'none' } })
        events.push({ seq: 3, type, data })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } } as never)
      const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
        autoReview: { enabled: true }, rules: [] })
      const route = { routeVersion: 2 as const, sourceId: 'lark', bindingId: 'binding',
        bindingVersion: 1, bindingGeneration: 1, workspace: '/work/alpha',
        principal: 'owner:lark:123', principalRecordId: 'owner-row', principalVersion: 1 }
      const agent = { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' },
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => events } }
      let committed = false
      await expect(policy.runOwnerRequestedChange({
        execution: { agent, signal: new AbortController().signal, name: 'memory_manage',
          callId: 'permission-call', arguments: { op: 'add', content: 'Rui' } } as never,
        resourceKind: 'memory', operation: 'add', policyIdempotencyKey: 'permission-key',
        resolveOwnerRequest: () => ({ route, text: '请记住我叫 Rui', receiptDigest: 'e'.repeat(64) }),
      }, () => { committed = true })).rejects.toThrow(/changed/)
      expect(committed).toBe(false)
      await ctx.fiber.restart()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('a replacement LLM provider cannot authorize the old review result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-request-llm-'))
  const ctx = new Context()
  try {
    const replacement = runtime('{"decision":"ask"}').llm
    ctx.provide('llm' as never, { async * stream(): AsyncIterable<StreamChunk> {
      ctx.set('llm' as never, replacement as never)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } as never)
    const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
      autoReview: { enabled: true }, rules: [] })
    const route = { routeVersion: 2 as const, sourceId: 'lark', bindingId: 'binding',
      bindingVersion: 1, bindingGeneration: 1, workspace: '/work/alpha',
      principal: 'owner:lark:123', principalRecordId: 'owner-row', principalVersion: 1 }
    const agent = { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] } }
    let committed = false
    await expect(policy.runOwnerRequestedChange({
      execution: { agent, signal: new AbortController().signal, name: 'memory_manage',
        callId: 'llm-call', arguments: { op: 'add', content: 'Rui' } } as never,
      resourceKind: 'memory', operation: 'add', policyIdempotencyKey: 'llm-key',
      resolveOwnerRequest: () => ({ route, text: '请记住我叫 Rui', receiptDigest: 'f'.repeat(64) }),
    }, () => { committed = true })).rejects.toThrow(/changed/)
    expect(committed).toBe(false)
    await ctx.fiber.restart()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('replace needs a stable current target; missing target remains a proposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-request-target-'))
  const ctx = new Context()
  try {
    let target = { id: 'fact:one', content: 'old', version: 1 }
    let drift = false
    ctx.provide('llm' as never, { async * stream(): AsyncIterable<StreamChunk> {
      if (drift) target = { ...target, version: 2 }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"execute"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } as never)
    const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
      autoReview: { enabled: true }, rules: [] })
    const route = { routeVersion: 2 as const, sourceId: 'lark', bindingId: 'binding',
      bindingVersion: 1, bindingGeneration: 1, workspace: '/work/alpha',
      principal: 'owner:lark:123', principalRecordId: 'owner-row', principalVersion: 1 }
    const agent = { session: { header: { cwd: '/work/alpha', agentPreset: 'primary' },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] } }
    const execution = { agent, signal: new AbortController().signal, name: 'memory_manage',
      callId: 'replace-call', arguments: { op: 'replace', id: 'fact:one', content: 'new' } }
    const owner = () => ({ route, text: '把原记录改为 new', receiptDigest: 'a'.repeat(64) })
    const proposal = { idempotencyKey: 'missing-target', requester: 'agent:primary',
      principal: route.principal, action: 'memory.replace', resource: { kind: 'memory', id: 'fact:one' },
      diff: '- old\n+ new', summary: 'Replace record', notAfter: Date.now() + 30_000, dispatch: route }
    expect(await policy.runOwnerRequestedChange({ execution: execution as never,
      resourceKind: 'memory', operation: 'replace', policyIdempotencyKey: proposal.idempotencyKey,
      resolveOwnerRequest: owner, resolveCurrentTarget: () => undefined },
    () => policy.recoverOrCreateProposal(proposal))).toMatchObject({ kind: 'proposal', proposal: { status: 'pending' } })
    drift = true
    let committed = false
    await expect(policy.runOwnerRequestedChange({ execution: execution as never,
      resourceKind: 'memory', operation: 'replace', policyIdempotencyKey: 'changed-target',
      resolveOwnerRequest: owner, resolveCurrentTarget: () => target },
    () => { committed = true })).rejects.toThrow(/changed/)
    expect(committed).toBe(false)
    await ctx.fiber.restart()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
