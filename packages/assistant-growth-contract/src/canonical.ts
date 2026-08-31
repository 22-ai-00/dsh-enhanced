import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import {
  ASSISTANT_GROWTH_CONTRACT_VERSION,
  WORKFLOW_ARGUMENT_SHAPE_PROTOCOL,
  WORKFLOW_TEMPLATE_PROTOCOL,
  WORKFLOW_TRACE_PROTOCOL,
  WORKFLOW_TRACE_SOURCE_ID,
  type GrowthWorkflowTraceSourceRegistration,
  type ResolvedWorkflowAutomationTemplate,
  type WorkflowAutomationTemplate,
  type WorkflowAutomationTemplateContent,
  type WorkflowScope,
  type WorkflowStepFingerprint,
  type WorkflowTemplatePrivacyAttestation,
  type WorkflowTraceEvidence,
  type WorkflowTraceProjectionReceipt,
  type WorkflowTraceRevision,
  type WorkflowTraceSourceAttestation,
} from './types.js'

export type AssistantGrowthContractErrorCode = 'invalid-input' | 'receipt-mismatch'

export class AssistantGrowthContractError extends Error {
  constructor(readonly code: AssistantGrowthContractErrorCode, message: string) {
    super(message)
    this.name = 'AssistantGrowthContractError'
  }
}

const digestPattern = /^[a-f0-9]{64}$/u
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const presetPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const externalPrincipalComponentPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

function invalid(message: string): never {
  throw new AssistantGrowthContractError('invalid-input', message)
}

export function isGrowthRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

export function assertExactGrowthKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    invalid(`${label} has an invalid shape`)
  }
}

function canonicalText(
  value: unknown,
  label: string,
  maxBytes: number,
  options: { multiline?: boolean; identifier?: RegExp } = {},
): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized !== value || normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    invalid(`${label} is not canonical bounded text`)
  }
  for (const character of normalized) {
    const code = character.codePointAt(0)!
    if (code === 0 || code === 0x7f || (!options.multiline && code <= 0x1f)) {
      invalid(`${label} contains a control character`)
    }
  }
  if (options.identifier !== undefined && !options.identifier.test(normalized)) {
    invalid(`${label} is not a canonical identifier`)
  }
  return normalized
}

/**
 * Validate Delivery's canonical four-component external principal identity.
 * Components are independently URI-encoded, so provider-owned slashes cannot
 * be confused with the separators between channel/account/tenant/user.
 */
export function validateExternalPrincipalId(value: unknown): string {
  const principalId = canonicalText(value, 'external principalId', 4_096)
  const components = principalId.split('/')
  if (components.length !== 4) invalid('external principalId must have four components')
  for (const component of components) {
    let decoded: string
    try {
      decoded = decodeURIComponent(component)
    } catch {
      invalid('external principalId has invalid component encoding')
    }
    if (!externalPrincipalComponentPattern.test(decoded)
      || encodeURIComponent(decoded) !== component) {
      invalid('external principalId is not canonical')
    }
  }
  return principalId
}

export function exactGrowthDigest(value: unknown, label = 'digest'): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

/** Strict canonical JSON for already-validated protocol payloads. */
export function canonicalGrowthJson(value: unknown): string {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (current: unknown, depth: number): string => {
    nodes += 1
    if (nodes > 8_192 || depth > 32) invalid('canonical JSON payload is too complex')
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalid('canonical JSON number is invalid')
      return JSON.stringify(current)
    }
    if (typeof current !== 'object') invalid('canonical JSON contains a non-JSON value')
    if (seen.has(current)) invalid('canonical JSON must not contain a cycle')
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) invalid('canonical JSON array is invalid')
        return `[${current.map(item => visit(item, depth + 1)).join(',')}]`
      }
      if (!isGrowthRecord(current)) invalid('canonical JSON object is invalid')
      const keys = Object.keys(current).sort()
      return `{${keys.map(key => `${JSON.stringify(key)}:${visit(current[key], depth + 1)}`).join(',')}}`
    } finally {
      seen.delete(current)
    }
  }
  return visit(value, 0)
}

export function growthSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function growthObjectDigest(value: unknown): string {
  return growthSha256(canonicalGrowthJson(value))
}

/**
 * Fingerprint JSON structure only. Scalar values, array length and member
 * order are deliberately absent. Object field names remain part of shape.
 */
export function workflowArgumentShapeDigest(input: unknown): string {
  let nodes = 0
  const active = new Set<object>()
  const shape = (value: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > 1_024 || depth > 16) invalid('workflow argument shape is too complex')
    if (value === null) return 'null'
    if (typeof value === 'string') return 'string'
    if (typeof value === 'boolean') return 'boolean'
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('workflow argument number is invalid')
      return Number.isInteger(value) ? 'integer' : 'number'
    }
    if (typeof value !== 'object') invalid('workflow arguments must be plain JSON data')
    if (active.has(value)) invalid('workflow arguments must not contain a cycle')
    active.add(value)
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) invalid('workflow argument array is invalid')
        const members = [...new Set(value.map(item => canonicalGrowthJson(shape(item, depth + 1))))].sort()
        return { arrayMembers: members.map(member => JSON.parse(member) as unknown) }
      }
      if (!isGrowthRecord(value)) invalid('workflow arguments must be plain JSON data')
      const keys = Object.keys(value).sort()
      if (keys.length > 256) invalid('workflow argument object is too wide')
      for (const key of keys) canonicalText(key, 'workflow argument field', 200)
      return Object.fromEntries(keys.map(key => [key, shape(value[key], depth + 1)]))
    } finally {
      active.delete(value)
    }
  }
  return growthObjectDigest({ contract: WORKFLOW_ARGUMENT_SHAPE_PROTOCOL, shape: shape(input, 0) })
}

export function validateWorkflowScope(value: unknown): Readonly<WorkflowScope> {
  if (!isGrowthRecord(value)) invalid('workflow scope must be an object')
  assertExactGrowthKeys(value, ['workspace', 'preset'], 'workflow scope')
  const workspace = canonicalText(value['workspace'], 'workflow workspace', 4_096)
  const preset = canonicalText(value['preset'], 'workflow preset', 200, { identifier: presetPattern })
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace) {
    invalid('workflow workspace must be an absolute normalized path')
  }
  return Object.freeze({ workspace, preset })
}

export function workflowScopeKey(value: unknown): string {
  const scope = validateWorkflowScope(value)
  return growthObjectDigest(['assistant-growth-scope/v1', scope.workspace, scope.preset])
}

function catalogId(value: unknown): string {
  return canonicalText(value, 'workflow catalog id', 200, { identifier: identifierPattern })
}

export function validateWorkflowStepFingerprint(value: unknown): Readonly<WorkflowStepFingerprint> {
  if (!isGrowthRecord(value)) invalid('workflow step must be an object')
  assertExactGrowthKeys(value, ['catalogId', 'argumentSchemaDigest'], 'workflow step')
  return Object.freeze({
    catalogId: catalogId(value['catalogId']),
    argumentSchemaDigest: exactGrowthDigest(value['argumentSchemaDigest'], 'argumentSchemaDigest'),
  })
}

export function validateWorkflowSteps(value: unknown): readonly Readonly<WorkflowStepFingerprint>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    invalid('workflow steps must contain 1 to 64 entries')
  }
  return Object.freeze(value.map(validateWorkflowStepFingerprint))
}

export function validateWorkflowTemplatePrivacyAttestation(
  value: unknown,
): WorkflowTemplatePrivacyAttestation {
  if (!isGrowthRecord(value)) invalid('workflow privacy attestation must be an object')
  if (value['kind'] === 'deterministic-deidentification') {
    assertExactGrowthKeys(
      value,
      ['kind', 'method', 'attestationId', 'attestationDigest'],
      'workflow privacy attestation',
    )
    if (value['method'] !== 'assistant-delivery-redaction-v1') {
      invalid('workflow deidentification method is unsupported')
    }
    return Object.freeze({
      kind: 'deterministic-deidentification',
      method: 'assistant-delivery-redaction-v1',
      attestationId: canonicalText(value['attestationId'], 'privacy attestation id', 200, {
        identifier: identifierPattern,
      }),
      attestationDigest: exactGrowthDigest(value['attestationDigest'], 'privacy attestation digest'),
    })
  }
  if (value['kind'] === 'owner-explicit') {
    assertExactGrowthKeys(
      value,
      ['kind', 'limitation', 'attestationId', 'attestationDigest'],
      'workflow privacy attestation',
    )
    if (value['limitation'] !== 'deidentification-unproven') {
      invalid('owner-explicit privacy limitation is invalid')
    }
    return Object.freeze({
      kind: 'owner-explicit',
      limitation: 'deidentification-unproven',
      attestationId: canonicalText(value['attestationId'], 'privacy attestation id', 200, {
        identifier: identifierPattern,
      }),
      attestationDigest: exactGrowthDigest(value['attestationDigest'], 'privacy attestation digest'),
    })
  }
  invalid('workflow privacy attestation kind is invalid')
}

export function validateWorkflowAutomationTemplate(value: unknown): Readonly<WorkflowAutomationTemplate> {
  if (!isGrowthRecord(value)) invalid('workflow template reference must be an object')
  assertExactGrowthKeys(
    value,
    ['templateRef', 'templateDigest', 'privacyAttestation'],
    'workflow template reference',
  )
  return Object.freeze({
    templateRef: canonicalText(value['templateRef'], 'templateRef', 200, { identifier: identifierPattern }),
    templateDigest: exactGrowthDigest(value['templateDigest'], 'templateDigest'),
    privacyAttestation: validateWorkflowTemplatePrivacyAttestation(value['privacyAttestation']),
  })
}

function canonicalTimezone(value: unknown): string {
  const timezone = canonicalText(value, 'workflow timezone', 200)
  try {
    if (new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone !== timezone) {
      invalid('workflow timezone must use its canonical IANA id')
    }
  } catch {
    invalid('workflow timezone is invalid')
  }
  return timezone
}

export function validateWorkflowAutomationTemplateContent(
  value: unknown,
): Readonly<WorkflowAutomationTemplateContent> {
  if (!isGrowthRecord(value)) invalid('workflow template content must be an object')
  assertExactGrowthKeys(value, [
    'scope', 'ownerBindingId', 'principalId', 'name', 'prompt', 'schedule', 'timeoutMs',
    'toolCatalogIds', 'deliveryBindingId',
  ], 'workflow template content')
  if (!isGrowthRecord(value['schedule'])) invalid('workflow schedule must be an object')
  assertExactGrowthKeys(value['schedule'], ['kind', 'expression', 'timezone'], 'workflow schedule')
  if (value['schedule']['kind'] !== 'cron') invalid('workflow schedule kind is invalid')
  if (!Number.isSafeInteger(value['timeoutMs'])
    || (value['timeoutMs'] as number) < 1_000 || (value['timeoutMs'] as number) > 86_400_000) {
    invalid('workflow timeout is invalid')
  }
  if (!Array.isArray(value['toolCatalogIds'])
    || value['toolCatalogIds'].length < 1
    || value['toolCatalogIds'].length > 64) invalid('workflow tool catalog is invalid')
  const toolCatalogIds = value['toolCatalogIds'].map(catalogId)
  const sorted = [...new Set(toolCatalogIds)].sort()
  if (sorted.length !== toolCatalogIds.length
    || sorted.some((entry, index) => entry !== toolCatalogIds[index])) {
    invalid('workflow tool catalog must be unique and sorted')
  }
  return Object.freeze({
    scope: validateWorkflowScope(value['scope']),
    ownerBindingId: canonicalText(value['ownerBindingId'], 'owner binding id', 200, {
      identifier: identifierPattern,
    }),
    principalId: validateExternalPrincipalId(value['principalId']),
    name: canonicalText(value['name'], 'workflow name', 200),
    prompt: canonicalText(value['prompt'], 'workflow prompt', 8_192, { multiline: true }),
    schedule: Object.freeze({
      kind: 'cron',
      expression: canonicalText(value['schedule']['expression'], 'cron expression', 200),
      timezone: canonicalTimezone(value['schedule']['timezone']),
    }),
    timeoutMs: value['timeoutMs'] as number,
    toolCatalogIds: Object.freeze(sorted),
    deliveryBindingId: canonicalText(value['deliveryBindingId'], 'delivery binding id', 200, {
      identifier: identifierPattern,
    }),
  })
}

export function workflowAutomationTemplateContentDigest(value: unknown): string {
  const content = validateWorkflowAutomationTemplateContent(value)
  return growthObjectDigest({ contract: WORKFLOW_TEMPLATE_PROTOCOL, content })
}

export function validateResolvedWorkflowAutomationTemplate(
  value: unknown,
): Readonly<ResolvedWorkflowAutomationTemplate> {
  if (!isGrowthRecord(value)) invalid('resolved workflow template must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'template', 'scope', 'ownerBindingId', 'principalId', 'name', 'prompt', 'schedule',
    'timeoutMs', 'toolCatalogIds', 'deliveryBindingId',
  ], 'resolved workflow template')
  if (value['contractVersion'] !== ASSISTANT_GROWTH_CONTRACT_VERSION) {
    invalid('resolved workflow template contract version is invalid')
  }
  const template = validateWorkflowAutomationTemplate(value['template'])
  const content = validateWorkflowAutomationTemplateContent({
    scope: value['scope'],
    ownerBindingId: value['ownerBindingId'],
    principalId: value['principalId'],
    name: value['name'],
    prompt: value['prompt'],
    schedule: value['schedule'],
    timeoutMs: value['timeoutMs'],
    toolCatalogIds: value['toolCatalogIds'],
    deliveryBindingId: value['deliveryBindingId'],
  })
  if (workflowAutomationTemplateContentDigest(content) !== template.templateDigest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'resolved workflow template digest is stale')
  }
  return Object.freeze({
    contractVersion: ASSISTANT_GROWTH_CONTRACT_VERSION,
    template,
    ...content,
  })
}

export function validateWorkflowTraceEvidence(value: unknown): Readonly<WorkflowTraceEvidence> {
  if (!isGrowthRecord(value)) invalid('workflow trace evidence must be an object')
  const expected = [
    'occurredAt', 'signal', 'objectiveStatus', 'ownerBindingId', 'taskRef', 'template', 'steps',
    ...(value['taskEvidenceDigest'] === undefined ? [] : ['taskEvidenceDigest']),
  ]
  assertExactGrowthKeys(value, expected, 'workflow trace evidence')
  if (!Number.isSafeInteger(value['occurredAt']) || (value['occurredAt'] as number) < 0
    || (value['signal'] !== 'owner-explicit' && value['signal'] !== 'verified-repetition')
    || (value['objectiveStatus'] !== 'achieved' && value['objectiveStatus'] !== 'unknown')) {
    invalid('workflow trace evidence tuple is invalid')
  }
  const template = validateWorkflowAutomationTemplate(value['template'])
  const taskEvidenceDigest = value['taskEvidenceDigest'] === undefined
    ? undefined
    : exactGrowthDigest(value['taskEvidenceDigest'], 'task evidence digest')
  if (value['signal'] === 'verified-repetition'
    && (value['objectiveStatus'] !== 'achieved' || taskEvidenceDigest === undefined
      || template.privacyAttestation.kind !== 'deterministic-deidentification')) {
    invalid('verified repetition requires achieved trusted evidence and proven deterministic deidentification')
  }
  return Object.freeze({
    occurredAt: value['occurredAt'] as number,
    signal: value['signal'],
    objectiveStatus: value['objectiveStatus'],
    ownerBindingId: canonicalText(value['ownerBindingId'], 'owner binding id', 200, {
      identifier: identifierPattern,
    }),
    taskRef: exactGrowthDigest(value['taskRef'], 'taskRef'),
    ...(taskEvidenceDigest === undefined ? {} : { taskEvidenceDigest }),
    template,
    steps: validateWorkflowSteps(value['steps']),
  })
}

export function validateWorkflowTraceSourceAttestation(
  value: unknown,
): Readonly<WorkflowTraceSourceAttestation> {
  if (!isGrowthRecord(value)) invalid('workflow trace source must be an object')
  assertExactGrowthKeys(value, ['sourceId', 'generation', 'authorityDigest'], 'workflow trace source')
  if (value['sourceId'] !== WORKFLOW_TRACE_SOURCE_ID
    || !Number.isSafeInteger(value['generation']) || (value['generation'] as number) < 1) {
    invalid('workflow trace source tuple is invalid')
  }
  return Object.freeze({
    sourceId: WORKFLOW_TRACE_SOURCE_ID,
    generation: value['generation'] as number,
    authorityDigest: exactGrowthDigest(value['authorityDigest'], 'source authority digest'),
  })
}

function revisionWithoutDigest(value: unknown): Omit<WorkflowTraceRevision, 'digest'> {
  if (!isGrowthRecord(value)) invalid('workflow trace revision must be an object')
  const expected = [
    'source', 'scope', 'subjectRef', 'version', 'disposition',
    ...(value['evidence'] === undefined ? [] : ['evidence']),
  ]
  assertExactGrowthKeys(value, expected, 'workflow trace revision payload')
  if (!Number.isSafeInteger(value['version']) || (value['version'] as number) < 1
    || (value['disposition'] !== 'upsert' && value['disposition'] !== 'retract')
    || (value['disposition'] === 'upsert') !== (value['evidence'] !== undefined)) {
    invalid('workflow trace revision tuple is invalid')
  }
  return Object.freeze({
    source: validateWorkflowTraceSourceAttestation(value['source']),
    scope: validateWorkflowScope(value['scope']),
    subjectRef: exactGrowthDigest(value['subjectRef'], 'subjectRef'),
    version: value['version'] as number,
    disposition: value['disposition'],
    ...(value['evidence'] === undefined
      ? {}
      : { evidence: validateWorkflowTraceEvidence(value['evidence']) }),
  })
}

export function workflowTraceRevisionDigest(value: Omit<WorkflowTraceRevision, 'digest'>): string {
  const revision = revisionWithoutDigest(value)
  return growthObjectDigest({ contract: WORKFLOW_TRACE_PROTOCOL, ...revision })
}

export function validateWorkflowTraceRevision(value: unknown): Readonly<WorkflowTraceRevision> {
  if (!isGrowthRecord(value)) invalid('workflow trace revision must be an object')
  const expected = [
    'source', 'scope', 'subjectRef', 'version', 'disposition', 'digest',
    ...(value['evidence'] === undefined ? [] : ['evidence']),
  ]
  assertExactGrowthKeys(value, expected, 'workflow trace revision')
  const digest = exactGrowthDigest(value['digest'], 'workflow trace digest')
  const payload = revisionWithoutDigest(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'digest'),
  ))
  if (workflowTraceRevisionDigest(payload) !== digest) {
    throw new AssistantGrowthContractError('receipt-mismatch', 'workflow trace digest does not match its payload')
  }
  return Object.freeze({ ...payload, digest })
}

export function workflowCandidateSignature(input: Readonly<{
  scope: Readonly<WorkflowScope>
  evidence: Readonly<WorkflowTraceEvidence>
}>): string {
  const scope = validateWorkflowScope(input.scope)
  const evidence = validateWorkflowTraceEvidence(input.evidence)
  return growthObjectDigest({
    contract: 'assistant-growth-workflow-signature/v2',
    scope,
    ownerBindingId: evidence.ownerBindingId,
    template: evidence.template,
    steps: evidence.steps,
  })
}

export function validateWorkflowTraceProjectionReceipt(
  value: unknown,
  expected?: Readonly<WorkflowTraceRevision>,
): Readonly<WorkflowTraceProjectionReceipt> {
  if (!isGrowthRecord(value)) invalid('workflow trace projection receipt must be an object')
  assertExactGrowthKeys(value, [
    'contractVersion', 'source', 'scope', 'subjectRef', 'version', 'disposition',
    'digest', 'outcome', 'candidateIds',
  ], 'workflow trace projection receipt')
  if (value['contractVersion'] !== ASSISTANT_GROWTH_CONTRACT_VERSION
    || (value['outcome'] !== 'applied' && value['outcome'] !== 'replayed')
    || !Array.isArray(value['candidateIds']) || value['candidateIds'].length > 1_000) {
    invalid('workflow trace projection receipt tuple is invalid')
  }
  const candidateIds = value['candidateIds'].map(item => canonicalText(
    item,
    'workflow candidate id',
    200,
    { identifier: identifierPattern },
  ))
  const sorted = [...new Set(candidateIds)].sort()
  if (sorted.length !== candidateIds.length
    || sorted.some((entry, index) => entry !== candidateIds[index])) {
    invalid('workflow candidate ids must be unique and sorted')
  }
  const receipt = Object.freeze({
    contractVersion: ASSISTANT_GROWTH_CONTRACT_VERSION,
    source: validateWorkflowTraceSourceAttestation(value['source']),
    scope: validateWorkflowScope(value['scope']),
    subjectRef: exactGrowthDigest(value['subjectRef'], 'subjectRef'),
    version: Number.isSafeInteger(value['version']) && (value['version'] as number) >= 1
      ? value['version'] as number
      : invalid('workflow trace receipt version is invalid'),
    disposition: value['disposition'] === 'upsert' || value['disposition'] === 'retract'
      ? value['disposition']
      : invalid('workflow trace receipt disposition is invalid'),
    digest: exactGrowthDigest(value['digest'], 'workflow trace receipt digest'),
    outcome: value['outcome'],
    candidateIds: Object.freeze(sorted),
  } satisfies WorkflowTraceProjectionReceipt)
  if (expected !== undefined) {
    const revision = validateWorkflowTraceRevision(expected)
    if (canonicalGrowthJson({
      source: receipt.source,
      scope: receipt.scope,
      subjectRef: receipt.subjectRef,
      version: receipt.version,
      disposition: receipt.disposition,
      digest: receipt.digest,
    }) !== canonicalGrowthJson({
      source: revision.source,
      scope: revision.scope,
      subjectRef: revision.subjectRef,
      version: revision.version,
      disposition: revision.disposition,
      digest: revision.digest,
    })) {
      throw new AssistantGrowthContractError('receipt-mismatch', 'workflow trace receipt changed revision identity')
    }
  }
  return receipt
}

export function validateGrowthWorkflowTraceSourceRegistration(
  value: unknown,
): GrowthWorkflowTraceSourceRegistration {
  if (!isGrowthRecord(value)) invalid('workflow trace registration must be an object')
  assertExactGrowthKeys(
    value,
    ['contractVersion', 'sourceId', 'generation', 'authorityDigest', 'dispose'],
    'workflow trace registration',
  )
  if (value['contractVersion'] !== ASSISTANT_GROWTH_CONTRACT_VERSION
    || typeof value['dispose'] !== 'function') invalid('workflow trace registration tuple is invalid')
  const source = validateWorkflowTraceSourceAttestation({
    sourceId: value['sourceId'],
    generation: value['generation'],
    authorityDigest: value['authorityDigest'],
  })
  return Object.freeze({
    contractVersion: ASSISTANT_GROWTH_CONTRACT_VERSION,
    ...source,
    dispose: value['dispose'] as () => void,
  })
}
