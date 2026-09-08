import { expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { isMap, isSeq } from 'yaml'
import { isExperimentToolAllowed } from './web-owner-real-guard.mjs'
import { query, sanitize } from './web-owner-helpers.mjs'

export const objective = 'Implement summarize.mjs: read a JSON array of orders from stdin, ignore cancelled orders, sum integer amountCents by currency, and print one JSON object with sorted currency keys followed by a newline.'
export const criteria = [
  { id: 'two-currencies', stdin: '[{"currency":"USD","amountCents":100},{"currency":"EUR","amountCents":250},{"currency":"USD","amountCents":75}]\n', expectedStdout: '{"EUR":250,"USD":175}\n' },
  { id: 'cancelled-and-negative', stdin: '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":-25},{"currency":"EUR","amountCents":5}]\n', expectedStdout: '{"EUR":-20,"USD":100}\n' },
  { id: 'empty', stdin: '[]\n', expectedStdout: '{}\n' },
]
function patchRow(doc, id, name) { if (!isSeq(doc.contents)) throw new Error('profile patch is not a sequence'); let row = doc.contents.items.find(item => isMap(item) && item.get('id') === id); if (!row) { row = doc.createNode({ id, name }); doc.contents.add(row) } if (!isMap(row)) throw new Error(`invalid patch row ${id}`); return row }
export function setConfig(doc, id, name, config) {
  const row = patchRow(doc, id, name)
  if (!row.has('config')) row.set('config', doc.createNode({}))
  const destination = row.get('config', true)
  if (!isMap(destination)) throw new Error('profile config must be a mapping')
  for (const [field, value] of Object.entries(config)) destination.set(field, doc.createNode(value))
}
export function contracts(path, kind) { return query(path, 'SELECT id, payload FROM acceptance_contracts WHERE task_kind = ? ORDER BY rowid ASC', kind).map(row => ({ ...row, contract: JSON.parse(row.payload) })) }
export function jobs(path, ids) { return ids.map(id => query(path, 'SELECT state, execution, receipt, reason FROM acceptance_jobs WHERE contract_id = ?', id)[0]).map(row => ({ ...row, execution: row.execution ? JSON.parse(row.execution) : null, receipt: row.receipt ? JSON.parse(row.receipt) : null })) }
export async function waitForVerifiedGoal(page, goalsPath, verifierPath, deliveryPath, approved, frames, sessionId, workspace, options = {}) {
  const allowed = options.isToolAllowed ?? isExperimentToolAllowed
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const failure = options.failure?.()
    if (failure) throw new Error(failure)
    if (options.until?.()) return
    const failedInput = query(deliveryPath, "SELECT failure_code FROM inbox_messages WHERE status = 'dead_letter'")[0]
    if (failedInput) throw new Error(`Real-model foreground input failed: ${failedInput.failure_code}`)
    if (options.until && query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state === 'released'
      && query(deliveryPath, "SELECT status FROM inbox_messages ORDER BY received_at DESC LIMIT 1")[0]?.status === 'processed') {
      throw new Error('Owner turn ended without the requested durable event wait')
    }
    const goal = existsSync(goalsPath) ? query(goalsPath, 'SELECT * FROM goal_records')[0] : undefined
    if (goal && existsSync(verifierPath)) {
      const outcomes = contracts(verifierPath, 'goal-outcome')
      const outcomeJob = outcomes.length ? jobs(verifierPath, outcomes.map(row => row.id)).at(-1) : undefined
      const receipt = outcomeJob?.receipt
      if (JSON.parse(goal.native_json).phase === 'paused' && outcomeJob?.state === 'needs-attention') throw new Error('Native goal paused with an unresolved independent outcome; inspect the experiment evidence')
      if (receipt?.objectiveStatus === 'achieved' && JSON.parse(goal.native_json).phase === 'complete') return
    }
    const button = page.getByRole('button', { name: 'Allow once', exact: true })
    if (await button.count()) {
      const pending = new Map()
      for (const frame of frames) {
        const value = frame.type === 'item' ? frame.value : undefined
        if (value?.type === 'waterfall' && value.event === 'approval/request') pending.set(value.eventId, value)
        if (value?.type === 'cancel') pending.delete(value.eventId)
      }
      const requests = [...pending.values()].filter(value => ![...approved, ...(options.rejected ?? [])].some(item => item.eventId === value.eventId))
      if (requests.length === 0) { await button.waitFor({ state: 'hidden', timeout: 1_000 }).catch(() => {}); continue }
      const request = requests[0]
      // Approval and Session-follow streams are independent. Wait for the
      // exact call evidence before validating or clicking its approval.
      await expect.poll(() => frames.some(frame => frame.value?.type === 'event'
        && frame.value.event?.type === 'tool/call'
        && frame.value.event.data.callId === request.request?.callId), { timeout: 5_000 }).toBe(true)
      const calls = frames.flatMap(frame => frame.value?.type === 'event' && frame.value.event?.type === 'tool/call' ? [frame.value.event.data] : [])
      const call = calls.findLast(item => item.callId === request.request?.callId)
      let args
      try { args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments } catch {}
      if (requests.length === 1 && request.agentId === sessionId && call?.name === request.request?.toolName
        && !allowed(call.name, args, workspace) && options.rejected) {
        if (options.rejected.length >= 3) throw new Error('Too many rejected tools in real-model experiment')
        options.rejected.push({ eventId: request.eventId, toolName: call.name, callId: call.callId })
        await page.getByRole('button', { name: 'Reject', exact: true }).click()
        continue
      }
      if (requests.length !== 1 || request.agentId !== sessionId || call?.name !== request.request?.toolName
        || !allowed(call.name, args, workspace)) {
        throw new Error(`unexpected approval request: ${sanitize(JSON.stringify(request)).slice(0, 500)}`)
      }
      if (approved.length >= 20) throw new Error('Too many approvals in real-model experiment')
      approved.push({ eventId: request.eventId, agentId: request.agentId, toolName: request.request.toolName, callId: request.request.callId })
      await button.click()
    } else {
      await button.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {})
    }
  }
  throw new Error('Independent whole-goal verification did not complete within the experiment deadline')
}
