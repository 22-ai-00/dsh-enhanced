import { createHash, createPrivateKey, createPublicKey, KeyObject, randomUUID, sign, verify } from 'node:crypto'
import { generatorDigest, verifyProspectiveCertificate, type ProspectiveHoldoutCertificate } from './prospective-holdout.js'

export type HoldoutCaseKind = 'replay' | 'evaluation' | 'regression'
export type CellVerdict = 'achieved' | 'not-achieved' | 'unknown'
export type ObservationStatus = 'completed' | 'failed' | 'unknown'
export type StopReason = 'expired' | 'recovered-outstanding' | 'non-quiescent' | 'execution-unknown'

export interface HoldoutCase {
  readonly id: string
  readonly kind: HoldoutCaseKind
  readonly stdin: string
  readonly expectedStdout: string
  readonly expectedExitCode: number
}

export interface HoldoutDataset {
  readonly id: string
  readonly version: string
  readonly cases: readonly HoldoutCase[]
}

export interface QualificationBinding {
  readonly scopeDigest: string
  readonly baselineDigest: string
  readonly candidateDigest: string
  readonly budgetDigest: string
  readonly expiresAt: number
  readonly repeats: number
}

export interface HoldoutLimits {
  readonly maxToolCalls: number
  readonly maxOutputBytes: number
}

export interface ToolCall {
  readonly name: string
  readonly inputDigest: string
  readonly outputDigest?: string
}

export interface CellObservation {
  readonly cellId: string
  readonly armDigest: string
  readonly stdout: string
  readonly exitCode: number | null
  readonly quiescent: boolean
  readonly status: ObservationStatus
  readonly artifactDigest: string
  readonly toolCalls: readonly ToolCall[]
}

export interface BeginResult {
  readonly sessionId: string
  readonly planDigest: string
  readonly datasetDigest: string
  readonly publicKey: string
  readonly scopeDigest: string
  readonly baselineDigest: string
  readonly candidateDigest: string
  readonly budgetDigest: string
  readonly expiresAt: number
  readonly repeats: number
  readonly limits: HoldoutLimits
  readonly cellCount: number
  /** Present only for a prospective dataset generated after the binding was frozen. */
  readonly prospective?: ProspectiveHoldoutCertificate
}

export interface SignedCell {
  readonly sessionId: string
  readonly planDigest: string
  readonly cellId: string
  readonly armDigest: string
  readonly stdin: string
  readonly signature: string
}

export interface PublicCellVerdict {
  readonly cellId: string
  readonly armDigest: string
  readonly caseId: string
  readonly kind: HoldoutCaseKind
  readonly repeat: number
  readonly verdict: CellVerdict
  readonly observationDigest?: string
}

export interface HoldoutReceipt extends BeginResult {
  /** False means one or more cells were made unknown by expiry, recovery, or non-quiescence. */
  readonly complete: boolean
  readonly stoppedReason?: StopReason
  readonly cellVerdicts: readonly PublicCellVerdict[]
  readonly observationDigest: string
  readonly signature: string
}

export interface AuthorityOptions {
  readonly dataset: HoldoutDataset
  readonly privateKey: KeyObject | string | Buffer
  readonly limits: HoldoutLimits
  readonly prospective?: ProspectiveHoldoutCertificate
  /** Deterministic clock hook for tests; production callers should omit it. */
  readonly now?: () => number
}

interface CellState {
  readonly cellId: string
  readonly armDigest: string
  readonly caseId: string
  readonly kind: HoldoutCaseKind
  readonly repeat: number
  verdict?: CellVerdict
  observationDigest?: string
  issued: boolean
}

interface PersistedState {
  readonly version: 1
  readonly datasetDigest: string
  readonly publicKey: string
  readonly createdAt: number
  readonly limits: HoldoutLimits
  readonly begin?: BeginResult
  readonly cells: readonly CellState[]
  readonly stopped: boolean
  readonly stoppedReason?: StopReason
}

interface SignedState { readonly state: PersistedState; readonly signature: string }

const digestPattern = /^[a-f0-9]{64}$/u
const kinds: readonly HoldoutCaseKind[] = ['replay', 'evaluation', 'regression']
const maxStringBytes = 256 * 1024

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }
function signature(payload: unknown, privateKey: AuthorityOptions['privateKey']): string {
  return sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url')
}
function validDigest(value: unknown): value is string { return typeof value === 'string' && digestPattern.test(value) }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`holdout-authority: ${message}`) }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return required.every(key => Object.hasOwn(descriptors, key)) && Object.entries(descriptors).every(([key, descriptor]) => (required.includes(key) || optional.includes(key)) && descriptor.enumerable && 'value' in descriptor)
}

function validateLimits(limits: HoldoutLimits): void {
  assert(exact(limits, ['maxToolCalls', 'maxOutputBytes']), 'limits shape is invalid')
  assert(Number.isInteger(limits.maxToolCalls) && limits.maxToolCalls >= 1 && limits.maxToolCalls <= 32, 'maxToolCalls must be an integer from 1 to 32')
  assert(Number.isInteger(limits.maxOutputBytes) && limits.maxOutputBytes >= 0 && limits.maxOutputBytes <= 262144, 'maxOutputBytes must be an integer no greater than 262144')
}

function validateDataset(dataset: HoldoutDataset, limits: HoldoutLimits): void {
  assert(exact(dataset, ['id', 'version', 'cases']), 'dataset shape is invalid')
  assert(dataset && typeof dataset.id === 'string' && dataset.id.length > 0 && dataset.id.length <= 128, 'dataset id is invalid')
  assert(typeof dataset.version === 'string' && dataset.version.length > 0 && dataset.version.length <= 128, 'dataset version is invalid')
  assert(Array.isArray(dataset.cases) && dataset.cases.length >= 3 && dataset.cases.length <= 12, 'dataset requires 3 to 12 cases')
  const ids = new Set<string>(); const seenKinds = new Set<HoldoutCaseKind>(); let total = byteLength(dataset.id) + byteLength(dataset.version)
  for (const item of dataset.cases) {
    assert(exact(item, ['id', 'kind', 'stdin', 'expectedStdout', 'expectedExitCode']), 'case shape is invalid')
    assert(item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128 && !ids.has(item.id), 'case ids must be unique bounded strings')
    ids.add(item.id); assert(kinds.includes(item.kind), 'case kind is invalid'); seenKinds.add(item.kind)
    assert(typeof item.stdin === 'string' && typeof item.expectedStdout === 'string', 'case input and expected output must be strings')
    assert(Number.isInteger(item.expectedExitCode) && item.expectedExitCode >= 0 && item.expectedExitCode <= 255, 'expected exit code must be an integer from 0 to 255')
    assert(byteLength(item.expectedStdout) <= limits.maxOutputBytes, 'expected output exceeds maxOutputBytes')
    total += byteLength(item.id) + byteLength(item.stdin) + byteLength(item.expectedStdout)
  }
  assert(seenKinds.size === kinds.length, 'dataset must contain replay, evaluation, and regression cases')
  assert(total <= maxStringBytes, 'dataset strings exceed 256KiB')
}

function validateBinding(binding: QualificationBinding, now: number): void {
  assert(exact(binding, ['scopeDigest', 'baselineDigest', 'candidateDigest', 'budgetDigest', 'expiresAt', 'repeats']), 'binding shape is invalid')
  for (const value of [binding.scopeDigest, binding.baselineDigest, binding.candidateDigest, binding.budgetDigest]) assert(validDigest(value), 'binding digests must be lowercase SHA-256 hex')
  assert(Number.isInteger(binding.repeats) && binding.repeats >= 2 && binding.repeats <= 4, 'repeats must be an integer from 2 to 4')
  assert(Number.isSafeInteger(binding.expiresAt) && binding.expiresAt > now && binding.expiresAt <= now + 7 * 24 * 60 * 60 * 1000, 'expiresAt must be a future timestamp within seven days')
}

/** A synchronous, stateful authority. It has no Cordis dependency and never claims an OS seal or promotion authority. */
export class HoldoutAuthority {
  readonly #dataset: HoldoutDataset
  readonly #datasetDigest: string
  readonly #privateKey: KeyObject
  readonly #publicKey: string
  readonly #limits: HoldoutLimits
  readonly #prospective?: ProspectiveHoldoutCertificate
  readonly #now: () => number
  #createdAt: number
  #begin?: BeginResult
  #cells: CellState[] = []
  #stopped = false
  #stoppedReason?: StopReason

  private constructor(options: AuthorityOptions) {
    validateLimits(options.limits); validateDataset(options.dataset, options.limits)
    this.#dataset = structuredClone(options.dataset)
    this.#datasetDigest = sha256(this.#dataset)
    this.#privateKey = options.privateKey instanceof KeyObject ? options.privateKey : createPrivateKey(options.privateKey)
    assert(this.#privateKey.type === 'private' && this.#privateKey.asymmetricKeyType === 'ed25519', 'private key must be Ed25519')
    this.#publicKey = createPublicKey(this.#privateKey).export({ format: 'pem', type: 'spki' }).toString()
    this.#limits = Object.freeze({ ...options.limits })
    if (options.prospective !== undefined) {
      assert(verifyProspectiveCertificate(options.prospective, options.prospective.binding, this.#publicKey, generatorDigest), 'prospective certificate is invalid')
      assert(options.prospective.datasetDigest === this.#datasetDigest, 'prospective certificate dataset does not match')
      this.#prospective = Object.freeze(structuredClone(options.prospective))
    }
    this.#now = options.now ?? Date.now
    this.#createdAt = this.#now()
  }

  static create(options: AuthorityOptions): HoldoutAuthority { return new HoldoutAuthority(options) }

  /** Public operator pins; inspecting them does not issue a cell or create a qualification. */
  metadata(): Readonly<{ publicKey: string; datasetDigest: string; limits: HoldoutLimits }> {
    return Object.freeze({ publicKey: this.#publicKey, datasetDigest: this.#datasetDigest, limits: this.#limits })
  }

  static restore(serialized: string, options: AuthorityOptions): HoldoutAuthority {
    assert(typeof serialized === 'string' && byteLength(serialized) <= 1024 * 1024, 'serialized state is invalid')
    let parsed: SignedState
    try { parsed = JSON.parse(serialized) as SignedState } catch { throw new Error('holdout-authority: serialized state is invalid JSON') }
    assert(parsed && parsed.state && typeof parsed.signature === 'string', 'serialized state is malformed')
    const authority = new HoldoutAuthority(options)
    assert(parsed.state.version === 1 && parsed.state.datasetDigest === authority.#datasetDigest && parsed.state.publicKey === authority.#publicKey && canonical(parsed.state.limits) === canonical(authority.#limits), 'serialized state does not match operator dataset, key, or limits')
    assert(verify(null, Buffer.from(canonical(parsed.state)), createPublicKey(options.privateKey), Buffer.from(parsed.signature, 'base64url')), 'serialized state signature is invalid')
    if (parsed.state.begin) authority.#begin = parsed.state.begin
    authority.#cells = parsed.state.cells.map(cell => ({ ...cell }))
    authority.#stopped = parsed.state.stopped
    if (parsed.state.stoppedReason) authority.#stoppedReason = parsed.state.stoppedReason
    assert(Number.isSafeInteger(parsed.state.createdAt), 'serialized creation timestamp is invalid')
    authority.#createdAt = parsed.state.createdAt
    authority.validateRestoredState()
    // An issued cell could have run while the authority was down. It is never reissued or accepted after recovery.
    const hadOutstanding = authority.#cells.some(cell => cell.issued && !cell.verdict)
    for (const cell of authority.#cells) if (cell.issued && !cell.verdict) cell.verdict = 'unknown'
    if (hadOutstanding) authority.expireOutstanding('recovered-outstanding')
    return authority
  }

  begin(binding: QualificationBinding): BeginResult {
    assert(!this.#begin, 'qualification has already begun')
    assert(binding?.expiresAt > this.#now(), 'expiresAt must be a finite future timestamp')
    validateBinding(binding, this.#createdAt)
    const sessionId = randomUUID()
    const cells: CellState[] = []
    let index = 0
    for (let repeat = 1; repeat <= binding.repeats; repeat++) for (const item of this.#dataset.cases) {
      const arms = (index++ % 2 === 0) ? [binding.baselineDigest, binding.candidateDigest] : [binding.candidateDigest, binding.baselineDigest]
      for (const armDigest of arms) cells.push({ cellId: `cell-${cells.length + 1}`, armDigest, caseId: item.id, kind: item.kind, repeat, issued: false })
    }
    assert(binding.baselineDigest !== binding.candidateDigest, 'baseline and candidate digests must differ')
    const planDigest = sha256({ sessionId, datasetDigest: this.#datasetDigest, binding, limits: this.#limits, cells: cells.map(({ cellId, armDigest, caseId, kind, repeat }) => ({ cellId, armDigest, caseId, kind, repeat })) })
    if (this.#prospective) assert(verifyProspectiveCertificate(this.#prospective, binding, this.#publicKey, generatorDigest), 'prospective certificate binding does not match')
    this.#begin = Object.freeze({ sessionId, planDigest, datasetDigest: this.#datasetDigest, publicKey: this.#publicKey, ...binding, limits: this.#limits, cellCount: cells.length, ...(this.#prospective ? { prospective: this.#prospective } : {}) })
    this.#cells = cells
    return { ...this.#begin }
  }

  next(): SignedCell | undefined {
    this.assertBegun(); if (this.#stopped || this.#now() >= this.#begin!.expiresAt) { this.expireOutstanding('expired'); return undefined }
    assert(!this.#cells.some(item => item.issued && !item.verdict), 'an issued cell must be settled before requesting another')
    const cell = this.#cells.find(item => !item.issued && !item.verdict)
    if (!cell) return undefined
    cell.issued = true
    const stdin = this.caseFor(cell).stdin
    const unsigned = { sessionId: this.#begin!.sessionId, planDigest: this.#begin!.planDigest, cellId: cell.cellId, armDigest: cell.armDigest, stdin }
    return { ...unsigned, signature: signature(unsigned, this.#privateKey) }
  }

  record(observation: CellObservation): CellVerdict {
    this.assertBegun(); assert(!this.#stopped, 'qualification is stopped')
    if (this.#now() >= this.#begin!.expiresAt) { this.expireOutstanding('expired'); throw new Error('holdout-authority: qualification has expired') }
    this.validateObservation(observation)
    const cell = this.#cells.find(item => item.cellId === observation.cellId)
    assert(cell && cell.issued, 'cell was not issued')
    assert(!cell.verdict, 'cell has already been settled')
    assert(cell.armDigest === observation.armDigest, 'cell arm digest does not match')
    const expected = this.caseFor(cell)
    const verdict: CellVerdict = !observation.quiescent || observation.status === 'unknown' || observation.exitCode === null
      ? 'unknown'
      : observation.stdout === expected.expectedStdout && observation.exitCode === expected.expectedExitCode ? 'achieved' : 'not-achieved'
    cell.verdict = verdict
    cell.observationDigest = sha256({ cellId: observation.cellId, armDigest: observation.armDigest, stdout: observation.stdout, exitCode: observation.exitCode, quiescent: observation.quiescent, status: observation.status, artifactDigest: observation.artifactDigest, toolCalls: observation.toolCalls })
    if (verdict === 'unknown') this.expireOutstanding(!observation.quiescent ? 'non-quiescent' : 'execution-unknown')
    return verdict
  }

  finish(): HoldoutReceipt {
    this.assertBegun(); if (this.#now() >= this.#begin!.expiresAt) this.expireOutstanding('expired')
    assert(this.#cells.every(cell => !!cell.verdict), 'all cells must be terminal before finish')
    const cellVerdicts = this.#cells.map(({ cellId, armDigest, caseId, kind, repeat, verdict, observationDigest }) => ({ cellId, armDigest, caseId, kind, repeat, verdict: verdict!, ...(observationDigest ? { observationDigest } : {}) }))
    const observationDigest = sha256(cellVerdicts.map(cell => ({ cellId: cell.cellId, observationDigest: cell.observationDigest ?? null, verdict: cell.verdict })))
    const unsigned = { ...this.#begin!, complete: !cellVerdicts.some(cell => cell.verdict === 'unknown'), ...(this.#stoppedReason ? { stoppedReason: this.#stoppedReason } : {}), cellVerdicts, observationDigest }
    return { ...unsigned, signature: signature(unsigned, this.#privateKey) }
  }

  serialize(): string {
    const state: PersistedState = { version: 1, datasetDigest: this.#datasetDigest, publicKey: this.#publicKey, createdAt: this.#createdAt, limits: this.#limits, ...(this.#begin ? { begin: this.#begin } : {}), cells: this.#cells, stopped: this.#stopped, ...(this.#stoppedReason ? { stoppedReason: this.#stoppedReason } : {}) }
    return canonical({ state, signature: signature(state, this.#privateKey) })
  }

  private validateRestoredState(): void {
    if (!this.#begin) { assert(this.#cells.length === 0 && !this.#stopped && !this.#stoppedReason, 'unbegun serialized state is inconsistent'); return }
    validateBinding({ scopeDigest: this.#begin.scopeDigest, baselineDigest: this.#begin.baselineDigest, candidateDigest: this.#begin.candidateDigest, budgetDigest: this.#begin.budgetDigest, expiresAt: this.#begin.expiresAt, repeats: this.#begin.repeats }, this.#createdAt)
    assert(this.#begin.baselineDigest !== this.#begin.candidateDigest && this.#begin.datasetDigest === this.#datasetDigest && this.#begin.publicKey === this.#publicKey && canonical(this.#begin.limits) === canonical(this.#limits), 'restored qualification binding is invalid')
    if (this.#prospective) assert(this.#begin.prospective && verifyProspectiveCertificate(this.#begin.prospective, { scopeDigest: this.#begin.scopeDigest, baselineDigest: this.#begin.baselineDigest, candidateDigest: this.#begin.candidateDigest, budgetDigest: this.#begin.budgetDigest, expiresAt: this.#begin.expiresAt, repeats: this.#begin.repeats }, this.#publicKey, generatorDigest), 'restored prospective certificate is invalid')
    else assert(this.#begin.prospective === undefined, 'restored prospective certificate is inconsistent')
    const expectedCount = this.#dataset.cases.length * this.#begin.repeats * 2
    assert(this.#cells.length === expectedCount && this.#begin.cellCount === expectedCount, 'restored cell count is invalid')
    const seen = new Set<string>()
    for (const cell of this.#cells) {
      assert(!seen.has(cell.cellId) && /^cell-[1-9][0-9]*$/u.test(cell.cellId) && validDigest(cell.armDigest) && this.#dataset.cases.some(item => item.id === cell.caseId) && kinds.includes(cell.kind) && Number.isInteger(cell.repeat) && cell.repeat >= 1 && cell.repeat <= this.#begin.repeats && typeof cell.issued === 'boolean' && (cell.verdict === undefined || ['achieved', 'not-achieved', 'unknown'].includes(cell.verdict)), 'restored cell is invalid')
      seen.add(cell.cellId)
    }
    const planDigest = sha256({ sessionId: this.#begin.sessionId, datasetDigest: this.#datasetDigest, binding: { scopeDigest: this.#begin.scopeDigest, baselineDigest: this.#begin.baselineDigest, candidateDigest: this.#begin.candidateDigest, budgetDigest: this.#begin.budgetDigest, expiresAt: this.#begin.expiresAt, repeats: this.#begin.repeats }, limits: this.#limits, cells: this.#cells.map(({ cellId, armDigest, caseId, kind, repeat }) => ({ cellId, armDigest, caseId, kind, repeat })) })
    assert(planDigest === this.#begin.planDigest, 'restored plan digest is invalid')
  }

  private validateObservation(observation: CellObservation): void {
    assert(exact(observation, ['cellId', 'armDigest', 'stdout', 'exitCode', 'quiescent', 'status', 'artifactDigest', 'toolCalls']), 'observation shape is invalid')
    assert(observation && typeof observation.cellId === 'string' && /^cell-[1-9][0-9]*$/u.test(observation.cellId) && validDigest(observation.armDigest), 'observation cell identity is invalid')
    assert(typeof observation.stdout === 'string' && byteLength(observation.stdout) <= this.#limits.maxOutputBytes, 'observation stdout exceeds maxOutputBytes')
    assert((observation.exitCode === null || (Number.isInteger(observation.exitCode) && observation.exitCode >= 0 && observation.exitCode <= 255)) && typeof observation.quiescent === 'boolean' && ['completed', 'failed', 'unknown'].includes(observation.status), 'observation execution status is invalid')
    assert(validDigest(observation.artifactDigest), 'observation artifact digest is invalid')
    assert(Array.isArray(observation.toolCalls) && observation.toolCalls.length <= this.#limits.maxToolCalls, 'observation tool calls exceed maxToolCalls')
    let total = byteLength(observation.stdout)
    for (const call of observation.toolCalls) {
      assert(exact(call, ['name', 'inputDigest'], ['outputDigest']), 'tool observation shape is invalid')
      assert(call && typeof call.name === 'string' && call.name.length > 0 && call.name.length <= 128 && validDigest(call.inputDigest) && (call.outputDigest === undefined || validDigest(call.outputDigest)), 'observation tool call is invalid')
      total += byteLength(call.name) + byteLength(call.inputDigest) + (call.outputDigest ? byteLength(call.outputDigest) : 0)
    }
    assert(total <= maxStringBytes, 'observation strings exceed 256KiB')
  }

  private caseFor(cell: CellState): HoldoutCase { return this.#dataset.cases.find(item => item.id === cell.caseId)! }
  private assertBegun(): void { assert(this.#begin, 'qualification has not begun') }
  private expireOutstanding(reason: StopReason): void { for (const cell of this.#cells) if (!cell.verdict) cell.verdict = 'unknown'; this.#stopped = true; this.#stoppedReason ??= reason }
}

/** Verifies a signed next-cell or receipt payload with the public key emitted by begin. */
export function verifyHoldoutSignature(payload: Record<string, unknown>, publicKey: string): boolean {
  const { signature: value, ...unsigned } = payload
  return typeof value === 'string' && typeof publicKey === 'string' && verify(null, Buffer.from(canonical(unsigned)), publicKey, Buffer.from(value, 'base64url'))
}
