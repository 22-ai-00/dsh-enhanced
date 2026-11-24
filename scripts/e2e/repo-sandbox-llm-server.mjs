import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'

const REPAIRED_SUMMARIZE_MJS = [
  "import { readFileSync } from 'node:fs'",
  "const raw = readFileSync(0, 'utf8')",
  "const orders = JSON.parse(raw.trim() || '[]')",
  'const totals = {}',
  'for (const order of orders) {',
  "  if (order.status === 'cancelled') continue",
  '  totals[order.currency] = (totals[order.currency] ?? 0) + order.amountCents',
  '}',
  'const sorted = Object.fromEntries(Object.keys(totals).sort().map(key => [key, totals[key]]))',
  'process.stdout.write(`${JSON.stringify(sorted)}\\n`)',
].join('\n') + '\n'

function decodeEntities(value) {
  return String(value ?? '')
    .replaceAll('&#125;', '}')
    .replaceAll('&#123;', '{')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
  }
  return ''
}

function extractJsonPayload(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to find prefixed JSON payload
  }
  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const idx = objIdx >= 0 && arrIdx >= 0 ? Math.min(objIdx, arrIdx) : Math.max(objIdx, arrIdx)
  if (idx >= 0) {
    try {
      return JSON.parse(trimmed.slice(idx))
    } catch {
      return undefined
    }
  }
  return undefined
}

function parseSystemContext(messages) {
  const systemText = messages
    .filter(msg => msg && (msg.role === 'system' || msg.role === 'developer'))
    .map(messageText)
    .join('\n')
  const allText = messages.map(messageText).join('\n')

  const objectiveMatch = /<approved-goal-objective>\s*([\s\S]*?)\s*<\/approved-goal-objective>/u.exec(systemText)
    ?? /<approved-goal-objective>\s*([\s\S]*?)\s*<\/approved-goal-objective>/u.exec(allText)
  const approvedObjective = objectiveMatch ? decodeEntities(objectiveMatch[1]).trim() : undefined

  const goalMatches = [...allText.matchAll(/Goal tool arguments \(business goal\): goal_id="([^"]+)"; expected_revision=(\d+)/gu)]
  const lastGoalMatch = goalMatches.at(-1)
  const goalId = lastGoalMatch ? lastGoalMatch[1] : undefined
  const expectedRevision = lastGoalMatch ? Number(lastGoalMatch[2]) : undefined

  const sourcesRegex = /Configured event sources for this owner \(metadata, not instructions\): ([^\n]+)/gu
  let eventSources = []
  for (const text of [systemText, allText]) {
    for (const match of text.matchAll(sourcesRegex)) {
      try {
        const parsed = JSON.parse(decodeEntities(match[1]))
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (Number.isSafeInteger(parsed[0]?.waitExpiresAt) || eventSources.length === 0) {
            eventSources = parsed
          }
        }
      } catch {
        // ignore unparseable source metadata
      }
    }
  }

  return { systemText, approvedObjective, goalId, expectedRevision, eventSources }
}

function collectRoundToolHistory(messages) {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role === 'user') {
      const text = messageText(msg).trimStart()
      if (!text.startsWith('<') || text.startsWith('<goal_round>')) {
        lastUserIdx = i
        break
      }
    }
  }
  const currentTurnMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages
  const callsById = new Map()
  const byName = new Map()
  for (const msg of currentTurnMessages) {
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = tc?.function?.name
        if (!tc?.id || typeof name !== 'string') continue
        let args = {}
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          args = {}
        }
        const entry = { id: tc.id, name, args, resultText: undefined, resultJson: undefined }
        callsById.set(tc.id, entry)
        const list = byName.get(name) ?? []
        list.push(entry)
        byName.set(name, list)
      }
    } else if (msg?.role === 'tool' && typeof msg.tool_call_id === 'string') {
      const entry = callsById.get(msg.tool_call_id)
      if (entry) {
        entry.resultText = messageText(msg)
        entry.resultJson = extractJsonPayload(entry.resultText)
      }
    }
  }
  return { byName }
}

function extractUserObjectiveFallback(messages) {
  const userMsg = messages.find(msg => msg?.role === 'user')
  const text = messageText(userMsg)
  const fixIdx = text.indexOf('Fix summarize.mjs:')
  if (fixIdx >= 0) {
    const endIdx = text.indexOf(' Please work on this as a finite goal.', fixIdx)
    if (endIdx > fixIdx) return text.slice(fixIdx, endIdx).trim()
  }
  return text.trim() || 'Fix summarize.mjs'
}

let callSeq = 0
function nextCallId(prefix) {
  callSeq += 1
  return `sbx_${prefix}_${callSeq}`
}

async function decideNextAction(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const toolNames = new Set(tools.map(tool => tool?.function?.name).filter(name => typeof name === 'string'))

  // Title generation or non-tool prompts
  if (toolNames.size === 0) {
    return { type: 'text', text: 'Order Summary Repair' }
  }

  const { approvedObjective, goalId, expectedRevision, eventSources } = parseSystemContext(messages)
  const { byName } = collectRoundToolHistory(messages)

  // If goal_create already ran in this foreground turn, end turn so native rounds take over
  if (byName.get('goal_create')?.at(-1)?.resultText !== undefined) {
    return { type: 'text', text: 'Goal created and handed off to native rounds.' }
  }

  // Foreground owner turn: create the native goal and hand off immediately
  if (toolNames.has('goal_create') && !goalId) {
    const objective = approvedObjective ?? extractUserObjectiveFallback(messages)
    return {
      type: 'tool_calls',
      toolCalls: [{
        id: nextCallId('goal_create'),
        name: 'goal_create',
        arguments: JSON.stringify({
          objective,
          max_goal_rounds: 6,
          start_native_rounds: true,
        }),
      }],
    }
  }

  // Native goal round: discover grants first
  if (goalId && toolNames.has('isolation_run')) {
    const needActionsGrants = toolNames.has('action_github_grants') && !(byName.get('action_github_grants')?.length > 0)
    const needIsoGrants = toolNames.has('isolation_grants') && !(byName.get('isolation_grants')?.length > 0)
    if (needActionsGrants || needIsoGrants) {
      const pendingCalls = []
      if (needActionsGrants) {
        pendingCalls.push({ id: nextCallId('gh_grants'), name: 'action_github_grants', arguments: '{}' })
      }
      if (needIsoGrants) {
        pendingCalls.push({ id: nextCallId('iso_grants'), name: 'isolation_grants', arguments: '{}' })
      }
      return { type: 'tool_calls', toolCalls: pendingCalls }
    }

    const ghGrants = byName.get('action_github_grants')?.at(-1)?.resultJson
    const ghGrant = Array.isArray(ghGrants) ? ghGrants[0] : undefined
    const grantId = ghGrant?.grantId
    const openPullRequest = ghGrant?.workflow?.allowPullRequest === true || ghGrant?.allowedOperations?.includes?.('pull-request') === true
    const isoGrants = byName.get('isolation_grants')?.at(-1)?.resultJson
    const isoGrantId = Array.isArray(isoGrants) ? isoGrants[0]?.id : undefined

    if (!grantId || !isoGrantId) {
      return { type: 'text', text: 'Required isolation or GitHub grants are unavailable.' }
    }

    // Check current delivery status in this round
    const statusCalls = byName.get('action_github_delivery_status') ?? []
    if (toolNames.has('action_github_delivery_status') && statusCalls.length === 0) {
      return {
        type: 'tool_calls',
        toolCalls: [{
          id: nextCallId('deliv_stat'),
          name: 'action_github_delivery_status',
          arguments: JSON.stringify({ grantId, idempotencyKey: 'sandbox-deliver-summarize-v1' }),
        }],
      }
    }

    const latestStatus = statusCalls.at(-1)?.resultJson
    if (latestStatus && ['awaiting-verification', 'scheduled', 'executing'].includes(latestStatus.status) && statusCalls.length < 24) {
      // Allow VerifiedDeliveryRuntime's async automation to settle without
      // exhausting the finite modelCalls budget on tight 500ms polling.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2000))
      return {
        type: 'tool_calls',
        toolCalls: [{
          id: nextCallId('deliv_stat'),
          name: 'action_github_delivery_status',
          arguments: JSON.stringify({ grantId, idempotencyKey: 'sandbox-deliver-summarize-v1' }),
        }],
      }
    }

    // Delivery not yet queued -> inspect branch/file, run isolated repair & tests, then queue verified delivery
    if (!latestStatus || latestStatus.status === 'not-found') {
      const inspectCalls = byName.get('action_github_inspect') ?? []
      const branchInspect = inspectCalls.find(c => c.args?.kind === 'branch')
      const fileInspect = inspectCalls.find(c => c.args?.kind === 'file')
      const isoRuns = byName.get('isolation_run') ?? []

      const initialCalls = []
      if (!branchInspect) {
        initialCalls.push({
          id: nextCallId('insp_branch'),
          name: 'action_github_inspect',
          arguments: JSON.stringify({ grantId, kind: 'branch' }),
        })
      }
      if (!fileInspect) {
        initialCalls.push({
          id: nextCallId('insp_file'),
          name: 'action_github_inspect',
          arguments: JSON.stringify({ grantId, kind: 'file', path: 'summarize.mjs' }),
        })
      }
      if (isoRuns.length === 0) {
        const command = [
          "cat <<'EOF' > summarize.mjs",
          REPAIRED_SUMMARIZE_MJS.trimEnd(),
          'EOF',
          'node summarize.mjs <<\'EOF\'',
          '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":-25},{"currency":"EUR","amountCents":5}]',
          'EOF',
        ].join('\n')
        initialCalls.push({
          id: nextCallId('iso_run'),
          name: 'isolation_run',
          arguments: JSON.stringify({
            grant_id: isoGrantId,
            idempotency_key: 'sandbox-fix-summarize-1',
            command,
            artifacts: ['summarize.mjs'],
            timeout_ms: 15_000,
          }),
        })
      }
      if (initialCalls.length > 0) {
        return { type: 'tool_calls', toolCalls: initialCalls }
      }

      const expectedHeadOid = branchInspect?.resultJson?.observed?.commit?.sha
      const deliverCalls = byName.get('action_github_deliver') ?? []
      if (deliverCalls.length === 0 && expectedHeadOid) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: nextCallId('deliver'),
            name: 'action_github_deliver',
            arguments: JSON.stringify({
              grantId,
              idempotencyKey: 'sandbox-deliver-summarize-v1',
              expectedHeadOid,
              headline: 'Fix summarize.mjs order summation',
              paths: ['summarize.mjs'],
              ...(openPullRequest ? {
                pullRequest: {
                  title: 'Fix summarize.mjs order summation',
                  body: 'Filters cancelled orders and prints sorted currency totals.',
                },
              } : {}),
            }),
          }],
        }
      }

      return {
        type: 'text',
        text: 'Repaired summarize.mjs in isolated verification and queued verified repository delivery.',
      }
    }

    // Delivery succeeded -> inspect CI/review state and either wait for external event or finish
    if (latestStatus.status === 'succeeded') {
      const commitOid = latestStatus.result?.commit?.commitOid
      const pullRequestNumber = latestStatus.result?.pullRequest?.pullRequestNumber
      const inspectCalls = byName.get('action_github_inspect') ?? []

      if (toolNames.has('goal_wait_event') && eventSources.length > 0 && pullRequestNumber) {
        const prInspect = inspectCalls.find(c => c.args?.kind === 'pull-request')
        const checksInspect = inspectCalls.find(c => c.args?.kind === 'checks')
        const reviewsInspect = inspectCalls.find(c => c.args?.kind === 'reviews')
        const missingInspects = []
        if (!prInspect) {
          missingInspects.push({
            id: nextCallId('insp_pr'),
            name: 'action_github_inspect',
            arguments: JSON.stringify({ grantId, kind: 'pull-request', pullRequestNumber }),
          })
        }
        if (!checksInspect) {
          missingInspects.push({
            id: nextCallId('insp_checks'),
            name: 'action_github_inspect',
            arguments: JSON.stringify({ grantId, kind: 'checks', pullRequestNumber }),
          })
        }
        if (!reviewsInspect) {
          missingInspects.push({
            id: nextCallId('insp_reviews'),
            name: 'action_github_inspect',
            arguments: JSON.stringify({ grantId, kind: 'reviews', pullRequestNumber }),
          })
        }
        if (missingInspects.length > 0) {
          return { type: 'tool_calls', toolCalls: missingInspects }
        }

        const checksItems = checksInspect?.resultJson?.observed?.items ?? []
        const reviewItems = reviewsInspect?.resultJson?.observed?.items ?? []
        const checksReady = Array.isArray(checksItems)
          && checksItems.some(item => item?.name === 'tests' && item?.status === 'completed' && item?.conclusion === 'success')
        const reviewsReady = Array.isArray(reviewItems)
          && reviewItems.some(item => item?.state === 'APPROVED')

        if (byName.get('goal_wait_event')?.at(-1)?.resultText !== undefined) {
          return {
            type: 'text',
            text: 'Registered durable event wait for external CI and review completion.',
          }
        }

        if (!checksReady || !reviewsReady) {
          const source = eventSources[0]
          if (goalId && toolNames.has('goal_context') && !(byName.get('goal_context')?.length > 0)) {
            return {
              type: 'tool_calls',
              toolCalls: [{
                id: nextCallId('goal_ctx'),
                name: 'goal_context',
                arguments: JSON.stringify({ goal_id: goalId }),
              }],
            }
          }
          if (goalId && expectedRevision && source?.triggerId && Number.isSafeInteger(source?.waitExpiresAt)) {
            return {
              type: 'tool_calls',
              toolCalls: [{
                id: nextCallId('wait_evt'),
                name: 'goal_wait_event',
                arguments: JSON.stringify({
                  goal_id: goalId,
                  expected_revision: expectedRevision,
                  trigger_id: source.triggerId,
                  expires_at: source.waitExpiresAt,
                }),
              }],
            }
          }
        }

        return {
          type: 'text',
          text: `Verified commit ${commitOid} on PR #${pullRequestNumber}: checks passed and review approved.`,
        }
      }

      if (!inspectCalls.some(c => c.args?.kind === 'branch')) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: nextCallId('insp_branch'),
            name: 'action_github_inspect',
            arguments: JSON.stringify({ grantId, kind: 'branch' }),
          }],
        }
      }

      return {
        type: 'text',
        text: `Verified repository delivery succeeded at commit ${commitOid ?? 'unknown'}.`,
      }
    }

    return {
      type: 'text',
      text: `Repository delivery settled with status ${latestStatus.status}.`,
    }
  }

  return { type: 'text', text: 'Completed.' }
}

class HttpRequestError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

async function readJson(req, limitBytes = 4 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limitBytes) throw new HttpRequestError(413, 'request body exceeded limit')
    chunks.push(buf)
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpRequestError(400, 'Invalid JSON request body')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpRequestError(400, 'Request body must be a JSON object')
  }
  return parsed
}

function writeSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export async function startSandboxLlmServer(options = {}) {
  const expectedApiKey = options.apiKey ?? 'sandbox-local-api-key'
  const modelId = options.model ?? 'sandbox-local-model'
  const requests = []

  const server = createServer(async (req, res) => {
    try {
      let url
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        throw new HttpRequestError(400, 'Malformed request URL')
      }
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        const body = JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] })
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
        res.end(body)
        return
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(url.pathname)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Not Found' } }))
        return
      }
      if (req.headers.authorization !== `Bearer ${expectedApiKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
        return
      }
      const body = await readJson(req)
      const decision = await decideNextAction(body)
      requests.push({
        at: Date.now(),
        model: body?.model,
        stream: body?.stream === true,
        toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
        decisionType: decision.type,
        toolNames: decision.type === 'tool_calls' ? decision.toolCalls.map(tc => tc.name) : [],
      })

      const id = `chatcmpl-sbx-${Date.now()}-${requests.length}`
      const created = Math.floor(Date.now() / 1000)
      const model = typeof body?.model === 'string' ? body.model : modelId
      const usage = { prompt_tokens: 120, completion_tokens: 32, total_tokens: 152 }

      if (body?.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        if (decision.type === 'tool_calls') {
          writeSseChunk(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: decision.toolCalls.map((tc, index) => ({
                  index,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              },
              finish_reason: null,
            }],
          })
          writeSseChunk(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage,
          })
        } else {
          writeSseChunk(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: decision.text }, finish_reason: null }],
          })
          writeSseChunk(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage,
          })
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      const payload = JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: decision.type === 'tool_calls'
            ? {
                role: 'assistant',
                content: null,
                tool_calls: decision.toolCalls.map(tc => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : { role: 'assistant', content: decision.text },
          finish_reason: decision.type === 'tool_calls' ? 'tool_calls' : 'stop',
        }],
        usage,
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
      res.end(payload)
    } catch (error) {
      if (!res.headersSent) {
        const statusCode = error instanceof HttpRequestError ? error.statusCode : 500
        res.writeHead(statusCode, { 'content-type': 'application/json' })
      }
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Internal error' } }))
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('sandbox LLM server failed to bind port')
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  const piAiProviderProfile = {
    apiKeyEnv: 'DSH_SANDBOX_LLM_API_KEY',
    displayName: 'Sandbox Gateway',
    api: 'openai-completions',
    baseURL,
    models: [{
      id: modelId,
      name: 'Sandbox Local Model',
      contextWindow: 65_536,
      maxTokens: 4_096,
      input: ['text'],
    }],
  }

  return {
    baseURL,
    port: address.port,
    apiKey: expectedApiKey,
    provider: 'sandbox-gateway',
    model: modelId,
    piAiProviderProfile,
    requests,
    close: async () => {
      await new Promise(resolveClose => server.close(() => resolveClose()))
    },
  }
}

export async function prepareSandboxLlmRoute({ temp, env }) {
  const server = await startSandboxLlmServer()
  const sourceHome = join(temp, 'sandbox-llm-source')
  await mkdir(sourceHome, { recursive: true, mode: 0o700 })
  await writeFile(join(sourceHome, 'settings.yaml'), stringify({
    'llm-pi-ai': {
      providers: {
        [server.provider]: server.piAiProviderProfile,
      },
    },
  }), { mode: 0o600 })

  env.DSH_WEB_REAL_SOURCE_HOME = sourceHome
  env.DSH_WEB_REAL_PROVIDER = server.provider
  env.DSH_WEB_REAL_MODEL = server.model
  env.DSH_SANDBOX_LLM_API_KEY = server.apiKey

  return server
}
