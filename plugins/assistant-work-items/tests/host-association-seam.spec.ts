import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, test } from 'vitest'
import { OUTCOME_EVIDENCE_SOURCE } from '../src/outcome.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import type { WorkItemChangeEvent, WorkItemHostInspectScope } from '../src/types.ts'
import { AUTHORITY_HASH, BASELINE_SEQUENCE, INBOX, harness, receipt } from './fixtures.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

test('inspectOwnerWorkItems validates owner route and reads active + observe items, while onWorkItemChange emits post-commit events across admit/claim/report/settle/withdraw', async () => {
  const f = await harness()
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.restart() })

  const routeReceipt = receipt({
    authorityId: f.config.scope!.ownerRouteId,
    principalId: f.config.scope!.principalId,
    workspace: f.config.scope!.workspace,
    agentPreset: f.config.scope!.preset,
  })
  const delivery = {
    validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => {
      if (input.authorityId !== routeReceipt.authorityId || input.principalId !== routeReceipt.principalId
        || input.workspace !== routeReceipt.workspace || input.agentPreset !== routeReceipt.agentPreset) {
        throw Object.assign(new Error('missing-binding'), { code: 'missing-binding' })
      }
      return routeReceipt
    },
    listOwnerForegroundTaskSources: () => ({
      items: [{
        protocol: OUTCOME_EVIDENCE_SOURCE,
        inboxId: INBOX,
        sourceDigest: 'sha256:digest',
        completionSequence: BASELINE_SEQUENCE + 1,
        authorityId: routeReceipt.authorityId,
        authorityHash: AUTHORITY_HASH,
        principalId: routeReceipt.principalId,
        scope: { workspace: routeReceipt.workspace, preset: routeReceipt.agentPreset },
        binding: { id: 'binding-1', version: 3, generation: 2, sessionId: 'session-1' },
        execution: {
          dispatchedAt: 1_700_000_000_000,
          status: 'succeeded',
          quiescent: true,
          completedAt: 1_700_000_100_000,
          executionRef: 'exec-1',
        },
      }],
      nextCursor: null,
      watermark: BASELINE_SEQUENCE + 1,
      hasMore: false,
    }),
  }
  const policy = {
    authorize: () => ({ effect: 'allow', reasonCode: 'test-allow' }),
    evaluate: () => ({ effect: 'allow', reasonCode: 'test-allow' }),
    authorizeAgent: () => ({ effect: 'allow', reasonCode: 'test-allow' }),
  }
  ctx.provide('assistantDelivery' as never, delivery as never)
  ctx.provide('assistantPolicy' as never, policy as never)
  ctx.provide('assistantAutomations' as never, {
    ingestExternal: ({ automationId, eventId, occurredAt }: { automationId: string; eventId: string; occurredAt: number }) => ({
      id: `occ-${eventId}`, automationId, triggerKind: 'external', triggerKey: eventId,
      scheduledAt: occurredAt, status: 'pending', dryRun: false, createdAt: occurredAt, updatedAt: occurredAt,
    }),
  } as never)

  const service = new AssistantWorkItemsService(ctx, {
    enabled: true,
    mode: 'active',
    databasePath: f.config.databasePath,
    workRoot: f.config.workRoot,
    workerAutomationId: f.config.workerAutomationId!,
    scope: { ...f.config.scope!, expiresAt: Date.now() + 600_000 },
    admission: { allowedKinds: ['repair', 'review'] },
    settlement: { enabled: true },
  })
  cleanups.push(async () => { service.close() })

  const events: WorkItemChangeEvent[] = []
  const unsub = service.onWorkItemChange(event => events.push(event))

  // 1. Admit
  const admittedResult = service.admit({
    kind: 'repair',
    externalId: 'ext-1',
    title: 'Fix failing test',
    brief: 'Investigate unit test flake',
    originBindingId: 'binding-1',
    provenance: {
      source: 'owner-foreground-failures',
      sourceVersion: '1',
      signalDigest: 'a'.repeat(64),
      observedAt: Date.now(),
      evidence: {
        inboxId: INBOX,
        completionSequence: BASELINE_SEQUENCE,
        authorityHash: AUTHORITY_HASH,
      },
    },
  })
  expect(events.map(e => `${e.op}:${e.itemId}`)).toEqual([`upsert:${admittedResult.item.id}`])

  // 2. Claim
  const occId = admittedResult.dispatch.occurrenceId!
  const workerAgent = {
    id: 'worker-agent',
    session: { id: 'worker-sess', header: { cwd: f.config.scope!.workspace, agentPreset: f.config.scope!.preset } },
    ctx: { get: (name: string) => name === 'assistantAutomationExecution'
      ? Object.freeze({ mode: 'production', automationId: f.config.workerAutomationId!, occurrenceId: occId })
      : undefined },
  } as unknown as Agent
  service.claim(workerAgent)
  expect(events).toHaveLength(2)
  expect(events[1]?.op).toBe('upsert')

  // 3. Report
  await service.report(workerAgent, {
    status: 'ready',
    summary: 'Fixed the flaky check',
    idempotencyKey: 'rep-1',
  })
  expect(events).toHaveLength(3)
  expect(events[2]?.op).toBe('upsert')

  // 4. Settle (matches foreground source -> observed)
  const settledReport = service.settleOutcomes(true)
  expect(settledReport.settled).toBe(1)
  expect(events).toHaveLength(4)
  expect(events[3]).toMatchObject({ op: 'upsert', itemId: admittedResult.item.id })

  // 5. Inspect via Host seam
  const hostScope: WorkItemHostInspectScope = {
    principalId: routeReceipt.principalId,
    principalRecordId: routeReceipt.principalRecordId,
    principalVersion: routeReceipt.principalVersion,
    workspace: routeReceipt.workspace,
    preset: routeReceipt.agentPreset,
    ownerRouteId: routeReceipt.authorityId,
  }
  const items = service.inspectOwnerWorkItems(hostScope)
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    id: admittedResult.item.id,
    kind: 'repair',
    externalId: 'ext-1',
    title: 'Fix failing test',
    state: 'ready',
    lastReportStatus: 'ready',
    lastReportSummary: 'Fixed the flaky check',
    revisionCount: 1,
  })

  // Mismatched scope fails closed via Delivery route validation
  expect(() => service.inspectOwnerWorkItems({
    ...hostScope,
    principalId: 'other-principal',
  })).toThrow(/owner route/)

  // 6. Admit second item and withdraw it
  const second = service.admit({
    kind: 'review',
    externalId: 'ext-2',
    title: 'Cancel me',
    brief: 'Signal to be withdrawn',
    originBindingId: 'binding-1',
  })
  const countBeforeWithdraw = events.length
  const withdrawn = service.withdraw({
    kind: 'review',
    externalId: 'ext-2',
    title: 'Cancel me',
    brief: 'Signal to be withdrawn',
    originBindingId: 'binding-1',
  })
  expect(withdrawn.outcome).toBe('withdrawn')
  expect(events.slice(countBeforeWithdraw)).toEqual([{
    op: 'withdraw',
    itemId: second.item.id,
    scope: hostScope,
  }])

  unsub()
})
