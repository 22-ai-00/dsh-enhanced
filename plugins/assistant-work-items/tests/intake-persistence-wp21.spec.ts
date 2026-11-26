import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-ray/assistant-verifier'
import type { AcceptanceTask, AcceptedExecution, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '@dsh-ray/assistant-verifier'
import type { TaskAcceptanceContract } from '@dsh-ray/task-acceptance-contract'
import type { Config } from '../src/config.ts'
import { classifyIntake } from '../src/intake.ts'
import type { PeerDeliveryService } from '../src/peers.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { WorkItemStore } from '../src/store.ts'
import { PRESET } from './fixtures.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const SHA = 'a'.repeat(64)
const futureExpiry = () => Date.now() + 3_600_000

class MockGoalsProducer implements TaskAcceptanceProducer {
  registration: TaskAcceptanceRegistration | undefined
  readonly generation = crypto.randomUUID()
  trustedAcceptanceProducerGeneration(): string { return this.generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    const owner = registration.owner as AssistantVerifierService
    if (!owner.ownsTaskAcceptanceRegistration(registration)) throw new Error('foreign registration')
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedExecution(_contract: TaskAcceptanceContract): Promise<AcceptedExecution | null> { return null }
}

async function createVerifier(root: string, objective: string) {
  const ctx = new Context(); contexts.push(ctx)
  const producer = new MockGoalsProducer()
  ctx.provide('assistantGoals' as never, producer as never)
  const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/doc' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
  const [installed] = createVerifierAuthorities({ authorities: [authority] })
  const verifier = new AssistantVerifierService(ctx, {
    databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority],
    profiles: [{
      id: 'wp21-profile', version: 1, scope: { workspace: root, preset: PRESET },
      owner: { principalRecordId: 'principal-1', principalVersion: 7 },
      taskKind: 'goal-outcome' as const, objective, validityMs: 600_000,
      bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
      criteria: [{
        id: 'doc', kind: 'document-citations' as const,
        authority: { id: installed!.id, digest: installed!.digest },
        artifactPath: 'doc.md', requiredText: ['Verified'], quotes: [],
      }],
    }],
  })
  const handle = producer.registration!.prepare({
    scope: { workspace: root, preset: PRESET },
    owner: { principalRecordId: 'principal-1', principalVersion: 7 },
    task: {
      kind: 'goal-outcome', ref: 'assessment-1',
      goal: { id: 'goal-1', definitionVersion: 2, definitionDigest: SHA, assessmentId: 'assessment-1', sessionId: 'session-1', nativeGoalId: 'native-goal-1' },
    },
    objective,
  } as AcceptanceTask)!
  return { verifier, handle }
}

function provideBasicPeers(ctx: Context, options: {
  onObserver?: (observer: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0]) => void
  onWake?: (cb: () => void) => void
  onEventObserver?: (observer: unknown) => void
  policyRuleId?: string
} = {}) {
  const ruleId = options.policyRuleId ?? 'triage'
  ctx.provide('assistantPolicy' as never, {
    authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId }),
    evaluate: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId }),
  } as never)
  ctx.provide('assistantDelivery' as never, {
    isMaintenanceDraining: () => false,
    validateOwnerRoute: (value: Record<string, unknown>) => ({
      receiptVersion: 2, ...value, authorityHash: 'sha256:owner',
      principalRecordId: 'principal-1', principalVersion: 7, bindingVersion: 1, generation: 1,
    }),
    enqueueBackground: async () => ({ id: 'outbox-1' }),
    registerInboundIntakeObserver: (observer: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0]) => {
      options.onObserver?.(observer)
      return () => {}
    },
  } as never)
  if (options.onWake) {
    ctx.provide('assistantAutomations' as never, {
      onSchedulerWake: (cb: () => void) => {
        options.onWake!(cb)
        return () => {}
      },
      ingestExternal: () => ({ id: 'occ-1' }),
    } as never)
  }
  if (options.onEventObserver) {
    ctx.provide('eventTriggers' as never, {
      registerIntakeObserver: (observer: unknown) => {
        options.onEventObserver!(observer)
        return () => {}
      },
    } as never)
  }
}

function activeConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    mode: 'active',
    databasePath: join(root, 'items.sqlite'),
    workRoot: join(root, 'work'),
    workerAutomationId: 'worker',
    scope: { workspace: root, preset: PRESET, principalId: 'owner:one', ownerRouteId: 'route-1', expiresAt: futureExpiry() },
    admission: { allowedKinds: ['review', 'triage'], maxOpenItems: 10, maxAdmitsPerHour: 20, cooldownMs: 0 },
    intakeLedger: {
      enabled: true,
      evaluation: {
        enabled: true,
        admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
      },
    },
    ...overrides,
  }
}

function inferredCandidate(sourceEventId: string, contentDigest: string, occurredAt = 1_700_000_000_000) {
  return classifyIntake({
    source: 'lark-channel', sourceEventId, kind: 'message',
    senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
    contentDigest, occurredAt,
  })
}

describe('WP21 restart-persistent intake admission, sealing, eval queue & live tuning', () => {
  test('WP21-T1: encrypted staging persists sourceText & hints across restart with 0 plaintext in sqlite/wal and cleans up after admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t1-')); roots.push(root)
    await writeFile(join(root, 'doc.md'), 'Verified\n')
    const canary = 'CANARY_WP21_SECRET_TEXT_DO_NOT_LEAK_PLAINTEXT'
    const digest = sha256(canary)
    const { verifier, handle } = await createVerifier(root, canary)

    // Phase 1: record intake + sourceText before evaluation completes -> restart mid-flight -> evaluate -> restart -> admit
    const ctx1 = new Context(); contexts.push(ctx1)
    ctx1.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx1)
    const s1 = new AssistantWorkItemsService(ctx1, activeConfig(root))
    s1.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-wp21-1', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: digest, occurredAt: 1_700_000_000_000, objective: canary, objectiveDigest: digest,
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    }, canary)

    // Verify zero plaintext in SQLite / WAL files and 0o600 seal key permissions
    const dbPath = join(root, 'items.sqlite')
    const keyPath = `${dbPath}.intake-seal.key`
    expect(existsSync(keyPath)).toBe(true)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(canary))).toBe(false)
    }
    s1.close()

    // Phase 2: restart, register evaluator, let rehydrated sourceText evaluate
    const ctx2 = new Context(); contexts.push(ctx2)
    ctx2.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx2)
    const s2 = new AssistantWorkItemsService(ctx2, activeConfig(root))
    s2.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: async req => {
        expect(req.sourceText).toBe(canary)
        return { level: 'accept', quotes: ['CANARY_WP21'] }
      },
    })
    await vi.waitFor(() => expect(s2.intakeEvaluations('lark-channel', 'om-wp21-1')).toHaveLength(1), { timeout: 5_000 })
    s2.close()

    // Phase 3: third restart runs admission with persisted encrypted hint (no evaluator registered needed!)
    const ctx3 = new Context(); contexts.push(ctx3)
    ctx3.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx3)
    const s3 = new AssistantWorkItemsService(ctx3, activeConfig(root))
    try {
      const firstRun = s3.runIntakeAdmission()
      expect(firstRun).toMatchObject([{ mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) }])
      // Replay runs cleanly without duplicate admission
      expect(s3.runIntakeAdmission()).toEqual([])
      expect(s3.intakeAdmissions('lark-channel', 'om-wp21-1')).toHaveLength(1)

      const store = new WorkItemStore(dbPath)
      try {
        expect(store.readIntakeStagingHint('lark-channel', 'om-wp21-1')).toBeUndefined()
      } finally { store.close() }
    } finally { s3.close() }
  })

  test('WP21-T2: fail-closed on tampered ciphertext/tag/AAD, missing seal key, expired TTL, or contractDigest mismatch', async () => {
    // (a) Tampered auth tag and AAD contentDigest mismatch
    const rootTamper = await mkdtemp(join(tmpdir(), 'wp21-t2-tamper-')); roots.push(rootTamper)
    const dbTamper = join(rootTamper, 'items.sqlite')
    const storeTamper = new WorkItemStore(dbTamper)
    const secret = 'tamper-sensitive objective'
    const digest = sha256(secret)
    storeTamper.recordIntake(inferredCandidate('om-tamper', digest))
    storeTamper.upsertIntakeStaging({
      source: 'lark-channel', sourceEventId: 'om-tamper',
      objective: { text: secret, digest },
      acceptance: { contractId: 'c-1', contractDigest: 'b'.repeat(64) },
    })
    expect(storeTamper.readIntakeStagingHint('lark-channel', 'om-tamper')).toMatchObject({ objective: { text: secret } })
    storeTamper.close()

    const raw = new DatabaseSync(dbTamper)
    raw.exec("UPDATE work_item_intake_staging SET auth_tag = zeroblob(16) WHERE source_event_id = 'om-tamper'")
    raw.close()
    const storeAfter = new WorkItemStore(dbTamper)
    expect(storeAfter.readIntakeStagingHint('lark-channel', 'om-tamper')).toBeUndefined()
    storeAfter.close()

    // (a2) Mismatched content_digest AAD binding in staging row fails closed
    const rootAad = await mkdtemp(join(tmpdir(), 'wp21-t2-aad-')); roots.push(rootAad)
    const dbAad = join(rootAad, 'items.sqlite')
    const storeAad = new WorkItemStore(dbAad)
    storeAad.recordIntake(inferredCandidate('om-aad', digest))
    storeAad.upsertIntakeStaging({
      source: 'lark-channel', sourceEventId: 'om-aad',
      objective: { text: secret, digest },
    })
    storeAad.close()
    const rawAad = new DatabaseSync(dbAad)
    rawAad.prepare("UPDATE work_item_intake_staging SET content_digest = ? WHERE source_event_id = 'om-aad'").run(sha256('wrong'))
    rawAad.close()
    const storeAadAfter = new WorkItemStore(dbAad)
    expect(storeAadAfter.readIntakeStagingHint('lark-channel', 'om-aad')).toBeUndefined()
    storeAadAfter.close()

    // (b) Missing seal key on restart causes auto admission to fail closed (not crash)
    const rootKey = await mkdtemp(join(tmpdir(), 'wp21-t2-key-')); roots.push(rootKey)
    await writeFile(join(rootKey, 'doc.md'), 'Verified\n')
    const { verifier, handle } = await createVerifier(rootKey, secret)
    const ctx1 = new Context(); contexts.push(ctx1)
    ctx1.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx1)
    const s1 = new AssistantWorkItemsService(ctx1, activeConfig(rootKey))
    s1.registerIntakeEvaluator({
      protocol: 1, policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: async () => ({ level: 'accept', quotes: ['tamper-sensitive'] }),
    })
    s1.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-nokey', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: digest, occurredAt: 1_700_000_000_000, objective: secret, objectiveDigest: digest,
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    }, secret)
    await vi.waitFor(() => expect(s1.intakeEvaluations('lark-channel', 'om-nokey')).toHaveLength(1), { timeout: 5_000 })
    s1.close()
    await unlink(join(rootKey, 'items.sqlite.intake-seal.key'))

    const ctx2 = new Context(); contexts.push(ctx2)
    ctx2.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx2)
    const s2 = new AssistantWorkItemsService(ctx2, activeConfig(rootKey))
    expect(s2.runIntakeAdmission()).toMatchObject([{ mode: 'observe', outcome: 'would-admit', itemId: null }])
    s2.close()

    // (c) TTL expiry prunes unsealed staging
    const rootTtl = await mkdtemp(join(tmpdir(), 'wp21-t2-ttl-')); roots.push(rootTtl)
    let now = 1_700_000_000_000
    const storeTtl = new WorkItemStore(join(rootTtl, 'items.sqlite'), { now: () => now })
    storeTtl.recordIntake(inferredCandidate('om-ttl', digest, now))
    storeTtl.upsertIntakeStaging({ source: 'lark-channel', sourceEventId: 'om-ttl', objective: { text: secret, digest } })
    now += 8 * 24 * 60 * 60 * 1000
    expect(storeTtl.pruneIntakeStaging(now)).toBeGreaterThanOrEqual(1)
    expect(storeTtl.readIntakeStagingHint('lark-channel', 'om-ttl')).toBeUndefined()
    storeTtl.close()

    // (d) :memory: store seals/unseals cleanly using ephemeral process key
    const memStore = new WorkItemStore(':memory:')
    memStore.recordIntake(inferredCandidate('om-mem', digest))
    memStore.upsertIntakeStaging({ source: 'lark-channel', sourceEventId: 'om-mem', objective: { text: secret, digest } })
    expect(memStore.readIntakeStagingHint('lark-channel', 'om-mem')?.objective?.text).toBe(secret)
    memStore.close()

    // (e) contractDigest mismatch at admission after restart fails closed to would-admit
    const rootDrift = await mkdtemp(join(tmpdir(), 'wp21-t2-drift-')); roots.push(rootDrift)
    await writeFile(join(rootDrift, 'doc.md'), 'Verified\n')
    const { verifier: vDrift, handle: hDrift } = await createVerifier(rootDrift, secret)
    const ctxD1 = new Context(); contexts.push(ctxD1)
    ctxD1.provide('assistantVerifier' as never, vDrift as never)
    provideBasicPeers(ctxD1)
    const sD1 = new AssistantWorkItemsService(ctxD1, activeConfig(rootDrift))
    sD1.registerIntakeEvaluator({
      protocol: 1, policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: async () => ({ level: 'accept', quotes: ['tamper-sensitive'] }),
    })
    sD1.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-drift', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: digest, occurredAt: 1_700_000_000_000, objective: secret, objectiveDigest: digest,
      acceptance: { contractId: hDrift.contractId, contractDigest: 'f'.repeat(64) },
    }, secret)
    await vi.waitFor(() => expect(sD1.intakeEvaluations('lark-channel', 'om-drift')).toHaveLength(1), { timeout: 5_000 })
    sD1.close()

    const ctxD2 = new Context(); contexts.push(ctxD2)
    ctxD2.provide('assistantVerifier' as never, vDrift as never)
    provideBasicPeers(ctxD2)
    const sD2 = new AssistantWorkItemsService(ctxD2, activeConfig(rootDrift))
    expect(sD2.runIntakeAdmission()).toMatchObject([{ mode: 'auto', outcome: 'refused', reasonCode: 'acceptance-mismatch', itemId: null }])
    sD2.close()
  })

  test('WP21-T3: mid-backoff evaluation queue progress survives restart and bounded 256-entry eviction works', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t3-')); roots.push(root)
    const now = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)

    const cfg = activeConfig(root, {
      intakeLedger: {
        enabled: true,
        evaluation: { enabled: true, maxConsecutiveFailures: 2, timeoutMs: 5_000, maxPerRun: 5, maxCallsPerHour: 20 },
      },
    })

    // First service: 1 failing attempt -> records attempts=1, failures=1, next_at = now + 30_000
    const ctx1 = new Context(); contexts.push(ctx1)
    provideBasicPeers(ctx1)
    const s1 = new AssistantWorkItemsService(ctx1, cfg)
    let calls1 = 0
    const unregister1 = s1.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: async () => { calls1 += 1; throw new Error('transient model error') },
    })
    const body = 'check build failure'
    const digest = sha256(body)
    s1.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-backoff', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: digest, occurredAt: now,
    }, body)
    await vi.waitFor(() => expect(calls1).toBe(1), { timeout: 5_000 })
    // Verify unregister clears in-memory held texts cleanly
    unregister1()
    expect(s1.intakeEvaluationHealth()?.heldTexts).toBe(0)
    s1.close()

    // Check durable eval queue row survived
    const inspectStore = new WorkItemStore(join(root, 'items.sqlite'))
    const queued = inspectStore.getIntakeEvalQueue('lark-channel', 'om-backoff', 'triage', 'v1')
    expect(queued).toMatchObject({ attempts: 1, failures: 1 })
    expect(queued!.nextAt).toBeGreaterThanOrEqual(now + 1_000)
    expect(queued!.nextAt).toBeLessThan(now + 2_000)
    inspectStore.close()

    // Second service before backoff expires -> does not evaluate early
    const ctx2 = new Context(); contexts.push(ctx2)
    provideBasicPeers(ctx2)
    const s2 = new AssistantWorkItemsService(ctx2, cfg)
    let calls2 = 0
    s2.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: async () => { calls2 += 1; throw new Error('second failure') },
    })
    expect(calls2).toBe(0)

    // Advance past 1s backoff -> 2nd failure hits maxConsecutiveFailures=2 and emits unavailable row
    vi.setSystemTime(now + 1_500)
    await s2.runIntakeEvaluation()
    expect(calls2).toBe(1)
    expect(s2.intakeEvaluations('lark-channel', 'om-backoff')).toMatchObject([{ status: 'unavailable', attempts: 2 }])
    s2.close()

    // Bounded 256-entry eviction in staging store keeps settled/oldest rows bounded at 256
    const rootBound = await mkdtemp(join(tmpdir(), 'wp21-t3-bound-')); roots.push(rootBound)
    let boundNow = 1_700_000_000_000
    const boundStore = new WorkItemStore(join(rootBound, 'items.sqlite'), { now: () => boundNow })
    for (let index = 0; index < 260; index += 1) {
      boundNow += 1
      const text = `bounded-text-${index}`
      const contentDigest = sha256(text)
      const id = `om-bound-${index}`
      boundStore.recordIntake(inferredCandidate(id, contentDigest, boundNow))
      boundStore.upsertIntakeStaging({
        source: 'lark-channel', sourceEventId: id, sourceText: text,
      })
    }
    const rawBound = new DatabaseSync(join(rootBound, 'items.sqlite'), { readOnly: true })
    const countRow = rawBound.prepare('SELECT COUNT(*) AS n FROM work_item_intake_staging').get() as { n: number }
    rawBound.close()
    expect(countRow.n).toBeLessThanOrEqual(256)
    boundStore.close()
  }, 15_000)

  test('WP21-T4: live mode switching, per-rule tuning overrides, dynamic Delivery getter, and fail-closed reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t4-')); roots.push(root)
    await writeFile(join(root, 'doc.md'), 'Verified\n')
    const text1 = 'review PR 101'
    const { verifier, handle } = await createVerifier(root, text1)

    let observedGetter: { acceptsIntakeObjective?: boolean } | undefined
    const ctx1 = new Context(); contexts.push(ctx1)
    ctx1.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx1, { onObserver: obs => { observedGetter = obs } })

    const cfgObserve = activeConfig(root, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctx1.plugin(AssistantWorkItemsService, cfgObserve).await()
    const s1 = ctx1.assistantWorkItems
    expect(s1.intakeAdmissionMode()).toBe('observe')
    expect(observedGetter?.acceptsIntakeObjective).toBeUndefined()

    // Switch live from observe -> auto + disable secondary rule (leaving triage on global mode)
    const tuned = s1.applyIntakeTuning({
      workItemsMode: 'auto',
      intakeRuleUpdates: [
        { ruleId: 'triage', enabled: true },
        { ruleId: 'noisy', enabled: false, mode: 'observe' },
      ],
    })
    expect(tuned).toMatchObject({
      mode: 'auto',
      rules: [
        { ruleId: 'triage', enabled: true },
        { ruleId: 'noisy', enabled: false, mode: 'observe' },
      ],
    })
    expect(s1.intakeAdmissionMode()).toBe('auto')
    expect(observedGetter?.acceptsIntakeObjective).toBe(true)

    s1.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'noisy', ceiling: 'accept' },
        ],
      }),
      evaluate: async () => ({ level: 'accept', quotes: ['review PR'] }),
    })

    // Switch back to observe dynamically (global mode applies to 'triage')
    expect(s1.setIntakeAdmissionMode('observe')).toBe('observe')
    expect(observedGetter?.acceptsIntakeObjective).toBeUndefined()

    const text0 = 'review PR 100'
    s1.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-live-1', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text0), occurredAt: 1_700_000_000_000, objective: text0, objectiveDigest: sha256(text0),
    }, text0)
    await vi.waitFor(() => expect(s1.intakeEvaluations('lark-channel', 'om-live-1')).toHaveLength(1), { timeout: 5_000 })
    // Disabled 'noisy' rule produced no evaluation row
    expect(s1.intakeEvaluations('lark-channel', 'om-live-1').map(r => r.ruleId)).toEqual(['triage'])
    // Currently in observe -> would-admit
    expect(s1.runIntakeAdmission()).toMatchObject([{ mode: 'observe', outcome: 'would-admit', itemId: null }])

    // Switch back to auto live + set per-rule mode -> persisted override survives restart
    s1.applyIntakeTuning({
      workItemsMode: 'auto',
      intakeRuleUpdates: [{ ruleId: 'triage', enabled: true, mode: 'auto' }],
    })
    expect(s1.intakeAdmissionMode()).toBe('auto')
    s1.close()

    const ctx2 = new Context(); contexts.push(ctx2)
    ctx2.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx2)
    const s2 = new AssistantWorkItemsService(ctx2, cfgObserve)
    expect(s2.intakeAdmissionMode()).toBe('auto')
    expect(s2.intakeTuning().rules).toEqual([
      { ruleId: 'triage', enabled: true, mode: 'auto' },
      { ruleId: 'noisy', enabled: false, mode: 'observe' },
    ])
    // Now admits om-live-2 while keeping persisted auto mode
    s2.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-live-2', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text1), occurredAt: 1_700_000_001_000, objective: text1, objectiveDigest: sha256(text1),
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    }, text1)
    s2.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: async () => ({ level: 'accept', quotes: ['review PR'] }),
    })
    await vi.waitFor(() => expect(s2.intakeEvaluations('lark-channel', 'om-live-2')).toHaveLength(1), { timeout: 5_000 })
    expect(s2.runIntakeAdmission()).toMatchObject([{ mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) }])
    s2.close()

    // Fail-closed revalidation on restart when static config changes to mode: 'observe'
    const ctx3 = new Context(); contexts.push(ctx3)
    provideBasicPeers(ctx3)
    const s3 = new AssistantWorkItemsService(ctx3, { ...cfgObserve, mode: 'observe' })
    expect(s3.intakeAdmissionMode()).toBe('observe')
    expect(s3.intakeTuning().mode).toBe('observe')
    s3.close()
  }, 15_000)

  test('WP21-T5: R3 minimal-config default-on opens enabled observe intake with observers and scheduler wake subscribed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t5-r3-')); roots.push(root)
    const ctx = new Context(); contexts.push(ctx)
    let deliveryObserverCount = 0
    let eventObserverCount = 0
    let wakeCount = 0
    provideBasicPeers(ctx, {
      onObserver: () => { deliveryObserverCount += 1 },
      onEventObserver: () => { eventObserverCount += 1 },
      onWake: () => { wakeCount += 1 },
    })

    await ctx.plugin(AssistantWorkItemsService, {
      databasePath: join(root, 'minimal.sqlite'),
      workRoot: join(root, 'work'),
    }).await()
    const service = ctx.assistantWorkItems
    try {
      expect(service.enabled).toBe(true)
      expect(service.mode).toBe('observe')
      expect(deliveryObserverCount).toBe(1)
      expect(eventObserverCount).toBe(1)
      expect(wakeCount).toBe(1)
      expect(service.health()).toMatchObject({ enabled: true, mode: 'observe', openItems: 0 })
      expect(service.intakeAdmissionMode()).toBe('disabled')
    } finally {
      service.close()
    }
  })

  test('WP21-T6: selective per-rule auto under global observe enables acceptsIntakeObjective and admits selectively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t6-per-rule-')); roots.push(root)
    await writeFile(join(root, 'doc.md'), 'Verified\n')
    const text1 = 'selective auto triage objective'
    const text2 = 'global auto with selective observe objective'
    const { verifier, handle } = await createVerifier(root, text1)

    let observedGetter: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx, { onObserver: obs => { observedGetter = obs } })

    const cfgObserve = activeConfig(root, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctx.plugin(AssistantWorkItemsService, cfgObserve).await()
    const service = ctx.assistantWorkItems
    expect(service.intakeAdmissionMode()).toBe('observe')
    expect(observedGetter?.acceptsIntakeObjective).toBeUndefined()

    // Promote only 'triage' to 'auto' while global mode stays 'observe'
    service.applyIntakeTuning({
      workItemsMode: 'observe',
      intakeRuleUpdates: [{ ruleId: 'triage', enabled: true, mode: 'auto' }],
    })
    expect(service.intakeAdmissionMode()).toBe('observe')
    expect(observedGetter?.acceptsIntakeObjective).toBe(true)

    service.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'other', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => ({
        level: 'accept',
        quotes: [req.sourceText.slice(0, 10)],
      }),
    })

    // Simulate Delivery attaching objective + acceptance because acceptsIntakeObjective === true
    expect(observedGetter?.acceptsIntakeObjective).toBe(true)
    observedGetter!.observe({
      source: 'lark-channel', sourceEventId: 'om-selective-1', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text1), occurredAt: 1_700_000_000_000,
      sourceText: text1, objective: text1, objectiveDigest: sha256(text1),
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    } as Parameters<NonNullable<typeof observedGetter>['observe']>[0])

    await vi.waitFor(() => expect(service.intakeEvaluations('lark-channel', 'om-selective-1')).toHaveLength(2), { timeout: 5_000 })
    const admissions1 = service.runIntakeAdmission()
    const byRule1 = Object.fromEntries(admissions1.map(a => [a.ruleId, a]))
    expect(byRule1['triage']).toMatchObject({ mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) })
    expect(byRule1['other']).toMatchObject({ mode: 'observe', outcome: 'would-admit', itemId: null })
    expect(service.health().openItems).toBe(1)

    const inspected1 = Object.fromEntries(
      service.listIntakeAdmissions({ source: 'lark-channel', sourceEventId: 'om-selective-1' }).map(a => [a.ruleId, a]),
    )
    expect(inspected1['other']?.observeReason).toBe('configured-observe')

    // Disabling 'triage' flips acceptsIntakeObjective back to undefined
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'triage', enabled: false }] })
    expect(observedGetter?.acceptsIntakeObjective).toBeUndefined()

    // Re-enabling 'triage' (still mode: 'auto') restores acceptsIntakeObjective === true
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'triage', enabled: true }] })
    expect(observedGetter?.acceptsIntakeObjective).toBe(true)

    // Switching 'triage' to mode: 'observe' flips acceptsIntakeObjective back to undefined
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'triage', enabled: true, mode: 'observe' }] })
    expect(observedGetter?.acceptsIntakeObjective).toBeUndefined()

    // Conversely: global mode 'auto' with 'other' overridden to 'observe' admits 'triage' and keeps 'other' in would-admit
    await ctx.fiber.dispose()
    const root2 = await mkdtemp(join(tmpdir(), 'wp21-t6-converse-')); roots.push(root2)
    await writeFile(join(root2, 'doc.md'), 'Verified\n')
    const { verifier: verifier2, handle: handle2 } = await createVerifier(root2, text2)
    const ctx2 = new Context(); contexts.push(ctx2)
    ctx2.provide('assistantVerifier' as never, verifier2 as never)
    let observedGetter2: { acceptsIntakeObjective?: boolean } | undefined
    provideBasicPeers(ctx2, { onObserver: obs => { observedGetter2 = obs } })
    const cfgObserve2 = activeConfig(root2, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctx2.plugin(AssistantWorkItemsService, cfgObserve2).await()
    const service2 = ctx2.assistantWorkItems
    service2.applyIntakeTuning({
      workItemsMode: 'auto',
      intakeRuleUpdates: [
        { ruleId: 'triage', enabled: true },
        { ruleId: 'other', enabled: true, mode: 'observe' },
      ],
    })
    expect(observedGetter2?.acceptsIntakeObjective).toBe(true)
    service2.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'other', ceiling: 'accept' },
        ],
      }),
      evaluate: async () => ({ level: 'accept', quotes: ['global auto'] }),
    })
    service2.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-selective-2', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text2), occurredAt: 1_700_000_001_000,
      objective: text2, objectiveDigest: sha256(text2),
      acceptance: { contractId: handle2.contractId, contractDigest: handle2.contractDigest },
    }, text2)
    await vi.waitFor(() => expect(service2.intakeEvaluations('lark-channel', 'om-selective-2')).toHaveLength(2), { timeout: 5_000 })
    const admissions2 = service2.runIntakeAdmission()
    const byRule2 = Object.fromEntries(admissions2.map(a => [a.ruleId, a]))
    expect(byRule2['triage']).toMatchObject({ mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) })
    expect(byRule2['other']).toMatchObject({ mode: 'observe', outcome: 'would-admit', itemId: null })
    const inspected2 = Object.fromEntries(
      service2.listIntakeAdmissions({ source: 'lark-channel', sourceEventId: 'om-selective-2' }).map(a => [a.ruleId, a]),
    )
    expect(inspected2['other']?.observeReason).toBe('configured-observe')
    service2.close()
  })

  test('WP21-T7: disabling a rule mid-backoff purges its queued evaluation and re-enabling later evaluates it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t7-mid-backoff-')); roots.push(root)
    const now = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)

    const ctx = new Context(); contexts.push(ctx)
    provideBasicPeers(ctx)
    const service = new AssistantWorkItemsService(ctx, activeConfig(root, {
      intakeLedger: {
        enabled: true,
        evaluation: { enabled: true, maxConsecutiveFailures: 3, timeoutMs: 5_000, maxPerRun: 5, maxCallsPerHour: 20 },
      },
    }))

    let noisyCalls = 0
    let triageCalls = 0
    let failNoisy = true
    service.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'noisy', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => {
        if (req.ruleId === 'noisy') {
          noisyCalls += 1
          if (failNoisy) throw new Error('noisy transient failure')
          return { level: 'accept', quotes: ['mid-backoff'] }
        }
        triageCalls += 1
        return { level: 'digest', quotes: ['mid-backoff'] }
      },
    })

    const body = 'mid-backoff rule disable check'
    service.recordIntake({
      source: 'lark-channel', sourceEventId: 'om-mid-backoff-1', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(body), occurredAt: now,
    }, body)

    await vi.waitFor(() => expect(noisyCalls).toBe(1), { timeout: 5_000 })
    expect(triageCalls).toBe(1)
    expect(service.intakeEvaluationHealth()?.queued).toBe(1)

    const storeCheck1 = new WorkItemStore(join(root, 'items.sqlite'))
    expect(storeCheck1.getIntakeEvalQueue('lark-channel', 'om-mid-backoff-1', 'noisy', 'v1')).toMatchObject({
      attempts: 1,
      failures: 1,
    })
    storeCheck1.close()

    // Disable 'noisy' live while it is sitting in backoff
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'noisy', enabled: false }] })
    expect(service.intakeEvaluationHealth()?.queued).toBe(0)

    const storeCheck2 = new WorkItemStore(join(root, 'items.sqlite'))
    expect(storeCheck2.getIntakeEvalQueue('lark-channel', 'om-mid-backoff-1', 'noisy', 'v1')).toBeUndefined()
    storeCheck2.close()

    // Advance past backoff nextAt and run evaluation -> disabled rule must NOT spend an evaluator call
    failNoisy = false
    vi.setSystemTime(now + 5_000)
    expect(await service.runIntakeEvaluation()).toEqual([])
    expect(noisyCalls).toBe(1)
    expect(service.intakeEvaluations('lark-channel', 'om-mid-backoff-1').map(r => r.ruleId)).toEqual(['triage'])

    // Re-enable 'noisy' live -> reconcileRules() re-enqueues pending held text and evaluates it
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'noisy', enabled: true }] })
    expect(service.intakeEvaluationHealth()?.queued).toBe(1)
    const persisted = await service.runIntakeEvaluation()
    expect(noisyCalls).toBe(2)
    expect(persisted).toMatchObject([{ ruleId: 'noisy', status: 'decided', level: 'accept', wouldAccept: true }])
    expect(service.intakeEvaluations('lark-channel', 'om-mid-backoff-1').map(r => r.ruleId).sort()).toEqual(['noisy', 'triage'])
    service.close()
  })

  test('WP21-T8: same-process pre-registration observe() -> registerIntakeEvaluator() evaluates and auto-admits without restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t8-same-proc-')); roots.push(root)
    await writeFile(join(root, 'doc.md'), 'Verified\n')
    const text = 'same process pre-registration intake objective'
    const { verifier, handle } = await createVerifier(root, text)

    let observer: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx, { onObserver: obs => { observer = obs } })

    await ctx.plugin(AssistantWorkItemsService, activeConfig(root)).await()
    const service = ctx.assistantWorkItems
    expect(observer?.acceptsSourceText).toBe(true)
    expect(observer?.acceptsIntakeObjective).toBe(true)

    // Observe BEFORE any evaluator is registered
    observer!.observe({
      source: 'lark-channel', sourceEventId: 'om-same-proc-1', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text), occurredAt: 1_700_000_000_000,
      sourceText: text, objective: text, objectiveDigest: sha256(text),
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    } as Parameters<NonNullable<typeof observer>['observe']>[0])
    expect(service.intakeEvaluationHealth()).toMatchObject({ registered: false, heldTexts: 0 })
    expect(service.intakeEvaluations('lark-channel', 'om-same-proc-1')).toEqual([])

    // Register evaluator in the SAME process without restart
    let evalCalls = 0
    service.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: async req => {
        evalCalls += 1
        expect(req.sourceText).toBe(text)
        return { level: 'accept', quotes: ['same process'] }
      },
    })

    await vi.waitFor(() => expect(service.intakeEvaluations('lark-channel', 'om-same-proc-1')).toHaveLength(1), { timeout: 5_000 })
    expect(evalCalls).toBe(1)
    expect(service.runIntakeAdmission()).toMatchObject([
      { mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) },
    ])
    expect(service.health().openItems).toBe(1)
    service.close()
  })

  test('WP21-T9 (2E): multi-rule observe settlement preserves staging hints while auto rule is in backoff, including across restart', async () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)

    // Part A: Same-process backoff retry after observe peer settles
    const root = await mkdtemp(join(tmpdir(), 'wp21-t9-2e-')); roots.push(root)
    await writeFile(join(root, 'doc.md'), 'Verified\n')
    const text = 'multi-rule backoff keeps objective and acceptance'
    const { verifier, handle } = await createVerifier(root, text)

    let observer: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx, { onObserver: obs => { observer = obs }, policyRuleId: 'noisy' })

    const cfgObserve = activeConfig(root, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          maxConsecutiveFailures: 3,
          timeoutMs: 5_000,
          maxPerRun: 5,
          maxCallsPerHour: 20,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctx.plugin(AssistantWorkItemsService, cfgObserve).await()
    const service = ctx.assistantWorkItems
    service.applyIntakeTuning({
      workItemsMode: 'observe',
      intakeRuleUpdates: [
        { ruleId: 'triage', enabled: true, mode: 'observe' },
        { ruleId: 'noisy', enabled: true, mode: 'auto' },
      ],
    })
    expect(observer?.acceptsIntakeObjective).toBe(true)

    let failNoisy = true
    let noisyCalls = 0
    service.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'noisy', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => {
        if (req.ruleId === 'noisy') {
          noisyCalls += 1
          if (failNoisy) throw new Error('noisy transient failure')
        }
        return { level: 'accept', quotes: [req.sourceText.slice(0, 10)] }
      },
    })

    observer!.observe({
      source: 'lark-channel', sourceEventId: 'ev-2e', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text), occurredAt: now,
      sourceText: text, objective: text, objectiveDigest: sha256(text),
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    } as Parameters<NonNullable<typeof observer>['observe']>[0])

    await vi.waitFor(() => expect(service.intakeEvaluations('lark-channel', 'ev-2e')).toHaveLength(1), { timeout: 5_000 })
    expect(noisyCalls).toBe(1)

    // Wake 1: 'triage' settles as would-admit (configured-observe) while 'noisy' is in eval_queue backoff
    expect(service.runIntakeAdmission()).toMatchObject([
      { ruleId: 'triage', mode: 'observe', outcome: 'would-admit', itemId: null },
    ])
    const inspectAfterWake1 = new WorkItemStore(join(root, 'items.sqlite'))
    expect(inspectAfterWake1.readIntakeStagingHint('lark-channel', 'ev-2e')).toMatchObject({
      objective: { text },
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    })
    inspectAfterWake1.close()

    // Wake 2: advance clock past backoff -> 'noisy' succeeds and admits cleanly
    failNoisy = false
    vi.setSystemTime(now + 10_000)
    await service.runIntakeEvaluation()
    expect(noisyCalls).toBe(2)
    expect(service.runIntakeAdmission()).toMatchObject([
      { ruleId: 'noisy', mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) },
    ])
    expect(service.health().openItems).toBe(1)
    const inspectAfterWake2 = new WorkItemStore(join(root, 'items.sqlite'))
    expect(inspectAfterWake2.readIntakeStagingHint('lark-channel', 'ev-2e')).toBeUndefined()
    inspectAfterWake2.close()
    service.close()

    // Part B: Restart variant between Wake 1 and Wake 2
    const rootR = await mkdtemp(join(tmpdir(), 'wp21-t9-2e-restart-')); roots.push(rootR)
    await writeFile(join(rootR, 'doc.md'), 'Verified\n')
    const { verifier: vR, handle: hR } = await createVerifier(rootR, text)

    let observerR: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
    const ctxR1 = new Context(); contexts.push(ctxR1)
    ctxR1.provide('assistantVerifier' as never, vR as never)
    provideBasicPeers(ctxR1, { onObserver: obs => { observerR = obs }, policyRuleId: 'noisy' })

    const cfgR = activeConfig(rootR, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          maxConsecutiveFailures: 3,
          timeoutMs: 5_000,
          maxPerRun: 5,
          maxCallsPerHour: 20,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctxR1.plugin(AssistantWorkItemsService, cfgR).await()
    const sR1 = ctxR1.assistantWorkItems
    sR1.applyIntakeTuning({
      workItemsMode: 'observe',
      intakeRuleUpdates: [
        { ruleId: 'triage', enabled: true, mode: 'observe' },
        { ruleId: 'noisy', enabled: true, mode: 'auto' },
      ],
    })
    sR1.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'noisy', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => {
        if (req.ruleId === 'noisy') throw new Error('noisy transient before restart')
        return { level: 'accept', quotes: [req.sourceText.slice(0, 10)] }
      },
    })
    observerR!.observe({
      source: 'lark-channel', sourceEventId: 'ev-2e-restart', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text), occurredAt: now,
      sourceText: text, objective: text, objectiveDigest: sha256(text),
      acceptance: { contractId: hR.contractId, contractDigest: hR.contractDigest },
    } as Parameters<NonNullable<typeof observerR>['observe']>[0])
    await vi.waitFor(() => expect(sR1.intakeEvaluations('lark-channel', 'ev-2e-restart')).toHaveLength(1), { timeout: 5_000 })
    expect(sR1.runIntakeAdmission()).toMatchObject([
      { ruleId: 'triage', mode: 'observe', outcome: 'would-admit', itemId: null },
    ])
    sR1.close()

    const ctxR2 = new Context(); contexts.push(ctxR2)
    ctxR2.provide('assistantVerifier' as never, vR as never)
    provideBasicPeers(ctxR2, { policyRuleId: 'noisy' })
    const sR2 = new AssistantWorkItemsService(ctxR2, cfgR)
    let noisyCallsR2 = 0
    sR2.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'noisy', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => {
        if (req.ruleId === 'noisy') noisyCallsR2 += 1
        return { level: 'accept', quotes: [req.sourceText.slice(0, 10)] }
      },
    })
    // Before advancing past backoff, sR2 must NOT call noisy early
    await sR2.runIntakeEvaluation()
    expect(noisyCallsR2).toBe(0)

    vi.setSystemTime(now + 20_000)
    await sR2.runIntakeEvaluation()
    expect(noisyCallsR2).toBe(1)
    expect(sR2.runIntakeAdmission()).toMatchObject([
      { ruleId: 'noisy', mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) },
    ])
    expect(sR2.health().openItems).toBe(1)
    sR2.close()
  })

  test('WP21-T10 (2C): multi-rule observe settlement preserves staging hints while auto rule is disabled mid-backoff and later re-enabled', async () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)

    const root = await mkdtemp(join(tmpdir(), 'wp21-t10-2c-')); roots.push(root)
    await writeFile(join(root, 'doc.md'), 'Verified\n')
    const text = 'multi-rule live disable and re-enable preserves hints'
    const { verifier, handle } = await createVerifier(root, text)

    let observer: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantVerifier' as never, verifier as never)
    provideBasicPeers(ctx, { onObserver: obs => { observer = obs }, policyRuleId: 'noisy' })

    const cfgObserve = activeConfig(root, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          maxConsecutiveFailures: 3,
          timeoutMs: 5_000,
          maxPerRun: 1,
          maxCallsPerHour: 20,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctx.plugin(AssistantWorkItemsService, cfgObserve).await()
    const service = ctx.assistantWorkItems
    service.applyIntakeTuning({
      workItemsMode: 'observe',
      intakeRuleUpdates: [
        { ruleId: 'triage', enabled: true, mode: 'observe' },
        { ruleId: 'noisy', enabled: true, mode: 'auto' },
      ],
    })
    expect(observer?.acceptsIntakeObjective).toBe(true)

    let failNoisy = true
    let noisyCalls = 0
    service.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'noisy', ceiling: 'accept' },
          { ruleId: 'triage', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => {
        if (req.ruleId === 'noisy') {
          noisyCalls += 1
          if (failNoisy) throw new Error('noisy transient failure')
        }
        return { level: 'accept', quotes: [req.sourceText.slice(0, 10)] }
      },
    })

    observer!.observe({
      source: 'lark-channel', sourceEventId: 'ev-2c', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text), occurredAt: now,
      sourceText: text, objective: text, objectiveDigest: sha256(text),
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    } as Parameters<NonNullable<typeof observer>['observe']>[0])

    // Wake 1 (maxPerRun: 1): 'noisy' fails once into eval_queue backoff
    await vi.waitFor(() => expect(noisyCalls).toBe(1), { timeout: 5_000 })

    // Disable 'noisy' live while it is in backoff (purges eval_queue row for 'noisy')
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'noisy', enabled: false }] })

    // Wake 2: 'triage' evaluates and settles as would-admit (configured-observe), leaving eval_queue empty
    await service.runIntakeEvaluation()
    expect(service.runIntakeAdmission()).toMatchObject([
      { ruleId: 'triage', mode: 'observe', outcome: 'would-admit', itemId: null },
    ])
    const inspectAfterTriage = new WorkItemStore(join(root, 'items.sqlite'))
    expect(inspectAfterTriage.countPendingIntakeEvalQueueFor('lark-channel', 'ev-2c')).toBe(0)
    expect(inspectAfterTriage.readIntakeStagingHint('lark-channel', 'ev-2c')).toMatchObject({
      objective: { text },
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
    })
    inspectAfterTriage.close()

    // Re-enable 'noisy' live -> evaluates and admits with preserved objective + acceptance
    failNoisy = false
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'noisy', enabled: true, mode: 'auto' }] })
    await service.runIntakeEvaluation()
    expect(noisyCalls).toBe(2)
    expect(service.runIntakeAdmission()).toMatchObject([
      { ruleId: 'noisy', mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) },
    ])
    expect(service.health().openItems).toBe(1)
    service.close()

    // Restart variant while 'noisy' is disabled after 'triage' settles would-admit
    const rootR = await mkdtemp(join(tmpdir(), 'wp21-t10-2c-restart-')); roots.push(rootR)
    await writeFile(join(rootR, 'doc.md'), 'Verified\n')
    const { verifier: vR, handle: hR } = await createVerifier(rootR, text)

    let observerR: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
    const ctxR1 = new Context(); contexts.push(ctxR1)
    ctxR1.provide('assistantVerifier' as never, vR as never)
    provideBasicPeers(ctxR1, { onObserver: obs => { observerR = obs }, policyRuleId: 'noisy' })

    const cfgR = activeConfig(rootR, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          maxConsecutiveFailures: 3,
          timeoutMs: 5_000,
          maxPerRun: 1,
          maxCallsPerHour: 20,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctxR1.plugin(AssistantWorkItemsService, cfgR).await()
    const sR1 = ctxR1.assistantWorkItems
    sR1.applyIntakeTuning({
      workItemsMode: 'observe',
      intakeRuleUpdates: [
        { ruleId: 'triage', enabled: true, mode: 'observe' },
        { ruleId: 'noisy', enabled: true, mode: 'auto' },
      ],
    })
    let noisyR1 = 0
    sR1.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'noisy', ceiling: 'accept' },
          { ruleId: 'triage', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => {
        if (req.ruleId === 'noisy') { noisyR1 += 1; throw new Error('noisy transient') }
        return { level: 'accept', quotes: [req.sourceText.slice(0, 10)] }
      },
    })
    observerR!.observe({
      source: 'lark-channel', sourceEventId: 'ev-2c-restart', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(text), occurredAt: now,
      sourceText: text, objective: text, objectiveDigest: sha256(text),
      acceptance: { contractId: hR.contractId, contractDigest: hR.contractDigest },
    } as Parameters<NonNullable<typeof observerR>['observe']>[0])
    await vi.waitFor(() => expect(noisyR1).toBe(1), { timeout: 5_000 })
    sR1.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'noisy', enabled: false }] })
    await sR1.runIntakeEvaluation()
    expect(sR1.runIntakeAdmission()).toMatchObject([
      { ruleId: 'triage', mode: 'observe', outcome: 'would-admit', itemId: null },
    ])
    sR1.close()

    const ctxR2 = new Context(); contexts.push(ctxR2)
    ctxR2.provide('assistantVerifier' as never, vR as never)
    provideBasicPeers(ctxR2, { policyRuleId: 'noisy' })
    const sR2 = new AssistantWorkItemsService(ctxR2, cfgR)
    sR2.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'noisy', ceiling: 'accept' },
          { ruleId: 'triage', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => ({ level: 'accept', quotes: [req.sourceText.slice(0, 10)] }),
    })
    sR2.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'noisy', enabled: true, mode: 'auto' }] })
    await sR2.runIntakeEvaluation()
    expect(sR2.runIntakeAdmission()).toMatchObject([
      { ruleId: 'noisy', mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) },
    ])
    expect(sR2.health().openItems).toBe(1)
    sR2.close()
  })

  test('WP21-T11 (P7B/P7C): superseded-policy eval_queue rows are purged when policy moves v1 -> v2 with removed or disabled rules', async () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)

    const runScenario = async (mode: 'removed' | 'disabled', eventId: string) => {
      const root = await mkdtemp(join(tmpdir(), `wp21-t11-${mode}-`)); roots.push(root)
      await writeFile(join(root, 'doc.md'), 'Verified\n')
      const text = `superseded policy ${mode} rule test`
      const { verifier, handle } = await createVerifier(root, text)

      let observer1: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
      const ctx1 = new Context(); contexts.push(ctx1)
      ctx1.provide('assistantVerifier' as never, verifier as never)
      provideBasicPeers(ctx1, { onObserver: obs => { observer1 = obs }, policyRuleId: 'triage' })

      const cfg = activeConfig(root, {
        intakeLedger: {
          enabled: true,
          evaluation: {
            enabled: true,
            maxConsecutiveFailures: 3,
            timeoutMs: 5_000,
            maxPerRun: 5,
            maxCallsPerHour: 20,
            admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
          },
        },
      })
      await ctx1.plugin(AssistantWorkItemsService, cfg).await()
      const s1 = ctx1.assistantWorkItems
      let noisyCalls1 = 0
      s1.registerIntakeEvaluator({
        protocol: 1,
        policy: () => ({
          version: 'v1',
          rules: [{ ruleId: 'noisy', ceiling: 'accept' }],
        }),
        evaluate: async () => {
          noisyCalls1 += 1
          throw new Error('v1 noisy transient failure')
        },
      })

      observer1!.observe({
        source: 'lark-channel', sourceEventId: eventId, kind: 'message',
        senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
        contentDigest: sha256(text), occurredAt: now,
        sourceText: text, objective: text, objectiveDigest: sha256(text),
        acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest },
      } as Parameters<NonNullable<typeof observer1>['observe']>[0])

      await vi.waitFor(() => expect(noisyCalls1).toBe(1), { timeout: 5_000 })
      s1.close()

      const storeCheck1 = new WorkItemStore(join(root, 'items.sqlite'))
      expect(storeCheck1.getIntakeEvalQueue('lark-channel', eventId, 'noisy', 'v1')).toMatchObject({ attempts: 1, failures: 1 })
      expect(storeCheck1.countPendingIntakeEvalQueueFor('lark-channel', eventId)).toBe(1)
      storeCheck1.close()

      // Restart under Policy v2 where 'noisy' is either removed (P7B) or disabled (P7C), and 'triage' admits
      const ctx2 = new Context(); contexts.push(ctx2)
      ctx2.provide('assistantVerifier' as never, verifier as never)
      provideBasicPeers(ctx2, { policyRuleId: 'triage' })
      const s2 = new AssistantWorkItemsService(ctx2, cfg)
      if (mode === 'disabled') {
        s2.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'noisy', enabled: false }] })
      }
      s2.registerIntakeEvaluator({
        protocol: 1,
        policy: () => ({
          version: 'v2',
          rules: mode === 'removed'
            ? [{ ruleId: 'triage', ceiling: 'accept' }]
            : [{ ruleId: 'triage', ceiling: 'accept' }, { ruleId: 'noisy', ceiling: 'accept' }],
        }),
        evaluate: async req => ({ level: 'accept', quotes: [req.sourceText.slice(0, 10)] }),
      })

      await vi.waitFor(() => expect(s2.intakeEvaluations('lark-channel', eventId)).toHaveLength(1), { timeout: 5_000 })
      expect(s2.runIntakeAdmission()).toMatchObject([
        { ruleId: 'triage', policyVersion: 'v2', mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) },
      ])
      s2.close()

      // Verify stale v1 queue row is purged, hint is pruned, and staging row is evictable under 256-entry LRU
      const storeCheck2 = new WorkItemStore(join(root, 'items.sqlite'), { now: () => now + 10_000 })
      expect(storeCheck2.countPendingIntakeEvalQueueFor('lark-channel', eventId)).toBe(0)
      expect(storeCheck2.readIntakeStagingHint('lark-channel', eventId)).toBeUndefined()

      // Fill 256 settled rows to verify the admitted event's staging row is evictable
      for (let i = 0; i < 256; i += 1) {
        const filler = `evict-filler-${i}`
        const fillerId = `ev-fill-${i}`
        storeCheck2.recordIntake(inferredCandidate(fillerId, sha256(filler), now + 10_000 + i))
        expect(storeCheck2.upsertIntakeStaging({ source: 'lark-channel', sourceEventId: fillerId, sourceText: filler }).stored).toBe(true)
        storeCheck2.recordIntakeEvaluation({
          source: 'lark-channel', sourceEventId: fillerId, ruleId: 'triage', policyVersion: 'v2',
          sourceDigest: sha256(filler), mode: 'auto', status: 'decided', level: 'ignore',
          proposedLevel: 'ignore', ceiling: 'accept', quoteSpans: [], reasons: [], wouldAccept: false,
          attempts: 1, decidedAt: now + 10_000 + i,
        })
      }
      storeCheck2.close()

      const raw = new DatabaseSync(join(root, 'items.sqlite'), { readOnly: true })
      const remaining = raw.prepare('SELECT COUNT(*) AS n FROM work_item_intake_staging WHERE source_event_id = ?').get(eventId) as { n: number }
      raw.close()
      expect(remaining.n).toBe(0)
    }

    await runScenario('removed', 'ev-p7b')
    await runScenario('disabled', 'ev-p7c')

    // Part C: Live in-process policy bump v1 -> v2 cleans stale v1 queue rows (both held and unheld)
    const rootLive = await mkdtemp(join(tmpdir(), 'wp21-t11-live-')); roots.push(rootLive)
    await writeFile(join(rootLive, 'doc.md'), 'Verified\n')
    const textLive = 'live policy bump v1 to v2 cleanup'
    const { verifier: vLive, handle: hLive } = await createVerifier(rootLive, textLive)
    let observerLive: Parameters<NonNullable<PeerDeliveryService['registerInboundIntakeObserver']>>[0] | undefined
    const ctxLive = new Context(); contexts.push(ctxLive)
    ctxLive.provide('assistantVerifier' as never, vLive as never)
    provideBasicPeers(ctxLive, { onObserver: obs => { observerLive = obs }, policyRuleId: 'triage' })
    const cfgLive = activeConfig(rootLive, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          maxConsecutiveFailures: 3,
          timeoutMs: 5_000,
          maxPerRun: 5,
          maxCallsPerHour: 20,
          admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctxLive.plugin(AssistantWorkItemsService, cfgLive).await()
    const sLive = ctxLive.assistantWorkItems
    let currentPolicy: { version: string; rules: Array<{ ruleId: string; ceiling: 'accept' }> } = {
      version: 'v1',
      rules: [{ ruleId: 'noisy', ceiling: 'accept' }],
    }
    let liveNoisyCalls = 0
    sLive.registerIntakeEvaluator({
      protocol: 1,
      policy: () => currentPolicy,
      evaluate: async req => {
        if (req.ruleId === 'noisy') {
          liveNoisyCalls += 1
          throw new Error('live v1 noisy failure')
        }
        return { level: 'accept', quotes: [req.sourceText.slice(0, 10)] }
      },
    })
    observerLive!.observe({
      source: 'lark-channel', sourceEventId: 'ev-p7-live', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: sha256(textLive), occurredAt: now,
      sourceText: textLive, objective: textLive, objectiveDigest: sha256(textLive),
      acceptance: { contractId: hLive.contractId, contractDigest: hLive.contractDigest },
    } as Parameters<NonNullable<typeof observerLive>['observe']>[0])
    await vi.waitFor(() => expect(liveNoisyCalls).toBe(1), { timeout: 5_000 })

    // Also stage an unheld event with a stale v1 eval_queue row in SQLite
    const rawQueueStore = new WorkItemStore(join(rootLive, 'items.sqlite'), { now: () => now })
    const unheldText = 'unheld stale v1 queue row'
    rawQueueStore.recordIntake(inferredCandidate('ev-p7-unheld', sha256(unheldText), now))
    rawQueueStore.upsertIntakeEvalQueue({
      source: 'lark-channel', sourceEventId: 'ev-p7-unheld', ruleId: 'noisy', policyVersion: 'v1',
      ceiling: 'accept', attempts: 1, failures: 1, nextAt: now + 60_000,
    })
    expect(rawQueueStore.countPendingIntakeEvalQueueFor('lark-channel', 'ev-p7-unheld')).toBe(1)
    rawQueueStore.close()

    // Bump live policy v1 -> v2
    currentPolicy = { version: 'v2', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }
    await sLive.runIntakeEvaluation()
    expect(sLive.runIntakeAdmission()).toMatchObject([
      { ruleId: 'triage', policyVersion: 'v2', mode: 'auto', outcome: 'admitted', itemId: expect.stringMatching(/^wi-/u) },
    ])
    sLive.close()

    const checkLive = new WorkItemStore(join(rootLive, 'items.sqlite'))
    expect(checkLive.countPendingIntakeEvalQueueFor('lark-channel', 'ev-p7-live')).toBe(0)
    expect(checkLive.countPendingIntakeEvalQueueFor('lark-channel', 'ev-p7-unheld')).toBe(0)
    expect(checkLive.readIntakeStagingHint('lark-channel', 'ev-p7-live')).toBeUndefined()
    checkLive.close()
  }, 20_000)

  test('WP21-T12 (P6B): buffer-full SQLite staging rejection does not prematurely evict heldTexts when all rules are disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wp21-t12-p6b-')); roots.push(root)
    const now = 1_700_000_000_000
    const ctx = new Context(); contexts.push(ctx)
    provideBasicPeers(ctx)

    const cfg = activeConfig(root, {
      intakeLedger: {
        enabled: true,
        evaluation: {
          enabled: true,
          admit: { enabled: true, mode: 'observe', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 10 },
        },
      },
    })
    await ctx.plugin(AssistantWorkItemsService, cfg).await()
    const service = ctx.assistantWorkItems
    service.applyIntakeTuning({
      intakeRuleUpdates: [
        { ruleId: 'triage', enabled: false },
        { ruleId: 'noisy', enabled: false },
      ],
    })
    let evalCalls = 0
    service.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({
        version: 'v1',
        rules: [
          { ruleId: 'triage', ceiling: 'accept' },
          { ruleId: 'noisy', ceiling: 'accept' },
        ],
      }),
      evaluate: async req => {
        evalCalls += 1
        return { level: 'digest', quotes: [req.sourceText.slice(0, 8)] }
      },
    })

    for (let i = 0; i < 265; i += 1) {
      const body = `all-disabled buffer-full event ${i}`
      service.recordIntake({
        source: 'lark-channel', sourceEventId: `ev-6b-${i}`, kind: 'message',
        senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
        contentDigest: sha256(body), occurredAt: now + i,
      }, body)
    }

    expect(evalCalls).toBe(0)
    expect(service.intakeEvaluationHealth()).toMatchObject({ heldTexts: 256, skipped: 9 })

    const raw = new DatabaseSync(join(root, 'items.sqlite'), { readOnly: true })
    const stagingCount = (raw.prepare('SELECT COUNT(*) AS n FROM work_item_intake_staging').get() as { n: number }).n
    const hasFirst = (raw.prepare("SELECT COUNT(*) AS n FROM work_item_intake_staging WHERE source_event_id = 'ev-6b-0'").get() as { n: number }).n
    raw.close()
    expect(stagingCount).toBe(256)
    expect(hasFirst).toBe(1)

    // Re-enabling a rule still evaluates retained earliest event ev-6b-0 from in-memory #texts
    service.applyIntakeTuning({ intakeRuleUpdates: [{ ruleId: 'triage', enabled: true }] })
    await service.runIntakeEvaluation()
    expect(service.intakeEvaluations('lark-channel', 'ev-6b-0')).toHaveLength(1)
    service.close()
  }, 30_000)
})
