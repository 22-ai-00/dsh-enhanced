import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-tools'
import IsolationPlugin from '../src/index.ts'
import { IsolationLedger } from '../src/ledger.ts'
import { AssistantIsolationService } from '../src/service.ts'

const roots: string[] = []
const sleep = async (milliseconds: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, milliseconds))
const image = `sha256:${'a'.repeat(64)}`
const principalDigest = 'a'.repeat(64)

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(leaseMs: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-isolation-controller-startup-')))
  roots.push(root)
  await chmod(root, 0o700)
  const ledger = new IsolationLedger(join(root, 'ledger.sqlite'))
  const authority = ledger.claimController('previous-host', leaseMs)
  return { root, ledger, authority }
}

function controller(root: string) {
  const database = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
  try { return database.prepare('SELECT owner_id, fence FROM isolation_controller WHERE singleton=1').get() as { owner_id: string, fence: number } }
  finally { database.close() }
}

const rawExecution = (name: string, cwd: string) => ({ name, agent: { session: { header: { cwd, agentPreset: 'default' } } } }) as never

test('scope guard blocks raw Host tools while controller startup is pending and after readiness, then unloads', async () => {
  const { root, ledger, authority } = await fixture(30_000)
  const grant = { id: 'scoped-grant', revision: 1, principalDigest, principalRecordId: 'record', principalVersion: 1,
    workspace: '/scoped', agentPreset: 'default', expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 1_000 }
  ledger.syncGrants([grant], authority)
  const context = new Context()
  const mounted = context.plugin(IsolationPlugin, { stateRoot: root, image, grants: [grant] })
  const ownerContext = (mounted as unknown as { ctx: Context }).ctx
  let mountSettled = false, startupError: unknown
  void mounted.then(() => { mountSettled = true }, error => { mountSettled = true; startupError = error })
  let terminal = 0
  const delegate = async () => ({ isError: false as const, value: `delegated-${++terminal}`, content: [] })
  try {
    await expect.poll(() => context.get('assistantIsolation', false)).toBeDefined()
    expect(context.get('assistantIsolation')).toBeUndefined()
    expect(mountSettled).toBe(false)
    expect(startupError).toBeUndefined()
    for (const name of ['write', 'bash']) await expect(ownerContext.waterfall('tools/execute', rawExecution(name, '/scoped'), delegate)).rejects.toThrow(/requires isolated execution/i)
    expect(terminal).toBe(0)
    await expect(ownerContext.waterfall('tools/execute', rawExecution('bash', '/unscoped'), delegate)).resolves.toMatchObject({ value: 'delegated-1' })
    expect(terminal).toBe(1)
    ledger.releaseController(authority)
    await mounted
    await expect(ownerContext.waterfall('tools/execute', rawExecution('bash', '/scoped'), delegate)).rejects.toThrow(/requires isolated execution/i)
    expect(terminal).toBe(1)
    await mounted.dispose()
    await expect(ownerContext.waterfall('tools/execute', rawExecution('write', '/scoped'), delegate)).resolves.toMatchObject({ value: 'delegated-2' })
    expect(terminal).toBe(2)
  } finally { await context.fiber.dispose(); ledger.close() }
})

test('default mount and dependent injection stay pending until a release or expiry during startup', async () => {
  const claimAfterPending = async (mode: 'release' | 'expiry') => {
    const previous = await fixture(mode === 'release' ? 30_000 : 40)
    const context = new Context()
    const mounted = context.plugin(IsolationPlugin, { stateRoot: previous.root })
    let mountSettled = false, startupError: unknown, activations = 0
    void mounted.then(() => { mountSettled = true }, error => { mountSettled = true; startupError = error })
    const dependent = context.inject(['assistantIsolation'], () => { activations++ })
    try {
      await expect.poll(() => context.get('assistantIsolation', false)).toBeDefined()
      expect(context.get('assistantIsolation')).toBeUndefined()
      await sleep(mode === 'release' ? 20 : 60)
      expect(mountSettled).toBe(false)
      expect(startupError).toBeUndefined()
      expect(activations).toBe(0)
      if (mode === 'release') previous.ledger.releaseController(previous.authority)
      await mounted
      await dependent
      expect(activations).toBe(1)
      expect(controller(previous.root)).toMatchObject({ fence: previous.authority.fence + 1 })
      expect(previous.ledger.renewController(previous.authority, 500)).toBe(false)
      expect(() => previous.ledger.syncGrants([], previous.authority)).toThrow(/controller/i)
    } finally { await context.fiber.dispose(); previous.ledger.close() }
  }

  await claimAfterPending('release')
  await claimAfterPending('expiry')
})

test('claims the next fence after a released lease', async () => {
  const released = await fixture(30_000)
  const context = new Context()
  try {
    released.ledger.releaseController(released.authority)
    await context.plugin(IsolationPlugin, { stateRoot: released.root })
    expect(controller(released.root)).toMatchObject({ fence: released.authority.fence + 1 })
  } finally { await context.fiber.dispose(); released.ledger.close() }
})

test('does not steal a renewing live controller lease', async () => {
  const { root, ledger, authority } = await fixture(500)
  const context = new Context()
  const pending = context.plugin(AssistantIsolationService, { stateRoot: root })
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  const renewal = setInterval(() => { ledger.renewController(authority, 500) }, 100)
  try {
    await sleep(750)
    expect(settled).toBe(false)
    expect(controller(root)).toEqual({ owner_id: 'previous-host', fence: authority.fence })
  } finally {
    clearInterval(renewal)
    await context.fiber.dispose()
    ledger.close()
  }
})

test('rejects startup at its bounded deadline while a live owner keeps renewing', async () => {
  vi.useFakeTimers()
  const { root, ledger, authority } = await fixture(500)
  const context = new Context()
  const pending = context.plugin(IsolationPlugin, { stateRoot: root })
  const renewal = setInterval(() => { ledger.renewController(authority, 500) }, 100)
  const database = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
  const baseline = database.prepare('SELECT (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_jobs) AS jobs').get()
  database.close()
  try {
    await vi.advanceTimersByTimeAsync(31_100)
    await expect(pending).rejects.toThrow(/controller is owned by another host/i)
    expect(controller(root)).toEqual({ owner_id: 'previous-host', fence: authority.fence })
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
    try { expect(reader.prepare('SELECT (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_jobs) AS jobs').get()).toEqual(baseline) }
    finally { reader.close() }
  } finally {
    clearInterval(renewal)
    await context.fiber.dispose()
    ledger.close()
    vi.useRealTimers()
  }
})

test('cancellation while waiting cannot claim later or mutate grants and usage', async () => {
  const { root, ledger, authority } = await fixture(30_000)
  const grant = { id: 'existing-grant', revision: 1, principalDigest, principalRecordId: 'record', principalVersion: 1,
    workspace: '/workspace', agentPreset: 'default', expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 1_000 }
  ledger.syncGrants([grant], authority)
  const database = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
  const baseline = database.prepare('SELECT (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_jobs) AS jobs, (SELECT COUNT(*) FROM isolation_audit) AS audits').get()
  database.close()
  const context = new Context()
  const pending = context.plugin(IsolationPlugin, { stateRoot: root, image, grants: [grant] })
  let startupError: unknown, settled = false
  void pending.then(() => { settled = true }, error => { settled = true; startupError = error })
  try {
    await expect.poll(() => context.get('assistantIsolation', false)).toBeDefined()
    expect(context.get('assistantIsolation')).toBeUndefined()
    await sleep(30)
    expect(settled).toBe(false)
    expect(startupError).toBeUndefined()
    await pending.dispose()
    await sleep(750)
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
    try {
      expect(reader.prepare('SELECT owner_id, fence FROM isolation_controller WHERE singleton=1').get()).toEqual({ owner_id: 'previous-host', fence: authority.fence })
      expect(reader.prepare('SELECT (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_jobs) AS jobs, (SELECT COUNT(*) FROM isolation_audit) AS audits').get()).toEqual(baseline)
    } finally { reader.close() }
  } finally { await context.fiber.dispose(); ledger.close() }
})
