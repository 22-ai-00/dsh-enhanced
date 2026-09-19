import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import { tokenizeMemory } from '../src/tokenize.ts'
import type { MemoryEntryInput, MemoryIdentity, MemoryOwnerNamespace } from '../src/types.ts'

const temporaryRoots: string[] = []
const namespace: MemoryOwnerNamespace = {
  mode: 'delivery',
  principalDigest: 'a'.repeat(64),
  principalRecordId: 'principal-a',
  principalVersion: 1,
}
const identity: MemoryIdentity = { owner: 'user', scope: 'user-global' }

async function databasePath() {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-tokenizer-'))
  temporaryRoots.push(root)
  return join(root, 'memory.sqlite')
}

function entry(content: string, overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    kind: 'fact',
    content,
    sensitivity: 'private',
    trust: 'user-confirmed',
    confidence: 1,
    provenance: { source: 'user', observedAt: 10_000 },
    ...overrides,
  }
}

function add(memory: MemoryStore, content: string, overrides: Partial<MemoryEntryInput> = {}) {
  return memory.applyApprovedMutation({
    op: 'add',
    idempotencyKey: `add:${content}`,
    namespace,
    identity,
    entry: entry(content, overrides),
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('mixed-script memory tokenizer', () => {
  test('keeps Latin tokens adjacent to CJK and only forms adjacent CJK bigrams', () => {
    const tokens = tokenizeMemory('DeepSeek插件，咖啡')

    expect(tokens).toEqual(expect.arrayContaining(['deepseek', '插', '件', '插件', '咖', '啡', '咖啡']))
    expect(tokens).not.toContain('件咖')
    expect(tokenizeMemory('插件a咖啡')).not.toContain('件咖')
  })

  test('rebuilds a v6 token index once from active content and knowledge', async () => {
    const path = await databasePath()
    const memory = new MemoryStore({ path, now: () => 100_000 })
    const active = add(memory, 'DeepSeek插件工作流', {
      knowledge: { claim: { key: 'workflow.index', value: 'knowledge espresso' } },
    })
    const removed = add(memory, 'Legacy removed token')
    memory.applyApprovedMutation({
      op: 'remove',
      namespace,
      identity,
      idempotencyKey: 'remove-legacy',
      id: removed.id,
      expectedVersion: removed.version,
    })
    memory.close()

    // Simulate a schema-6 database written by the previous tokenizer, including
    // stale tokens and no independent tokenizer-index marker.
    const legacy = new DatabaseSync(path)
    legacy.exec('BEGIN IMMEDIATE')
    legacy.prepare('DELETE FROM memory_tokens').run()
    legacy.prepare('INSERT INTO memory_tokens(memory_id, token) VALUES (?, ?)').run(active.id, 'legacy-active')
    legacy.prepare('INSERT INTO memory_tokens(memory_id, token) VALUES (?, ?)').run(removed.id, 'legacy-removed')
    legacy.prepare("DELETE FROM schema_meta WHERE key = 'tokenizer-index-version'").run()
    legacy.exec('COMMIT')
    legacy.close()

    const migrated = new MemoryStore({ path, now: () => 100_000 })
    expect(migrated.search({ context: { workspace: '/work/alpha', agentPreset: 'primary', namespace }, query: 'deepseek' }))
      .toHaveLength(1)
    expect(migrated.search({ context: { workspace: '/work/alpha', agentPreset: 'primary', namespace }, query: 'espresso' }))
      .toHaveLength(1)
    expect(migrated.search({ context: { workspace: '/work/alpha', agentPreset: 'primary', namespace }, query: 'legacy-active' }))
      .toEqual([])
    expect(migrated.search({ context: { workspace: '/work/alpha', agentPreset: 'primary', namespace }, query: 'legacy-removed' }))
      .toEqual([])
    migrated.close()

    const indexed = new DatabaseSync(path)
    expect(indexed.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 })
    expect(indexed.prepare("SELECT value FROM schema_meta WHERE key = 'tokenizer-index-version'").get())
      .toMatchObject({ value: '1' })
    // A second rebuild would delete this distinguishable token. It must not run
    // once this algorithm version has been recorded by the first migration.
    indexed.prepare('INSERT INTO memory_tokens(memory_id, token) VALUES (?, ?)').run(active.id, 'reopen-sentinel')
    indexed.close()

    // Reopening an already-marked database is idempotent and does not rebuild removed tokens.
    const reopened = new MemoryStore({ path, now: () => 100_000 })
    expect(reopened.search({ context: { workspace: '/work/alpha', agentPreset: 'primary', namespace }, query: 'deepseek' }))
      .toHaveLength(1)
    expect(reopened.search({ context: { workspace: '/work/alpha', agentPreset: 'primary', namespace }, query: 'legacy-removed' }))
      .toEqual([])
    reopened.close()
    const finalIndex = new DatabaseSync(path)
    expect(finalIndex.prepare('SELECT token FROM memory_tokens WHERE memory_id = ? AND token = ?')
      .get(active.id, 'reopen-sentinel')).toMatchObject({ token: 'reopen-sentinel' })
    finalIndex.close()
  })

  test('rolls back an interrupted rebuild and retries without changing records or audit', async () => {
    const path = await databasePath()
    const memory = new MemoryStore({ path, now: () => 100_000 })
    const active = add(memory, 'DeepSeek插件恢复')
    memory.close()

    const legacy = new DatabaseSync(path)
    legacy.exec("DELETE FROM memory_tokens; DELETE FROM schema_meta WHERE key = 'tokenizer-index-version'")
    legacy.prepare('INSERT INTO memory_tokens(memory_id, token) VALUES (?, ?)').run(active.id, 'legacy-sentinel')
    const records = legacy.prepare('SELECT * FROM memory_records ORDER BY id').all()
    const audit = legacy.prepare('SELECT * FROM memory_audit ORDER BY sequence').all()
    legacy.exec(`CREATE TRIGGER interrupt_token_rebuild BEFORE INSERT ON memory_tokens
      BEGIN SELECT RAISE(ABORT, 'injected token rebuild failure'); END`)
    legacy.close()

    expect(() => new MemoryStore({ path, now: () => 100_000 })).toThrow('injected token rebuild failure')
    const interrupted = new DatabaseSync(path)
    expect(interrupted.prepare('SELECT token FROM memory_tokens').all()).toEqual([{ token: 'legacy-sentinel' }])
    expect(interrupted.prepare("SELECT value FROM schema_meta WHERE key = 'tokenizer-index-version'").get()).toBeUndefined()
    expect(interrupted.prepare('SELECT * FROM memory_records ORDER BY id').all()).toEqual(records)
    expect(interrupted.prepare('SELECT * FROM memory_audit ORDER BY sequence').all()).toEqual(audit)
    interrupted.exec('DROP TRIGGER interrupt_token_rebuild')
    interrupted.close()

    const recovered = new MemoryStore({ path, now: () => 100_000 })
    expect(recovered.search({ context: { workspace: '/work/alpha', agentPreset: 'primary', namespace }, query: 'deepseek' }))
      .toHaveLength(1)
    recovered.close()
  })
})
