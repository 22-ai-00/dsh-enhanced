import { describe, expect, test } from 'vitest'
import { attentionGraphemeCaps, attentionWordCaps, ProgressAttentionAudit, progressAttentionText } from '../src/index.ts'

const run = { bindingId: 'binding-1', eventId: 'om_in' }

describe('WP19 stage 2c progress attention audit', () => {
  test('measures the upper bound of owner-visible text per update kind', () => {
    expect(progressAttentionText({ kind: 'started' })).toBe('')
    expect(progressAttentionText({ kind: 'completed' })).toBe('')
    expect(progressAttentionText({ kind: 'paused' })).toBe('')
    expect(progressAttentionText({ kind: 'step', text: '正在处理请求…' })).toBe('正在处理请求…')
    expect(progressAttentionText({ kind: 'tool-started', callId: 'c', toolName: 'web.search', argumentsPreview: '{"q":"x"}' }))
      .toBe('web.search\n{"q":"x"}')
    expect(progressAttentionText({ kind: 'tool-finished', callId: 'c', failed: true, resultPreview: 'boom', code: 'E1' }))
      .toBe('boom\nE1')
    expect(progressAttentionText({ kind: 'todos', todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] }))
      .toBe('a\nb')
    expect(progressAttentionText({ kind: 'failed', code: 'agent-task-timeout' })).toBe('agent-task-timeout')
    expect(progressAttentionText({ kind: 'failed' })).toBe('')
  })

  test('verdict is cumulative per run so splitting across bubbles cannot dodge the cap', () => {
    const audit = new ProgressAttentionAudit(1000, 256, () => 42)
    const half = Array.from({ length: attentionWordCaps.result / 2 }, () => 'word').join(' ')
    const first = audit.record({ ...run, origin: 'foreground', update: { kind: 'step', text: half } })
    expect(first).toMatchObject({ sequence: 1, origin: 'foreground', updateKind: 'step', purpose: 'result', purposeSource: 'lane',
      wordCount: attentionWordCaps.result / 2, runWordCount: attentionWordCaps.result / 2, wordCap: attentionWordCaps.result,
      verdict: 'would-accept', reasons: [], recordedAt: 42 })
    const second = audit.record({ ...run, origin: 'foreground', update: { kind: 'step', text: half } })
    expect(second).toMatchObject({ runWordCount: attentionWordCaps.result, verdict: 'would-accept' })
    const third = audit.record({ ...run, origin: 'foreground', update: { kind: 'step', text: 'over' } })
    expect(third).toMatchObject({ wordCount: 1, runWordCount: attentionWordCaps.result + 1, verdict: 'would-attach', reasons: ['over-word-cap'] })
    // A different origin is a separate run; a terminal closes the run.
    expect(audit.record({ ...run, origin: 'background', update: { kind: 'step', text: 'goal' } }))
      .toMatchObject({ runWordCount: 1, verdict: 'would-accept' })
    expect(audit.record({ ...run, origin: 'foreground', update: { kind: 'completed' } }))
      .toMatchObject({ wordCount: 0, verdict: 'would-attach' })
    expect(audit.record({ ...run, origin: 'foreground', update: { kind: 'started' } }))
      .toMatchObject({ runWordCount: 0, verdict: 'would-accept' })
  })

  test('grapheme cap, estimate and identifier flags stick for the run', () => {
    const audit = new ProgressAttentionAudit()
    audit.record({ ...run, origin: 'foreground', update: { kind: 'step', text: '配置估值 0.7' } })
    const id = audit.record({ ...run, origin: 'foreground', update: { kind: 'tool-finished', callId: 'c', failed: false,
      resultPreview: '123e4567-e89b-12d3-a456-426614174000' } })
    expect(id.reasons).toEqual(['text-exposes-estimate', 'text-exposes-identifier'])
    expect(id.verdict).toBe('would-accept')
    const blob = audit.record({ ...run, origin: 'foreground', update: { kind: 'step', text: 'x'.repeat(attentionGraphemeCaps.result) } })
    expect(blob).toMatchObject({ verdict: 'would-attach', reasons: ['over-grapheme-cap', 'text-exposes-estimate', 'text-exposes-identifier'] })
  })

  test('is deterministic for one ordered update stream', () => {
    const stream = [
      { kind: 'started' }, { kind: 'step', text: '正在处理请求…' },
      { kind: 'tool-started', callId: 'c', toolName: 'shell', argumentsPreview: 'ls -la' },
      { kind: 'todos', todos: [{ content: '核对接口', status: 'in_progress' }] }, { kind: 'completed' },
    ] as const
    const replay = () => {
      const audit = new ProgressAttentionAudit(1000, 256, () => 0)
      for (const update of stream) audit.record({ ...run, origin: 'foreground', update })
      return audit.list(0, 500)
    }
    expect(replay()).toEqual(replay())
  })

  test('pages in append order and keeps a bounded ring without text', () => {
    const audit = new ProgressAttentionAudit(3)
    for (let index = 0; index < 5; index += 1) {
      audit.record({ ...run, origin: 'foreground', update: { kind: 'step', text: `secret step ${index}` } })
    }
    const first = audit.list(0, 2)
    expect(first).toMatchObject({ hasMore: true, nextAfterSequence: 4, durable: false, evicted: 2 })
    expect(first.entries.map(entry => entry.sequence)).toEqual([3, 4])
    const second = audit.list(4, 2)
    expect(second).toMatchObject({ hasMore: false, nextAfterSequence: null })
    expect(second.entries.map(entry => entry.sequence)).toEqual([5])
    expect(audit.list(5, 2).entries).toEqual([])
    expect(JSON.stringify([first, second])).not.toContain('secret')
  })

  test('bounds unterminated run state', () => {
    const audit = new ProgressAttentionAudit(1000, 2)
    audit.record({ bindingId: 'b', eventId: 'e1', origin: 'foreground', update: { kind: 'step', text: 'one' } })
    audit.record({ bindingId: 'b', eventId: 'e2', origin: 'foreground', update: { kind: 'step', text: 'one' } })
    audit.record({ bindingId: 'b', eventId: 'e3', origin: 'foreground', update: { kind: 'step', text: 'one' } })
    // e1 was evicted as the oldest run, so it restarts its cumulative count.
    expect(audit.record({ bindingId: 'b', eventId: 'e1', origin: 'foreground', update: { kind: 'step', text: 'two' } }).runWordCount).toBe(1)
    expect(audit.record({ bindingId: 'b', eventId: 'e3', origin: 'foreground', update: { kind: 'step', text: 'two' } }).runWordCount).toBe(2)
  })

  test('a terminal also releases the background run of the same inbound message', () => {
    const audit = new ProgressAttentionAudit(1000, 2)
    audit.record({ ...run, origin: 'background', update: { kind: 'step', text: 'goal round' } })
    audit.record({ ...run, origin: 'foreground', update: { kind: 'completed' } })
    expect(audit.record({ ...run, origin: 'background', update: { kind: 'step', text: 'next' } }).runWordCount).toBe(1)
  })
})
