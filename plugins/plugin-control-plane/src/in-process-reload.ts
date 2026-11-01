import { createHash } from 'node:crypto'
import { ControlPlaneStoreError } from './store.js'

/**
 * In-process reload protocol.
 *
 * An in-process reload replaces the mounted plugin tree of a *running* Host
 * process (Cordis Loader/Include refresh) instead of restarting the systemd
 * unit. Consequently the Host **process generation** must not change: the only
 * evidence that may be claimed is a monotonic `inProcessGeneration` plus a
 * probe of the freshly mounted fibers. A process restart belongs to the
 * existing `{ kind: 'reload' }` attestation path and must never be reported
 * through this module.
 *
 * This module is pure policy/orchestration over an injected Host port. It never
 * touches the filesystem, Cordis or systemd, and it never reports a reload
 * without a probe digest produced by the Host adapter.
 */

export type InProcessReloadRefusalReason =
  | 'not-awaiting-reload'
  | 'not-rollback-eligible'
  | 'stale-fence'
  | 'warrant-digest-mismatch'
  | 'warrant-expired'
  | 'artifact-digest-mismatch'
  | 'patch-digest-mismatch'
  | 'invalid-target'
  | 'never-hot-reload'
  | 'process-subtree-change'
  | 'unproven-process-authority'
  | 'loader-unavailable'
  | 'host-generation-changed'
  | 'in-process-generation-not-monotonic'
  | 'unproven-reload'
  | 'probe-failed'
  | 'probe-digest-invalid'

const REFUSAL_CODES: Readonly<Record<InProcessReloadRefusalReason, ConstructorParameters<typeof ControlPlaneStoreError>[0]>> = Object.freeze({
  'not-awaiting-reload': 'invalid-state',
  'not-rollback-eligible': 'invalid-state',
  'stale-fence': 'conflict',
  'warrant-digest-mismatch': 'conflict',
  'warrant-expired': 'expired',
  'artifact-digest-mismatch': 'conflict',
  'patch-digest-mismatch': 'conflict',
  'invalid-target': 'invalid-input',
  'never-hot-reload': 'conflict',
  'process-subtree-change': 'conflict',
  'unproven-process-authority': 'conflict',
  'loader-unavailable': 'invalid-state',
  'host-generation-changed': 'conflict',
  'in-process-generation-not-monotonic': 'conflict',
  'unproven-reload': 'invalid-input',
  'probe-failed': 'invalid-input',
  'probe-digest-invalid': 'invalid-input',
})

/** Typed refusal. Distinct `reason` values are stable machine-readable codes. */
export class InProcessReloadRefusal extends ControlPlaneStoreError {
  constructor(readonly reason: InProcessReloadRefusalReason, message: string) {
    super(REFUSAL_CODES[reason], message)
    this.name = 'InProcessReloadRefusal'
  }
}

const DIGEST = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/u

/** Plugins that must never be replaced inside a live Host process. */
export const IN_PROCESS_RELOAD_DENYLIST: readonly string[] = Object.freeze([
  '@dsh-enhanced/plugin-control-plane',
  '@dsh-enhanced/assistant-delivery',
  '@dsh-enhanced/assistant-isolation',
  '@dsh-enhanced/lark-channel',
])

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digestOf(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

function textOf(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new InProcessReloadRefusal('invalid-target', `${label} is invalid`)
  return value
}

function digestField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new InProcessReloadRefusal('invalid-target', `${label} must be a SHA-256 digest`)
  return value
}

function integerOf(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new InProcessReloadRefusal('invalid-target', `${label} must be an integer >= ${minimum}`)
  }
  return value
}

function sameTarget(left: InProcessReloadTarget, right: InProcessReloadTarget): boolean {
  return left.package === right.package && left.version === right.version
    && left.artifactDigest === right.artifactDigest && left.patchDigest === right.patchDigest
    && left.changesProcessSubtree === right.changesProcessSubtree
    && left.holdsUnprovenProcessAuthority === right.holdsUnprovenProcessAuthority
}

export interface InProcessReloadTarget {
  /** Published plugin package name being reloaded. */
  package: string
  version: string
  /** SHA-256 of the sealed artifact that must be mounted after the reload. */
  artifactDigest: string
  /** SHA-256 of the profile/bundle patch applied by the Host adapter. */
  patchDigest: string
  /** True when the patch changes the unit or the dependency subtree: those require a process restart. */
  changesProcessSubtree: boolean
  /** True when the candidate would hold process/cgroup authority that this Host has not proven. */
  holdsUnprovenProcessAuthority: boolean
}

/**
 * Minimal plan projection consumed by this protocol. It is structurally
 * satisfied by `PluginActivationPlan`; the reload decision only needs status,
 * fence and generation binding.
 */
export interface InProcessReloadSnapshot {
  planId: string
  planDigest: string
  /** Must be `'awaiting-reload'` for a reload to be prepared or applied. */
  status: string
  activation: { id: string; fence: number }
  /** Host process generation (must stay unchanged across the reload). */
  hostGeneration: number
  /** Monotonic per-process reload generation (starts at 1). */
  inProcessGeneration: number
  /** Identity of the tree that is currently mounted in this Host process. */
  running: { artifactDigest: string; patchDigest: string }
  target: InProcessReloadTarget
}

/** JSON-safe, signed-input shaped probe produced by the Host adapter. */
export interface InProcessReloadHostProbe {
  /** Number of probe assertions that ran; must be >= 1. */
  checks: number
  /** Number of failed assertions; must be 0 for any success claim. */
  failures: number
  /** True only when the probe actually observed replaced fibers. */
  reloaded: boolean
  /** Number of old fibers observed as disposed. */
  fibersDisposed: number
  /** SHA-256 over the complete probe observation. */
  probeDigest: string
}

export interface InProcessReloadHostActivationInput {
  warrantDigest: string
  target: InProcessReloadTarget
  previousHostGeneration: number
  previousInProcessGeneration: number
}

export interface InProcessReloadHostActivationResult {
  previousHostGeneration: number
  currentHostGeneration: number
  previousInProcessGeneration: number
  currentInProcessGeneration: number
  probe: InProcessReloadHostProbe
}

export interface InProcessReloadHostRollbackInput {
  warrantDigest: string
  target: InProcessReloadTarget
  /** Generation that the failed/undesired reload produced. */
  reloadedInProcessGeneration: number
}

export interface InProcessReloadHostRollbackResult {
  hostGeneration: number
  inProcessGeneration: number
  restored: boolean
  profileRestored: boolean
  probe: InProcessReloadHostProbe
}

/**
 * Host-side capability seam. `@dsh-enhanced/assistant-delivery`'s
 * `in-process-reload-runtime` exports a structurally compatible implementation;
 * the Host wires it in. When it is absent, no reload happens.
 */
export interface InProcessReloadHostPort {
  activate(input: InProcessReloadHostActivationInput): Promise<InProcessReloadHostActivationResult>
  rollback(input: InProcessReloadHostRollbackInput): Promise<InProcessReloadHostRollbackResult>
}

export interface InProcessReloadWarrant {
  schemaVersion: 1
  kind: 'dsh-in-process-reload-warrant'
  planId: string
  planDigest: string
  activationId: string
  fence: number
  target: InProcessReloadTarget
  previousHostGeneration: number
  previousInProcessGeneration: number
  requestedAt: number
  expiresAt: number
  digest: string
}

export type InProcessReloadWarrantBody = Omit<InProcessReloadWarrant, 'digest'>

export function inProcessReloadWarrantDigest(warrant: InProcessReloadWarrantBody): string { return digestOf(warrant) }

function assertTarget(target: InProcessReloadTarget): void {
  textOf(target.package, 'target package', PACKAGE)
  textOf(target.version, 'target version')
  digestField(target.artifactDigest, 'target artifactDigest')
  digestField(target.patchDigest, 'target patchDigest')
  if (typeof target.changesProcessSubtree !== 'boolean') throw new InProcessReloadRefusal('invalid-target', 'target changesProcessSubtree must be boolean')
  if (typeof target.holdsUnprovenProcessAuthority !== 'boolean') throw new InProcessReloadRefusal('invalid-target', 'target holdsUnprovenProcessAuthority must be boolean')
}

function assertReloadable(target: InProcessReloadTarget): void {
  if (IN_PROCESS_RELOAD_DENYLIST.includes(target.package)) {
    throw new InProcessReloadRefusal('never-hot-reload', `${target.package} must never be reloaded inside a live Host process`)
  }
  if (target.changesProcessSubtree) {
    throw new InProcessReloadRefusal('process-subtree-change', `${target.package} changes the unit/dependency subtree and requires a process restart`)
  }
  if (target.holdsUnprovenProcessAuthority) {
    throw new InProcessReloadRefusal('unproven-process-authority', `${target.package} would hold unproven process/cgroup authority`)
  }
}

/**
 * An in-process reload can only replace the running *configuration/patch* of an
 * already-mounted artifact. Replacing the installed artifact code would need a
 * module re-import that the pinned Loader does not perform (ESM import caching),
 * so it stays a process-restart obligation.
 */
function assertInProcessScope(snapshot: InProcessReloadSnapshot): void {
  if (snapshot.running.artifactDigest !== snapshot.target.artifactDigest) {
    throw new InProcessReloadRefusal('artifact-digest-mismatch', 'in-process reload cannot replace the installed artifact; the artifact change requires a process restart')
  }
  if (snapshot.running.patchDigest === snapshot.target.patchDigest) {
    throw new InProcessReloadRefusal('patch-digest-mismatch', 'in-process reload requires a changed profile patch')
  }
}

function assertSnapshot(snapshot: InProcessReloadSnapshot): void {
  textOf(snapshot.planId, 'snapshot planId')
  digestField(snapshot.planDigest, 'snapshot planDigest')
  textOf(snapshot.activation.id, 'snapshot activation id')
  integerOf(snapshot.activation.fence, 'snapshot fence')
  integerOf(snapshot.hostGeneration, 'snapshot hostGeneration')
  integerOf(snapshot.inProcessGeneration, 'snapshot inProcessGeneration')
  digestField(snapshot.running.artifactDigest, 'snapshot running artifactDigest')
  digestField(snapshot.running.patchDigest, 'snapshot running patchDigest')
  assertTarget(snapshot.target)
}

export interface PrepareInProcessReloadInput {
  snapshot: InProcessReloadSnapshot
  requestedAt: number
  ttlMs: number
}

/**
 * Prepare an in-process reload warrant. Only a plan parked at `awaiting-reload`
 * with a matching target may produce a warrant; every other state refuses.
 */
export function prepareInProcessReload(input: PrepareInProcessReloadInput): InProcessReloadWarrant {
  const { snapshot, requestedAt, ttlMs } = input
  assertSnapshot(snapshot)
  if (snapshot.status !== 'awaiting-reload') {
    throw new InProcessReloadRefusal('not-awaiting-reload', `in-process reload requires plan status awaiting-reload, got ${snapshot.status}`)
  }
  assertReloadable(snapshot.target)
  assertInProcessScope(snapshot)
  integerOf(requestedAt, 'requestedAt', 0)
  integerOf(ttlMs, 'ttlMs')
  const body: InProcessReloadWarrantBody = {
    schemaVersion: 1,
    kind: 'dsh-in-process-reload-warrant',
    planId: snapshot.planId,
    planDigest: snapshot.planDigest,
    activationId: snapshot.activation.id,
    fence: snapshot.activation.fence,
    target: { ...snapshot.target },
    previousHostGeneration: snapshot.hostGeneration,
    previousInProcessGeneration: snapshot.inProcessGeneration,
    requestedAt,
    expiresAt: requestedAt + ttlMs,
  }
  return Object.freeze({ ...body, digest: inProcessReloadWarrantDigest(body) })
}

function assertWarrantStillBound(warrant: InProcessReloadWarrant, snapshot: InProcessReloadSnapshot, now: number): void {
  if (typeof warrant.digest !== 'string' || !DIGEST.test(warrant.digest)) {
    throw new InProcessReloadRefusal('warrant-digest-mismatch', 'in-process reload warrant digest is invalid')
  }
  const { digest: _digest, ...body } = warrant
  if (inProcessReloadWarrantDigest(body) !== warrant.digest) {
    throw new InProcessReloadRefusal('warrant-digest-mismatch', 'in-process reload warrant digest does not match its body')
  }
  if (warrant.planId !== snapshot.planId || warrant.planDigest !== snapshot.planDigest) {
    throw new InProcessReloadRefusal('stale-fence', 'in-process reload warrant belongs to another plan revision')
  }
  if (warrant.activationId !== snapshot.activation.id || warrant.fence !== snapshot.activation.fence) {
    throw new InProcessReloadRefusal('stale-fence', 'in-process reload warrant is fenced out by a newer activation')
  }
  if (warrant.previousHostGeneration !== snapshot.hostGeneration
    || warrant.previousInProcessGeneration !== snapshot.inProcessGeneration) {
    throw new InProcessReloadRefusal('stale-fence', 'in-process reload warrant generation binding is stale')
  }
  if (!sameTarget(warrant.target, snapshot.target)) {
    throw new InProcessReloadRefusal('artifact-digest-mismatch', 'in-process reload warrant target no longer matches the plan')
  }
  if (!Number.isSafeInteger(now) || now > warrant.expiresAt) {
    throw new InProcessReloadRefusal('warrant-expired', 'in-process reload warrant is outside its validity interval')
  }
}

export type InProcessReloadOutcomeCode =
  | 'host-activation-failed'
  | 'host-generation-changed'
  | 'in-process-generation-not-monotonic'
  | 'host-rollback-failed'
  | 'restore-unproven'
  | 'probe-failed'
  | 'probe-digest-invalid'
  | 'unproven-reload'

export interface InProcessReloadApplied {
  status: 'reloaded'
  reloaded: true
  previousHostGeneration: number
  currentHostGeneration: number
  previousInProcessGeneration: number
  currentInProcessGeneration: number
  fibersDisposed: number
  probeDigest: string
  warrantDigest: string
}

export interface InProcessReloadRollbackPending {
  status: 'rollback-pending'
  code: InProcessReloadOutcomeCode
  detail: string
  warrantDigest: string
}

export type InProcessReloadApplyResult = InProcessReloadApplied | InProcessReloadRollbackPending

function probed(value: InProcessReloadHostProbe): boolean {
  return typeof value === 'object' && value !== null
    && Number.isSafeInteger(value.checks) && value.checks >= 1
    && Number.isSafeInteger(value.failures) && value.failures >= 0
    && typeof value.reloaded === 'boolean'
    && Number.isSafeInteger(value.fibersDisposed) && value.fibersDisposed >= 0
    && typeof value.probeDigest === 'string' && DIGEST.test(value.probeDigest)
}

function failure(detail: string, code: InProcessReloadOutcomeCode, warrantDigest: string): InProcessReloadRollbackPending {
  return { status: 'rollback-pending', code, detail, warrantDigest }
}

/**
 * Apply a prepared warrant through the Host port.
 *
 * Refusals (state/fence/digest/expiry) throw `InProcessReloadRefusal` and never
 * touch the Host. Operational failures — a Host exception, a moved process
 * generation, a non-monotonic in-process generation, or any probe assertion
 * failure — return `rollback-pending`; this function has no path that reports
 * a reload without a valid, failure-free probe digest.
 */
export async function applyInProcessReload(input: {
  warrant: InProcessReloadWarrant
  snapshot: InProcessReloadSnapshot
  port: InProcessReloadHostPort
  now: number
}): Promise<InProcessReloadApplyResult> {
  const { warrant, snapshot, port, now } = input
  assertSnapshot(snapshot)
  assertWarrantStillBound(warrant, snapshot, now)
  if (snapshot.status !== 'awaiting-reload') {
    throw new InProcessReloadRefusal('not-awaiting-reload', `in-process reload requires plan status awaiting-reload, got ${snapshot.status}`)
  }
  assertReloadable(snapshot.target)
  assertInProcessScope(snapshot)
  let result: InProcessReloadHostActivationResult
  try {
    result = await port.activate({
      warrantDigest: warrant.digest,
      target: { ...warrant.target },
      previousHostGeneration: warrant.previousHostGeneration,
      previousInProcessGeneration: warrant.previousInProcessGeneration,
    })
  } catch (error) {
    return failure(`Host activation failed: ${error instanceof Error ? error.message : String(error)}`, 'host-activation-failed', warrant.digest)
  }
  if (result.previousHostGeneration !== warrant.previousHostGeneration
    || result.currentHostGeneration !== warrant.previousHostGeneration) {
    return failure('Host process generation changed during an in-process reload', 'host-generation-changed', warrant.digest)
  }
  if (result.previousInProcessGeneration !== warrant.previousInProcessGeneration
    || result.currentInProcessGeneration !== warrant.previousInProcessGeneration + 1) {
    return failure('in-process generation is not monotonic', 'in-process-generation-not-monotonic', warrant.digest)
  }
  if (!probed(result.probe)) return failure('Host probe is missing or malformed', 'probe-failed', warrant.digest)
  if (result.probe.failures !== 0) return failure(`Host probe reported ${result.probe.failures} failure(s)`, 'probe-failed', warrant.digest)
  if (!result.probe.reloaded) return failure('Host probe did not observe replaced fibers', 'unproven-reload', warrant.digest)
  return {
    status: 'reloaded',
    reloaded: true,
    previousHostGeneration: warrant.previousHostGeneration,
    currentHostGeneration: result.currentHostGeneration,
    previousInProcessGeneration: warrant.previousInProcessGeneration,
    currentInProcessGeneration: result.currentInProcessGeneration,
    fibersDisposed: result.probe.fibersDisposed,
    probeDigest: result.probe.probeDigest,
    warrantDigest: warrant.digest,
  }
}

export interface InProcessReloadRolledBack {
  status: 'rolled-back'
  restored: true
  hostGeneration: number
  inProcessGeneration: number
  probeDigest: string
  warrantDigest: string
}

export type InProcessReloadRollbackResult = InProcessReloadRolledBack | InProcessReloadRollbackPending

/**
 * Roll back a failed (or deliberately reverted) in-process reload. A rollback
 * claim requires both an explicit profile restore and a failure-free probe; a
 * partial rollback stays `rollback-pending`.
 */
export async function rollbackInProcessReload(input: {
  warrant: InProcessReloadWarrant
  snapshot: InProcessReloadSnapshot
  port: InProcessReloadHostPort
  now: number
}): Promise<InProcessReloadRollbackResult> {
  const { warrant, snapshot, port, now } = input
  assertSnapshot(snapshot)
  assertWarrantStillBound(warrant, snapshot, now)
  if (snapshot.status !== 'rollback-pending' && snapshot.status !== 'reloaded') {
    throw new InProcessReloadRefusal('not-rollback-eligible', `in-process reload rollback requires rollback-pending or reloaded, got ${snapshot.status}`)
  }
  assertReloadable(snapshot.target)
  let result: InProcessReloadHostRollbackResult
  try {
    result = await port.rollback({
      warrantDigest: warrant.digest,
      target: { ...warrant.target },
      reloadedInProcessGeneration: snapshot.inProcessGeneration,
    })
  } catch (error) {
    return failure(`Host rollback failed: ${error instanceof Error ? error.message : String(error)}`, 'host-rollback-failed', warrant.digest)
  }
  if (result.hostGeneration !== warrant.previousHostGeneration) {
    return failure('Host process generation changed during rollback', 'host-generation-changed', warrant.digest)
  }
  if (!result.restored || !result.profileRestored) return failure('Host did not prove the profile restore', 'restore-unproven', warrant.digest)
  if (!probed(result.probe)) return failure('Host rollback probe is missing or malformed', 'probe-failed', warrant.digest)
  if (result.probe.failures !== 0 || !result.probe.reloaded) {
    return failure('Host rollback probe did not prove a serving tree', 'probe-failed', warrant.digest)
  }
  return {
    status: 'rolled-back',
    restored: true,
    hostGeneration: result.hostGeneration,
    inProcessGeneration: result.inProcessGeneration,
    probeDigest: result.probe.probeDigest,
    warrantDigest: warrant.digest,
  }
}
