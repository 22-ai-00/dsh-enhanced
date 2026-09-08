import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const objective = 'Implement summarize.mjs: read a JSON array of orders from stdin, ignore cancelled orders, sum integer amountCents by currency, and print one JSON object with sorted currency keys followed by a newline.'

function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('workspace must be a non-empty path')
  let readable = ''; let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index); const value = cwd[index]
    if (value === '/' || value === '\\' || value === ':') { if (!separatorRun) readable += '-'; separatorRun = true; continue }
    separatorRun = false
    readable += /^[A-Za-z0-9._-]$/u.test(value) ? value : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
function compact(event) {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
  if (event.type === 'tool/call') {
    let argumentsValue = data.arguments && typeof data.arguments === 'object' ? data.arguments : {}
    if (typeof data.arguments === 'string') try { argumentsValue = JSON.parse(data.arguments) } catch { return null }
    const selected = data.name === 'goal_create' && argumentsValue.objective === objective ? { objective, max_goal_rounds: argumentsValue.max_goal_rounds, start_native_rounds: argumentsValue.start_native_rounds }
      : data.name === 'goal_wait_event' ? { goal_id: argumentsValue.goal_id, expected_revision: argumentsValue.expected_revision, trigger_id: argumentsValue.trigger_id, expires_at: argumentsValue.expires_at }
        : { file_path: argumentsValue.file_path }
    return { seq: event.seq, type: event.type, data: { turn: data.turn, callId: data.callId, name: data.name, arguments: selected } }
  }
  if (event.type === 'turn/start') return { seq: event.seq, type: event.type, data: { turn: data.turn } }
  if (event.type === 'user/message' && data.source?.kind === 'goal') return { seq: event.seq, type: event.type,
    data: { source: { kind: 'goal', round: data.source.round } } }
  if (event.type === 'approval/asked' || event.type === 'approval/decided') return { seq: event.seq, type: event.type, data: { id: data.id, callId: data.callId, toolName: data.toolName, outcome: data.outcome } }
  if (event.type.startsWith('goal/')) return { seq: event.seq, type: event.type, data: Object.fromEntries(Object.entries(data).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))) }
  if (['permission/preset', 'sandbox/mode', 'approval/policy', 'assistant-policy/approval-reviewer'].includes(event.type)) return { seq: event.seq, type: event.type, data: event.type === 'permission/preset' ? { preset: data.preset } : event.type === 'sandbox/mode' ? { mode: data.mode } : event.type === 'approval/policy' ? { policy: data.policy } : { reviewer: data.reviewer } }
  return null
}

/** Read the bounded synthetic Web test session: selected tool metadata and assistant replies. */
export async function readSessionAudit(home, workspace, sessionId) {
  if (typeof home !== 'string' || typeof sessionId !== 'string' || !/^[A-Za-z0-9-]+$/u.test(sessionId)) throw new Error('home and sessionId are invalid')
  const path = join(home, 'sessions', projectKey(workspace), sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`, 'session.jsonl.zstd')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('session artifact is not a bounded regular file')
  const { stdout } = await exec('zstd', ['-q', '-dc', '--', path], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const policy = await import(pathToFileURL(join(home, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'assistant-policy', 'lib', 'index.js')).href)
  const selected = events.map(compact).filter(Boolean)
  const assistantReplies = events.filter(event => event.type === 'assistant/message').map(event => ({
    seq: event.seq, turn: event.data.turn, text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
  }))
  return Object.freeze({ sessionId, assistantReplies, projectKey: projectKey(workspace), reviewer: policy.approvalReviewerOf(events), events: selected })
}
