import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SOURCE_WEIGHTS,
  buildMemoryIndex,
  computeOwnerScopeKey,
  computePrincipalDigest,
  runHotPathQuery,
  tokenizeAssociationText,
  type MemoryIndexEdgeInput,
  type MemoryIndexNodeInput,
} from '../src/index.js'

describe('hot-path timeout fallback (assoc-timeout)', () => {
  function buildSampleGraph() {
    const nowMs = 1_700_000_000_000
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-timeout'),
      principalRecordId: 'pr-t',
      principalVersion: 1,
      workspace: '/ws/timeout',
      agentPreset: 'primary',
    })

    const nodes: MemoryIndexNodeInput[] = []
    const edges: MemoryIndexEdgeInput[] = []
    for (let i = 0; i < 200; i += 1) {
      const title = `timeout probe cgroup.freeze node ${i}`
      nodes.push({
        id: `n:${i}`,
        kind: 'memory',
        sourcePlugin: 'personal-memory',
        sourceRef: `memory:${i}`,
        ownerScopeKey,
        scopeMode: 'workspace',
        workspace: '/ws/timeout',
        agentPreset: 'primary',
        trust: 'trusted',
        sensitivity: 'private',
        title,
        entities: ['cgroup.freeze'],
        tokens: tokenizeAssociationText(title),
        expiresAt: null,
        updatedAt: nowMs - i * 1000,
      })
      if (i > 0) {
        edges.push({
          aId: 'n:0',
          bId: `n:${i}`,
          edgeType: 'entity',
          weight: 0.8,
          trust: 'trusted',
          reason: 'entity:cgroup.freeze',
        })
      }
    }

    return {
      nowMs,
      ownerScopeKey,
      index: buildMemoryIndex({ nodes, edges }),
    }
  }

  test('returns timedOut: true cleanly when hotPathBudgetMs is 0', () => {
    const { index, ownerScopeKey, nowMs } = buildSampleGraph()
    const res = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check cgroup.freeze', weight: 1.0 }],
      {
        ownerScopeKey,
        workspace: '/ws/timeout',
        agentPreset: 'primary',
        allowLowTrust: false,
        allowSensitive: false,
        nowMs,
      },
      {
        maxHops: 2,
        hopTopN: 32,
        maxFanoutPerNode: 128,
        maxItems: 8,
        decayHalfLifeMs: 14 * 86_400_000,
        budgetMs: 0,
        sourceWeights: DEFAULT_SOURCE_WEIGHTS,
      },
    )

    expect(res.timedOut).toBe(true)
    expect(res.items).toEqual([])
  })

  test('aborts cleanly mid-traversal on deterministic clock jump and leaves scratchpad uncorrupted', () => {
    const { index, ownerScopeKey, nowMs } = buildSampleGraph()
    let calls = 0
    const jumpingClock = () => {
      calls += 1
      return calls <= 5 ? 0 : 12.0
    }

    const timedOutRes = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check cgroup.freeze timeout probe', weight: 1.0 }],
      {
        ownerScopeKey,
        workspace: '/ws/timeout',
        agentPreset: 'primary',
        allowLowTrust: false,
        allowSensitive: false,
        nowMs,
      },
      {
        maxHops: 2,
        hopTopN: 32,
        maxFanoutPerNode: 128,
        maxItems: 8,
        decayHalfLifeMs: 14 * 86_400_000,
        budgetMs: 4.5,
        sourceWeights: DEFAULT_SOURCE_WEIGHTS,
      },
      { clock: jumpingClock },
    )

    expect(timedOutRes.timedOut).toBe(true)
    expect(timedOutRes.items).toEqual([])
    expect(timedOutRes.elapsedMs).toBeGreaterThanOrEqual(4.5)

    // Subsequent query with normal budget succeeds cleanly without scratchpad lock/corruption
    const normalRes = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check cgroup.freeze timeout probe', weight: 1.0 }],
      {
        ownerScopeKey,
        workspace: '/ws/timeout',
        agentPreset: 'primary',
        allowLowTrust: false,
        allowSensitive: false,
        nowMs,
      },
      {
        maxHops: 2,
        hopTopN: 32,
        maxFanoutPerNode: 128,
        maxItems: 8,
        decayHalfLifeMs: 14 * 86_400_000,
        budgetMs: 50,
        sourceWeights: DEFAULT_SOURCE_WEIGHTS,
      },
    )

    expect(normalRes.timedOut).toBe(false)
    expect(normalRes.items.length).toBeGreaterThan(0)
  })
})
