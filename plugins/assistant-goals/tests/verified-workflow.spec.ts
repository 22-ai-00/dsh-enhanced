import { expect, test } from 'vitest'
import { successfulToolSteps, verifiedRunId, verifiedToolTrace, verifiedWorkflowSource, verifiedWorkflowSourceChain } from '../src/verified-workflow.ts'

const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/work', preset: 'primary' }

function chainFixture(earlyCall = false) {
  const now = Date.now(); const record = { id: 'goal-a', scope, originalObjective: 'objective', definition: { version: 1, digest: 'digest', objective: 'objective' }, native: { sessionId: 'session-a', goalId: 'native-a', revision: 1, objective: 'objective', phase: 'complete', roundsStarted: 2, maxGoalRounds: 2, updatedAt: now }, checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: now, updatedAt: now } as any
  const run = (round: number, turn: number) => { const runId = verifiedRunId(scope, 'goal-a', 'session-a', turn); return { intent: { runId, scope, objective: 'objective', admission: { issuedAt: now, expiresAt: now + 10_000, maxGoalRounds: 2, round, authorizationDigest: 'auth' }, task: { kind: 'goal-step', ref: `step-${round}`, goal: { id: 'goal-a', definitionVersion: 1, definitionDigest: 'digest', stepId: `step-${round}`, runId, sessionId: 'session-a', nativeGoalId: 'native-a', nativeRevision: 1 } } }, execution: { status: 'succeeded', quiescent: true, completedAt: now } } as any }
  const first = run(1, 3); const final = run(2, 5)
  const call = (id: string, turn: number, seq: number) => ({ seq, type: 'tool/call', data: { turn, callId: id, name: 'read', arguments: JSON.stringify({ file_path: `${turn}.md` }) } })
  const result = (id: string, turn: number, seq: number) => ({ seq, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [seq - 1], data: { turn, message: { source: { callId: id }, content: [{ type: 'tool-result', toolCallId: id, content: [] }] } } })
  const events: any[] = [{ seq: 0, type: 'turn/start', data: { turn: 3 } }, { seq: 1, type: 'user/message', data: { source: { kind: 'goal', goalId: 'native-a', revision: 1, round: 1 } } }]
  if (earlyCall) events.push(call('shared', 3, 2), result('shared', 3, 3))
  events.push({ seq: earlyCall ? 4 : 2, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }, { seq: earlyCall ? 5 : 3, type: 'turn/start', data: { turn: 5 } }, { seq: earlyCall ? 6 : 4, type: 'user/message', data: { source: { kind: 'goal', goalId: 'native-a', revision: 1, round: 2 } } }, call(earlyCall ? 'shared' : 'final', 5, earlyCall ? 7 : 5), result(earlyCall ? 'shared' : 'final', 5, earlyCall ? 8 : 6), { seq: earlyCall ? 9 : 7, type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  return { scope, record, run: final, runs: [first, final], accepted: { state: 'done', contract: { id: 'contract', digest: 'digest' }, receipt: { objectiveStatus: 'achieved', validUntil: now + 10_000, completedAt: now } }, events }
}

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

test('retains only an explicit failed native read probe as a failed observation', () => {
  const call = { type: 'tool/call', data: { turn: 3, callId: 'missing-read', name: 'read', arguments: JSON.stringify({ file_path: 'missing.md' }) } }
  const result = { type: 'tool/result', data: { turn: 3, message: { isError: true, source: { callId: 'missing-read' }, content: [{ type: 'tool-result', toolCallId: 'missing-read', isError: true, content: [] }] } } }
  expect(verifiedToolTrace([call, result], 3)).toEqual({ steps: [], failedObservations: [{ id: 'missing-read', toolName: 'read', arguments: { file_path: 'missing.md' }, outcome: 'failed' }] })
  expect(() => successfulToolSteps([call, result], 3)).toThrow(/failed/u)
})

test('exports a failed read probe separately from confirmed successful workflow steps', () => {
  const runId = verifiedRunId(scope, 'goal-a', 'session-a', 3); const now = Date.now()
  const call = (id: string, name: string, arguments_: unknown, seq: number) => ({ seq, type: 'tool/call', data: { turn: 3, callId: id, name, arguments: JSON.stringify(arguments_) } })
  const result = (id: string, failed: boolean, seq: number) => ({ seq, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [seq - 1], data: { turn: 3, message: { ...(failed ? { isError: true } : {}), source: { callId: id }, content: [{ type: 'tool-result', toolCallId: id, ...(failed ? { isError: true } : {}), content: [] }] } } })
  const source = verifiedWorkflowSource({ scope, record: { id: 'goal-a', scope, originalObjective: 'objective', definition: { version: 1, digest: 'digest', objective: 'objective' },
    native: { sessionId: 'session-a', goalId: 'native-a', revision: 1, objective: 'objective', phase: 'complete', roundsStarted: 1, maxGoalRounds: 1, updatedAt: now },
    checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: now, updatedAt: now },
  run: { intent: { runId, scope, objective: 'objective', admission: { issuedAt: now, expiresAt: now + 10_000, maxGoalRounds: 1, round: 1, authorizationDigest: 'auth' }, task: { kind: 'goal-step', ref: 'step', goal: { id: 'goal-a', definitionVersion: 1, definitionDigest: 'digest', stepId: 'step', runId, sessionId: 'session-a', nativeGoalId: 'native-a', nativeRevision: 1 } } }, execution: { status: 'succeeded', quiescent: true, completedAt: now } },
  accepted: { state: 'done', contract: { id: 'contract', digest: 'contract-digest' }, receipt: { objectiveStatus: 'achieved', validUntil: now + 10_000, completedAt: now, digest: 'receipt-digest' } },
  events: [
    { seq: 0, type: 'turn/start', data: { turn: 3 } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'goal', goalId: 'native-a', revision: 1, round: 1 } } },
    call('missing', 'read', { file_path: 'missing.md' }, 2), result('missing', true, 3),
    call('verified', 'read', { file_path: 'report.md' }, 4), result('verified', false, 5),
    { seq: 6, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ] })
  expect(source).toMatchObject({ steps: [{ id: 'verified', toolName: 'read' }], failedObservations: [{ id: 'missing', toolName: 'read', arguments: { file_path: 'missing.md' }, outcome: 'failed' }] })
})

test.each([
  ['write', '{}'], ['edit', '{}'], ['bash', '{}'], ['unknown', '{}'], ['get_goal', JSON.stringify({ id: 'not-empty' })],
])('rejects failed non-observation %s', (name, argumentsText) => {
  const call = { type: 'tool/call', data: { turn: 3, callId: `failed-${name}`, name, arguments: argumentsText } }
  const result = { type: 'tool/result', data: { turn: 3, message: { isError: true, source: { callId: `failed-${name}` }, content: [{ type: 'tool-result', toolCallId: `failed-${name}`, isError: true, content: [] }] } } }
  expect(() => verifiedToolTrace([call, result], 3)).toThrow(/failed/u)
})

test('rejects duplicate or contradictory results even for a read observation', () => {
  const call = { type: 'tool/call', data: { turn: 3, callId: 'read-1', name: 'read', arguments: JSON.stringify({ file_path: 'missing.md' }) } }
  const failed = { type: 'tool/result', data: { turn: 3, message: { isError: true, source: { callId: 'read-1' }, content: [{ type: 'tool-result', toolCallId: 'read-1', isError: true, content: [] }] } } }
  const succeeded = { type: 'tool/result', data: { turn: 3, message: { source: { callId: 'read-1' }, content: [{ type: 'tool-result', toolCallId: 'read-1', content: [] }] } } }
  expect(() => verifiedToolTrace([call, failed, succeeded], 3)).toThrow(/duplicate|mismatched/u)
})

test('chains a completed empty early round without treating it as a replayable step', () => {
  const source = verifiedWorkflowSourceChain(chainFixture())
  expect(source.segments).toMatchObject([{ round: 1, steps: [] }, { round: 2, steps: [{ id: 'final' }] }])
})

test.each(['before-source', 'after-end'] as const)('excludes a settled call %s from workflow segments', position => {
  const input = chainFixture(), events = input.events as any[]
  const call = { type: 'tool/call', data: { turn: 5, callId: `outside-${position}`, name: 'write', arguments: '{}' } }
  const result = { type: 'tool/result', surfaceOp: 'append', data: { turn: 5, message: { source: { callId: `outside-${position}` },
    content: [{ type: 'tool-result', toolCallId: `outside-${position}` }] } } }
  if (position === 'before-source') {
    for (const event of events.slice(4)) {
      event.seq += 2
      if (Array.isArray(event.sourceEventSeqs)) event.sourceEventSeqs = event.sourceEventSeqs.map((seq: number) => seq + 2)
    }
    events.splice(4, 0, { ...call, seq: 4 }, { ...result, seq: 5, sourceEventSeqs: [4] })
  } else {
    events.push({ ...call, seq: 8 }, { ...result, seq: 9, sourceEventSeqs: [8] })
  }
  expect(verifiedWorkflowSourceChain(input).segments).toMatchObject([{ round: 1, steps: [] }, { round: 2, steps: [{ id: 'final' }] }])
})

test.each(['wrong-source', 'replacement'] as const)('rejects a workflow result with invalid append provenance: %s', kind => {
  const input = chainFixture(), result = (input.events as any[]).find(event => event.type === 'tool/result' && event.data.turn === 5)
  if (kind === 'wrong-source') result.sourceEventSeqs = [4]
  else result.surfaceOp = { op: 'replace', start: result.seq, end: result.seq }
  expect(() => verifiedWorkflowSourceChain(input)).toThrow(/unconfirmed/u)
})

test.each(['missing-round', 'unknown-middle', 'duplicate-call', 'max-round-drift'] as const)('rejects an invalid multi-round workflow chain: %s', kind => {
  const input = chainFixture(kind === 'duplicate-call')
  if (kind === 'missing-round') input.runs[0].intent.admission.round = 2
  if (kind === 'unknown-middle') input.runs[0].execution = { status: 'unknown', quiescent: false, completedAt: Date.now() }
  if (kind === 'max-round-drift') input.runs[0].intent.admission.maxGoalRounds = 3
  expect(() => verifiedWorkflowSourceChain(input)).toThrow()
})
