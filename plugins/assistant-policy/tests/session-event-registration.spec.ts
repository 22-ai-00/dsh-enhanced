import { Context } from '@deepseek-ai/cordis'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
  type SessionPreparation,
} from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { apply } from '../src/index.ts'
import { foldApprovalReviewer, setApprovalReviewer } from '../src/approval-reviewer.ts'
import {
  registerApprovalReviewerSessionEvent,
  waitForApprovalReviewerSessionEventReady,
} from '../src/session-event-registration.ts'

const REVIEWER_EVENT_TYPE = 'assistant-policy/approval-reviewer'
const require = createRequire(import.meta.url)
const contexts = new Set<Context>()
const roots = new Set<string>()

interface StoredSession {
  events: SessionEvent[]
  meta: SessionHeader
  revision: string
}

interface PersistenceBackend {
  readonly name: string
  appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>
  commitRepair(meta: SessionHeader, tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void>
  list(): Promise<SessionHeader[]>
  loadStored(id: ReturnType<typeof SessionId>): Promise<StoredSession | undefined>
  readStoredRevision(id: ReturnType<typeof SessionId>): Promise<string | undefined>
}

interface PersistenceCoordinator extends ReaderCoordinator {
  inspect(id: ReturnType<typeof SessionId>): Promise<{ events: readonly SessionEvent[]; meta: SessionHeader }>
  prepare(id: ReturnType<typeof SessionId>): Promise<SessionPreparation>
}

interface SessionRegistryModule {
  readonly KNOWN_SESSION_EVENT_TYPES: Set<string>
  readonly SESSION_FORMAT_VERSION: number
}

interface ReaderCoordinator {
  assertEventsSupported(
    meta: SessionHeader,
    events: readonly SessionEvent[],
  ): void
}

function readerCoordinator(module: SessionRegistryModule): ReaderCoordinator {
  return {
    assertEventsSupported(meta, events) {
      for (const event of events) {
        if (module.KNOWN_SESSION_EVENT_TYPES.has(String(event.type)) || event.ignorable === true) continue
        throw new Error(
          `session "${meta.id}" contains event type "${String(event.type)}" `
          + 'unknown to this harness and not marked ignorable',
        )
      }
    },
  }
}

type PersistenceCoordinatorConstructor = new (
  ctx: Context,
  backend: PersistenceBackend,
  options: { preparedSessionCacheSize: number; writeBatchMaxDelayMs: number },
) => PersistenceCoordinator

async function coordinatorConstructor(): Promise<PersistenceCoordinatorConstructor> {
  // Use the exact persistence coordinator consumed by the installed rc.8 Agent loop.
  // It is a peer of the loop rather than a public dependency of this plugin.
  const loopPackage = require.resolve('@deepseek-ai/dsh-agent-loop/package.json')
  const entrypoint = require.resolve('@deepseek-ai/dsh-session-persistence', {
    paths: [dirname(loopPackage)],
  })
  const module = await import(pathToFileURL(entrypoint).href) as {
    PersistenceCoordinator: PersistenceCoordinatorConstructor
  }
  return module.PersistenceCoordinator
}

function backend(stored: Map<string, StoredSession>): PersistenceBackend {
  let revision = 0
  const snapshot = (value: StoredSession): StoredSession => structuredClone(value)
  return {
    name: 'assistant-policy-registration-test',
    async appendBatch(meta, events, isMaterialized) {
      const current = stored.get(String(meta.id))
      if (!isMaterialized || current === undefined) {
        revision += 1
        stored.set(String(meta.id), snapshot({
          meta,
          events: [...events],
          revision: `test:${revision}`,
        }))
        return
      }
      revision += 1
      current.events.push(...structuredClone(events))
      current.revision = `test:${revision}`
    },
    async commitRepair(meta, _tornMarker, closers) {
      const current = stored.get(String(meta.id))
      if (current === undefined) throw new Error(`missing stored session ${meta.id}`)
      revision += 1
      current.events.push(...structuredClone(closers))
      current.revision = `test:${revision}`
    },
    async list() {
      return [...stored.values()].map(value => structuredClone(value.meta))
    },
    async loadStored(id) {
      const value = stored.get(String(id))
      return value === undefined ? undefined : snapshot(value)
    },
    async readStoredRevision(id) {
      return stored.get(String(id))?.revision
    },
  }
}

async function context(withPolicy: boolean): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-session-event-'))
  roots.add(root)
  const ctx = new Context()
  contexts.add(ctx)
  new SessionStore(ctx)
  if (withPolicy) apply(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] })
  return { ctx, root }
}

async function distinctHostSessionModule(formatVersion = 0): Promise<{
  entrypoint: string
  module: SessionRegistryModule
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-host-session-'))
  roots.add(root)
  const hostRoot = join(root, 'host')
  const hostEntrypoint = join(hostRoot, 'lib', 'bin.js')
  const packageRoot = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-session')
  const binRoot = join(root, 'bin')
  const binLink = join(binRoot, 'dsh')
  await Promise.all([
    mkdir(dirname(hostEntrypoint), { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(binRoot, { recursive: true }),
  ])
  await Promise.all([
    writeFile(hostEntrypoint, 'export {}\n'),
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-session',
      type: 'module',
      exports: './index.js',
    })),
    writeFile(
      join(packageRoot, 'index.js'),
      `export const SESSION_FORMAT_VERSION = ${formatVersion}\n`
      + 'export const KNOWN_SESSION_EVENT_TYPES = new Set(["session/start"])\n',
    ),
  ])
  await symlink(hostEntrypoint, binLink)
  const hostRequire = createRequire(await realpath(binLink))
  return {
    entrypoint: binLink,
    module: hostRequire('@deepseek-ai/dsh-session') as SessionRegistryModule,
  }
}

async function unresolvableHostEntrypoint(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-unresolvable-host-'))
  roots.add(root)
  const entrypoint = join(root, 'bin.js')
  await writeFile(entrypoint, 'export {}\n')
  return entrypoint
}

async function distinctLoaderBackedReader(): Promise<{
  coordinator: ReaderCoordinator
  module: SessionRegistryModule
  service: unknown
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-reader-session-'))
  roots.add(root)
  const profileRoot = join(root, 'profile')
  const backendRoot = join(profileRoot, 'node_modules', '@fixture', 'session-reader')
  const persistenceRoot = join(
    backendRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-session-persistence',
  )
  const sessionRoot = join(persistenceRoot, 'node_modules', '@deepseek-ai', 'dsh-session')
  const backendEntrypoint = join(backendRoot, 'index.js')
  const persistenceEntrypoint = join(persistenceRoot, 'index.js')
  await mkdir(sessionRoot, { recursive: true })
  await Promise.all([
    writeFile(join(backendRoot, 'package.json'), JSON.stringify({
      name: '@fixture/session-reader',
      type: 'module',
      exports: './index.js',
    })),
    writeFile(backendEntrypoint, 'export const reader = true\n'),
    writeFile(join(persistenceRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-session-persistence',
      type: 'module',
      exports: './index.js',
    })),
    writeFile(persistenceEntrypoint, 'export const coordinator = true\n'),
    writeFile(join(sessionRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-session',
      type: 'module',
      exports: './index.js',
    })),
    writeFile(
      join(sessionRoot, 'index.js'),
      'export const SESSION_FORMAT_VERSION = 0\n'
      + `export const KNOWN_SESSION_EVENT_TYPES = new Set(${JSON.stringify(
        [...KNOWN_SESSION_EVENT_TYPES].filter(type => type !== REVIEWER_EVENT_TYPE),
      )})\n`,
    ),
  ])
  const readerRequire = createRequire(persistenceEntrypoint)
  const module = readerRequire('@deepseek-ai/dsh-session') as SessionRegistryModule
  const coordinator = readerCoordinator(module)
  const baseUrl = pathToFileURL(profileRoot).href.endsWith('/')
    ? pathToFileURL(profileRoot).href
    : `${pathToFileURL(profileRoot).href}/`
  return {
    coordinator,
    module,
    service: {
      coordinator,
      ctx: {
        fiber: {
          entry: {
            options: { name: '@fixture/session-reader' },
            parent: { tree: { ctx: { baseUrl } } },
          },
        },
      },
    },
  }
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('assistant-policy session event registration', () => {
  test('registers the live persistence reader when launcher, reader, and plugin use three distinct registries', async () => {
    const launcher = await distinctHostSessionModule()
    const reader = await distinctLoaderBackedReader()
    expect(launcher.module.KNOWN_SESSION_EVENT_TYPES).not.toBe(reader.module.KNOWN_SESSION_EVENT_TYPES)
    expect(reader.module.KNOWN_SESSION_EVENT_TYPES).not.toBe(KNOWN_SESSION_EVENT_TYPES)
    expect(launcher.module.KNOWN_SESSION_EVENT_TYPES).not.toBe(KNOWN_SESSION_EVENT_TYPES)

    const originalArgv = [...process.argv]
    process.argv[1] = launcher.entrypoint
    const ctx = new Context()
    contexts.add(ctx)
    ctx.provide('sessionPersistence' as never, reader.service as never)
    try {
      registerApprovalReviewerSessionEvent(ctx)
      expect(() => reader.coordinator.assertEventsSupported({
        version: SESSION_FORMAT_VERSION,
        id: SessionId('three-registry-reader'),
        createdAt: 0,
        cwd: '/work/alpha',
        delegationDepth: 0,
      }, [{
        type: REVIEWER_EVENT_TYPE,
        seq: 0,
        time: 0,
        data: { reviewer: 'auto-review' },
      } as SessionEvent])).not.toThrow()
      expect(reader.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
      expect(KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
      expect(launcher.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(false)
      for (const registry of [
        launcher.module.KNOWN_SESSION_EVENT_TYPES,
        reader.module.KNOWN_SESSION_EVENT_TYPES,
        KNOWN_SESSION_EVENT_TYPES,
      ]) {
        expect([...registry].some(type => type.startsWith('assistant-policy/__reader-probe/'))).toBe(false)
      }
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv)
    }
  })

  test('registers a late-provided distinct reader before persisting and cold-resuming reviewer history', async () => {
    const stored = new Map<string, StoredSession>()
    const PersistenceCoordinator = await coordinatorConstructor()
    const first = await context(true)
    const reader = await distinctLoaderBackedReader()
    expect(reader.module.KNOWN_SESSION_EVENT_TYPES).not.toBe(KNOWN_SESSION_EVENT_TYPES)
    expect(reader.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(false)

    const selections = [
      { id: SessionId('assistant-policy-reviewer-late-auto'), reviewer: 'auto-review' as const },
      { id: SessionId('assistant-policy-reviewer-late-full'), reviewer: 'none' as const },
    ].map(selection => ({
      ...selection,
      session: first.ctx.sessions.create(selection.id, {
        meta: { cwd: '/work/late', agentPreset: 'primary', delegationDepth: 0 },
      }),
    }))
    for (const selection of selections) {
      expect(() => setApprovalReviewer(selection.session, selection.reviewer)).toThrow(/reader.*proven/i)
      await expect(waitForApprovalReviewerSessionEventReady(selection.session))
        .rejects.toThrow(/sessionPersistence is unavailable/i)
      expect(selection.session.events.some(event => event.type === REVIEWER_EVENT_TYPE)).toBe(false)
    }

    const firstCoordinator = new PersistenceCoordinator(first.ctx, backend(stored), {
      preparedSessionCacheSize: 1,
      writeBatchMaxDelayMs: 1,
    })
    firstCoordinator.assertEventsSupported = reader.coordinator.assertEventsSupported
    first.ctx.provide('sessionPersistence' as never, {
      ...(reader.service as Record<string, unknown>),
      coordinator: firstCoordinator,
    } as never)
    await Promise.all(selections.map(selection => (
      waitForApprovalReviewerSessionEventReady(selection.session)
    )))

    expect(reader.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
    for (const selection of selections) {
      setApprovalReviewer(selection.session, selection.reviewer)
      expect(await first.ctx.sessions.flush(selection.session)).toBe(true)
    }

    await first.ctx.fiber.restart()
    contexts.delete(first.ctx)
    const cold = await context(false)
    const coldCoordinator = new PersistenceCoordinator(cold.ctx, backend(stored), {
      preparedSessionCacheSize: 1,
      writeBatchMaxDelayMs: 1,
    })
    coldCoordinator.assertEventsSupported = reader.coordinator.assertEventsSupported
    for (const selection of selections) {
      const inspected = await coldCoordinator.inspect(selection.id)
      expect(foldApprovalReviewer(inspected.events)).toBe(selection.reviewer)
    }
    await cold.ctx.fiber.restart()
    contexts.delete(cold.ctx)
  })

  test('re-proves a rebuilt persistence service when HMR reuses its wrapper object', async () => {
    const firstReader = await distinctLoaderBackedReader()
    const rebuiltReader = await distinctLoaderBackedReader()
    expect(firstReader.module.KNOWN_SESSION_EVENT_TYPES)
      .not.toBe(rebuiltReader.module.KNOWN_SESSION_EVENT_TYPES)
    const service = { ...(firstReader.service as Record<string, unknown>) }
    const fixture = await context(true)
    const provider = fixture.ctx.plugin((providerCtx: Context) => {
      providerCtx.provide('sessionPersistence' as never, service as never)
    })
    await provider
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(firstReader.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
    expect(rebuiltReader.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(false)

    Object.assign(service, rebuiltReader.service)
    await provider.restart()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(rebuiltReader.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
    expect(() => rebuiltReader.coordinator.assertEventsSupported({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('hmr-rebuilt-reader'),
      createdAt: 0,
      cwd: '/work/hmr',
      delegationDepth: 0,
    }, [{
      type: REVIEWER_EVENT_TYPE,
      seq: 0,
      time: 0,
      data: { reviewer: 'user' },
    } as SessionEvent])).not.toThrow()
  })

  test('invalidates a reused coordinator proof when its replacement reader cannot be proven', async () => {
    const firstReader = await distinctLoaderBackedReader()
    const replacementReader = await distinctLoaderBackedReader()
    const hiddenModule: SessionRegistryModule = {
      KNOWN_SESSION_EVENT_TYPES: new Set(
        [...KNOWN_SESSION_EVENT_TYPES].filter(type => type !== REVIEWER_EVENT_TYPE),
      ),
      SESSION_FORMAT_VERSION,
    }
    const reusedCoordinator = readerCoordinator(firstReader.module)
    const service = {
      ...(firstReader.service as Record<string, unknown>),
      coordinator: reusedCoordinator,
    }
    const fixture = await context(false)
    const registration = registerApprovalReviewerSessionEvent(fixture.ctx)
    const session = fixture.ctx.sessions.create(SessionId('hmr-failed-reader-proof'), {
      meta: { cwd: '/work/hmr', agentPreset: 'primary', delegationDepth: 0 },
    })
    const provider = fixture.ctx.plugin((providerCtx: Context) => {
      providerCtx.provide('sessionPersistence' as never, service as never)
    })
    await provider
    await waitForApprovalReviewerSessionEventReady(session)
    expect(registration.isReady()).toBe(true)

    Object.assign(service, replacementReader.service, { coordinator: reusedCoordinator })
    Object.assign(reusedCoordinator, readerCoordinator(hiddenModule))
    await provider.restart()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(registration.isReady()).toBe(false)
    await expect(waitForApprovalReviewerSessionEventReady(session)).rejects.toThrow(/cannot prove/i)
    expect(() => setApprovalReviewer(session, 'auto-review')).toThrow(/reader.*proven/i)
    expect(session.events.some(event => event.type === REVIEWER_EVENT_TYPE)).toBe(false)
  })

  test('proves the launcher registry for a programmatic reader without loader metadata', async () => {
    const host = await distinctHostSessionModule()
    expect(host.module.KNOWN_SESSION_EVENT_TYPES).not.toBe(KNOWN_SESSION_EVENT_TYPES)
    expect(host.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(false)
    const originalArgv = [...process.argv]
    process.argv[1] = host.entrypoint
    const ctx = new Context()
    contexts.add(ctx)
    const coordinator = readerCoordinator(host.module)
    ctx.provide('sessionPersistence' as never, { coordinator } as never)
    try {
      registerApprovalReviewerSessionEvent(ctx)
      expect(KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
      expect(host.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
      expect(() => coordinator.assertEventsSupported({
        version: SESSION_FORMAT_VERSION,
        id: SessionId('programmatic-reader'),
        createdAt: 0,
        cwd: '/work/alpha',
        delegationDepth: 0,
      }, [{
        type: REVIEWER_EVENT_TYPE,
        seq: 0,
        time: 0,
        data: { reviewer: 'user' },
      } as SessionEvent])).not.toThrow()

      await ctx.fiber.restart()
      contexts.delete(ctx)
      expect(host.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv)
    }
  })

  test('fails closed when the active host registry uses an unsupported format', async () => {
    const host = await distinctHostSessionModule(SESSION_FORMAT_VERSION + 1)
    const originalArgv = [...process.argv]
    process.argv[1] = host.entrypoint
    const ctx = new Context()
    contexts.add(ctx)
    ctx.provide('sessionPersistence' as never, {
      coordinator: readerCoordinator(host.module),
    } as never)
    try {
      expect(() => registerApprovalReviewerSessionEvent(ctx)).toThrow(
        /cannot prove.*unsupported session format v1/i,
      )
      expect(host.module.KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(false)
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv)
    }
  })

  test('fails closed instead of claiming success when the host registry cannot be resolved', async () => {
    const hiddenReader: SessionRegistryModule = {
      KNOWN_SESSION_EVENT_TYPES: new Set(['session/start']),
      SESSION_FORMAT_VERSION,
    }
    const originalArgv = [...process.argv]
    process.argv[1] = await unresolvableHostEntrypoint()
    const ctx = new Context()
    contexts.add(ctx)
    ctx.provide('sessionPersistence' as never, {
      coordinator: readerCoordinator(hiddenReader),
    } as never)
    try {
      expect(() => registerApprovalReviewerSessionEvent(ctx)).toThrow(
        /cannot prove exactly one live PersistenceCoordinator reader registry.*proved 0/i,
      )
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv)
    }
  })

  test('mounts the exact required event type and restores its non-ignorable history after a cold restart', async () => {
    expect(SESSION_FORMAT_VERSION).toBe(0)
    // The shim is process-lifetime metadata. This worker starts clean, while a
    // prior mount in the same process would also be a valid starting state.

    const stored = new Map<string, StoredSession>()
    const PersistenceCoordinator = await coordinatorConstructor()
    // Match the real profile lifecycle: persistence is mounted by DSH base
    // before the downstream AssistantPolicy plugin.
    const first = await context(false)
    const firstCoordinator = new PersistenceCoordinator(first.ctx, backend(stored), {
      preparedSessionCacheSize: 1,
      writeBatchMaxDelayMs: 1,
    })
    first.ctx.provide('sessionPersistence' as never, { coordinator: firstCoordinator } as never)
    apply(first.ctx, { databasePath: join(first.root, 'policy.sqlite'), rules: [] })
    expect(KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)

    const id = SessionId('assistant-policy-reviewer-cold-resume')
    const original = first.ctx.sessions.create(id, {
      meta: { cwd: '/work/alpha', agentPreset: 'primary', delegationDepth: 0 },
    })
    original.append('approval/policy', { policy: 'ask' })
    setApprovalReviewer(original, 'auto-review')

    // Exercise the coordinator's disposal drain, not a test-only explicit flush.
    await first.ctx.fiber.restart()
    contexts.delete(first.ctx)
    const persistedReviewer = stored.get(String(id))?.events.find(event => event.type === REVIEWER_EVENT_TYPE)
    expect(persistedReviewer).toBeDefined()
    expect(persistedReviewer).not.toHaveProperty('ignorable')
    expect(KNOWN_SESSION_EVENT_TYPES.has(REVIEWER_EVENT_TYPE)).toBe(true)

    // Persistence is intentionally able to drain and cold-read after Policy's
    // context has disposed. Deleting this global type here was the rc.8/HMR
    // race that made otherwise valid sessions permanently unresumable.
    const cold = await context(false)
    const coldCoordinator = new PersistenceCoordinator(cold.ctx, backend(stored), {
      preparedSessionCacheSize: 1,
      writeBatchMaxDelayMs: 1,
    })
    const inspected = await coldCoordinator.inspect(id)
    expect(foldApprovalReviewer(inspected.events)).toBe('auto-review')
    await cold.ctx.fiber.restart()
    contexts.delete(cold.ctx)

    const resumed = await context(false)
    const resumedCoordinator = new PersistenceCoordinator(resumed.ctx, backend(stored), {
      preparedSessionCacheSize: 1,
      writeBatchMaxDelayMs: 1,
    })
    resumed.ctx.provide('sessionPersistence' as never, { coordinator: resumedCoordinator } as never)
    apply(resumed.ctx, { databasePath: join(resumed.root, 'policy.sqlite'), rules: [] })
    const preparation = await resumedCoordinator.prepare(id)
    try {
      expect(foldApprovalReviewer(preparation.session.events)).toBe('auto-review')
      expect(preparation.session.header).toMatchObject({ id, cwd: '/work/alpha' })
    } finally {
      preparation[Symbol.dispose]()
    }
  })
})
