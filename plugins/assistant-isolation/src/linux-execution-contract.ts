import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { LinuxCgroupDirectory, LinuxCgroupLimits, LinuxCgroupRoots, LinuxCgroupSnapshot } from './linux-cgroups.js'
import type { IsolationLimits } from './types.js'

export interface LinuxExecutionContract {
  schemaVersion: 1
  backend: 'linux-native'
  runtimeDigest: string
  profile: 'ordinary' | 'repository'
  limits: IsolationLimits
  keeperLimits: LinuxCgroupLimits
  cgroupRoots: LinuxCgroupRoots
}
export interface LinuxExecutionIntent {
  schemaVersion: 1
  jobId: string
  requestDigest: string
  nativeResourceId: string
  nativeNonce: string
  contractDigest: string
  bootId: string
  uid: number
  deadline: number
  namespacePath: string
  workerNonce: string
  keeperNonce: string
  roots: Record<string, LinuxCgroupDirectory>
}
export interface LinuxExecutionResources {
  schemaVersion: 1
  intentDigest: string
  worker: LinuxCgroupSnapshot
  keeper: LinuxCgroupSnapshot
}
/** Host validates the private receipt and kernel evidence before presenting this binding. */
export interface LinuxReceiptBinding {
  requestDigest: string
  nativeNonce: string
  nativeResourceId: string
  intentDigest: string
  resourcesDigest: string
  receiptDigest: string
}
/** Host-owned evidence for a dispatched job that never reached start admission. */
export interface LinuxExecutionPartialCleanupProof {
  schemaVersion: 1
  jobId: string
  requestDigest: string
  nativeResourceId: string
  nativeNonce: string
  intentDigest: string
  observedAt: number
  workerAbsent: true
  keeperAbsent: true
  namespaceAbsent: true
  proofDigest: string
}

const HEX = /^[a-f0-9]{64}$/u
const NONCE = /^[a-f0-9]{32}$/u
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const controllers = ['cpu', 'memory', 'pids', 'freezer'] as const
function fail(): never { throw new Error('invalid Linux execution contract or binding') }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && value !== '/' && posix.isAbsolute(value) && posix.normalize(value) === value && !/[\p{Cc}\\]/u.test(value)
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail()
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value) }
  return value
}
function clone<T>(value: T): T { return freeze(JSON.parse(JSON.stringify(value)) as T) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export function linuxExecutionPartialCleanupProofDigest(value: Omit<LinuxExecutionPartialCleanupProof, 'proofDigest'>): string {
  object(value, ['schemaVersion', 'jobId', 'requestDigest', 'nativeResourceId', 'nativeNonce', 'intentDigest', 'observedAt', 'workerAbsent', 'keeperAbsent', 'namespaceAbsent'])
  if (value.schemaVersion !== 1 || !matches(value.jobId, UUID) || !matches(value.requestDigest, HEX)
    || value.nativeResourceId !== `linux-${value.jobId}` || !matches(value.nativeNonce, NONCE)
    || !matches(value.intentDigest, HEX) || !positive(value.observedAt)
    || value.workerAbsent !== true || value.keeperAbsent !== true || value.namespaceAbsent !== true) fail()
  return digest(value)
}
export function validateLinuxExecutionPartialCleanupProof(value: unknown): LinuxExecutionPartialCleanupProof {
  object(value, ['schemaVersion', 'jobId', 'requestDigest', 'nativeResourceId', 'nativeNonce', 'intentDigest', 'observedAt', 'workerAbsent', 'keeperAbsent', 'namespaceAbsent', 'proofDigest'])
  const { proofDigest, ...body } = value
  if (!matches(proofDigest, HEX) || proofDigest !== linuxExecutionPartialCleanupProofDigest(body as Omit<LinuxExecutionPartialCleanupProof, 'proofDigest'>)) fail()
  return clone(value as unknown as LinuxExecutionPartialCleanupProof)
}
function limits(value: unknown): asserts value is LinuxCgroupLimits {
  object(value, ['memoryMiB', 'pidsLimit', 'cpus'])
  if (!positive(value.memoryMiB) || value.memoryMiB > 65_536 || !positive(value.pidsLimit) || value.pidsLimit > 4096
    || typeof value.cpus !== 'number' || !Number.isFinite(value.cpus) || value.cpus < 0.1 || value.cpus > 64) fail()
}
function rootEntries(value: LinuxCgroupRoots): Array<[string, string]> {
  return value.mode === 'v1' ? controllers.map(key => [key, value[key]]) : [['unified', value.unified]]
}
function directory(value: unknown, expected: string): asserts value is LinuxCgroupDirectory {
  object(value, ['path', 'dev', 'ino'])
  if (value.path !== expected || !natural(value.dev) || !positive(value.ino)) fail()
}
export function validateLinuxExecutionContract(value: unknown): LinuxExecutionContract {
  object(value, ['schemaVersion', 'backend', 'runtimeDigest', 'profile', 'limits', 'keeperLimits', 'cgroupRoots'])
  if (value.schemaVersion !== 1 || value.backend !== 'linux-native' || !matches(value.runtimeDigest, HEX) || !['ordinary', 'repository'].includes(value.profile as string)) fail()
  object(value.limits, ['maxDurationMs', 'maxInputBytes', 'maxOutputBytes', 'maxArtifactBytes', 'maxFiles', 'memoryMiB', 'workspaceMiB', 'workspaceInodes', 'pidsLimit', 'cpus'])
  for (const [key, item] of Object.entries(value.limits)) if (key !== 'cpus' && !positive(item)) fail()
  limits({ memoryMiB: value.limits.memoryMiB, pidsLimit: value.limits.pidsLimit, cpus: value.limits.cpus })
  if ((value.limits.maxInputBytes as number) > 1_048_576 || (value.limits.maxOutputBytes as number) > 1_048_576
    || (value.limits.maxArtifactBytes as number) > 1_048_576 || (value.limits.maxFiles as number) > 128
    || (value.limits.workspaceInodes as number) < 16 || (value.limits.workspaceInodes as number) > 1_000_000
    || (value.limits.workspaceMiB as number) > 65_536) fail()
  limits(value.keeperLimits)
  const roots = value.cgroupRoots as LinuxCgroupRoots
  if (!roots || !['v1', 'v2'].includes(roots.mode)) fail()
  object(roots, roots.mode === 'v1' ? ['mode', ...controllers] : ['mode', 'unified'])
  const entries = rootEntries(roots)
  if (new Set(entries.map(([, root]) => root)).size !== entries.length) fail()
  for (const [, root] of entries) if (!path(root) || !(roots.mode === 'v1'
    ? /^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+\/dsh-native\/uid-[1-9][0-9]*$/u
    : /^\/sys\/fs\/cgroup\/dsh-native\/uid-[1-9][0-9]*$/u).test(root)) fail()
  return clone(value as unknown as LinuxExecutionContract)
}
export function linuxExecutionContractDigest(value: LinuxExecutionContract): string { return digest(validateLinuxExecutionContract(value)) }
function intentValue(value: unknown): LinuxExecutionIntent {
  object(value, ['schemaVersion', 'jobId', 'requestDigest', 'nativeResourceId', 'nativeNonce', 'contractDigest', 'bootId', 'uid', 'deadline', 'namespacePath', 'workerNonce', 'keeperNonce', 'roots'])
  if (value.schemaVersion !== 1 || !matches(value.jobId, UUID) || !matches(value.requestDigest, HEX) || value.nativeResourceId !== `linux-${value.jobId}`
    || !matches(value.nativeNonce, NONCE) || !matches(value.contractDigest, HEX) || !matches(value.bootId, UUID)
    || !positive(value.uid) || value.uid > 0xffff_fffe || !positive(value.deadline) || !path(value.namespacePath)
    || !matches(value.workerNonce, NONCE) || !matches(value.keeperNonce, NONCE) || value.workerNonce === value.keeperNonce) fail()
  const roots = value.roots
  const keys = roots && typeof roots === 'object' && Object.hasOwn(roots, 'unified') ? ['unified'] : controllers
  object(roots, keys)
  for (const key of keys) {
    const entry = roots[key]
    if (!entry || typeof entry !== 'object') fail()
    const root = (entry as Record<string, unknown>).path
    if (!path(root) || !(key === 'unified'
      ? /^\/sys\/fs\/cgroup\/dsh-native\/uid-[1-9][0-9]*$/u
      : /^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+\/dsh-native\/uid-[1-9][0-9]*$/u).test(root)
      || !root.endsWith(`/uid-${value.uid}`)) fail()
    directory(entry, root)
  }
  return value as unknown as LinuxExecutionIntent
}
export function validateLinuxExecutionIntent(value: unknown, contract: LinuxExecutionContract): LinuxExecutionIntent {
  const checked = validateLinuxExecutionContract(contract)
  const intent = intentValue(value)
  if (intent.contractDigest !== linuxExecutionContractDigest(checked)) fail()
  const entries = rootEntries(checked.cgroupRoots)
  object(intent.roots, entries.map(([key]) => key))
  for (const [key, root] of entries) directory(intent.roots[key], root)
  return clone(intent)
}
export function linuxExecutionIntentDigest(value: LinuxExecutionIntent): string { return digest(intentValue(value)) }
function snapshotValue(value: unknown): LinuxCgroupSnapshot {
  object(value, ['schemaVersion', 'mode', 'bootId', 'jobId', 'nonce', 'uid', 'deadline', 'limits', 'directories'])
  if (value.schemaVersion !== 1 || value.mode !== 'v1' && value.mode !== 'v2' || !matches(value.bootId, UUID)
    || !matches(value.jobId, UUID) || !matches(value.nonce, NONCE) || !positive(value.uid) || value.uid > 0xffff_fffe || !positive(value.deadline)) fail()
  limits(value.limits)
  const keys = value.mode === 'v1' ? controllers : ['unified']
  object(value.directories, keys)
  for (const key of keys) {
    const entry = value.directories[key]
    if (!entry || typeof entry !== 'object') fail()
    const child = (entry as Record<string, unknown>).path
    if (!path(child) || !child.endsWith(`/uid-${value.uid}/job-${value.jobId}-${value.nonce}`)) fail()
    directory(entry, child)
  }
  return value as unknown as LinuxCgroupSnapshot
}
function resourcesValue(value: unknown): LinuxExecutionResources {
  object(value, ['schemaVersion', 'intentDigest', 'worker', 'keeper'])
  if (value.schemaVersion !== 1 || !matches(value.intentDigest, HEX)) fail()
  const worker = snapshotValue(value.worker), keeper = snapshotValue(value.keeper)
  if (worker.mode !== keeper.mode || worker.bootId !== keeper.bootId || worker.jobId !== keeper.jobId || worker.uid !== keeper.uid
    || worker.deadline !== keeper.deadline || worker.nonce === keeper.nonce) fail()
  for (const key of Object.keys(worker.directories)) {
    const left = worker.directories[key]!, right = keeper.directories[key]!
    if (posix.dirname(left.path) !== posix.dirname(right.path) || left.dev !== right.dev || left.ino === right.ino) fail()
  }
  return value as unknown as LinuxExecutionResources
}
export function validateLinuxExecutionResources(value: unknown, intent: LinuxExecutionIntent, contract: LinuxExecutionContract): LinuxExecutionResources {
  const checked = validateLinuxExecutionIntent(intent, contract)
  resourcesValue(value)
  object(value, ['schemaVersion', 'intentDigest', 'worker', 'keeper'])
  if (value.schemaVersion !== 1 || value.intentDigest !== linuxExecutionIntentDigest(checked)) fail()
  const entries = rootEntries(contract.cgroupRoots)
  for (const kind of ['worker', 'keeper'] as const) {
    const item = value[kind]
    object(item, ['schemaVersion', 'mode', 'bootId', 'jobId', 'nonce', 'uid', 'deadline', 'limits', 'directories'])
    const nonce = checked[kind === 'worker' ? 'workerNonce' : 'keeperNonce']
    const expectedLimits = kind === 'worker' ? { memoryMiB: contract.limits.memoryMiB, pidsLimit: contract.limits.pidsLimit, cpus: contract.limits.cpus } : contract.keeperLimits
    limits(item.limits)
    if (item.schemaVersion !== 1 || item.mode !== contract.cgroupRoots.mode || item.bootId !== checked.bootId || item.jobId !== checked.jobId
      || item.nonce !== nonce || item.uid !== checked.uid || item.deadline !== checked.deadline || canonical(item.limits) !== canonical(expectedLimits)) fail()
    object(item.directories, entries.map(([key]) => key))
    for (const [key, root] of entries) {
      directory(item.directories[key], `${root}/job-${checked.jobId}-${nonce}`)
      const rootIdentity = checked.roots[key]!
      const child = item.directories[key] as LinuxCgroupDirectory
      if (child.dev !== rootIdentity.dev || child.ino === rootIdentity.ino) fail()
    }
  }
  const worker = value.worker as unknown as LinuxCgroupSnapshot, keeper = value.keeper as unknown as LinuxCgroupSnapshot
  for (const [key] of entries) if (worker.directories[key]!.dev === keeper.directories[key]!.dev && worker.directories[key]!.ino === keeper.directories[key]!.ino) fail()
  return clone(value as unknown as LinuxExecutionResources)
}
export function linuxExecutionResourcesDigest(value: LinuxExecutionResources): string {
  return digest(resourcesValue(value))
}
export function validateLinuxReceiptBinding(value: unknown): LinuxReceiptBinding {
  object(value, ['requestDigest', 'nativeNonce', 'nativeResourceId', 'intentDigest', 'resourcesDigest', 'receiptDigest'])
  if (!matches(value.requestDigest, HEX) || !matches(value.nativeNonce, NONCE) || typeof value.nativeResourceId !== 'string'
    || !/^linux-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value.nativeResourceId)
    || !matches(value.intentDigest, HEX) || !matches(value.resourcesDigest, HEX) || !matches(value.receiptDigest, HEX)) fail()
  return clone(value as unknown as LinuxReceiptBinding)
}
