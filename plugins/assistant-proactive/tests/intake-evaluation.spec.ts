import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Config, IntakeEvaluationError, IntakeEvaluationProducer, INTAKE_EVALUATION_LEVELS, MAX_INTAKE_EVALUATION_QUOTE_CHARS,
  intakeEvaluationPolicy, normalizeIntakeEvaluation, type IntakeEvaluationConfig, type IntakeModelRequest,
} from '../src/index.ts'

// WP20 stage 3 producer contract: every LLM below is a scripted in-process
// supplier; nothing calls a real model and nothing here touches WorkItems.
const TEXT = 'the nightly build is red again, can someone look'

interface StreamCall {
  provider: string
  model: string
  system?: string
  tools?: readonly unknown[]
  maxTokens?: number
  messages: readonly { content: readonly { type: string; text: string }[] }[]
}

const textChunk = (value: string, index = 0) => ({ type: 'text-delta' as const, index, text: value })
const finishChunk = () => ({ type: 'finish' as const, reason: { kind: 'stop' as const } })

/** A scripted LLM service: records every call and yields the scripted chunks. */
function scriptedLlm(script: (call: number) => readonly unknown[] | Promise<readonly unknown[]>) {
  const calls: StreamCall[] = []
  const llm = {
    stream(options: StreamCall) {
      calls.push(options)
      const call = calls.length
      return (async function* () {
        const chunks = await script(call)
        for (const chunk of chunks) yield chunk
      })()
    },
  }
  return { llm: llm as unknown as LlmRuntime, calls }
}

const jsonOutput = (value: unknown) => [textChunk(JSON.stringify(value)), finishChunk()]

function settings(overrides: Partial<IntakeEvaluationConfig> = {}): NonNullable<ReturnType<typeof normalizeIntakeEvaluation>> {
  const config = normalizeIntakeEvaluation({
    enabled: true,
    provider: 'local-script',
    model: 'scripted-evaluator',
    rules: [{ ruleId: 'triage', ceiling: 'notify' }],
    ...overrides,
  })
  if (config === undefined) throw new Error('test config must normalize')
  return config
}

function producerWith(llm: LlmRuntime, overrides: Partial<IntakeEvaluationConfig> = {}) {
  let now = 1_700_000_000_000
  const producer = new IntakeEvaluationProducer({ config: settings(overrides), now: () => now })
  producer.attach(llm)
  producer.markRegistered(true)
  return { producer, advance: (ms: number) => { now += ms } }
}

function request(producer: IntakeEvaluationProducer, overrides: Partial<IntakeModelRequest> = {}): IntakeModelRequest {
  const rule = producer.policy.rules[0]!
  return {
    candidateId: 'lark-channel:om_1',
    ruleId: rule.ruleId,
    policyVersion: producer.policy.version,
    sourceText: TEXT,
    ceiling: rule.ceiling,
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function codeOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof IntakeEvaluationError) return error.code
    throw error
  }
  throw new Error('expected the producer to throw')
}

afterEach(() => { /* producers hold no timers of their own */ })

describe('assistant-proactive intake evaluation config', () => {
  it('is off by default and every absent/false section normalizes away', () => {
    expect(normalizeIntakeEvaluation(undefined)).toBeUndefined()
    expect(normalizeIntakeEvaluation(null)).toBeUndefined()
    expect(normalizeIntakeEvaluation({})).toBeUndefined()
    expect(normalizeIntakeEvaluation({ enabled: false, provider: 'p', model: 'm', rules: [] })).toBeUndefined()
  })

  it('enabled requires a frozen provider/model and 1..16 well-formed rules', () => {
    expect(() => normalizeIntakeEvaluation({ enabled: true, model: 'm', rules: [{ ruleId: 'triage', ceiling: 'digest' }] })).toThrow(/provider/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', rules: [{ ruleId: 'triage', ceiling: 'digest' }] })).toThrow(/model/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm' })).toThrow(/rules/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm', rules: [] })).toThrow(/rules/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm', rules: [{ ruleId: 'bad id', ceiling: 'digest' }] })).toThrow(/ruleId/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm', rules: [{ ruleId: 'triage', ceiling: 'execute' }] })).toThrow(/ceiling/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm', rules: [{ ruleId: 'triage', ceiling: 'digest' }, { ruleId: 'triage', ceiling: 'notify' }] })).toThrow(/repeats/)
    const many = Array.from({ length: 17 }, (_, index) => ({ ruleId: `rule-${index}`, ceiling: 'ignore' as const }))
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm', rules: many })).toThrow(/16/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm', rules: [{ ruleId: 'triage', ceiling: 'digest' }], unexpected: 1 })).toThrow(/does not accept/)
    expect(() => normalizeIntakeEvaluation({ enabled: true, provider: 'p', model: 'm', rules: [{ ruleId: 'triage', ceiling: 'digest', extra: true }] })).toThrow(/does not accept/)
  })

  it('defaults the bounded limits and rejects out-of-range values', () => {
    const config = settings()
    expect(config.maxCallsPerHour).toBe(20)
    expect(config.timeoutMs).toBe(30_000)
    expect(config.maxConsecutiveFailures).toBe(3)
    expect(() => settings({ maxCallsPerHour: 0 })).toThrow(/maxCallsPerHour/)
    expect(() => settings({ maxCallsPerHour: 1_001 })).toThrow(/maxCallsPerHour/)
    expect(() => settings({ timeoutMs: 999 })).toThrow(/timeoutMs/)
    expect(() => settings({ maxConsecutiveFailures: 11 })).toThrow(/maxConsecutiveFailures/)
  })

  it('digests the normalized rules plus provider/model, so any change moves the version', () => {
    const base = settings()
    expect(intakeEvaluationPolicy(base).version).toMatch(/^v1-[0-9a-f]{64}$/u)
    // Order is not semantic: the same rules in another order keep the version.
    const reordered = settings({ rules: [{ ruleId: 'triage', ceiling: 'notify' }, { ruleId: 'alert', ceiling: 'digest' }] })
    const canonical = settings({ rules: [{ ruleId: 'alert', ceiling: 'digest' }, { ruleId: 'triage', ceiling: 'notify' }] })
    expect(canonical).toEqual(reordered)
    expect(intakeEvaluationPolicy(canonical).version).toBe(intakeEvaluationPolicy(reordered).version)
    const versions = new Set([
      intakeEvaluationPolicy(base).version,
      intakeEvaluationPolicy(settings({ rules: [{ ruleId: 'triage', ceiling: 'digest' }] })).version,
      intakeEvaluationPolicy(settings({ provider: 'other' })).version,
      intakeEvaluationPolicy(settings({ model: 'other' })).version,
      intakeEvaluationPolicy(settings({ rules: [{ ruleId: 'other', ceiling: 'notify' }] })).version,
    ])
    expect(versions.size).toBe(5)
  })

  it('accepts the documented section through the Loader Config schema and rejects an unknown ceiling', () => {
    // The Loader schema materializes the disabled section; normalize still treats it as off.
    expect(Config({}).intakeEvaluation).toMatchObject({ enabled: false, rules: [] })
    const accepted = Config({ intakeEvaluation: { enabled: true, provider: 'p', model: 'm', rules: [{ ruleId: 'triage', ceiling: 'digest' }] } })
    expect(accepted.intakeEvaluation).toMatchObject({ enabled: true, provider: 'p', model: 'm' })
    expect(() => Config({ intakeEvaluation: { enabled: true, rules: [{ ruleId: 'triage', ceiling: 'execute' }] } } as never)).toThrow()
  })

  it('publishes exactly the protocol-1 registration WorkItems accepts', () => {
    const { producer } = producerWith(scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'ignore', quotes: [] })).llm)
    const registration = producer.registration()
    expect(registration.protocol).toBe(1)
    expect(registration.policy()).toEqual(producer.policy)
    expect(Object.isFrozen(registration)).toBe(true)
    expect(Object.isFrozen(registration.policy())).toBe(true)
    expect(INTAKE_EVALUATION_LEVELS).toEqual(['ignore', 'digest', 'notify', 'accept'])
  })
})

describe('assistant-proactive intake evaluation model call', () => {
  it('sends one tool-free, bounded call on the frozen provider/model with the authenticated text', async () => {
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'digest', quotes: ['build is red'] }))
    const { producer } = producerWith(llm)
    const verdict = await producer.evaluate(request(producer))
    expect(verdict).toEqual({ level: 'digest', quotes: ['build is red'] })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('local-script')
    expect(call.model).toBe('scripted-evaluator')
    expect(call.tools).toEqual([])
    expect(call.maxTokens).toBe(2048)
    expect(call.system).toMatch(/untrusted message data/u)
    expect(call.messages).toHaveLength(1)
    const payload = JSON.parse(call.messages[0]!.content[0]!.text) as Record<string, unknown>
    expect(payload).toEqual({ ruleId: 'triage', ceiling: 'notify', sourceText: TEXT })
  })

  it('only lowers the Host ceiling; a stronger model level is clamped', async () => {
    const { producer } = producerWith(scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'accept', quotes: ['can someone look'] })).llm)
    expect(await producer.evaluate(request(producer))).toEqual({ level: 'notify', quotes: ['can someone look'] })
  })

  it('rejects quote text that is not an exact substring of the authenticated source', async () => {
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'notify', quotes: ['build is green'] }))
    const { producer } = producerWith(llm)
    expect(await codeOf(() => producer.evaluate(request(producer)))).toBe('quote-not-in-source')
    expect(calls).toHaveLength(1)
  })

  it('rejects malformed output shapes and unexpected keys instead of guessing', async () => {
    const cases: Array<[unknown, string]> = [
      ['not json', 'output-invalid'],
      ['null', 'output-invalid'],
      ['[]', 'output-invalid'],
      ['42', 'output-invalid'],
      [{ ruleId: 'triage', level: 'digest', quotes: ['build is red'], extra: true }, 'output-invalid'],
      [{ ruleId: 'other', level: 'digest', quotes: ['build is red'] }, 'output-invalid'],
      [{ ruleId: 'triage', level: 'execute', quotes: ['build is red'] }, 'output-invalid'],
      [{ ruleId: 'triage', level: 'digest', quotes: 'build is red' }, 'output-invalid'],
      [{ ruleId: 'triage', level: 'digest', quotes: [] }, 'quote-missing'],
      [{ ruleId: 'triage', level: 'digest', quotes: ['build is red', 'red again', 'can someone look', 'nightly build', 'extra'] }, 'quote-bound-exceeded'],
      [{ ruleId: 'triage', level: 'digest', quotes: ['x'.repeat(MAX_INTAKE_EVALUATION_QUOTE_CHARS + 1)] }, 'quote-bound-exceeded'],
      [{ ruleId: 'triage', level: 'ignore', quotes: ['   '] }, 'output-invalid'],
    ]
    for (const [output, expected] of cases) {
      const { producer } = producerWith(scriptedLlm(() => [textChunk(typeof output === 'string' ? output : JSON.stringify(output)), finishChunk()]).llm)
      expect(await codeOf(() => producer.evaluate(request(producer))), JSON.stringify(output)).toBe(expected)
    }
  })

  it('rejects tool calls, a truncated stream and a non-stop finish', async () => {
    const badStreams: readonly unknown[][] = [
      [{ type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '{}' }],
      [textChunk('{"ruleId":"triage"')],
      [textChunk('{}'), { type: 'finish', reason: { kind: 'max-tokens' } }],
      [textChunk('{}'), finishChunk(), textChunk('late')],
    ]
    for (const chunks of badStreams) {
      const { producer } = producerWith(scriptedLlm(() => chunks).llm)
      expect(await codeOf(() => producer.evaluate(request(producer)))).toBe('stream-invalid')
    }
  })

  it('turns provider errors into a provider-error failure and eventually opens the local breaker', async () => {
    const { llm, calls } = scriptedLlm(() => { throw new Error('provider down') })
    const { producer } = producerWith(llm, { maxConsecutiveFailures: 2 })
    expect(await codeOf(() => producer.evaluate(request(producer)))).toBe('provider-error')
    expect(await codeOf(() => producer.evaluate(request(producer)))).toBe('provider-error')
    expect(calls).toHaveLength(2)
    // The breaker keeps the next driven attempt off the provider until its cooldown.
    expect(await codeOf(() => producer.evaluate(request(producer)))).toBe('circuit-open')
    expect(calls).toHaveLength(2)
    expect(producer.health()).toMatchObject({ readiness: 'degraded', consecutiveFailures: 2 })
  })

  it('times out a hanging model call and records lastError', async () => {
    const { llm } = scriptedLlm(() => new Promise<readonly unknown[]>(() => {}))
    const { producer } = producerWith(llm, { timeoutMs: 1_000 })
    expect(await codeOf(() => producer.evaluate(request(producer)))).toBe('timeout')
    expect(producer.health().lastError).toBe('timeout')
  })

  it('caps producer calls per rolling hour and rejects already-aborted requests', async () => {
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'ignore', quotes: [] }))
    const { producer } = producerWith(llm, { maxCallsPerHour: 1 })
    await producer.evaluate(request(producer))
    expect(await codeOf(() => producer.evaluate(request(producer)))).toBe('budget-exhausted')
    expect(calls).toHaveLength(1)
    expect(producer.health()).toMatchObject({ budgetExhausted: true, callsInWindow: 1 })
    const controller = new AbortController()
    controller.abort()
    expect(await codeOf(() => producer.evaluate(request(producer, { signal: controller.signal })))).toBe('cancelled')
    expect(calls).toHaveLength(1)
  })

  it('rejects requests that do not match the frozen policy without calling the model', async () => {
    const { llm, calls } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'ignore', quotes: [] }))
    const { producer } = producerWith(llm)
    expect(await codeOf(() => producer.evaluate(request(producer, { policyVersion: 'v1-deadbeef' })))).toBe('stale-policy')
    expect(await codeOf(() => producer.evaluate(request(producer, { ruleId: 'unknown' })))).toBe('unknown-rule')
    expect(await codeOf(() => producer.evaluate(request(producer, { ceiling: 'digest' })))).toBe('ceiling-mismatch')
    expect(await codeOf(() => producer.evaluate({ ...request(producer), unexpected: true } as never))).toBe('invalid-request')
    expect(await codeOf(() => producer.evaluate(request(producer, { sourceText: 'x'.repeat(65_537) })))).toBe('invalid-request')
    expect(calls).toHaveLength(0)
  })
})

describe('assistant-proactive intake evaluation health', () => {
  it('reports unregistered, registered and degraded states without granting anything', () => {
    const { llm } = scriptedLlm(() => jsonOutput({ ruleId: 'triage', level: 'ignore', quotes: [] }))
    const producer = new IntakeEvaluationProducer({ config: settings() })
    expect(producer.health()).toMatchObject({ enabled: true, registered: false, readiness: 'unavailable', lastError: null })
    expect(producer.health().policyVersion).toMatch(/^v1-[0-9a-f]{64}$/u)
    producer.attach(llm)
    producer.markRegistered(true)
    expect(producer.health()).toMatchObject({ registered: true, readiness: 'registered', lastError: null })
    producer.markUnavailable(new Error('intake evaluation is disabled'))
    expect(producer.health()).toMatchObject({ registered: false, readiness: 'unavailable', lastError: expect.stringContaining('intake evaluation is disabled') })
    expect(Object.isFrozen(producer.health())).toBe(true)
  })
})
