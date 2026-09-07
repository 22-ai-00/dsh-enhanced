import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, test } from 'vitest'
import { originalToolEvidence, pageToolEvidence } from '../src/evidence-runtime.ts'

function session() {
  const id = SessionId('evidence-runtime')
  return Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
  })
}

function appendCallAndResult(target: Session, name = 'read_file', content = 'result') {
  const callId = ToolCallId(`call-${target.seq}`)
  const call = target.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{"private":"argument"}' })
  const result = target.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: content }], isError: false }),
    meta: { private: 'metadata' },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  return result
}

describe('tool evidence runtime', () => {
  test('extracts only append-origin model-visible result content', () => {
    const target = session()
    const result = appendCallAndResult(target)
    const evidence = originalToolEvidence(target, result.seq)
    expect(evidence).toMatchObject({ eventSeq: result.seq, toolName: 'read_file', callId: result.data.message.source.callId, failed: false })
    expect(evidence?.text).toBe('{"content":[{"text":"result","type":"text"}],"isError":false}')
    expect(evidence?.text).not.toContain('metadata')
    expect(evidence?.text).not.toContain('argument')
  })

  test('retains append evidence when a later compaction replacement shadows it', () => {
    const target = session()
    const result = appendCallAndResult(target)
    const replacement = target.append('tool/result', { ...result.data,
      message: { ...result.data.message, content: [{ ...result.data.message.content[0], content: [{ type: 'text', text: 'summary only' }] }] },
    }, { surfaceOp: { op: 'replace', start: result.seq, end: result.seq }, sourceEventSeqs: [result.seq] })
    expect(originalToolEvidence(target, result.seq)?.text).toContain('result')
    expect(originalToolEvidence(target, replacement.seq)).toBeUndefined()
  })

  test('has a stable digest after a cold JSON event round trip and shows content tampering', () => {
    const target = session()
    const result = appendCallAndResult(target)
    const first = originalToolEvidence(target, result.seq)!
    const snapshot = JSON.parse(JSON.stringify(target.snapshotEvents()))
    const cold = Session.create(target.id, snapshot, target.header)
    expect(originalToolEvidence(cold, result.seq)?.contentDigest).toBe(first.contentDigest)
    const changed = JSON.parse(JSON.stringify(target.snapshotEvents()))
    changed.find((event: { seq: number }) => event.seq === result.seq).data.message.content[0].content[0].text = 'tampered'
    const tampered = Session.create(target.id, changed, target.header)
    expect(originalToolEvidence(tampered, result.seq)?.contentDigest).not.toBe(first.contentDigest)
  })

  test('does not index an append copy as a new original observation', () => {
    const target = session()
    const result = appendCallAndResult(target)
    const copy = target.append('tool/result', result.data, { surfaceOp: 'append', sourceEventSeqs: [result.seq] })
    expect(originalToolEvidence(target, result.seq)).toBeDefined()
    expect(originalToolEvidence(target, copy.seq)).toBeUndefined()
    const forged = target.append('tool/result', result.data, { surfaceOp: 'append', sourceEventSeqs: result.sourceEventSeqs! })
    expect(originalToolEvidence(target, forged.seq)).toBeUndefined()
  })

  test('excludes memory tools, mismatched calls, and oversized originals', () => {
    const memory = session()
    const memoryResult = appendCallAndResult(memory, 'memory_search')
    expect(originalToolEvidence(memory, memoryResult.seq)).toBeUndefined()
    const target = session()
    const result = appendCallAndResult(target, 'read_file', 'x'.repeat(100))
    expect(originalToolEvidence(target, result.seq, 10)).toBeUndefined()

    const mismatched = session()
    const callId = ToolCallId('mismatched-call')
    mismatched.append('tool/call', { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' })
    const mismatchedResult = mismatched.append('tool/result', { turn: 2, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'wrong turn' }], isError: false }),
    }, { surfaceOp: 'append' })
    expect(originalToolEvidence(mismatched, mismatchedResult.seq)).toBeUndefined()
  })

  test('pages from the middle without splitting Unicode surrogate pairs', () => {
    const value = { text: 'ab😀cdef' }
    expect(pageToolEvidence(value, 2, 1)).toEqual({ text: '😀', offset: 2, nextOffset: 4, totalChars: 8 })
    expect(pageToolEvidence(value, 4, 2)).toEqual({ text: 'cd', offset: 4, nextOffset: 6, totalChars: 8 })
    expect(() => pageToolEvidence(value, 3)).toThrow(RangeError)
    expect(() => pageToolEvidence(value, -1)).toThrow(RangeError)
    expect(() => pageToolEvidence(value, 0, Number.NaN)).toThrow(RangeError)
    expect(pageToolEvidence(value, 0, 99_999).text.length).toBeLessThanOrEqual(4_096)
  })
})
