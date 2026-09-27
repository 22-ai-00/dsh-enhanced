/** Append-only, Host-signed source lineage across a managed local cohort update. */
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { validateSourceBaselineConfig, type SourceBaselineConfig } from './source-baseline.js'
import type { PluginSourcePlan, SourceReleaseOperation } from './types.js'

const HEX = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
function invalid(): never { throw new Error('source maintenance record is invalid') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export function sourceMaintenanceDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || value.includes('\0')) invalid()
}
function path(value: unknown): asserts value is string { text(value); if (!isAbsolute(value) || resolve(value) !== value || value === '/') invalid() }
function hex(value: unknown): asserts value is string { if (typeof value !== 'string' || !HEX.test(value)) invalid() }
function commit(value: unknown): asserts value is string { if (typeof value !== 'string' || !COMMIT.test(value)) invalid() }
function integer(value: unknown, minimum = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid()
}
export interface SourceMaintenanceVersion { sourceCommit: string; version: string; cohortDigest: string }
export interface SourceMaintenanceRecord {
  schemaVersion: 1
  kind: 'dsh-source-maintenance'
  transactionId: string
  installationId: string
  ledger: { id: string; path: string }
  repository: string
  baseline: SourceBaselineConfig
  sequence: number
  previousDigest: string | null
  previousTip: string
  candidateTip: string
  upstreamCommit: string
  sourceTree: string
  preparationReceiptDigest: string
  originalBootstrapDigest: string
  before: SourceMaintenanceVersion
  after: SourceMaintenanceVersion
  host: { planId: string; planDigest: string; readinessOperationId: string; readinessReceiptDigest: string } | null
  issuedAt: number
  authority: string
  keyId: string
  publicKeyPem: string
  signature: string
}
export interface SourceMaintenanceAnchor {
  installationId: string
  ledger: { id: string; path: string }
  repository: string
  baseline: SourceBaselineConfig
  hostIdentity: { authority: string; keyId: string; publicKeyPem: string }
}
export function sourceMaintenanceSourceFieldsDigest(value: Pick<SourceMaintenanceRecord,
  'before' | 'after' | 'upstreamCommit' | 'sourceTree' | 'preparationReceiptDigest' | 'originalBootstrapDigest'>): string {
  return sourceMaintenanceDigest({ before: value.before, after: value.after, upstreamCommit: value.upstreamCommit,
    sourceTree: value.sourceTree, preparationReceiptDigest: value.preparationReceiptDigest,
    originalBootstrapDigest: value.originalBootstrapDigest })
}
export function parseSourceMaintenanceRecord(value: unknown): SourceMaintenanceRecord {
  if (Buffer.byteLength(JSON.stringify(value)) > 16384) invalid()
  const item = object(value, ['schemaVersion','kind','transactionId','installationId','ledger','repository','baseline',
    'sequence','previousDigest','previousTip','candidateTip','upstreamCommit','sourceTree','preparationReceiptDigest',
    'originalBootstrapDigest','before','after','host','issuedAt','authority','keyId','publicKeyPem','signature'])
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-source-maintenance') invalid()
  for (const key of ['transactionId','installationId','authority','keyId']) text(item[key], 160)
  const ledger = object(item.ledger, ['id','path']); text(ledger.id, 160); path(ledger.path)
  path(item.repository)
  try { validateSourceBaselineConfig(item.baseline) } catch { invalid() }
  integer(item.sequence); integer(item.issuedAt)
  if (item.sequence === 1 ? item.previousDigest !== null : typeof item.previousDigest !== 'string' || !HEX.test(item.previousDigest)) invalid()
  for (const key of ['previousTip','candidateTip','upstreamCommit']) commit(item[key])
  if (item.previousTip === item.candidateTip) invalid()
  commit(item.sourceTree)
  for (const key of ['preparationReceiptDigest','originalBootstrapDigest']) hex(item[key])
  for (const key of ['before','after']) {
    const version = object(item[key], ['sourceCommit','version','cohortDigest'])
    commit(version.sourceCommit); text(version.version, 160); hex(version.cohortDigest)
  }
  if (item.host !== null) {
    const host = object(item.host, ['planId','planDigest','readinessOperationId','readinessReceiptDigest'])
    text(host.planId, 160); hex(host.planDigest); text(host.readinessOperationId, 160); hex(host.readinessReceiptDigest)
  }
  text(item.publicKeyPem, 4096); text(item.signature, 256)
  try {
    const key = createPublicKey(item.publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519') invalid()
    const { signature, ...unsigned } = item
    const bytes = Buffer.from(signature as string, 'base64')
    if (bytes.length !== 64 || bytes.toString('base64') !== signature
      || !verify(null, Buffer.from(canonical(unsigned)), key, bytes)) invalid()
  } catch { invalid() }
  return item as unknown as SourceMaintenanceRecord
}
export function signSourceMaintenanceRecord(input: Omit<SourceMaintenanceRecord, 'publicKeyPem' | 'signature'>,
  privateKeyPem: string): SourceMaintenanceRecord {
  const unsigned = { ...input, publicKeyPem: createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString() }
  return parseSourceMaintenanceRecord({ ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), privateKeyPem).toString('base64') })
}
export function verifySourceMaintenanceRecords(records: readonly SourceMaintenanceRecord[], anchor: SourceMaintenanceAnchor): readonly SourceMaintenanceRecord[] {
  if (records.length > 256) invalid()
  let prior: SourceMaintenanceRecord | undefined
  const transactions = new Set<string>(), tips = new Set<string>()
  for (const value of records) {
    const record = parseSourceMaintenanceRecord(value)
    if (record.installationId !== anchor.installationId || sourceMaintenanceDigest(record.ledger) !== sourceMaintenanceDigest(anchor.ledger)
      || record.repository !== anchor.repository || sourceMaintenanceDigest(record.baseline) !== sourceMaintenanceDigest(anchor.baseline)
      || record.authority !== anchor.hostIdentity.authority || record.keyId !== anchor.hostIdentity.keyId
      || record.publicKeyPem !== anchor.hostIdentity.publicKeyPem || record.sequence !== (prior?.sequence ?? 0) + 1
      || record.previousDigest !== (prior ? sourceMaintenanceDigest(prior) : null)
      || prior && (record.issuedAt < prior.issuedAt || record.originalBootstrapDigest !== prior.originalBootstrapDigest
        || sourceMaintenanceDigest(record.before) !== sourceMaintenanceDigest(prior.after))
      || transactions.has(record.transactionId) || tips.has(record.candidateTip)) invalid()
    transactions.add(record.transactionId); tips.add(record.candidateTip); prior = record
  }
  return records
}

/** One structural lineage for signed releases and signed offline maintenance. */
export function sourceBaselineChain(config: SourceBaselineConfig,
  history: readonly { plan: PluginSourcePlan; operation: SourceReleaseOperation }[],
  maintenance: readonly SourceMaintenanceRecord[]): readonly string[] {
  if (history.length > 1024 || maintenance.length > 256) invalid()
  const edges = new Map<string, string>(), destinations = new Set<string>()
  const add = (base: string, next: string): void => {
    if (!COMMIT.test(base) || !COMMIT.test(next) || base === next || edges.has(base) || destinations.has(next)) {
      throw new Error('source baseline history forks or repeats an edge')
    }
    edges.set(base, next); destinations.add(next)
  }
  for (const { plan, operation } of history) {
    const receipt = operation.receipt, evidence = receipt?.evidence
    if (plan.status !== 'release-complete' || operation.status !== 'applied' || operation.phase !== 'merge'
      || evidence?.kind !== 'merge' || evidence.targetBranch !== config.targetBranch
      || plan.releaseAuthorization?.releasePolicy.targetBranch !== config.targetBranch) invalid()
    add(plan.baseCommit, evidence.mergeCommit)
  }
  for (const record of maintenance) {
    if (sourceMaintenanceDigest(record.baseline) !== sourceMaintenanceDigest(config)) invalid()
    add(record.previousTip, record.candidateTip)
  }
  const chain = [config.initialCommit], visited = new Set(chain)
  while (edges.has(chain.at(-1)!)) {
    const next = edges.get(chain.at(-1)!)!
    if (visited.has(next)) invalid()
    chain.push(next); visited.add(next)
  }
  if (chain.length !== edges.size + 1) throw new Error('source baseline history is disconnected')
  return chain
}
