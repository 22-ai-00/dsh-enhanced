import type { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, type Session } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * rc.8 exposes its generated known-event catalog as a ReadonlySet and defers a
 * downstream registration API. Persistence nevertheless consults the same
 * object for both new batches and cold reads, so a narrowly scoped runtime
 * registration is the only compatible way to make this required plugin event
 * durable until DSH ships that public surface.
 */
const APPROVAL_REVIEWER_EVENT_TYPE = 'assistant-policy/approval-reviewer'
const READER_PROBE_EVENT_PREFIX = 'assistant-policy/__reader-probe/'
const SHIMMED_SESSION_FORMAT_VERSION = 0
const SESSION_REGISTRATIONS_GLOBAL_KEY = '__dshEnhancedApprovalReviewerSessionRegistrationsV1__'

interface MutableEventTypeRegistry extends ReadonlySet<string> {
  add(value: string): this
  delete(value: string): boolean
}

interface SessionRegistryModule {
  readonly KNOWN_SESSION_EVENT_TYPES?: unknown
  readonly SESSION_FORMAT_VERSION?: unknown
}

interface SessionRegistryCandidate {
  readonly label: string
  readonly module: SessionRegistryModule
}

interface ValidatedSessionRegistry {
  readonly label: string
  readonly registry: MutableEventTypeRegistry
}

interface EventSupportOracle {
  assertEventsSupported(meta: unknown, events: readonly unknown[]): void
}

interface PersistenceService {
  readonly coordinator?: unknown
  readonly ctx?: unknown
}

interface SessionsService {
  list(): readonly Session[]
}

export interface ApprovalReviewerSessionEventRegistration {
  /** Whether this registration proved the reader currently live in its Context. */
  isReady(): boolean
  /** Join late provision/HMR and reject unless the resulting live reader is proven. */
  assertReady(): Promise<void>
}

interface SessionRegistrationGlobal {
  [SESSION_REGISTRATIONS_GLOBAL_KEY]?: WeakMap<Session, ApprovalReviewerSessionEventRegistration>
}

function sessionRegistrations(): WeakMap<Session, ApprovalReviewerSessionEventRegistration> {
  const shared = globalThis as unknown as SessionRegistrationGlobal
  const current = shared[SESSION_REGISTRATIONS_GLOBAL_KEY]
  if (current !== undefined) return current
  const created = new WeakMap<Session, ApprovalReviewerSessionEventRegistration>()
  Object.defineProperty(shared, SESSION_REGISTRATIONS_GLOBAL_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  })
  return created
}

/** Fail synchronously before a managed Session appends this required custom event. */
export function assertApprovalReviewerSessionEventReady(session: Session): void {
  const registration = sessionRegistrations().get(session)
  if (registration === undefined || registration.isReady()) return
  throw new Error(
    'assistant-policy: session persistence reader is not proven for the required reviewer event',
  )
}

/** Async seam for Delivery and other durable writers that can wait for late provision/HMR. */
export async function waitForApprovalReviewerSessionEventReady(session: Session): Promise<void> {
  const registration = sessionRegistrations().get(session)
  if (registration === undefined) {
    throw new Error(
      'assistant-policy: session is not registered with a persistence reader readiness barrier',
    )
  }
  await registration.assertReady()
}

function record(value: unknown): Record<PropertyKey, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<PropertyKey, unknown>
    : undefined
}

function nested(value: unknown, ...keys: PropertyKey[]): unknown {
  let current = value
  for (const key of keys) {
    const currentRecord = record(current)
    if (currentRecord === undefined) return undefined
    current = currentRecord[key]
  }
  return current
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function loadSessionCandidate(
  label: string,
  ownerRequire: NodeJS.Require,
): SessionRegistryCandidate {
  let sessionEntrypoint: string
  try {
    sessionEntrypoint = ownerRequire.resolve('@deepseek-ai/dsh-session')
  } catch (error) {
    throw new Error(
      `cannot resolve @deepseek-ai/dsh-session for ${label}`,
      { cause: error },
    )
  }

  let sessionModule: unknown
  try {
    // Supported DSH runtimes (Node ^22.19 or >=24) synchronously require this
    // ESM package because it has no top-level await. Registration must finish
    // before another plugin can append or cold-read the required event.
    sessionModule = ownerRequire(sessionEntrypoint)
  } catch (error) {
    throw new Error(
      `cannot synchronously load @deepseek-ai/dsh-session at ${JSON.stringify(sessionEntrypoint)} `
      + `for ${label}`,
      { cause: error },
    )
  }
  if (record(sessionModule) === undefined) {
    throw new Error(
      `@deepseek-ai/dsh-session at ${JSON.stringify(sessionEntrypoint)} for ${label} `
      + 'has an incompatible module shape',
    )
  }
  return {
    label: `${label} (${sessionEntrypoint})`,
    module: sessionModule as SessionRegistryModule,
  }
}

function loaderReaderCandidate(persistence: PersistenceService): SessionRegistryCandidate {
  // cordis-plugin-loader binds the service context to the Entry that imported
  // its backend. Resolving from that same entry reproduces the dependency graph
  // used by PersistenceCoordinator, including a backend-private session copy.
  const entry = nested(persistence.ctx, 'fiber', 'entry')
  const backendName = nested(entry, 'options', 'name')
  const baseUrl = nested(entry, 'parent', 'tree', 'ctx', 'baseUrl')
  if (typeof backendName !== 'string' || backendName === '') {
    throw new Error('live sessionPersistence has no Cordis loader entry name')
  }
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new Error('live sessionPersistence loader entry has no profile baseUrl')
  }

  let profileRequire: NodeJS.Require
  try {
    profileRequire = createRequire(new URL('.assistant-policy-reader.cjs', baseUrl))
  } catch (error) {
    throw new Error(
      `live sessionPersistence loader baseUrl ${JSON.stringify(baseUrl)} is invalid`,
      { cause: error },
    )
  }

  let backendEntrypoint: string
  try {
    backendEntrypoint = profileRequire.resolve(backendName)
  } catch (error) {
    throw new Error(
      `cannot resolve live sessionPersistence backend ${JSON.stringify(backendName)} `
      + `from ${JSON.stringify(baseUrl)}`,
      { cause: error },
    )
  }
  const backendRequire = createRequire(backendEntrypoint)
  let coordinatorEntrypoint: string
  try {
    // The JSONL service owns a PersistenceCoordinator imported from this
    // package. Its closure, not the outer backend, captures the authoritative
    // KNOWN_SESSION_EVENT_TYPES object.
    coordinatorEntrypoint = backendRequire.resolve('@deepseek-ai/dsh-session-persistence')
  } catch (error) {
    throw new Error(
      `cannot resolve the PersistenceCoordinator consumed by live backend `
      + `${JSON.stringify(backendName)}`,
      { cause: error },
    )
  }
  return loadSessionCandidate(
    `PersistenceCoordinator consumed by live backend ${JSON.stringify(backendName)}`,
    createRequire(coordinatorEntrypoint),
  )
}

function launcherCandidate(): SessionRegistryCandidate {
  const argvEntrypoint = process.argv[1]
  if (argvEntrypoint === undefined || argvEntrypoint === '') {
    throw new Error('process.argv[1] is unavailable')
  }

  let launcherEntrypoint: string
  try {
    // npm/pnpm commonly expose their bin as a symlink outside the package.
    // Resolve it before asking Node for the launcher's dependency graph.
    launcherEntrypoint = realpathSync(argvEntrypoint)
  } catch (error) {
    throw new Error(
      `launcher entrypoint ${JSON.stringify(argvEntrypoint)} cannot be inspected`,
      { cause: error },
    )
  }
  return loadSessionCandidate(
    'launcher @deepseek-ai/dsh-session',
    createRequire(launcherEntrypoint),
  )
}

function validateRegistry(candidate: SessionRegistryCandidate): ValidatedSessionRegistry {
  const formatVersion = candidate.module.SESSION_FORMAT_VERSION
  if (formatVersion !== SHIMMED_SESSION_FORMAT_VERSION) {
    throw new Error(
      `${candidate.label} uses unsupported session format v${String(formatVersion)}`,
    )
  }
  const registry = candidate.module.KNOWN_SESSION_EVENT_TYPES
  if (!(registry instanceof Set)
    || typeof (registry as Partial<MutableEventTypeRegistry>).add !== 'function'
    || typeof (registry as Partial<MutableEventTypeRegistry>).delete !== 'function') {
    throw new Error(
      `${candidate.label} does not expose the mutable rc.8 session event catalog`,
    )
  }
  return { label: candidate.label, registry: registry as MutableEventTypeRegistry }
}

function supportOracle(persistence: PersistenceService): EventSupportOracle {
  const coordinator = record(persistence.coordinator)
  if (coordinator === undefined
    || typeof coordinator.assertEventsSupported !== 'function') {
    throw new Error(
      'assistant-policy: live sessionPersistence does not expose the rc.8 '
      + 'PersistenceCoordinator event-support oracle; refusing unproven registration',
    )
  }
  return coordinator as unknown as EventSupportOracle
}

function probeMeta(): Record<string, unknown> {
  return {
    version: SHIMMED_SESSION_FORMAT_VERSION,
    id: `assistant-policy-reader-probe-${randomUUID()}`,
    createdAt: 0,
    cwd: '/',
    delegationDepth: 0,
  }
}

function probeEvent(type: string): Record<string, unknown> {
  return { type, seq: 0, time: 0, data: {} }
}

function assertRejectedUnknown(
  oracle: EventSupportOracle,
  meta: unknown,
  type: string,
  stage: string,
): void {
  let rejection: unknown
  try {
    oracle.assertEventsSupported(meta, [probeEvent(type)])
  } catch (error) {
    rejection = error
  }
  if (rejection === undefined) {
    throw new Error(
      `assistant-policy: PersistenceCoordinator accepted unregistered ${stage} event `
      + `${JSON.stringify(type)}; its reader registry identity cannot be proven`,
    )
  }
  if (!errorMessage(rejection).includes(type)) {
    throw new Error(
      `assistant-policy: PersistenceCoordinator rejected the ${stage} probe for an unrelated `
      + `reason (${errorMessage(rejection)}); its reader registry identity cannot be proven`,
      { cause: rejection },
    )
  }
}

function proveReaderRegistry(
  oracle: EventSupportOracle,
  candidates: readonly ValidatedSessionRegistry[],
  diagnostics: readonly string[],
): ValidatedSessionRegistry {
  const registries = new Map<MutableEventTypeRegistry, ValidatedSessionRegistry>()
  for (const candidate of candidates) {
    if (!registries.has(candidate.registry)) registries.set(candidate.registry, candidate)
  }

  let probeType: string
  do {
    probeType = `${READER_PROBE_EVENT_PREFIX}${randomUUID()}`
  } while ([...registries.keys()].some(registry => registry.has(probeType)))
  const meta = probeMeta()
  assertRejectedUnknown(oracle, meta, probeType, 'baseline')

  const proven: ValidatedSessionRegistry[] = []
  for (const candidate of registries.values()) {
    candidate.registry.add(probeType)
    try {
      oracle.assertEventsSupported(meta, [probeEvent(probeType)])
      proven.push(candidate)
    } catch (error) {
      if (!errorMessage(error).includes(probeType)) {
        throw new Error(
          `assistant-policy: PersistenceCoordinator probe through ${candidate.label} failed `
          + `for an unrelated reason (${errorMessage(error)}); refusing unproven registration`,
          { cause: error },
        )
      }
    } finally {
      candidate.registry.delete(probeType)
    }
    if (candidate.registry.has(probeType)) {
      throw new Error(
        `assistant-policy: ${candidate.label} retained the temporary reader probe `
        + `${JSON.stringify(probeType)}; refusing registration`,
      )
    }
  }

  const [reader] = proven
  if (proven.length !== 1 || reader === undefined) {
    const detail = diagnostics.length === 0 ? 'none' : diagnostics.join('; ')
    throw new Error(
      `assistant-policy: cannot prove exactly one live PersistenceCoordinator reader registry `
      + `(proved ${proven.length}; candidate diagnostics: ${detail}); refusing registration `
      + `of required event ${JSON.stringify(APPROVAL_REVIEWER_EVENT_TYPE)}`,
    )
  }
  return reader
}

function writerRegistry(): ValidatedSessionRegistry {
  return validateRegistry({
    label: 'plugin-local @deepseek-ai/dsh-session',
    module: { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION },
  })
}

function installRequiredEvent(
  registries: readonly ValidatedSessionRegistry[],
  oracle?: EventSupportOracle,
): void {
  const unique = new Map<MutableEventTypeRegistry, ValidatedSessionRegistry>()
  for (const candidate of registries) unique.set(candidate.registry, candidate)
  const added: MutableEventTypeRegistry[] = []
  try {
    for (const candidate of unique.values()) {
      if (!candidate.registry.has(APPROVAL_REVIEWER_EVENT_TYPE)) {
        candidate.registry.add(APPROVAL_REVIEWER_EVENT_TYPE)
        added.push(candidate.registry)
      }
      if (!candidate.registry.has(APPROVAL_REVIEWER_EVENT_TYPE)) {
        throw new Error(
          `assistant-policy: ${candidate.label} did not retain required session event `
          + `${JSON.stringify(APPROVAL_REVIEWER_EVENT_TYPE)}`,
        )
      }
    }
    oracle?.assertEventsSupported(probeMeta(), [probeEvent(APPROVAL_REVIEWER_EVENT_TYPE)])
  } catch (error) {
    for (const registry of added) registry.delete(APPROVAL_REVIEWER_EVENT_TYPE)
    throw new Error(
      `assistant-policy: required session event registration failed for `
      + `${JSON.stringify(APPROVAL_REVIEWER_EVENT_TYPE)}`,
      { cause: error },
    )
  }
}

function installApprovalReviewerEventType(persistence: PersistenceService): void {
  const oracle = supportOracle(persistence)
  const writer = writerRegistry()
  const candidates: SessionRegistryCandidate[] = []
  const diagnostics: string[] = []
  for (const resolveCandidate of [
    () => loaderReaderCandidate(persistence),
    launcherCandidate,
  ]) {
    try {
      candidates.push(resolveCandidate())
    } catch (error) {
      diagnostics.push(errorMessage(error))
    }
  }

  const registries: ValidatedSessionRegistry[] = [writer]
  for (const candidate of candidates) {
    try {
      registries.push(validateRegistry(candidate))
    } catch (error) {
      diagnostics.push(errorMessage(error))
    }
  }
  const reader = proveReaderRegistry(oracle, registries, diagnostics)
  installRequiredEvent([writer, reader], oracle)
}

/**
 * Register the required reviewer event for the process lifetime.
 *
 * rc.8 persistence can drain after downstream plugin effects dispose, and
 * hot-reloaded module copies cannot safely coordinate ownership of this global
 * catalog. Removing the type would therefore make a valid durable tail (or an
 * already stored session) unreadable. The catalog is metadata only, so the
 * safe compatibility behavior is a monotonic add until process exit.
 */
export function registerApprovalReviewerSessionEvent(
  ctx: Context,
): ApprovalReviewerSessionEventRegistration {
  let active = true
  let provenOracle: EventSupportOracle | undefined
  const installLiveReader = (persistence: PersistenceService): void => {
    // Invalidate the prior proof before touching a replacement. A hot reload
    // may reuse the same coordinator object while swapping the reader hidden
    // behind it; if the new proof fails, object identity alone must not leave
    // the old proof looking current.
    provenOracle = undefined
    installApprovalReviewerEventType(persistence)
    provenOracle = supportOracle(persistence)
  }

  const persistence = ctx.get('sessionPersistence') as PersistenceService | undefined
  // Keep the writer catalog usable for programmatic/no-persistence contexts.
  // A live reader is always proved separately below before it can become the
  // active durable backend.
  if (persistence === undefined) installRequiredEvent([writerRegistry()])
  else installLiveReader(persistence)

  const injection = ctx.inject(['sessionPersistence'], persistenceCtx => {
    const live = persistenceCtx.get('sessionPersistence') as PersistenceService | undefined
    if (live === undefined) {
      throw new Error('assistant-policy: injected sessionPersistence is unavailable')
    }
    installLiveReader(live)
    const activationOracle = provenOracle
    return () => {
      if (provenOracle === activationOracle) provenOracle = undefined
    }
  })

  const registration: ApprovalReviewerSessionEventRegistration = {
    isReady(): boolean {
      if (!active) return false
      const live = ctx.get('sessionPersistence') as PersistenceService | undefined
      if (live === undefined) return false
      try {
        return provenOracle === supportOracle(live)
      } catch {
        return false
      }
    },
    async assertReady(): Promise<void> {
      if ((ctx.get('sessionPersistence') as PersistenceService | undefined) === undefined) {
        throw new Error(
          'assistant-policy: sessionPersistence is unavailable; refusing to append a required reviewer event',
        )
      }
      // Late provision and HMR activation are asynchronous in Cordis. Joining
      // the exact injected Fiber prevents an append from overtaking its reader
      // proof, while a failed proof is rethrown to the fail-closed caller.
      await injection.await()
      if (!registration.isReady()) {
        throw new Error(
          'assistant-policy: live sessionPersistence reader is not proven for the required reviewer event',
        )
      }
    },
  }

  const registrations = sessionRegistrations()
  const bindSession = (session: Session): void => {
    registrations.set(session, registration)
  }
  const sessions = ctx.get('sessions') as SessionsService | undefined
  for (const session of sessions?.list() ?? []) bindSession(session)
  ctx.on('session/created', bindSession)
  ctx.effect(() => () => {
    active = false
  }, 'assistant-policy.session-event-readiness')
  return registration
}
