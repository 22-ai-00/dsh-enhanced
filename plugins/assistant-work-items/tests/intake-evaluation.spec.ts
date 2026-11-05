import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  InferredIntakeEvaluationQueue,
  type InferredIntakeCandidate,
  type IntakeEvaluationMode,
  type IntakeEvaluationOptions,
  type IntakeModelRequest,
} from '../src/intake-evaluation.ts'

const TEXT = '明天下午三点前请把季度报告发给我，谢谢。'
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function candidate(over: Partial<InferredIntakeCandidate> = {}): InferredIntakeCandidate {
  return { candidateId: 'c1', ruleId: 'r1', strength: 'inferred', policyVersion: 'p1', sourceText: TEXT, sourceDigest: digest(TEXT), ceiling: 'notify', ...over }
}

/** Manual clock + manual timers so timeouts are deterministic. */
function harness(evaluate: (request: IntakeModelRequest) => Promise<unknown>, over: Partial<IntakeEvaluationOptions> = {}) {
  let now = 1_000
  let policy = 'p1'
  let mode: IntakeEvaluationMode = 'observe'
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = []
  const calls: IntakeModelRequest[] = []
  const queue = new InferredIntakeEvaluationQueue({
    evaluator: request => { calls.push(request); return evaluate(request) },
    policyVersion: () => policy,
    mode: () => mode,
    now: () => now,
    setTimer: (ms, callback) => {
      const timer = { at: now + ms, callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    timeoutMs: 100,
    ...over,
  })
  return {
    queue,
    calls,
    advance(ms: number) { now += ms },
    fireTimers() { for (const t of timers) if (!t.cancelled && t.at <= now + 1e9) { t.cancelled = true; t.callback() } },
    setPolicy(version: string) { policy = version },
    setMode(next: IntakeEvaluationMode) { mode = next },
  }
}

/** A one-slot array with a hole (not `[undefined]`): `every` skips holes. */
const sparse = (): unknown[] => { const holes: unknown[] = []; holes.length = 1; return holes }

const verdict = (level: string, quotes: string[]) => async () => ({ level, quotes })

describe('inferred intake model evaluation', () => {
  test('evaluates once per rule and returns the stored decision afterwards', async () => {
    const h = harness(verdict('notify', ['季度报告发给我']))
    expect(h.queue.enqueue(candidate())).toEqual({ state: 'queued' })
    expect(h.queue.enqueue(candidate())).toEqual({ state: 'duplicate' })
    expect(h.queue.enqueue(candidate({ ruleId: 'r2' }))).toEqual({ state: 'queued' })
    const decisions = await h.queue.runDue()
    expect(decisions.map(d => [d.ruleId, d.level, d.reasons])).toEqual([['r1', 'notify', []], ['r2', 'notify', []]])
    expect(await h.queue.runDue()).toEqual([])
    expect(h.queue.enqueue(candidate())).toEqual({ state: 'duplicate' })
    expect(await h.queue.runDue()).toEqual([])
    expect(h.calls).toHaveLength(2)
    expect(h.queue.decision('c1', 'r1')?.quotes).toEqual(['季度报告发给我'])
  })

  test('a conflicting re-enqueue for the same rule is rejected, not re-evaluated', () => {
    const h = harness(verdict('ignore', []))
    h.queue.enqueue(candidate())
    expect(h.queue.enqueue(candidate({ ceiling: 'accept' }))).toEqual({ state: 'rejected', reason: 'conflict' })
    const other = '另一段文字'
    expect(h.queue.enqueue(candidate({ sourceText: other, sourceDigest: digest(other) }))).toEqual({ state: 'rejected', reason: 'conflict' })
  })

  test('never upgrades past the Host ceiling', async () => {
    const h = harness(verdict('accept', ['季度报告']))
    h.queue.enqueue(candidate({ ceiling: 'digest' }))
    const [decision] = await h.queue.runDue()
    expect(decision).toMatchObject({ level: 'digest', proposedLevel: 'accept', ceiling: 'digest', reasons: ['upgrade-clamped'], wouldAccept: false })
  })

  test('downgrades are kept as-is', async () => {
    const h = harness(verdict('digest', ['季度报告']))
    h.queue.enqueue(candidate({ ceiling: 'accept' }))
    expect((await h.queue.runDue())[0]).toMatchObject({ level: 'digest', reasons: [] })
  })

  test.each([
    ['paraphrase', ['把季度的报告发给我']],
    ['normalized whitespace', ['明天下午三点前 请把']],
    ['one bad among good', ['季度报告', '年度报告']],
  ])('quote that is not an exact substring downgrades to ignore (%s)', async (_label, quotes) => {
    const h = harness(verdict('notify', quotes))
    h.queue.enqueue(candidate())
    expect((await h.queue.runDue())[0]).toMatchObject({ status: 'decided', level: 'ignore', proposedLevel: 'notify', quotes: [], reasons: ['quote-not-in-source'] })
  })

  test('non-ignore without quotes, malformed output and oversized quotes downgrade to ignore', async () => {
    const cases: [unknown, string][] = [
      [{ level: 'notify', quotes: [] }, 'quote-missing'],
      [{ level: 'urgent', quotes: ['季度报告'] }, 'malformed-output'],
      [{ level: 'notify', quotes: [''] }, 'malformed-output'],
      ['accept', 'malformed-output'],
      [{ level: 'notify', quotes: ['季', '度', '报', '告', '发'] }, 'quote-bound-exceeded'],
    ]
    for (const [output, reason] of cases) {
      const h = harness(async () => output)
      h.queue.enqueue(candidate())
      expect((await h.queue.runDue())[0]).toMatchObject({ level: 'ignore', reasons: [reason], quotes: [], effect: 'none' })
    }
  })

  test('unauthenticated source text is ignored without a model call', async () => {
    const h = harness(verdict('accept', ['季度报告']))
    const result = h.queue.enqueue(candidate({ sourceText: TEXT + '（篡改）' }))
    expect(result).toMatchObject({ state: 'decided', decision: { level: 'ignore', reasons: ['source-unauthenticated'] } })
    h.setPolicy('p2')
    expect(await h.queue.runDue()).toEqual([])
    expect(h.calls).toHaveLength(0)
  })

  test('budget bounds calls per window and leaves the rest queued', async () => {
    const h = harness(verdict('notify', ['季度报告']), { budget: { maxCalls: 2, windowMs: 10_000 } })
    for (const id of ['a', 'b', 'c']) h.queue.enqueue(candidate({ candidateId: id }))
    expect(await h.queue.runDue()).toHaveLength(2)
    expect(h.queue.inspect()).toMatchObject({ queued: 1, decided: 2, budgetExhausted: true })
    expect(await h.queue.runDue()).toEqual([])
    h.advance(10_001)
    expect((await h.queue.runDue()).map(d => d.candidateId)).toEqual(['c'])
    expect(h.calls).toHaveLength(3)
  })

  test('maxPerRun and maxPending are bounded', async () => {
    const h = harness(verdict('ignore', []), { maxPerRun: 1, maxPending: 2 })
    h.queue.enqueue(candidate({ candidateId: 'a' }))
    h.queue.enqueue(candidate({ candidateId: 'b' }))
    expect(h.queue.enqueue(candidate({ candidateId: 'c' }))).toEqual({ state: 'rejected', reason: 'queue-full' })
    expect(await h.queue.runDue()).toHaveLength(1)
  })

  test('timeouts re-queue with bounded backoff, then settle unavailable', async () => {
    const signals: AbortSignal[] = []
    const h = harness(request => { signals.push(request.signal); return new Promise(() => {}) }, {
      maxConsecutiveFailures: 4, backoffBaseMs: 1_000, backoffMaxMs: 2_500,
    })
    h.queue.enqueue(candidate())
    const run = async () => { const pending = h.queue.runDue(); await Promise.resolve(); await Promise.resolve(); h.fireTimers(); return pending }
    expect(await run()).toEqual([])
    expect(signals[0]?.aborted).toBe(true)
    // Not due before backoff (1000ms).
    h.advance(999); expect(await h.queue.runDue()).toEqual([])
    h.advance(1); expect(await run()).toEqual([])          // failure 2, backoff 2000
    h.advance(1_999); expect(await h.queue.runDue()).toEqual([])
    h.advance(1); expect(await run()).toEqual([])          // failure 3, backoff capped 2500
    h.advance(2_499); expect(await h.queue.runDue()).toEqual([])
    h.advance(1)
    const [decision] = await run()                         // failure 4 → unavailable
    expect(decision).toMatchObject({ status: 'unavailable', level: 'ignore', reasons: ['consecutive-failures'], attempts: 4, effect: 'none', wouldAccept: false })
    expect(h.calls).toHaveLength(4)
    expect(h.queue.inspect()).toMatchObject({ unavailable: 1, queued: 0 })
  })

  test('a success resets the consecutive-failure count; thrown errors count as failures', async () => {
    let n = 0
    const h = harness(async () => { if (n++ === 0) throw new Error('5xx'); return { level: 'notify', quotes: ['季度报告'] } }, { maxConsecutiveFailures: 2 })
    h.queue.enqueue(candidate())
    expect(await h.queue.runDue()).toEqual([])
    h.advance(1_000)
    expect((await h.queue.runDue())[0]).toMatchObject({ status: 'decided', level: 'notify', attempts: 2 })
  })

  test('a result computed under a Policy version that changed mid-call is discarded and re-queued on re-match', async () => {
    const h = harness(async request => {
      if (request.policyVersion === 'p1') h.setPolicy('p2')
      return { level: 'notify', quotes: ['季度报告'] }
    })
    h.queue.enqueue(candidate())
    expect(await h.queue.runDue()).toEqual([])
    expect(h.queue.decision('c1', 'r1')).toBeUndefined()
    expect(h.queue.inspect()).toMatchObject({ awaitingRematch: 1, queued: 0 })
    expect(await h.queue.runDue()).toEqual([])
    expect(h.queue.enqueue(candidate({ policyVersion: 'p2' }))).toEqual({ state: 'queued' })
    const [decision] = await h.queue.runDue()
    expect(decision).toMatchObject({ policyVersion: 'p2', level: 'notify' })
    expect(h.calls.map(c => c.policyVersion)).toEqual(['p1', 'p2'])
  })

  test('settled decisions on a stale Policy version are re-queued with the re-matched ceiling', async () => {
    const h = harness(verdict('accept', ['季度报告']))
    h.queue.enqueue(candidate({ ceiling: 'accept' }))
    expect((await h.queue.runDue())[0]?.level).toBe('accept')
    h.setPolicy('p2')
    expect(h.queue.decision('c1', 'r1')).toBeUndefined()
    // The stale entry is neither evaluated nor returned until the Host re-matches it.
    expect(await h.queue.runDue()).toEqual([])
    expect(h.queue.enqueue(candidate())).toEqual({ state: 'rejected', reason: 'stale-policy' })
    expect(h.queue.enqueue(candidate({ policyVersion: 'p2', ceiling: 'digest' }))).toEqual({ state: 'queued' })
    const [decision] = await h.queue.runDue()
    expect(decision).toMatchObject({ policyVersion: 'p2', level: 'digest', ceiling: 'digest', reasons: ['upgrade-clamped'] })
    expect(await h.queue.runDue()).toEqual([])
    expect(h.calls).toHaveLength(2)
  })

  test('observe mode records would-accept only; auto mode marks apply', async () => {
    const h = harness(verdict('accept', ['季度报告']))
    h.queue.enqueue(candidate({ ceiling: 'accept' }))
    expect((await h.queue.runDue())[0]).toMatchObject({ mode: 'observe', level: 'accept', wouldAccept: true, effect: 'none' })
    h.setMode('auto')
    h.queue.enqueue(candidate({ candidateId: 'c2', ceiling: 'accept' }))
    expect((await h.queue.runDue())[0]).toMatchObject({ mode: 'auto', wouldAccept: true, effect: 'apply' })
  })

  test('a persisted prior decision for the current version prevents re-evaluation', async () => {
    const first = harness(verdict('notify', ['季度报告']))
    first.queue.enqueue(candidate())
    const [prior] = await first.queue.runDue()
    const restarted = harness(verdict('accept', ['季度报告']))
    expect(restarted.queue.enqueue(candidate(), prior)).toEqual({ state: 'queued', prior: 'adopted' })
    expect(await restarted.queue.runDue()).toEqual([])
    expect(restarted.calls).toHaveLength(0)
    expect(restarted.queue.decision('c1', 'r1')).toEqual(prior)
  })

  test('a forged or inconsistent prior is not trusted', async () => {
    const h = harness(verdict('ignore', []), { maxPerRun: 20, budget: { maxCalls: 50, windowMs: 1_000 } })
    const base = { candidateId: 'c1', ruleId: 'r1', sourceDigest: digest(TEXT), policyVersion: 'p1', mode: 'auto', status: 'decided',
      level: 'notify', proposedLevel: 'notify', ceiling: 'notify', quotes: ['季度报告'], reasons: [], wouldAccept: false, effect: 'apply',
      attempts: 1, decidedAt: 1 } as const
    const forged: Record<string, unknown>[] = [
      { quotes: ['伪造引文'] },
      { level: 'accept' },
      { level: 'bogus' },
      { quotes: [] },
      { quotes: sparse() },
      { quotes: ['\ud83d'] },
      { quotes: 'not-an-array' },
      { policyVersion: 'p0' },
      { status: 'unavailable' },
      { status: 'unavailable', level: 'accept', quotes: [], reasons: ['consecutive-failures'] },
      { reasons: ['source-unauthenticated'] },
      { reasons: ['made-up'] },
      { mode: 'yolo' },
      { attempts: -1 },
    ]
    forged.forEach((over, i) => {
      expect(h.queue.enqueue(candidate({ ruleId: `r${i}` }), { ...base, ruleId: `r${i}`, ...over } as never)).toEqual({ state: 'queued', prior: 'rejected' })
    })
    expect(await h.queue.runDue()).toHaveLength(forged.length)
    expect(h.calls).toHaveLength(forged.length)
  })

  test('an adopted prior is rebuilt: derived fields cannot be forged and observe never applies', async () => {
    const h = harness(verdict('ignore', []))
    const prior = { candidateId: 'c1', ruleId: 'r1', sourceDigest: digest(TEXT), policyVersion: 'p1', mode: 'observe', status: 'decided',
      level: 'notify', proposedLevel: 'notify', ceiling: 'notify', quotes: ['季度报告'], reasons: [], wouldAccept: true, effect: 'apply',
      attempts: 1, decidedAt: 1 } as const
    expect(h.queue.enqueue(candidate(), prior)).toEqual({ state: 'queued', prior: 'adopted' })
    expect(h.queue.decision('c1', 'r1')).toMatchObject({ wouldAccept: false, effect: 'none' })
    const unavailable = { ...prior, ruleId: 'r2', status: 'unavailable', level: 'ignore', proposedLevel: null, quotes: [], reasons: ['consecutive-failures'] } as const
    expect(h.queue.enqueue(candidate({ ruleId: 'r2' }), unavailable)).toEqual({ state: 'queued', prior: 'adopted' })
    expect(h.calls).toHaveLength(0)
  })

  test('re-entrant runDue is a no-op', async () => {
    let release = () => {}
    const h = harness(() => new Promise(resolve => { release = () => resolve({ level: 'ignore', quotes: [] }) }))
    h.queue.enqueue(candidate())
    const first = h.queue.runDue()
    expect(await h.queue.runDue()).toEqual([])
    await Promise.resolve(); await Promise.resolve()
    release()
    expect(await first).toHaveLength(1)
  })

  test('invalid candidates are rejected', () => {
    const h = harness(verdict('ignore', []))
    expect(h.queue.enqueue(candidate({ strength: 'explicit' as never }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
    expect(h.queue.enqueue(candidate({ policyVersion: '' }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
    expect(h.queue.enqueue(null as never)).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
    expect(h.queue.enqueue(candidate({ ruleId: '' }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
    expect(h.queue.enqueue(candidate({ sourceDigest: 'x' }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
    expect(h.queue.enqueue(candidate({ ceiling: 'urgent' as never }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
  })

  test('quotes: sparse arrays, lone surrogates, whitespace-only and over-long quotes never pass', async () => {
    const emoji = '请把😀季度报告发给我'
    const cases: [unknown, string][] = [
      [{ level: 'notify', quotes: sparse() }, 'malformed-output'],
      [{ level: 'notify', quotes: ['\ud83d'] }, 'malformed-output'],
      [{ level: 'notify', quotes: ['季度报告', '\ude00'] }, 'malformed-output'],
      [{ level: 'notify', quotes: ['   '] }, 'malformed-output'],
      [{ level: 'notify', quotes: [emoji + emoji] }, 'quote-bound-exceeded'],
    ]
    for (const [output, reason] of cases) {
      const h = harness(async () => output, { maxQuoteChars: 12 })
      h.queue.enqueue(candidate({ sourceText: emoji, sourceDigest: digest(emoji) }))
      expect((await h.queue.runDue())[0]).toMatchObject({ level: 'ignore', reasons: [reason], quotes: [] })
    }
    // Exact, un-normalized match: NFD 'é' is not a substring of NFC 'é'; a full astral character is fine.
    const nfc = 'café 😀'
    for (const [quote, level] of [['café', 'ignore'], ['😀', 'notify'], ['é 😀', 'notify']] as const) {
      const h = harness(verdict('notify', [quote]))
      h.queue.enqueue(candidate({ sourceText: nfc, sourceDigest: digest(nfc) }))
      expect((await h.queue.runDue())[0]?.level).toBe(level)
    }
  })

  test('evaluator output is read once, so a getter cannot pass checks and then change', async () => {
    let reads = 0
    const output = { get level() { return reads++ === 0 ? 'notify' : 'accept' }, quotes: ['季度报告'] }
    const h = harness(async () => output)
    h.queue.enqueue(candidate({ ceiling: 'accept' }))
    expect((await h.queue.runDue())[0]).toMatchObject({ level: 'notify', proposedLevel: 'notify' })
    const throwing = harness(async () => ({ get level(): string { throw new Error('boom') }, quotes: [] }))
    throwing.queue.enqueue(candidate())
    expect((await throwing.queue.runDue())[0]).toMatchObject({ level: 'ignore', reasons: ['malformed-output'] })
  })

  test('a tampered enqueue is not retained, so the authentic one is still evaluated', async () => {
    const h = harness(verdict('notify', ['季度报告']))
    expect(h.queue.enqueue(candidate({ sourceText: TEXT + 'x' }))).toMatchObject({ state: 'decided', decision: { reasons: ['source-unauthenticated'] } })
    expect(h.queue.enqueue(candidate())).toEqual({ state: 'queued' })
    // A later tampered copy is ignored on its own and does not disturb the stored entry.
    expect(h.queue.enqueue(candidate({ sourceText: TEXT + 'x' }))).toMatchObject({ state: 'decided', decision: { level: 'ignore' } })
    expect((await h.queue.runDue())[0]?.level).toBe('notify')
  })

  test('a ceiling of ignore settles without spending budget', async () => {
    const h = harness(verdict('notify', ['季度报告']))
    expect(h.queue.enqueue(candidate({ ceiling: 'ignore' }))).toMatchObject({ state: 'decided', decision: { level: 'ignore', reasons: ['ceiling-ignore'] } })
    expect(h.queue.enqueue(candidate({ ceiling: 'ignore' }))).toEqual({ state: 'duplicate' })
    expect(await h.queue.runDue()).toEqual([])
    expect(h.calls).toHaveLength(0)
  })

  test('maxPending bounds undecided items only; settled entries are evicted at maxRetained', async () => {
    const h = harness(verdict('ignore', []), { maxPending: 2, maxRetained: 3, budget: { maxCalls: 100, windowMs: 1_000 } })
    for (const id of ['a', 'b']) h.queue.enqueue(candidate({ candidateId: id }))
    expect(h.queue.enqueue(candidate({ candidateId: 'c' }))).toEqual({ state: 'rejected', reason: 'queue-full' })
    await h.queue.runDue()
    for (const id of ['c', 'd']) expect(h.queue.enqueue(candidate({ candidateId: id }))).toEqual({ state: 'queued' })
    // 'a' (oldest settled) was evicted to make room for 'd'.
    expect(h.queue.decision('a', 'r1')).toBeUndefined()
    expect(h.queue.decision('b', 'r1')?.level).toBe('ignore')
    expect(h.queue.enqueue(candidate({ candidateId: 'e' }))).toEqual({ state: 'rejected', reason: 'queue-full' })
  })

  test('auto→observe: a stored apply decision is looked up with effect none', async () => {
    const h = harness(verdict('notify', ['季度报告']))
    h.setMode('auto')
    h.queue.enqueue(candidate())
    expect((await h.queue.runDue())[0]?.effect).toBe('apply')
    h.setMode('observe')
    expect(h.queue.decision('c1', 'r1')).toMatchObject({ effect: 'none', level: 'notify' })
  })

  test('a throwing Host callback does not strand the entry in flight', async () => {
    let boom = true
    const queue = new InferredIntakeEvaluationQueue({
      evaluator: verdict('notify', ['季度报告']),
      policyVersion: () => 'p1',
      mode: () => { if (boom) throw new Error('mode'); return 'observe' },
    })
    queue.enqueue(candidate())
    await expect(queue.runDue()).rejects.toThrow('mode')
    boom = false
    expect((await queue.runDue())[0]?.level).toBe('notify')
  })

  test('a late result after timeout is discarded and the call stays charged', async () => {
    let resolveLate: (value: unknown) => void = () => {}
    let n = 0
    const h = harness(() => n++ === 0 ? new Promise(resolve => { resolveLate = resolve }) : Promise.resolve({ level: 'digest', quotes: ['季度报告'] }),
      { budget: { maxCalls: 2, windowMs: 10_000 } })
    h.queue.enqueue(candidate())
    const pending = h.queue.runDue(); await Promise.resolve(); await Promise.resolve(); h.fireTimers()
    expect(await pending).toEqual([])
    resolveLate({ level: 'accept', quotes: ['季度报告'] })
    await Promise.resolve()
    expect(h.queue.decision('c1', 'r1')).toBeUndefined()
    expect(h.queue.inspect()).toMatchObject({ callsInWindow: 1, queued: 1 })
    h.advance(1_000)
    expect((await h.queue.runDue())[0]).toMatchObject({ level: 'digest', attempts: 2 })
    expect(h.queue.inspect()).toMatchObject({ callsInWindow: 2, budgetExhausted: true })
  })

  test('timeoutMs beyond the 32-bit timer range is clamped instead of wrapping', () => {
    const delays: number[] = []
    const queue = new InferredIntakeEvaluationQueue({
      evaluator: () => new Promise(() => {}), policyVersion: () => 'p1', mode: () => 'observe', timeoutMs: 3_000_000_000,
      setTimer: (ms) => { delays.push(ms); return () => {} },
    })
    queue.enqueue(candidate())
    void queue.runDue()
    expect(delays).toEqual([2_147_483_647])
  })
})
