import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { registerWorkItemTools } from '../src/tools.ts'
import type { AssistantWorkItemsService } from '../src/service.ts'
import type { WorkItemClaimView } from '../src/service.ts'
import { admitted, claim, harness, type Harness } from './fixtures.ts'

const TICKET_SOURCE = (kind: string) => kind === 'ticket'
  ? { source: 'ticket-board', generation: 'gen-1' }
  : kind === 'pull-request'
    ? { source: 'pull-request-board', generation: 'gen-1' }
    : undefined

/** Reports with an explicit summary so resume ordering/truncation is observable. */
function reportWith(
  fixture: Harness,
  itemId: string,
  runId: string,
  status: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed',
  summary: string,
  key: string,
) {
  return fixture.ledger.report({
    itemId,
    runId,
    status,
    summary,
    artifactPaths: [],
    idempotencyKey: key,
  })
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

describe('resume brief derivation', () => {
  test('a first claim has no prior history to resume', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id, 'run-first')

    const resume = fixture.store.workItemResumeContext(item.id)
    expect(resume).toBeDefined()
    expect(resume).toMatchObject({
      resumed: false,
      priorAttempts: 0,
      attempts: [],
      reports: [],
      reportsTotal: 0,
      latestOutcome: null,
      truncated: false,
    })
    // The current attempt's own `claimed` event is not prior history.
    expect(fixture.store.events(item.id).filter(event => event.kind === 'claimed')).toHaveLength(1)
  })

  test('reports the prior attempt, its ending and the prior report summaries', async () => {
    const fixture = await harness({}, { threadSource: TICKET_SOURCE })
    const item = await admitted(fixture, { follows: [{ kind: 'ticket', ref: 'TICKET-1' }] })
    claim(fixture, item.id, 'run-one')
    reportWith(fixture, item.id, 'run-one', 'progress', 'first progress note', 'one-progress')
    // A terminal report on an item that still follows an open thread is parked
    // in `waiting` (claimable again) and records its status on the attempt.
    reportWith(fixture, item.id, 'run-one', 'blocked', 'blocked on the upstream thread', 'one-blocked')
    claim(fixture, item.id, 'run-two')

    const resume = fixture.store.workItemResumeContext(item.id)
    expect(resume).toBeDefined()
    expect(resume?.priorAttempts).toBe(1)
    expect(resume?.resumed).toBe(true)
    expect(resume?.truncated).toBe(false)
    expect(resume?.attempts).toHaveLength(1)
    expect(resume?.attempts[0]).toEqual({
      attempt: 1,
      runId: 'run-one',
      startedAt: 1_700_000_000_000,
      ended: 'reported',
      terminalStatus: 'blocked',
    })
    expect(resume?.reports.map(report => [report.revision, report.status, report.summary])).toEqual([
      [1, 'progress', 'first progress note'],
      [2, 'blocked', 'blocked on the upstream thread'],
    ])
    expect(resume?.reportsTotal).toBe(2)
    // The deferred outcome is not written until the thread closes.
    expect(resume?.latestOutcome).toBeNull()
  })

  test('carries the latest settled outcome across a re-claim', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id, 'run-one')
    reportWith(fixture, item.id, 'run-one', 'failed', 'attempt one failed', 'one-failed')

    // A settled item is terminal; the only store-level path that re-opens it is
    // an authority park (revalidation denial) followed by restoration. That is
    // the same public pair the service uses, without a full peer harness here.
    fixture.store.parkAuthority(item.id, 'authority-revoked', { reason: 'test-park' }, fixture.now())
    fixture.store.restoreAuthority(item.id, fixture.now())
    claim(fixture, item.id, 'run-two')

    const resume = fixture.store.workItemResumeContext(item.id)
    expect(resume).toBeDefined()
    expect(resume?.priorAttempts).toBe(1)
    expect(resume?.attempts[0]).toMatchObject({ attempt: 1, runId: 'run-one', ended: 'reported', terminalStatus: 'failed' })
    expect(resume?.latestOutcome).toEqual({
      revision: 1,
      settledBy: 'report-failed',
      executionStatus: 'failed',
      objectiveStatus: 'not-achieved',
      evidenceState: 'not-applicable',
      evidenceReason: null,
      settledAt: 1_700_000_000_000,
    })
    expect(resume?.resumed).toBe(true)
  })

  test('an expired lease ends the attempt as expired, and a reclaim restarts it', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id, 'run-one')
    fixture.advance(fixture.config.limits.leaseMs + 1)
    claim(fixture, item.id, 'run-two')

    const resume = fixture.store.workItemResumeContext(item.id)
    expect(resume).toBeDefined()
    expect(resume?.priorAttempts).toBe(1)
    expect(resume?.attempts).toHaveLength(1)
    expect(resume?.attempts[0]).toMatchObject({ attempt: 1, runId: 'run-one', ended: 'expired' })
    expect(resume?.attempts[0]?.terminalStatus).toBeNull()
    expect(resume?.reports).toHaveLength(0)
    expect(resume?.reportsTotal).toBe(0)
    expect(resume?.latestOutcome).toBeNull()
    expect(resume?.resumed).toBe(true)
  })

  test('caps prior attempts and reports while keeping real totals and safe summaries', async () => {
    const fixture = await harness({ limits: { maxAttempts: 9, maxReportsPerItem: 40 } })
    const item = await admitted(fixture)
    const longSummary = `${'é'.repeat(300)}`
    for (let index = 1; index <= 8; index += 1) {
      claim(fixture, item.id, `run-${String(index)}`)
      const summary = index <= 4 ? `short summary ${String(index)}` : longSummary
      reportWith(fixture, item.id, `run-${String(index)}`, 'progress', summary, `cap-${String(index)}`)
      fixture.advance(fixture.config.limits.leaseMs + 1)
    }

    const resume = fixture.store.workItemResumeContext(item.id)
    expect(resume).toBeDefined()
    expect(resume?.priorAttempts).toBe(7)
    expect(resume?.attempts.map(attempt => attempt.attempt)).toEqual([3, 4, 5, 6, 7])
    expect(resume?.attempts.every(attempt => attempt.ended === 'expired')).toBe(true)
    expect(resume?.reports.map(report => report.revision)).toEqual([4, 5, 6, 7, 8])
    expect(resume?.reportsTotal).toBe(8)
    expect(resume?.truncated).toBe(true)
    expect(resume?.reports[0]?.summaryTruncated).toBe(false)
    expect(resume?.reports.slice(1).every(report => report.summaryTruncated)).toBe(true)
    for (const report of resume?.reports ?? []) {
      expect(utf8Bytes(report.summary)).toBeLessThanOrEqual(512)
    }
    // The long summaries are cut at a UTF-8 boundary, never mid code point.
    expect(resume?.reports[1]?.summary).toBe('é'.repeat(256))
  })

  test('never leaks another item into the brief', async () => {
    const fixture = await harness()
    const alpha = await admitted(fixture)
    claim(fixture, alpha.id, 'run-alpha')
    reportWith(fixture, alpha.id, 'run-alpha', 'progress', 'alpha-only detail', 'alpha-progress')
    fixture.advance(fixture.config.limits.leaseMs + 1)
    claim(fixture, alpha.id, 'run-alpha-two')

    const beta = await admitted(fixture, { externalId: 'ext-beta' })
    claim(fixture, beta.id, 'run-beta')

    const alphaResume = fixture.store.workItemResumeContext(alpha.id)
    const betaResume = fixture.store.workItemResumeContext(beta.id)
    expect(alphaResume?.reports.map(report => report.summary)).toEqual(['alpha-only detail'])
    expect(alphaResume?.attempts[0]?.runId).toBe('run-alpha')
    expect(betaResume?.resumed).toBe(false)
    expect(betaResume?.priorAttempts).toBe(0)
    expect(betaResume?.attempts).toHaveLength(0)
    expect(betaResume?.reports).toHaveLength(0)
    expect(betaResume?.reportsTotal).toBe(0)
    expect(betaResume?.latestOutcome).toBeNull()
  })

  test('a replayed claim returns the identical brief without appending history', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id, 'run-replay')
    const before = fixture.store.workItemResumeContext(item.id)
    const eventsBefore = fixture.store.events(item.id).length
    const claimIdBefore = fixture.store.findClaimByRun('run-replay')?.claimId

    const replay = claim(fixture, item.id, 'run-replay')
    expect(replay.replayed).toBe(true)
    const after = fixture.store.workItemResumeContext(item.id)
    expect(after).toEqual(before)
    expect(fixture.store.events(item.id)).toHaveLength(eventsBefore)
    expect(fixture.store.findClaimByRun('run-replay')?.claimId).toBe(claimIdBefore)
    expect(fixture.store.reportCount(item.id)).toBe(0)
    expect(fixture.store.findItemById(item.id)?.attempt).toBe(1)
  })

  test('an absent item has no resume brief', async () => {
    const fixture = await harness()
    expect(fixture.store.workItemResumeContext('missing-item')).toBeUndefined()
  })
})

describe('resume brief tool projection', () => {
  test('omits null optionals and keeps the output schema strict', async () => {
    const registered: Array<Record<string, unknown>> = []
    registerWorkItemTools(
      { tools: { register: (tool: unknown) => { registered.push(tool as Record<string, unknown>) } } } as unknown as Context,
      {
        claim: () => ({
          itemId: 'item-1',
          runId: 'run-1',
          state: 'claimed',
          kind: 'review',
          externalId: 'ext-1',
          title: 'Title',
          brief: 'Brief',
          briefTruncated: false,
          acceptanceRef: null,
          workDir: '/work/item-1',
          attempt: 2,
          maxAttempts: 3,
          leaseUntil: null,
          replayed: false,
          resume: {
            resumed: true,
            priorAttempts: 1,
            attempts: [{ attempt: 1, runId: null, startedAt: 10, ended: null, terminalStatus: null }],
            reports: [{ revision: 1, status: 'progress', summary: 'note', summaryTruncated: false, recordedAt: 11 }],
            reportsTotal: 1,
            latestOutcome: null,
            truncated: false,
          },
        } satisfies WorkItemClaimView),
      } as unknown as AssistantWorkItemsService,
    )

    const tool = registered.find(entry => entry['name'] === 'work_item_claim')
    expect(tool).toBeDefined()
    const output = tool?.['output'] as {
      schema: {
        required: readonly string[]
        properties: {
          resume: { additionalProperties: boolean; required: readonly string[]; properties: Record<string, unknown> }
        }
      }
    }
    // `defineTool` normalizes the DSL's per-property `required: true` flags into
    // JSON-Schema `required` arrays, so strictness is asserted on both levels.
    expect(output.schema.required).toContain('resume')
    expect(output.schema.properties.resume.additionalProperties).toBe(false)
    expect(output.schema.properties.resume.required).toEqual([
      'resumed', 'priorAttempts', 'attempts', 'reports', 'reportsTotal', 'truncated',
    ])
    expect(Object.keys(output.schema.properties.resume.properties)).toEqual([
      'resumed', 'priorAttempts', 'attempts', 'reports', 'reportsTotal', 'latestOutcome', 'truncated',
    ])

    const execute = tool?.['execute'] as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
    const value = await execute({}, { agent: {} })
    expect(value).not.toHaveProperty('acceptanceRef')
    expect(value).not.toHaveProperty('leaseUntil')
    const resume = value['resume'] as Record<string, unknown>
    expect(Object.keys(resume)).toEqual(['resumed', 'priorAttempts', 'attempts', 'reports', 'reportsTotal', 'truncated'])
    expect((resume['attempts'] as Array<Record<string, unknown>>)[0]).toEqual({ attempt: 1, startedAt: 10 })
    expect((resume['reports'] as Array<Record<string, unknown>>)[0]).toMatchObject({ revision: 1, summary: 'note' })
  })
})
