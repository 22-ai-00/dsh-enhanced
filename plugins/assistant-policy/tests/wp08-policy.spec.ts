import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, test } from 'vitest'
import * as entrypoint from '../src/index.ts'
import {
  AssistantPolicyService,
  POLICY_SENSITIVITY_LEVELS,
  compilePolicy,
  evaluatePolicy,
  mergeAssistantPolicyGrants,
  type PolicyRequest,
  type PolicyRule,
  type PolicySensitivity,
} from '../src/index.ts'

const temporaryRoots: string[] = []

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-wp08-'))
  temporaryRoots.push(root)
  return join(root, 'policy.sqlite')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const baseRequest: PolicyRequest = {
  subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
  action: 'execute',
  resource: { kind: 'network', id: 'github-api' },
  context: { initiator: 'foreground' },
}

function makeAgent(id = 'wp08-session', preset = 'primary', cwd = '/work/alpha'): Agent {
  const sid = SessionId(id)
  const session = Session.create(sid, [], {
    version: SESSION_FORMAT_VERSION,
    id: sid,
    createdAt: 1,
    isSeeded: false,
    cwd,
    agentPreset: preset,
  })
  return {
    id: sid,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: createInboxStub(),
    model: { current: () => ({ provider: 'test-provider', model: 'test-model' }), select: () => {} },
    status: 'idle',
    ctx: new Context(),
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

describe('WP08 native PolicyRule & evaluatePolicy', () => {
  test('exports compilePolicy, evaluatePolicy, and sensitivity levels while keeping ledger unexported', () => {
    expect(POLICY_SENSITIVITY_LEVELS).toEqual(['public', 'internal', 'confidential', 'restricted'])
    expect(compilePolicy).toBeTypeOf('function')
    expect(evaluatePolicy).toBeTypeOf('function')
    expect(entrypoint).not.toHaveProperty('PolicyLedger')
    expect(entrypoint).not.toHaveProperty('PolicyLedgerError')
  })

  test('validates WP08 rule fields at compile time and freezes snapshots', () => {
    expect(() => compilePolicy([{
      id: 'bad-lease-obj',
      effect: 'allow',
      lease: [] as never,
    }])).toThrow(/lease/i)
    expect(() => compilePolicy([{
      id: 'bad-lease-id',
      effect: 'allow',
      lease: { leaseId: ' lease-1 ' },
    }])).toThrow(/leaseId/i)
    expect(() => compilePolicy([{
      id: 'bad-lease-exp',
      effect: 'allow',
      lease: { expiresAtMs: Number.NaN },
    }])).toThrow(/expiresAtMs/i)
    expect(() => compilePolicy([{
      id: 'bad-lease-uses',
      effect: 'allow',
      lease: { maxUses: -1 },
    }])).toThrow(/maxUses/i)
    expect(() => compilePolicy([{
      id: 'bad-lease-float',
      effect: 'allow',
      lease: { maxUses: 1.5 },
    }])).toThrow(/maxUses/i)
    expect(() => compilePolicy([{
      id: 'bad-dest-type',
      effect: 'allow',
      destinations: 'https://api.github.com' as never,
    }])).toThrow(/destinations/i)
    expect(() => compilePolicy([{
      id: 'bad-dest-entry',
      effect: 'allow',
      destinations: ['https://api.github.com\n'],
    }])).toThrow(/destination/i)
    expect(() => compilePolicy([{
      id: 'bad-sens',
      effect: 'allow',
      maxSensitivity: 'top-secret' as never,
    }])).toThrow(/maxSensitivity/i)
    expect(() => compilePolicy([{
      id: 'bad-cost-neg',
      effect: 'allow',
      monetaryCostCapMicros: -5,
    }])).toThrow(/monetaryCostCapMicros/i)
    expect(() => compilePolicy([{
      id: 'bad-cost-float',
      effect: 'allow',
      monetaryCostCapMicros: 12.5,
    }])).toThrow(/monetaryCostCapMicros/i)
    expect(() => compilePolicy([{
      id: 'bad-commit',
      effect: 'allow',
      commitDigest: ' ',
    }])).toThrow(/commitDigest/i)
    expect(() => compilePolicy([{
      id: 'bad-pred',
      effect: 'allow',
      predecessorDigest: 'sha256:bad\t',
    }])).toThrow(/predecessorDigest/i)
    expect(() => compilePolicy([{
      id: 'bad-idem',
      effect: 'allow',
      idempotencyKey: '',
    }])).toThrow(/idempotencyKey/i)

    const rule: PolicyRule = {
      id: 'frozen-wp08',
      effect: 'allow',
      lease: { leaseId: 'lease-1', expiresAtMs: 5_000, maxUses: 2, revoked: false },
      destinations: ['https://api.github.com/*'],
      maxSensitivity: 'internal',
      monetaryCostCapMicros: 1_000,
      commitDigest: 'sha256:1111',
      predecessorDigest: 'sha256:0000',
      idempotencyKey: 'idem-1',
    }
    const compiled = compilePolicy([rule])
    ;(rule.lease as { maxUses: number }).maxUses = 999
    ;(rule.destinations as string[])[0] = '*'
    expect(compiled.rules[0]!.lease).toEqual({
      leaseId: 'lease-1',
      expiresAtMs: 5_000,
      maxUses: 2,
      revoked: false,
    })
    expect(compiled.rules[0]!.destinations).toEqual(['https://api.github.com/*'])
    expect(Object.isFrozen(compiled.rules[0]!.lease)).toBe(true)
    expect(Object.isFrozen(compiled.rules[0]!.destinations)).toBe(true)
  })

  test('enforces short-term leases: expiry boundaries, maxUses, revocation, mismatch, and fallback', () => {
    const compiled = compilePolicy([
      {
        id: 'allow-leased',
        effect: 'allow',
        actions: ['execute'],
        lease: { leaseId: 'lease-short', expiresAtMs: 10_000, maxUses: 2 },
      },
    ])

    expect(evaluatePolicy(compiled, baseRequest, { nowMs: 9_999, leaseUses: { 'lease-short': 1 } })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'allow-leased',
      lease: { leaseId: 'lease-short', expiresAtMs: 10_000, maxUses: 2 },
    })
    expect(evaluatePolicy(compiled, baseRequest, { nowMs: 10_000 })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-expired',
      ruleId: 'allow-leased',
    })
    expect(evaluatePolicy(compiled, baseRequest, { nowMs: 9_000, leaseUses: { 'lease-short': 2 } })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-exhausted',
      ruleId: 'allow-leased',
    })
    expect(evaluatePolicy(compiled, baseRequest, { nowMs: 9_000, revokedLeaseIds: ['lease-short'] })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'allow-leased',
    })
    expect(evaluatePolicy(compiled, { ...baseRequest, lease: { leaseId: 'other' } }, { nowMs: 9_000 })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-mismatch',
      ruleId: 'allow-leased',
    })
    expect(evaluatePolicy(compiled, { ...baseRequest, lease: { revoked: true } }, { nowMs: 9_000 })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: undefined,
    })
    expect(evaluatePolicy(compiled, { ...baseRequest, lease: { expiresAtMs: Number.NaN } }, { nowMs: 9_000 })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-invalid',
      ruleId: undefined,
    })

    const zeroUses = compilePolicy([{
      id: 'zero-uses',
      effect: 'allow',
      actions: ['execute'],
      lease: { leaseId: 'zero', maxUses: 0 },
    }])
    expect(evaluatePolicy(zeroUses, baseRequest, { nowMs: 1_000 })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-exhausted',
      ruleId: 'zero-uses',
    })

    const multiLease = compilePolicy([
      { id: 'expired-lease', effect: 'allow', actions: ['execute'], lease: { leaseId: 'l1', expiresAtMs: 5_000 } },
      { id: 'active-lease', effect: 'allow', actions: ['execute'], lease: { leaseId: 'l2', expiresAtMs: 15_000 } },
    ])
    expect(evaluatePolicy(multiLease, baseRequest, { nowMs: 10_000 })).toMatchObject({
      effect: 'allow',
      ruleId: 'active-lease',
    })
  })

  test('enforces destinations fail-closed against missing, invalid, empty, and host-suffix attacks', () => {
    const compiled = compilePolicy([
      {
        id: 'allow-github-api',
        effect: 'allow',
        actions: ['execute'],
        destinations: ['https://api.github.com/*'],
      },
      {
        id: 'allow-slack-api',
        effect: 'allow',
        actions: ['execute'],
        destinations: ['https://slack.com/api/*'],
        maxSensitivity: 'public',
      },
    ])

    expect(evaluatePolicy(compiled, { ...baseRequest, destination: 'https://api.github.com/repos/a/b' }))
      .toMatchObject({ effect: 'allow', ruleId: 'allow-github-api' })
    expect(evaluatePolicy(compiled, { ...baseRequest, destination: 'https://slack.com/api/chat.postMessage', sensitivity: 'public' }))
      .toMatchObject({ effect: 'allow', ruleId: 'allow-slack-api' })
    expect(evaluatePolicy(compiled, { ...baseRequest, destination: 'https://slack.com/api/chat.postMessage', sensitivity: 'restricted' }))
      .toEqual({ effect: 'deny', reasonCode: 'sensitivity-exceeded', ruleId: 'allow-slack-api' })
    expect(evaluatePolicy(compiled, { ...baseRequest, destination: 'https://api.github.com.evil.com/repos' }))
      .toMatchObject({ effect: 'deny', reasonCode: 'destination-mismatch' })
    expect(evaluatePolicy(compiled, baseRequest))
      .toMatchObject({ effect: 'deny', reasonCode: 'destination-missing' })
    expect(evaluatePolicy(compiled, { ...baseRequest, destination: '   ' }))
      .toEqual({ effect: 'deny', reasonCode: 'destination-invalid', ruleId: undefined })

    const githubOnly = compilePolicy([
      {
        id: 'allow-github-api',
        effect: 'allow',
        actions: ['execute'],
        destinations: ['https://api.github.com/*'],
      },
      {
        id: 'deny-evil-path',
        effect: 'deny',
        actions: ['execute'],
        destinations: ['https://api.github.com/admin/*'],
      },
    ])
    expect(evaluatePolicy(githubOnly, { ...baseRequest, destination: 'https://api.github.com.evil.com/repos' }))
      .toEqual({ effect: 'deny', reasonCode: 'destination-mismatch', ruleId: 'allow-github-api' })
    expect(evaluatePolicy(githubOnly, { ...baseRequest, destination: 'https://api.github.com/admin/users' }))
      .toEqual({ effect: 'deny', reasonCode: 'rule-deny', ruleId: 'deny-evil-path' })
    expect(evaluatePolicy(githubOnly, { ...baseRequest, destination: 'https://api.github.com/repos/o/r' }))
      .toEqual({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-github-api' })

    const emptyDestRule = compilePolicy([{ id: 'empty-dest', effect: 'allow', actions: ['execute'], destinations: [] }])
    expect(evaluatePolicy(emptyDestRule, { ...baseRequest, destination: 'https://api.github.com/repos' }))
      .toEqual({ effect: 'deny', reasonCode: 'destination-mismatch', ruleId: 'empty-dest' })

    const wildcardDestRule = compilePolicy([{ id: 'any-dest', effect: 'allow', actions: ['execute'], destinations: ['*'] }])
    expect(evaluatePolicy(wildcardDestRule, baseRequest))
      .toEqual({ effect: 'deny', reasonCode: 'destination-missing', ruleId: 'any-dest' })
  })

  test('enforces full 4x4 sensitivity matrix and fail-closed on missing or invalid sensitivity', () => {
    const rank: Record<PolicySensitivity, number> = {
      public: 0,
      internal: 1,
      confidential: 2,
      restricted: 3,
    }
    for (const maxSensitivity of POLICY_SENSITIVITY_LEVELS) {
      const compiled = compilePolicy([{
        id: `cap-${maxSensitivity}`,
        effect: 'allow',
        actions: ['execute'],
        maxSensitivity,
      }])
      expect(evaluatePolicy(compiled, baseRequest)).toEqual({
        effect: 'deny',
        reasonCode: 'sensitivity-missing',
        ruleId: `cap-${maxSensitivity}`,
      })
      expect(evaluatePolicy(compiled, { ...baseRequest, sensitivity: 'secret' as never })).toEqual({
        effect: 'deny',
        reasonCode: 'sensitivity-invalid',
        ruleId: undefined,
      })
      for (const reqSensitivity of POLICY_SENSITIVITY_LEVELS) {
        const decision = evaluatePolicy(compiled, { ...baseRequest, sensitivity: reqSensitivity })
        if (rank[reqSensitivity] <= rank[maxSensitivity]) {
          expect(decision).toEqual({ effect: 'allow', reasonCode: 'rule-allow', ruleId: `cap-${maxSensitivity}` })
        } else {
          expect(decision).toEqual({ effect: 'deny', reasonCode: 'sensitivity-exceeded', ruleId: `cap-${maxSensitivity}` })
        }
      }
    }
  })

  test('enforces monetaryCostCapMicros boundaries, cumulative spentCostMicros, and invalid values', () => {
    const compiled = compilePolicy([{
      id: 'cost-cap',
      effect: 'allow',
      actions: ['execute'],
      monetaryCostCapMicros: 500,
    }])

    expect(evaluatePolicy(compiled, { ...baseRequest, estimatedCostMicros: 0 })).toMatchObject({ effect: 'allow' })
    expect(evaluatePolicy(compiled, { ...baseRequest, estimatedCostMicros: 500 })).toMatchObject({ effect: 'allow' })
    expect(evaluatePolicy(compiled, { ...baseRequest, estimatedCostMicros: 501 })).toEqual({
      effect: 'deny',
      reasonCode: 'monetary-cost-exceeded',
      ruleId: 'cost-cap',
    })
    expect(evaluatePolicy(compiled, { ...baseRequest, estimatedCostMicros: 200 }, { spentCostMicros: 300 }))
      .toMatchObject({ effect: 'allow' })
    expect(evaluatePolicy(compiled, { ...baseRequest, estimatedCostMicros: 201 }, { spentCostMicros: 300 }))
      .toEqual({ effect: 'deny', reasonCode: 'monetary-cost-exceeded', ruleId: 'cost-cap' })
    expect(evaluatePolicy(compiled, baseRequest)).toEqual({
      effect: 'deny',
      reasonCode: 'monetary-cost-missing',
      ruleId: 'cost-cap',
    })
    for (const badCost of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.25]) {
      expect(evaluatePolicy(compiled, { ...baseRequest, estimatedCostMicros: badCost })).toEqual({
        effect: 'deny',
        reasonCode: 'monetary-cost-invalid',
        ruleId: undefined,
      })
    }
  })

  test('enforces commitDigest, predecessorDigest, activeCommitDigests, and idempotencyKey bindings', () => {
    const compiled = compilePolicy([{
      id: 'commit-bound',
      effect: 'allow',
      actions: ['execute'],
      commitDigest: 'sha256:commit-2',
      predecessorDigest: 'sha256:commit-1',
      idempotencyKey: 'op-2',
    }])

    expect(evaluatePolicy(compiled, {
      ...baseRequest,
      commitDigest: 'sha256:commit-2',
      predecessorDigest: 'sha256:commit-1',
      idempotencyKey: 'op-2',
    }, {
      expectedPredecessorDigest: 'sha256:commit-1',
      activeCommitDigests: ['sha256:commit-2'],
      idempotencyBindings: { 'op-2': { commitDigest: 'sha256:commit-2', predecessorDigest: 'sha256:commit-1' } },
    })).toMatchObject({ effect: 'allow', ruleId: 'commit-bound' })

    expect(evaluatePolicy(compiled, { ...baseRequest, predecessorDigest: 'sha256:commit-1', idempotencyKey: 'op-2' }))
      .toEqual({ effect: 'deny', reasonCode: 'commit-digest-missing', ruleId: 'commit-bound' })
    expect(evaluatePolicy(compiled, {
      ...baseRequest, commitDigest: 'sha256:other', predecessorDigest: 'sha256:commit-1', idempotencyKey: 'op-2',
    })).toEqual({ effect: 'deny', reasonCode: 'commit-digest-mismatch', ruleId: 'commit-bound' })
    expect(evaluatePolicy(compiled, {
      ...baseRequest, commitDigest: 'sha256:commit-2', idempotencyKey: 'op-2',
    })).toEqual({ effect: 'deny', reasonCode: 'predecessor-digest-missing', ruleId: 'commit-bound' })
    expect(evaluatePolicy(compiled, {
      ...baseRequest, commitDigest: 'sha256:commit-2', predecessorDigest: 'sha256:stale', idempotencyKey: 'op-2',
    })).toEqual({ effect: 'deny', reasonCode: 'predecessor-digest-mismatch', ruleId: 'commit-bound' })
    expect(evaluatePolicy(compiled, {
      ...baseRequest, commitDigest: 'sha256:commit-2', predecessorDigest: 'sha256:commit-1',
    })).toEqual({ effect: 'deny', reasonCode: 'idempotency-key-missing', ruleId: 'commit-bound' })
    expect(evaluatePolicy(compiled, {
      ...baseRequest, commitDigest: 'sha256:commit-2', predecessorDigest: 'sha256:commit-1', idempotencyKey: 'op-other',
    })).toEqual({ effect: 'deny', reasonCode: 'idempotency-conflict', ruleId: 'commit-bound' })
    expect(evaluatePolicy(compiled, {
      ...baseRequest, commitDigest: 'sha256:commit-2', predecessorDigest: 'sha256:commit-1', idempotencyKey: 'op-2',
    }, {
      usedIdempotencyKeys: ['op-2'],
    })).toEqual({ effect: 'deny', reasonCode: 'idempotency-conflict', ruleId: undefined })
    expect(evaluatePolicy(compiled, {
      ...baseRequest, commitDigest: 'sha256:commit-2', predecessorDigest: 'sha256:commit-1', idempotencyKey: 'op-2',
    }, {
      activeCommitDigests: ['sha256:different'],
    })).toEqual({ effect: 'deny', reasonCode: 'commit-digest-mismatch', ruleId: 'commit-bound' })
  })
})

describe('WP08 AssistantPolicyService & SQLite v7 durability', () => {
  test('validates, snapshots, and merges WP08 rules without altering legacy rules', async () => {
    const wp08Rule: PolicyRule = {
      id: 'wp08-rule',
      effect: 'allow',
      actions: ['execute'],
      resource: { kind: 'network', id: 'github' },
      lease: { leaseId: 'lease-cfg', expiresAtMs: 50_000, maxUses: 3 },
      destinations: ['https://api.github.com/*'],
      maxSensitivity: 'confidential',
      monetaryCostCapMicros: 2_500,
      commitDigest: 'sha256:abc',
      predecessorDigest: 'sha256:000',
      idempotencyKey: 'key-cfg',
    }
    const legacyRule: PolicyRule = {
      id: 'legacy-rule',
      effect: 'allow',
      actions: ['read'],
    }
    const merged = mergeAssistantPolicyGrants({ rules: [legacyRule] }, { rules: [wp08Rule] })
    expect(merged.rules).toEqual([legacyRule, wp08Rule])

    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      rules: merged.rules,
    })
    expect(service.inspectHostConfiguration().rules).toEqual([legacyRule, wp08Rule])
    await ctx.fiber.restart()
  })

  test('toolDefaultEffect: allow never bypasses failed WP08 constraints on matching tool rules', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      toolDefaultEffect: 'allow',
      rules: [{
        id: 'restricted-tool-rule',
        effect: 'allow',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'http_post' },
        destinations: ['https://api.github.com/*'],
        maxSensitivity: 'internal',
        monetaryCostCapMicros: 100,
      }],
    })

    const owner = makeAgent('tool-non-bypass')
    const exec = (name: string): ToolExecution => ({
      name,
      callId: `call-${name}`,
      rootCallId: 'root-1',
      agent: owner,
      arguments: {},
      signal: new AbortController().signal,
    } as unknown as ToolExecution)

    // Unmatched tool still uses tool-default-allow.
    expect(service.authorizeToolExecution(exec('read_file'))).toEqual({
      effect: 'allow',
      reasonCode: 'tool-default-allow',
      ruleId: undefined,
    })
    // Matched tool failing WP08 constraint must NOT fall back to tool-default-allow.
    expect(service.authorizeToolExecution(exec('http_post'))).toEqual({
      effect: 'deny',
      reasonCode: 'destination-missing',
      ruleId: 'restricted-tool-rule',
    })
    await ctx.fiber.restart()
  })

  test('persists lease usage, expiry, and revocation across service restarts while evaluate() stays read-only', async () => {
    const dbPath = await databasePath()
    let now = 1_000
    const rules: PolicyRule[] = [{
      id: 'leased-network',
      effect: 'allow',
      actions: ['execute'],
      resource: { kind: 'network', id: 'github-api' },
      lease: { leaseId: 'lease-persist', expiresAtMs: 10_000, maxUses: 2 },
    }]

    const ctx1 = new Context()
    const s1 = new AssistantPolicyService(ctx1, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules }, { now: () => now })
    // evaluate() is strictly read-only.
    expect(s1.evaluate(baseRequest)).toMatchObject({ effect: 'allow', reasonCode: 'rule-allow' })
    expect(s1.evaluate(baseRequest)).toMatchObject({ effect: 'allow', reasonCode: 'rule-allow' })
    expect(s1.getLeaseState('lease-persist')).toBeUndefined()

    expect(s1.authorize(baseRequest, { idempotencyKey: 'u1' }).effect).toBe('allow')
    expect(s1.getLeaseState('lease-persist')).toMatchObject({ leaseId: 'lease-persist', uses: 1, revoked: false })
    await ctx1.fiber.restart()

    // Restart service and verify persisted use count and exhaustion.
    const ctx2 = new Context()
    const s2 = new AssistantPolicyService(ctx2, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules }, { now: () => now })
    expect(s2.getLeaseState('lease-persist')).toMatchObject({ uses: 1, revoked: false })
    expect(s2.authorize(baseRequest, { idempotencyKey: 'u2' }).effect).toBe('allow')
    expect(s2.authorize(baseRequest, { idempotencyKey: 'u3' })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-exhausted',
      ruleId: 'leased-network',
    })

    // Idempotent replay of u1 succeeds without double-charging lease uses.
    expect(s2.authorize(baseRequest, { idempotencyKey: 'u1' }).effect).toBe('allow')
    expect(s2.getLeaseState('lease-persist')?.uses).toBe(2)

    // Revocation persists across restart and blocks even existing keys.
    const revoked = s2.revokeLease('lease-persist', { actor: 'owner', reason: 'rotate' })
    expect(revoked).toMatchObject({ leaseId: 'lease-persist', revoked: true, uses: 2 })
    await ctx2.fiber.restart()

    const ctx3 = new Context()
    const s3 = new AssistantPolicyService(ctx3, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules }, { now: () => now })
    expect(s3.authorize(baseRequest, { idempotencyKey: 'u1' })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'leased-network',
    })
    expect(s3.queryAudit({ limit: 20 }).some(e => e.action === 'policy.lease.revoke' && e.outcome === 'revoked')).toBe(true)
    await ctx3.fiber.restart()

    // Expiry enforcement via injected clock.
    const ctx4 = new Context()
    const s4 = new AssistantPolicyService(ctx4, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      rules: [{ id: 'exp-rule', effect: 'allow', actions: ['execute'], lease: { leaseId: 'exp-1', expiresAtMs: 5_000 } }],
    }, { now: () => now })
    now = 5_000
    expect(s4.authorize(baseRequest)).toEqual({
      effect: 'deny',
      reasonCode: 'lease-expired',
      ruleId: 'exp-rule',
    })
    await ctx4.fiber.restart()
  })

  test('keeps lease, commit head, idempotency, and budget atomic on failure and across commit chains', async () => {
    const dbPath = await databasePath()
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: dbPath,
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'atomic-rule',
        effect: 'allow',
        actions: ['execute'],
        resource: { kind: 'goal', id: 'goal-1' },
        lease: { leaseId: 'atomic-lease', maxUses: 5 },
        budget: { id: 'ops', amount: 1 },
      }],
      budgets: [{ id: 'ops', metric: 'ops', limit: 2, periodMs: 60_000, scope: 'global' }],
    }, { now: () => 10_000 })

    const goalReq = (commitDigest: string, predecessorDigest?: string, idempotencyKey?: string): PolicyRequest => ({
      ...baseRequest,
      resource: { kind: 'goal', id: 'goal-1' },
      commitDigest,
      ...(predecessorDigest === undefined ? {} : { predecessorDigest }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })

    // Commit 1: d1 (prev d0).
    expect(service.authorize(goalReq('sha256:d1', 'sha256:d0'), { idempotencyKey: 'k1' }).effect).toBe('allow')
    expect(service.getCommitHead({ kind: 'goal', id: 'goal-1' })).toBe('sha256:d1')
    expect(service.getLeaseState('atomic-lease')?.uses).toBe(1)

    // Replay k1 with identical intent -> allow without advancing lease uses or failing predecessor check.
    expect(service.authorize(goalReq('sha256:d1', 'sha256:d0'), { idempotencyKey: 'k1' }).effect).toBe('allow')
    expect(service.getLeaseState('atomic-lease')?.uses).toBe(1)

    // Reuse k1 with different commitDigest -> idempotency-conflict.
    expect(service.authorize(goalReq('sha256:d2', 'sha256:d1'), { idempotencyKey: 'k1' })).toEqual({
      effect: 'deny',
      reasonCode: 'idempotency-conflict',
      ruleId: undefined,
    })
    expect(service.getCommitHead({ kind: 'goal', id: 'goal-1' })).toBe('sha256:d1')

    // Conflict between request.idempotencyKey and options.idempotencyKey -> idempotency-conflict.
    expect(service.authorize(goalReq('sha256:d2', 'sha256:d1', 'k-req'), { idempotencyKey: 'k-opt' })).toEqual({
      effect: 'deny',
      reasonCode: 'idempotency-conflict',
      ruleId: undefined,
    })

    // Stale predecessor -> predecessor-digest-mismatch, does not charge budget or lease.
    expect(service.authorize(goalReq('sha256:d2', 'sha256:d0'), { idempotencyKey: 'k2-stale' })).toEqual({
      effect: 'deny',
      reasonCode: 'predecessor-digest-mismatch',
      ruleId: 'atomic-rule',
    })
    expect(service.getLeaseState('atomic-lease')?.uses).toBe(1)

    // Missing predecessor once a commit head exists -> predecessor-digest-missing.
    expect(service.authorize(goalReq('sha256:d2'), { idempotencyKey: 'k2-missing' })).toEqual({
      effect: 'deny',
      reasonCode: 'predecessor-digest-missing',
      ruleId: 'atomic-rule',
    })

    // Valid Commit 2: d2 (prev d1) consumes the 2nd and final budget unit.
    expect(service.authorize(goalReq('sha256:d2', 'sha256:d1'), { idempotencyKey: 'k2' }).effect).toBe('allow')
    expect(service.getCommitHead({ kind: 'goal', id: 'goal-1' })).toBe('sha256:d2')
    expect(service.getLeaseState('atomic-lease')?.uses).toBe(2)

    // Commit 3: budget is now exhausted -> must NOT increment lease uses or advance commit head!
    expect(service.authorize(goalReq('sha256:d3', 'sha256:d2'), { idempotencyKey: 'k3' })).toEqual({
      effect: 'deny',
      reasonCode: 'budget-exhausted',
      ruleId: undefined,
    })
    expect(service.getCommitHead({ kind: 'goal', id: 'goal-1' })).toBe('sha256:d2')
    expect(service.getLeaseState('atomic-lease')?.uses).toBe(2)
    await ctx.fiber.restart()
  })

  test('prevents anonymous rule.lease maxUses bypass via rotating request.lease.leaseId and revokes via rule.id or rule:<id>', async () => {
    const dbPath1 = await databasePath()
    const ctx1 = new Context()
    const s1 = new AssistantPolicyService(ctx1, {
      databasePath: dbPath1,
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'anon-capped',
        effect: 'allow',
        actions: ['execute'],
        lease: { maxUses: 1 },
      }],
    })

    // First call with caller-a consumes rule:anon-capped (and caller-a).
    expect(s1.evaluate({ ...baseRequest, lease: { leaseId: 'caller-a' } })).toMatchObject({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'anon-capped',
    })
    expect(s1.authorize({ ...baseRequest, lease: { leaseId: 'caller-a' } }, { idempotencyKey: 'k1' })).toMatchObject({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'anon-capped',
    })
    expect(s1.getLeaseState('rule:anon-capped')?.uses).toBe(1)

    // Rotating to caller-b or omitting request.lease must fail with lease-exhausted in both evaluate() and authorize().
    for (const nextReq of [
      { ...baseRequest, lease: { leaseId: 'caller-b' } },
      baseRequest,
    ]) {
      expect(s1.evaluate(nextReq)).toEqual({
        effect: 'deny',
        reasonCode: 'lease-exhausted',
        ruleId: 'anon-capped',
      })
      expect(s1.authorize(nextReq, { idempotencyKey: `k-${nextReq.lease?.leaseId ?? 'none'}` })).toEqual({
        effect: 'deny',
        reasonCode: 'lease-exhausted',
        ruleId: 'anon-capped',
      })
    }
    await ctx1.fiber.restart()

    // Revoking via bare rule.id revokes anonymous rule lease (including on replay).
    const ctx2 = new Context()
    const s2 = new AssistantPolicyService(ctx2, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'anon-rev-bare',
        effect: 'allow',
        actions: ['execute'],
        lease: { maxUses: 5 },
      }],
    })
    expect(s2.authorize(baseRequest, { idempotencyKey: 'rk1' }).effect).toBe('allow')
    s2.revokeLease('anon-rev-bare')
    expect(s2.evaluate(baseRequest)).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'anon-rev-bare',
    })
    expect(s2.authorize(baseRequest, { idempotencyKey: 'rk1' })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'anon-rev-bare',
    })
    expect(s2.authorize(baseRequest, { idempotencyKey: 'rk2' })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'anon-rev-bare',
    })
    await ctx2.fiber.restart()

    // Revoking via rule:<id> also revokes anonymous rule lease.
    const ctx3 = new Context()
    const s3 = new AssistantPolicyService(ctx3, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'anon-rev-prefix',
        effect: 'allow',
        actions: ['execute'],
        lease: { maxUses: 5 },
      }],
    })
    expect(s3.authorize(baseRequest, { idempotencyKey: 'pk1' }).effect).toBe('allow')
    s3.revokeLease('rule:anon-rev-prefix')
    expect(s3.evaluate(baseRequest)).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'anon-rev-prefix',
    })
    expect(s3.authorize(baseRequest, { idempotencyKey: 'pk2' })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'anon-rev-prefix',
    })
    await ctx3.fiber.restart()
  })

  test('evaluate() and authorize() agree on idempotent initial-commit replay and plain rules with anonymous request.lease', async () => {
    let now = 1_000
    const ctx1 = new Context()
    const s1 = new AssistantPolicyService(ctx1, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'commit-r1',
        effect: 'allow',
        actions: ['execute'],
        resource: { kind: 'goal', id: 'g1' },
        lease: { leaseId: 'commit-lease', expiresAtMs: 5_000, maxUses: 1 },
      }],
    }, { now: () => now })

    const commitReq: PolicyRequest = {
      ...baseRequest,
      resource: { kind: 'goal', id: 'g1' },
      commitDigest: 'sha256:c1',
      idempotencyKey: 'idem-c1',
    }
    expect(s1.evaluate(commitReq)).toMatchObject({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'commit-r1' })
    expect(s1.authorize(commitReq)).toMatchObject({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'commit-r1' })
    // Replay after first commit + lease consumption must agree between evaluate() and authorize().
    expect(s1.evaluate(commitReq)).toMatchObject({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'commit-r1' })
    expect(s1.authorize(commitReq)).toMatchObject({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'commit-r1' })
    // Mutated intent with same key conflicts in both.
    expect(s1.evaluate({ ...commitReq, commitDigest: 'sha256:c2' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'idempotency-conflict',
    })
    expect(s1.authorize({ ...commitReq, commitDigest: 'sha256:c2' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'idempotency-conflict',
    })
    // Live lease expiry still blocks replay in both evaluate() and authorize().
    now = 5_000
    expect(s1.evaluate(commitReq)).toEqual({ effect: 'deny', reasonCode: 'lease-expired', ruleId: 'commit-r1' })
    expect(s1.authorize(commitReq)).toEqual({ effect: 'deny', reasonCode: 'lease-expired', ruleId: 'commit-r1' })
    await ctx1.fiber.restart()

    // Plain rule without rule.lease invoked with request.lease: { maxUses: 1 } (no leaseId).
    const ctx2 = new Context()
    const s2 = new AssistantPolicyService(ctx2, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      rules: [{
        id: 'plain-rule',
        effect: 'allow',
        actions: ['execute'],
      }],
    })
    const leasedReq: PolicyRequest = { ...baseRequest, lease: { maxUses: 1 } }
    expect(s2.evaluate(leasedReq)).toEqual({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'plain-rule' })
    expect(s2.authorize(leasedReq, { idempotencyKey: 'pl-1' })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'plain-rule',
    })
    // After exhaustion, evaluate() and authorize() both deny with lease-exhausted.
    expect(s2.evaluate(leasedReq)).toEqual({ effect: 'deny', reasonCode: 'lease-exhausted', ruleId: 'plain-rule' })
    expect(s2.authorize(leasedReq, { idempotencyKey: 'pl-2' })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-exhausted',
      ruleId: 'plain-rule',
    })
    // Replay of pl-1 agrees (allow), until revoked.
    expect(s2.evaluate({ ...leasedReq, idempotencyKey: 'pl-1' })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'plain-rule',
    })
    s2.revokeLease('plain-rule')
    expect(s2.evaluate(leasedReq)).toEqual({ effect: 'deny', reasonCode: 'lease-revoked', ruleId: 'plain-rule' })
    expect(s2.authorize(leasedReq, { idempotencyKey: 'pl-1' })).toEqual({
      effect: 'deny',
      reasonCode: 'lease-revoked',
      ruleId: 'plain-rule',
    })
    await ctx2.fiber.restart()
  })

  test('does not leak commitDigest requirement across unrelated resource rules', async () => {
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, {
      databasePath: await databasePath(),
      proposalMaintenanceIntervalMs: 0,
      rules: [
        {
          id: 'goal-allow',
          effect: 'allow',
          actions: ['execute'],
          resource: { kind: 'goal', id: 'g1' },
        },
        {
          id: 'wiki-digested',
          effect: 'allow',
          actions: ['execute'],
          resource: { kind: 'wiki', id: 'w1' },
          commitDigest: 'sha256:wiki-1',
        },
      ],
    })

    // Establish a commit head on goal:g1.
    expect(service.authorize({
      ...baseRequest,
      resource: { kind: 'goal', id: 'g1' },
      commitDigest: 'sha256:goal-1',
      idempotencyKey: 'goal-c1',
    })).toMatchObject({ effect: 'allow', ruleId: 'goal-allow' })
    expect(service.getCommitHead({ kind: 'goal', id: 'g1' })).toBe('sha256:goal-1')

    // Un-digested request on goal:g1 must still succeed (wiki-digested must not force predecessorDigest on goal:g1).
    const plainGoalReq: PolicyRequest = {
      ...baseRequest,
      resource: { kind: 'goal', id: 'g1' },
    }
    expect(service.evaluate(plainGoalReq)).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'goal-allow',
    })
    expect(service.authorize(plainGoalReq, { idempotencyKey: 'goal-plain' })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'goal-allow',
    })

    // Digested request on goal:g1 still requires predecessorDigest.
    const nextDigestedGoalReq: PolicyRequest = {
      ...baseRequest,
      resource: { kind: 'goal', id: 'g1' },
      commitDigest: 'sha256:goal-2',
    }
    expect(service.evaluate(nextDigestedGoalReq)).toEqual({
      effect: 'deny',
      reasonCode: 'predecessor-digest-missing',
      ruleId: 'goal-allow',
    })
    expect(service.authorize(nextDigestedGoalReq, { idempotencyKey: 'goal-c2' })).toEqual({
      effect: 'deny',
      reasonCode: 'predecessor-digest-missing',
      ruleId: 'goal-allow',
    })
    await ctx.fiber.restart()
  })

  test('handles pathological multi-wildcard destination patterns in linear time and enforces PolicyIdempotencyBinding.intentHash', async () => {
    const pathologicalPattern = `https://${'a*'.repeat(30)}b`
    const compiled = compilePolicy([
      {
        id: 'multi-wildcard',
        effect: 'allow',
        actions: ['execute'],
        destinations: [pathologicalPattern, 'https://***api.github.com/***'],
      },
    ])

    const start = performance.now()
    expect(evaluatePolicy(compiled, {
      ...baseRequest,
      destination: `https://${'a'.repeat(900)}c`,
    })).toEqual({
      effect: 'deny',
      reasonCode: 'destination-mismatch',
      ruleId: 'multi-wildcard',
    })
    expect(performance.now() - start).toBeLessThan(100)

    expect(evaluatePolicy(compiled, {
      ...baseRequest,
      destination: 'https://sub.api.github.com/repos/o/r',
    })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'multi-wildcard',
    })

    expect(evaluatePolicy(compiled, {
      ...baseRequest,
      destination: 'https://sub.api.github.com/repos/o/r',
      commitDigest: 'sha256:c1',
      predecessorDigest: 'sha256:c0',
      idempotencyKey: 'idem-h1',
    }, {
      intentHash: 'intent-a',
      idempotencyBindings: {
        'idem-h1': {
          commitDigest: 'sha256:c1',
          predecessorDigest: 'sha256:c0',
          intentHash: 'intent-a',
        },
      },
    })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'multi-wildcard',
    })

    expect(evaluatePolicy(compiled, {
      ...baseRequest,
      destination: 'https://sub.api.github.com/repos/o/r',
      commitDigest: 'sha256:c1',
      predecessorDigest: 'sha256:c0',
      idempotencyKey: 'idem-h1',
    }, {
      intentHash: 'intent-b',
      idempotencyBindings: {
        'idem-h1': {
          commitDigest: 'sha256:c1',
          predecessorDigest: 'sha256:c0',
          intentHash: 'intent-a',
        },
      },
    })).toEqual({
      effect: 'deny',
      reasonCode: 'idempotency-conflict',
      ruleId: undefined,
    })

    // Config rejects whitespace/control-char tokens and unsafe integers directly.
    const dbPath = await databasePath()
    for (const badRule of [
      { id: 'bad-1', effect: 'allow', lease: { leaseId: '  ' } },
      { id: 'bad-2', effect: 'allow', destinations: ['https://api.github.com\n'] },
      { id: 'bad-3', effect: 'allow', monetaryCostCapMicros: Number.MAX_SAFE_INTEGER + 1 },
      { id: 'bad-4', effect: 'allow', commitDigest: '   ' },
    ]) {
      expect(() => AssistantPolicyService.Config({
        databasePath: dbPath,
        rules: [badRule as never],
      })).toThrow()
    }
  })

  test('enforces cumulative monetaryCostCapMicros across authorize() calls and restarts without double-charging idempotent replays', async () => {
    const dbPath = await databasePath()
    const rules: PolicyRule[] = [{
      id: 'cost-capped-rule',
      effect: 'allow',
      actions: ['execute'],
      resource: { kind: 'network', id: 'paid-api' },
      monetaryCostCapMicros: 1_000,
    }]
    const paidRequest = (estimatedCostMicros: number): PolicyRequest => ({
      ...baseRequest,
      resource: { kind: 'network', id: 'paid-api' },
      estimatedCostMicros,
    })

    const ctx1 = new Context()
    const s1 = new AssistantPolicyService(ctx1, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules })

    // 1. First authorize consumes 600 of 1000.
    expect(s1.authorize(paidRequest(600), { idempotencyKey: 'cost-k1' })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'cost-capped-rule',
    })

    // 2. Idempotent replay of cost-k1 succeeds without double-charging.
    expect(s1.authorize(paidRequest(600), { idempotencyKey: 'cost-k1' })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'cost-capped-rule',
    })

    // 3. Second distinct key requesting 600 exceeds 1000 -> denied (monetary-cost-exceeded) and does not charge.
    expect(s1.authorize(paidRequest(600), { idempotencyKey: 'cost-k2' })).toEqual({
      effect: 'deny',
      reasonCode: 'monetary-cost-exceeded',
      ruleId: 'cost-capped-rule',
    })
    expect(s1.evaluate(paidRequest(600))).toEqual({
      effect: 'deny',
      reasonCode: 'monetary-cost-exceeded',
      ruleId: 'cost-capped-rule',
    })

    // 4. Remaining 400 succeeds, bringing cumulative spent to 1000.
    expect(s1.authorize(paidRequest(400), { idempotencyKey: 'cost-k3' })).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'cost-capped-rule',
    })
    await ctx1.fiber.restart()

    // 5. Persisted cumulative spend survives restart: even 1 micro is denied, while 0 micros & replays still work.
    const ctx2 = new Context()
    const s2 = new AssistantPolicyService(ctx2, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules })
    expect(s2.authorize(paidRequest(1), { idempotencyKey: 'cost-k4' })).toEqual({
      effect: 'deny',
      reasonCode: 'monetary-cost-exceeded',
      ruleId: 'cost-capped-rule',
    })
    expect(s2.authorize(paidRequest(600), { idempotencyKey: 'cost-k1' }).effect).toBe('allow')
    expect(s2.authorize(paidRequest(0), { idempotencyKey: 'cost-k5' }).effect).toBe('allow')
    await ctx2.fiber.restart()
  })

  test('forwards WP08 AuthorizationOptions through authorizeAgent, authorizeAgentForPrincipal, and evaluateAgent', async () => {
    const dbPath = await databasePath()
    const now = Date.now()
    const rules: PolicyRule[] = [{
      id: 'agent-wp08-rule',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'action:http:g1' },
      lease: { leaseId: 'agent-lease-1', expiresAtMs: now + 60_000, maxUses: 2 },
      destinations: ['https://api.example.test/v1/*'],
      maxSensitivity: 'internal',
      monetaryCostCapMicros: 1_000,
    }]
    const ctx = new Context()
    const service = new AssistantPolicyService(ctx, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules })
    const agent = makeAgent('agent-wp08-sess', 'primary', '/work/alpha')
    const resource = { kind: 'tool' as const, id: 'action:http:g1' }
    const unbind = service.bindInitiator(agent, 'foreground', 'owner-principal-1')
    try {
      // Missing estimatedCostMicros/destination/sensitivity still fail closed
      expect(service.evaluateAgent(agent, 'execute', resource)).toEqual({
        effect: 'deny',
        reasonCode: 'destination-missing',
        ruleId: 'agent-wp08-rule',
      })
      expect(service.authorizeAgent(agent, 'execute', resource, { idempotencyKey: 'missing-wp08' })).toEqual({
        effect: 'deny',
        reasonCode: 'destination-missing',
        ruleId: 'agent-wp08-rule',
      })

      // evaluateAgent checks WP08 fields without consuming lease or cost
      expect(service.evaluateAgent(agent, 'execute', resource, {
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'internal',
        estimatedCostMicros: 600,
      })).toMatchObject({ effect: 'allow', ruleId: 'agent-wp08-rule' })
      expect(service.evaluateAgent(agent, 'execute', resource, {
        destination: 'https://evil.example.test/v1/items',
        sensitivity: 'internal',
        estimatedCostMicros: 600,
      })).toEqual({ effect: 'deny', reasonCode: 'destination-mismatch', ruleId: 'agent-wp08-rule' })
      expect(service.evaluateAgent(agent, 'execute', resource, {
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'restricted',
        estimatedCostMicros: 600,
      })).toEqual({ effect: 'deny', reasonCode: 'sensitivity-exceeded', ruleId: 'agent-wp08-rule' })

      // authorizeAgent consumes 600 micros + 1 lease use
      expect(service.authorizeAgent(agent, 'execute', resource, {
        idempotencyKey: 'agent-k1',
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'public',
        estimatedCostMicros: 600,
        commitDigest: 'a'.repeat(64),
      })).toMatchObject({ effect: 'allow', ruleId: 'agent-wp08-rule' })

      // Idempotent replay of agent-k1 does not double-charge lease or cost
      expect(service.authorizeAgent(agent, 'execute', resource, {
        idempotencyKey: 'agent-k1',
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'public',
        estimatedCostMicros: 600,
        commitDigest: 'a'.repeat(64),
      })).toMatchObject({ effect: 'allow', ruleId: 'agent-wp08-rule' })

      // Excess cost denied by authorizeAgentForPrincipal without consuming 2nd lease use
      expect(service.authorizeAgentForPrincipal(agent, 'execute', resource, {
        principal: 'owner-principal-1',
        idempotencyKey: 'agent-k-excess',
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'internal',
        estimatedCostMicros: 500,
        commitDigest: 'b'.repeat(64),
        predecessorDigest: 'a'.repeat(64),
      })).toEqual({
        effect: 'deny',
        reasonCode: 'monetary-cost-exceeded',
        ruleId: 'agent-wp08-rule',
      })

      // Remaining 400 micros succeeds via authorizeAgentForPrincipal (2nd lease use)
      expect(service.authorizeAgentForPrincipal(agent, 'execute', resource, {
        principal: 'owner-principal-1',
        idempotencyKey: 'agent-k2',
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'internal',
        estimatedCostMicros: 400,
        commitDigest: 'b'.repeat(64),
        predecessorDigest: 'a'.repeat(64),
      })).toMatchObject({ effect: 'allow', ruleId: 'agent-wp08-rule' })

      // 3rd call hits lease-exhausted
      expect(service.authorizeAgent(agent, 'execute', resource, {
        idempotencyKey: 'agent-k3',
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'public',
        estimatedCostMicros: 0,
        commitDigest: 'c'.repeat(64),
        predecessorDigest: 'b'.repeat(64),
      })).toEqual({
        effect: 'deny',
        reasonCode: 'lease-exhausted',
        ruleId: 'agent-wp08-rule',
      })

      // Request-supplied lease is also forwarded
      expect(service.evaluateAgent(agent, 'execute', resource, {
        destination: 'https://api.example.test/v1/items',
        sensitivity: 'public',
        estimatedCostMicros: 0,
        lease: { leaseId: 'other-lease' },
      })).toEqual({
        effect: 'deny',
        reasonCode: 'lease-mismatch',
        ruleId: 'agent-wp08-rule',
      })
    } finally {
      unbind()
      await ctx.fiber.restart()
    }
  })

  test('atomically rolls back pre-dispatch authorizations across lease, cost cap, budget, commit head, and idempotency while preserving user_version=7', async () => {
    const dbPath = await databasePath()
    const rules: PolicyRule[] = [{
      id: 'rb-rule',
      effect: 'allow',
      actions: ['execute'],
      resource: { kind: 'goal', id: 'rb-goal' },
      lease: { leaseId: 'rb-lease', maxUses: 1 },
      monetaryCostCapMicros: 1_000,
      budget: { id: 'ops', amount: 1 },
    }]
    const budgets = [{ id: 'ops', metric: 'ops', limit: 1, periodMs: 60_000, scope: 'global' as const }]

    const req = (commitDigest: string, estimatedCostMicros: number, predecessorDigest?: string): PolicyRequest => ({
      ...baseRequest,
      resource: { kind: 'goal', id: 'rb-goal' },
      commitDigest,
      ...(predecessorDigest === undefined ? {} : { predecessorDigest }),
      estimatedCostMicros,
    })

    const ctx1 = new Context()
    const s1 = new AssistantPolicyService(ctx1, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules, budgets })

    const d1 = s1.authorize(req('sha256:c1', 800), { idempotencyKey: 'rb-k1' })
    expect(d1).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'rb-rule',
      budget: { id: 'ops', amount: 1 },
      lease: { leaseId: 'rb-lease', maxUses: 1 },
    })
    expect(d1.decisionId).toBeTypeOf('string')
    expect(s1.getLeaseState('rb-lease')?.uses).toBe(1)
    expect(s1.getCommitHead({ kind: 'goal', id: 'rb-goal' })).toBe('sha256:c1')

    // Mismatched bindings must NOT roll back
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k1', decisionId: 'wrong-id' })).toBe(false)
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k1', ruleId: 'other-rule' })).toBe(false)
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k1', leaseId: 'other-lease' })).toBe(false)
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k1', estimatedCostMicros: 799 })).toBe(false)
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k1', commitDigest: 'sha256:other' })).toBe(false)
    expect(s1.getLeaseState('rb-lease')?.uses).toBe(1)

    // Matching rollback reverts lease, cost cap, budget, commit head, and idempotency atomically
    expect(s1.rollbackPreDispatchAuthorization({
      idempotencyKey: 'rb-k1',
      decisionId: d1.decisionId,
      ruleId: 'rb-rule',
      leaseId: 'rb-lease',
      estimatedCostMicros: 800,
      commitDigest: 'sha256:c1',
    })).toBe(true)
    expect(s1.getLeaseState('rb-lease')?.uses).toBe(0)
    expect(s1.getCommitHead({ kind: 'goal', id: 'rb-goal' })).toBeUndefined()

    // Second rollback on same key is a no-op (never double-decrements)
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k1' })).toBe(false)
    expect(s1.getLeaseState('rb-lease')?.uses).toBe(0)

    // Retry with the SAME idempotencyKey succeeds, then roll back again and retry with a NEW key
    const d1Retry = s1.authorize(req('sha256:c1', 800), { idempotencyKey: 'rb-k1' })
    expect(d1Retry.effect).toBe('allow')
    expect(s1.getLeaseState('rb-lease')?.uses).toBe(1)
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k1', decisionId: d1Retry.decisionId })).toBe(true)

    const d2 = s1.authorize(req('sha256:c2', 900), { idempotencyKey: 'rb-k2' })
    expect(d2.effect).toBe('allow')
    expect(s1.getLeaseState('rb-lease')?.uses).toBe(1)
    expect(s1.getCommitHead({ kind: 'goal', id: 'rb-goal' })).toBe('sha256:c2')

    // Replaying rb-k2 invalidates pre-dispatch rollback eligibility (fails closed)
    const d2Replay = s1.authorize(req('sha256:c2', 900), { idempotencyKey: 'rb-k2' })
    expect(d2Replay.effect).toBe('allow')
    expect(d2Replay.decisionId).toBeUndefined()
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k2' })).toBe(false)
    expect(s1.getLeaseState('rb-lease')?.uses).toBe(1)

    // Denied authorization cannot be rolled back
    const denied = s1.authorize(req('sha256:c3', 100, 'sha256:c2'), { idempotencyKey: 'rb-k3' })
    expect(denied).toEqual({ effect: 'deny', reasonCode: 'lease-exhausted', ruleId: 'rb-rule' })
    expect(s1.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k3' })).toBe(false)

    expect(s1.queryAudit({ limit: 50 }).some(e => e.action === 'policy.pre-dispatch.rollback' && e.outcome === 'rolled-back')).toBe(true)
    await ctx1.fiber.restart()

    // Restart clears pending rollback window and preserves user_version = 7
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    } finally {
      db.close()
    }
    const ctx2 = new Context()
    const s2 = new AssistantPolicyService(ctx2, { databasePath: dbPath, proposalMaintenanceIntervalMs: 0, rules, budgets })
    expect(s2.rollbackPreDispatchAuthorization({ idempotencyKey: 'rb-k2' })).toBe(false)
    expect(s2.getLeaseState('rb-lease')?.uses).toBe(1)
    await ctx2.fiber.restart()
  })
})
