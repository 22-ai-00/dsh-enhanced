import { chmodSync, lstatSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { GoalStore } from '../src/store.ts'
import { goalDependencies } from '../src/dependency.ts'
import { GoalStoreError } from '../src/types.ts'
import type { GoalCheckpoint, GoalScope, NativeGoalState } from '../src/types.ts'

const scope = (principalId = 'owner-a'): GoalScope => ({ principalId, principalRecordId: `${principalId}-record`, principalVersion: 1, workspace: '/workspace', preset: 'default' })
const native = (changes: Partial<NativeGoalState> = {}): NativeGoalState => ({
  sessionId: 'session-a', goalId: 'goal-a', revision: 1, objective: 'write the report', phase: 'active', roundsStarted: 0, maxGoalRounds: 4, updatedAt: 100, ...changes,
})
const checkpoint = (changes: Partial<GoalCheckpoint> = {}): GoalCheckpoint => ({ nextStep: 'inspect source', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [], ...changes })
const database = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'assistant-goals-')), 'goals.sqlite')

describe('GoalStore', () => {
  it('migrates a v1 native history into semantic definitions and can reopen it again', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const original = store.observe(scope(), native(), true)!
    store.observe(scope(), native({ revision: 2, objective: 'revised goal', updatedAt: 200 }), false)
    store.observe(scope(), native({ revision: 3, objective: 'revised goal', phase: 'paused', updatedAt: 300 }), false)
    store.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE goal_records DROP COLUMN definition_json; PRAGMA user_version = 1;')
    old.close()
    for (let attempt = 0; attempt < 2; attempt++) {
      const migrated = new GoalStore(path)
      expect(migrated.get(scope(), original.id)).toMatchObject({ originalObjective: 'write the report', definition: { version: 2, objective: 'revised goal' }, native: { revision: 3, phase: 'paused' } })
      migrated.close()
    }
  })

  it('observes native state, enforces checkpoint CAS, and survives restart', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const record = store.observe(scope(), native(), true)
    expect(record).toMatchObject({ originalObjective: 'write the report', version: 1 })
    expect(store.observe(scope(), native(), true)).toEqual(record)
    const saved = store.checkpoint(scope(), record!.id, 1, checkpoint())
    expect(saved.version).toBe(2)
    expect(() => store.checkpoint(scope(), record!.id, 1, checkpoint())).toThrow(GoalStoreError)
    store.close()

    const reopened = new GoalStore(path)
    expect(reopened.get(scope(), record!.id)).toEqual(saved)
    expect(reopened.health()).toEqual({ goals: 1, awaitingVerification: 0 })
    reopened.close()
  })

  it('preserves creation objective and only advances non-stale native snapshots', () => {
    const store = new GoalStore(':memory:')
    store.observe(scope(), native(), true)!
    const advanced = store.observe(scope(), native({ revision: 2, objective: 'revised objective', roundsStarted: 1, updatedAt: 200 }), true)!
    expect(advanced.originalObjective).toBe('write the report')
    expect(advanced.native.objective).toBe('revised objective')
    expect(store.observe(scope(), native({ revision: 1, roundsStarted: 0 }), true)).toEqual(advanced)
    expect(() => store.observe(scope(), native({ revision: 2, roundsStarted: 1, objective: 'tampered' }), true)).toThrow(GoalStoreError)
    store.close()
  })

  it('reopens a ledger whose later native snapshot changed the objective', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const created = store.observe(scope(), native(), true)!
    const advanced = store.observe(scope(), native({ revision: 2, roundsStarted: 1, objective: 'edited objective', updatedAt: 200 }), true)!
    store.close()
    const reopened = new GoalStore(path)
    expect(reopened.get(scope(), created.id)).toEqual(advanced)
    reopened.close()
  })

  it('versions only semantic native objective edits and reconstructs the definition from history', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const first = store.observe(scope(), native(), true)!
    expect(first.definition).toMatchObject({ version: 1, objective: 'write the report' })
    const paused = store.observe(scope(), native({ revision: 2, phase: 'paused', updatedAt: 200 }), true)!
    expect(paused.definition).toEqual(first.definition)
    const edited = store.observe(scope(), native({ revision: 3, objective: 'revised report', phase: 'active', updatedAt: 300 }), true)!
    expect(edited.definition).toMatchObject({ version: 2, objective: 'revised report' })
    store.close()
    expect(new GoalStore(path).get(scope(), first.id)?.definition).toEqual(edited.definition)
  })

  it('rejects a persisted definition that does not replay from native history', async () => {
    const path = await database(); const store = new GoalStore(path)
    const record = store.observe(scope(), native(), true)!; store.close()
    const db = new DatabaseSync(path)
    db.prepare('UPDATE goal_records SET definition_json = ? WHERE id = ?').run(JSON.stringify({ version: 2, objective: 'forged', digest: '0'.repeat(64) }), record.id)
    db.close()
    expect(() => new GoalStore(path)).toThrow(GoalStoreError)
  })

  it('keeps owners isolated and denies takeover of an existing native identity', () => {
    const store = new GoalStore(':memory:')
    const first = store.observe(scope(), native(), true)!
    expect(() => store.observe(scope('owner-b'), native(), true)).toThrow(GoalStoreError)
    expect(store.get(scope('owner-b'), first.id)).toBeUndefined()
    expect(store.list(scope('owner-b'))).toEqual([])
    expect(() => store.checkpoint(scope('owner-b'), first.id, 1, checkpoint())).toThrow(new GoalStoreError('not-found'))
    store.close()
  })

  it('finds an older native goal without depending on list pagination', () => {
    const store = new GoalStore(':memory:')
    const first = store.observe(scope(), native({ sessionId: 'old-session', goalId: 'old-goal', updatedAt: 1 }), true)!
    for (let index = 0; index < 101; index++) {
      store.observe(scope(), native({ sessionId: `new-session-${index}`, goalId: `new-goal-${index}`, updatedAt: index + 2 }), true)
    }
    expect(store.list(scope()).map(record => record.id)).not.toContain(first.id)
    expect(store.findNative(scope(), 'old-session', 'old-goal')).toEqual(first)
    expect(store.findNative(scope('owner-b'), 'old-session', 'old-goal')).toBeUndefined()
    store.close()
  })

  it('applies list pagination after owner filtering', () => {
    const store = new GoalStore(':memory:')
    const own = store.observe(scope(), native({ sessionId: 'owner-a-session', goalId: 'owner-a-goal', updatedAt: 1 }), true)!
    for (let index = 0; index < 50; index++) {
      store.observe(scope('owner-b'), native({ sessionId: `owner-b-session-${index}`, goalId: `owner-b-goal-${index}`, updatedAt: index + 2 }), true)
    }
    expect(store.list(scope())).toEqual([own])
    store.close()
  })

  it('persists focus by owner scope and session without allowing owner inheritance', async () => {
    const path = await database()
    const store = new GoalStore(path)
    store.observe(scope(), native(), true)!
    const record = store.observe(scope(), native({ sessionId: 'source-session', goalId: 'source-goal' }), true)!
    store.setFocus(scope(), 'session-a', record.id)
    expect(store.focused(scope(), 'session-a')).toEqual(record)
    expect(store.focused(scope('owner-b'), 'session-a')).toBeUndefined()
    expect(() => store.setFocus(scope('owner-b'), 'session-a', record.id)).toThrow(GoalStoreError)
    store.close()
    const reopened = new GoalStore(path)
    expect(reopened.focused(scope(), 'session-a')).toEqual(record)
    reopened.close()
  })

  it('rejects truncated, mismatched, and cross-owner persisted ledger rows on reopen', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const first = store.observe(scope(), native(), true)!
    const other = store.observe(scope('owner-b'), native({ sessionId: 'owner-b-session', goalId: 'owner-b-goal' }), true)!
    store.checkpoint(scope(), first.id, 1, checkpoint())
    store.close()

    const corrupt = new DatabaseSync(path)
    corrupt.exec('PRAGMA foreign_keys = OFF')
    corrupt.prepare('DELETE FROM goal_history WHERE record_id = ? AND sequence = 2').run(first.id)
    corrupt.close()
    expect(() => new GoalStore(path)).toThrow(GoalStoreError)

    const mismatchPath = await database()
    const mismatchStore = new GoalStore(mismatchPath)
    const mismatch = mismatchStore.observe(scope(), native(), true)!
    mismatchStore.close()
    const mismatchDb = new DatabaseSync(mismatchPath)
    mismatchDb.prepare("UPDATE goal_history SET payload_json = ? WHERE record_id = ? AND sequence = 1").run(JSON.stringify(native({ objective: 'tampered' })), mismatch.id)
    mismatchDb.close()
    expect(() => new GoalStore(mismatchPath)).toThrow(GoalStoreError)

    const focusPath = await database()
    const focusStore = new GoalStore(focusPath)
    focusStore.observe(scope(), native(), true)!
    const foreign = focusStore.observe(scope('owner-b'), native({ sessionId: 'foreign-session', goalId: 'foreign-goal' }), true)!
    focusStore.close()
    const focusDb = new DatabaseSync(focusPath)
    focusDb.prepare('INSERT INTO goal_focus(scope_json, session_id, record_id) VALUES (?, ?, ?)').run(JSON.stringify(scope()), 'session-a', foreign.id)
    focusDb.close()
    expect(() => new GoalStore(focusPath)).toThrow(GoalStoreError)
    expect(other.id).toBeTruthy()
  })

  it('rejects cross-owner, self, and cyclic dependencies', () => {
    const store = new GoalStore(':memory:')
    const first = store.observe(scope(), native(), true)!
    const second = store.observe(scope(), native({ sessionId: 'session-b', goalId: 'goal-b' }), true)!
    const other = store.observe(scope('owner-b'), native({ sessionId: 'session-c', goalId: 'goal-c' }), true)!
    expect(() => store.checkpoint(scope(), first.id, 1, checkpoint({ dependencies: [other.id] }))).toThrow(GoalStoreError)
    expect(() => store.checkpoint(scope(), first.id, 1, checkpoint({ dependencies: [first.id] }))).toThrow(GoalStoreError)
    const secondSaved = store.checkpoint(scope(), second.id, 1, checkpoint({ dependencies: [first.id] }))
    expect(secondSaved.version).toBe(2)
    expect(() => store.checkpoint(scope(), first.id, 1, checkpoint({ dependencies: [second.id] }))).toThrow(GoalStoreError)
    store.close()
  })

  it('freezes dependency definition identities at checkpoint time and preserves them across objective drift and restart', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const dependency = store.observe(scope(), native({ sessionId: 'dependency-session', goalId: 'dependency-goal', objective: 'Publish version one' }), true)!
    const parent = store.observe(scope(), native({ sessionId: 'parent-session', goalId: 'parent-goal', objective: 'Use the published result' }), true)!
    const saved = store.checkpoint(scope(), parent.id, parent.version, checkpoint({ dependencies: [dependency.id], dependencyBindings: [{
      goalId: dependency.id, definitionVersion: 999, definitionDigest: 'f'.repeat(64),
    }] }))

    expect(saved.checkpoint.dependencyBindings).toEqual([{ goalId: dependency.id, definitionVersion: dependency.definition.version, definitionDigest: dependency.definition.digest }])
    expect(Object.isFrozen(saved.checkpoint.dependencyBindings)).toBe(true)
    expect(Object.isFrozen(saved.checkpoint.dependencyBindings?.[0])).toBe(true)
    const edited = store.observe(scope(), native({ sessionId: 'dependency-session', goalId: 'dependency-goal', revision: 2, objective: 'Publish version two', updatedAt: 200 }), false)!
    expect(edited.definition.version).toBe(dependency.definition.version + 1)
    expect(store.get(scope(), parent.id)?.checkpoint.dependencyBindings).toEqual(saved.checkpoint.dependencyBindings)
    store.close()

    const reopened = new GoalStore(path)
    const persisted = reopened.get(scope(), parent.id)!
    expect(persisted.checkpoint.dependencyBindings).toEqual(saved.checkpoint.dependencyBindings)
    expect(goalDependencies(persisted, { get: (_scope, goalId) => reopened.get(scope(), goalId),
      outcome: () => ({ status: 'achieved', definitionVersion: edited.definition.version, nativeCompletion: 'complete' }) }))
      .toMatchObject([{ goalId: dependency.id, status: 'stale', reason: 'definition-changed' }])
    reopened.close()
  })

  it('migrates v2 ID-only dependencies as legacy unresolved and never silently binds them on restart', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const dependency = store.observe(scope(), native({ sessionId: 'legacy-dependency-session', goalId: 'legacy-dependency-goal' }), true)!
    const parent = store.observe(scope(), native({ sessionId: 'legacy-parent-session', goalId: 'legacy-parent-goal' }), true)!
    const saved = store.checkpoint(scope(), parent.id, parent.version, checkpoint({ dependencies: [dependency.id] }))
    store.close()

    const legacy = { ...saved.checkpoint }
    delete legacy.dependencyBindings
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE goal_records SET checkpoint_json = ? WHERE id = ?').run(JSON.stringify(legacy), parent.id)
    raw.prepare("UPDATE goal_history SET payload_json = ? WHERE record_id = ? AND kind = 'checkpoint' AND sequence = (SELECT MAX(sequence) FROM goal_history WHERE record_id = ?)").run(JSON.stringify(legacy), parent.id, parent.id)
    raw.exec('PRAGMA user_version = 2;')
    raw.close()

    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = new GoalStore(path)
      const migrated = reopened.get(scope(), parent.id)!
      expect(migrated.checkpoint).toEqual(legacy)
      expect(goalDependencies(migrated, { get: () => dependency, outcome: () => ({ status: 'achieved', definitionVersion: 1, nativeCompletion: 'complete' }) }))
        .toEqual([{ goalId: dependency.id, status: 'stale', reason: 'legacy-unbound' }])
      reopened.close()
    }
  })

  it('rejects a v2 database that forges Host-only dependency bindings', async () => {
    const path = await database()
    const store = new GoalStore(path)
    const dependency = store.observe(scope(), native({ sessionId: 'forged-dependency-session', goalId: 'forged-dependency-goal' }), true)!
    const parent = store.observe(scope(), native({ sessionId: 'forged-parent-session', goalId: 'forged-parent-goal' }), true)!
    const saved = store.checkpoint(scope(), parent.id, parent.version, checkpoint({ dependencies: [dependency.id] }))
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 2;')
    raw.close()
    expect(() => new GoalStore(path)).toThrow(GoalStoreError)
    expect(saved.checkpoint.dependencyBindings).toHaveLength(1)
  })

  it('rejects malformed persisted dependency bindings instead of trusting caller metadata', () => {
    const store = new GoalStore(':memory:')
    const dependency = store.observe(scope(), native({ sessionId: 'digest-dependency-session', goalId: 'digest-dependency-goal' }), true)!
    const parent = store.observe(scope(), native({ sessionId: 'digest-parent-session', goalId: 'digest-parent-goal' }), true)!
    expect(() => store.checkpoint(scope(), parent.id, parent.version, checkpoint({ dependencies: [dependency.id], dependencyBindings: [{
      goalId: dependency.id, definitionVersion: 1, definitionDigest: 'not-a-sha256',
    }] }))).toThrow(GoalStoreError)
    expect(store.get(scope(), parent.id)?.checkpoint.dependencies).toEqual([])
    store.close()
  })

  it('treats native complete as awaiting verification only', () => {
    const store = new GoalStore(':memory:')
    const record = store.observe(scope(), native({ phase: 'complete' }), true)!
    expect(store.health()).toEqual({ goals: 1, awaitingVerification: 1 })
    expect(Object.keys(record)).not.toContain('verified')
    store.close()
  })

  it('rejects unsafe database files and malformed input objects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'assistant-goals-'))
    expect(lstatSync(directory).mode & 0o077).toBe(0)
    const target = join(directory, 'target.sqlite'); const link = join(directory, 'link.sqlite')
    new GoalStore(target).close(); symlinkSync(target, link)
    expect(() => new GoalStore(link)).toThrow(GoalStoreError)
    chmodSync(target, 0o644)
    expect(() => new GoalStore(target)).toThrow(GoalStoreError)
    const sidecarDirectory = await mkdtemp(join(tmpdir(), 'assistant-goals-'))
    const sidecar = join(sidecarDirectory, 'sidecar.sqlite')
    new GoalStore(sidecar).close()
    writeFileSync(`${sidecar}-wal`, '')
    chmodSync(`${sidecar}-wal`, 0o644)
    expect(() => new GoalStore(sidecar)).toThrow(GoalStoreError)
    const danglingDirectory = await mkdtemp(join(tmpdir(), 'assistant-goals-'))
    const dangling = join(danglingDirectory, 'dangling.sqlite')
    new GoalStore(dangling).close()
    symlinkSync(join(danglingDirectory, 'does-not-exist'), `${dangling}-shm`)
    expect(() => new GoalStore(dangling)).toThrow(GoalStoreError)
    const directoryMode = await mkdtemp(join(tmpdir(), 'assistant-goals-'))
    const directoryDatabase = join(directoryMode, 'directory.sqlite')
    new GoalStore(directoryDatabase).close()
    chmodSync(directoryMode, 0o777)
    expect(() => new GoalStore(directoryDatabase)).toThrow(GoalStoreError)
    const createdDirectory = join(await mkdtemp(join(tmpdir(), 'assistant-goals-')), 'nested')
    const createdDatabase = join(createdDirectory, 'created.sqlite')
    new GoalStore(createdDatabase).close()
    expect(lstatSync(createdDirectory).mode & 0o077).toBe(0)
    const store = new GoalStore(':memory:')
    const unsafe = Object.create(null) as NativeGoalState
    Object.assign(unsafe, native())
    expect(() => store.observe(scope(), unsafe, true)).toThrow(GoalStoreError)
    expect(() => store.observe({ ...scope(), workspace: 'relative' }, native(), true)).toThrow(GoalStoreError)
    expect(() => store.observe(scope(), native({ revision: 0 }), true)).toThrow(GoalStoreError)
    const sparse: string[] = []; sparse.length = 1
    expect(() => store.checkpoint(scope(), 'missing', 1, { ...checkpoint(), blockers: sparse })).toThrow(GoalStoreError)
    store.close()
  })
})
