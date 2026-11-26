import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { TrustedTaskLearningProjectionReceipt } from '@dsh-ray/assistant-evaluation'
import {
  ensureEvalPoolSchema,
  EvalPoolError,
  evaluateEvalPoolEligibility,
  getEvalPoolTask,
  listEvalPool,
  retractEvalPoolTask,
  upsertEvalPoolFromReceipt,
  withdrawEvalPoolTask,
  type EvalPoolVerifierPeer,
} from '../src/eval-pool.js'
import { evaluateHoldout, resolveHoldoutSeedKey } from '../src/holdout.js'
import { openAssociationDatabase } from '../src/sqlite.js'
import { computeOwnerScopeKey, computePrincipalDigest } from '../src/types.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assoc-eval-pool-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeScopeKey(label = 'owner-eval-pool'): string {
  return computeOwnerScopeKey({
    mode: 'delivery',
    principalDigest: computePrincipalDigest(label),
    principalRecordId: `pr-${label}`,
    principalVersion: 1,
    workspace: '/ws/eval-pool',
    agentPreset: 'primary',
  })
}

function findSubjectRefByHoldout(
  seedKey: Buffer,
  wantHoldout: boolean,
  subjectKind: TrustedTaskLearningProjectionReceipt['projection']['subjectKind'] = 'automation-run',
  prefix = 'run',
): string {
  let idx = 0
  while (true) {
    const ref = `${prefix}-${idx}`
    idx += 1
    const taskId = `${subjectKind}:${ref}`
    if (evaluateHoldout(seedKey, taskId, 1250).inHoldout === wantHoldout) {
      return ref
    }
  }
}

function makeReceipt(options: {
  subjectKind?: TrustedTaskLearningProjectionReceipt['projection']['subjectKind']
  subjectRef: string
  version?: number
  disposition?: 'upsert' | 'retract'
  sourceId?: string
  objectiveStatus?: 'achieved' | 'partial' | 'not-achieved' | 'unknown'
  contractRef?: string
  contractDigest?: string
  receiptRef?: string
  receiptDigest?: string
  omitContract?: boolean
  omitReceipt?: boolean
  evidenceOnExecution?: boolean
}): TrustedTaskLearningProjectionReceipt {
  const subjectKind = options.subjectKind ?? 'automation-run'
  const version = options.version ?? 1
  const contractRef = options.contractRef ?? `contract-${options.subjectRef}`
  const contractDigest = options.contractDigest ?? sha(`contract:${options.subjectRef}`)
  const receiptRef = options.receiptRef ?? `receipt-${options.subjectRef}`
  const receiptDigest = options.receiptDigest ?? sha(`receipt:${options.subjectRef}`)
  const sourceId = options.sourceId ?? 'assistant-verifier'

  const evidence = [
    ...(options.omitContract
      ? []
      : [{ kind: 'acceptance-contract', ref: contractRef, digest: contractDigest }]),
    ...(options.omitReceipt
      ? []
      : [{ kind: 'verification-receipt', ref: receiptRef, digest: receiptDigest }]),
    { kind: subjectKind, ref: options.subjectRef },
  ]

  return {
    triggerOutcomeId: `outcome-${options.subjectRef}-v${version}`,
    scope: { workspace: '/ws/eval-pool', preset: 'primary' },
    scopeKey: sha('scope'),
    scopeWatermark: version,
    situation: `Verify deployment workflow for ${options.subjectRef}`,
    execution: {
      outcomeId: `exec-${options.subjectRef}`,
      status: 'succeeded',
      source: { kind: options.evidenceOnExecution ? 'evaluator' : 'automation', id: options.evidenceOnExecution ? sourceId : 'assistant-automations' },
      evidence: options.evidenceOnExecution ? evidence : [{ kind: 'run', ref: options.subjectRef }],
      occurredAt: 1_000,
      evaluator: { id: 'assistant-verifier', version: '1' },
    },
    objective: {
      outcomeId: `obj-${options.subjectRef}`,
      status: options.objectiveStatus ?? 'achieved',
      source: { kind: 'evaluator', id: sourceId },
      evidence: options.evidenceOnExecution ? [] : evidence,
      occurredAt: 2_000,
      evaluator: { id: 'assistant-verifier', version: '1' },
    },
    projection: {
      subjectKind,
      subjectRef: options.subjectRef,
      version,
      digest: sha(`proj:${options.subjectRef}:v${version}`),
      disposition: options.disposition ?? 'upsert',
      evidenceOutcomeId: `obj-${options.subjectRef}`,
    },
  }
}

describe('eval-pool eligibility & verifier provenance', () => {
  test('requires upsert, both acceptance-contract & verification-receipt evidence with 64-hex digests, and verifier provenance', () => {
    const missingContract = makeReceipt({ subjectRef: 'r1', omitContract: true })
    expect(evaluateEvalPoolEligibility(missingContract)).toEqual({
      eligible: false,
      reason: 'missing-acceptance-contract',
    })

    const missingReceipt = makeReceipt({ subjectRef: 'r2', omitReceipt: true })
    expect(evaluateEvalPoolEligibility(missingReceipt)).toEqual({
      eligible: false,
      reason: 'missing-verification-receipt',
    })

    const badDigest = makeReceipt({ subjectRef: 'r3', contractDigest: 'not-64-hex' })
    expect(evaluateEvalPoolEligibility(badDigest)).toEqual({
      eligible: false,
      reason: 'missing-acceptance-contract',
    })

    const nonVerifierSource = makeReceipt({
      subjectRef: 'r4',
      sourceId: 'assistant-delivery',
    })
    expect(evaluateEvalPoolEligibility(nonVerifierSource)).toEqual({
      eligible: false,
      reason: 'missing-verifier-provenance',
    })

    // Non-verifier source (e.g. owner revision) becomes eligible when assistantVerifier confirms matching contract + receipt + scope
    const matchingVerifier: EvalPoolVerifierPeer = {
      inspectAcceptedTask: (contractId) => ({
        contract: {
          id: contractId,
          digest: sha('contract:r4'),
          scope: { workspace: '/ws/eval-pool', preset: 'primary' },
        },
        state: 'done',
        receipt: {
          id: 'receipt-r4',
          contractDigest: sha('contract:r4'),
          digest: sha('receipt:r4'),
        },
      }),
    }
    expect(evaluateEvalPoolEligibility(nonVerifierSource, { assistantVerifier: matchingVerifier })).toEqual({
      eligible: true,
      contractRef: 'contract-r4',
      contractDigest: sha('contract:r4'),
      receiptRef: 'receipt-r4',
      receiptDigest: sha('receipt:r4'),
    })

    // Mismatched digest from verifier rejects even if source.id === 'assistant-verifier'
    const mismatchedVerifier: EvalPoolVerifierPeer = {
      inspectAcceptedTask: (contractId) => ({
        contract: {
          id: contractId,
          digest: sha('tampered-contract'),
          scope: { workspace: '/ws/eval-pool', preset: 'primary' },
        },
        state: 'done',
        receipt: {
          id: 'receipt-r5',
          digest: sha('receipt:r5'),
        },
      }),
    }
    expect(
      evaluateEvalPoolEligibility(makeReceipt({ subjectRef: 'r5' }), {
        assistantVerifier: mismatchedVerifier,
      }),
    ).toEqual({
      eligible: false,
      reason: 'verifier-mismatch',
    })

    // Evidence on execution.evidence is also accepted
    const onExec = makeReceipt({ subjectRef: 'r6', evidenceOnExecution: true })
    expect(evaluateEvalPoolEligibility(onExec).eligible).toBe(true)
  })
})

describe('assoc_eval_pool persistence, holdout partitioning & retraction', () => {
  test('partitions eligible receipts into replay vs holdout, skips ineligible receipts, and excludes retracted/withdrawn tasks immediately', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'eval-pool.sqlite')
    const db = openAssociationDatabase(dbPath)
    try {
      ensureEvalPoolSchema(db)
      const seedKey = resolveHoldoutSeedKey({ databasePath: dbPath })
      const scopeKey = makeScopeKey('pool-1')

      // Throws when holdoutSeedKey === null
      expect(() =>
        upsertEvalPoolFromReceipt(db, {
          ownerScopeKey: scopeKey,
          receipt: makeReceipt({ subjectRef: 'run-null' }),
          holdoutSeedKey: null,
        }),
      ).toThrow(EvalPoolError)

      const replayRef = findSubjectRefByHoldout(seedKey, false, 'automation-run', 'rep')
      const holdoutRef = findSubjectRefByHoldout(seedKey, true, 'automation-run', 'ho')

      // R1: eligible replay task
      const r1 = upsertEvalPoolFromReceipt(db, {
        ownerScopeKey: scopeKey,
        receipt: makeReceipt({ subjectRef: replayRef }),
        holdoutSeedKey: seedKey,
        toolNames: ['read', 'test'],
        nowMs: 10_000,
      })
      expect(r1.eligible).toBe(true)
      if (r1.eligible) {
        expect(r1.entry.poolKind).toBe('replay')
        expect(r1.entry.inHoldout).toBe(false)
        expect(r1.entry.toolNames).toEqual(['read', 'test'])
      }

      // R2: eligible holdout task
      const r2 = upsertEvalPoolFromReceipt(db, {
        ownerScopeKey: scopeKey,
        receipt: makeReceipt({ subjectRef: holdoutRef }),
        holdoutSeedKey: seedKey,
        nowMs: 11_000,
      })
      expect(r2.eligible).toBe(true)
      if (r2.eligible) {
        expect(r2.entry.poolKind).toBe('holdout')
        expect(r2.entry.inHoldout).toBe(true)
      }

      // R3: missing verifier evidence -> never enters pool
      const r3 = upsertEvalPoolFromReceipt(db, {
        ownerScopeKey: scopeKey,
        receipt: makeReceipt({ subjectRef: 'no-verifier', omitReceipt: true }),
        holdoutSeedKey: seedKey,
        nowMs: 12_000,
      })
      expect(r3.eligible).toBe(false)
      expect(r3.action).toBe('skipped')

      expect(listEvalPool(db, scopeKey, { poolKind: 'replay' }).map((e) => e.subjectRef)).toEqual([
        replayRef,
      ])
      expect(listEvalPool(db, scopeKey, { poolKind: 'holdout' }).map((e) => e.subjectRef)).toEqual([
        holdoutRef,
      ])

      // R4: upsert then retract via projection disposition === 'retract'
      const r4Ref = findSubjectRefByHoldout(seedKey, false, 'foreground-turn', 'ret')
      const r4Up = upsertEvalPoolFromReceipt(db, {
        ownerScopeKey: scopeKey,
        receipt: makeReceipt({ subjectKind: 'foreground-turn', subjectRef: r4Ref, version: 1 }),
        holdoutSeedKey: seedKey,
        nowMs: 13_000,
      })
      expect(r4Up.eligible).toBe(true)
      expect(getEvalPoolTask(db, scopeKey, `foreground-turn:${r4Ref}`)).not.toBeNull()

      const r4Retract = upsertEvalPoolFromReceipt(db, {
        ownerScopeKey: scopeKey,
        receipt: makeReceipt({
          subjectKind: 'foreground-turn',
          subjectRef: r4Ref,
          version: 2,
          disposition: 'retract',
        }),
        holdoutSeedKey: seedKey,
        nowMs: 14_000,
      })
      expect(r4Retract.eligible).toBe(false)
      expect(r4Retract.action).toBe('retracted')
      expect(getEvalPoolTask(db, scopeKey, `foreground-turn:${r4Ref}`)).toBeNull()
      expect(
        listEvalPool(db, scopeKey).map((e) => e.taskId),
      ).not.toContain(`foreground-turn:${r4Ref}`)
      expect(
        getEvalPoolTask(db, scopeKey, `foreground-turn:${r4Ref}`, { includeRetracted: true })?.status,
      ).toBe('retracted')

      // Stale v1 upsert must NOT overwrite v2 retraction
      const stale = upsertEvalPoolFromReceipt(db, {
        ownerScopeKey: scopeKey,
        receipt: makeReceipt({ subjectKind: 'foreground-turn', subjectRef: r4Ref, version: 1 }),
        holdoutSeedKey: seedKey,
        nowMs: 15_000,
      })
      expect(stale.eligible).toBe(false)
      expect(stale.action).toBe('skipped')
      if (!stale.eligible) {
        expect(stale.reason).toBe('stale-version')
      }

      // Direct retractEvalPoolTask & withdrawEvalPoolTask immediately exclude tasks
      expect(retractEvalPoolTask(db, scopeKey, `automation-run:${holdoutRef}`, { updatedAt: 16_000 })).toBe(true)
      expect(listEvalPool(db, scopeKey, { poolKind: 'holdout' })).toEqual([])

      expect(withdrawEvalPoolTask(db, scopeKey, `automation-run:${replayRef}`, { updatedAt: 17_000 })).toBe(true)
      expect(listEvalPool(db, scopeKey)).toEqual([])
    } finally {
      db.close()
    }
  })

  test('enriches entities and toolNames from assoc_nodes when present', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'eval-enrich.sqlite')
    const db = openAssociationDatabase(dbPath)
    try {
      const seedKey = resolveHoldoutSeedKey({ databasePath: dbPath })
      const scopeKey = makeScopeKey('enrich')
      const subjectRef = findSubjectRefByHoldout(seedKey, false, 'goal-outcome', 'g')
      const taskId = `goal-outcome:${subjectRef}`

      db.prepare(`
        INSERT INTO assoc_nodes (
          id, kind, source_plugin, source_ref, source_version, owner_scope_key,
          owner_mode, principal_digest, principal_record_id, principal_version,
          scope_mode, workspace, agent_preset, trust, sensitivity, title, body,
          entities_json, tokens_json, metadata_json, ttl_ms, expires_at, status,
          created_at, updated_at
        ) VALUES (
          'a:e-goal-1', 'episode', 'assistant-evaluation', ?, 1, ?,
          'delivery', ?, 'pr-enrich', 1,
          'workspace', '/ws/eval-pool', 'primary', 'trusted', 'private', 'goal run', 'body',
          '["custom-entity"]', '[]', '{"toolNames":["read","edit","test"]}', NULL, NULL, 'active',
          1000, 1000
        )
      `).run(taskId, scopeKey, sha('enrich'))

      const res = upsertEvalPoolFromReceipt(db, {
        ownerScopeKey: scopeKey,
        receipt: makeReceipt({ subjectKind: 'goal-outcome', subjectRef }),
        holdoutSeedKey: seedKey,
        nowMs: 2000,
      })
      expect(res.eligible).toBe(true)
      if (res.eligible) {
        expect(res.entry.entities).toContain('custom-entity')
        expect(res.entry.toolNames).toEqual(['read', 'edit', 'test'])
      }
    } finally {
      db.close()
    }
  })
})
