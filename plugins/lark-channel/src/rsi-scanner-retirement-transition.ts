import { createHash } from 'node:crypto'
import type {
  AutomationRetirementDefinitionRecord,
  AutomationRetirementReceipt,
  AutomationRetirementSchemaEntry,
  AutomationRetirementSnapshot,
} from '@dsh-enhanced/assistant-automations'
import { externalPrincipalId, ownerRouteAuthorityHash } from '@dsh-enhanced/assistant-delivery'
import type { RevokedOwnerRouteSnapshot } from '@dsh-enhanced/assistant-delivery'

const scannerPrefixes = {
  'assistant-memory-learning': 'memory-scan-',
  'assistant-growth-usage': 'usage-scan-',
  'plugin-control-plane-task-observations': 'task-observation-scan-',
  'plugin-control-plane-live-qualification': 'live-qualification-scan-',
} as const

export interface ScannerRetirementTarget {
  readonly owner: keyof typeof scannerPrefixes
  readonly automationId: string
}

export interface ScannerRetirementTransitionInput {
  readonly before: AutomationRetirementSnapshot
  readonly after: AutomationRetirementSnapshot
  readonly ownerProof: RevokedOwnerRouteSnapshot
  readonly targets: readonly ScannerRetirementTarget[]
}

export type ScannerRetirementOperation = Pick<AutomationRetirementReceipt,
  'owner' | 'automationId' | 'operationId' | 'definitionHash' | 'expectedVersion' | 'reason' | 'evidenceDigest'>

export const scannerRetirementTransitionProtocol = 'lark-channel/scanner-retirement-transition/v1' as const

export interface ScannerRetirementTransitionReceipt {
  readonly protocol: typeof scannerRetirementTransitionProtocol
  readonly beforeSnapshotDigest: string
  readonly afterSnapshotDigest: string
  readonly ownerProofSnapshotDigest: string
  readonly targets: readonly Readonly<ScannerRetirementTarget & { evidenceDigest: string; markerDigest: string }>[]
  readonly receiptDigest: string
}

export type ScannerRetirementTransitionErrorCode = 'invalid-proof' | 'invalid-targets' | 'definitions-changed'
  | 'retirements-changed' | 'history-changed' | 'schema-changed'

export class ScannerRetirementTransitionError extends Error {
  constructor(readonly code: ScannerRetirementTransitionErrorCode) {
    super(`scanner retirement transition rejected: ${code}`)
    this.name = 'ScannerRetirementTransitionError'
  }
}

const digestPattern = /^[a-f0-9]{64}$/u
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const jsonDigest = (value: unknown): string => digest(JSON.stringify(value))
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum

function reject(code: ScannerRetirementTransitionErrorCode): never { throw new ScannerRetirementTransitionError(code) }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right) }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function uniqueMap<T>(items: readonly T[], key: (item: T) => string, code: ScannerRetirementTransitionErrorCode): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const identity = key(item)
    if (result.has(identity)) reject(code)
    result.set(identity, item)
  }
  return result
}
const markerKey = (marker: { owner: string; automationId: string }): string => JSON.stringify([marker.owner, marker.automationId])
const schemaKey = (entry: AutomationRetirementSchemaEntry): string => JSON.stringify([entry.type, entry.name])

/** Reconstruct the exact scope insertion order passed by each production scanner runtime. */
function ownerEvidence(proof: RevokedOwnerRouteSnapshot): (owner: ScannerRetirementTarget['owner']) => string {
  if (proof.protocol !== 'assistant-delivery/revoked-owner-route-snapshot/v1'
    || ![23, 24, 25, 26, 27].includes(proof.schemaVersion)
    || !integer(proof.frozenPrincipalVersion, 1) || !digestPattern.test(proof.snapshotDigest)) reject('invalid-proof')
  const authority = proof.authority
  const authorityHash = ownerRouteAuthorityHash(authority)
  // The public hash function validates the full authority and canonicalizes it.
  // Rebuild canonical field order to reject noncanonical values while accepting
  // arbitrary incoming JSON key order, without importing another bundle's internals.
  const conversation = authority.conversation
  const principal = authority.principal
  const orderedAuthority = {
    id: authority.id,
    conversation: { channel: conversation.channel, account: conversation.account, tenant: conversation.tenant,
      kind: conversation.kind, chat: conversation.chat, ...(conversation.thread === undefined ? {} : { thread: conversation.thread }) },
    principal: { channel: principal.channel, account: principal.account, tenant: principal.tenant, user: principal.user },
    workspace: authority.workspace, agentPreset: authority.agentPreset, policyRef: authority.policyRef,
    minimumGeneration: authority.minimumGeneration,
  }
  if (jsonDigest(orderedAuthority) !== authorityHash) reject('invalid-proof')
  const state = proof.state
  if (state.status !== 'revoked' || state.authorityId !== authority.id || state.authorityHash !== authorityHash
    || state.principalId !== externalPrincipalId(principal)
    || typeof state.principalRecordId !== 'string' || !/^principal_[0-9a-f-]{8,}$/u.test(state.principalRecordId)
    || !integer(state.principalVersion, 1) || state.principalVersion < proof.frozenPrincipalVersion) reject('invalid-proof')
  const orderedState = { status: 'revoked' as const, authorityId: authority.id, authorityHash,
    principalId: externalPrincipalId(principal), principalRecordId: state.principalRecordId, principalVersion: state.principalVersion }
  if (!same(state, orderedState)) reject('invalid-proof')
  const { snapshotDigest, ...unsigned } = proof
  if (digest(canonicalJson(unsigned)) !== snapshotDigest) reject('invalid-proof')
  return owner => jsonDigest({ protocol: 'scanner-owner-revoked/v1',
    scope: { authorityId: authority.id, principalId: orderedState.principalId,
      workspace: authority.workspace, agentPreset: authority.agentPreset,
      ...(owner === 'assistant-memory-learning' ? { expectedOwner: { authorityHash,
        principalRecordId: orderedState.principalRecordId, principalVersion: proof.frozenPrincipalVersion } } : {}) },
    state: orderedState })
}

function stableDefinition(record: AutomationRetirementDefinitionRecord) {
  const { status: _status, nextRunAt: _nextRunAt, updatedAt: _updatedAt, version: _version, ...stable } = record
  return stable
}

function verifySchema(before: AutomationRetirementSnapshot, after: AutomationRetirementSnapshot): void {
  const original = uniqueMap(before.schemaEntries, schemaKey, 'schema-changed')
  const current = uniqueMap(after.schemaEntries, schemaKey, 'schema-changed')
  for (const [key, entry] of original) if (!same(entry, current.get(key))) reject('schema-changed')
  if (before.schemaVersion === 16) {
    if (original.size !== current.size || !same(before.schemaEntries, after.schemaEntries)
      || before.schemaDigest !== after.schemaDigest) reject('schema-changed')
    return
  }
  // Formal readers have already verified the exact SQL for the table and four
  // triggers. The v15->v16 allowance is only these seven identities, preserving
  // every old schema entry byte-for-byte. No arbitrary new SQL is authorized.
  const additions: AutomationRetirementSchemaEntry[] = [
    { type: 'table', name: 'automation_system_retirements', table: 'automation_system_retirements', sql: '' },
    { type: 'index', name: 'sqlite_autoindex_automation_system_retirements_1', table: 'automation_system_retirements', sql: null },
    { type: 'index', name: 'sqlite_autoindex_automation_system_retirements_2', table: 'automation_system_retirements', sql: null },
    { type: 'trigger', name: 'automation_retirements_no_update', table: 'automation_system_retirements', sql: '' },
    { type: 'trigger', name: 'automation_retirements_no_delete', table: 'automation_system_retirements', sql: '' },
    { type: 'trigger', name: 'automation_retired_no_activate_insert', table: 'automation_definitions', sql: '' },
    { type: 'trigger', name: 'automation_retired_no_activate_update', table: 'automation_definitions', sql: '' },
  ]
  const allowed = new Map(additions.map(entry => [schemaKey(entry), entry]))
  if (current.size !== original.size + allowed.size) reject('schema-changed')
  for (const [key, entry] of current) {
    if (original.has(key)) continue
    const expected = allowed.get(key)
    if (expected === undefined || entry.table !== expected.table
      || (expected.sql === null ? entry.sql !== null : typeof entry.sql !== 'string' || entry.sql.length === 0)) reject('schema-changed')
    allowed.delete(key)
  }
  if (allowed.size !== 0) reject('schema-changed')
}

/**
 * Freeze the exact operations before any staged service is mounted. Inputs have
 * the same trusted-reader and independently derived configuration requirements
 * as transition verification. These tuples confer no permission: the writer must
 * use the formal Automations service and retain them unchanged across retries.
 */
export function prepareScannerRetirementOperations(
  input: Omit<ScannerRetirementTransitionInput, 'after'>,
): readonly ScannerRetirementOperation[] {
  try {
    const { before, ownerProof } = input
    if (before.protocol !== 'assistant-automations/retirement-snapshot/v1'
      || ![15, 16].includes(before.schemaVersion) || before.inFlightCount !== 0
      || !digestPattern.test(before.snapshotDigest)) reject('invalid-proof')
    const evidenceForOwner = ownerEvidence(ownerProof)
    if (!Array.isArray(input.targets) || input.targets.length > 4) reject('invalid-targets')
    const originals = uniqueMap(before.records, record => record.id, 'definitions-changed')
    const oldMarkers = uniqueMap(before.retirements, markerKey, 'retirements-changed')
    if (before.schemaVersion === 15 && oldMarkers.size !== 0) reject('retirements-changed')
    const owners = new Set<string>()
    return freeze(input.targets.map((inputTarget: ScannerRetirementTarget) => {
      const target: ScannerRetirementTarget = { owner: inputTarget.owner, automationId: inputTarget.automationId }
      const prefix = Object.hasOwn(scannerPrefixes, target.owner) ? scannerPrefixes[target.owner] : undefined
      if (!same(target, inputTarget) || prefix === undefined || typeof target.automationId !== 'string'
        || !new RegExp(`^${prefix}[a-f0-9]{64}$`, 'u').test(target.automationId) || owners.has(target.owner)) reject('invalid-targets')
      owners.add(target.owner)
      const record = originals.get(target.automationId)
      if (record === undefined || record.owner !== target.owner || record.runningTaskCount !== 0
        || !['active', 'paused'].includes(record.status) || !integer(record.version, 1)
        || !digestPattern.test(record.definitionHash)) reject('definitions-changed')
      if (oldMarkers.has(markerKey(target))) reject('retirements-changed')
      const evidenceDigest = evidenceForOwner(target.owner)
      return { ...target, definitionHash: record.definitionHash, expectedVersion: record.version,
        operationId: `owner-revoked:${jsonDigest([target.owner, target.automationId, record.definitionHash, record.version, evidenceDigest])}`,
        reason: 'owner-revoked' as const, evidenceDigest }
    }))
  } catch (error) {
    if (error instanceof ScannerRetirementTransitionError) throw error
    return reject('invalid-proof')
  }
}

/**
 * Pure verification of a preselected retirement change; grants no write or execution permission.
 * Both snapshots and ownerProof MUST come from the formal trusted local readers.
 * The parent installer MUST independently derive exact targets from frozen effective
 * configuration and bind that configuration, owner route and transaction to this call.
 * For Memory, ownerProof.frozenPrincipalVersion MUST equal the frozen learning
 * grant owner.principalVersion; its expectedOwner scope uses that grant version,
 * while the observed revoked state can be at a later durable principal version.
 * A matching scanner prefix does not prove that a definition belongs to that config.
 * Digests are consistency checks after trusted reads, never external authenticity signatures.
 */
export function verifyScannerRetirementTransition(input: ScannerRetirementTransitionInput): ScannerRetirementTransitionReceipt {
  try {
    const { before, after, ownerProof } = input
    if (before.protocol !== 'assistant-automations/retirement-snapshot/v1' || after.protocol !== before.protocol
      || (before.schemaVersion !== 15 && before.schemaVersion !== 16) || after.schemaVersion !== 16
      || before.inFlightCount !== 0 || after.inFlightCount !== 0
      || !digestPattern.test(before.snapshotDigest) || !digestPattern.test(after.snapshotDigest)) reject('invalid-proof')
    const operations = prepareScannerRetirementOperations(input)
    const targets: ScannerRetirementTarget[] = input.targets.map(target => ({ owner: target.owner, automationId: target.automationId }))
    const selected = uniqueMap(targets, target => target.automationId, 'invalid-targets')
    const originals = uniqueMap(before.records, record => record.id, 'definitions-changed')
    const current = uniqueMap(after.records, record => record.id, 'definitions-changed')
    if (originals.size !== current.size) reject('definitions-changed')
    for (const [id, record] of originals) {
      const updated = current.get(id)
      if (updated === undefined || record.runningTaskCount !== 0 || updated.runningTaskCount !== 0
        || record.immutableDigest !== updated.immutableDigest) reject('definitions-changed')
      if (!selected.has(id) && !same(record, updated)) reject('definitions-changed')
    }
    const oldMarkers = uniqueMap(before.retirements, markerKey, 'retirements-changed')
    const newMarkers = uniqueMap(after.retirements, markerKey, 'retirements-changed')
    uniqueMap(after.retirements, marker => marker.operationId, 'retirements-changed')
    if ((before.schemaVersion === 15 && oldMarkers.size !== 0)
      || newMarkers.size !== oldMarkers.size + targets.length) reject('retirements-changed')
    for (const [key, marker] of oldMarkers) if (!same(marker, newMarkers.get(key))) reject('retirements-changed')
    const receipts = targets.map((target, index) => {
      const operation = operations[index]!
      const { evidenceDigest } = operation
      const record = originals.get(target.automationId)
      const updated = current.get(target.automationId)
      if (record === undefined || updated === undefined || record.owner !== target.owner
        || (record.status !== 'active' && record.status !== 'paused') || record.runningTaskCount !== 0
        || updated.runningTaskCount !== 0 || !integer(record.version, 1) || !integer(updated.version, 2)
        || updated.version !== record.version + 1 || updated.status !== 'paused' || Object.hasOwn(updated, 'nextRunAt')
        || !same(stableDefinition(record), stableDefinition(updated))) reject('definitions-changed')
      const key = markerKey(target)
      const marker = newMarkers.get(key)
      if (oldMarkers.has(key) || marker === undefined || !integer(marker.retiredAt)
        || updated.updatedAt !== marker.retiredAt) reject('retirements-changed')
      const expected: AutomationRetirementReceipt = {
        ...operation, definitionVersion: updated.version, automationStatus: 'paused', retiredAt: marker.retiredAt,
      }
      if (!same(marker, expected)) reject('retirements-changed')
      return { ...target, evidenceDigest, markerDigest: digest(canonicalJson(expected)) }
    })
    const history = uniqueMap(before.historyTables, table => table.name, 'history-changed')
    const updatedHistory = uniqueMap(after.historyTables, table => table.name, 'history-changed')
    if (history.size !== updatedHistory.size || !same(before.historyTables, after.historyTables)) reject('history-changed')
    for (const [name, table] of history) if (!same(table, updatedHistory.get(name))) reject('history-changed')
    verifySchema(before, after)
    receipts.sort((left, right) => left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0)
    const unsigned = { protocol: scannerRetirementTransitionProtocol, beforeSnapshotDigest: before.snapshotDigest,
      afterSnapshotDigest: after.snapshotDigest, ownerProofSnapshotDigest: ownerProof.snapshotDigest, targets: receipts }
    return freeze({ ...unsigned, receiptDigest: digest(canonicalJson(unsigned)) })
  } catch (error) {
    if (error instanceof ScannerRetirementTransitionError) throw error
    return reject('invalid-proof')
  }
}
