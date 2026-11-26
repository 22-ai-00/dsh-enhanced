import { describe, expect, it } from 'vitest'
import type { PolicyRequest, PolicyRule } from '@dsh-ray/assistant-policy'
import {
  authorizeAgentWithWp08,
  evaluateBrokerWp08Constraints,
  evaluatePolicyWithWp08,
  matchWp08Destination,
  normalizeBrokerWp08Constraints,
  normalizeBrokerWp08RequestContext,
  sensitivityRank,
  type BrokerPolicyServicePort,
  type BrokerWp08Constraints,
} from '../src/broker-policy.ts'

describe('WP08 Policy Alignment (broker-policy.ts)', () => {
  it('orders data sensitivity levels deterministically', () => {
    expect(sensitivityRank('public')).toBeLessThan(sensitivityRank('internal'))
    expect(sensitivityRank('internal')).toBeLessThan(sensitivityRank('confidential'))
    expect(sensitivityRank('confidential')).toBeLessThan(sensitivityRank('restricted'))
  })

  it('enforces lease revocation, expiration, and maxUses fail-closed', () => {
    const now = 1_000_000
    expect(evaluateBrokerWp08Constraints(
      { lease: { leaseId: 'l1', revoked: true, expiresAtMs: now + 60_000, maxUses: 5 } },
      {},
      { leaseUses: 0, spentCostMicros: 0 },
      now,
    )).toMatchObject({ allowed: false, reasonCode: 'lease-revoked' })

    expect(evaluateBrokerWp08Constraints(
      { lease: { leaseId: 'l1', expiresAtMs: now, maxUses: 5 } },
      {},
      { leaseUses: 0, spentCostMicros: 0 },
      now,
    )).toMatchObject({ allowed: false, reasonCode: 'lease-expired' })

    expect(evaluateBrokerWp08Constraints(
      { lease: { leaseId: 'l1', expiresAtMs: now + 60_000, maxUses: 2 } },
      {},
      { leaseUses: 2, spentCostMicros: 0 },
      now,
    )).toMatchObject({ allowed: false, reasonCode: 'lease-exhausted' })

    expect(evaluateBrokerWp08Constraints(
      { lease: { leaseId: 'l1', expiresAtMs: now + 60_000, maxUses: 2 } },
      {},
      { leaseUses: 1, spentCostMicros: 0 },
      now,
    )).toMatchObject({ allowed: true, reasonCode: 'allowed' })
  })

  it('enforces destination matching without host confusion', () => {
    expect(matchWp08Destination('https://api.example.com/v1/*', 'https://api.example.com/v1/items')).toBe(true)
    expect(matchWp08Destination('https://api.example.com/v1/*', 'https://api.example.com.evil.test/v1/items')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/*', 'https://api.example.com/v10/items')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1', 'https://api.example.com/v1/items')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1', 'https://api.example.com.evil.test/v1/items')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1', 'https://api.example.com/v10/items')).toBe(false)
    expect(matchWp08Destination('lark://tenant-1/chat_id/*', 'lark://tenant-1/chat_id/oc_123')).toBe(true)

    expect(evaluateBrokerWp08Constraints(
      { destinations: ['https://api.example.com/v1/*'] },
      { destination: 'https://api.example.com/v2/items' },
    )).toMatchObject({ allowed: false, reasonCode: 'destination-mismatch' })

    expect(evaluateBrokerWp08Constraints(
      { destinations: [] },
      { destination: 'https://api.example.com/v1/items' },
    )).toMatchObject({ allowed: false, reasonCode: 'destination-mismatch' })
  })

  it('enforces exact HTTP path and query pinning unless explicit * wildcards are present, and rejects userinfo/fragments', () => {
    expect(matchWp08Destination('https://api.example.com/v1/report', 'https://api.example.com/v1/report')).toBe(true)
    expect(matchWp08Destination('https://api.example.com/v1/report', 'https://api.example.com/v1/report/extra')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report', 'https://api.example.com/v1/report?mode=delete')).toBe(false)

    expect(matchWp08Destination('https://api.example.com/v1/report?mode=read', 'https://api.example.com/v1/report?mode=read')).toBe(true)
    expect(matchWp08Destination('https://api.example.com/v1/report?mode=read', 'https://api.example.com/v1/report?mode=delete')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report?mode=read', 'https://api.example.com/v1/report')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report?mode=read', 'https://api.example.com/v1/report/extra?mode=read')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/?mode=read', 'https://api.example.com/admin?mode=delete')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/?mode=read', 'https://api.example.com/admin?mode=read')).toBe(false)

    expect(matchWp08Destination('https://api.example.com/v1/report?mode=*', 'https://api.example.com/v1/report?mode=read')).toBe(true)
    expect(matchWp08Destination('https://api.example.com/v1/report?mode=*', 'https://api.example.com/v1/report?other=1')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report?mode=*', 'https://api.example.com/v1/report')).toBe(false)

    expect(matchWp08Destination('https://api.example.com/v1/report/*', 'https://api.example.com/v1/report/a')).toBe(true)
    expect(matchWp08Destination('https://api.example.com/v1/report/*', 'https://api.example.com/v1/report/a?x=1')).toBe(true)
    expect(matchWp08Destination('https://api.example.com/v1/report/*', 'https://api.example.com/v1/report')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report*', 'https://api.example.com/v1/report')).toBe(true)
    expect(matchWp08Destination('https://api.example.com/v1/report*', 'https://api.example.com/v1/report/a')).toBe(true)

    expect(matchWp08Destination('https://user:pass@api.example.com/v1/report', 'https://user:pass@api.example.com/v1/report')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report', 'https://user:pass@api.example.com/v1/report')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report', 'https://@api.example.com/v1/report')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report#frag', 'https://api.example.com/v1/report#frag')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report', 'https://api.example.com/v1/report#frag')).toBe(false)
    expect(matchWp08Destination('https://api.example.com/v1/report', 'https://api.example.com/v1/report#')).toBe(false)
  })

  it('rejects invalid request sensitivity with invalid-input even when maxSensitivity is omitted', () => {
    expect(evaluateBrokerWp08Constraints(undefined, { sensitivity: 'bogus' as never }))
      .toMatchObject({ allowed: false, reasonCode: 'invalid-input' })
    expect(evaluateBrokerWp08Constraints({ lease: { maxUses: 2 } }, { sensitivity: 'bogus' as never }))
      .toMatchObject({ allowed: false, reasonCode: 'invalid-input' })
  })

  it('enforces maxSensitivity, monetaryCostCapMicros, commitDigest, and predecessorDigest', () => {
    const digestA = 'a'.repeat(64)
    const digestB = 'b'.repeat(64)
    const constraints: BrokerWp08Constraints = normalizeBrokerWp08Constraints({
      maxSensitivity: 'internal',
      monetaryCostCapMicros: 1_000,
      commitDigest: digestA,
      predecessorDigest: digestB,
      idempotencyKey: 'idem-1',
    })

    expect(evaluateBrokerWp08Constraints(constraints, {
      sensitivity: 'confidential',
      estimatedCostMicros: 100,
      commitDigest: digestA,
      predecessorDigest: digestB,
    }, { leaseUses: 0, spentCostMicros: 0, lastSettledCommitDigest: digestB })).toMatchObject({ allowed: false, reasonCode: 'sensitivity-exceeded' })

    expect(evaluateBrokerWp08Constraints(constraints, {
      sensitivity: 'internal',
      estimatedCostMicros: 201,
      commitDigest: digestA,
      predecessorDigest: digestB,
    }, { leaseUses: 0, spentCostMicros: 800, lastSettledCommitDigest: digestB })).toMatchObject({ allowed: false, reasonCode: 'cost-cap-exceeded' })

    expect(evaluateBrokerWp08Constraints(constraints, {
      sensitivity: 'internal',
      estimatedCostMicros: 100,
      commitDigest: 'f'.repeat(64),
      predecessorDigest: digestB,
    }, { leaseUses: 0, spentCostMicros: 800, lastSettledCommitDigest: digestB })).toMatchObject({ allowed: false, reasonCode: 'commit-digest-mismatch' })

    expect(evaluateBrokerWp08Constraints(constraints, {
      sensitivity: 'internal',
      estimatedCostMicros: 100,
      commitDigest: digestA,
      predecessorDigest: digestB,
    }, { leaseUses: 0, spentCostMicros: 800, lastSettledCommitDigest: 'c'.repeat(64) })).toMatchObject({ allowed: false, reasonCode: 'predecessor-digest-mismatch' })

    expect(evaluateBrokerWp08Constraints(constraints, {
      sensitivity: 'internal',
      estimatedCostMicros: 100,
      commitDigest: digestA,
    }, { leaseUses: 0, spentCostMicros: 800, lastSettledCommitDigest: digestB })).toMatchObject({ allowed: false, reasonCode: 'predecessor-digest-mismatch' })

    expect(evaluateBrokerWp08Constraints(constraints, normalizeBrokerWp08RequestContext({
      sensitivity: 'public',
      estimatedCostMicros: 200,
      commitDigest: digestA,
      predecessorDigest: digestB,
    }), { leaseUses: 0, spentCostMicros: 800, lastSettledCommitDigest: digestB })).toMatchObject({ allowed: true, reasonCode: 'allowed' })
  })

  it('forwards WP08 context structurally to assistant-policy port without excess-property errors', () => {
    const baseRequest: PolicyRequest = {
      subject: { kind: 'agent', id: 'primary', workspace: '/ws', principal: 'owner-1' },
      action: 'execute',
      resource: { kind: 'tool', id: 'action:http:grant-1' },
      context: { initiator: 'foreground' },
    }
    const baseRule: PolicyRule = { id: 'allow-1', effect: 'allow' }
    expect(baseRule.effect).toBe('allow')

    const seen: unknown[] = []
    const port: BrokerPolicyServicePort = {
      evaluate(req) { seen.push(req); return { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-1' } },
      authorize(req) { seen.push(req); return { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-1' } },
      evaluateAgent() { return { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-1' } },
      authorizeAgent(_agent, _action, _resource, opts) { seen.push(opts); return { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-1' } },
    }

    const evalRes = evaluatePolicyWithWp08(
      port,
      { ...baseRequest, destination: 'https://api.example.test/v1/ok', sensitivity: 'internal', estimatedCostMicros: 50 },
      { destinations: ['https://api.example.test/v1/*'], maxSensitivity: 'internal', monetaryCostCapMicros: 100 },
    )
    expect(evalRes.effect).toBe('allow')

    const authRes = authorizeAgentWithWp08(
      port,
      undefined,
      'execute',
      baseRequest.resource,
      { idempotencyKey: 'k1', destination: 'https://api.example.test/v1/ok', sensitivity: 'confidential', estimatedCostMicros: 50 },
      { destinations: ['https://api.example.test/v1/*'], maxSensitivity: 'internal', monetaryCostCapMicros: 100 },
    )
    expect(authRes.effect).toBe('deny')
    expect(authRes.wp08.reasonCode).toBe('sensitivity-exceeded')
    expect(seen).toHaveLength(1)
  })

  it('rejects invalid estimatedCostMicros with invalid-input even when constraints or monetaryCostCapMicros are omitted', () => {
    for (const invalidCost of [Number.NaN, 1.5, -5, -0, Number.POSITIVE_INFINITY]) {
      expect(evaluateBrokerWp08Constraints(undefined, { estimatedCostMicros: invalidCost }))
        .toMatchObject({ allowed: false, reasonCode: 'invalid-input' })
      expect(evaluateBrokerWp08Constraints({ lease: { maxUses: 2 } }, { estimatedCostMicros: invalidCost }))
        .toMatchObject({ allowed: false, reasonCode: 'invalid-input' })
    }
    expect(evaluateBrokerWp08Constraints(undefined, { estimatedCostMicros: 0 }))
      .toMatchObject({ allowed: true, reasonCode: 'allowed' })
    expect(evaluateBrokerWp08Constraints({ lease: { maxUses: 2 } }, { estimatedCostMicros: 100 }))
      .toMatchObject({ allowed: true, reasonCode: 'allowed' })
  })

  it('rejects spentCostMicros safe-integer overflow and unsafe monetaryCostCapMicros or -0 usage with invalid-input', () => {
    expect(evaluateBrokerWp08Constraints(
      undefined,
      { estimatedCostMicros: 1 },
      { leaseUses: 0, spentCostMicros: Number.MAX_SAFE_INTEGER },
    )).toMatchObject({ allowed: false, reasonCode: 'invalid-input' })

    expect(evaluateBrokerWp08Constraints(
      { lease: { maxUses: 5 } },
      { estimatedCostMicros: 1 },
      { leaseUses: 1, spentCostMicros: Number.MAX_SAFE_INTEGER },
    )).toMatchObject({ allowed: false, reasonCode: 'invalid-input' })

    expect(evaluateBrokerWp08Constraints(
      { monetaryCostCapMicros: Number.MAX_SAFE_INTEGER + 10 },
      { estimatedCostMicros: 1 },
      { leaseUses: 0, spentCostMicros: Number.MAX_SAFE_INTEGER },
    )).toMatchObject({ allowed: false, reasonCode: 'invalid-input' })

    expect(evaluateBrokerWp08Constraints(
      { monetaryCostCapMicros: Number.MAX_SAFE_INTEGER + 10 },
      { estimatedCostMicros: 0 },
      { leaseUses: 0, spentCostMicros: 0 },
    )).toMatchObject({ allowed: false, reasonCode: 'invalid-input' })

    expect(evaluateBrokerWp08Constraints(
      { monetaryCostCapMicros: -0 },
      { estimatedCostMicros: 0 },
      { leaseUses: 0, spentCostMicros: 0 },
    )).toMatchObject({ allowed: false, reasonCode: 'invalid-input' })

    expect(evaluateBrokerWp08Constraints(
      undefined,
      { estimatedCostMicros: 0 },
      { leaseUses: 0, spentCostMicros: -0 },
    )).toMatchObject({ allowed: false, reasonCode: 'invalid-input' })

    expect(evaluateBrokerWp08Constraints(
      { lease: { maxUses: 5 } },
      { estimatedCostMicros: 0 },
      { leaseUses: 1, spentCostMicros: Number.MAX_SAFE_INTEGER },
    )).toMatchObject({ allowed: true, reasonCode: 'allowed' })
  })
})
