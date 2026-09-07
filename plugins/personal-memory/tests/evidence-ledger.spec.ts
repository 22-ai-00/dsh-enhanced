import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryEvidenceLedgerError } from '../src/evidence-ledger.ts'
import { MemoryStore } from '../src/store.ts'
import type { EvidenceScope } from '../src/evidence-ledger.ts'
import type { MemoryOwnerNamespace } from '../src/types.ts'

const temporaryRoots: string[] = []

async function temporaryPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-evidence-'))
  temporaryRoots.push(root)
  return join(root, 'private', 'memory.sqlite')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const namespace: MemoryOwnerNamespace = {
  mode: 'delivery',
  principalDigest: 'a'.repeat(64),
  principalRecordId: 'principal-a',
  principalVersion: 1,
}

function scope(overrides: Partial<EvidenceScope> = {}): EvidenceScope {
  return {
    namespace,
    workspace: '/work/alpha',
    agentPreset: 'primary',
    sessionId: 'session-a',
    ...overrides,
  }
}

function anchor(eventSeq: number, overrides: Partial<Omit<import('../src/evidence-ledger.ts').EvidenceAnchor, 'reference'>> = {}) {
  return {
    eventSeq,
    toolName: 'read',
    sourcePath: '/work/alpha/journal.txt',
    sourceTargetDigest: 'c'.repeat(64),
    callId: `call-${eventSeq}`,
    contentDigest: `${eventSeq.toString(16).padStart(2, '0')}${'b'.repeat(62)}`,
    observedAt: 1_000 + eventSeq,
    ...overrides,
  }
}

describe('memory evidence ledger', () => {
  test('persists deterministic anchors across a SQLite reopen', async () => {
    const path = await temporaryPath()
    const store = new MemoryStore({ path })
    const created = store.evidence.record(scope(), anchor(1))
    expect(created.reference).toMatch(/^dsh-evidence:v1:[0-9a-f]{64}$/u)
    expect(store.evidence.record(scope(), anchor(1))).toEqual(created)
    store.close()

    const reopened = new MemoryStore({ path })
    expect(reopened.evidence.get(scope(), created.reference)).toEqual(created)
    expect(reopened.evidence.list(scope(), 10)).toEqual([created])
    reopened.close()
  })

  test('binds anchors to the exact owner version, workspace, preset, and session', async () => {
    const store = new MemoryStore({ path: await temporaryPath() })
    const created = store.evidence.record(scope(), anchor(1))
    const changedScopes: EvidenceScope[] = [
      scope({ namespace: { ...namespace, principalVersion: 2 } }),
      scope({ workspace: '/work/beta' }),
      scope({ agentPreset: 'secondary' }),
      scope({ sessionId: 'session-b' }),
    ]
    for (const changed of changedScopes) {
      expect(store.evidence.get(changed, created.reference)).toBeUndefined()
      expect(store.evidence.list(changed, 10)).toEqual([])
    }
    store.close()
  })

  test('is idempotent for an exact duplicate and rejects changed same-session event metadata', async () => {
    const store = new MemoryStore({ path: await temporaryPath() })
    const created = store.evidence.record(scope(), anchor(1))
    expect(store.evidence.record(scope(), anchor(1))).toEqual(created)
    expect(() => store.evidence.record(scope(), anchor(1, { contentDigest: 'c'.repeat(64) })))
      .toThrowError(expect.objectContaining<Partial<MemoryEvidenceLedgerError>>({ code: 'conflict' }))
    expect(store.evidence.list(scope(), 10)).toEqual([created])
    store.close()
  })

  test('prunes the oldest rows across sessions for an owner workspace and preset', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), maxRecordsPerIdentity: 2 })
    const first = store.evidence.record(scope({ sessionId: 'session-a' }), anchor(1, { observedAt: 10 }))
    store.evidence.record(scope({ sessionId: 'session-b' }), anchor(2, { observedAt: 20 }))
    const latest = store.evidence.record(scope({ sessionId: 'session-c' }), anchor(3, { observedAt: 30 }))
    expect(store.evidence.get(scope({ sessionId: 'session-a' }), first.reference)).toBeUndefined()
    expect(store.evidence.list(scope({ sessionId: 'session-b' }), 2)).toHaveLength(1)
    expect(store.evidence.list(scope({ sessionId: 'session-c' }), 2)).toEqual([latest])
    store.close()
  })

  test.each([
    [scope({ workspace: 'relative' }), anchor(1)],
    [scope({ agentPreset: '' }), anchor(1)],
    [scope({ sessionId: '' }), anchor(1)],
    [scope(), anchor(-1)],
    [scope(), anchor(1, { contentDigest: 'not-a-digest' })],
    [scope(), anchor(1, { toolName: '' })],
    [scope(), anchor(1, { observedAt: -1 })],
  ])('rejects malformed scope or anchor input', async (badScope, badAnchor) => {
    const store = new MemoryStore({ path: await temporaryPath() })
    expect(() => store.evidence.record(badScope, badAnchor)).toThrow(MemoryEvidenceLedgerError)
    store.close()
  })

  test('migrates a v5 database without changing existing memory rows', async () => {
    const path = await temporaryPath()
    const store = new MemoryStore({ path })
    const saved = store.applyApprovedMutation({
      op: 'add', namespace, idempotencyKey: 'preserve-v5-memory',
      identity: { owner: 'user', scope: 'user-global' },
      entry: {
        kind: 'fact', content: 'preserved v5 record', sensitivity: 'private', trust: 'user-confirmed',
        confidence: 1, provenance: { source: 'test', observedAt: 1_000 },
      },
    })
    store.close()
    const v5 = new DatabaseSync(path)
    v5.exec('DROP TABLE memory_evidence_anchors; PRAGMA user_version = 5;')
    v5.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'schema-version'").run()
    v5.close()

    const migrated = new MemoryStore({ path })
    expect(migrated.get(namespace, { owner: 'user', scope: 'user-global' }, saved.id)?.content)
      .toBe('preserved v5 record')
    expect(migrated.evidence.record(scope(), anchor(1)).eventSeq).toBe(1)
    migrated.close()
  })

  test('rejects altered source identity metadata after reopening the database', async () => {
    const path = await temporaryPath()
    const store = new MemoryStore({ path })
    const saved = store.evidence.record(scope(), anchor(1))
    store.close()
    const writer = new DatabaseSync(path)
    writer.prepare('UPDATE memory_evidence_anchors SET source_path = ?').run('/work/alpha/other.txt')
    writer.close()
    const reopened = new MemoryStore({ path })
    try {
      expect(() => reopened.evidence.get(scope(), saved.reference)).toThrow(MemoryEvidenceLedgerError)
      expect(() => reopened.evidence.list(scope(), 1)).toThrow(MemoryEvidenceLedgerError)
    } finally { reopened.close() }
  })
})
