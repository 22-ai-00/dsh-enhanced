import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantWorkItemsService,
  WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL,
  classifyIntake,
  type Config,
  type WorkItemIntakeInput,
  WorkItemError,
} from '../src/index.ts'
import { WorkItemStore } from '../src/store.ts'
import { deriveWithdrawalOutcome } from '../src/outcome.ts'
import { deliveryPeer, fakeAcceptance, harness, INBOX, PRESET, signal, WORKSPACE, type Harness } from './fixtures.ts'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const SECRET_CANARY_TEXT = 'CONFIDENTIAL_CANARY_BODY_DO_NOT_LEAK_9f8e7d'
const SECRET_CANARY_BRIEF = 'CONFIDENTIAL_CANARY_BRIEF_DO_NOT_LEAK_4a3b2c'
const RULE = 'triage-rule'

const tempDirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart().catch(() => {})))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function intakeInput(sourceEventId: string, overrides: Partial<WorkItemIntakeInput> = {}): WorkItemIntakeInput {
  return {
    source: 'lark-channel',
    sourceEventId,
    kind: 'message',
    senderAllowlisted: true,
    addressed: false,
    threadFollowUp: false,
    senderIsBot: false,
    contentDigest: sha256(`${SECRET_CANARY_TEXT}:${sourceEventId}`),
    occurredAt: 1_700_000_000_000,
    ...overrides,
  }
}

function recordEval(
  fixture: Harness,
  eventId: string,
  options: {
    source?: string
    ruleId?: string
    policyVersion?: string
    mode?: 'observe' | 'auto'
    wouldAccept?: boolean
    level?: 'ignore' | 'digest' | 'notify' | 'accept'
  } = {},
) {
  const source = options.source ?? 'lark-channel'
  const contentDigest = sha256(`${SECRET_CANARY_TEXT}:${eventId}`)
  if (fixture.store.getIntake(source, eventId) === undefined) {
    fixture.store.recordIntake(classifyIntake(intakeInput(eventId, { source, contentDigest })))
  }
  const level = options.level ?? (options.wouldAccept === false ? 'notify' : 'accept')
  const wouldAccept = options.wouldAccept ?? (level === 'accept')
  return fixture.store.recordIntakeEvaluation({
    source,
    sourceEventId: eventId,
    ruleId: options.ruleId ?? RULE,
    policyVersion: options.policyVersion ?? 'v1',
    sourceDigest: contentDigest,
    mode: options.mode ?? 'observe',
    status: 'decided',
    level,
    proposedLevel: level,
    ceiling: 'accept',
    quoteSpans: [[0, 12]],
    reasons: [],
    wouldAccept,
    attempts: 1,
    decidedAt: fixture.now(),
  }).record
}

function admitAndLink(
  fixture: Harness,
  eventId: string,
  options: {
    ruleId?: string
    policyVersion?: string
    withOutcome?: 'observed-achieved' | 'withdrawn' | 'report-failed'
    withVerdict?: 'achieved' | 'not-achieved'
    admitDelayMs?: number
    outcomeDelayMs?: number
  } = {},
) {
  const ruleId = options.ruleId ?? RULE
  const policyVersion = options.policyVersion ?? 'v1'
  const evalRecord = fixture.store.getIntakeEvaluation('lark-channel', eventId, ruleId, policyVersion)
    ?? recordEval(fixture, eventId, { ruleId, policyVersion, mode: 'auto', wouldAccept: true })

  if (options.admitDelayMs !== undefined) fixture.advance(options.admitDelayMs)
  const admitted = fixture.admission.admit(signal({
    externalId: `intake:${eventId}`,
    title: `Secret Title ${SECRET_CANARY_BRIEF}`,
    brief: SECRET_CANARY_BRIEF,
  }))
  if (!admitted.created) throw new Error(`unexpected admit replay: ${admitted.reason ?? 'unknown'}`)
  const item = admitted.item

  fixture.store.recordIntakeAdmission({
    source: evalRecord.source,
    sourceEventId: evalRecord.sourceEventId,
    ruleId: evalRecord.ruleId,
    policyVersion: evalRecord.policyVersion,
    mode: 'auto',
    outcome: 'admitted',
    reasonCode: null,
    decisionId: `decision-${eventId}`,
    itemId: item.id,
  })

  if (options.withOutcome === 'withdrawn') {
    fixture.advance(options.outcomeDelayMs ?? 100)
    fixture.store.withdrawByDedupKey(item.dedupKey)
  } else if (options.withOutcome === 'observed-achieved') {
    fixture.advance(options.outcomeDelayMs ?? 100)
    const occId = `occ-${eventId}`
    const runId = `run-${eventId}`
    fixture.store.markDispatchDispatched(item.id, occId)
    fixture.ledger.claim({ itemId: item.id, runId, occurrenceId: occId })
    fixture.ledger.report({
      itemId: item.id,
      runId,
      status: 'ready',
      summary: SECRET_CANARY_BRIEF,
      artifactPaths: [],
      idempotencyKey: `rep-${eventId}`,
    })
    const pendingOutcome = fixture.store.latestOutcome(item.id)!
    fixture.advance(10)
    const settledAt = fixture.now()
    fixture.store.settleOutcome({
      itemId: item.id,
      revision: pendingOutcome.revision,
      evidence: {
        inboxId: INBOX,
        executionStatus: 'succeeded',
        completionSequence: 5,
        completedAt: settledAt,
      },
      reason: null,
      degraded: false,
      expired: false,
    })
  } else if (options.withOutcome === 'report-failed') {
    fixture.advance(options.outcomeDelayMs ?? 100)
    const occId = `occ-${eventId}`
    const runId = `run-${eventId}`
    fixture.store.markDispatchDispatched(item.id, occId)
    fixture.ledger.claim({ itemId: item.id, runId, occurrenceId: occId })
    fixture.ledger.report({
      itemId: item.id,
      runId,
      status: 'failed',
      summary: SECRET_CANARY_BRIEF,
      artifactPaths: [],
      idempotencyKey: `rep-fail-${eventId}`,
    })
  }

  if (options.withVerdict !== undefined) {
    fixture.advance(options.outcomeDelayMs ?? 150)
    const t = fixture.now()
    const verifier = fakeAcceptance()
    const handle = verifier.handle()
    fixture.store.recordAcceptanceVerdict({
      itemId: item.id,
      verifier: 'assistant-verifier',
      contractId: handle.contractId,
      contractDigest: handle.contractDigest,
      receiptId: `rcpt-${eventId}`,
      receiptDigest: sha256(`rcpt-${eventId}`),
      objectiveStatus: options.withVerdict,
      completedAt: t,
    })
  }

  return item
}

async function serviceConfig(overrides: Partial<Config> = {}): Promise<Config & { databasePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wi-eval-feed-'))
  tempDirs.push(dir)
  return {
    enabled: true,
    mode: 'observe',
    databasePath: join(dir, 'work-items.sqlite'),
    workRoot: join(dir, 'work'),
    intakeLedger: {
      enabled: true,
      sources: {
        'lark-channel': { unaddressedGroupMessages: true },
        'event-triggers': { unsubscribedEvents: true },
      },
      evaluation: {
        enabled: true,
      },
    },
    ...overrides,
  }
}

describe('listIntakeEvaluationFeed (WP22)', () => {
  test('maintains strictly monotonic cursor pagination across timestamp ties and afterSeq/keyset cursors', async () => {
    const f = await harness()
    // 4 items sharing identical timestamp at base now(), followed by 3 items advancing clock
    for (const id of ['ev-1', 'ev-2', 'ev-3', 'ev-4']) recordEval(f, id)
    f.advance(1_000); recordEval(f, 'ev-5', { source: 'event-triggers', wouldAccept: false, level: 'notify' })
    f.advance(1_000); recordEval(f, 'ev-6', { ruleId: 'second-rule', policyVersion: 'v2' })
    f.advance(1_000); recordEval(f, 'ev-7')

    const seenKeyset: string[] = []
    const seqsKeyset: number[] = []
    let cursor: { afterRecordedAt?: number; afterId?: string } = {}
    for (let guard = 0; guard < 10; guard += 1) {
      const page = f.store.listIntakeEvaluationFeed({ ...cursor, limit: 2 })
      expect(page.protocol).toBe(WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL)
      for (const item of page.items) {
        seenKeyset.push(item.sourceEventId)
        seqsKeyset.push(item.seq)
      }
      if (!page.hasMore) break
      cursor = {
        afterRecordedAt: page.nextCursor!.afterRecordedAt,
        afterId: page.nextCursor!.afterId,
      }
    }
    expect(seenKeyset).toHaveLength(7)
    expect(new Set(seenKeyset).size).toBe(7)
    expect(seqsKeyset).toEqual([1, 2, 3, 4, 5, 6, 7])

    // Identical traversal via afterSeq only (via ledger facade as well)
    const seenSeq: string[] = []
    let afterSeq = 0
    for (let guard = 0; guard < 10; guard += 1) {
      const page = f.ledger.listIntakeEvaluationFeed({ afterSeq, limit: 2 })
      for (const item of page.items) seenSeq.push(item.sourceEventId)
      if (!page.hasMore) break
      afterSeq = page.nextCursor!.afterSeq
    }
    expect(seenSeq).toEqual(seenKeyset)

    // Determinism across repeated reads and clean schema 13 check
    expect(f.store.stats().schemaVersion).toBe(13)
    expect(f.store.listIntakeEvaluationFeed({ limit: 5000 }).items.map(i => i.id))
      .toEqual(f.store.listIntakeEvaluationFeed({ limit: 50 }).items.map(i => i.id))
  })

  test('links outcomes, owner withdrawals and verdicts, advances recordedAt on late outcome, filters cleanly and leaks zero raw text', async () => {
    const f = await harness()
    const itemA = admitAndLink(f, 'om-a', { admitDelayMs: 100 })
    f.advance(100)
    recordEval(f, 'om-obs', { mode: 'observe', wouldAccept: false, level: 'digest' })
    f.advance(100)
    const itemB = admitAndLink(f, 'om-b', {
      admitDelayMs: 100,
      withOutcome: 'observed-achieved',
      outcomeDelayMs: 100,
      withVerdict: 'achieved',
    })

    // Initial sync: all 3 evaluations present, outcome filter + workspace/preset match
    const allBefore = f.store.listIntakeEvaluationFeed({ limit: 10 })
    expect(allBefore.items.map(i => i.sourceEventId)).toEqual(['om-a', 'om-obs', 'om-b'])
    const cursorAfterInitial = allBefore.nextCursor!

    expect(f.store.listIntakeEvaluationFeed({ onlyWithOutcome: true, workspace: '/work/other' }).items).toEqual([])
    const onlyOutcomeBefore = f.store.listIntakeEvaluationFeed({ onlyWithOutcome: true, workspace: WORKSPACE, preset: PRESET })
    expect(onlyOutcomeBefore.items).toHaveLength(1)
    expect(onlyOutcomeBefore.items[0]).toMatchObject({
      sourceEventId: 'om-b',
      wouldAccept: true,
      evaluationLevel: 'accept',
      itemId: itemB.id,
      scope: { workspace: WORKSPACE, preset: PRESET },
      outcome: { settledBy: 'observed-evidence', executionStatus: 'succeeded', objectiveStatus: 'unknown', evidenceState: 'observed', ownerWithdrawn: false },
      acceptanceVerdict: { objectiveStatus: 'achieved' },
      ownerCorrection: null,
    })

    // Later at +500ms, owner withdraws itemA -> effective recordedAt advances past cursorAfterInitial!
    f.advance(500)
    const withdrawnAt = f.now()
    expect(deriveWithdrawalOutcome(withdrawnAt).settledBy).toBe('withdrawn')
    f.store.withdrawByDedupKey(itemA.dedupKey)

    const incremental = f.store.listIntakeEvaluationFeed({
      afterRecordedAt: cursorAfterInitial.afterRecordedAt,
      afterId: cursorAfterInitial.afterId,
      limit: 10,
    })
    expect(incremental.items).toHaveLength(1)
    expect(incremental.items[0]).toMatchObject({
      sourceEventId: 'om-a',
      itemId: itemA.id,
      outcome: { settledBy: 'withdrawn', ownerWithdrawn: true },
      ownerCorrection: { kind: 'withdrawn', stateReason: 'signal-withdrawn', recordedAt: withdrawnAt },
      recordedAt: withdrawnAt,
    })

    // Zero raw body/title/brief leakage across the serialized feed
    const serialized = JSON.stringify(f.store.listIntakeEvaluationFeed({ limit: 50 }))
    expect(serialized).not.toContain(SECRET_CANARY_TEXT)
    expect(serialized).not.toContain(SECRET_CANARY_BRIEF)
    expect(serialized).not.toContain('"brief"')
    expect(serialized).not.toContain('"title"')
  })

  test('rejects invalid cursors/options fail-closed and keeps disabled-by-default & closed parity with service restart continuation', async () => {
    const disabledCfg = await serviceConfig({ enabled: false })
    const disabledCtx = new Context(); contexts.push(disabledCtx)
    await disabledCtx.plugin(AssistantWorkItemsService, disabledCfg).await()
    const disabledSvc = disabledCtx.assistantWorkItems
    expect(disabledSvc.listIntakeEvaluationFeed()).toEqual({
      protocol: WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL,
      items: [],
      hasMore: false,
      nextCursor: null,
    })
    expect(() => disabledSvc.listIntakeEvaluationFeed({ afterSeq: -1 })).toThrow(WorkItemError)
    expect(() => disabledSvc.listIntakeEvaluationFeed({ limit: 0 })).toThrow(WorkItemError)
    expect(() => disabledSvc.listIntakeEvaluationFeed({ afterId: 'only-id-no-time' })).toThrow(WorkItemError)
    expect(() => disabledSvc.listIntakeEvaluationFeed({ unknownOption: true } as never)).toThrow(WorkItemError)

    // Without intakeLedger enabled, returns empty cleanly
    const noLedgerCfg = await serviceConfig({ intakeLedger: { enabled: false } })
    const noLedgerCtx = new Context(); contexts.push(noLedgerCtx)
    noLedgerCtx.provide('assistantDelivery' as never, deliveryPeer() as never)
    await noLedgerCtx.plugin(AssistantWorkItemsService, noLedgerCfg).await()
    expect(noLedgerCtx.assistantWorkItems.listIntakeEvaluationFeed()).toEqual({
      protocol: WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL,
      items: [],
      hasMore: false,
      nextCursor: null,
    })

    // Enabled service: write via SQLite store, read via service, restart service, and continue cleanly
    const activeCfg = await serviceConfig()
    const ctx1 = new Context(); contexts.push(ctx1)
    ctx1.provide('assistantDelivery' as never, deliveryPeer() as never)
    await ctx1.plugin(AssistantWorkItemsService, activeCfg).await()
    let storeNow = 10_000
    const rawStore = new WorkItemStore(activeCfg.databasePath, { now: () => storeNow })
    try {
      for (const [index, ts] of [10_000, 11_000, 12_000].entries()) {
        storeNow = ts
        const eventId = `svc-ev-${index + 1}`
        const digest = sha256(`${SECRET_CANARY_TEXT}:${eventId}`)
        rawStore.recordIntake(classifyIntake(intakeInput(eventId, { contentDigest: digest, occurredAt: ts })))
        rawStore.recordIntakeEvaluation({
          source: 'lark-channel', sourceEventId: eventId, ruleId: RULE, policyVersion: 'v1',
          sourceDigest: digest, mode: 'observe', status: 'decided', level: 'accept', proposedLevel: 'accept',
          ceiling: 'accept', quoteSpans: [], reasons: [], wouldAccept: true, attempts: 1, decidedAt: ts,
        })
      }
    } finally {
      rawStore.close()
    }
    const page1 = ctx1.assistantWorkItems.listIntakeEvaluationFeed({ limit: 2 })
    expect(page1.items.map(i => i.sourceEventId)).toEqual(['svc-ev-1', 'svc-ev-2'])
    expect(page1.hasMore).toBe(true)

    await ctx1.fiber.restart()
    contexts.splice(contexts.indexOf(ctx1), 1)

    const ctx2 = new Context(); contexts.push(ctx2)
    ctx2.provide('assistantDelivery' as never, deliveryPeer() as never)
    await ctx2.plugin(AssistantWorkItemsService, activeCfg).await()
    const page2 = ctx2.assistantWorkItems.listIntakeEvaluationFeed({
      afterRecordedAt: page1.nextCursor!.afterRecordedAt,
      afterId: page1.nextCursor!.afterId,
      limit: 2,
    })
    expect(page2.items.map(i => i.sourceEventId)).toEqual(['svc-ev-3'])
    expect(page2.hasMore).toBe(false)

    // Schema stays strictly at 13 on disk
    const db = new DatabaseSync(activeCfg.databasePath, { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
    } finally {
      db.close()
    }

    ctx2.assistantWorkItems.close()
    expect(ctx2.assistantWorkItems.listIntakeEvaluationFeed().items).toEqual([])
  })
})
