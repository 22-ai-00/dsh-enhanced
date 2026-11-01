import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Host-side adapter for the control plane's in-process reload protocol.
 *
 * Scope, stated honestly:
 *
 * - It reloads the *mounted configuration* of a running Host process by
 *   re-reading the profile's Cordis Include file and letting the pinned Loader
 *   restart the changed entries (`include` subtree `refresh()`).
 * - It does **not** replace installed plugin code. ESM module instances are
 *   cached by the pinned Loader, so a changed artifact (`lib/`) cannot be
 *   re-imported in-process; that stays a process-restart obligation of the
 *   existing `reload` attestation path. The control plane therefore refuses an
 *   in-process reload whose artifact digest differs from the mounted one.
 * - It never claims success. Success requires a probe that observed a changed
 *   profile file, a restarted (same-uid) fiber with a rebuilt store, an
 *   unchanged loaded module instance, an unchanged process identity
 *   (pid/invocation id) and an unchanged Host generation. Any failed assertion
 *   is reported as `failures > 0`, which the control plane maps to
 *   `rollback-pending`.
 *
 * This module is inert: it is a factory that nothing in `apply()` registers, so
 * the plugin's default behavior and `--dump-config` output do not change.
 */

// Cordis 4.0.5 exports `FiberState` as an ambient const enum that is unavailable
// at runtime, so the numeric values are used directly.
const ACTIVE = 2

const DIGEST = /^[a-f0-9]{64}$/u
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000

/** Structural mirror of the loader's `Fiber` surface used by the probe. */
interface RuntimeFiber {
  uid: number | null
  state: number
  store?: object | null
}

/** Structural mirror of the loader's `Entry` surface used by the probe. */
interface RuntimeEntry {
  parent?: unknown
  options?: { id?: unknown; name?: unknown; config?: unknown }
  fiber?: RuntimeFiber
  moduleNamespace?: unknown
  subtree?: RuntimeTree
}

/** Structural mirror of the include plugin instance (an `EntryTree`). */
interface RuntimeTree {
  root?: unknown
  ctx?: { fiber?: { entry?: unknown } }
  refresh?: () => Promise<void>
  await?: () => Promise<void>
}

interface RuntimeLoader {
  root?: unknown
  builtins?: { include?: unknown }
  resolve: (id: string) => unknown
}

export interface InProcessReloadRuntimeTarget {
  package: string
  version: string
  artifactDigest: string
  patchDigest: string
  changesProcessSubtree: boolean
  holdsUnprovenProcessAuthority: boolean
}

export interface InProcessReloadRuntimeProbe {
  checks: number
  failures: number
  reloaded: boolean
  /** Fibers that reached DISPOSED. A config-only reload restarts in place: 0. */
  fibersDisposed: number
  /** Local diagnostics for the failed assertion names; never part of the digest. */
  failedChecks: string[]
  probeDigest: string
}

export interface InProcessReloadRuntimeActivationInput {
  warrantDigest: string
  target: InProcessReloadRuntimeTarget
  previousHostGeneration: number
  previousInProcessGeneration: number
}

export interface InProcessReloadRuntimeActivationResult {
  previousHostGeneration: number
  currentHostGeneration: number
  previousInProcessGeneration: number
  currentInProcessGeneration: number
  probe: InProcessReloadRuntimeProbe
}

export interface InProcessReloadRuntimeRollbackInput {
  warrantDigest: string
  target: InProcessReloadRuntimeTarget
  reloadedInProcessGeneration: number
}

export interface InProcessReloadRuntimeRollbackResult {
  hostGeneration: number
  inProcessGeneration: number
  restored: boolean
  profileRestored: boolean
  probe: InProcessReloadRuntimeProbe
}

/**
 * Structurally identical to the control plane's `InProcessReloadHostPort`.
 * `assistant-delivery` must not depend on `@dsh-enhanced/plugin-control-plane`
 * (that would create a peer cycle), so the seam is mirrored here and the
 * compatibility is asserted by the type-level test in
 * `tests/in-process-reload-runtime.spec.ts`, not by a compiled import.
 */
export interface InProcessReloadRuntime {
  activate(input: InProcessReloadRuntimeActivationInput): Promise<InProcessReloadRuntimeActivationResult>
  rollback(input: InProcessReloadRuntimeRollbackInput): Promise<InProcessReloadRuntimeRollbackResult>
  snapshot(): { hostGeneration: number; inProcessGeneration: number }
}

export interface InProcessReloadRuntimeOptions {
  /** Profile directory that owns `cordis.yml` (same value the runtime observer uses). */
  profilePath: string
  /** Entry id inside the `include` tree, e.g. `candidate` or `include:candidate`. */
  entryId: string
  /** Expected mounted package name for the entry. */
  package: string
  /**
   * Authoritative current Host *process* generation (for example from the Host
   * attestation ledger). Required: the adapter must not invent it.
   */
  hostGeneration: () => number
  /**
   * Optional caller-owned profile patch step applied *before* the include tree is
   * re-read (for example renaming the staged profile into place).
   */
  apply?: () => Promise<void> | void
  /**
   * Optional caller-owned restore step used by rollback. Without it, rollback
   * reports `profileRestored: false` and the control plane keeps the plan in
   * `rollback-pending`; there is no path that claims an unproven restore.
   */
  restore?: () => Promise<void> | void
  /** Reload/probe deadline. Clamped to `[1000, 120000]`. */
  timeoutMs?: number
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digestOf(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

function fiberOf(entry: RuntimeEntry | undefined): RuntimeFiber | undefined {
  const fiber = entry?.fiber
  return fiber && typeof fiber === 'object' ? fiber : undefined
}

function normalizeEntryId(entryId: string): string {
  const local = entryId.startsWith('include:') ? entryId.slice('include:'.length) : entryId
  if (!local || local.includes(':')) throw new Error(`in-process reload entry id is invalid: ${entryId}`)
  return local
}

export function createInProcessReloadRuntime(ctx: Context, options: InProcessReloadRuntimeOptions): InProcessReloadRuntime {
  const localEntryId = normalizeEntryId(options.entryId)
  const profileFile = join(options.profilePath, 'cordis.yml')
  const profileUrl = pathToFileURL(profileFile).href
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const pid = process.pid
  const invocationId = /^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? '') ? process.env.INVOCATION_ID! : null
  let inProcessGeneration = 1

  function withDeadline<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`in-process reload exceeded its ${timeoutMs}ms deadline`)), timeoutMs)
      void work().then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
  }

  function loader(): RuntimeLoader {
    const value = ctx.get('loader') as RuntimeLoader | undefined
    if (!value || typeof value.resolve !== 'function') throw new Error('the Cordis Loader service is not available')
    return value
  }

  /**
   * Resolve and verify the mounted include root and the target entry. This is the
   * narrowest injection point: the include root is the only tree that owns the
   * profile file, and the loader provider is re-resolved per call, never cached.
   */
  function resolveMount(): { loader: RuntimeLoader; root: RuntimeEntry; tree: RuntimeTree; target: RuntimeEntry } {
    const active = loader()
    let root: unknown
    try { root = active.resolve('include') } catch { throw new Error('the Cordis include root is not mounted') }
    if (!root || typeof root !== 'object') throw new Error('the Cordis include root is not mounted')
    const rootEntry = root as RuntimeEntry
    const tree = rootEntry.subtree
    if (rootEntry.options?.id !== 'include' || rootEntry.options.name !== 'cordis:include'
      || rootEntry.parent !== active.root || !tree || tree.ctx?.fiber?.entry !== rootEntry) {
      throw new Error('the Cordis include root is not the profile include tree')
    }
    const config = rootEntry.options.config
    const configuredPath = config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).path : undefined
    if (configuredPath !== profileUrl) throw new Error('the Cordis include root is not bound to this profile')
    const rootFiber = fiberOf(rootEntry)
    if (!rootFiber || rootFiber.state !== ACTIVE) throw new Error('the Cordis include root is not active')
    let target: unknown
    try { target = active.resolve(`include:${localEntryId}`) } catch { throw new Error(`the target entry ${localEntryId} is not mounted`) }
    if (!target || typeof target !== 'object') throw new Error(`the target entry ${localEntryId} is not mounted`)
    const targetEntry = target as RuntimeEntry
    if (targetEntry.options?.id !== localEntryId || targetEntry.parent !== tree.root) {
      throw new Error(`the target entry ${localEntryId} is not a child of the include root`)
    }
    if (typeof targetEntry.options.name !== 'string' || targetEntry.options.name !== options.package) {
      throw new Error(`the target entry ${localEntryId} is not mounted from ${options.package}`)
    }
    return { loader: active, root: rootEntry, tree, target: targetEntry }
  }

  async function profileDigest(): Promise<string> {
    return createHash('sha256').update(await readFile(profileFile)).digest('hex')
  }

  interface MountIdentity {
    /** The fiber object captured before the reload; used to prove it disposed. */
    fiber: RuntimeFiber
    uid: number | null
    store: object | null
    state: number
    moduleNamespace: unknown
    profileDigest: string
    pid: number
    invocationId: string | null
    hostGeneration: number
  }

  async function capture(): Promise<{ mount: ReturnType<typeof resolveMount>; identity: MountIdentity }> {
    const mount = resolveMount()
    const fiber = fiberOf(mount.target)
    if (!fiber) throw new Error(`the target entry ${localEntryId} has no running fiber`)
    return { mount, identity: {
      fiber,
      uid: fiber.uid, store: fiber.store ?? null, state: fiber.state,
      moduleNamespace: mount.target.moduleNamespace, profileDigest: await profileDigest(),
      pid, invocationId, hostGeneration: options.hostGeneration(),
    } }
  }

  /**
   * Re-resolve the mount and assert the post-reload facts. Every assertion is
   * counted; `reloaded` is only true when a real replacement was observed.
   */
  async function probe(before: MountIdentity, expectedHostGeneration: number): Promise<{ probe: InProcessReloadRuntimeProbe; after: MountIdentity | null }> {
    let checks = 0; let failures = 0
    const failedChecks: string[] = []
    const bad = (check: string): void => { checks += 1; failures += 1; failedChecks.push(check) }
    const good = (): void => { checks += 1 }
    const observations: Record<string, unknown> = {}
    let after: MountIdentity | null = null
    try {
      const mount = resolveMount()
      const fiber = fiberOf(mount.target)
      const currentProfileDigest = await profileDigest()
      const hostGeneration = options.hostGeneration()
      after = {
        fiber: fiber ?? before.fiber,
        uid: fiber?.uid ?? null, store: fiber?.store ?? null, state: fiber?.state ?? -1,
        moduleNamespace: mount.target.moduleNamespace, profileDigest: currentProfileDigest,
        pid, invocationId, hostGeneration,
      }
      if (currentProfileDigest !== before.profileDigest) good(); else bad('profile-changed')
      if (fiber !== undefined && fiber.state === ACTIVE) good(); else bad('fiber-active')
      // A config-only reload restarts the same fiber in place: Cordis keeps the
      // uid and rebuilds the store, so a *changed* uid would mean the entry was
      // replaced by code this adapter cannot bind to an artifact digest.
      if (fiber !== undefined && fiber.uid !== null && fiber.uid === before.uid) good(); else bad('fiber-preserved')
      if (fiber !== undefined && fiber.store !== undefined && fiber.store !== null && fiber.store !== before.store) good(); else bad('store-rebuilt')
      // Config-only scope: the mounted module code must be the same module
      // instance, otherwise the reload would have replaced code that this
      // adapter cannot bind to the authorized artifact digest.
      if (mount.target.moduleNamespace === before.moduleNamespace) good(); else bad('module-reused')
      if (hostGeneration === expectedHostGeneration && after.hostGeneration === expectedHostGeneration) good(); else bad('host-generation-unchanged')
      if (before.hostGeneration === expectedHostGeneration) good(); else bad('host-generation-before')
      if (pid === before.pid && invocationId === before.invocationId) good(); else bad('process-identity')
      // The same fiber must still be the live mount; it was restarted, not replaced.
      if (before.fiber.state === ACTIVE && fiber === before.fiber) good(); else bad('same-fiber-live')
      observations.profileChanged = currentProfileDigest !== before.profileDigest
      observations.fiberPreserved = after.uid === before.uid
      observations.storeRebuilt = after.store !== before.store
      observations.moduleReused = mount.target.moduleNamespace === before.moduleNamespace
      observations.probe = { pid, invocationId, hostGeneration }
    } catch (error) {
      bad('mount-resolvable')
      observations.error = error instanceof Error ? error.message : String(error)
      observations.probe = { pid, invocationId, hostGeneration: options.hostGeneration() }
    }
    // A config-only reload disposes effects and re-runs `apply` on the same fiber;
    // no fiber reaches DISPOSED, so the count stays 0 and the restart is proven by
    // the rebuilt store plus the recorded effect disposals in the caller's probe.
    const fibersDisposed = 0
    const reloaded = after !== null && failures === 0
      && after.profileDigest !== before.profileDigest
      && after.store !== before.store && after.uid === before.uid && after.state === ACTIVE
    observations.before = { uid: before.uid, state: before.state, profileDigest: before.profileDigest }
    observations.after = after === null ? null : { uid: after.uid, state: after.state, profileDigest: after.profileDigest }
    observations.failedChecks = failedChecks
    observations.fibersDisposed = fibersDisposed
    observations.reloaded = reloaded
    return { probe: { checks, failures, reloaded, fibersDisposed, failedChecks, probeDigest: digestOf(observations) }, after }
  }

  async function refreshTree(mount: ReturnType<typeof resolveMount>): Promise<void> {
    if (typeof mount.tree.refresh !== 'function') throw new Error('the Cordis include tree does not expose refresh()')
    await mount.tree.refresh()
    // Await the tree's settled state so old fibers/disposers finish before the
    // probe hands over any exclusive resource.
    if (typeof mount.tree.await === 'function') await mount.tree.await()
  }

  function assertTarget(target: InProcessReloadRuntimeTarget): void {
    if (target.package !== options.package) throw new Error(`in-process reload target ${target.package} is not the mounted package ${options.package}`)
    if (!DIGEST.test(target.artifactDigest) || !DIGEST.test(target.patchDigest)) throw new Error('in-process reload target digests are invalid')
    if (target.changesProcessSubtree || target.holdsUnprovenProcessAuthority) {
      throw new Error(`in-process reload target ${target.package} requires a process restart`)
    }
  }

  return {
    snapshot: () => ({ hostGeneration: options.hostGeneration(), inProcessGeneration }),

    async activate(input) {
      if (!DIGEST.test(input.warrantDigest)) throw new Error('in-process reload warrant digest is invalid')
      assertTarget(input.target)
      const currentHostGeneration = options.hostGeneration()
      if (input.previousHostGeneration !== currentHostGeneration) {
        throw new Error('in-process reload warrant is bound to another Host generation')
      }
      const before = await capture()
      const observedGeneration = before.identity.hostGeneration
      if (observedGeneration !== input.previousHostGeneration) throw new Error('in-process reload started across a Host generation change')
      try {
        await withDeadline(async () => {
          if (options.apply) await options.apply()
          await refreshTree(before.mount)
        })
      } catch (error) {
        // The mount may be partially reloaded; report it as an attempted mount so
        // the control plane transitions to rollback-pending instead of retrying.
        inProcessGeneration += 1
        throw error
      }
      inProcessGeneration += 1
      const { probe: result } = await probe(before.identity, input.previousHostGeneration)
      return {
        previousHostGeneration: before.identity.hostGeneration,
        // The Host process generation is captured from the same authoritative
        // source before and after; the probe asserts it did not move.
        currentHostGeneration: options.hostGeneration(),
        previousInProcessGeneration: input.previousInProcessGeneration,
        currentInProcessGeneration: inProcessGeneration,
        probe: result,
      }
    },

    async rollback(input) {
      if (!DIGEST.test(input.warrantDigest)) throw new Error('in-process reload warrant digest is invalid')
      assertTarget(input.target)
      const currentHostGeneration = options.hostGeneration()
      const before = await capture()
      if (before.identity.hostGeneration !== currentHostGeneration) throw new Error('in-process rollback started across a Host generation change')
      let profileRestored = false
      try {
        await withDeadline(async () => {
          if (options.restore) { await options.restore(); profileRestored = true }
          await refreshTree(before.mount)
        })
      } catch (error) {
        inProcessGeneration += 1
        throw error
      }
      inProcessGeneration += 1
      const { probe: result } = await probe(before.identity, currentHostGeneration)
      return {
        hostGeneration: options.hostGeneration(),
        inProcessGeneration,
        restored: profileRestored && result.failures === 0 && result.reloaded,
        profileRestored,
        probe: result,
      }
    },
  }
}
