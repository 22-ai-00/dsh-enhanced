import { describe, expect, test } from 'vitest'
import {
  buildMemoryIndex,
  buildSharedEntityEdges,
  computeOwnerScopeKey,
  computePrincipalDigest,
  Config,
  DEFAULT_SOURCE_WEIGHTS,
  extractEntities,
  name,
  normalizeConfig,
  runHotPathQuery,
  tokenizeAssociationText,
  version,
} from '../src/index.js'

describe('assistant-association config & core indexing', () => {
  test('exports expected plugin identity and aligns version', () => {
    expect(name).toBe('dsh-enhanced-assistant-association')
    expect(version).toBe('0.1.79')
  })

  test('validates synchronous Standard-Schema Config defaults and bounds', () => {
    const cfg = normalizeConfig({ databasePath: ':memory:' })
    expect(cfg.enabled).toBe(true)
    expect(cfg.localOnly).toBe(true)
    expect(cfg.holdoutRateBps).toBe(1250)
    expect(cfg.hotPathBudgetMs).toBe(4.5)
    expect(cfg.maxItems).toBe(8)
    expect(cfg.minItems).toBe(5)
    expect(cfg.maxContextTokens).toBe(400)
    expect(cfg.maxHops).toBe(2)
    expect(cfg.dreaming.enabled).toBe(false)
    expect(cfg.intakeSignal.enabled).toBe(false)
    expect(cfg.webLearning.enabled).toBe(false)

    expect(() => Config({ unknownField: 1 } as never)).toThrow(/unknown config field/)
    expect(() => Config({ holdoutRateBps: 999 })).toThrow()
    expect(() => Config({ holdoutRateBps: 1501 })).toThrow()
    expect(() => Config({ maxItems: 5, minItems: 6 })).toThrow(/minItems/)
    expect(() => Config({ databasePath: 'relative/db.sqlite' })).toThrow(/databasePath/)
  })

  test('tokenizes mixed CJK and English text matching personal-memory semantics', () => {
    const tokens = tokenizeAssociationText('SQLite_busy 错误处理与迁移冻结流程')
    expect(tokens).toContain('sqlite_busy')
    expect(tokens).toContain('迁')
    expect(tokens).toContain('迁移')
    expect(tokens).toContain('冻结')
    expect(tokens).toContain('流程')
  })

  test('extracts deterministic entities and builds shared-entity edges', () => {
    const e1 = extractEntities('Fix cgroup.freeze timeout and ACK_LOST during 迁移冻结流程')
    expect(e1).toContain('cgroup.freeze')
    expect(e1).toContain('ack_lost')
    expect(e1).toContain('迁移冻结流程')

    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-1'),
      principalRecordId: 'pr-1',
      principalVersion: 1,
      workspace: '/tmp/ws',
      agentPreset: 'primary',
    })
    const { edges, derivedRefs } = buildSharedEntityEdges(
      {
        id: 'n1',
        sourceVersion: 1,
        ownerScopeKey,
        trust: 'trusted',
        entities: ['cgroup.freeze', 'ack_lost'],
        updatedAt: 1000,
      },
      [
        {
          id: 'n2',
          sourceVersion: 2,
          ownerScopeKey,
          trust: 'trusted',
          entities: ['cgroup.freeze'],
          updatedAt: 900,
        },
        {
          id: 'n3',
          sourceVersion: 1,
          ownerScopeKey: '0'.repeat(64),
          trust: 'trusted',
          entities: ['cgroup.freeze'],
          updatedAt: 900,
        },
      ],
    )
    expect(edges).toHaveLength(1)
    expect(edges[0]!.aId).toBe('n1')
    expect(edges[0]!.bId).toBe('n2')
    expect(derivedRefs).toHaveLength(2)
  })

  test('runs AC boundary checks, BM25 fallback, 2-hop spreading, and scope/trust/tombstone filters', () => {
    const nowMs = 1_700_000_000_000
    const ownerA = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-a'),
      principalRecordId: 'pr-a',
      principalVersion: 1,
      workspace: '/ws/a',
      agentPreset: 'primary',
    })
    const ownerB = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-b'),
      principalRecordId: 'pr-b',
      principalVersion: 1,
      workspace: '/ws/a',
      agentPreset: 'primary',
    })

    const index = buildMemoryIndex({
      nodes: [
        {
          id: 'a:m-1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:1',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/a',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'cgroup.freeze watchdog recovery note',
          entities: ['cgroup.freeze'],
          tokens: tokenizeAssociationText('cgroup.freeze watchdog recovery note'),
          expiresAt: null,
          updatedAt: nowMs - 1_000,
        },
        {
          id: 'a:g-2',
          kind: 'goal',
          sourcePlugin: 'assistant-goals',
          sourceRef: 'goal:2',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/a',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Stabilize container cgroup lifecycle',
          entities: ['container_lifecycle'],
          tokens: tokenizeAssociationText('Stabilize container cgroup lifecycle'),
          expiresAt: null,
          updatedAt: nowMs - 2_000,
        },
        {
          id: 'a:e-3',
          kind: 'episode',
          sourcePlugin: 'assistant-delivery',
          sourceRef: 'foreground-turn:3',
          ownerScopeKey: ownerA,
          scopeMode: 'user-global',
          workspace: '/ws/other',
          agentPreset: 'other',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Resolved linux namespace freeze issue',
          entities: ['namespace_freeze'],
          tokens: tokenizeAssociationText('Resolved linux namespace freeze issue'),
          expiresAt: null,
          updatedAt: nowMs - 3_000,
        },
        {
          id: 'a:m-bm25',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:bm25',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/a',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: '数据库锁超时处理手册',
          entities: [],
          tokens: tokenizeAssociationText('数据库锁超时处理手册'),
          expiresAt: null,
          updatedAt: nowMs - 500,
        },
        {
          id: 'a:m-sensitive',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:sensitive',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/a',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'sensitive',
          title: 'cgroup.freeze secret token',
          entities: ['cgroup.freeze'],
          tokens: tokenizeAssociationText('cgroup.freeze secret token'),
          expiresAt: null,
          updatedAt: nowMs,
        },
        {
          id: 'a:m-other-owner',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:other',
          ownerScopeKey: ownerB,
          scopeMode: 'workspace',
          workspace: '/ws/a',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'cgroup.freeze belonging to ownerB',
          entities: ['cgroup.freeze'],
          tokens: tokenizeAssociationText('cgroup.freeze belonging to ownerB'),
          expiresAt: null,
          updatedAt: nowMs,
        },
      ],
      edges: [
        {
          aId: 'a:m-1',
          bId: 'a:g-2',
          edgeType: 'cooccur',
          weight: 0.8,
          trust: 'trusted',
          reason: 'cooccur:session',
        },
        {
          aId: 'a:g-2',
          bId: 'a:e-3',
          edgeType: 'entity',
          weight: 0.7,
          trust: 'trusted',
          reason: 'entity:namespace',
        },
      ],
      synonyms: [{ surface: 'freeze_watchdog', canonicalEntity: 'cgroup.freeze' }],
    })

    const profile = {
      maxHops: 2,
      hopTopN: 32,
      maxFanoutPerNode: 128,
      maxItems: 8,
      decayHalfLifeMs: 14 * 86_400_000,
      budgetMs: 10,
      sourceWeights: DEFAULT_SOURCE_WEIGHTS,
    }
    const filter = {
      ownerScopeKey: ownerA,
      workspace: '/ws/a',
      agentPreset: 'primary',
      allowLowTrust: false,
      allowSensitive: false,
      nowMs,
    }

    // Word boundary check: "mycgroup.freezer" should NOT trigger AC match on "cgroup.freeze"
    const boundaryRes = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'mycgroup.freezer', weight: 1.0 }],
      filter,
      profile,
    )
    expect(boundaryRes.items.some((i) => i.reason === 'entity:cgroup.freeze')).toBe(false)

    // Exact AC + 2-hop spreading + owner/sensitivity isolation
    const hitRes = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'investigate cgroup.freeze failure', weight: 1.0 }],
      filter,
      profile,
    )
    expect(hitRes.timedOut).toBe(false)
    const ids = hitRes.items.map((i) => i.id)
    expect(ids).toContain('a:m-1')
    expect(ids).toContain('a:g-2')
    expect(ids).toContain('a:e-3')
    expect(ids).not.toContain('a:m-sensitive')
    expect(ids).not.toContain('a:m-other-owner')

    // Synonym surface match
    const synRes = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check freeze_watchdog status', weight: 1.0 }],
      filter,
      profile,
    )
    expect(synRes.items[0]?.id).toBe('a:m-1')

    // BM25 unmatched CJK fallback
    const bm25Res = runHotPathQuery(
      index,
      [{ kind: 'user', text: '排查数据库锁超时', weight: 1.0 }],
      filter,
      profile,
    )
    expect(bm25Res.items.map((i) => i.id)).toContain('a:m-bm25')

    // Synchronous tombstone immediately hides node before index rebuild
    expect(index.tombstoneNodeId('a:m-1')).toBe(true)
    const afterTombstone = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'investigate cgroup.freeze failure', weight: 1.0 }],
      filter,
      profile,
    )
    expect(afterTombstone.items.map((i) => i.id)).not.toContain('a:m-1')
  })
})
