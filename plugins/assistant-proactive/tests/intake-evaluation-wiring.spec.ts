import { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import proactive, { DISABLED_INTAKE_EVALUATION_HEALTH, type IntakeEvaluationConfig } from '../src/index.ts'

// WP20 stage 3 production assembly: the real assistant-work-items service and
// this plugin are mounted in one Cordis context, the LLM is a scripted service
// (never a real model), and Delivery is a boundary fake exposing only its
// published inbound-intake registration. The inbound text still travels the
// production path (Delivery observer -> WorkItems ledger -> evaluation queue),
// and every persisted row is read back from the real WorkItems service.
const TEXT = 'the nightly build is red again, can someone look'
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const workItemsSource = new URL('../../assistant-work-items/src/index.ts', import.meta.url).href
const roots: string[] = []
const contexts: Context[] = []
const fibers: Array<{ dispose(): Promise<void> | void }> = []

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface WorkItemsServiceLike {
  intakeEvaluations(source: string, sourceEventId: string): readonly Record<string, unknown>[]
  intakeEvaluationHealth(): Record<string, unknown> | undefined
  recordIntake(input: unknown): unknown
}

interface StreamCall {
  provider: string
  model: string
  tools?: readonly unknown[]
  maxTokens?: number
  messages: readonly { content: readonly { type: string; text: string }[] }[]
}

type Observer = { observe(signal: unknown): void; acceptsSourceText?: true }

/** A scripted LLM service: yields the scripted chunks for every call. */
function scriptedLlm(script: (call: number) => readonly unknown[]) {
  const calls: StreamCall[] = []
  const llm = {
    stream(options: StreamCall) {
      calls.push(options)
      const call = calls.length
      return (async function* () {
        for (const chunk of await script(call)) yield chunk
      })()
    },
  }
  return { llm: llm as unknown as LlmRuntime, calls }
}

const jsonOutput = (value: unknown) => [
  { type: 'text-delta' as const, index: 0, text: JSON.stringify(value) },
  { type: 'finish' as const, reason: { kind: 'stop' as const } },
]

/** The published Delivery inbound-intake registration, faked at the boundary. */
function deliveryPeer() {
  let observer: Observer | undefined
  const registrations: Observer[] = []
  const peer = {
    registerInboundIntakeObserver(value: Observer) {
      observer = value
      registrations.push(value)
      return () => { if (observer === value) observer = undefined }
    },
  }
  return {
    peer,
    registrations,
    get observer() { return observer },
    deliver(signal: unknown) {
      if (observer === undefined) throw new Error('no inbound intake observer registered')
      observer.observe(signal)
    },
  }
}

function inbound(sourceEventId = 'om_1', text = TEXT) {
  return {
    source: 'lark-channel', sourceEventId, kind: 'message', senderAllowlisted: true, addressed: false,
    threadFollowUp: false, senderIsBot: false, contentDigest: sha256(text), occurredAt: 1_700_000_000_000,
    sourceText: text,
  }
}

async function statePaths() {
  const root = await mkdtemp(join(tmpdir(), 'proactive-intake-wiring-'))
  roots.push(root)
  return { databasePath: join(root, 'state', 'items.sqlite'), workRoot: join(root, 'work') }
}

interface WorkItemsEvaluationConfig {
  enabled: boolean
  timeoutMs?: number
  maxConsecutiveFailures?: number
  maxPerRun?: number
  maxCallsPerHour?: number
}

async function mountWorkItems(ctx: Context, evaluation: WorkItemsEvaluationConfig | undefined) {
  const paths = await statePaths()
  const module = await import(workItemsSource) as { AssistantWorkItemsService: new (...args: never[]) => unknown }
  const fiber = await ctx.plugin(module.AssistantWorkItemsService as never, {
    enabled: true, mode: 'observe', ...paths,
    intakeLedger: { enabled: true, ...(evaluation === undefined ? {} : { evaluation }) },
  } as never)
  fibers.push(fiber as unknown as { dispose(): Promise<void> | void })
  return ctx.get('assistantWorkItems' as never) as unknown as WorkItemsServiceLike
}

function producerConfig(overrides: Partial<IntakeEvaluationConfig> = {}): IntakeEvaluationConfig {
  return {
    enabled: true,
    provider: 'local-script',
    model: 'scripted-evaluator',
    rules: [{ ruleId: 'triage', ceiling: 'notify' }],
    ...overrides,
  }
}

async function mountProactive(ctx: Context, intakeEvaluation: IntakeEvaluationConfig | undefined) {
  const config = intakeEvaluation === undefined ? { databasePath: ':memory:' } : { databasePath: ':memory:', intakeEvaluation }
  const fiber = await ctx.plugin(proactive, config)
  fibers.push(fiber as unknown as { dispose(): Promise<void> | void })
  return { fiber, service: ctx.assistantProactive }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

describe('intake evaluation production wiring', () => {
  it('registers a producer that evaluates one inferred inbound row and persists the evaluation', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'digest', quotes: ['build is red'] }))
    ctx.provide('llm' as never, llm as never)
    const workItems = await mountWorkItems(ctx, { enabled: true, timeoutMs: 5_000, maxConsecutiveFailures: 3, maxPerRun: 5, maxCallsPerHour: 20 })
    const { service } = await mountProactive(ctx, producerConfig())

    // Production assembly: the producer is registered only because both peers exist.
    await vi.waitFor(() => expect(service.intakeEvaluationHealth().readiness).toBe('registered'))
    const health = service.intakeEvaluationHealth()
    expect(health).toMatchObject({ enabled: true, registered: true, readiness: 'registered', lastError: null, provider: 'local-script', model: 'scripted-evaluator' })
    expect(health.policyVersion).toMatch(/^v1-[0-9a-f]{64}$/u)
    expect(workItems.intakeEvaluationHealth()).toMatchObject({ enabled: true, registered: true, policyVersion: health.policyVersion })

    // One authenticated inferred inbound item, through Delivery's registration.
    delivery.deliver(inbound())
    await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1))
    const [row] = workItems.intakeEvaluations('lark-channel', 'om_1')
    expect(row).toMatchObject({
      source: 'lark-channel', sourceEventId: 'om_1', ruleId: 'triage', policyVersion: health.policyVersion,
      sourceDigest: sha256(TEXT), mode: 'observe', status: 'decided', level: 'digest', ceiling: 'notify',
      quoteSpans: [[12, 24]], reasons: [], wouldAccept: false, attempts: 1,
    })
    // Observe only: no admission, no dispatch, and the frozen route/tools were used.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'local-script', model: 'scripted-evaluator', tools: [], maxTokens: 2048 })
    expect(JSON.parse(calls[0]!.messages[0]!.content[0]!.text)).toMatchObject({ ruleId: 'triage', ceiling: 'notify', sourceText: TEXT })
  })

  it('defaults off: no registration, no model call and no evaluation row', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'digest', quotes: ['build is red'] }))
    ctx.provide('llm' as never, llm as never)
    const workItems = await mountWorkItems(ctx, { enabled: true, timeoutMs: 5_000, maxConsecutiveFailures: 3, maxPerRun: 5, maxCallsPerHour: 20 })
    const { service } = await mountProactive(ctx, undefined)

    expect(service.intakeEvaluationHealth()).toEqual(DISABLED_INTAKE_EVALUATION_HEALTH)
    expect(workItems.intakeEvaluationHealth()).toMatchObject({ enabled: true, registered: false })
    delivery.deliver(inbound())
    await flush()
    expect(calls).toHaveLength(0)
    expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toEqual([])
    expect(workItems.intakeEvaluationHealth()).toMatchObject({ registered: false, persisted: { decided: 0, unavailable: 0 } })
  })

  it('stays loaded and reports unavailable when WorkItems evaluation is disabled', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'digest', quotes: ['build is red'] }))
    ctx.provide('llm' as never, llm as never)
    const workItems = await mountWorkItems(ctx, undefined)
    const { service } = await mountProactive(ctx, producerConfig())

    await vi.waitFor(() => expect(service.intakeEvaluationHealth().lastError).toMatch(/intake evaluation is disabled/u))
    expect(service.intakeEvaluationHealth()).toMatchObject({ enabled: true, registered: false, readiness: 'unavailable' })
    // The plugin still works, and the inbound item is only recorded in the ledger.
    delivery.deliver(inbound())
    await flush()
    expect(calls).toHaveLength(0)
    expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toEqual([])
  })

  it('late-binds the LLM: an enabled producer registers once the service appears', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    const workItems = await mountWorkItems(ctx, { enabled: true, timeoutMs: 5_000, maxConsecutiveFailures: 3, maxPerRun: 5, maxCallsPerHour: 20 })
    const { service } = await mountProactive(ctx, producerConfig())
    expect(service.intakeEvaluationHealth()).toMatchObject({ enabled: true, registered: false, readiness: 'unavailable', lastError: null })
    expect(workItems.intakeEvaluationHealth()).toMatchObject({ registered: false })

    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'digest', quotes: ['build is red'] }))
    ctx.provide('llm' as never, llm as never)
    await vi.waitFor(() => expect(service.intakeEvaluationHealth().readiness).toBe('registered'))
    delivery.deliver(inbound())
    await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1))
    expect(calls).toHaveLength(1)
  })

  it('re-queues under a changed policy version after a config reload', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'digest', quotes: ['build is red'] }))
    ctx.provide('llm' as never, llm as never)
    const workItems = await mountWorkItems(ctx, { enabled: true, timeoutMs: 5_000, maxConsecutiveFailures: 3, maxPerRun: 5, maxCallsPerHour: 20 })
    const first = await mountProactive(ctx, producerConfig())
    await vi.waitFor(() => expect(first.service.intakeEvaluationHealth().readiness).toBe('registered'))
    const firstVersion = first.service.intakeEvaluationHealth().policyVersion!
    delivery.deliver(inbound())
    await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1))

    // A config reload is a stop/start: the old registration is disposed, then a
    // producer with a different Host ceiling registers under a new digest.
    await first.fiber.dispose()
    expect(await (async () => { try { return first.service.intakeEvaluationHealth().registered } catch { return 'disposed' } })()).toBe(false)
    const second = await mountProactive(ctx, producerConfig({ rules: [{ ruleId: 'triage', ceiling: 'digest' }] }))
    await vi.waitFor(() => expect(second.service.intakeEvaluationHealth().readiness).toBe('registered'))
    const secondVersion = second.service.intakeEvaluationHealth().policyVersion!
    expect(secondVersion).not.toBe(firstVersion)
    expect(workItems.intakeEvaluationHealth()).toMatchObject({ registered: true, policyVersion: secondVersion })

    // The same authenticated event replayed after the version change is
    // re-evaluated under the new version; the old append-only row stays.
    delivery.deliver(inbound())
    await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(2))
    const versions = workItems.intakeEvaluations('lark-channel', 'om_1').map(row => row['policyVersion']).sort()
    expect(versions).toEqual([firstVersion, secondVersion].sort())
    expect(calls).toHaveLength(2)
    expect(calls[1]!.messages[0]!.content[0]!.text).toContain('"ceiling":"digest"')
    expect(second.service.intakeEvaluationHealth().lastError).toBeNull()
  })

  it('unregisters on disposal so no further model calls happen', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'digest', quotes: ['build is red'] }))
    ctx.provide('llm' as never, llm as never)
    const workItems = await mountWorkItems(ctx, { enabled: true, timeoutMs: 5_000, maxConsecutiveFailures: 3, maxPerRun: 5, maxCallsPerHour: 20 })
    const { fiber, service } = await mountProactive(ctx, producerConfig())
    await vi.waitFor(() => expect(service.intakeEvaluationHealth().readiness).toBe('registered'))

    const registration = delivery.registrations.length
    await fiber.dispose()
    expect(service.intakeEvaluationHealth()).toMatchObject({ enabled: true, registered: false, readiness: 'unavailable' })
    expect(workItems.intakeEvaluationHealth()).toMatchObject({ registered: false })
    // WorkItems keeps its inbound observer; without a supplier the text is dropped, never stored.
    expect(delivery.registrations.length).toBeGreaterThanOrEqual(registration)
    delivery.deliver(inbound())
    await flush()
    expect(calls).toHaveLength(0)
    expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toEqual([])
  })

  it('degrades through the queue when the producer rejects model output', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    // A quote that is not in the authenticated text: the producer throws, and
    // the WorkItems queue records an unavailable decision instead of guessing.
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'notify', quotes: ['build is green'] }))
    ctx.provide('llm' as never, llm as never)
    const workItems = await mountWorkItems(ctx, { enabled: true, timeoutMs: 5_000, maxConsecutiveFailures: 1, maxPerRun: 5, maxCallsPerHour: 20 })
    const { service } = await mountProactive(ctx, producerConfig())
    await vi.waitFor(() => expect(service.intakeEvaluationHealth().readiness).toBe('registered'))
    delivery.deliver(inbound())
    await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1))
    expect(workItems.intakeEvaluations('lark-channel', 'om_1')[0]).toMatchObject({
      status: 'unavailable', level: 'ignore', proposedLevel: null, reasons: ['consecutive-failures'], attempts: 1,
    })
    expect(calls).toHaveLength(1)
    expect(service.intakeEvaluationHealth().lastError).toBe('quote-not-in-source')
  })

  it('degrades on a model timeout without a real model or an unbounded wait', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const delivery = deliveryPeer()
    ctx.provide('assistantDelivery' as never, delivery.peer as never)
    const llm = {
      stream() { return (async function* () { await new Promise(() => {}); yield { type: 'finish', reason: { kind: 'stop' as const } } })() },
    }
    ctx.provide('llm' as never, llm as never)
    // WorkItems' own per-call timeout (100 ms) settles the unavailable record.
    const workItems = await mountWorkItems(ctx, { enabled: true, timeoutMs: 100, maxConsecutiveFailures: 1, maxPerRun: 5, maxCallsPerHour: 20 })
    const { service } = await mountProactive(ctx, producerConfig({ timeoutMs: 30_000 }))
    await vi.waitFor(() => expect(service.intakeEvaluationHealth().readiness).toBe('registered'))
    delivery.deliver(inbound())
    await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1), { timeout: 10_000 })
    expect(workItems.intakeEvaluations('lark-channel', 'om_1')[0]).toMatchObject({
      status: 'unavailable', level: 'ignore', reasons: ['consecutive-failures'],
    })
  })
})
