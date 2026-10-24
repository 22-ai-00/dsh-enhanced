import { spawn } from 'node:child_process'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { admitRestartContinuation, createRestartContinuation, RestartContinuationError } from '../src/restart-native.ts'

const roots: string[] = []
const fixture = new URL('./fixtures/restart-native-child.mjs', import.meta.url)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function runChild(mode: string, root: string, killOn?: string): Promise<{
  exitCode: number | null; signal: NodeJS.Signals | null; events: Record<string, unknown>[]; stderr: string
}> {
  const child = spawn(process.execPath, [fixture.pathname, mode, root], { stdio: ['ignore', 'pipe', 'pipe'] })
  const events: Record<string, unknown>[] = []
  let stdout = ''
  let stderr = ''
  let killed = false
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    while (stdout.includes('\n')) {
      const end = stdout.indexOf('\n')
      const line = stdout.slice(0, end)
      stdout = stdout.slice(end + 1)
      if (!line.startsWith('{')) continue
      const event = JSON.parse(line) as Record<string, unknown>
      events.push(event)
      if (!killed && killOn !== undefined && event.event === killOn) {
        killed = true
        child.kill('SIGKILL')
      }
    }
  })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  clearTimeout(timer)
  return { ...result, events, stderr }
}

function event(result: Awaited<ReturnType<typeof runChild>>, kind: string): Record<string, unknown> {
  const found = result.events.find(value => value.event === kind)
  if (found === undefined) throw new Error(`missing ${kind}: ${JSON.stringify(result)}`)
  return found
}

describe('native restart continuation in a real JSONL Session and child process', () => {
  test('SIGKILL after a durable pending splice resumes the same Session once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-restart-')); roots.push(root)
    const seed = await runChild('seed', root, 'seeded')
    expect(seed.signal).toBe('SIGKILL')
    expect(event(seed, 'seeded')).toMatchObject({ state: 'pending', calls: 0 })
    const resumed = await runChild('resume', root)
    expect(resumed.exitCode).toBe(0)
    expect(event(resumed, 'settled')).toMatchObject({ state: { kind: 'settled', reason: 'completed' }, calls: 1 })
    const repeat = await runChild('inspect', root)
    expect(repeat.exitCode).toBe(0)
    expect(event(repeat, 'inspected')).toMatchObject({ state: { kind: 'settled', reason: 'completed' }, calls: 0 })
  }, 75_000)

  test('SIGKILL after native claim never redispatches an unknown model call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-restart-')); roots.push(root)
    const claimed = await runChild('claim', root, 'model-start')
    expect(claimed.signal).toBe('SIGKILL')
    expect(event(claimed, 'model-start')).toMatchObject({ calls: 1 })
    const resumed = await runChild('resume', root)
    expect(resumed.exitCode).toBe(0)
    expect(event(resumed, 'settled')).toMatchObject({ state: { kind: 'settled', reason: 'interrupted' }, calls: 0 })
  }, 60_000)

  test.each(['resume-false', 'resume-throw'] as const)('flush %s suppresses the latched wake', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-restart-')); roots.push(root)
    expect((await runChild('seed', root, 'seeded')).signal).toBe('SIGKILL')
    const resumed = await runChild(mode, root)
    expect(resumed.exitCode).toBe(0)
    expect(event(resumed, 'settled')).toMatchObject({ calls: 0,
      error: { name: 'RestartContinuationError', code: 'flush-failed' } })
  }, 60_000)

  test('owner revocation after flush suppresses the latched wake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-restart-')); roots.push(root)
    expect((await runChild('seed', root, 'seeded')).signal).toBe('SIGKILL')
    const resumed = await runChild('resume-revoke', root)
    expect(resumed.exitCode).toBe(0)
    expect(event(resumed, 'settled')).toMatchObject({ calls: 0,
      error: { name: 'RestartContinuationError', code: 'authorization-revoked' } })
  }, 60_000)

  test('native followup throwing after its append cannot release a model wake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-restart-')); roots.push(root)
    expect((await runChild('seed', root, 'seeded')).signal).toBe('SIGKILL')
    const resumed = await runChild('resume-followup-throw', root)
    expect(resumed.exitCode).toBe(0)
    expect(event(resumed, 'settled')).toMatchObject({ calls: 0,
      error: { name: 'Error', message: 'fixture throw after native append' } })
  }, 60_000)

  test('same native identity with a different payload is refused before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-restart-')); roots.push(root)
    expect((await runChild('seed', root, 'seeded')).signal).toBe('SIGKILL')
    const drift = await runChild('resume-drift', root)
    expect(drift.exitCode).toBe(0)
    expect(event(drift, 'settled')).toMatchObject({ calls: 0,
      error: { name: 'RestartContinuationError', code: 'conflict' } })
  }, 60_000)

  test('completed native continuation cannot be dispatched twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-restart-')); roots.push(root)
    const first = await runChild('settle', root)
    expect(first.exitCode).toBe(0)
    expect(event(first, 'settled')).toMatchObject({ calls: 1, state: { kind: 'settled' } })
    const next = await runChild('resume', root)
    expect(next.exitCode).toBe(0)
    expect(event(next, 'settled')).toMatchObject({ calls: 0, state: { kind: 'settled' } })
  }, 60_000)
})

test('maintenance admission invokes its Host commit only after flush and repeated authorization', async () => {
  const message = createRestartContinuation({ continuationId: 'callback-barrier', text: 'Resume' })
  const order: string[] = []
  const nextTurn: typeof message[] = []
  const agent = {
    session: { snapshotEvents: () => [] },
    inbox: { nextTurn, nextStep: [], remove: () => false },
    runMaintenance: async (work: (signal: AbortSignal) => Promise<unknown>) => {
      const result = await work(new AbortController().signal)
      order.push('maintenance-released')
      return result
    },
    followup: () => { nextTurn.push(message); order.push('followup') },
    cancel: () => { order.push('cancel') },
  } as unknown as Agent
  let authorized = true
  const authorize = () => {
    order.push('authorize')
    if (!authorized) throw new RestartContinuationError('authorization-revoked', 'owner permission changed')
  }
  const onAdmitted = () => { order.push('commit') }
  const admitted = await admitRestartContinuation(agent, message, {
    authorize, flush: async () => { order.push('flush'); return true }, onAdmitted,
  })
  expect(admitted.kind).toBe('pending')
  expect(order).toEqual(['authorize', 'followup', 'flush', 'authorize', 'commit', 'maintenance-released'])

  order.length = 0
  nextTurn.length = 0
  await expect(admitRestartContinuation(agent, message, {
    authorize, flush: async () => { order.push('flush'); return false }, onAdmitted,
  })).rejects.toMatchObject({ code: 'flush-failed' })
  expect(order).not.toContain('commit')
  expect(order).toContain('cancel')

  order.length = 0
  nextTurn.length = 0
  await expect(admitRestartContinuation(agent, message, {
    authorize, flush: async () => { order.push('flush'); authorized = false; return true }, onAdmitted,
  })).rejects.toMatchObject({ code: 'authorization-revoked' })
  expect(order).not.toContain('commit')
  expect(order).toContain('cancel')
})
