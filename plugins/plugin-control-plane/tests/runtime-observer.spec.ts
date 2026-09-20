import { createHmac, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PluginControlPlaneService } from '../src/service.js'
import { installRuntimeObserver, queryRuntimeObserver, runtimeConfigDigest, validateRuntimeObserverConfig, type RuntimeObservation, type RuntimeObserverConfig } from '../src/runtime-observer.js'

const createdServers = vi.hoisted(() => [] as Server[])
vi.mock('node:net', async importOriginal => {
  const original = await importOriginal<typeof import('node:net')>()
  return { ...original, createServer: (...args: Parameters<typeof original.createServer>) => {
    const server = original.createServer(...args); createdServers.push(server); return server
  } }
})

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  createdServers.length = 0
})
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
async function eventually(assertion: () => Promise<void>): Promise<void> {
  let last: unknown
  for (let count = 0; count < 200; count++) { try { await assertion(); return } catch (error) { last = error; await pause() } }
  throw last
}
async function fixture(load = true, services = ['candidateService']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ro-'))
  const ctx = new Context(); fixtures.push({ ctx, root })
  const profile = join(root, 'profiles', 'fixture'); const owner = join(root, 'owner')
  await mkdir(profile, { recursive: true }); await mkdir(owner, { mode: 0o700 })
  const keyPath = join(owner, 'key'); await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
  const pkg = join(profile, 'node_modules', 'observer-fixture')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'observer-fixture', type: 'module', exports: './index.js' }))
  await writeFile(join(pkg, 'index.js'), `export default { name: 'observer-fixture', inject: ['fixtureDependency'], apply(ctx) { ctx.provide('candidateService', { ready: true }); } }\n`)
  const config: RuntimeObserverConfig = { socketPath: join(owner, 'observe.sock'), keyPath, profilePath: profile,
    targets: [{ entryId: 'candidate', module: './node_modules/observer-fixture/index.js', configDigest: runtimeConfigDigest({ option: 1 }), services }] }
  const controlConfig = { catalogPath: join(owner, 'catalog.json'), trustPath: join(owner, 'trust.json'), statePath: join(owner, 'state'), runtimeObserver: config }
  const control = ctx.plugin(PluginControlPlaneService, controlConfig); await control
  ctx.baseUrl = pathToFileURL(join(profile, 'cordis.yml')).href
  const addLoader = async () => { const fiber = ctx.plugin(Loader); await fiber; return fiber }
  const loader = load ? await addLoader() : undefined
  const addCandidate = () => { const options = { id: 'candidate', name: config.targets[0]!.module, config: { option: 1 } }; return ctx.loader.create(options) }
  const dependency = () => ctx.plugin({ name: 'fixture-dependency', apply(c: Context) { c.provide('fixtureDependency', {}) } })
  const query = () => queryRuntimeObserver(config)
  if (load) await eventually(async () => { expect((await lstat(config.socketPath)).mode & 0o777).toBe(0o600) })
  return { ctx, root, owner, config, controlConfig, control, loader, addLoader, addCandidate, dependency, query }
}

describe.skipIf(process.platform !== 'linux')('owner runtime observer on the pinned Loader', () => {
  test('foreground consumers share socket identity and epochs, and lose sampling on teardown', async () => {
    const f = await fixture(); await f.dependency(); await f.addCandidate()
    const config = { ...f.config, socketPath: join(f.owner, 'foreground.sock') }
    let sample: ((challenge: string) => RuntimeObservation) | undefined
    const detached = vi.fn()
    const fiber = f.ctx.plugin({ name: 'foreground-observer-fixture', apply(ctx: Context) {
      installRuntimeObserver(ctx, config, (_ctx, sampler) => { sample = sampler; return detached })
    } })
    await fiber
    await eventually(async () => { expect(await queryRuntimeObserver(config)).toMatchObject({ processId: process.pid }) })
    const socket = await queryRuntimeObserver(config), local = sample!(socket.challenge)
    expect(local.observerId).toBe(socket.observerId); expect(local.entries).toEqual(socket.entries)
    await f.ctx.loader.update('candidate', { config: { option: 2 } })
    const next = await queryRuntimeObserver(config)
    expect(sample!(next.challenge).entries).toEqual(next.entries)
    expect(next.entries[0]?.instance?.epoch).not.toBe(socket.entries[0]?.instance?.epoch)
    await fiber.dispose()
    expect(detached).toHaveBeenCalledTimes(1)
    expect(() => sample!('a'.repeat(64))).toThrow()
    await expect(lstat(config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('distinguishes missing and injection-pending entries from actual active services', async () => {
    const f = await fixture()
    expect((await f.query()).entries[0]).toMatchObject({ active: false, instance: null, module: null })
    await f.addCandidate()
    expect((await f.query()).entries[0]).toMatchObject({ active: false, instance: null, module: f.config.targets[0]!.module })
    await f.dependency(); await f.ctx.loader.await()
    const observed = await f.query()
    expect(observed).toMatchObject({ kind: 'dsh-runtime-observation', processId: process.pid, profilePath: f.config.profilePath })
    expect(observed.entries[0]).toMatchObject({ active: true, configDigest: runtimeConfigDigest({ option: 1 }),
      services: [{ name: 'candidateService', instance: { uid: expect.any(Number), epoch: expect.any(Number) } }],
      dependencies: [{ name: 'fixtureDependency', instance: { uid: expect.any(Number), epoch: expect.any(Number) } }] })
    const second = await f.query()
    expect(second.challenge).not.toBe(observed.challenge)
    expect(second.entries).toEqual(observed.entries)
    expect(second.observerId).toBe(observed.observerId)
  })

  test('detects same-uid Fiber restart and config drift through store epochs', async () => {
    const f = await fixture(); await f.dependency(); await f.addCandidate()
    const first = (await f.query()).entries[0]!
    await f.ctx.loader.update('candidate', { config: { option: 2 } })
    const second = (await f.query()).entries[0]!
    expect(second.active).toBe(false)
    expect(second.instance?.uid).toBe(first.instance?.uid)
    expect(second.instance?.epoch).not.toBe(first.instance?.epoch)
    await f.ctx.loader.update('candidate', { config: { option: 1 } })
    expect((await f.query()).entries[0]?.active).toBe(true)
  })

  test('tracks provider removal and replacement without caching its service proxy', async () => {
    const f = await fixture(); const provider = await f.dependency(); await f.addCandidate()
    const first = (await f.query()).entries[0]!
    await provider.dispose(); await f.ctx.loader.await()
    expect((await f.query()).entries[0]?.active).toBe(false)
    await f.dependency(); await f.ctx.loader.await()
    const after = (await f.query()).entries[0]!
    expect(after.active).toBe(true)
    expect(after.dependencies[0]?.instance?.uid).not.toBe(first.dependencies[0]?.instance?.uid)
    expect(after.instance?.epoch).not.toBe(first.instance?.epoch)
  })

  test('recognizes a native Host root-owned dependency with uid zero as active', async () => {
    const f = await fixture()
    f.ctx.provide('fixtureDependency', {})
    await f.addCandidate()
    expect((await f.query()).entries[0]).toMatchObject({ active: true,
      dependencies: [{ name: 'fixtureDependency', instance: { uid: 0, epoch: expect.any(Number) } }] })
  })

  test('never accepts a disabled entry or a foreign service with the requested name', async () => {
    const f = await fixture(); await f.dependency(); await f.addCandidate()
    await f.ctx.loader.update('candidate', { disabled: true })
    await f.ctx.plugin({ apply(c: Context) { c.provide('candidateService', {}) } })
    expect((await f.query()).entries[0]).toMatchObject({ active: false, instance: null, services: [{ name: 'candidateService', instance: null }] })
  })

  test('an active candidate cannot claim a service provided by an unrelated Fiber', async () => {
    const f = await fixture(true, ['foreignService']); await f.dependency(); await f.addCandidate()
    await f.ctx.plugin({ apply(c: Context) { c.provide('foreignService', {}) } })
    expect((await f.query()).entries[0]).toMatchObject({ active: false, instance: { uid: expect.any(Number) },
      services: [{ name: 'foreignService', instance: null }] })
  })

  test('late-binds Loader, drains its socket on replacement and assigns a fresh observer identity', async () => {
    const f = await fixture(false)
    await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const firstLoader = await f.addLoader()
    await eventually(async () => { expect((await lstat(f.config.socketPath)).mode & 0o777).toBe(0o600) })
    const before = await f.query()
    await firstLoader.dispose()
    await eventually(async () => { await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' }) })
    await f.addLoader()
    await eventually(async () => { expect((await lstat(f.config.socketPath)).mode & 0o777).toBe(0o600) })
    expect((await f.query()).observerId).not.toBe(before.observerId)
  })

  test('rejects an incorrect key and closes slow clients on owner unload', async () => {
    const f = await fixture()
    const other = join(f.owner, 'other-key'); await writeFile(other, randomBytes(32), { mode: 0o600 })
    await expect(queryRuntimeObserver({ ...f.config, keyPath: other })).rejects.toThrow('runtime observer')
    const socket = createConnection(f.config.socketPath)
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    socket.write('{')
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    await f.control.dispose(); await closed
    await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does not unlink an unknown pre-existing socket path', async () => {
    const f = await fixture(false)
    await writeFile(f.config.socketPath, 'owner-marker', { mode: 0o600 })
    await f.addLoader()
    await pause()
    expect(await readFile(f.config.socketPath, 'utf8')).toBe('owner-marker')
    await f.control.dispose()
    expect(await readFile(f.config.socketPath, 'utf8')).toBe('owner-marker')
  })

  test('post-listen server errors release the endpoint and permit a fresh owner generation', async () => {
    const f = await fixture()
    const old = await f.query()
    const server = createdServers.at(-1)!
    server.emit('error', new Error('controlled supervisor error'))
    await eventually(async () => {
      expect(server.listening).toBe(false)
      await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await f.control.dispose()
    await f.ctx.plugin(PluginControlPlaneService, f.controlConfig)
    await eventually(async () => { expect((await lstat(f.config.socketPath)).mode & 0o777).toBe(0o600) })
    expect((await f.query()).observerId).not.toBe(old.observerId)
  })

  test('rejects candidate-owned authority and unsafe keys before binding', async () => {
    const f = await fixture(false)
    expect(() => validateRuntimeObserverConfig({ ...f.config, socketPath: join(f.config.profilePath, 'socket') })).toThrow()
    await chmod(f.config.keyPath, 0o644)
    expect(() => validateRuntimeObserverConfig(f.config)).toThrow()
    await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('owner cancellation settles without leaving a connection', async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort()
    await expect(queryRuntimeObserver({ ...f.config, signal: abort.signal })).rejects.toThrow()
    expect((await f.query()).entries[0]?.active).toBe(false)
  })

  test.each(['wrong-mac', 'replayed-challenge', 'malformed-shape'])('rejects %s from a replacement response server', async mode => {
    const f = await fixture(); const old = await f.query(); await f.control.dispose()
    const key = await readFile(f.config.keyPath)
    const server = createServer({ allowHalfOpen: true }, socket => {
      let request = ''
      socket.on('data', chunk => { request += chunk.toString() })
      socket.on('end', () => {
        const challenge = JSON.parse(request).challenge as string
        const observation = { ...old, ...(mode === 'replayed-challenge' ? {} : { challenge }),
          ...(mode === 'malformed-shape' ? { unrecognizedField: true } : {}) }
        const mac = mode === 'wrong-mac' ? '0'.repeat(64)
          : createHmac('sha256', key).update(`dsh-runtime-response/v1\n${JSON.stringify(observation)}`).digest('hex')
        socket.end(JSON.stringify({ observation, mac }) + '\n')
      })
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(f.config.socketPath, resolve) })
      await chmod(f.config.socketPath, 0o600)
      await expect(f.query()).rejects.toThrow('runtime observer response rejected')
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); key.fill(0) }
  })
})

test('configuration digest is canonical and rejects getters, cycles and oversized values', () => {
  expect(runtimeConfigDigest({ a: 1, b: 2 })).toBe(runtimeConfigDigest({ b: 2, a: 1 }))
  let invoked = false
  expect(() => runtimeConfigDigest({ get a() { invoked = true; return 1 } })).toThrow()
  const array = [1]; Object.defineProperty(array, '0', { get() { invoked = true; return 1 } })
  expect(() => runtimeConfigDigest(array)).toThrow()
  expect(invoked).toBe(false)
  const cyclic: unknown[] = []; cyclic.push(cyclic)
  expect(() => runtimeConfigDigest(cyclic)).toThrow()
  expect(() => runtimeConfigDigest('x'.repeat(70_000))).toThrow()
})
