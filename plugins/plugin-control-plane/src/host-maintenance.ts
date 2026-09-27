/** Signed, append-only deployment rebasing during an offline managed Host update.
 * Original plans, approvals and readiness receipts remain unchanged. */
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { HostAttestationReceipt, HostInputWitness, PluginActivationPlan } from './types.js'

type Pin = { path: string; sha256: string | null }
type DeploymentPin = { input: string; path: string; sha256: string }
export interface HostMaintenanceSnapshot {
  executor: PluginActivationPlan['executor']
  profileFiles: readonly Pin[]
  baselineFiles: readonly Pin[]
  deploymentFiles: readonly DeploymentPin[]
  baselineDeploymentFiles: readonly DeploymentPin[]
  unitProperties: Record<string, string>
}
export interface HostMaintenanceRecord {
  schemaVersion: 1
  kind: 'dsh-host-maintenance'
  transactionId: string
  installationId: string
  ledger: PluginActivationPlan['ledger']
  profile: { name: string; path: string }
  plan: { id: string; digest: string }
  activation: { id: string; fence: number }
  predecessor: { operationId: string; receiptDigest: string; hostGeneration: number }
  sequence: number
  previousDigest: string | null
  before: HostMaintenanceSnapshot
  after: HostMaintenanceSnapshot
  issuedAt: number
  authority: string
  keyId: string
  publicKeyPem: string
  signature: string
}
const unitKeys = ['FragmentPath', 'DropInPaths', 'ExecStart', 'Environment', 'WorkingDirectory', 'User', 'Group', 'Type', 'KillMode']
const hex = /^[a-f0-9]{64}$/u
function fail(): never { throw new Error('Host maintenance proof is invalid') }
export function hostMaintenanceCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(hostMaintenanceCanonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${hostMaintenanceCanonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export function hostMaintenanceDigest(value: unknown): string { return createHash('sha256').update(hostMaintenanceCanonical(value)).digest('hex') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max || value.includes('\0')) fail()
}
function path(value: unknown): asserts value is string {
  text(value); if (!isAbsolute(value) || resolve(value) !== value || value === '/') fail()
}
function integer(value: unknown, min = 1): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < min) fail() }
function digest(value: unknown): asserts value is string { if (typeof value !== 'string' || !hex.test(value)) fail() }
function snapshot(value: unknown, root: string): asserts value is HostMaintenanceSnapshot {
  const item = object(value, ['executor', 'profileFiles', 'baselineFiles', 'deploymentFiles', 'baselineDeploymentFiles', 'unitProperties'])
  const executor = object(item.executor, ['id', 'version', 'path', 'sha256'])
  text(executor.id); text(executor.version); path(executor.path); digest(executor.sha256)
  const properties = object(item.unitProperties, unitKeys)
  for (const value of Object.values(properties)) if (typeof value !== 'string' || Buffer.byteLength(value) > 65536 || value.includes('\0')) fail()
  for (const name of ['profileFiles', 'baselineFiles', 'deploymentFiles', 'baselineDeploymentFiles'] as const) {
    const pins = item[name]
    if (!Array.isArray(pins) || pins.length > 128 || name === 'profileFiles' && pins.length !== 3
      || name === 'baselineFiles' && ![0, 3].includes(pins.length)) fail()
    const seen = new Set<string>()
    for (const pin of pins) {
      const deployment = name.includes('Deployment') || name === 'deploymentFiles'
      const value = object(pin, deployment ? ['input', 'path', 'sha256'] : ['path', 'sha256'])
      path(value.path)
      if (!value.path.startsWith(`${root}/`) || seen.has(value.path)) fail()
      seen.add(value.path)
      if (deployment) text(value.input)
      if (value.sha256 !== null || name !== 'baselineFiles') digest(value.sha256)
    }
  }
}
export function parseHostMaintenanceRecord(value: unknown): HostMaintenanceRecord {
  if (Buffer.byteLength(JSON.stringify(value)) > 524288) fail()
  const item = object(value, ['schemaVersion', 'kind', 'transactionId', 'installationId', 'ledger', 'profile', 'plan', 'activation',
    'predecessor', 'sequence', 'previousDigest', 'before', 'after', 'issuedAt', 'authority', 'keyId', 'publicKeyPem', 'signature'])
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-host-maintenance') fail()
  for (const name of ['transactionId', 'installationId', 'authority', 'keyId']) text(item[name], 160)
  const ledger = object(item.ledger, ['id', 'path']); text(ledger.id); path(ledger.path)
  const profile = object(item.profile, ['name', 'path']); text(profile.name, 64); path(profile.path)
  const plan = object(item.plan, ['id', 'digest']); text(plan.id); digest(plan.digest)
  const activation = object(item.activation, ['id', 'fence']); text(activation.id); integer(activation.fence)
  const predecessor = object(item.predecessor, ['operationId', 'receiptDigest', 'hostGeneration'])
  text(predecessor.operationId); digest(predecessor.receiptDigest); integer(predecessor.hostGeneration)
  integer(item.sequence); integer(item.issuedAt)
  if (item.sequence === 1 ? item.previousDigest !== null : typeof item.previousDigest !== 'string' || !hex.test(item.previousDigest)) fail()
  snapshot(item.before, profile.path); snapshot(item.after, profile.path)
  for (const field of ['profileFiles', 'baselineFiles', 'deploymentFiles', 'baselineDeploymentFiles'] as const) {
    const identity = (values: readonly (Pin | DeploymentPin)[]) => values.map(pin => ({ path: pin.path, ...('input' in pin ? { input: pin.input } : {}) }))
    if (hostMaintenanceCanonical(identity(item.before[field])) !== hostMaintenanceCanonical(identity(item.after[field]))) fail()
  }
  if (item.before.executor.id !== item.after.executor.id) fail()
  text(item.publicKeyPem, 4096); text(item.signature, 256)
  const { signature, ...unsigned } = item
  const key = createPublicKey(item.publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(hostMaintenanceCanonical(unsigned)), key, Buffer.from(signature as string, 'base64'))) fail()
  return item as unknown as HostMaintenanceRecord
}
export function signHostMaintenanceRecord(input: Omit<HostMaintenanceRecord, 'publicKeyPem' | 'signature'>, privateKeyPem: string): HostMaintenanceRecord {
  const unsigned = { ...input, publicKeyPem: createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString() }
  return parseHostMaintenanceRecord({ ...unsigned, signature: sign(null, Buffer.from(hostMaintenanceCanonical(unsigned)), privateKeyPem).toString('base64') })
}

/** Anchor every maintenance chain in the already applied original readiness key. */
export function verifyHostMaintenanceChain(records: readonly HostMaintenanceRecord[], plan: PluginActivationPlan,
  readiness: HostAttestationReceipt, witness: HostInputWitness): readonly HostMaintenanceRecord[] {
  if (records.length > 256 || Buffer.byteLength(JSON.stringify(records)) > 450000
    || readiness.phase !== 'readiness' || readiness.outcome !== 'passed' || readiness.installationId !== plan.installationId
    || readiness.planId !== plan.id || readiness.planDigest !== plan.digest || readiness.activationId !== witness.activationId
    || readiness.fence !== witness.fence || readiness.evidenceDigest !== hostMaintenanceDigest(readiness.evidence)) fail()
  let prior: HostMaintenanceRecord | undefined
  for (const value of records) {
    const record = parseHostMaintenanceRecord(value), same = (a: unknown, b: unknown) => hostMaintenanceDigest(a) === hostMaintenanceDigest(b)
    if (record.installationId !== plan.installationId || !same(record.ledger, plan.ledger)
      || record.profile.name !== plan.profile || record.profile.path !== plan.target.profilePath
      || record.plan.id !== plan.id || record.plan.digest !== plan.digest || record.activation.id !== plan.activation?.id
      || record.activation.fence !== witness.fence || record.sequence !== (prior?.sequence ?? 0) + 1
      || record.previousDigest !== (prior ? hostMaintenanceDigest(prior) : null)
      || record.predecessor.operationId !== readiness.operationId || record.predecessor.receiptDigest !== hostMaintenanceDigest(readiness)
      || record.predecessor.hostGeneration !== readiness.hostGeneration || record.authority !== readiness.authority
      || record.keyId !== readiness.keyId || record.issuedAt < readiness.observedAt || record.issuedAt > Date.now()
      || prior && (record.issuedAt < prior.issuedAt || !same(record.before, prior.after))) fail()
    const { signature, ...unsigned } = readiness
    if (!verify(null, Buffer.from(hostMaintenanceCanonical(unsigned)), createPublicKey(record.publicKeyPem), Buffer.from(signature, 'base64'))) fail()
    if (!prior && (!same(record.before.executor, plan.executor) || !same(record.before.profileFiles, witness.profileFiles)
      || !same(record.before.baselineFiles, plan.activation?.targetBaselineFiles ?? [])
      || !same(record.before.deploymentFiles, witness.deploymentFiles) || !same(record.before.baselineDeploymentFiles, witness.baselineDeploymentFiles))) fail()
    prior = record
  }
  return records
}

export function readHostMaintenanceRecords(database: DatabaseSync, planId: string): HostMaintenanceRecord[] {
  const rows = database.prepare('SELECT record_json,record_digest,sequence FROM deployment_host_maintenance WHERE plan_id=? ORDER BY sequence').all(planId)
  return rows.map(row => {
    const record = parseHostMaintenanceRecord(JSON.parse(String(row.record_json)))
    if (record.plan.id !== planId || record.sequence !== row.sequence || hostMaintenanceDigest(record) !== row.record_digest) fail()
    return record
  })
}
