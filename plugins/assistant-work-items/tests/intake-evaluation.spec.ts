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
  return { candidateId: 'c1', ruleId: 'r1', sourceText: TEXT, sourceDigest: digest(TEXT), ceiling: 'notify', ...over }
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

  test('a result computed under a Policy version that changed mid-call is re-queued', async () => {
    const h = harness(async request => {
      if (request.policyVersion === 'p1') h.setPolicy('p2')
      return { level: 'notify', quotes: ['季度报告'] }
    })
    h.queue.enqueue(candidate())
    expect(await h.queue.runDue()).toEqual([])
    const [decision] = await h.queue.runDue()
    expect(decision).toMatchObject({ policyVersion: 'p2', level: 'notify' })
    expect(h.calls.map(c => c.policyVersion)).toEqual(['p1', 'p2'])
  })

  test('settled decisions on a stale Policy version are re-queued for the new version', async () => {
    const h = harness(verdict('notify', ['季度报告']))
    h.queue.enqueue(candidate())
    await h.queue.runDue()
    h.setPolicy('p2')
    expect(h.queue.decision('c1', 'r1')).toBeUndefined()
    const [decision] = await h.queue.runDue()
    expect(decision?.policyVersion).toBe('p2')
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
    expect(restarted.queue.enqueue(candidate(), prior)).toEqual({ state: 'queued' })
    expect(await restarted.queue.runDue()).toEqual([])
    expect(restarted.calls).toHaveLength(0)
    expect(restarted.queue.decision('c1', 'r1')).toBe(prior)
  })

  test('a forged prior (quote not in source or above ceiling) is not trusted', async () => {
    const h = harness(verdict('ignore', []))
    const base = { candidateId: 'c1', ruleId: 'r1', sourceDigest: digest(TEXT), policyVersion: 'p1', mode: 'auto', status: 'decided',
      proposedLevel: 'notify', ceiling: 'notify', reasons: [], wouldAccept: false, effect: 'apply', attempts: 1, decidedAt: 1 } as const
    h.queue.enqueue(candidate(), { ...base, level: 'notify', quotes: ['伪造引文'] })
    h.queue.enqueue(candidate({ ruleId: 'r2' }), { ...base, ruleId: 'r2', level: 'accept', quotes: ['季度报告'] })
    expect((await h.queue.runDue()).map(d => d.level)).toEqual(['ignore', 'ignore'])
    expect(h.calls).toHaveLength(2)
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
    expect(h.queue.enqueue(candidate({ ruleId: '' }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
    expect(h.queue.enqueue(candidate({ sourceDigest: 'x' }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
    expect(h.queue.enqueue(candidate({ ceiling: 'urgent' as never }))).toEqual({ state: 'rejected', reason: 'invalid-candidate' })
  })
})
