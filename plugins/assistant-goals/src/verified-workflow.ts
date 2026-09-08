import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalExecutionRun, GoalScope, GoalRecord } from './types.js'

export interface VerifiedWorkflowSource {
  protocol: 'assistant-goals/verified-workflow-source/v1'
  scope: GoalScope
  goal: { id: string; definition: { version: number; digest: string; objective: string }; sessionId: string; nativeGoalId: string }
  runId: string
  turn: number
  acceptance: { contractId: string; contractDigest: string; receiptDigest: string; verifiedAt: number; validUntil: number }
  steps: readonly { id: string; toolName: string; arguments: unknown }[]
  failedObservations?: readonly { id: string; toolName: string; arguments: unknown; outcome: 'failed' }[]
  /** Present only when the owner bridge exports more than the final accepted native run. */
  segments?: readonly VerifiedWorkflowSegment[]
}

export interface VerifiedWorkflowSegment {
  runId: string
  turn: number
  round: number
  nativeRevision: number
  steps: readonly { id: string; toolName: string; arguments: unknown }[]
  failedObservations?: readonly { id: string; toolName: string; arguments: unknown; outcome: 'failed' }[]
}

/** Stable failure taxonomy for the owner Host bridge.  It is never model-visible. */
export class OwnerVerifiedWorkflowSourceError extends Error {
  constructor(readonly code: 'pending' | 'unknown' | 'unavailable' | 'rejected', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OwnerVerifiedWorkflowSourceError'
  }
}

export interface VerifiedWorkflowEvidence {
  scope: GoalScope
  record: GoalRecord
  run: GoalExecutionRun
  accepted: { state: string; contract: { id: string; digest: string } | null; receipt: unknown }
  events: readonly unknown[]
}

type BuiltSegment = { segment: VerifiedWorkflowSegment; calls: number; argumentBytes: number }

export function verifiedRunId(scope: GoalScope, goalId: string, sessionId: string, turn: number): string {
  return `goal-run-${acceptanceDigest([scope, goalId, sessionId, turn])}`
}

export function successfulToolSteps(events: readonly any[], turn: number): readonly { id: string; toolName: string; arguments: unknown }[] {
  const trace = verifiedToolTrace(events, turn)
  if (trace.failedObservations.length !== 0) throw new Error('assistant-goals: tool trace contains a failed call')
  return trace.steps
}

/**
 * A complete native turn trace. Failed calls are rejected except for bounded,
 * explicit read-only probes, which stay separately labelled as observations.
 */
export function verifiedToolTrace(events: readonly any[], turn: number): { steps: readonly { id: string; toolName: string; arguments: unknown }[]; failedObservations: readonly { id: string; toolName: string; arguments: unknown; outcome: 'failed' }[] } {
  const trace = verifiedToolTraceInternal(events, turn)
  return { steps: trace.steps, failedObservations: trace.failedObservations }
}

function verifiedToolTraceInternal(events: readonly any[], turn: number): { steps: readonly { id: string; toolName: string; arguments: unknown }[]; failedObservations: readonly { id: string; toolName: string; arguments: unknown; outcome: 'failed' }[]; argumentBytes: number } {
  const calls = new Map<string, { id: string; toolName: string; arguments: unknown }>()
  const results = new Map<string, 'succeeded' | 'failed'>()
  let argumentBytes = 0
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.turn === turn && typeof event.data.callId === 'string'
      && typeof event.data.name === 'string') {
      if (calls.has(event.data.callId) || calls.size >= 32) throw new Error('assistant-goals: duplicate or oversized tool trace')
      const arguments_ = parseArguments(event.data.arguments)
      argumentBytes += Buffer.byteLength(event.data.arguments, 'utf8')
      if (argumentBytes > 256 * 1024) throw new Error('assistant-goals: oversized tool trace arguments')
      calls.set(event.data.callId, { id: event.data.callId, toolName: event.data.name, arguments: arguments_ })
    }
    if (event?.type === 'tool/result' && event.data?.turn === turn && typeof event.data?.message?.source?.callId === 'string') {
      const id = event.data.message.source.callId
      const content = event.data.message.content
      const result = Array.isArray(content) && content.length === 1 && content[0]?.type === 'tool-result' ? content[0] : undefined
      // Native errors live in the matching tool-result block, not on Message.
      if (!calls.has(id) || results.has(id) || !result || result.toolCallId !== id) throw new Error('assistant-goals: tool trace contains a failed, duplicate or mismatched result')
      results.set(id, event.data.message.isError === true || result.isError === true ? 'failed' : 'succeeded')
    }
  }
  if ([...calls.keys()].some(id => !results.has(id))) throw new Error('assistant-goals: tool trace contains an unconfirmed call')
  const steps: Array<{ id: string; toolName: string; arguments: unknown }> = []
  const failedObservations: Array<{ id: string; toolName: string; arguments: unknown; outcome: 'failed' }> = []
  for (const call of calls.values()) {
    if (results.get(call.id) === 'succeeded') { steps.push(call); continue }
    if (!readOnlyProbe(call)) throw new Error('assistant-goals: tool trace contains a failed non-observation call')
    failedObservations.push({ ...call, outcome: 'failed' })
  }
  return { steps, failedObservations, argumentBytes }
}

/**
 * Builds the single Host export after both callers have established their own
 * authority and exact independent whole-goal assessment.  Keeping the raw
 * native-event checks here prevents a cold read from drifting from the live
 * owner-turn path.
 */
export function verifiedWorkflowSource(evidence: VerifiedWorkflowEvidence): VerifiedWorkflowSource {
  const { scope, record, run, accepted } = evidence
  const receipt = accepted.receipt as { objectiveStatus?: unknown; validUntil?: unknown; completedAt?: unknown; digest?: unknown } | null
  if (record.native.phase !== 'complete') throw new Error('assistant-goals: exact completed native goal is required')
  if (accepted.state !== 'done' || accepted.contract === null || receipt === null || receipt.objectiveStatus !== 'achieved'
    || !Number.isSafeInteger(receipt.validUntil) || !(typeof receipt.validUntil === 'number' && receipt.validUntil > Date.now()) || !Number.isSafeInteger(receipt.completedAt)) {
    throw new Error('assistant-goals: current accepted outcome is unavailable')
  }
  const built = workflowSegment(scope, record, run, evidence.events)
  return Object.freeze({ protocol: 'assistant-goals/verified-workflow-source/v1', scope: Object.freeze({ ...scope }),
    goal: Object.freeze({ id: record.id, definition: Object.freeze({ ...record.definition }), sessionId: record.native.sessionId, nativeGoalId: record.native.goalId }),
    runId: built.segment.runId, turn: built.segment.turn, acceptance: Object.freeze({ contractId: accepted.contract.id, contractDigest: accepted.contract.digest,
      receiptDigest: typeof receipt.digest === 'string' ? receipt.digest : acceptanceDigest(receipt), verifiedAt: receipt.completedAt as number, validUntil: receipt.validUntil as number }),
    steps: built.segment.steps, ...(built.segment.failedObservations === undefined ? {} : { failedObservations: built.segment.failedObservations }) })
}

/** Build an owner-only contiguous trace whose final run is independently achieved. */
export function verifiedWorkflowSourceChain(evidence: VerifiedWorkflowEvidence & { runs: readonly GoalExecutionRun[] }): VerifiedWorkflowSource {
  const final = verifiedWorkflowSource(evidence)
  const runs = evidence.runs.filter(run => run.intent.task.goal.id === evidence.record.id
    && run.intent.task.goal.definitionVersion === evidence.record.definition.version && run.intent.task.goal.definitionDigest === evidence.record.definition.digest
    && run.intent.task.goal.sessionId === evidence.record.native.sessionId && run.intent.task.goal.nativeGoalId === evidence.record.native.goalId)
    .sort((a, b) => a.intent.admission.round - b.intent.admission.round)
  const finalIndex = runs.findIndex(run => run.intent.runId === final.runId)
  if (finalIndex < 0 || runs.length !== finalIndex + 1 || runs.length === 0) throw new Error('assistant-goals: exact final workflow run is required')
  const maxGoalRounds = runs[0]!.intent.admission.maxGoalRounds
  if (maxGoalRounds !== evidence.record.native.maxGoalRounds || runs.some(run => run.intent.objective !== evidence.record.definition.objective || run.intent.admission.maxGoalRounds !== maxGoalRounds)) {
    throw new Error('assistant-goals: workflow semantics changed')
  }
  const built = runs.map(run => {
    if (run.execution?.status === 'unknown') throw new Error('assistant-goals: workflow execution outcome is unknown')
    if (run.execution?.status !== 'succeeded' || !run.execution.quiescent) throw new Error('assistant-goals: workflow execution is pending')
    return workflowSegment(evidence.scope, evidence.record, run, evidence.events, run.intent.runId !== final.runId)
  })
  for (let index = 0; index < built.length; index++) if (runs[index]!.intent.admission.round !== index + 1 || index > 0 && built[index - 1]!.segment.turn >= built[index]!.segment.turn) throw new Error('assistant-goals: workflow rounds are not contiguous')
  const calls = built.reduce((total, item) => total + item.calls, 0); const argumentBytes = built.reduce((total, item) => total + item.argumentBytes, 0)
  if (calls > 32 || argumentBytes > 256 * 1024) throw new Error('assistant-goals: bounded workflow trace is required')
  const ids = built.flatMap(item => [...item.segment.steps, ...(item.segment.failedObservations ?? [])].map(call => call.id))
  if (new Set(ids).size !== ids.length) throw new Error('assistant-goals: workflow call ids are not unique')
  if (built.length === 1) return final
  return Object.freeze({ ...final, segments: Object.freeze(built.map(item => item.segment)) })
}

function workflowSegment(scope: GoalScope, record: GoalRecord, run: GoalExecutionRun, rawEvents: readonly unknown[], allowEmpty = false): BuiltSegment {
  if (acceptanceDigest(run.intent.scope) !== acceptanceDigest(scope) || acceptanceDigest(record.scope) !== acceptanceDigest(scope)
    || run.execution?.status !== 'succeeded' || !run.execution.quiescent || run.intent.objective !== record.definition.objective || run.intent.task.goal.id !== record.id
    || run.intent.task.goal.definitionVersion !== record.definition.version || run.intent.task.goal.definitionDigest !== record.definition.digest
    || run.intent.task.goal.sessionId !== record.native.sessionId || run.intent.task.goal.nativeGoalId !== record.native.goalId) {
    throw new Error('assistant-goals: exact successful trigger run is required')
  }
  const events = rawEvents as readonly any[]
  const turn = events.filter(event => event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn))
    .map(event => event.data.turn as number)
    .find(value => run.intent.runId === verifiedRunId(scope, record.id, record.native.sessionId, value))
  if (turn === undefined) throw new Error('assistant-goals: trigger run has no source turn')
  const start = events.find(event => event?.type === 'turn/start' && event.data?.turn === turn)
  const end = events.find(event => event?.type === 'turn/end' && event.data?.turn === turn)
  const source = events.filter(event => event?.type === 'user/message' && start !== undefined && end !== undefined && event.seq > start.seq && event.seq < end.seq
    && event.data?.source?.kind === 'goal' && event.data.source.goalId === record.native.goalId && event.data.source.revision === run.intent.task.goal.nativeRevision
    && event.data.source.round === run.intent.admission.round)
  if (source.length !== 1) throw new Error('assistant-goals: trigger run goal source is invalid')
  if (end?.data?.reason?.kind !== 'completed') throw new Error('assistant-goals: completed source turn is required')
  const trace = verifiedToolTraceInternal(events, turn)
  if (!allowEmpty && trace.steps.length === 0 || trace.steps.length + trace.failedObservations.length > 32) {
    throw new Error('assistant-goals: bounded successful tool trace is required')
  }
  return { segment: Object.freeze({ runId: run.intent.runId, turn, round: run.intent.admission.round, nativeRevision: run.intent.task.goal.nativeRevision, steps: Object.freeze(trace.steps.map(step => Object.freeze({ ...step }))),
    ...(trace.failedObservations.length === 0 ? {} : { failedObservations: Object.freeze(trace.failedObservations.map(step => Object.freeze({ ...step }))) }) }), calls: trace.steps.length + trace.failedObservations.length, argumentBytes: trace.argumentBytes }
}

function readOnlyProbe(call: { toolName: string; arguments: unknown }): boolean {
  if (call.toolName === 'read' || call.toolName === 'glob' || call.toolName === 'grep') return true
  return call.toolName === 'get_goal' && call.arguments !== null && typeof call.arguments === 'object'
    && !Array.isArray(call.arguments) && Object.keys(call.arguments).length === 0
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 262144) throw new Error('assistant-goals: bounded native tool arguments required')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('assistant-goals: native tool arguments must be an object')
  return parsed as Record<string, unknown>
}
