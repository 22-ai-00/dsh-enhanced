import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AnySourceGrowthRunBinding, PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { LinuxCgroupRoots, LinuxRunnerStateSeal, NativeMacRuntime } from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { CreationCapabilitySourceSnapshot } from './creation-capability-source.js'

export type CreationCapabilityOwner = Pick<SourceJobOwnerReceipt, 'authorityId' | 'authorityHash' | 'principalId'
  | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>

/** Separate owner authority for adoption and ordinary use; never a verifier policy. */
export interface CreationCapabilityConfig {
  /** Explicit new authority for work-item engineering sources; false canonicalizes to absent. */
  workItemFailures?: boolean
  authorityId: string
  keyId: string
  keyPath: string
  owner: CreationCapabilityOwner
  namePrefix: string
  expiresAt: number
  maxAdoptions: number
  maxTools: number
  maxCallsPerAdoption: number
  maxCallRecords: number
  maxInputBytes: number
  /** Opt-in lifetime for an already adopted capability; never extends either use grant. */
  retention?: { maximumLifetimeMs: number }
  runner: {
    stateRoot: string
    image: string
    dockerPath: string
    socketPath?: string
    expiresAt: number
    maxRuns: number
    maxTotalDurationMs: number
    maxDurationMs: number
    maxOutputBytes: number
  } | {
    backend: 'linux-native'
    runtime: LinuxPluginBehaviorRuntime
    cgroupRoots: LinuxCgroupRoots
    stateSeal?: LinuxRunnerStateSeal
    stateRoot: string
    expiresAt: number
    maxRuns: number
    maxTotalDurationMs: number
    maxDurationMs: number
    maxOutputBytes: number
  } | {
    backend: 'macos-seatbelt'
    runtime: NativeMacRuntime
    stateRoot: string
    expiresAt: number
    maxRuns: number
    maxTotalDurationMs: number
    maxDurationMs: number
    maxOutputBytes: number
  }
}

export interface CreationCapabilityTool {
  originalName: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CreationCapabilityReceipt {
  protocol: 'dsh-created-capability-adoption/v1' | 'dsh-created-capability-adoption/v2'
  authorityId: string
  authorityDigest: string
  keyId: string
  planId: string
  planDigest: string
  verificationDigest: string
  artifactSha256: string
  artifactBytes: number
  source: PluginCreationVerificationCertificate['source']
  schemaDigest: string
  toolsDigest: string
  expiresAt: number
  adoptedAt: number
  signature: string
}

export interface CreationCapabilityRecord {
  planId: string
  status: 'claimed' | 'authorized' | 'active' | 'closed' | 'unknown' | 'rejected'
  receipt?: CreationCapabilityReceipt
  certificate: PluginCreationVerificationCertificate
  tools?: readonly CreationCapabilityTool[]
  artifact: Buffer
  reason?: string
}

export interface CreationCapabilityObservation {
  status: 'observed' | 'unknown'
  quiescent: boolean
  jobId?: string
  artifactSha256: string
  /** Evidence can describe an unsupported backend; adoption still requires its certificate boundary. */
  boundary?: 'process-seccomp-v1' | 'macos-seatbelt-single-process-v1' | 'linux-native-process-seccomp-v1'
  runtimeDigest?: string
  reason?: string
  environment?: PluginCreationVerificationCertificate['environment']
  schemaDigest?: string
  schemas?: readonly unknown[]
  calls?: readonly { id: string; toolName: string; result: unknown }[]
}

export interface CreationCapabilityRunner {
  run(input: { key: string; artifact: Buffer; operation: { kind: 'discover' }
    | { kind: 'invoke'; schemaDigest: string; calls: readonly { id: string; toolName: string; arguments: unknown }[] };
    signal: AbortSignal }): Promise<CreationCapabilityObservation>
  close(): Promise<void>
}

/** The integration owns current authenticated task/owner fences, not model parameters. */
export interface CreationCapabilityPorts {
  inspect(planId: string): { certificate: PluginCreationVerificationCertificate; artifact: Buffer; owner: CreationCapabilityOwner; sourceRun?: AnySourceGrowthRunBinding }
  recheck(planId: string, signal: AbortSignal): Promise<void>
  /** Capture checked staged source before first claim; legacy ports may have no archive. */
  captureSource?(planId: string, signal: AbortSignal): Promise<CreationCapabilitySourceSnapshot>
  /** Historical evidence read for a v2 receipt; must recheck the current owner and frozen source. */
  inspectRetained?(record: CreationCapabilityRecord): { certificate: PluginCreationVerificationCertificate; artifact: Buffer; owner: CreationCapabilityOwner; sourceRun?: AnySourceGrowthRunBinding }
  recheckRetained?(record: CreationCapabilityRecord, signal: AbortSignal): Promise<void>
  /** The trusted source fence supplies the actual v2 run; legacy v1 ports call back without it. */
  withCurrent<T>(record: CreationCapabilityRecord, callback: (sourceRun?: AnySourceGrowthRunBinding) => T): T
  assertCaller(record: CreationCapabilityRecord, execution: ToolRunContext): void
  /** Optional authenticated Host attribution; absence never implies a foreground task. */
  inspectCall?(record: CreationCapabilityRecord, execution: ToolRunContext, toolAlias: string,
    argumentsJson: string): CreationCapabilityForegroundCallWitness | undefined
}

export interface CreationCapabilityForegroundCallWitness {
  protocol: 'assistant-delivery/foreground-tool-call/v1'
  task: {
    protocol: 'assistant-delivery/foreground-task/v1'
    inboxId: string
    sessionId: string
    scope: { workspace: string; preset: string }
    owner: { principalRecordId: string; principalVersion: number }
    binding: { id: string; version: number; generation: number }
    dispatchedAt: number
  }
  turn: number
  call: { id: string; toolName: string; eventSeq: number; eventDigest: string; argumentsDigest: string }
}

export interface CreationCapabilityCallEvidence {
  protocol: 'dsh-created-capability-call-evidence/v1'
  planId: string
  key: string
  status: CreationCapabilityCall['status']
  attribution: 'foreground' | 'unattributed' | 'legacy-unattributed'
  toolAlias?: string
  originalName?: string
  receiptDigest: string
  artifactSha256: string
  schemaDigest: string
  claimedAt?: number
  settledAt?: number
  foreground?: CreationCapabilityForegroundCallWitness
}

/** A current, content-free task association; not a causal improvement claim. */
export interface CreationCapabilityTaskAssociation {
  protocol: 'dsh-created-capability-task-association/v1'
  planId: string
  inboxId: string
  sessionId: string
  callKeys: readonly string[]
  receiptDigest: string
  artifactSha256: string
  schemaDigest: string
  adoptionStatus: CreationCapabilityRecord['status']
  /** Signed deadline only; current execution still requires runtime owner, mount and quota checks. */
  withinSignedUseWindow: boolean
  task: {
    projection: { subjectKind: 'foreground-turn'; subjectRef: string; version: number; digest: string; disposition: 'upsert' }
    scopeWatermark: number
    outcomeId: string
    judgement: 'owner-feedback' | 'independent-verifier'
    status: 'achieved' | 'not-achieved'
    sourceDigest: string
  }
}

/** Frozen task model only; a frozen state without a complete selection is reported as inconsistent. */
export type CreationCapabilityOrdinaryUseModel =
  | { state: 'frozen'; provider: string; model: string; reasoningEffort?: string }
  | { state: 'missing' | 'inconsistent' }

export interface CreationCapabilityOrdinaryUseQuality {
  status: 'measured' | 'insufficient'
  samples: number
  achieved: number
  notAchieved: number
}

/** Nearest-rank p50 and max are present only when measured. */
export interface CreationCapabilityOrdinaryUseLatency {
  status: 'measured' | 'insufficient' | 'unmeasured'
  samples: number
  p50Ms?: number
  maxMs?: number
}

export interface CreationCapabilityOrdinaryUseMeasures {
  quality: CreationCapabilityOrdinaryUseQuality
  callLatency: CreationCapabilityOrdinaryUseLatency
  taskLatency: CreationCapabilityOrdinaryUseLatency
}

export interface CreationCapabilityOrdinaryUseStratum extends CreationCapabilityOrdinaryUseMeasures {
  model: CreationCapabilityOrdinaryUseModel
}

/** Content-free descriptive counts over current associations; never causal, adoption or promotion evidence. */
export interface CreationCapabilityOrdinaryUseReport {
  protocol: 'dsh-created-capability-ordinary-use-report/v1'
  causal: false
  planId: string
  receiptDigest: string
  artifactSha256: string
  schemaDigest: string
  adoptionStatus: CreationCapabilityRecord['status']
  withinSignedUseWindow: boolean
  minimumSamples: number
  associationsDigest: string
  /** Candidate Inboxes not counted as a current association (no certified judgement, or failed owner/binding re-check); an unfenced upper bound. */
  unknown: { inboxes: number }
  overall: CreationCapabilityOrdinaryUseMeasures
  strata: readonly CreationCapabilityOrdinaryUseStratum[]
  regressions: { status: 'unmeasured' }
  cost: { status: 'unmeasured' }
}

/** Exact achieved-rate difference after minus before, as an unreduced fraction; never pooled across models. */
export type CreationCapabilityAttributionDelta =
  | { status: 'paired'; numerator: number; denominator: number; sign: -1 | 0 | 1 }
  | { status: 'insufficient' }

export interface CreationCapabilityAttributionArm {
  quality: CreationCapabilityOrdinaryUseQuality
  taskLatency: CreationCapabilityOrdinaryUseLatency
}

export interface CreationCapabilityAttributionStratum {
  model: CreationCapabilityOrdinaryUseModel
  before: CreationCapabilityAttributionArm
  after: CreationCapabilityAttributionArm
  achievedRateDelta: CreationCapabilityAttributionDelta
}

/**
 * Observational intention-to-treat attribution: every certified current owner foreground task in equal windows
 * before and after adoption, stratified by frozen task model. Not randomized and never adoption or promotion evidence.
 */
export interface CreationCapabilityAvailabilityAttribution {
  protocol: 'dsh-created-capability-availability-attribution/v1'
  causal: false
  design: 'adoption-before-after-itt-model-stratified'
  planId: string
  receiptDigest: string
  artifactSha256: string
  schemaDigest: string
  adoptionStatus: CreationCapabilityRecord['status']
  withinSignedUseWindow: boolean
  minimumSamples: number
  /** Before is [adoptedAt - windowMs, adoptedAt], after is (adoptedAt, adoptedAt + windowMs], by task dispatch time. */
  windowMs: number
  scopeWatermark: number
  rowsDigest: string
  population: {
    scanned: number
    counted: number
    excluded: { nonForeground: number; trigger: number; retracted: number; unverified: number; outsideWindow: number }
  }
  /** After-window tasks with a current exact call of this adoption; intention-to-treat counts every after task. */
  exposure: { afterTasks: number; exposedTasks: number }
  /** Other adoptions in the same journal whose adoption time falls inside either window. */
  concurrentAdoptions: { status: 'none' | 'flagged'; count: number }
  strata: readonly CreationCapabilityAttributionStratum[]
  /** Sign agreement over paired strata only; mixed when any paired stratum disagrees. */
  direction: 'improved' | 'regressed' | 'unchanged' | 'mixed' | 'insufficient'
  regressions: { status: 'unmeasured' }
  cost: { status: 'unmeasured' }
}

/** One fixed-length window by task dispatch time, `(startExclusive, endInclusive]`; negative indices precede adoption. */
export interface CreationCapabilityTrendWindow {
  index: number
  startExclusive: number
  endInclusive: number
  /** False only for the latest after window when it extends past `min(now, expiresAt)`. */
  complete: boolean
}

export interface CreationCapabilityTrendCell {
  index: number
  /** Current latest-revision judgements of tasks in sessions that used this adoption in a counted after window. */
  treated: CreationCapabilityOrdinaryUseQuality
  /** Same-scope certified foreground tasks in sessions that never used it in a counted after window. */
  control: CreationCapabilityOrdinaryUseQuality
  /** Exact calls of this adoption on counted tasks of the window; zero before adoption by construction. */
  calls: number
  exposedTasks: number
}

/**
 * Pooled after-minus-before treated change minus the same control change. The interval is an Agresti-Caffo adjusted
 * Wald 95% interval assuming independent tasks; insufficient when any of the four pooled cells is below minimumSamples.
 */
export type CreationCapabilityTrendDifferenceInDifferences =
  | { status: 'estimated'; estimate: number; standardError: number; interval95: { low: number; high: number } }
  | { status: 'insufficient' }

/** Drift of the treated-minus-control gap between the earliest and latest pre-adoption windows measured in both cohorts. */
export type CreationCapabilityTrendParallelCheck =
  | { status: 'not-flagged' | 'parallel-trend-suspect'; testedWindows: number; gapChange: number }
  | { status: 'untestable'; testedWindows: number }

export interface CreationCapabilityTrendStratum {
  model: CreationCapabilityOrdinaryUseModel
  cells: readonly CreationCapabilityTrendCell[]
  differenceInDifferences: CreationCapabilityTrendDifferenceInDifferences
  parallelTrend: CreationCapabilityTrendParallelCheck
}

export type CreationCapabilityTrendFlag = 'parallel-trend-suspect' | 'no-control-cohort' | 'concurrent-adoptions' | 'partial-window'

/**
 * Longitudinal ordinary-use series of one adoption with a same-scope session-cohort control and a
 * difference-in-differences estimate per frozen task model. Observational; never adoption or promotion evidence.
 */
export interface CreationCapabilityOrdinaryUseTrend {
  protocol: 'dsh-created-capability-ordinary-use-trend/v1'
  causal: false
  design: 'session-cohort-difference-in-differences-model-stratified'
  planId: string
  receiptDigest: string
  artifactSha256: string
  schemaDigest: string
  adoptionStatus: CreationCapabilityRecord['status']
  withinSignedUseWindow: boolean
  minimumSamples: number
  windowMs: number
  parallelTrendThreshold: number
  scopeWatermark: number
  rowsDigest: string
  windows: readonly CreationCapabilityTrendWindow[]
  population: {
    scanned: number
    counted: number
    excluded: { nonForeground: number; trigger: number; retracted: number; unverified: number; outsideWindow: number }
  }
  cohorts: { treatedSessions: number; controlSessions: number }
  concurrentAdoptions: { status: 'none' | 'flagged'; count: number }
  strata: readonly CreationCapabilityTrendStratum[]
  flags: readonly CreationCapabilityTrendFlag[]
  assumptions: readonly string[]
  regressions: { status: 'unmeasured' }
  cost: { status: 'unmeasured' }
}

export interface CreationCapabilityCall {
  key: string
  status: 'claimed' | 'completed' | 'unknown'
  result?: unknown
  jobId?: string
}

/** Historical source data signed separately from the finite execution receipt. */
export interface CreationCapabilitySourceArchive {
  protocol: 'dsh-created-capability-source-archive/v1'
  authorityId: string
  authorityDigest: string
  keyId: string
  planId: string
  certificateDigest: string
  artifactSha256: string
  source: CreationCapabilitySourceSnapshot
  signature: string
}

export interface CreationCapabilityJournalPort {
  readonly authorityDigest: string
  readonly publicKey: string
  inspect(planId: string): CreationCapabilityRecord | undefined
  list(): readonly CreationCapabilityRecord[]
  /** Live rows plus usage inherited from a sealed adoption handoff; grant limits count this total. */
  usage(): { adoptions: number; calls: number }
  claim(input: { certificate: PluginCreationVerificationCertificate; artifact: Buffer;
    source?: CreationCapabilitySourceSnapshot }): { created: boolean; record: CreationCapabilityRecord }
  /** Lazy historical read; legacy rows have no archive and are never inferred or backfilled. */
  inspectSourceArchive?(planId: string): CreationCapabilitySourceArchive | undefined
  authorize(planId: string, tools: readonly CreationCapabilityTool[]): CreationCapabilityRecord
  activate(planId: string): CreationCapabilityRecord
  settle(planId: string, status: 'closed' | 'unknown' | 'rejected', reason: string): void
  claimCall(input: { planId: string; key: string; argumentsDigest: string; toolAlias?: string;
    foreground?: CreationCapabilityForegroundCallWitness }): { created: boolean; call: CreationCapabilityCall }
  listCallEvidence?(planId: string): readonly CreationCapabilityCallEvidence[]
  settleCall(input: { planId: string; key: string; status: 'completed' | 'unknown'; result?: unknown; jobId?: string }): void
  recoverClaims(): void
  close(): void
}
