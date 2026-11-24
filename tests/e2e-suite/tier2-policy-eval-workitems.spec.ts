import { mkdirSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { getExportFn, getMethod, sha256Hex } from './helpers/assertions.ts'
import { runPluginSetupInProcess } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantEvaluation,
  loadAssistantPolicy,
  loadAssistantPolicyEvaluator,
  loadAssistantProactive,
  loadAssistantWorkItems,
  loadBenchmarkIndex,
  loadBenchmarkRunner,
  loadBenchmarkStore,
  loadFamiliesCorpus,
  loadNativeBenchmark,
  loadPackageModule,
  loadPluginSetup,
  loadTaskAcceptanceContract,
} from './helpers/packages.ts'
import { createWorkspaceTracker, type TempWorkspace } from './helpers/workspace.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

function basePolicyRequest(overrides: Record<string, unknown> = {}) {
  return {
    subject: { kind: 'agent', id: 'worker-1', workspace: '/work/proj', principal: 'web/a/t/u' },
    action: 'execute',
    resource: { kind: 'network', id: 'api.github.com' },
    context: { initiator: 'background' },
    ...overrides,
  }
}

function baseRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    effect: 'allow',
    subject: { kind: 'agent', id: 'worker-1' },
    actions: ['execute'],
    resource: { kind: 'network', id: '*' },
    context: { initiators: ['background'] },
    ...overrides,
  }
}

function activeWorkItemsConfig(
  ws: TempWorkspace,
  dbPath: string,
  admitMode: 'observe' | 'auto' = 'observe',
  kind = 'intake-inferred',
  overrides: Record<string, unknown> = {},
) {
  return {
    enabled: true,
    mode: 'active',
    databasePath: dbPath,
    workRoot: ws.workspace,
    workerAutomationId: 'worker-1',
    scope: {
      workspace: ws.workspace,
      preset: 'primary',
      principalId: 'web/a/t/u',
      ownerRouteId: 'route-1',
      expiresAt: Date.now() + 86_400_000,
    },
    admission: {
      allowedKinds: [kind],
      maxOpenItems: 100,
      maxAdmitsPerHour: 100,
      cooldownMs: 0,
    },
    intakeLedger: {
      enabled: true,
      sources: { 'lark-channel': { unaddressedGroupMessages: true, unsubscribedEvents: false } },
      evaluation: {
        enabled: true,
        admit: {
          enabled: true,
          mode: admitMode,
          kind,
          originBindingId: 'binding-origin-1',
        },
      },
    },
    ...overrides,
  }
}

async function mountWorkItemsPeers(
  ctx: ReturnType<typeof harness.createContext>,
  ws: TempWorkspace,
  policyDbName: string,
  objectiveText: string,
  contractId: string,
) {
  const { AssistantPolicyService } = await loadAssistantPolicy()
  const { createTaskAcceptanceContract } = await loadTaskAcceptanceContract()

  await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
    databasePath: ws.sqlitePath(policyDbName),
    rules: [
      {
        id: 'r-auto',
        effect: 'allow',
        subject: { kind: 'background', id: 'work-items/v1', workspace: ws.workspace, principal: 'web/a/t/u' },
        actions: ['admit'],
        resource: { kind: 'automation', id: 'worker-1' },
        context: { initiators: ['background'] },
      },
    ],
  })

  harness.provideMockService(ctx, 'assistantDelivery', {
    isMaintenanceDraining: () => true,
    validateOwnerRoute: (value: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
      receiptVersion: 2,
      ...value,
      authorityHash: sha256Hex('owner-auth'),
      principalRecordId: 'owner-1',
      principalVersion: 1,
      bindingVersion: 1,
      generation: 1,
    }),
    enqueueBackground: async () => ({ id: 'outbox-1' }),
  })

  const issuedAt = Date.now() - 1_000
  const contract = (createTaskAcceptanceContract as (input: Record<string, unknown>) => { id: string; digest: string })({
    protocol: 'task-acceptance/v1',
    id: contractId,
    scope: { workspace: ws.workspace, preset: 'primary' },
    owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task: { kind: 'automation-run', ref: `run-${contractId}` },
    objective: objectiveText,
    profile: { id: 'intake-profile', version: 1, digest: sha256Hex('intake-profile') },
    issuedAt,
    expiresAt: issuedAt + 3_600_000,
    criteria: [{
      id: 'result',
      kind: 'process-behavior',
      authority: { id: 'intake-runner', digest: sha256Hex('intake-runner') },
      artifactPath: 'result.txt',
      stdin: '',
      expectedStdout: '',
      expectedExitCode: 0,
    }],
    bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
  })

  harness.provideMockService(ctx, 'assistantVerifier', {
    inspectAcceptedTask: (id: string) =>
      id === contract.id
        ? { contract, state: 'awaiting-execution', attempts: 0, reason: null, receipt: null }
        : null,
  })

  return { contractId: contract.id, contractDigest: contract.digest }
}

function validEvaluator(quote: string) {
  return {
    protocol: 1,
    policy: () => ({ version: 'v1', rules: [{ ruleId: 'r-auto', ceiling: 'accept' }] }),
    evaluate: () => Promise.resolve({ level: 'accept', quotes: [quote] }),
  }
}

describe('Tier 2 — F02–F07: Boundary, Corner & Negative Cases', () => {
  describe('F02: WP08 PolicyRule lease, sensitivity, destination, cost cap & digest boundaries', () => {
    test('T2-F02-01: lease expiry enforces exact boundary (nowMs === expiresAtMs - 1 allows, nowMs === expiresAtMs denies) and rejects invalid expiry', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const evalFn = evaluatePolicy as (p: unknown, req: unknown, state?: unknown) => { effect: string; reasonCode: string }
      const expiresAtMs = 1_700_000_060_000
      const compiled = compilePolicy([
        baseRule({ lease: { leaseId: 'L-bva', expiresAtMs, maxUses: 5 } }) as never,
      ])

      expect(evalFn(compiled, basePolicyRequest({ leaseId: 'L-bva' }), { nowMs: expiresAtMs - 1 }).effect).toBe('allow')
      const atExpiry = evalFn(compiled, basePolicyRequest({ leaseId: 'L-bva' }), { nowMs: expiresAtMs })
      expect(atExpiry.effect).toBe('deny')
      expect(atExpiry.reasonCode).toBe('lease-expired')

      const pastExpiry = evalFn(compiled, basePolicyRequest({ leaseId: 'L-bva' }), { nowMs: expiresAtMs + 10_000 })
      expect(pastExpiry.effect).toBe('deny')
      expect(pastExpiry.reasonCode).toBe('lease-expired')

      const tighterReqLease = evalFn(
        compiled,
        basePolicyRequest({ lease: { leaseId: 'L-bva', expiresAtMs: expiresAtMs - 100 } }),
        { nowMs: expiresAtMs - 50 },
      )
      expect(tighterReqLease.effect).toBe('deny')
      expect(tighterReqLease.reasonCode).toBe('lease-expired')

      expect(() => compilePolicy([baseRule({ lease: { expiresAtMs: -1 } }) as never])).toThrow()
      const badReqLease = evalFn(compiled, basePolicyRequest({ lease: { leaseId: 'L-bva', expiresAtMs: 1.5 } }), { nowMs: expiresAtMs - 10 })
      expect(badReqLease.effect).toBe('deny')
      expect(badReqLease.reasonCode).toBe('lease-invalid')
    })

    test('T2-F02-02: lease revocation, maxUses exhaustion (used >= maxUses), and leaseId mismatch fail closed', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const evalFn = evaluatePolicy as (p: unknown, req: unknown, state?: unknown) => { effect: string; reasonCode: string }
      const compiled = compilePolicy([
        baseRule({ id: 'r-use', lease: { leaseId: 'L-use', maxUses: 3, revoked: false } }) as never,
      ])

      expect(evalFn(compiled, basePolicyRequest({ leaseId: 'L-use' }), { leaseUses: { 'L-use': 2 } }).effect).toBe('allow')
      const exactExhaust = evalFn(compiled, basePolicyRequest({ leaseId: 'L-use' }), { leaseUses: { 'L-use': 3 } })
      expect(exactExhaust.effect).toBe('deny')
      expect(exactExhaust.reasonCode).toBe('lease-exhausted')

      const revokedViaState = evalFn(compiled, basePolicyRequest({ leaseId: 'L-use' }), { revokedLeaseIds: ['L-use'] })
      expect(revokedViaState.effect).toBe('deny')
      expect(revokedViaState.reasonCode).toBe('lease-revoked')

      const revokedViaRequest = evalFn(compiled, basePolicyRequest({ lease: { leaseId: 'L-use', revoked: true } }))
      expect(revokedViaRequest.effect).toBe('deny')
      expect(revokedViaRequest.reasonCode).toBe('lease-revoked')

      const compiledRevoked = compilePolicy([baseRule({ lease: { leaseId: 'L-rev', revoked: true } }) as never])
      expect(evalFn(compiledRevoked, basePolicyRequest({ leaseId: 'L-rev' })).reasonCode).toBe('lease-revoked')

      const idMismatch = evalFn(compiled, basePolicyRequest({ lease: { leaseId: 'L-other' } }))
      expect(idMismatch.effect).toBe('deny')
      expect(idMismatch.reasonCode).toBe('lease-mismatch')

      const zeroMax = compilePolicy([baseRule({ lease: { leaseId: 'L-zero', maxUses: 0 } }) as never])
      expect(evalFn(zeroMax, basePolicyRequest({ leaseId: 'L-zero' }), { leaseUses: { 'L-zero': 0 } }).reasonCode).toBe('lease-exhausted')
    })

    test('T2-F02-03: data sensitivity allows exact maxSensitivity cap and denies exceeding/missing/invalid sensitivity', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const evalFn = evaluatePolicy as (p: unknown, req: unknown) => { effect: string; reasonCode: string }
      const compiled = compilePolicy([baseRule({ maxSensitivity: 'confidential' }) as never])

      expect(evalFn(compiled, basePolicyRequest({ sensitivity: 'confidential' })).effect).toBe('allow')

      const over = evalFn(compiled, basePolicyRequest({ sensitivity: 'restricted' }))
      expect(over.effect).toBe('deny')
      expect(over.reasonCode).toBe('sensitivity-exceeded')

      const missing = evalFn(compiled, basePolicyRequest())
      expect(missing.effect).toBe('deny')
      expect(missing.reasonCode).toBe('sensitivity-missing')

      const invalid = evalFn(compiled, basePolicyRequest({ sensitivity: 'top-secret' }))
      expect(invalid.effect).toBe('deny')
      expect(invalid.reasonCode).toBe('sensitivity-invalid')
    })

    test('T2-F02-04: destination allowlist denies empty allowlist, missing/empty/control destination, and newline glob escape', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const evalFn = evaluatePolicy as (p: unknown, req: unknown) => { effect: string; reasonCode: string }

      const emptyAllowlist = compilePolicy([baseRule({ destinations: [] }) as never])
      expect(evalFn(emptyAllowlist, basePolicyRequest({ destination: 'https://api.github.com/a' })).reasonCode).toBe('destination-mismatch')

      const globPolicy = compilePolicy([baseRule({ destinations: ['https://api.github.com/*'] }) as never])
      expect(evalFn(globPolicy, basePolicyRequest()).reasonCode).toBe('destination-missing')
      expect(evalFn(globPolicy, basePolicyRequest({ destination: '' })).reasonCode).toBe('destination-invalid')
      expect(evalFn(globPolicy, basePolicyRequest({ destination: 'https://api.github.com/\nevil' })).reasonCode).toBe('destination-invalid')
      expect(evalFn(globPolicy, basePolicyRequest({ destination: 'https://api.github.com/repos' })).effect).toBe('allow')
    })

    test('T2-F02-05: monetary cost cap allows exact cap (spent + estimated === cap) and denies +1 over-cap or missing/invalid cost', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const evalFn = evaluatePolicy as (p: unknown, req: unknown, state?: unknown) => { effect: string; reasonCode: string }
      const compiled = compilePolicy([baseRule({ monetaryCostCapMicros: 50_000 }) as never])

      expect(evalFn(compiled, basePolicyRequest({ estimatedCostMicros: 20_000 }), { spentCostMicros: 30_000 }).effect).toBe('allow')

      const overByOne = evalFn(compiled, basePolicyRequest({ estimatedCostMicros: 20_001 }), { spentCostMicros: 30_000 })
      expect(overByOne.effect).toBe('deny')
      expect(overByOne.reasonCode).toBe('monetary-cost-exceeded')

      expect(evalFn(compiled, basePolicyRequest()).reasonCode).toBe('monetary-cost-missing')
      expect(evalFn(compiled, basePolicyRequest({ estimatedCostMicros: -1 })).reasonCode).toBe('monetary-cost-invalid')
      expect(evalFn(compiled, basePolicyRequest({ estimatedCostMicros: 12.5 })).reasonCode).toBe('monetary-cost-invalid')
    })

    test('T2-F02-06: commit/predecessor digest binding and idempotencyKey conflict fail closed, and deny precedence overrides allow', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const evalFn = evaluatePolicy as (p: unknown, req: unknown, state?: unknown) => { effect: string; reasonCode: string }
      const commitSha = sha256Hex('commit-next')
      const prevSha = sha256Hex('commit-prev')
      const otherSha = sha256Hex('commit-wrong')

      const compiled = compilePolicy([
        baseRule({
          id: 'allow-commit',
          commitDigest: commitSha,
          predecessorDigest: prevSha,
          idempotencyKey: 'idem-bind-1',
        }) as never,
      ])

      const selfCycle = evalFn(compiled, basePolicyRequest({
        commitDigest: prevSha,
        predecessorDigest: prevSha,
        idempotencyKey: 'idem-bind-1',
      }))
      expect(selfCycle.effect).toBe('deny')
      expect(selfCycle.reasonCode).toBe('commit-digest-mismatch')

      const missingPrev = evalFn(compiled, basePolicyRequest({
        commitDigest: commitSha,
        idempotencyKey: 'idem-bind-1',
      }))
      expect(missingPrev.reasonCode).toBe('predecessor-digest-missing')

      const mismatchPrev = evalFn(compiled, basePolicyRequest({
        commitDigest: commitSha,
        predecessorDigest: otherSha,
        idempotencyKey: 'idem-bind-1',
      }))
      expect(mismatchPrev.reasonCode).toBe('predecessor-digest-mismatch')

      const usedIdem = evalFn(compiled, basePolicyRequest({
        commitDigest: commitSha,
        predecessorDigest: prevSha,
        idempotencyKey: 'idem-bind-1',
      }), { usedIdempotencyKeys: ['idem-bind-1'] })
      expect(usedIdem.reasonCode).toBe('idempotency-conflict')

      const bindingConflict = evalFn(compiled, basePolicyRequest({
        commitDigest: commitSha,
        predecessorDigest: prevSha,
        idempotencyKey: 'idem-bind-1',
      }), { idempotencyBindings: { 'idem-bind-1': { commitDigest: otherSha } } })
      expect(bindingConflict.reasonCode).toBe('idempotency-conflict')

      const precedenceCompiled = compilePolicy([
        baseRule({ id: 'allow-broad', effect: 'allow' }) as never,
        baseRule({ id: 'deny-exact', effect: 'deny', resource: { kind: 'network', id: 'api.github.com' } }) as never,
      ])
      expect(evalFn(precedenceCompiled, basePolicyRequest()).effect).toBe('deny')
    })
  })

  describe('F03: WP22 evaluation loosening regression & WorkItems intake tuning boundaries', () => {
    test('T2-F03-01: insufficient sample/holdout and regression metrics block attention loosening', async () => {
      const evalMod = await loadAssistantEvaluation()
      const propose = getExportFn<(input: Record<string, unknown>) => { kind: string; reason?: string }>(evalMod, 'proposeAttentionTuning')
      const replay = getExportFn<(
        records: readonly { era: Record<string, unknown>; outcome: string }[],
        parent: Record<string, unknown>,
        candidate: Record<string, unknown>,
        policy: Record<string, unknown>,
      ) => { verdict: string; reason: string }>(evalMod, 'replayAttentionLoosening')

      const lowSample = propose(
        { interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
        { total: 4, decided: 4, positive: 0, negative: 4 },
        { minSample: 5, negativeRatePpm: 200_000, step: { interruptionCostDelta: 5, minimumUtilityDelta: 5, quietExtensionMinutes: 5 }, bounds: { maxInterruptionCostDelta: 30, maxMinimumUtilityDelta: 30, maxQuietExtensionMinutes: 30 } },
      )
      expect(lowSample).toMatchObject({ kind: 'no-op', reason: 'insufficient-sample' })

      const parentEra = { interruptionCostDelta: 10, minimumUtilityDelta: 10, quietExtensionMinutes: 0, muted: false }
      const candidateEra = { interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false }

      const holdoutShort = replay(
        [
          { era: candidateEra, outcome: 'accepted' },
          { era: candidateEra, outcome: 'rejected' },
        ],
        parentEra,
        candidateEra,
        { minSample: 5, negativeRatePpm: 250_000, regressionMarginPpm: 50_000 },
      )
      expect(holdoutShort.verdict).toBe('fail')
      expect(holdoutShort.reason).toBe('insufficient-holdout')

      const regressionHoldout = replay(
        [
          { era: candidateEra, outcome: 'rejected' },
          { era: candidateEra, outcome: 'rejected' },
          { era: candidateEra, outcome: 'rejected' },
          { era: candidateEra, outcome: 'accepted' },
          { era: candidateEra, outcome: 'accepted' },
        ],
        parentEra,
        candidateEra,
        { minSample: 5, negativeRatePpm: 200_000, regressionMarginPpm: 50_000 },
      )
      expect(regressionHoldout.verdict).toBe('fail')
      expect(['extra-interruptions', 'candidate-negative-rate', 'no-net-benefit']).toContain(regressionHoldout.reason)
    })

    test('T2-F03-02: AssistantEvaluationService rejects inconsistent loosening flags and denies loosening when disabled', async () => {
      const ws = await workspaces.create('f03-eval-guard-')
      const { AssistantEvaluationService } = await loadAssistantEvaluation()
      const ctxBad = harness.createContext()

      expect(() => new AssistantEvaluationService(ctxBad as never, {
        databasePath: ws.sqlitePath('eval-bad'),
        attentionTuningAutoAdopt: false,
        attentionLooseningEnabled: true,
      } as never)).toThrow()

      const ctx = harness.createContext()
      const evalSvc = new AssistantEvaluationService(ctx as never, {
        databasePath: ws.sqlitePath('eval-ok'),
        projectionIntervalMs: 0,
        notificationOutcomesEnabled: true,
        attentionTuningAutoAdopt: true,
        attentionLooseningEnabled: false,
        attentionTuningCohorts: [{ lane: 'notify', sourceId: 'work-items' }],
      })

      const rejected = evalSvc.requestAttentionTuning({
        scope: { principalId: 'web/a/t/u', workspace: ws.workspace, preset: 'primary' },
        cohort: { lane: 'notify', sourceId: 'work-items' },
        parameters: { interruptionCostDelta: -5, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
        reason: 'attempt loosening while disabled',
      } as never)
      expect(rejected.status).toBe('rejected')
      expect(rejected.reason).toBe('loosening-requires-holdout')
    })

    test('T2-F03-03: applyIntakeTuning rejects invalid workItemsMode, out-of-bounds rule updates, duplicates & >16 rules atomically', async () => {
      const ws = await workspaces.create('f03-tuning-bounds-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const workItems = await harness.mountService<{
        applyIntakeTuning: (u: unknown) => unknown
        intakeTuning: () => { mode: string; rules: readonly unknown[] }
      }>(ctx, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, ws.sqlitePath('wi'), 'observe'))

      expect(() => workItems.applyIntakeTuning({ workItemsMode: 'automatic' })).toThrow()
      expect(() => workItems.applyIntakeTuning({ unknownKey: true })).toThrow()
      expect(() => workItems.applyIntakeTuning({
        intakeRuleUpdates: [{ ruleId: 'rule-1', confidenceThresholdPpm: -1 }],
      })).toThrow()
      expect(() => workItems.applyIntakeTuning({
        intakeRuleUpdates: [{ ruleId: 'rule-1', confidenceThresholdPpm: 1_000_001 }],
      })).toThrow()
      expect(() => workItems.applyIntakeTuning({
        intakeRuleUpdates: [{ ruleId: 'rule-1', minUtility: Number.NaN }],
      })).toThrow()
      expect(() => workItems.applyIntakeTuning({
        intakeRuleUpdates: [{ ruleId: 'dup-rule' }, { ruleId: 'dup-rule' }],
      })).toThrow()

      const sixtyFiveRules = Array.from({ length: 65 }, (_, idx) => ({ ruleId: `rule-${idx}`, enabled: true }))
      expect(() => workItems.applyIntakeTuning({ intakeRuleUpdates: sixtyFiveRules })).toThrow()

      // Live state remained cleanly untouched in observe with 0 overrides.
      expect(workItems.intakeTuning()).toEqual({ mode: 'observe', rules: [] })
    }, 15_000)

    test('T2-F03-04: applyIntakeTuning fails closed with WorkItemError on expired owner scope, rejected kind & observe-only mode', async () => {
      const ws = await workspaces.create('f03-tuning-state-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()

      const ctx1 = harness.createContext()
      await harness.mountService(ctx1, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy1') })
      const expiredSvc = await harness.mountService<{
        applyIntakeTuning: (u: unknown) => unknown
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, ws.sqlitePath('wi-exp'), 'observe', 'intake-inferred', {
        scope: {
          workspace: ws.workspace,
          preset: 'primary',
          principalId: 'web/a/t/u',
          ownerRouteId: 'route-1',
          expiresAt: Date.now() + 40,
        },
      }))
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(() => expiredSvc.applyIntakeTuning({ workItemsMode: 'auto' })).toThrow(/expired|owner/i)

      const ctx2 = harness.createContext()
      await harness.mountService(ctx2, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy2') })
      const mismatchKindSvc = await harness.mountService<{
        applyIntakeTuning: (u: unknown) => unknown
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, ws.sqlitePath('wi-kind'), 'observe', 'intake-inferred', {
        admission: { allowedKinds: ['other-kind'], maxOpenItems: 10, maxAdmitsPerHour: 10, cooldownMs: 0 },
      }))
      expect(() => mismatchKindSvc.applyIntakeTuning({ workItemsMode: 'auto' })).toThrow(/allowedKinds|kind/i)

      const ctx3 = harness.createContext()
      await harness.mountService(ctx3, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy3') })
      const observeOnlySvc = await harness.mountService<{
        applyIntakeTuning: (u: unknown) => unknown
        intakeAdmissionMode: () => string
        runIntakeAdmission: () => readonly unknown[]
      }>(ctx3, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, ws.sqlitePath('wi-obs-mode'), 'observe', 'intake-inferred', {
        mode: 'observe',
      }))
      expect(() => observeOnlySvc.applyIntakeTuning({ workItemsMode: 'auto' })).toThrow(/active intake|invalid-state/i)
      expect(observeOnlySvc.intakeAdmissionMode()).toBe('observe')
      expect(observeOnlySvc.runIntakeAdmission()).toEqual([])
    })

    test('T2-F03-05: WP22 normalizeAttentionTuningParameters rejects invalid workItemsMode and consumer bridge does not adopt failed loosening', async () => {
      const evalMod = await loadAssistantEvaluation()
      const normalize = getExportFn<(input: Record<string, unknown>) => Record<string, unknown>>(
        evalMod,
        'normalizeAttentionTuningParameters',
      )
      expect(() => normalize({
        interruptionCostDelta: 0,
        minimumUtilityDelta: 0,
        quietExtensionMinutes: 0,
        muted: false,
        workItemsMode: 'force-auto',
      })).toThrow()

      expect(() => normalize({
        interruptionCostDelta: 0,
        minimumUtilityDelta: 0,
        quietExtensionMinutes: 0,
        muted: false,
        intakeRuleUpdates: [{ ruleId: 'r1', confidenceThresholdPpm: 2_000_000 }],
      })).toThrow()

      const ws = await workspaces.create('f03-bridge-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const evalSvc = await harness.mountService(ctx, evalMod.AssistantEvaluationService, 'assistantEvaluation', {
        databasePath: ws.sqlitePath('eval'),
        projectionIntervalMs: 0,
        notificationOutcomesEnabled: true,
        attentionTuningAutoAdopt: true,
        attentionLooseningEnabled: false,
      })
      const workItems = await harness.mountService<{
        intakeAdmissionMode: () => string
      }>(ctx, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, ws.sqlitePath('wi'), 'observe'))

      const subscribe = getMethod<(cb: (d: Record<string, unknown>) => void) => () => void>(evalSvc, 'onAttentionLooseningAdopted')
      let callbackCount = 0
      subscribe(() => { callbackCount += 1 })
      const reqRes = (evalSvc as { requestAttentionTuning: (i: Record<string, unknown>) => { status: string } }).requestAttentionTuning({
        cohort: { lane: 'notify', sourceId: 'work-items' },
        parameters: { interruptionCostDelta: -5, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
        reason: 'blocked loosening',
      })
      expect(reqRes.status).toBe('rejected')
      expect(callbackCount).toBe(0)
      expect(workItems.intakeAdmissionMode()).toBe('observe')
    })
  })

  describe('F04: WP21 tampered staging, corrupt metadata/SQLite & evaluation queue boundaries', () => {
    test('T2-F04-01: tampering work_item_intake_staging ciphertext or IV fails closed post-restart to would-admit', async () => {
      const ws = await workspaces.create('f04-tamper-ct-')
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('wi-tamper')
      const objectiveText = 'Fix CI flake in worker'
      const digest = sha256Hex(objectiveText)

      const ctx1 = harness.createContext()
      const acceptance = await mountWorkItemsPeers(ctx1, ws, 'policy1', objectiveText, 'c-tamper-1')
      const wi1 = await harness.mountService<{
        recordIntake: (i: unknown, s?: string) => unknown
        registerIntakeEvaluator: (r: unknown) => () => void
        runIntakeEvaluation: () => Promise<unknown[]>
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))
      wi1.registerIntakeEvaluator(validEvaluator('Fix CI flake'))
      wi1.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-tamper-ct',
        kind: 'message',
        senderAllowlisted: true,
        addressed: false,
        threadFollowUp: false,
        senderIsBot: false,
        groupMessage: true,
        contentDigest: digest,
        occurredAt: Date.now(),
        objective: objectiveText,
        objectiveDigest: digest,
        acceptance,
      }, objectiveText)
      await wi1.runIntakeEvaluation()
      await harness.disposeAll()

      const db = new DatabaseSync(dbPath)
      try {
        const row = db.prepare('SELECT ciphertext FROM work_item_intake_staging WHERE source_event_id = ?').get('evt-tamper-ct') as { ciphertext: Uint8Array }
        const mutated = Buffer.from(row.ciphertext)
        mutated[0] = (mutated[0]! ^ 0x5a) & 0xff
        db.prepare('UPDATE work_item_intake_staging SET ciphertext = ? WHERE source_event_id = ?').run(mutated, 'evt-tamper-ct')
      } finally {
        db.close()
      }

      const ctx2 = harness.createContext()
      await mountWorkItemsPeers(ctx2, ws, 'policy2', objectiveText, 'c-tamper-1')
      const wi2 = await harness.mountService<{
        runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      const admissions = wi2.runIntakeAdmission()
      expect(admissions[0]?.outcome).toBe('would-admit')
      expect(admissions[0]?.itemId).toBeNull()
    })

    test('T2-F04-02: auto admission without acceptance handle fails closed to would-admit and digest mismatch rejects staging', async () => {
      const ws = await workspaces.create('f04-no-acc-')
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('wi-no-acc')
      const objectiveText = 'Objective without verifier contract'
      const digest = sha256Hex(objectiveText)

      const ctx1 = harness.createContext()
      await mountWorkItemsPeers(ctx1, ws, 'policy1', objectiveText, 'c-unused')
      const wi1 = await harness.mountService<{
        recordIntake: (i: unknown, s?: string) => unknown
        registerIntakeEvaluator: (r: unknown) => () => void
        runIntakeEvaluation: () => Promise<unknown[]>
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))
      wi1.registerIntakeEvaluator(validEvaluator('Objective without'))
      wi1.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-no-acc',
        kind: 'message',
        senderAllowlisted: true,
        addressed: false,
        threadFollowUp: false,
        senderIsBot: false,
        groupMessage: true,
        contentDigest: digest,
        occurredAt: Date.now(),
        objective: objectiveText,
        objectiveDigest: digest,
      }, objectiveText)
      await wi1.runIntakeEvaluation()
      await harness.disposeAll()

      const ctx2 = harness.createContext()
      await mountWorkItemsPeers(ctx2, ws, 'policy2', objectiveText, 'c-unused')
      const wi2 = await harness.mountService<{
        runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))
      const res = wi2.runIntakeAdmission()
      expect(res[0]?.outcome).toBe('would-admit')
      expect(res[0]?.itemId).toBeNull()

      const { WorkItemStore } = (await loadPackageModule('assistant-work-items/store')) as {
        WorkItemStore: new (path: string, workRoot: string, opts?: Record<string, unknown>) => {
          recordIntake: (input: Record<string, unknown>) => unknown
          upsertIntakeStaging: (input: Record<string, unknown>) => { stored: boolean; reason?: string }
          close: () => void
        }
      }
      const store = new WorkItemStore(ws.sqlitePath('wi-store-digest'), ws.workspace)
      try {
        store.recordIntake({
          source: 'lark-channel',
          sourceEventId: 'evt-bad-digest',
          kind: 'message',
          decision: 'stored',
          reason: 'inferred',
          strength: 'inferred',
          strengthReason: 'inferred',
          signals: {
            addressed: false,
            threadFollowUp: false,
            senderAllowlisted: true,
            senderIsBot: false,
            groupMessage: true,
            hasExplicitIntent: false,
          },
          contentDigest: sha256Hex('different-text'),
          metadataDigest: sha256Hex('meta-bad-digest'),
          occurredAt: Date.now(),
        })
        const mismatch = store.upsertIntakeStaging({
          source: 'lark-channel',
          sourceEventId: 'evt-bad-digest',
          sourceText: objectiveText,
          ttlMs: 60_000,
        })
        expect(mismatch).toMatchObject({ stored: false, reason: 'integrity-failed' })
      } finally {
        store.close()
      }
    })

    test('T2-F04-03: expired staging row fails closed post-restart and invalid ttlMs <= 0 is rejected', async () => {
      const ws = await workspaces.create('f04-expired-')
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('wi-exp')
      const objectiveText = 'Expiring intake item'
      const digest = sha256Hex(objectiveText)

      const ctx1 = harness.createContext()
      const acceptance = await mountWorkItemsPeers(ctx1, ws, 'policy1', objectiveText, 'c-exp')
      const wi1 = await harness.mountService<{
        recordIntake: (i: unknown, s?: string) => unknown
        registerIntakeEvaluator: (r: unknown) => () => void
        runIntakeEvaluation: () => Promise<unknown[]>
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))
      wi1.registerIntakeEvaluator(validEvaluator('Expiring'))
      wi1.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-exp',
        kind: 'message',
        senderAllowlisted: true,
        addressed: false,
        threadFollowUp: false,
        senderIsBot: false,
        groupMessage: true,
        contentDigest: digest,
        occurredAt: Date.now(),
        objective: objectiveText,
        objectiveDigest: digest,
        acceptance,
      }, objectiveText)
      await wi1.runIntakeEvaluation()
      await harness.disposeAll()

      const db = new DatabaseSync(dbPath)
      try {
        db.prepare('UPDATE work_item_intake_staging SET expires_at = ? WHERE source_event_id = ?').run(Date.now() - 5_000, 'evt-exp')
      } finally {
        db.close()
      }

      const ctx2 = harness.createContext()
      await mountWorkItemsPeers(ctx2, ws, 'policy2', objectiveText, 'c-exp')
      const wi2 = await harness.mountService<{
        runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))
      const res = wi2.runIntakeAdmission()
      expect(res[0]?.outcome).toBe('would-admit')
      expect(res[0]?.itemId).toBeNull()

      const { WorkItemStore } = (await loadPackageModule('assistant-work-items/store')) as {
        WorkItemStore: new (path: string, workRoot: string) => {
          upsertIntakeStaging: (input: Record<string, unknown>) => unknown
          close: () => void
        }
      }
      const store = new WorkItemStore(ws.sqlitePath('wi-ttl'), ws.workspace)
      try {
        expect(() => store.upsertIntakeStaging({
          source: 'lark-channel',
          sourceEventId: 'evt-ttl-0',
          contentDigest: digest,
          sourceText: objectiveText,
          ttlMs: 0,
        })).toThrow()
      } finally {
        store.close()
      }
    })

    test('T2-F04-04: corrupt persisted intake tuning meta JSON falls back safely to configured observe mode on restart', async () => {
      const ws = await workspaces.create('f04-corrupt-meta-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('wi-meta')

      const ctx1 = harness.createContext()
      await harness.mountService(ctx1, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy1') })
      const wi1 = await harness.mountService<{
        applyIntakeTuning: (u: unknown) => { mode: string }
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'observe', 'triage'))
      expect(wi1.applyIntakeTuning({ workItemsMode: 'auto' }).mode).toBe('auto')
      await harness.disposeAll()

      const db = new DatabaseSync(dbPath)
      try {
        db.prepare("UPDATE work_item_schema_meta SET value = '{not-valid-json' WHERE key LIKE '%intake%'").run()
      } finally {
        db.close()
      }

      const ctx2 = harness.createContext()
      await harness.mountService(ctx2, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy2') })
      const wi2 = await harness.mountService<{
        intakeAdmissionMode: () => string
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'observe', 'triage'))
      expect(wi2.intakeAdmissionMode()).toBe('observe')
    })

    test('T2-F04-05: invalid/empty intake handles are rejected and evaluation queue enforces bounded capacity', async () => {
      const ws = await workspaces.create('f04-qcap-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('wi-cap')

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const wi = await harness.mountService<{
        recordIntake: (i: unknown, s?: string) => unknown
      }>(ctx, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'observe', 'triage'))

      expect(() => wi.recordIntake({
        source: '',
        sourceEventId: 'evt-bad-src',
        kind: 'message',
        senderAllowlisted: true,
        addressed: false,
        threadFollowUp: false,
        senderIsBot: false,
        groupMessage: true,
        contentDigest: sha256Hex('x'),
        occurredAt: Date.now(),
      }, 'x')).toThrow()

      const { WorkItemStore } = (await loadPackageModule('assistant-work-items/store')) as {
        WorkItemStore: new (path: string, workRoot: string) => {
          recordIntake: (input: Record<string, unknown>) => unknown
          upsertIntakeEvalQueue: (input: Record<string, unknown>) => boolean
          close: () => void
        }
      }
      const store = new WorkItemStore(ws.sqlitePath('wi-queue-limit'), ws.workspace)
      try {
        let accepted = 0
        let rejected = false
        for (let i = 0; i < 4_100; i += 1) {
          const eventId = `evt-q-${i}`
          store.recordIntake({
            source: 'lark-channel',
            sourceEventId: eventId,
            kind: 'message',
            decision: 'stored',
            reason: 'inferred',
            strength: 'inferred',
            strengthReason: 'inferred',
            signals: {
              addressed: false,
              threadFollowUp: false,
              senderAllowlisted: true,
              senderIsBot: false,
              groupMessage: true,
              hasExplicitIntent: false,
            },
            contentDigest: sha256Hex(eventId),
            metadataDigest: sha256Hex(`meta-${eventId}`),
            occurredAt: Date.now(),
          })
          const ok = store.upsertIntakeEvalQueue({
            source: 'lark-channel',
            sourceEventId: eventId,
            ruleId: 'r-auto',
            policyVersion: 1,
            ceiling: 'accept',
            attempts: 0,
            failures: 0,
            nextAt: 0,
          })
          if (ok) accepted += 1
          else {
            rejected = true
            break
          }
        }
        expect(accepted).toBeGreaterThan(0)
        expect(rejected).toBe(true)
      } finally {
        store.close()
      }
    }, 15_000)
  })

  describe('F05: WP12 dynamic proactive utility, quiet-hours wraparound & overload boundaries', () => {
    function makeProfile(overrides: Record<string, unknown> = {}) {
      return {
        id: 'prof-1',
        mode: 'remind',
        expectedBenefit: 100,
        successPpm: 800_000,
        executionCost: 10,
        interruptionCost: 15,
        possibleLoss: 5,
        minimumUtility: 20,
        mergeWindowMs: 0,
        cooldownMs: 1_000,
        rejectionCooldownMs: 2_000,
        maxDecisionsPerGoal: 10,
        maxExecutionsPerGoal: 5,
        maxRemindersPerGoal: 5,
        ...overrides,
      }
    }

    function makeInput(wsRoot: string, seq: number, overrides: Record<string, unknown> = {}) {
      return {
        waitId: `wait-${seq}`,
        profileId: 'prof-1',
        scope: { principalId: 'web/a/t/u', principalRecordId: 'rec-1', principalVersion: 1, workspace: wsRoot, preset: 'primary' },
        goalId: 'goal-1',
        sessionId: 'sess-1',
        definitionDigest: sha256Hex('def'),
        objective: `Objective ${seq}`,
        nativeGoalId: 'ng-1',
        nativeRevision: 1,
        ownerRouteId: 'route-1',
        sourceDigest: sha256Hex('src'),
        sourceId: 'src-1',
        event: { id: `evt-${seq}`, sequence: seq, digest: sha256Hex(`evt-${seq}`), occurredAt: 1_700_000_000_000 + seq },
        expiresAt: 1_900_000_000_000,
        ...overrides,
      }
    }

    test('T2-F05-01: OpportunityEngine.evaluate rejects malformed runtimeContext (unknown keys, out-of-range urgencyPpm, negative counts)', async () => {
      const ws = await workspaces.create('f05-ctx-err-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[]) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): unknown
      }>(mod, 'OpportunityEngine')

      const engine = new OpportunityEngine(ws.sqlitePath('proactive'), [makeProfile()])
      expect(() => engine.evaluate(makeInput(ws.workspace, 1), undefined, { unknownFlag: true })).toThrow(/invalid runtime context/)
      expect(() => engine.evaluate(makeInput(ws.workspace, 2), undefined, { urgencyPpm: -1 })).toThrow(/invalid runtime context/)
      expect(() => engine.evaluate(makeInput(ws.workspace, 3), undefined, { urgencyPpm: 1_000_001 })).toThrow(/invalid runtime context/)
      expect(() => engine.evaluate(makeInput(ws.workspace, 4), undefined, { urgencyPpm: 0.5 })).toThrow(/invalid runtime context/)
      expect(() => engine.evaluate(makeInput(ws.workspace, 5), undefined, { recentNotificationCount: -1 })).toThrow(/invalid runtime context/)
      expect(() => engine.evaluate(makeInput(ws.workspace, 6), undefined, ['bad'] as never)).toThrow(/invalid runtime context/)
    })

    test('T2-F05-02: quiet-hours midnight wraparound (22:00-07:00) defers at 22:00 & 02:00 and allows at exact 07:00 boundary', async () => {
      const ws = await workspaces.create('f05-quiet-wrap-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[], opts?: { now?: () => number }) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { disposition: string; decision: { mode: string; reason: string; eligibleAt: number } }
      }>(mod, 'OpportunityEngine')

      const dayBase = Date.UTC(2026, 5, 1, 0, 0, 0)
      let currentNow = dayBase + 22 * 3_600_000 // 22:00 UTC (exact startMinute 1320)
      const engine = new OpportunityEngine(
        ws.sqlitePath('proactive'),
        [makeProfile({ quietHours: { timezone: 'UTC', startMinute: 1320, endMinute: 420 } })],
        { now: () => currentNow },
      )

      const atStart = engine.evaluate(makeInput(ws.workspace, 1))
      expect(atStart.disposition).toBe('defer')
      expect(atStart.decision.reason).toBe('quiet-hours')
      expect(atStart.decision.eligibleAt).toBe(dayBase + 31 * 3_600_000)

      currentNow = dayBase + 26 * 3_600_000 // 02:00 UTC next day
      const midNight = engine.evaluate(makeInput(ws.workspace, 2))
      expect(midNight.disposition).toBe('defer')
      expect(midNight.decision.reason).toBe('quiet-hours')

      currentNow = dayBase + 31 * 3_600_000 // exact 07:00 UTC (endMinute 420)
      const atEnd = engine.evaluate(makeInput(ws.workspace, 3))
      expect(atEnd.disposition).toBe('consume')
      expect(atEnd.decision.mode).toBe('remind')

      expect(() => new OpportunityEngine(ws.sqlitePath('proactive-bad'), [
        makeProfile({ quietHours: { timezone: 'UTC', startMinute: 600, endMinute: 600 } }),
      ])).toThrow(/invalid quiet hours/)
    })

    test('T2-F05-03: goal budget exhaustion and proactive notification overload suppress cleanly', async () => {
      const ws = await workspaces.create('f05-budget-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[], opts?: { now?: () => number }) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { disposition: string; decision: { mode: string; reason: string; utility: number } }
      }>(mod, 'OpportunityEngine')

      let currentNow = 1_700_000_000_000
      const engine = new OpportunityEngine(
        ws.sqlitePath('proactive'),
        [makeProfile({ maxRemindersPerGoal: 1, cooldownMs: 0, minimumUtility: 40 })],
        { now: () => currentNow },
      )

      const overload = engine.evaluate(makeInput(ws.workspace, 1), undefined, {
        userActive: true,
        recentNotificationCount: 100,
        urgencyPpm: 0,
      })
      expect(overload.decision.mode).toBe('suppress')
      expect(overload.decision.reason).toBe('below-threshold')

      currentNow += 1_000
      const firstRemind = engine.evaluate(makeInput(ws.workspace, 2), undefined, { userActive: false, urgencyPpm: 900_000 })
      expect(firstRemind.decision.mode).toBe('remind')

      currentNow += 1_000
      const overBudget = engine.evaluate(makeInput(ws.workspace, 3), undefined, { userActive: false, urgencyPpm: 900_000 })
      expect(overBudget.disposition).toBe('consume')
      expect(overBudget.decision.mode).toBe('suppress')
      expect(overBudget.decision.reason).toBe('budget')

      // Combined 3-arg evaluate(input, overlay, runtimeContext): overlay tightening + runtimeContext signals
      const overlay = {
        version: 1,
        digest: sha256Hex('overlay-tighten'),
        parameters: {
          interruptionCostDelta: 20,
          minimumUtilityDelta: 20,
          quietExtensionMinutes: 0,
          muted: false,
        },
      }
      const comboEngine = new OpportunityEngine(
        ws.sqlitePath('proactive-combo'),
        [makeProfile({ maxRemindersPerGoal: 5, cooldownMs: 0, minimumUtility: 20 })],
        { now: () => currentNow },
      ) as unknown as {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): {
          disposition: string
          decision: { mode: string; reason: string; utility: number; attentionTuning?: { version: number; digest: string } }
        }
      }

      const tightenedButUrgent = comboEngine.evaluate(
        makeInput(ws.workspace, 10, { goalId: 'goal-combo-1' }),
        overlay,
        { userActive: false, idleDurationMs: 3_600_000, urgencyPpm: 900_000 },
      )
      expect(tightenedButUrgent.decision.mode).toBe('remind')
      expect(tightenedButUrgent.decision.attentionTuning).toEqual({ version: 1, digest: overlay.digest })

      currentNow += 1_000
      const tightenedAndActive = comboEngine.evaluate(
        makeInput(ws.workspace, 11, { goalId: 'goal-combo-2' }),
        overlay,
        { userActive: true, recentNotificationCount: 2 },
      )
      expect(tightenedAndActive.decision.mode).toBe('suppress')
      expect(tightenedAndActive.decision.reason).toBe('below-threshold')
      expect(tightenedAndActive.decision.attentionTuning).toEqual({ version: 1, digest: overlay.digest })
    })

    test('T2-F05-04: cooldown and rejectionCooldown exact millisecond boundaries', async () => {
      const ws = await workspaces.create('f05-cooldown-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[], opts?: { now?: () => number }) => {
        evaluate(input: unknown): { decision: { id: string; mode: string; reason: string } }
        feedback(decisionId: string, scope: unknown, outcome: string): void
      }>(mod, 'OpportunityEngine')

      // Goal A tests cooldownMs - 1 suppression vs fresh Goal B at exact +cooldownMs
      let nowA = 1_700_000_000_000
      const engineA = new OpportunityEngine(
        ws.sqlitePath('proactive-a'),
        [makeProfile({ cooldownMs: 5_000, rejectionCooldownMs: 10_000 })],
        { now: () => nowA },
      )
      expect(engineA.evaluate(makeInput(ws.workspace, 1, { goalId: 'goal-a' })).decision.mode).toBe('remind')
      nowA += 4_999
      const inCooldown = engineA.evaluate(makeInput(ws.workspace, 2, { goalId: 'goal-a' }))
      expect(inCooldown.decision.mode).toBe('suppress')
      expect(inCooldown.decision.reason).toBe('cooldown')

      let nowB = 1_700_000_000_000
      const engineB = new OpportunityEngine(
        ws.sqlitePath('proactive-b'),
        [makeProfile({ cooldownMs: 5_000, rejectionCooldownMs: 10_000 })],
        { now: () => nowB },
      )
      const firstB = engineB.evaluate(makeInput(ws.workspace, 1, { goalId: 'goal-b' }))
      nowB += 5_000 // exact +cooldownMs
      const afterCooldown = engineB.evaluate(makeInput(ws.workspace, 2, { goalId: 'goal-b' }))
      expect(afterCooldown.decision.mode).toBe('remind')

      engineB.feedback(firstB.decision.id, makeInput(ws.workspace, 1, { goalId: 'goal-b' }).scope, 'rejected')
      nowB += 9_999
      const inRejCooldown = engineB.evaluate(makeInput(ws.workspace, 3, { goalId: 'goal-b' }))
      expect(inRejCooldown.decision.reason).toBe('rejected-cooldown')

      nowB += 10_000
      const afterRejCooldown = engineB.evaluate(makeInput(ws.workspace, 4, { goalId: 'goal-b' }))
      expect(afterRejCooldown.decision.mode).toBe('remind')
    })

    test('T2-F05-05: negative/unsafe profile fields throw and idle discount never makes effectiveInterruptionCost negative', async () => {
      const ws = await workspaces.create('f05-neg-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[]) => unknown>(mod, 'OpportunityEngine')
      const computeDynamicUtility = getExportFn<(p: unknown, ctx?: unknown) => {
        effectiveInterruptionCost: number
        effectiveUtility: number
      }>(mod, 'computeDynamicUtility')

      expect(() => new OpportunityEngine(ws.sqlitePath('bad1'), [makeProfile({ interruptionCost: -1 })])).toThrow(/invalid profile/)
      expect(() => new OpportunityEngine(ws.sqlitePath('bad2'), [makeProfile({ successPpm: 1_000_001 })])).toThrow(/invalid profile/)
      expect(() => new OpportunityEngine(ws.sqlitePath('bad3'), [makeProfile({ expectedBenefit: Number.NaN })])).toThrow(/invalid profile/)

      const lowCostProfile = makeProfile({ interruptionCost: 2 })
      const util = computeDynamicUtility(lowCostProfile, { idleDurationMs: 7_200_000, userActive: false })
      expect(util.effectiveInterruptionCost).toBeGreaterThanOrEqual(0)
    })

    test('T2-F05-06: expired opportunity fails closed and duplicate event identity/sequence conflicts throw', async () => {
      const ws = await workspaces.create('f05-expiry-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[], opts?: { now?: () => number }) => {
        evaluate(input: unknown): { disposition: string; decision: { reason: string } }
      }>(mod, 'OpportunityEngine')

      const currentNow = 1_700_000_000_000
      const engine = new OpportunityEngine(ws.sqlitePath('proactive'), [makeProfile()], { now: () => currentNow })

      const expired = engine.evaluate(makeInput(ws.workspace, 1, { expiresAt: currentNow }))
      expect(expired.disposition).toBe('consume')
      expect(expired.decision.reason).toBe('expired')

      engine.evaluate(makeInput(ws.workspace, 2))
      expect(() => engine.evaluate(makeInput(ws.workspace, 2, {
        definitionDigest: sha256Hex('tampered-def'),
      }))).toThrow(/identity conflict/)

      expect(() => engine.evaluate(makeInput(ws.workspace, 2, {
        event: { id: 'evt-2-other', sequence: 2, digest: sha256Hex('evt-2-other'), occurredAt: currentNow },
      }))).toThrow(/sequence conflict/)
    })
  })

  describe('F06: WP04 benchmark budget cutoff, missing baseline & ablation/corpus boundaries', () => {
    function sampleModelConfig(maxOutputTokens = 256) {
      return {
        provider: 'deepseek',
        model: 'deepseek-chat',
        temperature: 0,
        maxOutputTokens,
        inputUsdMicrosPerMillionTokens: 1000,
        outputUsdMicrosPerMillionTokens: 2000,
        adapterDigest: sha256Hex('adapter'),
        tokenCounterDigest: sha256Hex('counter'),
      }
    }

    function sampleBudget(overrides: Record<string, unknown> = {}) {
      return {
        durationMs: 10_000,
        inputTokens: 100_000,
        outputTokens: 1_000,
        costUsdMicros: null,
        toolCalls: 4,
        ...overrides,
      }
    }

    test('T2-F06-01: zero durationMs/outputTokens fails plan validation and exceeded zero inputTokens/toolCalls halts runBenchmark', async () => {
      const ws = await workspaces.create('f06-budget-')
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const runnerMod = await loadBenchmarkRunner()
      const { BenchmarkStore } = await loadBenchmarkStore()
      const caseId = corpus.familiesDevelopmentCases()[0]!.id

      const baseVariants = [
        { id: 'base', role: 'baseline' as const, persona: 'p', memory: false, review: false, planning: false, growth: false },
        { id: 'cand', role: 'candidate' as const, persona: 'p', memory: false, review: false, planning: true, growth: false },
      ]

      expect(() => native.nativeBenchmarkPlan({
        id: 'zero-dur',
        suite: 'families-v1',
        cases: [caseId],
        variants: baseVariants,
        model: sampleModelConfig(),
        budget: sampleBudget({ durationMs: 0 }),
        repeats: 2,
        seed: 1,
      })).toThrow(/durationMs/)

      expect(() => native.nativeBenchmarkPlan({
        id: 'zero-out',
        suite: 'families-v1',
        cases: [caseId],
        variants: baseVariants,
        model: sampleModelConfig(),
        budget: sampleBudget({ outputTokens: 0 }),
        repeats: 2,
        seed: 1,
      })).toThrow(/maxOutputTokens/)

      const zeroToolPlan = native.nativeBenchmarkPlan({
        id: 'zero-tool-exec',
        suite: 'families-v1',
        cases: [caseId],
        variants: baseVariants,
        model: sampleModelConfig(),
        budget: sampleBudget({ toolCalls: 0 }),
        repeats: 2,
        seed: 1,
      })

      const store = new (BenchmarkStore as new (path: string) => { close?: () => void })(ws.sqlitePath('bench'))
      try {
        let execCalls = 0
        const results = await runnerMod.runBenchmark(store as never, zeroToolPlan, {
          execute: async (req: {
            variant: { versions: unknown }
            task: { inputDigest: string; acceptanceDigest: string }
          }) => {
            execCalls += 1
            return {
              versions: req.variant.versions,
              inputDigest: req.task.inputDigest,
              acceptanceDigest: req.task.acceptanceDigest,
              verdict: 'achieved',
              evidenceDigest: sha256Hex('obs-ev-01'),
              quiescent: true,
              metrics: {
                inputTokens: 10,
                outputTokens: 5,
                costUsdMicros: 1,
                toolCalls: 1, // exceeds toolCalls: 0
                rework: 0,
                interventions: 0,
                latencyMs: 10,
              },
            }
          },
        } as never)
        expect(execCalls).toBe(1)
        expect(results).toHaveLength(1)
        expect(results[0]?.status).toBe('unknown')
        expect(results[0]?.reason).toBe('budget-exceeded')
      } finally {
        store.close?.()
      }
    })

    test('T2-F06-02: empty, duplicate, and unknown benchmark cases or families scenarios fail closed', async () => {
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const firstId = corpus.familiesDevelopmentCases()[0]!.id
      const variants = [
        { id: 'base', role: 'baseline' as const, persona: 'p', memory: false, review: false, planning: false, growth: false },
        { id: 'cand', role: 'candidate' as const, persona: 'p', memory: false, review: false, planning: true, growth: false },
      ]

      expect(() => native.nativeBenchmarkPlan({
        id: 'empty-cases',
        suite: 'families-v1',
        cases: [],
        variants,
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 1,
      })).toThrow(/cases/)

      expect(() => native.nativeBenchmarkPlan({
        id: 'dup-cases',
        suite: 'families-v1',
        cases: [firstId, firstId],
        variants,
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 1,
      })).toThrow(/unique/)

      expect(() => native.nativeBenchmarkPlan({
        id: 'bad-case',
        suite: 'families-v1',
        cases: ['does-not-exist'],
        variants,
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 1,
      })).toThrow(/unique|cases/)

      expect(() => corpus.familiesScenario('nonexistent-scenario-id' as never)).toThrow()
    })

    test('T2-F06-03: missing baseline, ablation without candidate, multi-feature ablation & memory on families-v1 are rejected', async () => {
      const native = await loadNativeBenchmark()
      const schemaMod = (await loadPackageModule('assistant-evaluation/benchmark/schema')) as {
        parseBenchmarkPlan: (raw: unknown) => unknown
      }
      const corpus = await loadFamiliesCorpus()
      const firstId = corpus.familiesDevelopmentCases()[0]!.id

      expect(() => native.nativeBenchmarkPlan({
        id: 'no-base',
        suite: 'families-v1',
        cases: [firstId],
        variants: [
          { id: 'cand1', role: 'candidate', persona: 'p1', memory: false, review: false, planning: true, growth: false },
          { id: 'cand2', role: 'candidate', persona: 'p2', memory: false, review: false, planning: false, growth: true },
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 1,
      })).toThrow(/baseline/)

      expect(() => native.nativeBenchmarkPlan({
        id: 'abl-no-cand',
        suite: 'families-v1',
        cases: [firstId],
        variants: [
          { id: 'base', role: 'baseline', persona: 'p', memory: false, review: false, planning: false, growth: false },
          { id: 'abl', role: 'ablation', persona: 'p', memory: false, review: false, planning: false, growth: false },
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 1,
      })).toThrow(/candidate/)

      expect(() => native.nativeBenchmarkPlan({
        id: 'mem-families',
        suite: 'families-v1',
        cases: [firstId],
        variants: [
          { id: 'base', role: 'baseline', persona: 'p', memory: false, review: false, planning: false, growth: false },
          { id: 'cand', role: 'candidate', persona: 'p', memory: true, review: false, planning: true, growth: false },
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 1,
      })).toThrow(/memory/)

      const vObj = {
        model: sha256Hex('m'),
        prompt: sha256Hex('p'),
        skills: sha256Hex('s'),
        tools: sha256Hex('t'),
        policy: sha256Hex('pol'),
        runtime: sha256Hex('rt'),
      }
      expect(() => schemaMod.parseBenchmarkPlan({
        schemaVersion: 1,
        id: 'two-disabled',
        dataset: { id: 'families-v1', version: '2', digest: sha256Hex('ds'), split: 'development' },
        comparison: 'capability',
        cases: [{ id: 'c1', domain: 'reasoning', inputDigest: sha256Hex('in1'), acceptanceDigest: sha256Hex('acc1') }],
        variants: [
          { id: 'base', role: 'baseline', versions: vObj, features: { memory: false, planning: false, review: false, growth: false } },
          { id: 'cand', role: 'candidate', versions: vObj, features: { memory: false, planning: true, review: false, growth: true } },
          { id: 'abl-both', role: 'ablation', versions: vObj, features: { memory: false, planning: false, review: false, growth: false } },
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 1,
      })).toThrow(/ablation must disable exactly one|unexpected benchmark fields/)
    })

    test('T2-F06-04: repeats (2..20) and seed (0..0xffffffff) enforce exact BVA integer bounds', async () => {
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const firstId = corpus.familiesDevelopmentCases()[0]!.id
      const variants = [
        { id: 'base', role: 'baseline' as const, persona: 'p', memory: false, review: false, planning: false, growth: false },
        { id: 'cand', role: 'candidate' as const, persona: 'p', memory: false, review: false, planning: true, growth: false },
      ]

      expect(() => native.nativeBenchmarkPlan({
        id: 'rep-low', suite: 'families-v1', cases: [firstId], variants, model: sampleModelConfig(), budget: sampleBudget(), repeats: 1, seed: 0,
      })).toThrow(/repeats/)
      expect(() => native.nativeBenchmarkPlan({
        id: 'rep-high', suite: 'families-v1', cases: [firstId], variants, model: sampleModelConfig(), budget: sampleBudget(), repeats: 21, seed: 0,
      })).toThrow(/repeats/)
      expect(() => native.nativeBenchmarkPlan({
        id: 'seed-neg', suite: 'families-v1', cases: [firstId], variants, model: sampleModelConfig(), budget: sampleBudget(), repeats: 2, seed: -1,
      })).toThrow(/seed/)
      expect(() => native.nativeBenchmarkPlan({
        id: 'seed-over', suite: 'families-v1', cases: [firstId], variants, model: sampleModelConfig(), budget: sampleBudget(), repeats: 2, seed: 0x1_0000_0000,
      })).toThrow(/seed/)

      const minOk = native.nativeBenchmarkPlan({
        id: 'bva-min', suite: 'families-v1', cases: [firstId], variants, model: sampleModelConfig(), budget: sampleBudget(), repeats: 2, seed: 0,
      })
      const maxOk = native.nativeBenchmarkPlan({
        id: 'bva-max', suite: 'families-v1', cases: [firstId], variants, model: sampleModelConfig(), budget: sampleBudget(), repeats: 20, seed: 0xffffffff,
      })
      expect(minOk.repeats).toBe(2)
      expect(maxOk.seed).toBe(0xffffffff)
    })

    test('T2-F06-05: non-quiescent execution halts runBenchmark immediately and leaves report incomplete', async () => {
      const ws = await workspaces.create('f06-quiesce-')
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const runnerMod = await loadBenchmarkRunner()
      const { BenchmarkStore } = await loadBenchmarkStore()
      const { benchmarkReport } = await loadBenchmarkIndex()

      const plan = native.nativeBenchmarkPlan({
        id: 'non-quiescent',
        suite: 'families-v1',
        cases: [corpus.familiesDevelopmentCases()[0]!.id],
        variants: [
          { id: 'base', role: 'baseline', persona: 'p', memory: false, review: false, planning: false, growth: false },
          { id: 'cand', role: 'candidate', persona: 'p', memory: false, review: false, planning: true, growth: false },
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(),
        repeats: 2,
        seed: 5,
      })

      const store = new (BenchmarkStore as new (path: string) => { close?: () => void })(ws.sqlitePath('bench'))
      try {
        const results = await runnerMod.runBenchmark(store as never, plan, {
          execute: async (req: {
            variant: { versions: unknown }
            task: { inputDigest: string; acceptanceDigest: string }
          }) => ({
            versions: req.variant.versions,
            inputDigest: req.task.inputDigest,
            acceptanceDigest: req.task.acceptanceDigest,
            verdict: 'achieved',
            evidenceDigest: sha256Hex('obs-ev-05'),
            quiescent: false,
            metrics: {
              inputTokens: 10,
              outputTokens: 5,
              costUsdMicros: 1,
              toolCalls: 0,
              rework: 0,
              interventions: 0,
              latencyMs: 10,
            },
          }),
        } as never)
        expect(results).toHaveLength(1)
        expect(results[0]?.status).toBe('unknown')
        expect(results[0]?.reason).toBe('not-quiescent')
        const report = benchmarkReport(plan, results)
        expect(report.complete).toBe(false)
      } finally {
        store.close?.()
      }
    })
  })

  describe('F07: R3 explicit false overrides, malformed Standard-Schema & plugin-setup edge rejections', () => {
    test('T2-F07-01: explicit false overrides suppress R3 defaults across WorkItems, Proactive & Evaluation', async () => {
      const ws = await workspaces.create('f07-false-')
      const { ConfigSchema: WorkItemsConfig } = await loadAssistantWorkItems()
      const { Config: ProactiveConfig } = await loadAssistantProactive()
      const { Config: EvalConfig } = await loadAssistantEvaluation()

      const wi = WorkItemsConfig({
        databasePath: ws.sqlitePath('wi'),
        workRoot: ws.workspace,
        enabled: false,
        intakeLedger: { enabled: false },
      })
      expect(wi.enabled).toBe(false)
      expect(wi.intakeLedger?.enabled).toBe(false)

      const pro = ProactiveConfig({ intakeEvaluation: { enabled: false } })
      expect(pro.intakeEvaluation?.enabled).toBe(false)

      const ev = EvalConfig({
        databasePath: ws.sqlitePath('eval'),
        notificationOutcomesEnabled: false,
        attentionTuningAutoAdopt: false,
        attentionLooseningEnabled: false,
      })
      expect(ev.notificationOutcomesEnabled).toBe(false)
      expect(ev.attentionTuningAutoAdopt).toBe(false)
      expect(ev.attentionLooseningEnabled).toBe(false)
    })

    test('T2-F07-02: malformed Standard-Schema configs fail validation across WorkItems, Evaluation & Proactive', async () => {
      const ws = await workspaces.create('f07-schema-')
      const { normalizeConfig: normalizeWorkItemsConfig } = (await loadPackageModule('assistant-work-items/config')) as {
        normalizeConfig: (c: unknown) => unknown
      }
      const { Config: EvalConfig } = await loadAssistantEvaluation()
      const { Config: ProactiveConfig } = await loadAssistantProactive()

      expect(() => normalizeWorkItemsConfig({ databasePath: 'relative.sqlite', workRoot: ws.workspace })).toThrow()
      expect(() => normalizeWorkItemsConfig({ databasePath: ws.workspace, workRoot: ws.workspace })).toThrow()
      expect(() => normalizeWorkItemsConfig({
        databasePath: ws.sqlitePath('wi'),
        workRoot: ws.workspace,
        intakeLedger: { enabled: true, evaluation: { enabled: true, timeoutMs: 99 } },
      })).toThrow()
      expect(() => normalizeWorkItemsConfig({
        databasePath: ws.sqlitePath('wi'),
        workRoot: ws.workspace,
        intakeLedger: { enabled: true, evaluation: { enabled: true, admit: { enabled: true, maxPerHour: 101 } } },
      })).toThrow()

      expect(() => EvalConfig({ databasePath: ws.sqlitePath('eval'), attentionTuningMinSample: 4 })).toThrow()
      expect(() => EvalConfig({ databasePath: ws.sqlitePath('eval'), attentionLooseningReplayWindowMs: 1_000 })).toThrow()
      expect(() => ProactiveConfig({ profiles: [{ id: 'p1', mode: 'remind', expectedBenefit: 10, successPpm: 1_000_001 }] } as never)).toThrow()
    })

    test('T2-F07-03: plugin-setup rejects corrupted/non-sequence cordis.patch.yml and unknown preset names', async () => {
      const ws = await workspaces.create('f07-corrupt-patch-')
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })

      await writeFile(join(profileDir, 'cordis.patch.yml'), 'id: not-a-sequence\n', 'utf8')
      const nonSeq = await runPluginSetupInProcess(
        ['preset', 'recommended', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        { dshHome: ws.dshHome, readDump: async () => [] },
      )
      expect(nonSeq.exitCode).toBe(1)
      expect(nonSeq.stderr).toMatch(/sequence/i)

      await writeFile(join(profileDir, 'cordis.patch.yml'), '- [unclosed\n', 'utf8')
      const badYaml = await runPluginSetupInProcess(
        ['preset', 'recommended', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        { dshHome: ws.dshHome, readDump: async () => [] },
      )
      expect(badYaml.exitCode).toBe(1)

      await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
      const unknownPreset = await runPluginSetupInProcess(
        ['preset', 'nonexistent-preset', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        { dshHome: ws.dshHome, readDump: async () => [] },
      )
      expect(unknownPreset.exitCode).toBe(1)
      expect(unknownPreset.stderr).toMatch(/unknown preset/i)
    })

    test('T2-F07-04: plugin-setup rolls back cordis.patch.yml byte-for-byte when post-write verification fails', async () => {
      const ws = await workspaces.create('f07-rb-')
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      const patchPath = join(profileDir, 'cordis.patch.yml')
      const original = '- id: dsh-enhanced-assistant-work-items\n  config:\n    enabled: false\n'
      await writeFile(patchPath, original, 'utf8')

      const res = await runPluginSetupInProcess(
        ['enable', 'assistant-work-items', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        {
          dshHome: ws.dshHome,
          readDump: async () => {
            throw new Error('simulated dump failure')
          },
        },
      )
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/simulated dump failure/i)
      expect(await readFile(patchPath, 'utf8')).toBe(original)

      // Also when cordis.patch.yml did not exist before, failed verify deletes the newly written file.
      const freshHome = join(ws.root, 'fresh-home')
      mkdirSync(join(freshHome, 'profiles', 'web'), { recursive: true })
      const setup = await loadPluginSetup()
      const applyPreset = getExportFn<(t: Record<string, unknown>, o?: Record<string, unknown>) => Promise<unknown>>(
        setup,
        'applyRecommendedPluginPreset',
      )
      await expect(applyPreset(
        { dshHome: freshHome, profile: 'web' },
        { readDump: async () => { throw new Error('verify boom') } },
      )).rejects.toThrow()
      await expect(stat(join(freshHome, 'profiles', 'web', 'cordis.patch.yml'))).rejects.toThrow()
    })

    test('T2-F07-05: plugin-setup refuses protected rows, protected ownerRoutes/policyRef keys & secret-named keys', async () => {
      const ws = await workspaces.create('f07-protect-')
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')

      const readDump = async () => []
      const disablePolicy = await runPluginSetupInProcess(
        ['disable', 'assistant-policy', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        { dshHome: ws.dshHome, readDump },
      )
      expect(disablePolicy.exitCode).toBe(1)

      const editRoutes = await runPluginSetupInProcess(
        ['set', 'assistant-delivery', 'ownerRoutes', '[]', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        { dshHome: ws.dshHome, readDump },
      )
      expect(editRoutes.exitCode).toBe(1)

      const editPolicyRef = await runPluginSetupInProcess(
        ['set', 'assistant-delivery', 'policyRef', 'tamper', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        { dshHome: ws.dshHome, readDump },
      )
      expect(editPolicyRef.exitCode).toBe(1)

      const secretKey = await runPluginSetupInProcess(
        ['set', 'assistant-work-items', 'apiKey', 'sk-secret', '--yes', '--profile', 'web', '--dsh-home', ws.dshHome],
        { dshHome: ws.dshHome, readDump },
      )
      expect(secretKey.exitCode).toBe(1)
    })
  })
})
