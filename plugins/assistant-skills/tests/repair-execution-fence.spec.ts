import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SkillStore, type RepairExecutionLease, type SkillRepairAuthorizationInput } from '../src/store.ts'
import { probeRepairProcess } from '../src/repair-process.ts'

const roots: string[] = []
const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/workspace', preset: 'primary' }
const authorization = (expiresAt = Date.now() + 60_000): SkillRepairAuthorizationInput => ({ invocationId: 'repair', ownerRouteId: 'route', source: { goalId: 'goal', sessionId: 'source-session', nativeGoalId: 'native', definitionDigest: 'a'.repeat(64) }, profileId: 'profile', profileDigest: 'b'.repeat(64), skillName: 'repair-skill', parentVersion: 1, parentDigest: 'c'.repeat(64), maxIterations: 1, expiresAt })

async function database(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'repair-fence-')); roots.push(root); return join(root, 'skills.sqlite') }
function create(store: SkillStore, expiresAt = Date.now() + 60_000) { return store.createRepairContinuation(scope, authorization(expiresAt), { receipt: true }) }
function claim(store: SkillStore, id: string, deadlineAt: number, holder = 'holder') { return store.claimRepairExecution(scope, id, 1, 'repair-session', holder, deadlineAt, { recover: false }) }
function witness(pid: number) {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase(), raw = readFileSync(`/proc/${pid}/stat`, 'utf8'), close = raw.lastIndexOf(') ')
  const namespace = statSync('/proc/self/ns/pid')
  return { bootId, pid, startTicks: raw.slice(close + 2).trim().split(/\s+/u)[19]!, pidNamespace: `linux:${namespace.dev}:${namespace.ino}` }
}
async function child(): Promise<ReturnType<typeof spawn>> {
  const value = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { value.once('spawn', resolve); value.once('error', reject) })
  return value
}
function replaceProcess(path: string, lease: RepairExecutionLease, process: RepairExecutionLease['process']): void {
  replaceLease(path, { ...lease, process })
}
function replaceLease(path: string, lease: RepairExecutionLease): void {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare('SELECT scope_key FROM skill_repair_execution WHERE id=? AND iteration=?').get(lease.authorizationId, lease.iteration) as { scope_key: string }
    db.prepare('UPDATE skill_repair_execution SET lease_json=?,fence=?,state=?,pending_model=?,pending_tool=? WHERE scope_key=? AND id=? AND iteration=?').run(JSON.stringify(lease), lease.fence, lease.state, lease.pendingModel, lease.pendingTool, row.scope_key, lease.authorizationId, lease.iteration)
  } finally { db.close() }
}
async function gracefulChildRelease(path: string, scope: object, lease: RepairExecutionLease): Promise<void> {
  const module = join(dirname(fileURLToPath(import.meta.url)), '../lib/store.js')
  const script = "const { SkillStore } = await import(process.argv[1]); let raw=''; process.stdin.on('data', chunk => raw += chunk); process.stdin.on('end', () => { const input=JSON.parse(raw); const store=new SkillStore(input.path); store.releaseRepairExecution(input.scope,input.lease); store.close(); });"
  const value = spawn(process.execPath, ['--input-type=module', '--eval', script, new URL(`file://${module}`).href], { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''; value.stderr.on('data', chunk => { stderr += String(chunk) })
  await new Promise<void>((resolve, reject) => { value.once('spawn', resolve); value.once('error', reject) })
  const childLease = { ...lease, holderId: 'child-holder', process: witness(value.pid!) }
  replaceLease(path, childLease)
  value.stdin.end(JSON.stringify({ path, scope, lease: childLease }))
  await new Promise<void>((resolve, reject) => value.once('exit', code => code === 0 ? resolve() : reject(new Error(`child release exited ${code}: ${stderr}`))))
}

afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('repair execution fence', () => {
  test.skipIf(process.platform !== 'linux')('a namespace mismatch is unavailable even when the recorded PID is absent', () => {
    const current = witness(process.pid)
    const [kind, device, inode] = current.pidNamespace.split(':')
    expect(probeRepairProcess({ ...current, pid: 2_147_483_647, pidNamespace: `${kind}:${device}:${BigInt(inode!) + 1n}` })).toBe('unavailable')
  })

  test.skipIf(process.platform !== 'linux')('a live child holder blocks recovery; SIGKILL permits a pending-free takeover and fences the old lease', async () => {
    const path = await database(), first = new SkillStore(path), record = create(first), lease = claim(first, record.id, record.authorization.expiresAt), holder = await child()
    try {
      replaceProcess(path, lease, witness(holder.pid!)); const second = new SkillStore(path)
      expect(() => second.claimRepairExecution(scope, record.id, 1, 'repair-session', 'new-holder', record.authorization.expiresAt, { recover: true })).toThrow(/remains authoritative/u)
      holder.kill('SIGKILL'); await new Promise<void>(resolve => holder.once('exit', () => resolve()))
      const replacement = second.claimRepairExecution(scope, record.id, 1, 'repair-session', 'new-holder', record.authorization.expiresAt, { recover: true })
      expect(replacement.fence).toBe(lease.fence + 1)
      expect(() => second.assertRepairExecution(scope, lease)).toThrow(/fence conflict/u)
      second.close()
    } finally { if (!holder.killed) holder.kill('SIGKILL'); first.close() }
  })

  test('unsettled model or tool effects prohibit takeover and exact finish settles them', async () => {
    const path = await database(), first = new SkillStore(path), record = create(first), lease = claim(first, record.id, record.authorization.expiresAt)
    const model = first.beginRepairEffect(scope, lease, 'model'), tool = first.beginRepairEffect(scope, lease, 'tool')
    expect(() => first.releaseRepairExecution(scope, lease)).toThrow(/effects remain pending/u)
    const second = new SkillStore(path)
    // A forged dead owner cannot convert external work into a settled effect.
    replaceProcess(path, second.inspectRepairExecution(scope, record.id, 1)!, { ...lease.process, startTicks: String(Number(lease.process.startTicks) + 1) })
    expect(() => second.claimRepairExecution(scope, record.id, 1, 'repair-session', 'next', record.authorization.expiresAt, { recover: true })).toThrow(/remains authoritative/u)
    // Restore the real holder only to demonstrate precise owned settlement.
    replaceProcess(path, second.inspectRepairExecution(scope, record.id, 1)!, lease.process); model(); tool()
    expect(second.inspectRepairExecution(scope, record.id, 1)).toMatchObject({ pendingModel: 0, pendingTool: 0 })
    second.close(); first.close()
  })

  test.skipIf(process.platform !== 'linux')('a graceful child release remains recoverable by a new host only after its process exits', async () => {
    const path = await database(), first = new SkillStore(path), record = create(first), lease = claim(first, record.id, record.authorization.expiresAt)
    await gracefulChildRelease(path, scope, lease)
    const second = new SkillStore(path)
    const recovered = second.claimRepairExecution(scope, record.id, 1, 'repair-session', 'new-host', record.authorization.expiresAt, { recover: true })
    expect(recovered).toMatchObject({ state: 'active', holderId: 'new-host', fence: lease.fence + 1, deadlineAt: lease.deadlineAt })
    first.close(); second.close()
  })

  test('two store instances serialize a first claim, and same-process release can reattach without extending the deadline', async () => {
    const path = await database(), first = new SkillStore(path), second = new SkillStore(path), record = create(first), lease = claim(first, record.id, record.authorization.expiresAt)
    expect(() => second.claimRepairExecution(scope, record.id, 1, 'repair-session', 'other', record.authorization.expiresAt, { recover: false })).toThrow(/recovery required/u)
    first.releaseRepairExecution(scope, lease)
    const reattached = second.claimRepairExecution(scope, record.id, 1, 'repair-session', 'same-process', record.authorization.expiresAt, { recover: true })
    expect(reattached).toMatchObject({ deadlineAt: lease.deadlineAt, fence: lease.fence + 1, state: 'active' })
    first.close(); second.close()
  })

  test('deadline expiry rejects assert/begin; revoked effects can settle and release without restoring recovery', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const store = new SkillStore(':memory:'), record = create(store), lease = claim(store, record.id, record.authorization.expiresAt)
    const finish = store.beginRepairEffect(scope, lease, 'model')
    const revoked = store.transitionRepairContinuation(scope, record.id, record.revision, 'revoked', {})
    expect(revoked.state).toBe('revoked')
    expect(() => store.assertRepairExecution(scope, lease)).toThrow(/authorization unavailable/u)
    expect(() => store.beginRepairEffect(scope, lease, 'model')).toThrow(/authorization unavailable/u)
    finish(); store.releaseRepairExecution(scope, lease)
    expect(store.inspectRepairExecution(scope, record.id, 1)).toMatchObject({ state: 'released', pendingModel: 0 })
    expect(() => store.claimRepairExecution(scope, record.id, 1, 'repair-session', 'after-revoke', lease.deadlineAt, { recover: true })).toThrow(/authorization unavailable/u)
    const authorizationExpiry = Date.now() + 60_000, deadline = Date.now() + 1
    const expiring = store.createRepairContinuation(scope, { ...authorization(authorizationExpiry), invocationId: 'repair-expiry' }, { receipt: true })
    const expiringLease = claim(store, expiring.id, deadline, 'expiry-holder')
    vi.advanceTimersByTime(2)
    expect(() => store.assertRepairExecution(scope, expiringLease)).toThrow(/authorization unavailable/u)
    expect(() => store.beginRepairEffect(scope, expiringLease, 'model')).toThrow(/authorization unavailable/u)
    store.close()
  })
})
