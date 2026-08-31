import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GrowthExperimentsStore,
  GrowthExperimentsStoreError,
} from '../src/store.ts'
import {
  workflowArgumentShapeDigest,
  workflowTraceRevisionDigest,
} from '@dsh-enhanced/assistant-growth-contract'
import type { WorkflowTraceEvidence, WorkflowTraceRevision } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const digest = (character: string) => character.repeat(64)
const source = { sourceId: 'assistantDelivery' as const, generation: 1, authorityDigest: digest('e') }

function evidence(signal: 'owner-explicit' | 'verified-repetition' = 'verified-repetition'): WorkflowTraceEvidence {
  return {
    occurredAt: 10,
    signal,
    objectiveStatus: signal === 'verified-repetition' ? 'achieved' : 'unknown',
    ownerBindingId: 'owner-main',
    taskRef: digest('a'),
    ...(signal === 'verified-repetition' ? { taskEvidenceDigest: digest('b') } : {}),
    template: {
      templateRef: 'workflow.daily-triage',
      templateDigest: digest('e'),
      privacyAttestation: signal === 'verified-repetition'
        ? {
            kind: 'deterministic-deidentification' as const,
            method: 'assistant-delivery-redaction-v1' as const,
            attestationId: 'attestation.daily-triage',
            attestationDigest: digest('f'),
          }
        : {
            kind: 'owner-explicit' as const,
            limitation: 'deidentification-unproven' as const,
            attestationId: 'attestation.daily-triage',
            attestationDigest: digest('f'),
          },
    },
    steps: [
      { catalogId: 'queue.list', argumentSchemaDigest: digest('c') },
      { catalogId: 'queue.update', argumentSchemaDigest: digest('d') },
    ],
  }
}

function revision(input: {
  subject: string
  version: number
  disposition?: 'upsert' | 'retract'
  trace?: WorkflowTraceEvidence
}): WorkflowTraceRevision {
  const disposition = input.disposition ?? 'upsert'
  const trace = input.trace ?? { ...evidence(), taskRef: digest(input.subject) }
  const base = {
    source,
    scope: { workspace: '/work/alpha', preset: 'primary' },
    subjectRef: digest(input.subject),
    version: input.version,
    disposition,
    ...(disposition === 'upsert' ? { evidence: trace } : {}),
  } as const
  return { ...base, digest: workflowTraceRevisionDigest(base) }
}

function store(minRepeatedSuccesses = 3) {
  const root = mkdtempSync(join(tmpdir(), 'growth-store-')); roots.push(root)
  return new GrowthExperimentsStore({ path: join(root, 'growth.sqlite'), minRepeatedSuccesses, now: () => 100 })
}

describe('GrowthExperimentsStore trace ledger', () => {
  it('fingerprints argument shape without scalar values, array length or ordering', () => {
    const first = workflowArgumentShapeDigest({ query: 'secret one', limit: 10, tags: ['a', 'b'] })
    const second = workflowArgumentShapeDigest({ query: 'different secret', limit: 20, tags: ['z'] })
    expect(second).toBe(first)
    expect(workflowArgumentShapeDigest({ query: 10, limit: 20, tags: ['z'] })).not.toBe(first)
    expect(() => workflowArgumentShapeDigest({ bad: undefined })).toThrowError(/plain JSON/)
  })

  it('accepts first version N, exact replay and gaps while rejecting rollback and conflicts', () => {
    const value = store()
    const first = value.projectWorkflowTraceRevision(revision({ subject: '1', version: 5 }))
    expect(first.outcome).toBe('applied')
    expect(first.candidateIds).toHaveLength(1)
    expect(value.projectWorkflowTraceRevision(revision({ subject: '1', version: 5 })))
      .toEqual({ ...first, outcome: 'replayed' })
    expect(() => value.projectWorkflowTraceRevision({
      ...revision({ subject: '1', version: 5 }), digest: digest('f'),
    })).toThrowError(GrowthExperimentsStoreError)
    expect(() => value.projectWorkflowTraceRevision(revision({ subject: '1', version: 4 })))
      .toThrowError(/backwards/)
    expect(value.projectWorkflowTraceRevision(revision({ subject: '1', version: 9 })).outcome).toBe('applied')
    value.close()
  })

  it('forms an exact candidate at N trusted repetitions and recomputes retract/re-upsert without ABA', () => {
    const value = store(3)
    const first = value.projectWorkflowTraceRevision(revision({ subject: '1', version: 1 }))
    const candidateId = first.candidateIds[0]!
    value.projectWorkflowTraceRevision(revision({ subject: '2', version: 1 }))
    expect(value.getCandidate(candidateId)?.state).toBe('observing')
    value.projectWorkflowTraceRevision(revision({ subject: '3', version: 1 }))
    const ready = value.getCandidate(candidateId)!
    expect(ready).toMatchObject({ state: 'ready', evidenceCount: 3, verifiedSuccessCount: 3, revision: 3 })
    const experiment = value.beginReadyExperiment({ candidateId, maxDurationMs: 10_000 })
    expect(experiment.candidateSnapshot.evidenceDigest).toBe(ready.evidenceDigest)
    value.projectWorkflowTraceRevision(revision({ subject: '3', version: 2, disposition: 'retract' }))
    expect(value.getExperiment(experiment.id)).toMatchObject({
      state: 'approval-requesting', terminalCode: 'evidence-superseded',
    })
    const revised = value.getCandidate(candidateId)!
    expect(revised).toMatchObject({ state: 'observing', revision: 4, evidenceCount: 2 })
    value.projectWorkflowTraceRevision(revision({ subject: '3', version: 3 }))
    expect(value.getCandidate(candidateId)).toMatchObject({ state: 'ready', revision: 5, evidenceCount: 3 })
    expect(() => value.transitionExperiment({
      experimentId: experiment.id, expectedVersion: experiment.version,
      expectedState: experiment.state, state: 'promoted',
    })).toThrowError(/changed/)
    value.close()
  })

  it('does not count the same trusted task twice through different source subjects', () => {
    const value = store(2)
    const duplicate = evidence()
    const first = value.projectWorkflowTraceRevision(revision({ subject: '1', version: 1, trace: duplicate }))
    value.projectWorkflowTraceRevision(revision({ subject: '2', version: 1, trace: duplicate }))
    expect(value.getCandidate(first.candidateIds[0]!)).toMatchObject({
      evidenceCount: 2, verifiedSuccessCount: 1, state: 'observing',
    })
    value.close()
  })

  it('lets one owner-explicit trace qualify while rejecting non-achieved repetition atomically', () => {
    const value = store(10)
    const receipt = value.projectWorkflowTraceRevision(revision({
      subject: '1', version: 1, trace: evidence('owner-explicit'),
    }))
    expect(value.getCandidate(receipt.candidateIds[0]!)).toMatchObject({
      state: 'ready', ownerExplicitCount: 1, verifiedSuccessCount: 0,
    })
    const before = value.health()
    const invalid = evidence()
    expect(() => value.projectWorkflowTraceRevision(revision({
      subject: '2', version: 1,
      trace: { ...invalid, objectiveStatus: 'unknown' },
    }))).toThrowError(/achieved trusted evidence/)
    expect(value.health()).toEqual(before)
    value.close()
  })
})
