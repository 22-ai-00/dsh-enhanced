import { describe, expect, test } from 'vitest'
import {
  ASSISTANT_GROWTH_CONTRACT_VERSION,
  GROWTH_EFFECT_BLOCKER_PROTOCOL,
  growthPortPayloadDigest,
  validateExternalPrincipalId,
  validateGrowthPromotionReceipt,
  validateResolvedWorkflowAutomationTemplate,
  validateGrowthShadowReceipt,
  validateWorkflowTraceRevision,
  withGrowthPortReceiptDigest,
  workflowArgumentShapeDigest,
  workflowAutomationTemplateContentDigest,
  workflowCandidateSignature,
  workflowTraceRevisionDigest,
  type GrowthAutomationArtifactRequest,
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
