import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from './types.js'

export interface VerifiedWorkflowSource {
  protocol: 'assistant-goals/verified-workflow-source/v1'
  scope: GoalScope
  goal: { id: string; definition: { version: number; digest: string; objective: string }; sessionId: string; nativeGoalId: string }
  runId: string
  turn: number
  acceptance: { contractId: string; contractDigest: string; receiptDigest: string; verifiedAt: number; validUntil: number }
  steps: readonly { id: string; toolName: string; arguments: unknown }[]
}

export function verifiedRunId(scope: GoalScope, goalId: string, sessionId: string, turn: number): string {
  return `goal-run-${acceptanceDigest([scope, goalId, sessionId, turn])}`
}

export function successfulToolSteps(events: readonly any[], turn: number): readonly { id: string; toolName: string; arguments: unknown }[] {
  const calls = new Map<string, { id: string; toolName: string; arguments: unknown }>()
  const successful = new Set<string>()
  const failed = new Set<string>()
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.turn === turn && typeof event.data.callId === 'string'
      && typeof event.data.name === 'string') {
      if (calls.has(event.data.callId) || calls.size >= 32) throw new Error('assistant-goals: duplicate or oversized tool trace')
      calls.set(event.data.callId, { id: event.data.callId, toolName: event.data.name, arguments: parseArguments(event.data.arguments) })
    }
    if (event?.type === 'tool/result' && event.data?.turn === turn && typeof event.data?.message?.source?.callId === 'string') {
      const id = event.data.message.source.callId
      const content = event.data.message.content
      const result = Array.isArray(content) && content.length === 1 && content[0]?.type === 'tool-result' ? content[0] : undefined
      // Native errors live in the matching tool-result block, not on Message.
      if (event.data.message.isError === true || !result
        || result.toolCallId !== id || result.isError === true) failed.add(id)
      else successful.add(id)
    }
  }
  if ([...calls.keys()].some(id => !successful.has(id) || failed.has(id))) throw new Error('assistant-goals: tool trace contains an unconfirmed or failed call')
  return [...calls.values()]
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 262144) throw new Error('assistant-goals: bounded native tool arguments required')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('assistant-goals: native tool arguments must be an object')
  return parsed as Record<string, unknown>
}
