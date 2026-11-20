import { describe, expect, test } from 'vitest'
import { buildEntityAutomaton } from '../src/aho-corasick.js'
import {
  createAgentAssocState,
  extractAcEntitiesFromText,
  recordTaskExposures,
} from '../src/cues.js'
import { detectWeakUseNodes } from '../src/hebbian.js'
import { runHotPathQuery } from '../src/hot-path.js'
import { buildMemoryIndex, type MemoryIndexNodeInput } from '../src/index-memory.js'
import { AssociationStore, openAssociationDatabase } from '../src/sqlite.js'
import { tokenizeAssociationText } from '../src/tokenize.js'
import {
  DEFAULT_SOURCE_WEIGHTS,
  computeDeterministicEdgeId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  type HotPathProfile,
  type ScoredAssociationItem,
  type UpsertNodeInput,
} from '../src/types.js'
import { AssociationWriteQueue } from '../src/write-queue.js'

function makeOwner(label: string, workspace = '/ws/s3'): string {
  return computeOwnerScopeKey({
    mode: 'delivery',
    principalDigest: computePrincipalDigest(label),
    principalRecordId: `pr-${label}`,
    principalVersion: 1,
    workspace,
    agentPreset: 'primary',
  })
}

function makeIndexNode(
  id: string,
  ownerScopeKey: string,
  entities: string[],
  nowMs: number,
  overrides?: Partial<MemoryIndexNodeInput>,
): MemoryIndexNodeInput {
  return {
    id,
    kind: 'memory',
    sourcePlugin: 'personal-memory',
    sourceRef: `mem:${id}`,
    ownerScopeKey,
    scopeMode: 'workspace',
    workspace: '/ws/s3',
    agentPreset: 'primary',
    trust: 'trusted',
    sensitivity: 'private',
    title: `Node ${id}`,
    entities,
    tokens: tokenizeAssociationText(`Node ${id}`),
    expiresAt: null,
    updatedAt: nowMs - 1_000,
    ...overrides,
  }
}

const BASE_PROFILE: HotPathProfile = {
  maxHops: 2,
  hopTopN: 32,
  maxFanoutPerNode: 128,
  maxItems: 16,
  decayHalfLifeMs: 14 * 86_400_000,
  budgetMs: 25,
  sourceWeights: DEFAULT_SOURCE_WEIGHTS,
}

describe('Slice S3 AC Synonym Owner/Trust Isolation & Low Radar #1, #3, #4', () => {
  test('isolates AC synonyms by ownerScopeKey and trust without cross-owner poisoning', () => {
    const nowMs = 1_700_000_000_000
    const ownerA = makeOwner('owner-a')
    const ownerB = makeOwner('owner-b')

    // Standalone buildEntityAutomaton without explicit ownerKeys stays backward-compatible
    const standaloneAc = buildEntityAutomaton({
      nodeCount: 1,
      nodeUpdatedAt: new Float64Array([nowMs]),
      nodeEntities: [['alpha_ent']],
      synonyms: [
        { surface: 'legacy_syn', canonicalEntity: 'alpha_ent' },
        {
          surface: 'scoped_low_syn',
          canonicalEntity: 'alpha_ent',
          ownerScopeKey: ownerA,
          trust: 'low',
        },
      ],
    })
    expect(standaloneAc.ownerKeys).toEqual([ownerA])
    expect(standaloneAc.ownerKeyToIdx.get(ownerA)).toBe(0)
    expect(standaloneAc.outSynonymOwnerIdx.some((v) => v === -1)).toBe(true)
    expect(standaloneAc.outSynonymOwnerIdx.some((v) => v === 0)).toBe(true)
    expect(standaloneAc.outSynonymTrust.some((v) => v === 0)).toBe(true)

    const index = buildMemoryIndex({
      nodes: [
        makeIndexNode('a:m-a1', ownerA, ['canonical_a'], nowMs),
        makeIndexNode('a:m-a2', ownerA, ['shared_ent'], nowMs),
        makeIndexNode('a:m-b1', ownerB, ['canonical_b'], nowMs),
        makeIndexNode('a:m-b2', ownerB, ['shared_ent'], nowMs),
      ],
      edges: [],
      synonyms: [
        // Backward-compatible unscoped synonym (defaults to trusted, global)
        { surface: 'legacy_alias', canonicalEntity: 'canonical_a' },
        // Owner-A trusted & low-trust synonyms
        {
          surface: 'trusted_alias_a',
          canonicalEntity: 'canonical_a',
          ownerScopeKey: ownerA,
          trust: 'trusted',
        },
        {
          surface: 'dream_alias_a',
          canonicalEntity: 'canonical_a',
          ownerScopeKey: ownerA,
          trust: 'low',
        },
        // Same surface mapped by Owner A (low) before Owner B (trusted)
        {
          surface: 'shared_alias',
          canonicalEntity: 'shared_ent',
          ownerScopeKey: ownerA,
          trust: 'low',
        },
        {
          surface: 'shared_alias',
          canonicalEntity: 'shared_ent',
          ownerScopeKey: ownerB,
          trust: 'trusted',
        },
      ],
    })

    // 1. Owner B with allowLowTrust=true MUST NOT match Owner A's dream_alias_a
    const crossOwnerRes = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'inspect dream_alias_a now', weight: 1.0 }],
      {
        ownerScopeKey: ownerB,
        workspace: '/ws/s3',
        agentPreset: 'primary',
        allowLowTrust: true,
        allowSensitive: false,
        nowMs,
      },
      BASE_PROFILE,
    )
    expect(crossOwnerRes.items).toEqual([])

    // 2. Owner A with allowLowTrust=false rejects dream_alias_a (low), allows trusted_alias_a & legacy_alias
    const ownerALowOff = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check dream_alias_a', weight: 1.0 }],
      {
        ownerScopeKey: ownerA,
        workspace: '/ws/s3',
        agentPreset: 'primary',
        allowLowTrust: false,
        allowSensitive: false,
        nowMs,
      },
      BASE_PROFILE,
    )
    expect(ownerALowOff.items).toEqual([])

    const ownerATrusted = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check trusted_alias_a', weight: 1.0 }],
      {
        ownerScopeKey: ownerA,
        workspace: '/ws/s3',
        agentPreset: 'primary',
        allowLowTrust: false,
        allowSensitive: false,
        nowMs,
      },
      BASE_PROFILE,
    )
    expect(ownerATrusted.items.map((i) => i.id)).toEqual(['a:m-a1'])

    const ownerALegacy = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check legacy_alias', weight: 1.0 }],
      {
        ownerScopeKey: ownerA,
        workspace: '/ws/s3',
        agentPreset: 'primary',
        allowLowTrust: false,
        allowSensitive: false,
        nowMs,
      },
      BASE_PROFILE,
    )
    expect(ownerALegacy.items.map((i) => i.id)).toEqual(['a:m-a1'])

    // 3. Owner A with allowLowTrust=true matches dream_alias_a
    const ownerALowOn = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check dream_alias_a', weight: 1.0 }],
      {
        ownerScopeKey: ownerA,
        workspace: '/ws/s3',
        agentPreset: 'primary',
        allowLowTrust: true,
        allowSensitive: false,
        nowMs,
      },
      BASE_PROFILE,
    )
    expect(ownerALowOn.items.map((i) => i.id)).toEqual(['a:m-a1'])

    // 4. Shared surface: Owner A's low-trust binding precedes Owner B's trusted binding,
    //    yet Owner B with allowLowTrust=false MUST still match Owner B's node!
    const sharedOwnerB = runHotPathQuery(
      index,
      [{ kind: 'user', text: 'check shared_alias', weight: 1.0 }],
      {
        ownerScopeKey: ownerB,
        workspace: '/ws/s3',
        agentPreset: 'primary',
        allowLowTrust: false,
        allowSensitive: false,
        nowMs,
      },
      BASE_PROFILE,
    )
    expect(sharedOwnerB.items.map((i) => i.id)).toEqual(['a:m-b2'])

    // 5. extractAcEntitiesFromText helper also respects ownerScopeKey and allowLowTrust
    expect(
      extractAcEntitiesFromText(index.ac, 'dream_alias_a', {
        ownerScopeKey: ownerB,
        allowLowTrust: true,
      }),
    ).toEqual([])
    expect(
      extractAcEntitiesFromText(index.ac, 'dream_alias_a', {
        ownerScopeKey: ownerA,
        allowLowTrust: false,
      }),
    ).toEqual([])
    expect(
      extractAcEntitiesFromText(index.ac, 'dream_alias_a', {
        ownerScopeKey: ownerA,
        allowLowTrust: true,
      }),
    ).toEqual([{ entityId: 'canonical_a', surface: 'canonical_a' }])
  })

  test('Low Radar #1: prevents REASON_SESSION double-expansion in both frontier orders and guards 3-cycle Hop-0 protection', () => {
    const nowMs = 1_700_000_000_000
    const ownerA = makeOwner('radar1')
    const filter = {
      ownerScopeKey: ownerA,
      workspace: '/ws/s3',
      agentPreset: 'primary',
      allowLowTrust: false,
      allowSensitive: false,
      nowMs,
    }

    // Case A: REASON_SESSION node S has HIGHER Hop-0 score than A, so S expands FIRST at hop=1,
    // setting expandedStamp[S]=epoch. When A later visits S at hop=1 (weight > 1.0), S MUST NOT
    // be overwritten or pushed to nextSlots to double-expand at hop=2!
    const eAS = computeDeterministicEdgeId('a:m-a', 'a:m-s', 'entity')
    const eST = computeDeterministicEdgeId('a:m-s', 'a:m-t', 'entity')
    const indexOrder1 = buildMemoryIndex({
      nodes: [
        makeIndexNode('a:m-a', ownerA, ['root_a'], nowMs),
        makeIndexNode('a:m-s', ownerA, ['sess_s'], nowMs),
        makeIndexNode('a:m-t', ownerA, ['leaf_t'], nowMs),
      ],
      edges: [
        { edgeId: eAS, aId: 'a:m-a', bId: 'a:m-s', edgeType: 'entity', weight: 2.0, trust: 'trusted', reason: 'r:as' },
        { edgeId: eST, aId: 'a:m-s', bId: 'a:m-t', edgeType: 'entity', weight: 0.9, trust: 'trusted', reason: 'r:st' },
      ],
    })
    // Compute root_a's Hop-0 score: 1.0 * ln(1 + 3/2) * 1.0 ≈ 0.916
    // Give sessionActivations score 2.0 -> Hop-0 score 0.5 * 2.0 = 1.0 > 0.916, so S runs first!
    const resOrder1 = runHotPathQuery(
      indexOrder1,
      [{ kind: 'user', text: 'root_a', weight: 1.0 }],
      filter,
      BASE_PROFILE,
      {
        sessionActivations: [{ nodeId: 'a:m-s', score: 2.0, updatedAt: nowMs }],
      },
    )
    const itemS1 = resOrder1.items.find((i) => i.id === 'a:m-s')
    const itemT1 = resOrder1.items.find((i) => i.id === 'a:m-t')
    expect(itemS1?.hop).toBe(0)
    expect(itemS1?.reason).toBe('session:active')
    expect(itemT1?.hop).toBe(1)
    expect(itemT1?.provenanceEdges).toEqual([
      { edgeId: eST, aId: 'a:m-s', bId: 'a:m-t', edgeType: 'entity' },
    ])

    // Case B: A has HIGHER Hop-0 score than S, so A runs first, promotes S to hop=1, and pushes S
    // to nextSlots for hop=2. Even when hopTopN=1 prunes S from hop=2, S MUST NOT also expand at hop=1!
    const indexOrder2 = buildMemoryIndex({
      nodes: [
        makeIndexNode('a:m-a', ownerA, ['root_a'], nowMs),
        makeIndexNode('a:m-b', ownerA, ['other_b'], nowMs),
        makeIndexNode('a:m-s', ownerA, ['sess_s'], nowMs),
        makeIndexNode('a:m-t', ownerA, ['leaf_t'], nowMs),
      ],
      edges: [
        {
          edgeId: computeDeterministicEdgeId('a:m-a', 'a:m-b', 'entity'),
          aId: 'a:m-a',
          bId: 'a:m-b',
          edgeType: 'entity',
          weight: 2.5,
          trust: 'trusted',
          reason: 'r:ab',
        },
        {
          edgeId: computeDeterministicEdgeId('a:m-a', 'a:m-s', 'entity'),
          aId: 'a:m-a',
          bId: 'a:m-s',
          edgeType: 'entity',
          weight: 1.5,
          trust: 'trusted',
          reason: 'r:as',
        },
        {
          edgeId: computeDeterministicEdgeId('a:m-s', 'a:m-t', 'entity'),
          aId: 'a:m-s',
          bId: 'a:m-t',
          edgeType: 'entity',
          weight: 0.9,
          trust: 'trusted',
          reason: 'r:st',
        },
      ],
    })
    const resOrder2 = runHotPathQuery(
      indexOrder2,
      [{ kind: 'user', text: 'root_a', weight: 1.0 }],
      filter,
      { ...BASE_PROFILE, hopTopN: 2 }, // Hop 0 frontier has [A, S], hop 2 frontier top-2 picks [B, S] or with hopTopN=1?
      {
        sessionActivations: [{ nodeId: 'a:m-s', score: 0.05, updatedAt: nowMs }],
      },
    )
    // With hopTopN=2, S expands ONCE at hop=2 (not at hop=1), so a:m-t is reached at hop=2
    expect(resOrder2.items.find((i) => i.id === 'a:m-t')?.hop).toBe(2)

    // With hopTopN=2 at hop=0? Let's force B > S at hop=1 -> hop=2 with hopTopN=1 at hop=2:
    // Actually hopTopN applies at both hop=0 and hop=1->2, so if S is in hop=0 with hopTopN=2 and
    // B has score > S after hop=1, let's check a:m-s promoted at hop=1 and pruned if another branch beats it:
    const indexOrder2Pruned = buildMemoryIndex({
      nodes: [
        makeIndexNode('a:m-a', ownerA, ['root_a'], nowMs),
        makeIndexNode('a:m-b', ownerA, ['other_b'], nowMs),
        makeIndexNode('a:m-c', ownerA, ['other_c'], nowMs),
        makeIndexNode('a:m-s', ownerA, ['sess_s'], nowMs),
        makeIndexNode('a:m-t', ownerA, ['leaf_t'], nowMs),
      ],
      edges: [
        {
          edgeId: computeDeterministicEdgeId('a:m-a', 'a:m-b', 'entity'),
          aId: 'a:m-a',
          bId: 'a:m-b',
          edgeType: 'entity',
          weight: 2.5,
          trust: 'trusted',
          reason: 'r:ab',
        },
        {
          edgeId: computeDeterministicEdgeId('a:m-a', 'a:m-c', 'entity'),
          aId: 'a:m-a',
          bId: 'a:m-c',
          edgeType: 'entity',
          weight: 2.2,
          trust: 'trusted',
          reason: 'r:ac',
        },
        {
          edgeId: computeDeterministicEdgeId('a:m-a', 'a:m-s', 'entity'),
          aId: 'a:m-a',
          bId: 'a:m-s',
          edgeType: 'entity',
          weight: 1.5,
          trust: 'trusted',
          reason: 'r:as',
        },
        {
          edgeId: computeDeterministicEdgeId('a:m-s', 'a:m-t', 'entity'),
          aId: 'a:m-s',
          bId: 'a:m-t',
          edgeType: 'entity',
          weight: 0.9,
          trust: 'trusted',
          reason: 'r:st',
        },
      ],
    })
    const resOrder2Pruned = runHotPathQuery(
      indexOrder2Pruned,
      [{ kind: 'user', text: 'root_a', weight: 1.0 }],
      filter,
      { ...BASE_PROFILE, hopTopN: 2 },
      {
        sessionActivations: [{ nodeId: 'a:m-s', score: 0.05, updatedAt: nowMs }],
      },
    )
    // S was promoted to hop=1 by A (and pruned from hop=2 top-2 by B & C), so S did NOT
    // leak a hop=1 expansion to a:m-t with its stale 0.025 session score!
    expect(resOrder2Pruned.items.find((i) => i.id === 'a:m-t')).toBeUndefined()

    // Case C: 3-cycle with weight > 1.0 never downgrades Hop-0 entity node to Hop-1 or Hop-2
    const indexCycle = buildMemoryIndex({
      nodes: [
        makeIndexNode('a:m-u', ownerA, ['root_u'], nowMs),
        makeIndexNode('a:m-x', ownerA, ['node_x'], nowMs),
        makeIndexNode('a:m-z', ownerA, ['node_z'], nowMs),
      ],
      edges: [
        { edgeId: 'e-ux', aId: 'a:m-u', bId: 'a:m-x', edgeType: 'entity', weight: 1.8, trust: 'trusted', reason: 'r:ux' },
        { edgeId: 'e-uz', aId: 'a:m-u', bId: 'a:m-z', edgeType: 'entity', weight: 1.8, trust: 'trusted', reason: 'r:uz' },
        { edgeId: 'e-xz', aId: 'a:m-x', bId: 'a:m-z', edgeType: 'entity', weight: 1.8, trust: 'trusted', reason: 'r:xz' },
      ],
    })
    const cycleRes = runHotPathQuery(
      indexCycle,
      [{ kind: 'user', text: 'root_u', weight: 1.0 }],
      filter,
      BASE_PROFILE,
    )
    const uItem = cycleRes.items.find((i) => i.id === 'a:m-u')
    expect(uItem?.hop).toBe(0)
    expect(uItem?.reason).toBe('entity:root_u')
    expect(uItem?.provenanceEdges).toBeUndefined()
  })

  test('Low Radar #3: write-queue persists cursor only after all chunks succeed and preserves tombstones across concurrent withdrawal', async () => {
    const now = 1_700_000_000_000
    const ownerA = makeOwner('wq-s3')
    const makeUpsertNode = (
      id: string,
      sourcePlugin = 'personal-memory',
      sourceRef = `mem:${id}`,
      kind: 'memory' | 'abstraction' = 'memory',
    ): UpsertNodeInput => ({
      id,
      kind,
      sourcePlugin,
      sourceRef,
      sourceVersion: 1,
      ownerScopeKey: ownerA,
      ownerMode: 'delivery',
      principalDigest: computePrincipalDigest('wq-s3'),
      principalRecordId: 'pr-wq-s3',
      principalVersion: 1,
      scopeMode: 'workspace',
      workspace: '/ws/s3',
      agentPreset: 'primary',
      trust: 'trusted',
      sensitivity: 'private',
      title: `Title ${id}`,
      body: `Body ${id}`,
      entities: ['wq_entity'],
      tokens: tokenizeAssociationText(`Title ${id}`),
      createdAt: now,
      updatedAt: now,
    })

    // Part A: Mid-chunk failure leaves cursor unpersisted
    const db1 = openAssociationDatabase(':memory:')
    const store1 = new AssociationStore(db1)
    const errors: unknown[] = []
    const queue1 = new AssociationWriteQueue(store1, {
      maxItemsPerTx: 2,
      flushIntervalMs: 10,
      onError: (err) => errors.push(err),
    })

    const origUpsertBatch = store1.upsertBatch.bind(store1)
    let callNum = 0
    store1.upsertBatch = (input) => {
      callNum += 1
      // Call 1: nodes[0..1], Call 2: nodes[2], Call 3: edges[0..1] -> throw!
      if (callNum === 3) {
        throw new Error('simulated mid-chunk edge failure')
      }
      return origUpsertBatch(input)
    }

    const n1 = makeUpsertNode('a:m-1')
    const n2 = makeUpsertNode('a:m-2')
    const n3 = makeUpsertNode('a:m-3')
    const n4 = makeUpsertNode('a:m-4')
    queue1.enqueue({
      kind: 'upsert-nodes',
      nodes: [n1, n2, n3],
      edges: [
        {
          edgeId: computeDeterministicEdgeId(n1.id, n2.id, 'cooccur'),
          aId: n1.id,
          bId: n2.id,
          edgeType: 'cooccur',
          weight: 0.8,
          trust: 'trusted',
          reason: 'r12',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: computeDeterministicEdgeId(n2.id, n3.id, 'cooccur'),
          aId: n2.id,
          bId: n3.id,
          edgeType: 'cooccur',
          weight: 0.8,
          trust: 'trusted',
          reason: 'r23',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: computeDeterministicEdgeId(n1.id, n3.id, 'cooccur'),
          aId: n1.id,
          bId: n3.id,
          edgeType: 'cooccur',
          weight: 0.8,
          trust: 'trusted',
          reason: 'r13',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [],
      cursor: {
        sourcePlugin: 'personal-memory',
        scopeKey: ownerA,
        cursorJson: '{"seq":42}',
      },
    })

    await queue1.flush()
    expect(errors.map(String)).toEqual(['Error: simulated mid-chunk edge failure'])
    expect(store1.getIngestCursor('personal-memory', ownerA)).toBeNull()

    // Restore upsertBatch and confirm full chunked completion persists cursor last
    store1.upsertBatch = origUpsertBatch
    queue1.enqueue({
      kind: 'upsert-nodes',
      nodes: [n4],
      edges: [
        {
          edgeId: computeDeterministicEdgeId(n1.id, n4.id, 'cooccur'),
          aId: n1.id,
          bId: n4.id,
          edgeType: 'cooccur',
          weight: 0.7,
          trust: 'trusted',
          reason: 'r14',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: computeDeterministicEdgeId(n2.id, n4.id, 'cooccur'),
          aId: n2.id,
          bId: n4.id,
          edgeType: 'cooccur',
          weight: 0.7,
          trust: 'trusted',
          reason: 'r24',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: computeDeterministicEdgeId(n3.id, n4.id, 'cooccur'),
          aId: n3.id,
          bId: n4.id,
          edgeType: 'cooccur',
          weight: 0.7,
          trust: 'trusted',
          reason: 'r34',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [
        { sourceNodeId: n1.id, sourceVersion: 1, targetKind: 'node', targetId: n4.id },
        { sourceNodeId: n2.id, sourceVersion: 1, targetKind: 'node', targetId: n4.id },
        { sourceNodeId: n3.id, sourceVersion: 1, targetKind: 'node', targetId: n4.id },
      ],
      cursor: {
        sourcePlugin: 'personal-memory',
        scopeKey: ownerA,
        cursorJson: '{"seq":99}',
      },
    })
    await queue1.flush()
    expect(errors.map(String)).toEqual(['Error: simulated mid-chunk edge failure'])
    expect(store1.getIngestCursor('personal-memory', ownerA)?.cursorJson).toBe('{"seq":99}')
    await queue1.dispose()
    store1.close()

    // Part B: Tombstone preservation when chunked upsert runs while a withdrawal is pending
    // for a DIFFERENT (sourcePlugin, sourceRef) that cascade-tombstoned a derived node.
    const db2 = openAssociationDatabase(':memory:')
    const store2 = new AssociationStore(db2)
    const queue2 = new AssociationWriteQueue(store2, {
      maxItemsPerTx: 1,
      flushIntervalMs: 10,
    })

    const parentNode = makeUpsertNode('a:m-parent', 'personal-memory', 'mem:parent', 'memory')
    const derivedNode = makeUpsertNode(
      'a:abs-derived',
      'assistant-association',
      'dream:derived',
      'abstraction',
    )
    const unrelatedNode = makeUpsertNode('a:m-other', 'personal-memory', 'mem:other', 'memory')

    store2.upsertBatch({
      nodes: [parentNode, derivedNode],
      edges: [],
      derivedRefs: [
        { sourceNodeId: parentNode.id, sourceVersion: 1, targetKind: 'node', targetId: derivedNode.id },
      ],
    })

    let observedTombstoneDuringUpsert = false
    const origUpsert2 = store2.upsertBatch.bind(store2)
    store2.upsertBatch = (input) => {
      const res = origUpsert2(input)
      if (input.nodes.some((n) => n.id === derivedNode.id)) {
        // Record whether tombstone was preserved right after nodeChunk executes
        queueMicrotask(() => {
          observedTombstoneDuringUpsert = queue2.isNodeTombstoned(derivedNode.id)
        })
      }
      return res
    }

    // Queue an upsert containing derivedNode (different sourcePlugin/sourceRef than withdrawal),
    // then synchronously mark derivedNode tombstoned and enqueue withdraw-source for parentNode!
    queue2.enqueue({
      kind: 'upsert-nodes',
      nodes: [derivedNode, unrelatedNode],
      edges: [],
      derivedRefs: [],
    })
    queue2.markTombstoneSync({
      nodeIds: [parentNode.id, derivedNode.id],
      ownerScopeKey: ownerA,
      sourcePlugin: 'personal-memory',
      sourceRef: 'mem:parent',
    })
    queue2.enqueue({
      kind: 'withdraw-source',
      ownerScopeKey: ownerA,
      sourcePlugin: 'personal-memory',
      sourceRef: 'mem:parent',
      hardDelete: true,
      recordWithdrawalTombstone: false,
    })

    await queue2.flush()
    expect(observedTombstoneDuringUpsert).toBe(true)
    expect(queue2.isNodeTombstoned(derivedNode.id)).toBe(true)
    expect(store2.getNodeById(parentNode.id)).toBeNull()
    expect(store2.getNodeById(derivedNode.id)).toBeNull()
    expect(store2.getNodeById(unrelatedNode.id)).not.toBeNull()

    queue2.clearTombstonesForRebuiltGraph(new Set([unrelatedNode.id]), queue2.withdrawalEpoch)
    expect(queue2.isNodeTombstoned(derivedNode.id)).toBe(false)

    await queue2.dispose()
    store2.close()
  })

  test('Low Radar #4: recordTaskExposures resets provenanceEdges to [] when Hop 1/2 shifts to Hop 0', () => {
    const state = createAgentAssocState()
    const baseItem: ScoredAssociationItem = {
      slot: 0,
      id: 'a:m-1',
      kind: 'memory',
      title: 'Test node',
      trust: 'trusted',
      sensitivity: 'private',
      score: 0.75,
      reason: 'cooccur:session',
      hop: 1,
      sourcePlugin: 'personal-memory',
      updatedAt: 1_700_000_000_000,
      provenanceEdges: [
        { edgeId: 'edge-1', aId: 'a:m-0', bId: 'a:m-1', edgeType: 'cooccur' },
      ],
    }

    // Step 1: exposed at Hop 1 with provenanceEdges
    recordTaskExposures(state, 'task-radar4', [baseItem])
    const afterStep1 = state.taskExposures.get('task-radar4')?.get('a:m-1')
    expect(afterStep1?.hop).toBe(1)
    expect(afterStep1?.provenanceEdges).toHaveLength(1)

    // Step 2: matched directly at Hop 0 (hot-path omits provenanceEdges)
    const { provenanceEdges: _omitted, ...hop0Base } = baseItem
    recordTaskExposures(state, 'task-radar4', [
      {
        ...hop0Base,
        hop: 0,
        score: 1.25,
        reason: 'entity:cgroup.freeze',
      },
    ])
    const afterStep2 = state.taskExposures.get('task-radar4')?.get('a:m-1')
    expect(afterStep2?.hop).toBe(0)
    expect(afterStep2?.reason).toBe('entity:cgroup.freeze')
    expect(afterStep2?.provenanceEdges).toEqual([])
  })

  test('detectWeakUseNodes enforces ownerScopeKey and allowLowTrust on AC synonyms', () => {
    const nowMs = 1_700_000_000_000
    const ownerA = makeOwner('weak-use-a')
    const ownerB = makeOwner('weak-use-b')

    const index = buildMemoryIndex({
      nodes: [
        makeIndexNode('a:m-owner-a', ownerA, ['shared_canon'], nowMs),
        makeIndexNode('a:m-owner-b', ownerB, ['other_canon'], nowMs),
      ],
      edges: [],
      synonyms: [
        {
          surface: 'owner_b_only_alias',
          canonicalEntity: 'shared_canon',
          ownerScopeKey: ownerB,
          trust: 'trusted',
        },
        {
          surface: 'owner_a_low_alias',
          canonicalEntity: 'shared_canon',
          ownerScopeKey: ownerA,
          trust: 'low',
        },
        {
          surface: 'owner_a_trusted_alias',
          canonicalEntity: 'shared_canon',
          ownerScopeKey: ownerA,
          trust: 'trusted',
        },
      ],
    })

    const exposedNodes = [{ nodeId: 'a:m-owner-a', entities: ['shared_canon'] }]
    const emptyPrompt = new Set<string>()

    // 1. Cross-owner synonym MUST NOT trigger weak-use credit for Owner A
    expect(
      detectWeakUseNodes({
        assistantText: 'The answer involves owner_b_only_alias.',
        exposedNodes,
        turnPromptEntities: emptyPrompt,
        entityAutomaton: index.ac,
        ownerScopeKey: ownerA,
        allowLowTrust: true,
      }),
    ).toEqual([])

    // 2. Low-trust synonym MUST NOT match when allowLowTrust is false
    expect(
      detectWeakUseNodes({
        assistantText: 'The answer involves owner_a_low_alias.',
        exposedNodes,
        turnPromptEntities: emptyPrompt,
        entityAutomaton: index.ac,
        ownerScopeKey: ownerA,
        allowLowTrust: false,
      }),
    ).toEqual([])

    // 3. Low-trust synonym matches Owner A when allowLowTrust is true
    expect(
      detectWeakUseNodes({
        assistantText: 'The answer involves owner_a_low_alias.',
        exposedNodes,
        turnPromptEntities: emptyPrompt,
        entityAutomaton: index.ac,
        ownerScopeKey: ownerA,
        allowLowTrust: true,
      }),
    ).toEqual(['a:m-owner-a'])

    // 4. Trusted synonym owned by Owner A matches even when allowLowTrust is false
    expect(
      detectWeakUseNodes({
        assistantText: 'The answer involves owner_a_trusted_alias.',
        exposedNodes,
        turnPromptEntities: emptyPrompt,
        entityAutomaton: index.ac,
        ownerScopeKey: ownerA,
        allowLowTrust: false,
      }),
    ).toEqual(['a:m-owner-a'])

    // 5. Canonical entity name itself remains unaffected by synonym owner/trust filtering
    expect(
      detectWeakUseNodes({
        assistantText: 'The answer involves shared_canon.',
        exposedNodes,
        turnPromptEntities: emptyPrompt,
        entityAutomaton: index.ac,
        ownerScopeKey: ownerA,
        allowLowTrust: false,
      }),
    ).toEqual(['a:m-owner-a'])
  })
})
