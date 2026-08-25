import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileObservation } from '../src/sensors.ts'
import { EventTriggersService } from '../src/service.ts'
import { EventTriggerStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakePolicy extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize() { return { effect: 'allow', reasonCode: 'rule-allow' } }
}

class FakeAutomations extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  ingestExternal(input: Record<string, unknown>) { return input }
}

async function harness(pollerEnabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-lifecycle-'))
  roots.push(root)
  const ctx = new Context()
  new FakePolicy(ctx)
  new FakeAutomations(ctx)
  let release: (response: Response) => void = () => {}
  let calls = 0
  const fetcher = vi.fn(() => {
    calls += 1
    if (calls > 1) return Promise.resolve(new Response('{"ready":true}', { status: 200 }))
    return new Promise<Response>(resolve => { release = resolve })
  })
  const service = new EventTriggersService(ctx, {
    databasePath: join(root, 'events.sqlite'),
    allowedHttpHosts: ['api.example.com'],
    pollerEnabled,
    pollIntervalMs: 1_000,
    triggers: [{
      id: 'remote', kind: 'http-json', automationId: 'remote-task',
      url: 'https://api.example.com/state', pointer: '/ready', fireWhen: 'changed',
      debounceMs: 0, cooldownMs: 0, maxFires: 10,
    }],
  }, {
    fetcher,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  })
  return { ctx, fetcher, release: (response: Response) => release(response), service }
}

describe('event trigger runtime lifecycle', () => {
  test('coalesces slow poll intervals and starts the next poll only after release', async () => {
    vi.useFakeTimers()
    const fixture = await harness(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fixture.fetcher).toHaveBeenCalledOnce()

    fixture.release(new Response('{"ready":true}', { status: 200 }))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fixture.fetcher).toHaveBeenCalledTimes(2)
    await fixture.ctx.fiber.restart()
  })

  test('cancels an in-flight network poll before closing its durable store', async () => {
    const fixture = await harness(false)
    const polling = fixture.service.pollOnce().then(() => 'resolved', error => String(error))
    await Promise.resolve()

    let disposed = false
    const disposing = fixture.ctx.fiber.restart().then(() => { disposed = true })
    const shutdownOutcome = await Promise.race([
      disposing.then(() => 'disposed'),
      new Promise<'blocked'>(resolve => setImmediate(() => resolve('blocked'))),
    ])

    fixture.release(new Response('{"ready":true}', { status: 200 }))
    await expect(polling).resolves.toMatch(/disposed|abort/i)
    await expect(disposing).resolves.toBeUndefined()
    expect(shutdownOutcome).toBe('disposed')
    expect(disposed).toBe(true)
  })

  test('starts a later file trigger while the first HTTP trigger is still pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-concurrent-poll-'))
    roots.push(root)
    const watched = join(root, 'watched.txt')
    await writeFile(watched, 'baseline')
    const ctx = new Context()
    new FakePolicy(ctx)
    new FakeAutomations(ctx)
    let releaseFetch!: (response: Response) => void
    let fetchStarted!: () => void
    const didStartFetch = new Promise<void>(resolve => { fetchStarted = resolve })
    let fileCompleted!: (beforeFetchRelease: boolean) => void
    const didCompleteFile = new Promise<boolean>(resolve => { fileCompleted = resolve })
    let fetchReleased = false
    const service = new EventTriggersService(ctx, {
      databasePath: join(root, 'events.sqlite'),
      allowedFileRoots: [root],
      allowedHttpOrigins: ['https://api.example.com'],
      pollerEnabled: false,
      pollConcurrency: 2,
      triggers: [
        { id: 'slow', kind: 'http-json', automationId: 'slow-task', url: 'https://api.example.com/state',
          pointer: '', fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10 },
        { id: 'file', kind: 'file', automationId: 'file-task', path: watched,
          fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10 },
      ],
    }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () => {
        fetchStarted()
        return new Promise<Response>(resolve => { releaseFetch = resolve })
      },
      fileObserver: async input => {
        const observation = await readFileObservation(input)
        fileCompleted(!fetchReleased)
        return observation
      },
    })
    const polling = service.pollOnce()
    await didStartFetch
    // The timeout is only a watchdog for a broken sequential implementation;
    // successful synchronization is driven by the file-observation event.
    let watchdog!: ReturnType<typeof setTimeout>
    const completedBeforeRelease = await Promise.race([
      didCompleteFile,
      new Promise<false>(resolve => { watchdog = setTimeout(() => resolve(false), 5_000) }),
    ])
    clearTimeout(watchdog)
    fetchReleased = true
    releaseFetch(new Response('{}'))
    await polling

    expect(completedBeforeRelease).toBe(true)
    expect(service.health()).toMatchObject({ triggersObserved: 2 })
    await ctx.fiber.restart()
  }, 10_000)

  test('times out saturated uncooperative file observations without leaking or starving later triggers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-file-deadline-'))
    roots.push(root)
    const paths = [join(root, 'hung-one'), join(root, 'hung-two'), join(root, 'healthy')]
    await Promise.all(paths.map(path => writeFile(path, 'baseline')))
    const ctx = new Context()
    new FakePolicy(ctx)
    new FakeAutomations(ctx)
    let releaseHung!: (observation: { fingerprint: string; truthy: boolean }) => void
    const neverUntilReleased = new Promise<{ fingerprint: string; truthy: boolean }>(resolve => {
      releaseHung = resolve
    })
    const fileObserver = vi.fn(async (input: { path: string }) => {
      if (input.path !== paths[2]) return neverUntilReleased
      return { fingerprint: 'healthy-baseline', truthy: true }
    })
    const service = new EventTriggersService(ctx, {
      databasePath: join(root, 'events.sqlite'),
      allowedFileRoots: [root],
      pollerEnabled: false,
      pollConcurrency: 2,
      requestTimeoutMs: 100,
      triggers: paths.map((path, index) => ({
        id: `file-${index}`, kind: 'file' as const, automationId: `file-task-${index}`, path,
        fireWhen: 'changed' as const, debounceMs: 0, cooldownMs: 0, maxFires: 10,
      })),
    }, { fileObserver })

    const first = service.pollOnce().then(() => 'settled', () => 'settled')
    await expect(Promise.race([
      first,
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500)),
    ])).resolves.toBe('settled')
    expect(fileObserver.mock.calls.map(([input]) => input.path)).toEqual(paths)
    expect(service.health()).toMatchObject({ triggersObserved: 1, failingTriggers: 2 })

    await service.pollOnce().catch(() => {})
    expect(fileObserver.mock.calls.filter(([input]) => input.path !== paths[2])).toHaveLength(2)
    expect(fileObserver.mock.calls.filter(([input]) => input.path === paths[2])).toHaveLength(2)

    await expect(Promise.race([
      ctx.fiber.restart().then(() => 'disposed'),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500)),
    ])).resolves.toBe('disposed')

    releaseHung({ fingerprint: 'late-result-must-be-discarded', truthy: true })
    await new Promise<void>(resolve => setImmediate(resolve))
    const reopened = new EventTriggerStore({ path: join(root, 'events.sqlite') })
    expect(reopened.health()).toMatchObject({ triggersObserved: 1, failingTriggers: 2 })
    reopened.close()
  })

  test('pins an allowlisted root at service initialization across later polls', async () => {
    const container = await mkdtemp(join(tmpdir(), 'event-triggers-service-root-pin-'))
    const outside = await mkdtemp(join(tmpdir(), 'event-triggers-service-root-outside-'))
    roots.push(container, outside)
    const allowed = join(container, 'allowed')
    const original = join(container, 'allowed-original')
    const path = join(allowed, 'watched.txt')
    await mkdir(allowed)
    await writeFile(path, 'safe')
    await writeFile(join(outside, 'watched.txt'), 'outside-secret')
    const ctx = new Context()
    new FakePolicy(ctx)
    new FakeAutomations(ctx)
    const service = new EventTriggersService(ctx, {
      databasePath: join(container, 'events.sqlite'),
      allowedFileRoots: [allowed],
      pollerEnabled: false,
      triggers: [{ id: 'file', kind: 'file', automationId: 'file-task', path,
        fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10 }],
    })

    await rename(allowed, original)
    await symlink(outside, allowed, 'dir')

    await expect(service.pollOnce()).rejects.toThrow(/root|allowlist|changed|escape/i)
    expect(service.health()).toMatchObject({ triggersObserved: 0, failingTriggers: 1 })
    await ctx.fiber.restart()
  })

  test('keeps an uncooperative DNS operation pinned across wrapper timeouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-dns-leak-'))
    roots.push(root)
    const ctx = new Context()
    new FakePolicy(ctx)
    new FakeAutomations(ctx)
    let releaseLookup!: (addresses: Array<{ address: string; family: number }>) => void
    const pendingLookup = new Promise<Array<{ address: string; family: number }>>(resolve => {
      releaseLookup = resolve
    })
    const lookup = vi.fn(async () => pendingLookup)
    const service = new EventTriggersService(ctx, {
      databasePath: join(root, 'events.sqlite'),
      allowedHttpOrigins: ['https://api.example.com'],
      pollerEnabled: false,
      requestTimeoutMs: 100,
      triggers: [{ id: 'remote', kind: 'http-json', automationId: 'remote-task',
        url: 'https://api.example.com/state', pointer: '', fireWhen: 'changed',
        debounceMs: 0, cooldownMs: 0, maxFires: 10 }],
    }, { lookup, fetcher: async () => new Response('{}') })

    await service.pollOnce().catch(() => {})
    await service.pollOnce().catch(() => {})
    expect(lookup).toHaveBeenCalledOnce()

    await expect(Promise.race([
      ctx.fiber.restart().then(() => 'disposed'),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500)),
    ])).resolves.toBe('disposed')
    releaseLookup([{ address: '93.184.216.34', family: 4 }])
    await new Promise<void>(resolve => setImmediate(resolve))
    const reopened = new EventTriggerStore({ path: join(root, 'events.sqlite') })
    expect(reopened.health()).toMatchObject({ triggersObserved: 0, failingTriggers: 1 })
    reopened.close()
  })
})
