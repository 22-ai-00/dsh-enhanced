import { describe, expect, test } from 'vitest'
import {
  ASSISTANT_GROWTH_CONTRACT_VERSION,
  GROWTH_EFFECT_BLOCKER_PROTOCOL,
  brandPreferenceMemoryPromotionProducer,
  growthPortPayloadDigest,
  isTrustedPreferenceMemoryPromotionProducer,
  resolveTrustedPreferenceMemoryPromotionProducer,
  validateExternalPrincipalId,
  validateGrowthPromotionReceipt,
  validateResolvedWorkflowAutomationTemplate,
  validateGrowthShadowReceipt,
  validateWorkflowTraceRevision,
  unbrandPreferenceMemoryPromotionProducer,
  withGrowthPortReceiptDigest,
  PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
  validatePreferenceMemoryPromotionCancellationReceipt,
  validatePreferenceMemoryPromotionRequest,
  validatePreferenceMemoryPromotionResult,
  validatePreferenceMemoryPromotionSubmissionReceipt,
  withPreferenceMemoryPromotionCancellationDigest,
  withPreferenceMemoryPromotionCancellationReceiptDigest,
  withPreferenceMemoryPromotionRequestDigest,
  withPreferenceMemoryPromotionResultDigest,
  withPreferenceMemoryPromotionSubmissionDigest,
  workflowArgumentShapeDigest,
  workflowAutomationTemplateContentDigest,
  workflowCandidateSignature,
  workflowTraceRevisionDigest,
  type GrowthAutomationArtifactRequest,
  type PreferenceMemoryPromotionProducer,
  type WorkflowTraceRevision,
} from '../src/index.ts'

const sha = 'a'.repeat(64)
const anotherSha = 'b'.repeat(64)

function artifactRequest(): GrowthAutomationArtifactRequest {
  return {
    contractVersion: ASSISTANT_GROWTH_CONTRACT_VERSION,
    operationId: 'experiment-1:promotion',
    experimentId: 'experiment-1',
    candidateId: 'candidate-1',
    candidateRevision: 2,
    candidateDigest: sha,
    artifactId: 'automation-growth-candidate-1',
    artifactVersion: 1,
    artifactDigest: anotherSha,
  }
}

function trace(): WorkflowTraceRevision {
  const content = {
    scope: { workspace: '/workspace', preset: 'default' },
    ownerBindingId: 'binding-1',
    principalId: 'lark/bot/tenant/owner',
    name: 'Daily summary',
    prompt: 'Summarize the latest owner-visible work.',
    schedule: { kind: 'cron' as const, expression: '0 9 * * *', timezone: 'UTC' },
    timeoutMs: 60_000,
    toolCatalogIds: ['assistant.agent-turn'],
    deliveryBindingId: 'binding-1',
  }
  const templateDigest = workflowAutomationTemplateContentDigest(content)
  const payload = {
    source: { sourceId: 'assistantDelivery' as const, generation: 1, authorityDigest: sha },
    scope: content.scope,
    subjectRef: anotherSha,
    version: 7,
    disposition: 'upsert' as const,
    evidence: {
      occurredAt: 1_000,
      signal: 'owner-explicit' as const,
      objectiveStatus: 'unknown' as const,
      ownerBindingId: 'binding-1',
      taskRef: sha,
      template: {
        templateRef: `workflow-template:${templateDigest}`,
        templateDigest,
        privacyAttestation: {
          kind: 'owner-explicit' as const,
          limitation: 'deidentification-unproven' as const,
          attestationId: 'workflow-review:one',
          attestationDigest: sha,
        },
      },
      steps: [{
        catalogId: 'assistant.agent-turn',
        argumentSchemaDigest: workflowArgumentShapeDigest({ prompt: 'redacted' }),
      }],
    },
  }
  return { ...payload, digest: workflowTraceRevisionDigest(payload) }
}

describe('assistant growth shared contract', () => {
  test('owns the exact revocable Preference promotion producer brand', () => {
    const producer: PreferenceMemoryPromotionProducer = {
      trustedMemoryPromotionProducerGeneration: () => 'preference-generation:1',
      registerTrustedMemoryPromotionResultSink: () => () => {},
    }
    const wrapper = new Proxy(producer, {})

    expect(isTrustedPreferenceMemoryPromotionProducer(producer)).toBe(false)
    expect(isTrustedPreferenceMemoryPromotionProducer(wrapper)).toBe(false)
    brandPreferenceMemoryPromotionProducer(producer)
    expect(isTrustedPreferenceMemoryPromotionProducer(producer)).toBe(true)
    expect(isTrustedPreferenceMemoryPromotionProducer(wrapper)).toBe(true)
    expect(resolveTrustedPreferenceMemoryPromotionProducer(producer)).toBe(producer)
    expect(resolveTrustedPreferenceMemoryPromotionProducer(wrapper)).toBe(producer)
    expect(isTrustedPreferenceMemoryPromotionProducer({ ...producer })).toBe(false)
    const revocable = Proxy.revocable(producer, {})
    expect(resolveTrustedPreferenceMemoryPromotionProducer(revocable.proxy)).toBe(producer)
    revocable.revoke()
    expect(resolveTrustedPreferenceMemoryPromotionProducer(revocable.proxy)).toBeUndefined()
    expect(isTrustedPreferenceMemoryPromotionProducer(revocable.proxy)).toBe(false)

    unbrandPreferenceMemoryPromotionProducer(producer)
    unbrandPreferenceMemoryPromotionProducer(producer)
    expect(isTrustedPreferenceMemoryPromotionProducer(producer)).toBe(false)
    expect(isTrustedPreferenceMemoryPromotionProducer(wrapper)).toBe(false)
    expect(resolveTrustedPreferenceMemoryPromotionProducer(wrapper)).toBeUndefined()
  })

  test('strictly binds the fixed low-sensitivity preference promotion protocol', () => {
    const request = withPreferenceMemoryPromotionRequestDigest({
      contractVersion: 1 as const,
      promotionId: 'promotion-1',
      promotionGeneration: 1,
      idempotencyKey: 'promotion-1:g1',
      scope: { workspace: '/workspace', preset: 'default' },
      principalId: 'lark/main/tenant/owner',
      principalLineage: { principalRecordId: 'principal-row-1', principalVersion: 2 },
      ownerGeneration: 3,
      hypothesis: {
        id: 'hypothesis-1', key: 'memory.retention' as const, value: 'long-term' as const,
        version: 4, confidenceBps: 9_000, contradictionBps: 500,
        supportingSignals: 3, distinctSignalSources: 2, evidenceMass: 3_000,
      },
      rendererId: PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
      observedAt: 1_000,
      deadlineAt: 2_000,
    })
    expect(validatePreferenceMemoryPromotionRequest(request)).toEqual(request)
    expect(() => validatePreferenceMemoryPromotionRequest({
      ...request, hypothesis: { ...request.hypothesis, key: 'external.commitments' },
    })).toThrow(/allowlist|digest/iu)
    expect(() => validatePreferenceMemoryPromotionRequest({
      ...request, freeText: 'remember everything',
    })).toThrow(/shape/iu)

    const submission = withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-1',
    })
    expect(validatePreferenceMemoryPromotionSubmissionReceipt(submission, request)).toEqual(submission)

    const confirmed = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'confirmed' as const, memoryProposalId: 'memory-proposal-1',
      memoryProposalVersion: 2, memoryRecordId: 'memory-record-1', memoryRecordVersion: 1,
      memoryRecordDigest: sha, occurredAt: 1_500,
    })
    expect(validatePreferenceMemoryPromotionResult(confirmed, request)).toEqual(confirmed)
    expect(() => validatePreferenceMemoryPromotionResult(withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'rejected' as const, rejectionKind: 'system' as never,
      memoryProposalId: 'memory-proposal-1', memoryProposalVersion: 2, occurredAt: 1_500,
    }), request)).toThrow(/owner rejection/iu)

    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      principalLineage: request.principalLineage, ownerGeneration: request.ownerGeneration,
      reason: 'forget' as const, occurredAt: 1_600,
    })
    const cancellationReceipt = withPreferenceMemoryPromotionCancellationReceiptDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      cancellationDigest: cancellation.cancellationDigest, outcome: 'cancelled' as const,
    })
    expect(validatePreferenceMemoryPromotionCancellationReceipt(cancellationReceipt, cancellation))
      .toEqual(cancellationReceipt)
    expect(() => validatePreferenceMemoryPromotionCancellationReceipt(
      withPreferenceMemoryPromotionCancellationReceiptDigest({
        contractVersion: 1 as const, promotionId: request.promotionId,
        promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
        cancellationDigest: cancellation.cancellationDigest, outcome: 'already-confirmed' as const,
      }), cancellation,
    )).toThrow(/compensation/iu)
  })

  test('argument shape ignores scalar values, array order, and array length', () => {
    expect(workflowArgumentShapeDigest({ count: 1, flags: [true, 'x', true] }))
      .toBe(workflowArgumentShapeDigest({ count: 42, flags: ['secret', false] }))
    expect(workflowArgumentShapeDigest({ count: 1 })).not.toBe(workflowArgumentShapeDigest({ value: 1 }))
  })

  test('rejects a template with no executable catalog action', () => {
    expect(() => workflowAutomationTemplateContentDigest({
      scope: { workspace: '/workspace', preset: 'default' },
      ownerBindingId: 'binding-1',
      principalId: 'lark/bot/tenant/owner',
      name: 'Empty workflow',
      prompt: 'Do the task.',
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      timeoutMs: 60_000,
      toolCatalogIds: [],
      deliveryBindingId: 'binding-1',
    })).toThrow(/tool catalog/i)
  })

  test('requires a canonical four-component external principal in private templates', () => {
    expect(validateExternalPrincipalId('lark/bot%2Fprod/tenant/user%40example.com'))
      .toBe('lark/bot%2Fprod/tenant/user%40example.com')
    expect(() => validateExternalPrincipalId('lark/bot/tenant/user@example.com')).toThrow(/canonical/i)
    expect(() => validateExternalPrincipalId('lark/bot%2fprod/tenant/owner')).toThrow(/canonical/i)
    expect(() => validateExternalPrincipalId('lark/bot/tenant/owner/extra')).toThrow(/four components/i)
  })

  test('binds resolved private material to the principal included in its digest', () => {
    const content = {
      scope: { workspace: '/workspace', preset: 'default' },
      ownerBindingId: 'binding-1',
      principalId: 'lark/bot/tenant/owner',
      name: 'Daily summary',
      prompt: 'Summarize the latest owner-visible work.',
      schedule: { kind: 'cron' as const, expression: '0 9 * * *', timezone: 'UTC' },
      timeoutMs: 60_000,
      toolCatalogIds: ['assistant.agent-turn'],
      deliveryBindingId: 'binding-1',
    }
    const templateDigest = workflowAutomationTemplateContentDigest(content)
    const resolved = {
      contractVersion: ASSISTANT_GROWTH_CONTRACT_VERSION,
      template: {
        templateRef: `workflow-template:${templateDigest}`,
        templateDigest,
        privacyAttestation: {
          kind: 'owner-explicit' as const,
          limitation: 'deidentification-unproven' as const,
          attestationId: 'workflow-review:one',
          attestationDigest: sha,
        },
      },
      ...content,
    }
    expect(validateResolvedWorkflowAutomationTemplate(resolved).principalId)
      .toBe('lark/bot/tenant/owner')
    expect(() => validateResolvedWorkflowAutomationTemplate({
      ...resolved,
      principalId: 'lark/bot/tenant/replacement',
    })).toThrow(/digest is stale/i)
  })

  test('keeps candidate replay stable but separates owner binding generations', () => {
    const revision = trace()
    const input = { scope: revision.scope, evidence: revision.evidence! }
    const signature = workflowCandidateSignature(input)
    expect(workflowCandidateSignature(input)).toBe(signature)
    expect(workflowCandidateSignature({
      ...input,
      evidence: { ...input.evidence, ownerBindingId: 'binding-3' },
    })).not.toBe(signature)
  })

  test('validates a source-bound trace digest and rejects a forged source generation', () => {
    const revision = trace()
    expect(validateWorkflowTraceRevision(revision)).toEqual(revision)
    expect(() => validateWorkflowTraceRevision({
      ...revision,
      source: { ...revision.source, generation: 2 },
    })).toThrow(/digest/i)
  })

  test('never accepts owner-explicit privacy as verified repetition proof', () => {
    const revision = trace()
    const evidence = { ...revision.evidence!, signal: 'verified-repetition' as const,
      objectiveStatus: 'achieved' as const, taskEvidenceDigest: sha }
    const payload = { ...revision, evidence }
    expect(() => workflowTraceRevisionDigest({
      source: payload.source,
      scope: payload.scope,
      subjectRef: payload.subjectRef,
      version: payload.version,
      disposition: payload.disposition,
      evidence,
    })).toThrow(/deidentification/i)
  })

  test('requires a code-level effect blocker tuple on shadow receipts', () => {
    const request = artifactRequest()
    const receipt = withGrowthPortReceiptDigest({
      ...request,
      outcome: 'passed' as const,
      effectsBlocked: true as const,
      effectBlockerAttestation: {
        contract: GROWTH_EFFECT_BLOCKER_PROTOCOL,
        blockedEffects: ['delivery', 'tool-execution'] as const,
        implementationDigest: sha,
      },
      shadowDigest: anotherSha,
    })
    expect(validateGrowthShadowReceipt(receipt, request).effectsBlocked).toBe(true)
    const { receiptDigest: _receiptDigest, ...payload } = receipt
    expect(() => validateGrowthShadowReceipt(withGrowthPortReceiptDigest({
      ...payload,
      effectBlockerAttestation: { ...receipt.effectBlockerAttestation, blockedEffects: ['delivery'] },
    }), request)).toThrow(/effect blocker/i)
  })

  test('promotion returns the exact next artifact version and digest', () => {
    const request = artifactRequest()
    const receipt = withGrowthPortReceiptDigest({
      ...request,
      outcome: 'promoted' as const,
      resultingArtifactVersion: 2,
      resultingArtifactDigest: sha,
    })
    expect(validateGrowthPromotionReceipt(receipt, request)).toMatchObject({
      resultingArtifactVersion: 2,
      resultingArtifactDigest: sha,
    })
    expect(growthPortPayloadDigest(request)).toMatch(/^[a-f0-9]{64}$/u)
  })
})
