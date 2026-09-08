import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantPolicyService, type Config } from '../src/service.ts'
import type { PolicyRule } from '../src/types.ts'

const roots: string[] = []
async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-host-configuration-'))
  roots.push(root)
  return join(root, 'policy.sqlite')
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('assistant policy Host configuration snapshots', () => {
  test('returns the validated active rules, defaults, budgets and auto-review without maintenance fields', async () => {
    const ctx = new Context()
    const input: Config = {
      databasePath: await databasePath(), toolDefaultEffect: 'allow', proposalMaintenanceIntervalMs: 0,
      autoReview: { enabled: true, provider: 'trusted-provider', model: 'trusted-model', timeoutMs: 1_000, maxTokens: 64 },
      rules: [{ id: 'allow-read', effect: 'allow', actions: ['read'], resource: { kind: 'filesystem', id: '/work/*' } }],
      budgets: [{ id: 'tokens', metric: 'tokens', limit: 10, periodMs: 60_000, scope: 'workspace' }],
    }
    const service = new AssistantPolicyService(ctx, input)
    const actions = input.rules![0]!.actions as string[]
    actions[0] = 'write'; input.budgets![0]!.limit = 999; input.autoReview!.model = 'changed'

    const snapshot = service.inspectHostConfiguration()
    expect(snapshot).toEqual({
      toolDefaultEffect: 'allow',
      autoReview: { enabled: true, provider: 'trusted-provider', model: 'trusted-model', timeoutMs: 1_000, maxTokens: 64 },
      rules: [{ id: 'allow-read', effect: 'allow', actions: ['read'], resource: { kind: 'filesystem', id: '/work/*' } }],
      budgets: [{ id: 'tokens', metric: 'tokens', limit: 10, periodMs: 60_000, scope: 'workspace' }],
    })
    expect(snapshot).not.toHaveProperty('databasePath')
    expect(snapshot).not.toHaveProperty('proposalMaintenanceIntervalMs')
    expect(Object.isFrozen(snapshot.rules[0]!)).toBe(true)
    expect(Object.isFrozen(snapshot.rules[0]!.actions)).toBe(true)
    expect(Object.isFrozen(snapshot.budgets[0]!)).toBe(true)
    expect(() => { (snapshot.budgets[0] as unknown as { limit: number }).limit = 1 }).toThrow()
    await ctx.fiber.restart()
  })

  test('uses validated defaults and returns a detached deep-frozen value', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, { databasePath: await databasePath(), proposalMaintenanceIntervalMs: 0 })
    const first = service.inspectHostConfiguration()
    expect(first).toEqual({ rules: [], toolDefaultEffect: 'deny', budgets: [], autoReview: null })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.rules)).toBe(true)
    expect(() => (first.rules as unknown as PolicyRule[]).push({ id: 'widen', effect: 'allow', actions: ['execute'] })).toThrow()
    const second = service.inspectHostConfiguration()
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    await ctx.fiber.restart()
  })

  test('rejects host configuration reads after disposal', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, { databasePath: await databasePath(), proposalMaintenanceIntervalMs: 0 })
    await ctx.fiber.restart()
    expect(() => service.inspectHostConfiguration()).toThrow('disposed')
  })
})
