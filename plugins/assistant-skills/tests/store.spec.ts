import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefinition, type VerifiedWorkflowSource } from '../src/definition.ts'
import { SkillStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const scope = { principalId: 'owner-a', principalRecordId: 'record-a', principalVersion: 1, workspace: '/tmp/workspace', preset: 'primary' }
const otherScope = { ...scope, principalId: 'owner-b', principalRecordId: 'record-b' }
function definition() {
  const source: VerifiedWorkflowSource = { protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: { id: 'goal', definition: { version: 1, digest: 'a'.repeat(64), objective: 'Read.' }, sessionId: 'session', nativeGoalId: 'native' }, runId: 'run', turn: 1,
    acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 }, steps: [{ id: 'read', toolName: 'files_read', arguments: { path: '/tmp/a' } }] }
  return createDefinition(source, { name: 'read-report', description: 'Read a report.', bindings: [{ name: 'path', stepId: 'read', path: '/path' }] }, ['files_read'])
}
async function database() { const root = await mkdtemp(join(tmpdir(), 'assistant-skills-')); roots.push(root); return join(root, 'skills.sqlite') }

describe('SkillStore', () => {
  it('uses immutable version CAS and owner-scoped reads', () => {
    const store = new SkillStore(':memory:'); const first = store.save(scope, definition())
    expect(first.version).toBe(1); expect(store.list(scope)).toHaveLength(1); expect(store.get(otherScope, first.name)).toBeUndefined()
    expect(() => store.save(scope, definition())).toThrow(/version conflict/)
    const second = store.save(scope, definition(), 1)
    expect(second).toMatchObject({ version: 2, parentVersion: 1 }); expect(store.get(scope, first.name, 1)?.version).toBe(1)
    expect(store.retire(scope, first.name, 2)).toMatchObject({ retired: true, version: 2 })
    expect(store.get(scope, first.name)).toBeUndefined(); expect(store.list(scope)).toEqual([]); store.close()
  })

  it('persists runs, fences duplicate finish, and never replays an interrupted run', async () => {
    const path = await database(); const first = new SkillStore(path)
    first.save(scope, definition())
    const claimed = first.claim(scope, { invocationId: 'invoke', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: { path: '/tmp/a' } })
    expect(claimed.claimed).toBe(true); expect(first.claim(scope, { invocationId: 'invoke', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: { path: '/tmp/a' } }).claimed).toBe(false)
    expect(() => first.claim(scope, { invocationId: 'invoke', goalId: 'other', sessionId: 'session', skillName: 'read-report', version: 1, inputs: { path: '/tmp/a' } })).toThrow(/invocation conflict/)
    expect(() => first.claim(scope, { invocationId: 'parallel', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })).toThrow()
    first.close()
    const reopened = new SkillStore(path)
    expect(reopened.getRun(scope, claimed.run.id)).toMatchObject({ state: 'unknown' })
    expect(() => reopened.finish(scope, claimed.run.id, 'succeeded', [])).toThrow(/run state conflict/)
    const later = reopened.claim(scope, { invocationId: 'later', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })
    expect(reopened.checkpoint(scope, later.run.id, [{ id: 'read', state: 'succeeded' }])).toMatchObject({ state: 'running', steps: [{ id: 'read', state: 'succeeded' }] })
    expect(reopened.finish(scope, later.run.id, 'succeeded', [{ id: 'read', state: 'succeeded' }])).toMatchObject({ state: 'succeeded' })
    expect(() => reopened.finish(scope, later.run.id, 'failed', [])).toThrow(/run state conflict/)
    expect(reopened.getRun(otherScope, later.run.id)).toBeUndefined(); reopened.close()
  })

  it('recovers multiple legacy running invocations before adding the per-goal index', async () => {
    const path = await database(); const first = new SkillStore(path)
    first.save(scope, definition())
    const claim = first.claim(scope, { invocationId: 'legacy-first', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })
    first.close()
    const legacy = new DatabaseSync(path)
    legacy.exec("DROP INDEX skill_runs_one_active")
    legacy.prepare("INSERT INTO skill_runs SELECT 'legacy-second', scope_key, json_set(identity_json, '$.invocationId', 'legacy-second'), json_set(run_json, '$.id', 'legacy-second', '$.invocationId', 'legacy-second'), state FROM skill_runs WHERE id=?").run(claim.run.id)
    legacy.close()
    const restored = new SkillStore(path)
    expect(restored.getRun(scope, claim.run.id)?.state).toBe('unknown')
    expect(restored.getRun(scope, 'legacy-second')?.state).toBe('unknown')
    expect(() => restored.finish(scope, claim.run.id, 'succeeded', [])).toThrow(/run state conflict/u)
    restored.close()
  })

  it('creates private state files and rejects a symlinked database', async () => {
    const path = await database(); const store = new SkillStore(path); store.close()
    expect((await lstat(path)).mode & 0o077).toBe(0)
    const root = await mkdtemp(join(tmpdir(), 'assistant-skills-link-')); roots.push(root)
    const target = join(root, 'target.sqlite'); const link = join(root, 'link.sqlite')
    await writeFile(target, 'not a database'); await symlink(target, link)
    expect(() => new SkillStore(link)).toThrow(/unsafe database file/)
  })
})
