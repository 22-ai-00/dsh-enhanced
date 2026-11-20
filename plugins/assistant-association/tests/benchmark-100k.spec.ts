import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SOURCE_WEIGHTS,
  buildMemoryIndex,
  computeOwnerScopeKey,
  computePrincipalDigest,
  runHotPathQuery,
  tokenizeAssociationText,
  type HotPathCue,
  type MemoryIndexEdgeInput,
  type MemoryIndexNodeInput,
  type NodeKind,
} from '../src/index.js'

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const EN_ENTITIES = [
  'cgroup.freeze',
  'ack_lost',
  'sqlite_busy',
  'dsh-plugin-setup',
  'wal_checkpoint',
  'oauth_refresh',
  'systemd.slice',
  'oom_killer',
  'tls_handshake',
  'grpc_deadline',
  'ebpf_probe',
  'fd_exhausted',
]

const ZH_ENTITIES = [
  '迁移冻结流程',
  '数据库锁超时',
  '偏好回滚',
  '长连接重连',
  '任务验收门',
  '沙箱隔离策略',
  '后台巡检队列',
  '知识库索引',
]

const KINDS: readonly NodeKind[] = ['memory', 'episode', 'goal', 'work-item', 'automation']

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[idx]!
}

describe('100k nodes / 1M edges hot-path benchmark', () => {
  test('achieves p99 <= 5.0ms at 100,000 nodes and 1,000,000 undirected edges without model calls', () => {
    const rng = mulberry32(0x51a550c1)
    const nodeCount = 100_000
    const edgeCount = 1_000_000
    const nowMs = 1_700_000_000_000

    const ownerKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('bench-owner'),
      principalRecordId: 'pr-bench',
      principalVersion: 1,
      workspace: '/data00/bench-ws',
      agentPreset: 'primary',
    })

    const nodes: MemoryIndexNodeInput[] = []
    for (let i = 0; i < nodeCount; i += 1) {
      const kind = KINDS[i % KINDS.length]!
      const en = EN_ENTITIES[Math.floor(rng() * EN_ENTITIES.length)]!
      const zh = ZH_ENTITIES[Math.floor(rng() * ZH_ENTITIES.length)]!
      const extraTag = `topic_${i % 500}`
      const title = `${kind} #${i} ${en} ${zh} ${extraTag}`
      nodes.push({
        id: `n:${i}`,
        kind,
        sourcePlugin: 'bench',
        sourceRef: `ref:${i}`,
        ownerScopeKey: ownerKey,
        scopeMode: 'workspace',
        workspace: '/data00/bench-ws',
        agentPreset: 'primary',
        trust: 'trusted',
        sensitivity: 'private',
        title,
        entities: i % 10 === 0 ? [en, zh, extraTag] : [extraTag, i % 2 === 0 ? en : zh],
        tokens: tokenizeAssociationText(title),
        expiresAt: null,
        updatedAt: nowMs - Math.floor(rng() * 14 * 86_400_000),
      })
    }

    const edges: MemoryIndexEdgeInput[] = []
    // Build degree-200 hubs for first 100 hub nodes + uniform random edges up to 1,000,000
    const hubCount = 100
    const hubDegree = 200
    for (let h = 0; h < hubCount; h += 1) {
      for (let k = 1; k <= hubDegree; k += 1) {
        const target = (h * 997 + k * 31) % nodeCount
        if (target === h) continue
        edges.push({
          aId: `n:${h}`,
          bId: `n:${target}`,
          edgeType: 'entity',
          weight: 0.3 + rng() * 0.7,
          trust: 'trusted',
          reason: 'entity:hub',
        })
      }
    }

    while (edges.length < edgeCount) {
      const a = Math.floor(rng() * nodeCount)
      const b = (a + 1 + Math.floor(rng() * (nodeCount - 1))) % nodeCount
      edges.push({
        aId: `n:${a}`,
        bId: `n:${b}`,
        edgeType: edges.length % 2 === 0 ? 'cooccur' : 'entity',
        weight: 0.2 + rng() * 0.8,
        trust: 'trusted',
        reason: 'cooccur:bench',
      })
    }

    const index = buildMemoryIndex({ nodes, edges })
    nodes.length = 0
    edges.length = 0
    expect(index.nodeCount).toBe(100_000)
    expect(index.edgeHalfCount).toBe(2_000_000)

    const profile = {
      maxHops: 2,
      hopTopN: 32,
      maxFanoutPerNode: 128,
      maxItems: 8,
      decayHalfLifeMs: 14 * 86_400_000,
      budgetMs: 4.5,
      sourceWeights: DEFAULT_SOURCE_WEIGHTS,
    }
    const filter = {
      ownerScopeKey: ownerKey,
      workspace: '/data00/bench-ws',
      agentPreset: 'primary',
      allowLowTrust: false,
      allowSensitive: false,
      nowMs,
    }

    const querySuites: readonly (readonly HotPathCue[])[] = [
      [{ kind: 'user', text: 'debug cgroup.freeze issue in primary agent', weight: 1.0 }],
      [{ kind: 'user', text: '排查迁移冻结流程与偏好回滚异常', weight: 1.0 }],
      [
        { kind: 'user', text: 'sqlite_busy 导致数据库锁超时', weight: 1.0 },
        { kind: 'goal', text: 'verify wal_checkpoint durability', weight: 0.6 },
      ],
      [{ kind: 'user', text: 'unmatched fallback query about topic_42 and topic_99', weight: 1.0 }],
      [
        { kind: 'user', text: 'ack_lost topic_0 dense hub traversal', weight: 1.0 },
        { kind: 'tool-entity', text: '', entities: ['cgroup.freeze', 'oauth_refresh'], weight: 0.4 },
      ],
    ]

    // Warmup V8 JIT before measuring with the strict 4.5ms budget
    const warmupProfile = { ...profile, budgetMs: 50 }
    for (let w = 0; w < 50; w += 1) {
      const res = runHotPathQuery(
        index,
        querySuites[w % querySuites.length]!,
        filter,
        warmupProfile,
      )
      expect(res.timedOut).toBe(false)
    }

    const samples: number[] = []
    let timedOutCount = 0
    let emptyCount = 0
    const measuredQueries = 500
    for (let q = 0; q < measuredQueries; q += 1) {
      const res = runHotPathQuery(index, querySuites[q % querySuites.length]!, filter, profile)
      samples.push(res.elapsedMs)
      if (res.timedOut) timedOutCount += 1
      if (res.items.length === 0) emptyCount += 1
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const p99 = percentile(sorted, 0.99)

    expect(timedOutCount).toBeLessThanOrEqual(Math.floor(measuredQueries * 0.01))
    expect(emptyCount).toBe(timedOutCount)
    expect(p50).toBeLessThanOrEqual(3.0)
    expect(p95).toBeLessThanOrEqual(5.0)
    expect(p99).toBeLessThanOrEqual(5.0)
  })
})
