import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test, vi } from 'vitest'
import { runNativeSourceReview } from '../src/source-review-native.ts'
import type { SourceReviewConfig, SourceReviewRequest } from '../src/source-review.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  onRequest: (() => void) | undefined
  constructor(readonly mode: 'approved' | 'rejected' | 'no-usage' | 'truncated' | 'malformed' = 'approved') { super() }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options); this.onRequest?.()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.mode === 'malformed' ? 'approved'
      : JSON.stringify({ decision: this.mode === 'rejected' ? 'rejected' : 'approved', reason: 'The scoped repair preserves lifecycle ownership.' }) } }
    if (this.mode !== 'no-usage') yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: this.mode === 'truncated' ? 'max-tokens' : 'stop' } }
  }
}
async function fixture(mode?: Adapter['mode']) {
  const root = await mkdtemp(join(tmpdir(), 'source-review-native-')), ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'GLOBAL PERSONA MUST NOT LEAK' } })
  ctx.tools.register({ name: 'global_write', description: 'A global tool that review must never inherit.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'forbidden' }] },
    execute: async () => { throw new Error('review executed a global tool') } })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
  const adapter = new Adapter(mode)
  ctx.llm.registerAdapter(['supplier'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'main' }
  const config: SourceReviewConfig = { authorityId: 'review-grant', expiresAt: Date.now() + 60_000, maxReviews: 2,
    repository: root, git: { path: '/usr/bin/git', sha256: 'a'.repeat(64) }, decisionRoot: root,
    plugins: ['example'], owner, reviewerPrincipal: 'reviewer', policy: 'Check correctness.', maxChangedFiles: 10,
    maxInputBytes: 32_768, maxOutputTokens: 512, timeoutMs: 10_000 }
  const request: SourceReviewRequest = { protocol: 'dsh-source-review/v1', operationId: 'operation', planId: 'plan', planDigest: 'a'.repeat(64),
    releaseId: 'release', fence: 1, revision: 1, name: 'example', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), prId: 'pr-1',
    prEvidenceDigest: 'c'.repeat(64), checkedTreeDigest: 'd'.repeat(64), checkedPatchDigest: 'e'.repeat(64), scope: ['plugins/example'],
    source: { owner: { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }, outcomeId: 'outcome', sourceDigest: 'f'.repeat(64),
      objective: 'Fix the actual task', modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } } }
  const controller = new AbortController(), assertCurrent = vi.fn()
  const input = { config, request, model: request.source.modelSelection!, patch: '+ scoped repair', changedPaths: ['plugins/example/src/index.ts'], signal: controller.signal, assertCurrent }
  return { ctx, root, config, request, input, adapter, controller, assertCurrent }
}

test('runs one native turn with the exact inherited model, isolated prompt and zero tools', async () => {
  const f = await fixture()
  const result = await runNativeSourceReview(f.ctx, f.input)
  expect(result.status).toBe('approved')
  expect(f.adapter.requests).toHaveLength(1)
  expect(f.adapter.requests[0]).toMatchObject({ provider: 'supplier', model: 'task-model', reasoningEffort: 'high', maxTokens: 512 })
  expect(f.adapter.requests[0]!.tools ?? []).toEqual([])
  expect(f.adapter.requests[0]!.system).not.toContain('GLOBAL PERSONA')
  expect(f.assertCurrent.mock.calls.length).toBeGreaterThan(3)
})

test.each(['no-usage', 'truncated', 'malformed'] as const)('does not approve %s native output', async mode => {
  const f = await fixture(mode)
  await expect(runNativeSourceReview(f.ctx, f.input)).rejects.toThrow()
  expect(f.adapter.requests).toHaveLength(1)
})

test('retains rejection and suppresses approval after cancellation', async () => {
  const rejected = await fixture('rejected')
  expect((await runNativeSourceReview(rejected.ctx, rejected.input)).status).toBe('rejected')
  const f = await fixture(); f.adapter.onRequest = () => f.controller.abort()
  await expect(runNativeSourceReview(f.ctx, f.input)).rejects.toThrow()
})
