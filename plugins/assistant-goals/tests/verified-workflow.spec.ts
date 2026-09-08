import { expect, test } from 'vitest'
import { successfulToolSteps, verifiedRunId } from '../src/verified-workflow.ts'

const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/work', preset: 'primary' }

test('retains only a complete successful historical tool trace and derives its exact run id', () => {
  const runId = verifiedRunId(scope, 'goal-a', 'session-a', 7)
  expect(runId).toMatch(/^goal-run-[a-f0-9]{64}$/u)
  expect(successfulToolSteps([
    { type: 'tool/call', data: { turn: 7, callId: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: 'a' }) } },
    { type: 'tool/result', data: { turn: 7, message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
  ], 7)).toEqual([{ id: 'call-1', toolName: 'read_file', arguments: { path: 'a' } }])
})

test('rejects a failed or unconfirmed historical tool trace', () => {
  const call = { type: 'tool/call', data: { turn: 3, callId: 'call-1', name: 'write_file', arguments: '{}' } }
  expect(() => successfulToolSteps([call], 3)).toThrow(/unconfirmed/u)
  expect(() => successfulToolSteps([call, { type: 'tool/result', data: { turn: 3, message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [] }] } } }], 3)).toThrow(/failed/u)
})

test.each(['null', '[]', 'true', '"text"', '{invalid'])('rejects malformed or scalar native arguments %s', argumentsText => {
  expect(() => successfulToolSteps([{ type: 'tool/call', data: { turn: 1, callId: 'bad', name: 'write', arguments: argumentsText } }], 1)).toThrow()
})

test.each([undefined, [], [{ type: 'text', text: 'extra' }, { type: 'tool-result', toolCallId: 'call-1', isError: false }], [{ type: 'text', text: 'success' }], [{ type: 'tool-result', toolCallId: 'other', isError: false }]])('rejects missing or mismatched native result blocks %j', content => {
  const call = { type: 'tool/call', data: { turn: 3, callId: 'call-1', name: 'write', arguments: '{}' } }
  expect(() => successfulToolSteps([call, { type: 'tool/result', data: { turn: 3, message: { source: { callId: 'call-1' }, content } } }], 3)).toThrow(/failed/u)
})

test('accepts the native success block with its optional error flag omitted', () => {
  const call = { type: 'tool/call', data: { turn: 3, callId: 'call-1', name: 'write', arguments: '{}' } }
  expect(successfulToolSteps([call, { type: 'tool/result', data: { turn: 3, message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] } } }], 3)).toHaveLength(1)
})
