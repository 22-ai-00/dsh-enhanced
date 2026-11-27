/**
 * Shared classification and trusted constant user notices for mid-turn dispatched failures.
 *
 * Safety invariants:
 * - Every code keeps `outcome: 'dead_letter'` and `retry: false` (never auto-replayed).
 * - Notices are fixed constants keyed strictly on classified failure codes; raw upstream
 *   error text, tokens, API keys, and filesystem paths never cross into outbox messages
 *   or progress events.
 */

export const CLASSIFIED_AGENT_TURN_FAILURE_CODES = [
  'agent-turn-missing-credential',
  'agent-turn-provider-aborted',
  'agent-turn-prompt-limit',
  'agent-turn-rate-limited',
  'agent-turn-runtime-failed',
] as const

export type ClassifiedAgentTurnFailureCode = typeof CLASSIFIED_AGENT_TURN_FAILURE_CODES[number]

export const INTERRUPTED_INBOX_NOTICE_FAILURE_CODES = [
  'dispatch-ambiguous',
  'agent-task-timeout',
  ...CLASSIFIED_AGENT_TURN_FAILURE_CODES,
] as const

export type InterruptedInboxNoticeFailureCode = typeof INTERRUPTED_INBOX_NOTICE_FAILURE_CODES[number]

const CLASSIFIED_AGENT_TURN_CODE_SET = new Set<string>(CLASSIFIED_AGENT_TURN_FAILURE_CODES)
const INTERRUPTED_INBOX_NOTICE_CODE_SET = new Set<string>(INTERRUPTED_INBOX_NOTICE_FAILURE_CODES)

export const interruptedTurnNotice = '这次请求在执行过程中被中断，当前已停止等待；已有操作的结果尚未确认，因此没有自动重跑。你可以继续发送消息；涉及写入的任务需要先核对现有结果。'

export const timedOutTurnNotice = '这次请求等待超时；已有操作的结果尚未确认，因此不会自动重跑。可发送 /status 查看当前会话状态，或缩小单次文件读取范围、拆分任务，也可以用 /model 切换其他模型后重试。'

const AGENT_TURN_NOTICES: Readonly<Record<ClassifiedAgentTurnFailureCode, string>> = Object.freeze({
  'agent-turn-missing-credential':
    '这次执行因缺少或失效的模型凭据（API Key / 登录态）而中断，已有操作的结果尚未确认，因此不会自动重跑。请检查模型凭据配置，或使用 /model 切换可用模型后重试；运行 /status 可查看当前会话状态。',
  'agent-turn-provider-aborted':
    '这次执行在外部运行器 / ACP 或模型流中途被中止，当前已停止等待；已有操作的结果尚未确认，因此不会自动重跑。请发送 /status 检查会话状态，使用 /model 切换模型，或核对后重新发起任务。',
  'agent-turn-prompt-limit':
    '这次执行因上下文或单次提示词体积超出模型上限而中断，已有操作的结果尚未确认，因此不会自动重跑。请缩小单次读取的文件范围或拆分任务，使用 /compact 压缩上下文或 /new 开启新会话，也可用 /model 切换到更大上下文模型。',
  'agent-turn-rate-limited':
    '这次执行因触发模型额度或频率限制而中断，已有操作的结果尚未确认，因此不会自动重跑。请稍后重试，或使用 /model 切换到其他可用模型；发送 /status 可查看当前会话状态。',
  'agent-turn-runtime-failed':
    '这次执行因模型或运行环境异常而中断，已有操作的结果尚未确认，因此不会自动重跑。请发送 /status 查看会话状态，或使用 /model 切换模型后重新发起；涉及写入的任务请先核对现有结果。',
})

export function isClassifiedAgentTurnFailureCode(
  code: string | undefined,
): code is ClassifiedAgentTurnFailureCode {
  return typeof code === 'string' && CLASSIFIED_AGENT_TURN_CODE_SET.has(code)
}

export function isNotifiableInterruptedFailureCode(
  code: string | undefined,
): code is InterruptedInboxNoticeFailureCode {
  return typeof code === 'string' && INTERRUPTED_INBOX_NOTICE_CODE_SET.has(code)
}

export function interruptedTurnNoticeForFailureCode(failureCode: string | undefined): string {
  if (failureCode === 'agent-task-timeout') return timedOutTurnNotice
  if (isClassifiedAgentTurnFailureCode(failureCode)) return AGENT_TURN_NOTICES[failureCode]
  return interruptedTurnNotice
}

interface ExtractedErrorSignal {
  readonly code?: string
  readonly name?: string
  readonly message?: string
  readonly status?: number
}

function collectErrorSignals(error: unknown, maxDepth = 5): ExtractedErrorSignal[] {
  const out: ExtractedErrorSignal[] = []
  const seen = new Set<object>()
  let current: unknown = error
  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'string') {
      out.push({ message: current })
      break
    }
    if (typeof current !== 'object') break
    if (seen.has(current)) break
    seen.add(current)
    const record = current as Record<string, unknown>
    const code = typeof record.code === 'string' ? record.code : undefined
    const name = typeof record.name === 'string' ? record.name : undefined
    const message = typeof record.message === 'string' ? record.message : undefined
    const status = typeof record.status === 'number'
      ? record.status
      : typeof record.statusCode === 'number'
        ? record.statusCode
        : undefined
    out.push({
      ...(code === undefined ? {} : { code }),
      ...(name === undefined ? {} : { name }),
      ...(message === undefined ? {} : { message }),
      ...(status === undefined ? {} : { status }),
    })
    current = record.cause
  }
  return out
}

const CREDENTIAL_CODE_SET = new Set([
  'MISSING_CREDENTIAL',
  'AUTHENTICATION_FAILED',
  'INVALID_API_KEY',
  'UNAUTHORIZED',
  'AUTH_REQUIRED',
])

const PROMPT_LIMIT_CODE_SET = new Set([
  'PROMPT_LIMIT',
  'PROMPT_TOO_LONG',
  'CONTEXT_LENGTH_EXCEEDED',
  'MAX_PROMPT_BYTES',
  'PAYLOAD_TOO_LARGE',
])

const RATE_LIMIT_CODE_SET = new Set([
  'RATE_LIMIT',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'INSUFFICIENT_QUOTA',
  'TOO_MANY_REQUESTS',
])

const PROVIDER_ABORT_CODE_SET = new Set([
  'ACP_ABORTED',
  'PROVIDER_ABORTED',
  'STREAM_ABORTED',
  'EXECUTION_ABORTED',
])

const CREDENTIAL_TEXT_RE = /\bmissing\b[^.\n]{0,80}\b(?:api[_ -]?key|credential|credentials|token|auth(?:entication)?)\b|(?:api[_ -]?key|credential|credentials|token)\b[^.\n]{0,60}\b(?:missing|absent|required|invalid|expired|unset|not\s+(?:set|found|configured))\b|invalid[_ -]?api[_ -]?key|\bunauthorized\b|authentication\s+failed|未配置[^。\n]{0,40}(?:api[_ -]?key|密钥|凭据)|缺少[^。\n]{0,40}(?:api[_ -]?key|密钥|凭据)|\b401\b/iu
const PROMPT_LIMIT_TEXT_RE = /prompt[-_ ]?limit|context[-_ ]?(?:length|window)[-_ ]?(?:exceeded|limit)|maximum\s+context|prompt\b[^.\n]{0,40}\btoo\s+(?:large|long|big)|max(?:imum)?\s+prompt\s+bytes|exceeds?\b[^.\n]{0,40}\b(?:prompt|context|request)\b[^.\n]{0,30}\b(?:limit|size|bytes|tokens)|payload\s+too\s+large|too\s+many\s+tokens|\b413\b/iu
const RATE_LIMIT_TEXT_RE = /rate[-_ ]?limit|too\s+many\s+requests|insufficient[_ -]?quota|quota[-_ ]?exceeded|credit[-_ ]?(?:exhausted|balance|limit)|requests?\s+per\s+(?:minute|second)\s+limit|\b429\b/iu
const PROVIDER_ABORT_TEXT_RE = /traex\s+acp\s+execution\s+was\s+aborted|\bacp\b[^.\n]{0,60}\babort(?:ed)?\b|\bprovider\b[^.\n]{0,60}\babort(?:ed)?\b|execution\s+was\s+aborted|stream\s+(?:was\s+)?aborted|request\s+(?:was\s+)?aborted/iu

export function classifyMidTurnFailure(input: Readonly<{
  error?: unknown
  upstreamCode?: string | undefined
  upstreamMessage?: string | undefined
  turnEndKind?: string | undefined
  userCancelled?: boolean | undefined
}>): {
  readonly code: ClassifiedAgentTurnFailureCode
  readonly matchedSpecific: boolean
} {
  const codes: string[] = []
  const texts: string[] = []
  const statuses: number[] = []
  let hasAbortName = false

  if (typeof input.upstreamCode === 'string' && input.upstreamCode.trim() !== '') {
    codes.push(input.upstreamCode.trim().toUpperCase())
  }
  if (typeof input.upstreamMessage === 'string' && input.upstreamMessage.trim() !== '') {
    texts.push(input.upstreamMessage)
  }

  for (const sig of collectErrorSignals(input.error)) {
    if (sig.code) codes.push(sig.code.trim().toUpperCase())
    if (sig.name) {
      if (sig.name === 'AbortError') hasAbortName = true
      texts.push(sig.name)
    }
    if (sig.message) texts.push(sig.message)
    if (sig.status !== undefined) statuses.push(sig.status)
  }

  const combinedText = texts.join('\n')

  if (
    codes.some(c => CREDENTIAL_CODE_SET.has(c))
    || statuses.includes(401)
    || CREDENTIAL_TEXT_RE.test(combinedText)
  ) {
    return { code: 'agent-turn-missing-credential', matchedSpecific: true }
  }

  if (
    codes.some(c => PROMPT_LIMIT_CODE_SET.has(c))
    || statuses.includes(413)
    || PROMPT_LIMIT_TEXT_RE.test(combinedText)
  ) {
    return { code: 'agent-turn-prompt-limit', matchedSpecific: true }
  }

  if (
    codes.some(c => RATE_LIMIT_CODE_SET.has(c))
    || statuses.includes(429)
    || RATE_LIMIT_TEXT_RE.test(combinedText)
  ) {
    return { code: 'agent-turn-rate-limited', matchedSpecific: true }
  }

  if (
    codes.some(c => PROVIDER_ABORT_CODE_SET.has(c))
    || (input.turnEndKind === 'aborted' && input.userCancelled !== true)
    || (hasAbortName && input.userCancelled !== true)
    || PROVIDER_ABORT_TEXT_RE.test(combinedText)
  ) {
    return { code: 'agent-turn-provider-aborted', matchedSpecific: true }
  }

  return { code: 'agent-turn-runtime-failed', matchedSpecific: false }
}
