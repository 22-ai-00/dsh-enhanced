import {
  ASSISTANT_GROWTH_CONTRACT_VERSION,
  GROWTH_AUTOMATION_OPERATION_PROTOCOL,
  GROWTH_AUTOMATION_RECEIPT_PROTOCOL,
  GROWTH_EFFECT_BLOCKER_PROTOCOL,
  type GrowthArtifactIdentity,
  type GrowthAutomationApprovalReceipt,
  type GrowthAutomationApprovalRequest,
  type GrowthAutomationArtifactRequest,
  type GrowthAutomationProposalReceipt,
  type GrowthAutomationProposalRequest,
  type GrowthCanaryInspectionReceipt,
  type GrowthCanaryInspectionRequest,
  type GrowthCanaryReceipt,
  type GrowthExperimentIdentity,
  type GrowthPromotionReceipt,
  type GrowthReplayReceipt,
  type GrowthRollbackReceipt,
  type GrowthShadowReceipt,
} from './types.js'
import {
  AssistantGrowthContractError,
  assertExactGrowthKeys,
  canonicalGrowthJson,
  exactGrowthDigest,
  growthObjectDigest,
  isGrowthRecord,
  validateWorkflowAutomationTemplate,
  validateWorkflowScope,
  validateWorkflowSteps,
} from './canonical.js'

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/u

function invalid(message: string): never {
  throw new AssistantGrowthContractError('invalid-input', message)
}

function identifier(value: unknown, label: string, maxBytes = 500): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || value === ''
    || Buffer.byteLength(value, 'utf8') > maxBytes || !identifierPattern.test(value)) {
    invalid(`${label} is invalid`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} is invalid`)
  return value as number
}

export function validateGrowthExperimentIdentity(value: unknown): Readonly<GrowthExperimentIdentity> {
  if (!isGrowthRecord(value)) invalid('growth operation identity must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'operationId', 'experimentId', 'candidateId',
    'candidateRevision', 'candidateDigest',
  ], 'growth operation identity')
  if (value['contractVersion'] !== ASSISTANT_GROWTH_CONTRACT_VERSION) {
    invalid('growth contract version is invalid')
  }
  return Object.freeze({
    contractVersion: ASSISTANT_GROWTH_CONTRACT_VERSION,
    operationId: identifier(value['operationId'], 'operationId'),
    experimentId: identifier(value['experimentId'], 'experimentId'),
    candidateId: identifier(value['candidateId'], 'candidateId'),
    candidateRevision: positiveInteger(value['candidateRevision'], 'candidateRevision'),
    candidateDigest: exactGrowthDigest(value['candidateDigest'], 'candidateDigest'),
  })
}

export function validateGrowthArtifactIdentity(value: unknown): Readonly<GrowthArtifactIdentity> {
  if (!isGrowthRecord(value)) invalid('growth artifact identity must be an object')
  assertExactGrowthKeys(value, ['artifactId', 'artifactVersion', 'artifactDigest'], 'growth artifact identity')
  return Object.freeze({
    artifactId: identifier(value['artifactId'], 'artifactId'),
    artifactVersion: positiveInteger(value['artifactVersion'], 'artifactVersion'),
    artifactDigest: exactGrowthDigest(value['artifactDigest'], 'artifactDigest'),
  })
}

function pickIdentity(value: Readonly<Record<string, unknown>>): Readonly<GrowthExperimentIdentity> {
  return validateGrowthExperimentIdentity({
    contractVersion: value['contractVersion'],
    operationId: value['operationId'],
    experimentId: value['experimentId'],
    candidateId: value['candidateId'],
    candidateRevision: value['candidateRevision'],
    candidateDigest: value['candidateDigest'],
  })
}

function pickArtifact(value: Readonly<Record<string, unknown>>): Readonly<GrowthArtifactIdentity> {
  return validateGrowthArtifactIdentity({
    artifactId: value['artifactId'],
    artifactVersion: value['artifactVersion'],
    artifactDigest: value['artifactDigest'],
  })
}

function identityMatches(
  actual: Readonly<GrowthExperimentIdentity>,
  expected: Readonly<GrowthExperimentIdentity>,
): void {
  const normalized = pickIdentity(expected as unknown as Readonly<Record<string, unknown>>)
  if (canonicalGrowthJson(actual) !== canonicalGrowthJson(normalized)) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'growth receipt changed operation identity')
  }
}

function artifactMatches(
  actual: Readonly<GrowthArtifactIdentity>,
  expected: Readonly<GrowthArtifactIdentity>,
): void {
  const normalized = pickArtifact(expected as unknown as Readonly<Record<string, unknown>>)
  if (canonicalGrowthJson(actual) !== canonicalGrowthJson(normalized)) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'growth receipt changed artifact identity')
  }
}

export function growthPortPayloadDigest(value: unknown): string {
  return growthObjectDigest({ contract: GROWTH_AUTOMATION_OPERATION_PROTOCOL, payload: value })
}

export function growthPortReceiptDigest(value: Readonly<Record<string, unknown>>): string {
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'receiptDigest'))
  return growthObjectDigest({ contract: GROWTH_AUTOMATION_RECEIPT_PROTOCOL, receipt: payload })
}

export function withGrowthPortReceiptDigest<T extends Readonly<Record<string, unknown>>>(
  value: T,
): Readonly<T & { receiptDigest: string }> {
  if (Object.hasOwn(value, 'receiptDigest')) invalid('receipt builder payload already contains receiptDigest')
  return Object.freeze({ ...value, receiptDigest: growthPortReceiptDigest(value) })
}

function verifiedReceipt(value: Readonly<Record<string, unknown>>): string {
  const digest = exactGrowthDigest(value['receiptDigest'], 'receiptDigest')
  if (growthPortReceiptDigest(value) !== digest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'growth receipt digest does not match its payload')
  }
  return digest
}

export function validateGrowthAutomationProposalRequest(
  value: unknown,
): Readonly<GrowthAutomationProposalRequest> {
  if (!isGrowthRecord(value)) invalid('growth automation proposal request must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'operationId', 'experimentId', 'candidateId', 'candidateRevision',
    'candidateDigest', 'initialState', 'scope', 'ownerBindingId', 'evidenceDigest',
    'evidenceCount', 'template', 'steps', 'deadlineAt',
  ], 'growth automation proposal request')
  if (value['initialState'] !== 'paused'
    || !Number.isSafeInteger(value['evidenceCount']) || (value['evidenceCount'] as number) < 1
    || !Number.isSafeInteger(value['deadlineAt']) || (value['deadlineAt'] as number) < 0) {
    invalid('growth automation proposal tuple is invalid')
  }
  return Object.freeze({
    ...pickIdentity(value),
    initialState: 'paused',
    scope: validateWorkflowScope(value['scope']),
    ownerBindingId: identifier(value['ownerBindingId'], 'ownerBindingId', 200),
    evidenceDigest: exactGrowthDigest(value['evidenceDigest'], 'evidenceDigest'),
    evidenceCount: value['evidenceCount'] as number,
    template: validateWorkflowAutomationTemplate(value['template']),
    steps: validateWorkflowSteps(value['steps']),
    deadlineAt: value['deadlineAt'] as number,
  })
}

export function validateGrowthAutomationApprovalRequest(
  value: unknown,
): Readonly<GrowthAutomationApprovalRequest> {
  if (!isGrowthRecord(value)) invalid('growth automation approval request must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'operationId', 'experimentId', 'candidateId', 'candidateRevision',
    'candidateDigest', 'proposalId',
  ], 'growth automation approval request')
  return Object.freeze({ ...pickIdentity(value), proposalId: identifier(value['proposalId'], 'proposalId') })
}

export function validateGrowthAutomationArtifactRequest(
  value: unknown,
): Readonly<GrowthAutomationArtifactRequest> {
  if (!isGrowthRecord(value)) invalid('growth automation artifact request must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'operationId', 'experimentId', 'candidateId', 'candidateRevision',
    'candidateDigest', 'artifactId', 'artifactVersion', 'artifactDigest',
  ], 'growth automation artifact request')
  return Object.freeze({ ...pickIdentity(value), ...pickArtifact(value) })
}

export function validateGrowthCanaryInspectionRequest(
  value: unknown,
): Readonly<GrowthCanaryInspectionRequest> {
  if (!isGrowthRecord(value)) invalid('growth canary inspection request must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'operationId', 'experimentId', 'candidateId', 'candidateRevision',
    'candidateDigest', 'artifactId', 'artifactVersion', 'artifactDigest', 'exposureOperationId',
  ], 'growth canary inspection request')
  return Object.freeze({
    ...validateGrowthAutomationArtifactRequest(Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'exposureOperationId'),
    )),
    exposureOperationId: identifier(value['exposureOperationId'], 'exposureOperationId'),
  })
}

function receiptIdentity(
  value: Readonly<Record<string, unknown>>,
  expected?: Readonly<GrowthExperimentIdentity>,
): Readonly<GrowthExperimentIdentity> {
  const identity = pickIdentity(value)
  if (expected !== undefined) identityMatches(identity, expected)
  return identity
}

function receiptArtifact(
  value: Readonly<Record<string, unknown>>,
  expected?: Readonly<GrowthArtifactIdentity>,
): Readonly<GrowthArtifactIdentity> {
  const artifact = pickArtifact(value)
  if (expected !== undefined) artifactMatches(artifact, expected)
  return artifact
}

const identityKeys = [
  'contractVersion', 'operationId', 'experimentId', 'candidateId', 'candidateRevision', 'candidateDigest',
] as const
const artifactKeys = ['artifactId', 'artifactVersion', 'artifactDigest'] as const

export function validateGrowthAutomationProposalReceipt(
  value: unknown,
  expected?: Readonly<GrowthExperimentIdentity>,
): Readonly<GrowthAutomationProposalReceipt> {
  if (!isGrowthRecord(value)) invalid('growth automation proposal receipt must be an object')
  const base = [...identityKeys, 'outcome', 'receiptDigest']
  if (value['outcome'] === 'approval-pending') {
    assertExactGrowthKeys(value, [...base, 'proposalId'], 'growth automation proposal receipt')
    const receipt = Object.freeze({
      ...receiptIdentity(value, expected),
      outcome: 'approval-pending' as const,
      proposalId: identifier(value['proposalId'], 'proposalId'),
      receiptDigest: verifiedReceipt(value),
    })
    return receipt
  }
  if (value['outcome'] === 'approved-paused') {
    assertExactGrowthKeys(value, [...base, 'proposalId', ...artifactKeys], 'growth automation proposal receipt')
    return Object.freeze({
      ...receiptIdentity(value, expected),
      outcome: 'approved-paused' as const,
      proposalId: identifier(value['proposalId'], 'proposalId'),
      ...receiptArtifact(value),
      receiptDigest: verifiedReceipt(value),
    })
  }
  if (value['outcome'] === 'conflicted' || value['outcome'] === 'expired' || value['outcome'] === 'rejected') {
    assertExactGrowthKeys(
      value,
      value['proposalId'] === undefined ? base : [...base, 'proposalId'],
      'growth automation proposal receipt',
    )
    return Object.freeze({
      ...receiptIdentity(value, expected),
      outcome: value['outcome'],
      ...(value['proposalId'] === undefined
        ? {}
        : { proposalId: identifier(value['proposalId'], 'proposalId') }),
      receiptDigest: verifiedReceipt(value),
    })
  }
  invalid('growth automation proposal outcome is invalid')
}

export function validateGrowthAutomationApprovalReceipt(
  value: unknown,
  expected?: Readonly<GrowthExperimentIdentity>,
): Readonly<GrowthAutomationApprovalReceipt> {
  return validateGrowthAutomationProposalReceipt(value, expected)
}

function validateArtifactReceiptBase(
  value: unknown,
  expected?: Readonly<GrowthAutomationArtifactRequest>,
): {
  value: Readonly<Record<string, unknown>>
  identity: Readonly<GrowthExperimentIdentity>
  artifact: Readonly<GrowthArtifactIdentity>
  receiptDigest: string
} {
  if (!isGrowthRecord(value)) invalid('growth artifact receipt must be an object')
  const identity = receiptIdentity(value, expected)
  const artifact = receiptArtifact(value, expected)
  return { value, identity, artifact, receiptDigest: verifiedReceipt(value) }
}

export function validateGrowthReplayReceipt(
  value: unknown,
  expected?: Readonly<GrowthAutomationArtifactRequest>,
): Readonly<GrowthReplayReceipt> {
  const base = validateArtifactReceiptBase(value, expected)
  assertExactGrowthKeys(base.value, [
    ...identityKeys, ...artifactKeys, 'outcome', 'replayDigest', 'receiptDigest',
  ], 'growth replay receipt')
  if (base.value['outcome'] !== 'passed' && base.value['outcome'] !== 'failed') {
    invalid('growth replay outcome is invalid')
  }
  return Object.freeze({
    ...base.identity,
    ...base.artifact,
    outcome: base.value['outcome'],
    replayDigest: exactGrowthDigest(base.value['replayDigest'], 'replayDigest'),
    receiptDigest: base.receiptDigest,
  })
}

export function validateGrowthShadowReceipt(
  value: unknown,
  expected?: Readonly<GrowthAutomationArtifactRequest>,
): Readonly<GrowthShadowReceipt> {
  const base = validateArtifactReceiptBase(value, expected)
  assertExactGrowthKeys(base.value, [
    ...identityKeys, ...artifactKeys, 'outcome', 'effectsBlocked', 'effectBlockerAttestation',
    'shadowDigest', 'receiptDigest',
  ], 'growth shadow receipt')
  if ((base.value['outcome'] !== 'passed' && base.value['outcome'] !== 'failed')
    || base.value['effectsBlocked'] !== true || !isGrowthRecord(base.value['effectBlockerAttestation'])) {
    invalid('growth shadow outcome or effect blocker is invalid')
  }
  const blocker = base.value['effectBlockerAttestation']
  assertExactGrowthKeys(
    blocker,
    ['contract', 'blockedEffects', 'implementationDigest'],
    'growth effect blocker attestation',
  )
  if (blocker['contract'] !== GROWTH_EFFECT_BLOCKER_PROTOCOL
    || !Array.isArray(blocker['blockedEffects'])
    || canonicalGrowthJson(blocker['blockedEffects']) !== canonicalGrowthJson(['delivery', 'tool-execution'])) {
    invalid('growth effect blocker attestation is invalid')
  }
  return Object.freeze({
    ...base.identity,
    ...base.artifact,
    outcome: base.value['outcome'],
    effectsBlocked: true,
    effectBlockerAttestation: Object.freeze({
      contract: GROWTH_EFFECT_BLOCKER_PROTOCOL,
      blockedEffects: Object.freeze(['delivery', 'tool-execution'] as const),
      implementationDigest: exactGrowthDigest(blocker['implementationDigest'], 'effect blocker implementation digest'),
    }),
    shadowDigest: exactGrowthDigest(base.value['shadowDigest'], 'shadowDigest'),
    receiptDigest: base.receiptDigest,
  })
}

function validateCanaryReceipt(
  value: unknown,
  expected?: Readonly<GrowthAutomationArtifactRequest>,
  expectedExposureOperationId?: string,
): Readonly<GrowthCanaryReceipt> {
  const base = validateArtifactReceiptBase(value, expected)
  const passed = base.value['outcome'] === 'passed'
  assertExactGrowthKeys(base.value, [
    ...identityKeys, ...artifactKeys, 'outcome', 'exposureCount', 'exposureOperationId',
    ...(passed ? ['evaluationDigest', 'evaluationTrust', 'objectiveStatus'] : []),
    'receiptDigest',
  ], 'growth canary receipt')
  if (base.value['outcome'] !== 'passed' && base.value['outcome'] !== 'failed'
    && base.value['outcome'] !== 'pending') invalid('growth canary outcome is invalid')
  const exposureOperationId = identifier(base.value['exposureOperationId'], 'exposureOperationId')
  if (base.value['exposureCount'] !== 1
    || (expectedExposureOperationId !== undefined && exposureOperationId !== expectedExposureOperationId)) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'growth canary exposure identity is invalid')
  }
  if (passed && (base.value['evaluationTrust'] !== 'trusted'
    || base.value['objectiveStatus'] !== 'achieved')) {
    invalid('growth canary pass lacks a trusted achieved Evaluation projection')
  }
  return Object.freeze({
    ...base.identity,
    ...base.artifact,
    outcome: base.value['outcome'],
    exposureCount: 1,
    exposureOperationId,
    ...(passed ? {
      evaluationDigest: exactGrowthDigest(base.value['evaluationDigest'], 'evaluationDigest'),
      evaluationTrust: 'trusted' as const,
      objectiveStatus: 'achieved' as const,
    } : {}),
    receiptDigest: base.receiptDigest,
  })
}

export function validateGrowthCanaryReceipt(
  value: unknown,
  expected?: Readonly<GrowthAutomationArtifactRequest>,
): Readonly<GrowthCanaryReceipt> {
  const exposure = expected === undefined ? undefined : `${expected.experimentId}:canary`
  return validateCanaryReceipt(value, expected, exposure)
}

export function validateGrowthCanaryInspectionReceipt(
  value: unknown,
  expected?: Readonly<GrowthCanaryInspectionRequest>,
): Readonly<GrowthCanaryInspectionReceipt> {
  const artifact = expected === undefined ? undefined : validateGrowthAutomationArtifactRequest(
    Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'exposureOperationId')),
  )
  return validateCanaryReceipt(value, artifact, expected?.exposureOperationId)
}

export function validateGrowthPromotionReceipt(
  value: unknown,
  expected?: Readonly<GrowthAutomationArtifactRequest>,
): Readonly<GrowthPromotionReceipt> {
  const base = validateArtifactReceiptBase(value, expected)
  assertExactGrowthKeys(base.value, [
    ...identityKeys, ...artifactKeys, 'outcome', 'resultingArtifactVersion',
    'resultingArtifactDigest', 'receiptDigest',
  ], 'growth promotion receipt')
  if (base.value['outcome'] !== 'promoted'
    || base.value['resultingArtifactVersion'] !== base.artifact.artifactVersion + 1) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'growth promotion did not satisfy exact artifact CAS')
  }
  return Object.freeze({
    ...base.identity,
    ...base.artifact,
    outcome: 'promoted',
    resultingArtifactVersion: base.value['resultingArtifactVersion'] as number,
    resultingArtifactDigest: exactGrowthDigest(
      base.value['resultingArtifactDigest'],
      'resultingArtifactDigest',
    ),
    receiptDigest: base.receiptDigest,
  })
}

export function validateGrowthRollbackReceipt(
  value: unknown,
  expected?: Readonly<GrowthAutomationArtifactRequest>,
): Readonly<GrowthRollbackReceipt> {
  const base = validateArtifactReceiptBase(value, expected)
  assertExactGrowthKeys(base.value, [
    ...identityKeys, ...artifactKeys, 'outcome', 'receiptDigest',
  ], 'growth rollback receipt')
  if (base.value['outcome'] !== 'rolled-back') invalid('growth rollback outcome is invalid')
  return Object.freeze({
    ...base.identity,
    ...base.artifact,
    outcome: 'rolled-back',
    receiptDigest: base.receiptDigest,
  })
}
