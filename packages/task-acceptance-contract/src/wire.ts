import { createHash } from 'node:crypto'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import type {
  AcceptanceCriterion, AcceptanceJsonValue, AuthorityRef, CriterionResult,
  TaskAcceptanceContract, TaskAcceptanceContractInput, TaskVerificationReceipt,
  TaskVerificationReceiptInput,
} from './types.js'

export type AcceptanceContractErrorCode = 'invalid-contract' | 'invalid-receipt'

export class AcceptanceContractError extends Error {
  constructor(readonly code: AcceptanceContractErrorCode, message: string) {
    super(message)
    this.name = 'AcceptanceContractError'
  }
}

const DIGEST = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const PRESET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_TEXT_BYTES = 65_536
const MAX_CONTRACT_BYTES = 262_144
const MAX_RECEIPT_BYTES = 1_048_576
const MAX_CANONICAL_BYTES = 1_048_576

function fail(code: AcceptanceContractErrorCode, message: string): never {
  throw new AcceptanceContractError(code, message)
}
function record(value: unknown, code: AcceptanceContractErrorCode, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(code, `${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(code, `${label} contains a symbol property`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (UNSAFE.has(key) || !Object.hasOwn(descriptor, 'value')) fail(code, `${label} contains an unsafe property`)
  }
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: AcceptanceContractErrorCode, label: string): void {
  const actual = Reflect.ownKeys(value)
  if (actual.some(key => typeof key !== 'string')) fail(code, `${label} has an invalid shape`)
  const actualStrings = actual as string[]
  const actualSorted = [...actualStrings].sort()
  const expected = [...keys].sort()
  if (actualSorted.length !== expected.length || actualSorted.some((key, index) => key !== expected[index])) {
    fail(code, `${label} has an invalid shape`)
  }
}
function text(value: unknown, code: AcceptanceContractErrorCode, label: string, max = 4_096, exact = false, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value === '') || Buffer.byteLength(value, 'utf8') > max) fail(code, `${label} is invalid`)
  if (value.includes('\0') || (!exact && (value !== value.normalize('NFC').trim()))) fail(code, `${label} is not canonical text`)
  return value
}
function id(value: unknown, code: AcceptanceContractErrorCode, label: string): string {
  const parsed = text(value, code, label, 256)
  if (!ID.test(parsed)) fail(code, `${label} is not an identifier`)
  return parsed
}
function digest(value: unknown, code: AcceptanceContractErrorCode, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(code, `${label} must be a lowercase SHA-256 digest`)
  return value
}
function positiveInteger(value: unknown, code: AcceptanceContractErrorCode, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) fail(code, `${label} is invalid`)
  return value
}
function timestamp(value: unknown, code: AcceptanceContractErrorCode, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code, `${label} is invalid`)
  return value
}
function array(value: unknown, code: AcceptanceContractErrorCode, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) {
    fail(code, `${label} has an invalid length`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code, `${label} has an unsafe shape`)
  const keys = Object.getOwnPropertyNames(value).filter(key => key !== 'length')
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    fail(code, `${label} has an unsafe shape`)
  }
  return value
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freeze((value as Record<PropertyKey, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** Deterministic JSON for bounded plain JSON data. */
export function acceptanceCanonicalJson(value: unknown): string {
  const active = new Set<object>()
  let nodes = 0
  const visit = (current: unknown, depth: number): string => {
    nodes += 1
    if (nodes > 4_096 || depth > 16) fail('invalid-contract', 'canonical JSON is too complex')
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return JSON.stringify(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || (Number.isInteger(current) && !Number.isSafeInteger(current))) {
        fail('invalid-contract', 'canonical JSON number is invalid')
      }
      return JSON.stringify(current)
    }
    if (typeof current !== 'object' || active.has(current)) fail('invalid-contract', 'canonical JSON contains an unsafe cycle or value')
    active.add(current)
    try {
      if (Array.isArray(current)) {
        array(current, 'invalid-contract', 'canonical JSON array', 0, 4_096)
        return `[${current.map(item => visit(item, depth + 1)).join(',')}]`
      }
      const object = record(current, 'invalid-contract', 'canonical JSON')
      const keys = Object.keys(object).sort()
      if (keys.some(key => UNSAFE.has(key))) fail('invalid-contract', 'canonical JSON contains an unsafe key')
      return `{${keys.map(key => `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`).join(',')}}`
    } finally { active.delete(current) }
  }
  const output = visit(value, 0)
  if (Buffer.byteLength(output, 'utf8') > MAX_CANONICAL_BYTES) {
    fail('invalid-contract', 'canonical JSON exceeds 1MiB serialization budget')
  }
  return output
}

export function acceptanceDigest(value: unknown): string {
  return createHash('sha256').update(acceptanceCanonicalJson(value)).digest('hex')
}

function scope(value: unknown, code: AcceptanceContractErrorCode): Readonly<{ workspace: string; preset: string }> {
  const item = record(value, code, 'scope'); exactKeys(item, ['workspace', 'preset'], code, 'scope')
  const workspace = text(item.workspace, code, 'scope workspace')
  if (!isAbsolute(workspace) || normalize(workspace) !== workspace || resolve(workspace) !== workspace) fail(code, 'scope workspace must be an absolute normalized path')
  const preset = text(item.preset, code, 'scope preset', 256)
  if (!PRESET.test(preset)) fail(code, 'scope preset is invalid')
  return freeze({ workspace, preset })
}
function owner(value: unknown, code: AcceptanceContractErrorCode): Readonly<{ principalRecordId: string; principalVersion: number }> {
  const item = record(value, code, 'owner'); exactKeys(item, ['principalRecordId', 'principalVersion'], code, 'owner')
  return freeze({ principalRecordId: id(item.principalRecordId, code, 'principalRecordId'), principalVersion: positiveInteger(item.principalVersion, code, 'principalVersion') })
}
function task(value: unknown, code: AcceptanceContractErrorCode): Readonly<{ kind: 'automation-run' | 'foreground-turn'; ref: string }> {
  const item = record(value, code, 'task'); exactKeys(item, ['kind', 'ref'], code, 'task')
  if (item.kind !== 'automation-run' && item.kind !== 'foreground-turn') fail(code, 'task kind is invalid')
  return freeze({ kind: item.kind, ref: id(item.ref, code, 'task ref') })
}
function authority(value: unknown, code: AcceptanceContractErrorCode): AuthorityRef {
  const item = record(value, code, 'authority'); exactKeys(item, ['id', 'digest'], code, 'authority')
  return freeze({ id: id(item.id, code, 'authority id'), digest: digest(item.digest, code, 'authority digest') })
}
function artifactPath(value: unknown, code: AcceptanceContractErrorCode): string {
  const path = text(value, code, 'artifactPath', 4_096)
  if (isAbsolute(path) || normalize(path) !== path || path === '.' || path.startsWith(`..${sep}`) || path === '..') fail(code, 'artifactPath must be a normalized relative path')
  return path
}
function json(value: unknown, code: AcceptanceContractErrorCode, depth = 0, state = { nodes: 0, active: new Set<object>() }): AcceptanceJsonValue {
  state.nodes += 1
  if (state.nodes > 4_096 || depth > 16) fail(code, 'JSON value is too complex')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail(code, 'JSON number is invalid')
    }
    return value
  }
  if (typeof value !== 'object' || state.active.has(value)) fail(code, 'JSON value is unsafe')
  state.active.add(value)
  try {
    if (Array.isArray(value)) {
      const entries = array(value, code, 'JSON array', 0, 4_096)
      return freeze(entries.map(item => json(item, code, depth + 1, state)))
    }
    const item = record(value, code, 'JSON object'); const keys = Object.keys(item)
    if (keys.some(key => UNSAFE.has(key))) fail(code, 'JSON object contains an unsafe key')
    return freeze(Object.fromEntries(keys.sort().map(key => [key, json(item[key], code, depth + 1, state)])))
  } finally { state.active.delete(value) }
}
function criterion(value: unknown, code: AcceptanceContractErrorCode, budget: { used: number; jsonUsed: number }): AcceptanceCriterion {
  const item = record(value, code, 'criterion')
  const addText = (input: unknown, label: string, maximum = MAX_TEXT_BYTES, exact = false, allowEmpty = false): string => {
    const output = text(input, code, label, maximum, exact, allowEmpty); budget.used += Buffer.byteLength(output, 'utf8')
    if (budget.used > MAX_TEXT_BYTES) fail(code, 'criterion text exceeds 64KiB total budget')
    return output
  }
  if (item.kind === 'process-behavior') {
    exactKeys(item, ['id', 'kind', 'authority', 'artifactPath', 'stdin', 'expectedStdout', 'expectedExitCode'], code, 'process criterion')
    const exit = item.expectedExitCode
    if (typeof exit !== 'number' || !Number.isSafeInteger(exit) || exit < 0 || exit > 255) fail(code, 'expectedExitCode is invalid')
    return freeze({ id: id(item.id, code, 'criterion id'), kind: 'process-behavior', authority: authority(item.authority, code), artifactPath: artifactPath(item.artifactPath, code), stdin: addText(item.stdin, 'stdin', MAX_TEXT_BYTES, true, true), expectedStdout: addText(item.expectedStdout, 'expectedStdout', MAX_TEXT_BYTES, true, true), expectedExitCode: exit })
  }
  if (item.kind === 'document-citations') {
    exactKeys(item, ['id', 'kind', 'authority', 'artifactPath', 'requiredText', 'quotes'], code, 'document criterion')
    const requiredText = array(item.requiredText, code, 'requiredText', 0, 128).map((entry, index) => addText(entry, `requiredText[${index}]`, MAX_TEXT_BYTES, true))
    const quotes = array(item.quotes, code, 'quotes', 0, 128).map((entry, index) => {
      const quote = record(entry, code, 'quote'); exactKeys(quote, ['quote', 'sourceId', 'sourceSha256'], code, 'quote')
      return freeze({ quote: addText(quote.quote, `quotes[${index}].quote`, MAX_TEXT_BYTES, true), sourceId: id(quote.sourceId, code, 'quote sourceId'), sourceSha256: digest(quote.sourceSha256, code, 'quote sourceSha256') })
    })
    if (requiredText.length === 0 && quotes.length === 0) fail(code, 'document criterion needs a measurable clause')
    return freeze({ id: id(item.id, code, 'criterion id'), kind: 'document-citations', authority: authority(item.authority, code), artifactPath: artifactPath(item.artifactPath, code), requiredText: freeze(requiredText), quotes: freeze(quotes) })
  }
  if (item.kind === 'target-readback') {
    exactKeys(item, Object.hasOwn(item, 'expectedRevision') ? ['id', 'kind', 'authority', 'objectId', 'expected', 'expectedRevision'] : ['id', 'kind', 'authority', 'objectId', 'expected'], code, 'target criterion')
    const expected = array(item.expected, code, 'expected', 1, 128).map(entry => {
      const expectation = record(entry, code, 'readback expectation'); exactKeys(expectation, ['pointer', 'value'], code, 'readback expectation')
      const pointer = text(expectation.pointer, code, 'JSON pointer', 4_096, true, true)
      if (pointer !== '' && (!pointer.startsWith('/') || /~(?:[^01]|$)/u.test(pointer) || pointer.split('/').slice(1).some(part => ['__proto__', 'prototype', 'constructor'].includes(part.replace(/~1/g, '/').replace(/~0/g, '~'))))) fail(code, 'JSON pointer is invalid')
      const value = json(expectation.value, code)
      const valueBytes = Buffer.byteLength(acceptanceCanonicalJson(value), 'utf8')
      if (valueBytes > MAX_TEXT_BYTES) fail(code, 'JSON value is too large')
      budget.jsonUsed += valueBytes
      if (budget.jsonUsed > MAX_TEXT_BYTES) fail(code, 'JSON expectations exceed 64KiB total budget')
      return freeze({ pointer, value })
    })
    const base = { id: id(item.id, code, 'criterion id'), kind: 'target-readback' as const, authority: authority(item.authority, code), objectId: id(item.objectId, code, 'objectId'), expected: freeze(expected) }
    return freeze(Object.hasOwn(item, 'expectedRevision') ? { ...base, expectedRevision: id(item.expectedRevision, code, 'expectedRevision') } : base)
  }
  fail(code, 'criterion kind is invalid')
}
function contractPayload(value: unknown, code: AcceptanceContractErrorCode): TaskAcceptanceContractInput {
  const item = record(value, code, 'contract')
  exactKeys(item, ['protocol', 'id', 'scope', 'owner', 'task', 'objective', 'profile', 'issuedAt', 'expiresAt', 'criteria', 'bounds'], code, 'contract')
  if (item.protocol !== 'task-acceptance/v1') fail(code, 'contract protocol is invalid')
  const issuedAt = timestamp(item.issuedAt, code, 'issuedAt'); const expiresAt = timestamp(item.expiresAt, code, 'expiresAt')
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 7 * 24 * 60 * 60 * 1_000) fail(code, 'contract validity is invalid')
  const profile = record(item.profile, code, 'profile'); exactKeys(profile, ['id', 'version', 'digest'], code, 'profile')
  const bounds = record(item.bounds, code, 'bounds'); exactKeys(bounds, ['maxDurationMs', 'maxEvidenceBytes'], code, 'bounds')
  const criteria = array(item.criteria, code, 'criteria', 1, 32); const budget = { used: 0, jsonUsed: 0 }
  const parsedCriteria = criteria.map(entry => criterion(entry, code, budget)); const ids = new Set(parsedCriteria.map(entry => entry.id))
  if (ids.size !== parsedCriteria.length) fail(code, 'criterion ids must be unique')
  const objective = text(item.objective, code, 'objective', 8_192, true)
  return freeze({ protocol: 'task-acceptance/v1', id: id(item.id, code, 'contract id'), scope: scope(item.scope, code), owner: owner(item.owner, code), task: task(item.task, code), objective, profile: freeze({ id: id(profile.id, code, 'profile id'), version: positiveInteger(profile.version, code, 'profile version'), digest: digest(profile.digest, code, 'profile digest') }), issuedAt, expiresAt, criteria: freeze(parsedCriteria), bounds: freeze({ maxDurationMs: positiveInteger(bounds.maxDurationMs, code, 'maxDurationMs', 300_000), maxEvidenceBytes: positiveInteger(bounds.maxEvidenceBytes, code, 'maxEvidenceBytes', 1_048_576) }) })
}

export function createTaskAcceptanceContract(input: unknown): TaskAcceptanceContract {
  const payload = contractPayload(input, 'invalid-contract')
  if (Buffer.byteLength(acceptanceCanonicalJson(payload), 'utf8') > MAX_CONTRACT_BYTES) {
    fail('invalid-contract', 'contract exceeds 256KiB overall bound')
  }
  return freeze({ ...payload, digest: acceptanceDigest(payload) })
}
export function validateTaskAcceptanceContract(value: unknown): TaskAcceptanceContract {
  const item = record(value, 'invalid-contract', 'contract')
  exactKeys(item, ['protocol', 'id', 'scope', 'owner', 'task', 'objective', 'profile', 'issuedAt', 'expiresAt', 'criteria', 'bounds', 'digest'], 'invalid-contract', 'contract')
  const { digest: supplied, ...payload } = item
  const result = createTaskAcceptanceContract(payload)
  if (digest(supplied, 'invalid-contract', 'contract digest') !== result.digest) fail('invalid-contract', 'contract digest is stale')
  return result
}

function result(value: unknown, code: AcceptanceContractErrorCode): CriterionResult {
  const item = record(value, code, 'criterion result')
  exactKeys(item, Object.hasOwn(item, 'artifactDigest') ? ['criterionId', 'status', 'reason', 'evidence', 'artifactDigest'] : ['criterionId', 'status', 'reason', 'evidence'], code, 'criterion result')
  if (item.status !== 'passed' && item.status !== 'failed' && item.status !== 'unknown') fail(code, 'criterion result status is invalid')
  const reason = text(item.reason, code, 'criterion result reason', 128)
  if (!REASON.test(reason)) fail(code, 'criterion result reason must be kebab-case')
  const evidence = array(item.evidence, code, 'evidence', 0, 32).map(entry => {
    const evidenceItem = record(entry, code, 'evidence'); exactKeys(evidenceItem, ['kind', 'ref', 'digest'], code, 'evidence')
    return freeze({ kind: id(evidenceItem.kind, code, 'evidence kind'), ref: text(evidenceItem.ref, code, 'evidence ref', 4_096), digest: digest(evidenceItem.digest, code, 'evidence digest') })
  })
  const base = { criterionId: id(item.criterionId, code, 'criterionId'), status: item.status, reason, evidence: freeze(evidence) } as const
  return freeze(Object.hasOwn(item, 'artifactDigest') ? { ...base, artifactDigest: digest(item.artifactDigest, code, 'artifactDigest') } : base) as CriterionResult
}
function equalJson(left: unknown, right: unknown): boolean { return acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right) }
function derive(results: readonly CriterionResult[]): 'achieved' | 'not-achieved' | 'unknown' {
  if (results.some(entry => entry.status === 'failed')) return 'not-achieved'
  return results.every(entry => entry.status === 'passed') ? 'achieved' : 'unknown'
}
function receiptPayload(contract: TaskAcceptanceContract, value: unknown, code: AcceptanceContractErrorCode): TaskVerificationReceiptInput {
  const item = record(value, code, 'receipt')
  exactKeys(item, ['protocol', 'id', 'contractId', 'contractDigest', 'scope', 'owner', 'task', 'results', 'startedAt', 'completedAt', 'validUntil'], code, 'receipt')
  if (item.protocol !== 'task-verification/v1') fail(code, 'receipt protocol is invalid')
  if (id(item.contractId, code, 'contractId') !== contract.id || digest(item.contractDigest, code, 'contractDigest') !== contract.digest || !equalJson(scope(item.scope, code), contract.scope) || !equalJson(owner(item.owner, code), contract.owner) || !equalJson(task(item.task, code), contract.task)) fail(code, 'receipt identity does not bind the contract')
  const startedAt = timestamp(item.startedAt, code, 'startedAt'); const completedAt = timestamp(item.completedAt, code, 'completedAt'); const validUntil = timestamp(item.validUntil, code, 'validUntil')
  if (startedAt < contract.issuedAt || completedAt < startedAt || completedAt > contract.expiresAt || validUntil < completedAt || validUntil > contract.expiresAt) fail(code, 'receipt time is outside contract validity')
  const results = array(item.results, code, 'results', contract.criteria.length, contract.criteria.length).map(entry => result(entry, code))
  const allowed = new Set(contract.criteria.map(entry => entry.id)); const ids = new Set(results.map(entry => entry.criterionId))
  if (ids.size !== results.length || results.some(entry => !allowed.has(entry.criterionId))) fail(code, 'receipt criterion set does not bind the contract')
  const evidenceBytes = Buffer.byteLength(acceptanceCanonicalJson(results.map(entry => entry.evidence)), 'utf8')
  if (evidenceBytes > contract.bounds.maxEvidenceBytes) fail(code, 'receipt evidence exceeds contract maxEvidenceBytes')
  return freeze({ protocol: 'task-verification/v1', id: id(item.id, code, 'receipt id'), contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task, results: freeze(results), startedAt, completedAt, validUntil })
}
export function createTaskVerificationReceipt(contract: TaskAcceptanceContract, input: unknown): TaskVerificationReceipt {
  const validContract = validateTaskAcceptanceContract(contract)
  const payload = receiptPayload(validContract, input, 'invalid-receipt')
  const objectiveStatus = derive(payload.results)
  const digestPayload = { ...payload, objectiveStatus }
  if (Buffer.byteLength(acceptanceCanonicalJson(digestPayload), 'utf8') > MAX_RECEIPT_BYTES) {
    fail('invalid-receipt', 'receipt exceeds 1MiB overall bound')
  }
  return freeze({ ...payload, objectiveStatus, digest: acceptanceDigest(digestPayload) })
}
export function validateTaskVerificationReceipt(contract: TaskAcceptanceContract, value: unknown): TaskVerificationReceipt {
  const item = record(value, 'invalid-receipt', 'receipt')
  exactKeys(item, ['protocol', 'id', 'contractId', 'contractDigest', 'scope', 'owner', 'task', 'results', 'startedAt', 'completedAt', 'validUntil', 'objectiveStatus', 'digest'], 'invalid-receipt', 'receipt')
  const objectiveStatus = item.objectiveStatus
  if (objectiveStatus !== 'achieved' && objectiveStatus !== 'not-achieved' && objectiveStatus !== 'unknown') fail('invalid-receipt', 'receipt objectiveStatus is invalid')
  const { objectiveStatus: _ignored, digest: supplied, ...payload } = item
  const output = createTaskVerificationReceipt(contract, payload)
  if (objectiveStatus !== output.objectiveStatus) fail('invalid-receipt', 'receipt objectiveStatus is not derived from results')
  if (digest(supplied, 'invalid-receipt', 'receipt digest') !== output.digest) fail('invalid-receipt', 'receipt digest is stale')
  return output
}
