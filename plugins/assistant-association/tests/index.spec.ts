import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import type { TrustedTaskLearningProjectionReceipt } from '@dsh-ray/assistant-evaluation'
import {
  buildMemoryIndex,
  buildSharedEntityEdges,
  computeDeterministicEdgeId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  Config,
  DEFAULT_SOURCE_WEIGHTS,
  extractEntities,
  name,
  normalizeConfig,
  tokenizeAssociationText,
  version,
} from '../src/index.js'
import {
  MAX_WEAK_USE_TEXT_CHARS,
  clampEdgeWeight,
  classifyEvaluationCorrection,
  computeExponentialDecayWeight,
  computeHebbianUseDelta,
  computeUniqueExposedEntities,
  detectWeakUseNodes,
  selectHop0CoActivationTargets,
} from '../src/hebbian.js'
import { runHotPathQuery } from '../src/hot-path.js'
import { rebuildMemoryIndexEdges } from '../src/index-memory.js'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('assistant-association config & core indexing', () => {
  test('exports expected plugin identity and aligns version', () => {
    expect(name).toBe('dsh-ray-assistant-association')
    expect(version).toBe(manifest.version)
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
    expect(cfg.dreaming.enabled).toBe(true)
    expect(cfg.intakeSignal.enabled).toBe(true)
    expect(cfg.webLearning.enabled).toBe(true)

    const optedOut = normalizeConfig({
      databasePath: ':memory:',
      dreaming: { enabled: false },
      intakeSignal: { enabled: false },
      webLearning: { enabled: false },
    })
    expect(optedOut.dreaming.enabled).toBe(false)
    expect(optedOut.intakeSignal.enabled).toBe(false)
    expect(optedOut.webLearning.enabled).toBe(false)

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

  test('attaches exact Hop 1/2 provenanceEdges and rebuilds CSR edges cleanly', () => {
    const nowMs = 1_700_000_000_000
    const ownerA = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-prov'),
      principalRecordId: 'pr-prov',
      principalVersion: 1,
      workspace: '/ws/prov',
      agentPreset: 'primary',
    })

    const e1Id = computeDeterministicEdgeId('a:m-1', 'a:g-2', 'cooccur')
    const e2Id = computeDeterministicEdgeId('a:g-2', 'a:e-3', 'entity')
    const eAltId = computeDeterministicEdgeId('a:m-1', 'a:w-4', 'hebbian')

    const baseIndex = buildMemoryIndex({
      nodes: [
        {
          id: 'a:m-1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:1',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/prov',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'cgroup.freeze seed note',
          entities: ['cgroup.freeze'],
          tokens: tokenizeAssociationText('cgroup.freeze seed note'),
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
          workspace: '/ws/prov',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Stabilize container lifecycle',
          entities: ['container_lifecycle'],
          tokens: tokenizeAssociationText('Stabilize container lifecycle'),
          expiresAt: null,
          updatedAt: nowMs - 2_000,
        },
        {
          id: 'a:e-3',
          kind: 'episode',
          sourcePlugin: 'assistant-delivery',
          sourceRef: 'foreground-turn:3',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/prov',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Resolved linux namespace outage',
          entities: ['namespace_outage'],
          tokens: tokenizeAssociationText('Resolved linux namespace outage'),
          expiresAt: null,
          updatedAt: nowMs - 3_000,
        },
        {
          id: 'a:w-4',
          kind: 'work-item',
          sourcePlugin: 'assistant-work-items',
          sourceRef: 'work-item:4',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/prov',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Watchdog follow-up task',
          entities: ['watchdog_followup'],
          tokens: tokenizeAssociationText('Watchdog follow-up task'),
          expiresAt: null,
          updatedAt: nowMs - 1_500,
        },
      ],
      edges: [
        {
          edgeId: e1Id,
          aId: 'a:m-1',
          bId: 'a:g-2',
          edgeType: 'cooccur',
          weight: 0.9,
          trust: 'trusted',
          reason: 'cooccur:session',
        },
        {
          edgeId: e2Id,
          aId: 'a:g-2',
          bId: 'a:e-3',
          edgeType: 'entity',
          weight: 0.8,
          trust: 'trusted',
          reason: 'entity:namespace',
        },
      ],
    })

    expect(baseIndex.nodeEntities[0]).toEqual(['cgroup.freeze'])
    expect(baseIndex.edgeIds).toContain(e1Id)
    expect(baseIndex.edgeIds).toContain(e2Id)

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
      workspace: '/ws/prov',
      agentPreset: 'primary',
      allowLowTrust: false,
      allowSensitive: false,
      nowMs,
    }

    const res1 = runHotPathQuery(
      baseIndex,
      [{ kind: 'user', text: 'investigate cgroup.freeze failure', weight: 1.0 }],
      filter,
      profile,
    )
    const item0 = res1.items.find((i) => i.id === 'a:m-1')
    const item1 = res1.items.find((i) => i.id === 'a:g-2')
    const item2 = res1.items.find((i) => i.id === 'a:e-3')
    expect(item0?.hop).toBe(0)
    expect(item0?.provenanceEdges).toBeUndefined()
    expect(item1?.hop).toBe(1)
    expect(item1?.provenanceEdges).toEqual([
      { edgeId: e1Id, aId: 'a:g-2', bId: 'a:m-1', edgeType: 'cooccur' },
    ])
    expect(item2?.hop).toBe(2)
    expect(item2?.provenanceEdges).toEqual([
      { edgeId: e1Id, aId: 'a:g-2', bId: 'a:m-1', edgeType: 'cooccur' },
      { edgeId: e2Id, aId: 'a:e-3', bId: 'a:g-2', edgeType: 'entity' },
    ])

    // Tombstone one node before rebuilding edges to verify tombstone copy & isolation
    expect(baseIndex.tombstoneNodeId('a:e-3')).toBe(true)

    const rebuilt = rebuildMemoryIndexEdges(
      baseIndex,
      [
        {
          edgeId: eAltId,
          aId: 'a:m-1',
          bId: 'a:w-4',
          edgeType: 'hebbian',
          weight: 1.6,
          trust: 'trusted',
          reason: 'hebbian:strong',
        },
        {
          edgeId: e1Id,
          aId: 'a:m-1',
          bId: 'a:g-2',
          edgeType: 'cooccur',
          weight: 0.4,
          trust: 'trusted',
          reason: 'cooccur:session',
        },
      ],
      { buildEpoch: 9, builtAt: nowMs + 500, maxFanoutPerNode: 1 },
    )

    expect(rebuilt.buildEpoch).toBe(9)
    expect(rebuilt.builtAt).toBe(nowMs + 500)
    expect(rebuilt.ac).toBe(baseIndex.ac)
    expect(rebuilt.bm25).toBe(baseIndex.bm25)
    expect(rebuilt.nodeEntities).toBe(baseIndex.nodeEntities)
    expect(rebuilt.nodeIds).toBe(baseIndex.nodeIds)
    // Prior tombstone copied, new tombstone isolated
    expect(rebuilt.nodeTombstoned[2]).toBe(1)
    expect(rebuilt.tombstoneNodeId('a:w-4')).toBe(true)
    expect(baseIndex.nodeTombstoned[3]).toBe(0)

    // Un-tombstone a:w-4 on a fresh edge-only rebuild with full fanout
    const rebuilt2 = rebuildMemoryIndexEdges(baseIndex, [
      {
        edgeId: eAltId,
        aId: 'a:m-1',
        bId: 'a:w-4',
        edgeType: 'hebbian',
        weight: 1.6,
        trust: 'trusted',
        reason: 'hebbian:strong',
      },
      {
        edgeId: e1Id,
        aId: 'a:m-1',
        bId: 'a:g-2',
        edgeType: 'cooccur',
        weight: 0.4,
        trust: 'trusted',
        reason: 'cooccur:session',
      },
    ])
    const res2 = runHotPathQuery(
      rebuilt2,
      [{ kind: 'user', text: 'investigate cgroup.freeze failure', weight: 1.0 }],
      filter,
      profile,
    )
    const hop1Winners = res2.items.filter((i) => i.hop === 1)
    expect(hop1Winners[0]?.id).toBe('a:w-4')
    expect(hop1Winners[0]?.provenanceEdges).toEqual([
      { edgeId: eAltId, aId: 'a:m-1', bId: 'a:w-4', edgeType: 'hebbian' },
    ])
    expect(res2.items.map((i) => i.id)).not.toContain('a:e-3')

    // BUG-1 regression: when a node was earlier seeded at Hop 0 (e.g. sessionActivations) with lower score
    // and then superseded by a stronger Hop-1 edge, hopReached & provenanceEdges MUST update to Hop 1 (and preserve Hop-2 chains)
    const eVGId = computeDeterministicEdgeId('a:m-1', 'a:g-2', 'cooccur')
    const eGWId = computeDeterministicEdgeId('a:g-2', 'a:w-4', 'entity')
    const bug1Index = buildMemoryIndex({
      nodes: [
        {
          id: 'a:m-1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:1',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/prov',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'cgroup.freeze seed note',
          entities: ['cgroup.freeze'],
          tokens: tokenizeAssociationText('cgroup.freeze seed note'),
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
          workspace: '/ws/prov',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Intermediate session-seeded goal',
          entities: ['container_lifecycle'],
          tokens: tokenizeAssociationText('Intermediate session-seeded goal'),
          expiresAt: null,
          updatedAt: nowMs - 1_000,
        },
        {
          id: 'a:w-4',
          kind: 'work-item',
          sourcePlugin: 'assistant-work-items',
          sourceRef: 'work-item:4',
          ownerScopeKey: ownerA,
          scopeMode: 'workspace',
          workspace: '/ws/prov',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Hop-2 follow-up task',
          entities: ['watchdog_followup'],
          tokens: tokenizeAssociationText('Hop-2 follow-up task'),
          expiresAt: null,
          updatedAt: nowMs - 1_000,
        },
      ],
      edges: [
        {
          edgeId: eVGId,
          aId: 'a:m-1',
          bId: 'a:g-2',
          edgeType: 'cooccur',
          weight: 2.0,
          trust: 'trusted',
          reason: 'cooccur:strong',
        },
        {
          edgeId: eGWId,
          aId: 'a:g-2',
          bId: 'a:w-4',
          edgeType: 'entity',
          weight: 0.9,
          trust: 'trusted',
          reason: 'entity:chain',
        },
      ],
    })
    const bug1Res = runHotPathQuery(
      bug1Index,
      [{ kind: 'user', text: 'investigate cgroup.freeze failure', weight: 1.0 }],
      filter,
      profile,
      {
        sessionActivations: [{ nodeId: 'a:g-2', score: 0.05, updatedAt: nowMs - 1_000 }],
      },
    )
    const superseded = bug1Res.items.find((i) => i.id === 'a:g-2')
    const hop2AfterSuperseded = bug1Res.items.find((i) => i.id === 'a:w-4')
    expect(superseded?.hop).toBe(1)
    expect(superseded?.reason).toBe('cooccur:strong')
    expect(superseded?.provenanceEdges).toEqual([
      { edgeId: eVGId, aId: 'a:g-2', bId: 'a:m-1', edgeType: 'cooccur' },
    ])
    expect(hop2AfterSuperseded?.hop).toBe(2)
    expect(hop2AfterSuperseded?.provenanceEdges).toEqual([
      { edgeId: eVGId, aId: 'a:g-2', bId: 'a:m-1', edgeType: 'cooccur' },
      { edgeId: eGWId, aId: 'a:g-2', bId: 'a:w-4', edgeType: 'entity' },
    ])
  })

  test('protects direct Hop-0 matches and isolates per-hop provenance across Hop-1/Hop-2 (Repro 1, Repro 2, REASON_SESSION)', () => {
    const nowMs = 1_700_000_000_000
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-repro'),
      principalRecordId: 'pr-repro',
      principalVersion: 1,
      workspace: '/ws/repro',
      agentPreset: 'primary',
    })
    const profile = {
      maxHops: 2,
      hopTopN: 32,
      maxFanoutPerNode: 128,
      maxItems: 16,
      decayHalfLifeMs: 14 * 86_400_000,
      budgetMs: 10,
      sourceWeights: DEFAULT_SOURCE_WEIGHTS,
    }
    const filter = {
      ownerScopeKey,
      workspace: '/ws/repro',
      agentPreset: 'primary',
      allowLowTrust: false,
      allowSensitive: false,
      nowMs,
    }
    const makeNode = (id: string, title: string, entities: string[], tokens: string[] = []) => ({
      id,
      kind: 'memory' as const,
      sourcePlugin: 'personal-memory',
      sourceRef: `mem:${id}`,
      ownerScopeKey,
      scopeMode: 'workspace' as const,
      workspace: '/ws/repro',
      agentPreset: 'primary',
      trust: 'trusted' as const,
      sensitivity: 'private' as const,
      title,
      entities,
      tokens,
      expiresAt: null,
      updatedAt: nowMs - 1_000,
    })

    // Repro 1: triangle u-x-z (w = 1.4 <= weightMax 2.0) + u-v (w = 0.9)
    const eUX = computeDeterministicEdgeId('a:m-u', 'a:m-x', 'entity')
    const eUZ = computeDeterministicEdgeId('a:m-u', 'a:m-z', 'entity')
    const eXZ = computeDeterministicEdgeId('a:m-x', 'a:m-z', 'entity')
    const eUV = computeDeterministicEdgeId('a:m-u', 'a:m-v', 'cooccur')
    const repro1Index = buildMemoryIndex({
      nodes: [
        makeNode('a:m-u', 'anchor_u primary root', ['anchor_u']),
        makeNode('a:m-x', 'triangle x', ['tri_x']),
        makeNode('a:m-z', 'triangle z', ['tri_z']),
        makeNode('a:m-v', 'leaf v', ['leaf_v']),
      ],
      edges: [
        { edgeId: eUX, aId: 'a:m-u', bId: 'a:m-x', edgeType: 'entity', weight: 1.4, trust: 'trusted', reason: 'r:ux' },
        { edgeId: eUZ, aId: 'a:m-u', bId: 'a:m-z', edgeType: 'entity', weight: 1.4, trust: 'trusted', reason: 'r:uz' },
        { edgeId: eXZ, aId: 'a:m-x', bId: 'a:m-z', edgeType: 'entity', weight: 1.4, trust: 'trusted', reason: 'r:xz' },
        { edgeId: eUV, aId: 'a:m-u', bId: 'a:m-v', edgeType: 'cooccur', weight: 0.9, trust: 'trusted', reason: 'r:uv' },
      ],
    })
    const repro1Res = runHotPathQuery(
      repro1Index,
      [{ kind: 'user', text: 'check anchor_u', weight: 1.0 }],
      filter,
      profile,
    )
    const itemU = repro1Res.items.find((i) => i.id === 'a:m-u')
    const itemV = repro1Res.items.find((i) => i.id === 'a:m-v')
    const itemX = repro1Res.items.find((i) => i.id === 'a:m-x')
    const itemZ = repro1Res.items.find((i) => i.id === 'a:m-z')
    expect(itemU?.hop).toBe(0)
    expect(itemU?.reason).toBe('entity:anchor_u')
    expect(itemU?.provenanceEdges).toBeUndefined()
    expect(itemV?.hop).toBe(1)
    expect(itemV?.reason).toBe('r:uv')
    expect(itemV?.provenanceEdges).toEqual([
      { edgeId: eUV, aId: 'a:m-u', bId: 'a:m-v', edgeType: 'cooccur' },
    ])
    expect(itemX?.hop).toBe(2)
    expect(itemX?.provenanceEdges).toEqual([
      { edgeId: eUZ, aId: 'a:m-u', bId: 'a:m-z', edgeType: 'entity' },
      { edgeId: eXZ, aId: 'a:m-x', bId: 'a:m-z', edgeType: 'entity' },
    ])
    expect(itemZ?.hop).toBe(2)
    expect(itemZ?.provenanceEdges).toEqual([
      { edgeId: eUX, aId: 'a:m-u', bId: 'a:m-x', edgeType: 'entity' },
      { edgeId: eXZ, aId: 'a:m-x', bId: 'a:m-z', edgeType: 'entity' },
    ])

    // Repro 2: all weights <= 0.9, converging a->y->x and b->x->q
    const eAY = computeDeterministicEdgeId('a:m-a', 'a:m-y', 'entity')
    const eBX = computeDeterministicEdgeId('a:m-b', 'a:m-x', 'entity')
    const eXY = computeDeterministicEdgeId('a:m-x', 'a:m-y', 'entity')
    const eQX = computeDeterministicEdgeId('a:m-q', 'a:m-x', 'entity')
    const repro2Index = buildMemoryIndex({
      nodes: [
        makeNode('a:m-a', 'seed a', ['ent_a1', 'ent_a2']),
        makeNode('a:m-b', 'seed b', [], ['ent_b1']),
        makeNode('a:m-y', 'hop1 y', ['hop1_y']),
        makeNode('a:m-x', 'bridge x', ['bridge_x']),
        makeNode('a:m-q', 'target q', ['target_q']),
      ],
      edges: [
        { edgeId: eAY, aId: 'a:m-a', bId: 'a:m-y', edgeType: 'entity', weight: 0.9, trust: 'trusted', reason: 'r:ay' },
        { edgeId: eBX, aId: 'a:m-b', bId: 'a:m-x', edgeType: 'entity', weight: 0.9, trust: 'trusted', reason: 'r:bx' },
        { edgeId: eXY, aId: 'a:m-x', bId: 'a:m-y', edgeType: 'entity', weight: 0.9, trust: 'trusted', reason: 'r:yx' },
        { edgeId: eQX, aId: 'a:m-q', bId: 'a:m-x', edgeType: 'entity', weight: 0.9, trust: 'trusted', reason: 'r:xq' },
      ],
    })
    const repro2Res = runHotPathQuery(
      repro2Index,
      [{ kind: 'user', text: 'ent_a1 ent_a2 ent_b1', weight: 1.0 }],
      filter,
      profile,
    )
    const r2A = repro2Res.items.find((i) => i.id === 'a:m-a')
    const r2B = repro2Res.items.find((i) => i.id === 'a:m-b')
    const r2Y = repro2Res.items.find((i) => i.id === 'a:m-y')
    const r2X = repro2Res.items.find((i) => i.id === 'a:m-x')
    const r2Q = repro2Res.items.find((i) => i.id === 'a:m-q')
    expect(r2A?.hop).toBe(0)
    expect(r2A?.provenanceEdges).toBeUndefined()
    expect(r2B?.hop).toBe(0)
    expect(r2B?.reason).toBe('keyword:ent_b1')
    expect(r2B?.provenanceEdges).toBeUndefined()
    expect(r2Y?.hop).toBe(1)
    expect(r2Y?.provenanceEdges).toEqual([
      { edgeId: eAY, aId: 'a:m-a', bId: 'a:m-y', edgeType: 'entity' },
    ])
    expect(r2X?.hop).toBe(2)
    expect(r2X?.provenanceEdges).toEqual([
      { edgeId: eAY, aId: 'a:m-a', bId: 'a:m-y', edgeType: 'entity' },
      { edgeId: eXY, aId: 'a:m-x', bId: 'a:m-y', edgeType: 'entity' },
    ])
    expect(r2Q?.hop).toBe(2)
    expect(r2Q?.provenanceEdges).toEqual([
      { edgeId: eBX, aId: 'a:m-b', bId: 'a:m-x', edgeType: 'entity' },
      { edgeId: eQX, aId: 'a:m-q', bId: 'a:m-x', edgeType: 'entity' },
    ])

    // Direct Hop-0 protection vs REASON_SESSION promotion (including Hop-0 direct + session combo)
    const eSD = computeDeterministicEdgeId('a:m-d', 'a:m-s', 'entity')
    const eSSess = computeDeterministicEdgeId('a:m-s', 'a:m-sess', 'cooccur')
    const protectIndex = buildMemoryIndex({
      nodes: [
        makeNode('a:m-s', 'strong root', ['strong_root']),
        makeNode('a:m-d', 'weak direct keyword', [], ['weak_kw']),
        makeNode('a:m-sess', 'session only seed', ['sess_only']),
      ],
      edges: [
        { edgeId: eSD, aId: 'a:m-d', bId: 'a:m-s', edgeType: 'entity', weight: 1.8, trust: 'trusted', reason: 'r:sd' },
        { edgeId: eSSess, aId: 'a:m-s', bId: 'a:m-sess', edgeType: 'cooccur', weight: 1.8, trust: 'trusted', reason: 'r:ssess' },
      ],
    })
    const protectRes = runHotPathQuery(
      protectIndex,
      [
        { kind: 'user', text: 'strong_root', weight: 1.0 },
        { kind: 'tool-entity', text: '', entities: [], weight: 0.4 },
        { kind: 'goal', text: 'weak_kw', weight: 0.05 },
      ],
      filter,
      profile,
      {
        sessionActivations: [
          { nodeId: 'a:m-d', score: 0.4, updatedAt: nowMs - 1_000 },
          { nodeId: 'a:m-sess', score: 0.05, updatedAt: nowMs - 1_000 },
        ],
      },
    )
    const directProtected = protectRes.items.find((i) => i.id === 'a:m-d')
    const sessionPromoted = protectRes.items.find((i) => i.id === 'a:m-sess')
    expect(directProtected?.hop).toBe(0)
    expect(directProtected?.reason).toBe('keyword:weak_kw')
    expect(directProtected?.provenanceEdges).toBeUndefined()
    expect(sessionPromoted?.hop).toBe(1)
    expect(sessionPromoted?.reason).toBe('r:ssess')
    expect(sessionPromoted?.provenanceEdges).toEqual([
      { edgeId: eSSess, aId: 'a:m-s', bId: 'a:m-sess', edgeType: 'cooccur' },
    ])
  })

  test('computes unique exposed entities and detects weak-use without prompt or shared false positives', () => {
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-weak'),
      principalRecordId: 'pr-weak',
      principalVersion: 1,
      workspace: '/ws/weak',
      agentPreset: 'primary',
    })
    const nowMs = 1_700_000_000_000
    const idx = buildMemoryIndex({
      nodes: [
        {
          id: 'n1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'm:1',
          ownerScopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/weak',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'n1',
          entities: ['cgroup.freeze', 'shared_ent', 'prompt_ent', 'wal_checkpoint', 'wal_checkpoint'],
          tokens: [],
          expiresAt: null,
          updatedAt: nowMs,
        },
        {
          id: 'n2',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'm:2',
          ownerScopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/weak',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'n2',
          entities: ['shared_ent', 'tool_ent', 'unique_n2'],
          tokens: [],
          expiresAt: null,
          updatedAt: nowMs,
        },
      ],
      edges: [],
      synonyms: [{ surface: 'freeze_wd', canonicalEntity: 'cgroup.freeze' }],
    })

    const turnPromptEntities = new Set(['prompt_ent', 'tool_ent'])
    const exposedNodes = [
      { nodeId: 'n1', entities: idx.nodeEntities[0]! },
      { nodeId: 'n2', entities: idx.nodeEntities[1]! },
    ]

    const uniqueMap = computeUniqueExposedEntities(exposedNodes, turnPromptEntities)
    expect(uniqueMap.get('n1')).toEqual(['cgroup.freeze', 'wal_checkpoint'])
    expect(uniqueMap.get('n2')).toEqual(['unique_n2'])

    // Mentioning prompt_ent, tool_ent, shared_ent, or non-boundary mycgroup.freezer must NOT match
    expect(
      detectWeakUseNodes({
        assistantText: 'Checked prompt_ent, tool_ent, shared_ent, and mycgroup.freezer today.',
        exposedNodes,
        turnPromptEntities,
        entityAutomaton: idx.ac,
      }),
    ).toEqual([])

    // Mentioning synonym freeze_wd matches n1 uniquely
    expect(
      detectWeakUseNodes({
        assistantText: 'We observed freeze_wd firing during shutdown.',
        exposedNodes,
        turnPromptEntities,
        entityAutomaton: idx.ac,
      }),
    ).toEqual(['n1'])

    // Mentioning unique_n2 without AC still works via fallback extractor
    expect(
      detectWeakUseNodes({
        assistantText: 'Looked into unique_n2 configuration.',
        exposedNodes,
        turnPromptEntities,
        entityAutomaton: null,
      }),
    ).toEqual(['n2'])

    // Bounded text scan (> 32_768 chars ignored)
    const paddedText = `${'a '.repeat(MAX_WEAK_USE_TEXT_CHARS / 2)} unique_n2`
    expect(
      detectWeakUseNodes({
        assistantText: paddedText,
        exposedNodes,
        turnPromptEntities,
        entityAutomaton: idx.ac,
      }),
    ).toEqual([])
  })

  test('enforces Hebbian clamping, use-delta idempotency, semigroup-invariant decay, targets & correction classification', () => {
    expect(clampEdgeWeight(5.0, 0.05, 3.0)).toBe(3.0)
    expect(clampEdgeWeight(0.01, 0.05, 3.0)).toBe(0.05)
    expect(clampEdgeWeight(Number.NaN, 0.05, 3.0)).toBe(0.05)
    expect(clampEdgeWeight(0.8, 0.05, 3.0)).toBe(0.8)

    const alpha = 0.3
    const weakRatio = 1 / 3
    expect(
      computeHebbianUseDelta({
        useKind: 'weak',
        strongUsed: false,
        weakUsed: false,
        hebbianDeltaApplied: 0,
        alpha,
        weakRatio,
      }),
    ).toBeCloseTo(0.1, 10)
    // Repeated weak is idempotent
    expect(
      computeHebbianUseDelta({
        useKind: 'weak',
        strongUsed: false,
        weakUsed: true,
        hebbianDeltaApplied: 0.1,
        alpha,
        weakRatio,
      }),
    ).toBe(0)
    // Weak -> Strong upgrade emits +(alpha - alpha * weakRatio)
    expect(
      computeHebbianUseDelta({
        useKind: 'strong',
        strongUsed: false,
        weakUsed: true,
        hebbianDeltaApplied: 0.1,
        alpha,
        weakRatio,
      }),
    ).toBeCloseTo(0.2, 10)
    // Repeated strong or strong -> weak emits 0
    expect(
      computeHebbianUseDelta({
        useKind: 'strong',
        strongUsed: true,
        weakUsed: true,
        hebbianDeltaApplied: 0.3,
        alpha,
        weakRatio,
      }),
    ).toBe(0)
    expect(
      computeHebbianUseDelta({
        useKind: 'weak',
        strongUsed: true,
        weakUsed: false,
        hebbianDeltaApplied: 0.3,
        alpha,
        weakRatio,
      }),
    ).toBe(0)

    // Semigroup-invariant exponential decay with grace period
    const anchorAt = 1_000_000
    const nonUseGraceMs = 7 * 86_400_000
    const decayHalfLifeMs = 30 * 86_400_000
    const weightMin = 0.05
    const weightMax = 3.0

    // Inside grace period -> unchanged
    expect(
      computeExponentialDecayWeight({
        weight: 2.0,
        anchorAt,
        lastDecayedAt: null,
        nowMs: anchorAt + nonUseGraceMs - 1,
        nonUseGraceMs,
        decayHalfLifeMs,
        weightMin,
        weightMax,
      }),
    ).toBe(2.0)

    const t1 = anchorAt + nonUseGraceMs + 10 * 86_400_000
    const t2 = anchorAt + nonUseGraceMs + 25 * 86_400_000
    const direct = computeExponentialDecayWeight({
      weight: 2.0,
      anchorAt,
      lastDecayedAt: null,
      nowMs: t2,
      nonUseGraceMs,
      decayHalfLifeMs,
      weightMin,
      weightMax,
    })
    const step1 = computeExponentialDecayWeight({
      weight: 2.0,
      anchorAt,
      lastDecayedAt: null,
      nowMs: t1,
      nonUseGraceMs,
      decayHalfLifeMs,
      weightMin,
      weightMax,
    })
    const step2 = computeExponentialDecayWeight({
      weight: step1,
      anchorAt,
      lastDecayedAt: t1,
      nowMs: t2,
      nonUseGraceMs,
      decayHalfLifeMs,
      weightMin,
      weightMax,
    })
    expect(step2).toBeCloseTo(direct, 12)

    // Hop-0 co-activation target selection
    expect(
      selectHop0CoActivationTargets({
        nodeId: 'n1',
        goalNodeId: 'g1',
        episodeNodeId: 'e1',
        coExposedNodeIds: ['n1', 'n2', 'g1', 'n3'],
        sessionNodeIds: ['n2', 's1', 'n4'],
        maxTargets: 4,
      }),
    ).toEqual(['g1', 'e1', 'n2', 'n3'])

    // Evaluation correction classification
    const makeReceipt = (
      disposition: 'upsert' | 'retract',
      sourceKind: 'user-feedback' | 'evaluator',
      status: 'achieved' | 'partial' | 'not-achieved' | 'unknown',
    ): TrustedTaskLearningProjectionReceipt => ({
      triggerOutcomeId: 'out-1',
      scope: { workspace: '/ws/a', preset: 'primary' },
      scopeKey: 'k',
      scopeWatermark: 1,
      situation: 'test',
      objective: {
        outcomeId: 'out-1',
        status,
        source: { kind: sourceKind, id: 'src-1' },
        evidence: [],
        occurredAt: 1000,
        evaluator: { id: 'ev', version: '1' },
      },
      projection: {
        subjectKind: 'foreground-turn',
        subjectRef: 'inbox-1',
        version: 1,
        digest: 'abc',
        disposition,
      },
    })

    expect(classifyEvaluationCorrection(makeReceipt('upsert', 'user-feedback', 'not-achieved'))).toBe(true)
    expect(classifyEvaluationCorrection(makeReceipt('upsert', 'user-feedback', 'achieved'))).toBe(false)
    expect(
      classifyEvaluationCorrection(makeReceipt('upsert', 'user-feedback', 'partial'), {
        action: 'correct',
        objectiveStatus: 'partial',
      }),
    ).toBe(true)
    expect(
      classifyEvaluationCorrection(makeReceipt('upsert', 'user-feedback', 'achieved'), {
        action: 'correct',
        objectiveStatus: 'achieved',
      }),
    ).toBe(false)
    expect(classifyEvaluationCorrection(makeReceipt('retract', 'user-feedback', 'unknown'))).toBe(true)
    expect(
      classifyEvaluationCorrection(makeReceipt('upsert', 'user-feedback', 'achieved'), {
        action: 'withdraw',
        objectiveStatus: 'unknown',
      }),
    ).toBe(true)
    expect(classifyEvaluationCorrection(makeReceipt('upsert', 'evaluator', 'not-achieved'))).toBe(false)
  })
})
