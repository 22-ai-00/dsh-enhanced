import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, symbols } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { createTaskAcceptanceContract } from '@dsh-ray/task-acceptance-contract'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantWorkItemsService } from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('AssistantWorkItemsService live Cordis Proxy surface (T3-EW-02 & F03)', () => {
  test('all getters, WP22/WP21 intake tuning, confidenceThresholdPpm/minUtility gating, and lifecycle methods work via Cordis Proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wi-proxy-'))
    dirs.push(dir)
    const wiDb = join(dir, 'wi.sqlite')
    const policyDb = join(dir, 'policy.sqlite')
    const objectiveText = 'Verify proxy-driven intake admission'
    const digest = sha256(objectiveText)
    const now = Date.now()
    const contract = createTaskAcceptanceContract({
      protocol: 'task-acceptance/v1',
      id: 'c-proxy-1',
      scope: { workspace: dir, preset: 'primary' },
      owner: { principalRecordId: 'owner-1', principalVersion: 1 },
      task: { kind: 'automation-run', ref: 'run-c-proxy-1' },
      objective: objectiveText,
      profile: { id: 'intake-profile', version: 1, digest: sha256('intake-profile') },
      issuedAt: now - 1_000,
      expiresAt: now + 3_600_000,
      criteria: [{
        id: 'result',
        kind: 'process-behavior',
        authority: { id: 'intake-runner', digest: sha256('intake-runner') },
        artifactPath: 'result.txt',
        stdin: '',
        expectedStdout: '',
        expectedExitCode: 0,
      }],
      bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
    })

    const ctx1 = new Context()
    contexts.push(ctx1)
    await ctx1.plugin(AssistantPolicyService, {
      databasePath: policyDb,
      rules: [{
        id: 'r-auto',
        effect: 'allow',
        subject: { kind: 'background', id: 'work-items/v1', workspace: dir, principal: 'web/a/t/u' },
        actions: ['admit'],
        resource: { kind: 'automation', id: 'worker-1' },
        context: { initiators: ['background'] },
      }],
    })
    ctx1.provide('assistantDelivery' as never, {
      isMaintenanceDraining: () => true,
      validateOwnerRoute: (value: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
        receiptVersion: 2,
        ...value,
        authorityHash: sha256('owner-auth'),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        bindingVersion: 1,
        generation: 1,
      }),
      enqueueBackground: async () => ({ id: 'outbox-1' }),
    } as never)
    ctx1.provide('assistantVerifier' as never, {
      inspectAcceptedTask: (id: string) => (id === contract.id
        ? { contract, state: 'awaiting-execution', attempts: 0, reason: null, receipt: null }
        : null),
    } as never)

    const wiConfig = {
      enabled: true,
      mode: 'active' as const,
      databasePath: wiDb,
      workRoot: dir,
      workerAutomationId: 'worker-1',
      scope: {
        workspace: dir,
        preset: 'primary',
        principalId: 'web/a/t/u',
        ownerRouteId: 'route-1',
        expiresAt: now + 86_400_000,
      },
      admission: { allowedKinds: ['intake-inferred'], maxOpenItems: 50, maxAdmitsPerHour: 50, cooldownMs: 0 },
      intakeLedger: {
        enabled: true,
        sources: { 'lark-channel': { unaddressedGroupMessages: true, unsubscribedEvents: false } },
        evaluation: {
          enabled: true,
          admit: { enabled: true, mode: 'observe' as const, kind: 'intake-inferred', originBindingId: 'b-1' },
        },
      },
    }

    await ctx1.plugin(AssistantWorkItemsService, wiConfig)
    const proxy = ctx1.get('assistantWorkItems')!
    const childProxy = ctx1.extend({}).assistantWorkItems
    expect((proxy as unknown as Record<symbol, unknown>)[symbols.original]).not.toBe(proxy)
    expect((childProxy as unknown as Record<symbol, unknown>)[symbols.original]).toBe(
      (proxy as unknown as Record<symbol, unknown>)[symbols.original],
    )

    // 5 getters
    expect(proxy.enabled).toBe(true)
    expect(proxy.mode).toBe('active')
    expect(proxy.diagnosisEnabled).toBe(false)
    expect(proxy.ownerContinuationEnabled).toBe(false)
    expect(proxy.ownerRecallEnabled).toBe(true)

    // Lifecycle & inspection methods via proxy
    expect(proxy.health().enabled).toBe(true)
    expect(childProxy.intakeAdmissionMode()).toBe('observe')
    expect(proxy.intakeTuning()).toEqual({ mode: 'observe', rules: [] })
    expect(proxy.intakeEvaluationHealth()?.enabled).toBe(true)
    expect(proxy.listObservedItems({ limit: 10 })).toEqual([])
    expect(proxy.listIntakeAdmissions({ limit: 10 })).toEqual([])
    expect(proxy.listIntakeEvaluationFeed({ limit: 10 }).items).toEqual([])
    expect(proxy.inspectIntakeQueue().pendingEvaluations).toBe(0)
    expect(proxy.outcomes()).toEqual([])
    expect(() => proxy.followUps('missing-item')).toThrow(/does not exist/u)
    expect(proxy.listReleasedFollowUps()).toEqual({ items: [], next: null })
    expect(() => childProxy.policyNotices('missing-item')).toThrow(/does not exist/u)
    const unsubChange = proxy.onWorkItemChange(() => {})
    unsubChange()
    const generation = proxy.trustedWorkItemProducerGeneration()
    expect(generation).toBeTruthy()
    const sinkReg: Record<string, unknown> = {
      protocol: 'assistant-work-items/evaluation/v1',
      generation,
      owner: {
        ownsTrustedAutomationEvaluationRegistration: () => false,
        ownsTrustedDeliveryEvaluationRegistration: () => false,
        ownsTrustedVerifierEvaluationRegistration: () => false,
        ownsTrustedWorkItemEvaluationRegistration: (value: unknown) => value === sinkReg,
      },
      append: async () => {},
    }
    const unsubSink = childProxy.registerTrustedWorkItemEvaluationSink(sinkReg as never)
    unsubSink()
    expect(proxy.sweepSignals(true).sources).toEqual([])
    expect(proxy.settleOutcomes().settled).toBe(0)

    // Register evaluator that attaches low confidencePpm on first call, high on second call
    let calls = 0
    const unregEval = proxy.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'r-auto', ceiling: 'accept' }] }),
      evaluate: () => {
        calls += 1
        return Promise.resolve({
          level: 'accept',
          quotes: ['Verify proxy-driven'],
          confidencePpm: calls === 1 ? 400_000 : 900_000,
          utility: calls === 1 ? 5 : 25,
        })
      },
    })

    // Apply tuning via proxy with threshold gates + auto mode
    const tuned = childProxy.applyIntakeTuning({
      workItemsMode: 'auto',
      intakeRuleUpdates: [{ ruleId: 'r-auto', enabled: true, mode: 'auto', confidenceThresholdPpm: 800_000, minUtility: 10 }],
    })
    expect(tuned.mode).toBe('auto')
    expect(proxy.intakeAdmissionMode()).toBe('auto')

    // First event has confidencePpm 400_000 < 800_000 -> clamped to ignore (not admitted)
    proxy.recordIntake({
      source: 'lark-channel',
      sourceEventId: 'evt-low-1',
      kind: 'message',
      senderAllowlisted: true,
      addressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      contentDigest: digest,
      occurredAt: now,
      objective: objectiveText,
      objectiveDigest: digest,
      acceptance: { contractId: contract.id, contractDigest: contract.digest },
    }, objectiveText)
    await new Promise(resolve => setTimeout(resolve, 10))
    await proxy.runIntakeEvaluation()
    expect(proxy.intakeEvaluations('lark-channel', 'evt-low-1')[0]?.wouldAccept).toBe(false)
    expect(proxy.runIntakeAdmission()).toEqual([])

    // Second event has distinct contentDigest, confidencePpm 900_000 >= 800_000 & utility 25 >= 10 -> admitted!
    const objectiveText2 = 'Verify proxy-driven second intake admission'
    const digest2 = sha256(objectiveText2)
    childProxy.recordIntake({
      source: 'lark-channel',
      sourceEventId: 'evt-high-2',
      kind: 'message',
      senderAllowlisted: true,
      addressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      contentDigest: digest2,
      occurredAt: now + 1,
      objective: objectiveText2,
      objectiveDigest: digest2,
      acceptance: { contractId: contract.id, contractDigest: contract.digest },
    }, objectiveText2)
    await new Promise(resolve => setTimeout(resolve, 10))
    await childProxy.runIntakeEvaluation()
    expect(proxy.intakeEvaluations('lark-channel', 'evt-high-2')[0]?.wouldAccept).toBe(true)
    const admissions = proxy.runIntakeAdmission()
    expect(admissions[0]).toMatchObject({ outcome: 'admitted', mode: 'auto' })
    expect(proxy.inspectIntakeProvenance(admissions[0]!.itemId!)).toMatchObject({ ruleId: 'r-auto', mode: 'auto' })
    expect(proxy.followUps(admissions[0]!.itemId!)).toEqual([])
    expect(childProxy.policyNotices(admissions[0]!.itemId!)).toEqual([])

    unregEval()
    await ctx1.fiber.restart()
    contexts.splice(contexts.indexOf(ctx1), 1)

    // Restart with static config mode: 'observe' -> persisted WP22 tuning survives
    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(AssistantPolicyService, { databasePath: policyDb })
    await ctx2.plugin(AssistantWorkItemsService, wiConfig)
    const proxy2 = ctx2.get('assistantWorkItems')!
    expect(proxy2.intakeAdmissionMode()).toBe('auto')
    expect(proxy2.intakeTuning().rules[0]).toMatchObject({ ruleId: 'r-auto', confidenceThresholdPpm: 800_000, minUtility: 10 })
    expect(proxy2.setIntakeAdmissionMode('observe')).toBe('observe')
  })
})
