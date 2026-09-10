import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual, promisify } from 'node:util'
import { isMap, isSeq, parseDocument } from 'yaml'
import { acceptanceDigest, validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '../../packages/task-acceptance-contract/lib/index.js'
import { fileObservationSteps, instantiate } from '../../plugins/assistant-skills/lib/definition.js'
import { prospectiveGeneratorDigest } from '../../plugins/assistant-skills/lib/prospective-holdout.js'
import { assertPublicCanaryStatus, canaryPolicy, createProspectiveCanaryAuthority, runtimeCanaryAdmission, templateCanaryApproval, templateCanaryMaterializedSources, templateFailureCandidatePayload, templateRenderCanaryTask } from './real-canary-helpers.mjs'
import { contracts, jobs, setConfig } from './web-owner-real-helpers.mjs'
import { selectRestoredSession } from './repo-session-navigation.mjs'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const task = templateRenderCanaryTask
const exec = promisify(execFile)

function projectKey(cwd) {
  let readable = '', separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index), value = cwd[index]
    if (value === '/' || value === '\\' || value === ':') { if (!separatorRun) readable += '-'; separatorRun = true; continue }
    separatorRun = false
    readable += /^[A-Za-z0-9._-]$/u.test(value) ? value : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

async function sessionEvents(home, workspace, sessionId) {
  const path = join(home, 'sessions', projectKey(workspace), sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`, 'session.jsonl.zstd')
  const info = await lstat(path)
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('canary Session artifact is not a bounded regular file')
  const { stdout } = await exec('zstd', ['-q', '-dc', '--', path], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function toolResult(events, callId, name, args) {
  const calls = events.filter(event => event.type === 'tool/call' && event.data?.callId === callId && event.data.name === name)
  if (calls.length !== 1) throw new Error(`missing exact ${name} Session call`)
  const callArgs = typeof calls[0].data.arguments === 'string' ? JSON.parse(calls[0].data.arguments) : calls[0].data.arguments
  if (acceptanceDigest(callArgs) !== acceptanceDigest(args)) throw new Error(`${name} Session call arguments changed`)
  const results = events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append'
    && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length === 1 && event.sourceEventSeqs[0] === calls[0].seq
    && event.data?.message?.source?.callId === callId)
  if (results.length !== 1) throw new Error(`missing exact ${name} Session result`)
  const block = results[0].data.message.content
  if (results[0].seq <= calls[0].seq || results[0].data.turn !== calls[0].data.turn || results[0].data.step !== calls[0].data.step
    || results[0].data.error !== undefined || results[0].data.message?.source?.kind !== 'tool' || results[0].data.message.isError === true
    || !Array.isArray(block) || block.length !== 1 || block[0]?.type !== 'tool-result' || block[0].toolCallId !== callId
    || block[0].isError === true || !Array.isArray(block[0].content) || block[0].content.length !== 1
    || block[0].content[0]?.type !== 'text' || typeof block[0].content[0].text !== 'string') throw new Error(`${name} Session result failed or changed shape`)
  const text = block[0].content[0].text
  if (!text) throw new Error(`${name} Session result has no JSON text`)
  return JSON.parse(text)
}

function runTraceDigest(events, scope, goal, run, execution, profile) {
  const turns = events.filter(event => event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)
    && run.goalExecutionRunId === `goal-run-${acceptanceDigest([scope, goal.id, goal.native.sessionId, event.data.turn])}`)
  if (turns.length !== 1) throw new Error(`run ${run.id} has no unique source turn`)
  const turn = turns[0].data.turn
  const starts = events.filter(event => event.type === 'turn/start' && event.data?.turn === turn && Number.isSafeInteger(event.seq))
  const ends = events.filter(event => event.type === 'turn/end' && event.data?.turn === turn && Number.isSafeInteger(event.seq))
  if (starts.length !== 1 || ends.length !== 1 || ends[0].seq <= starts[0].seq || ends[0].data?.reason?.kind !== 'completed') throw new Error(`run ${run.id} source turn is incomplete`)
  const sources = events.filter(event => event.type === 'user/message' && Number.isSafeInteger(event.seq) && event.seq > starts[0].seq && event.seq < ends[0].seq
    && event.data?.source?.kind === 'goal' && event.data.source.goalId === goal.native.goalId
    && event.data.source.revision === execution.task.goal.nativeRevision && event.data.source.round === execution.admission.round)
  if (sources.length !== 1) throw new Error(`run ${run.id} has no unique Goal source`)
  const calls = events.filter(event => event.type === 'tool/call' && Number.isSafeInteger(event.seq) && event.seq > starts[0].seq && event.seq < ends[0].seq
    && event.data?.turn === turn).map(event => ({ id: event.data.callId, name: event.data.name, arguments: JSON.parse(event.data.arguments), seq: event.seq }))
  if (calls.length < 1 || calls.length > 32 || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error(`run ${run.id} has an invalid call set`)
  const steps = calls.sort((left, right) => left.seq - right.seq).map(call => {
    const results = events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append' && event.seq > call.seq && event.seq < ends[0].seq
      && event.data?.turn === turn && event.data.message?.source?.callId === call.id && Array.isArray(event.sourceEventSeqs)
      && event.sourceEventSeqs.length === 1 && event.sourceEventSeqs[0] === call.seq)
    if (results.length !== 1) throw new Error(`run ${run.id} has no unique result for ${call.id}`)
    const block = results[0].data.message.content
    if (!Array.isArray(block) || block.length !== 1 || block[0]?.type !== 'tool-result' || block[0].toolCallId !== call.id) throw new Error(`run ${run.id} has an invalid result for ${call.id}`)
    return { id: call.id, name: call.name, arguments: call.arguments, outcome: results[0].data.message.isError === true || block[0].isError === true ? 'failed' : 'succeeded' }
  })
  const payload = { protocol: 'assistant-goals/owner-run-trace/v1', runId: run.goalExecutionRunId, turn, nativeRevision: execution.task.goal.nativeRevision,
    definitionDigest: goal.definition.digest, outcomeProfile: profile, steps }
  return acceptanceDigest(payload)
}

async function sourceHashes() {
  const harness = [
    'scripts/e2e/web-owner-real-canary.spec.mjs', 'scripts/e2e/web-owner-real-canary-guard.mjs', 'scripts/e2e/real-canary-helpers.mjs', 'scripts/e2e/playwright-real-canary.config.mjs',
    'scripts/e2e/web-owner-real-helpers.mjs', 'scripts/e2e/web-owner-real-route.mjs', 'scripts/e2e/web-owner-helpers.mjs', 'scripts/e2e/repo-session-navigation.mjs',
  ]
  const packages = ['plugins/personal-assistant', 'plugins/plugin-control-plane', 'plugins/assistant-delivery', 'plugins/assistant-goals', 'plugins/assistant-skills', 'plugins/assistant-isolation', 'plugins/assistant-web-owner', 'plugins/assistant-verifier', 'plugins/assistant-evaluation', 'plugins/traex-acp-provider', 'packages/task-acceptance-contract']
  const files = [...harness]
  for (const directory of packages) {
    for (const name of ['package.json', 'cordis.patch.yml']) if (existsSync(join(root, directory, name))) files.push(`${directory}/${name}`)
    const lib = join(root, directory, 'lib')
    for (const entry of await readdir(lib, { recursive: true, withFileTypes: true })) if (entry.isFile()) files.push(`${directory}/lib/${entry.parentPath.slice(lib.length + 1)}${entry.parentPath === lib ? '' : '/'}${entry.name}`.replace('/lib//', '/lib/'))
  }
  files.sort()
  return Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
}

function exactKeys(value, required, optional = []) {
  expect(value).not.toBeNull()
  expect(Array.isArray(value)).toBe(false)
  expect(Object.keys(value).sort()).toEqual([...required, ...optional.filter(key => Object.hasOwn(value, key))].sort())
}

function completeRows(path, table, order) {
  const columns = query(path, `PRAGMA table_info(${table})`).map(item => item.name)
  if (columns.length === 0 || columns.some(column => typeof column !== 'string' || !/^[a-z_][a-z0-9_]*$/u.test(column))) throw new Error(`missing expected table ${table}`)
  const quoted = columns.map(column => `"${column}"`).join(',')
  return query(path, `SELECT ${quoted} FROM ${table} ORDER BY ${order ?? quoted}`)
}

function databaseSnapshot(path) {
  const tables = query(path, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(item => item.name)
  return Object.fromEntries(tables.map(table => [table, completeRows(path, table)]))
}

function row(doc, id) {
  const value = doc.contents.items.find(item => isMap(item) && item.get('id') === id)
  if (!value || !isMap(value)) throw new Error(`missing profile row ${id}`)
  return value
}

function appendPolicy(doc, rules) {
  const config = row(doc, 'dsh-enhanced-personal-assistant').get('config', true)
  if (!isMap(config) || !isMap(config.get('assistantPolicy', true))) throw new Error('missing personal-assistant policy config')
  const policy = config.get('assistantPolicy', true); let list = policy.get('rules', true)
  if (list === undefined) { list = doc.createNode([]); policy.set('rules', list) }
  if (!isSeq(list)) throw new Error('assistant policy rules must be a list')
  for (const rule of rules) list.add(doc.createNode(rule))
}

function parsedRows(path, table, column) {
  return query(path, `SELECT ${column} FROM ${table} ORDER BY id`).map(item => JSON.parse(item[column]))
}

function outcome(verifierPath, goalId) {
  const matches = contracts(verifierPath, 'goal-outcome').filter(item => item.contract.task.goal?.id === goalId)
  if (matches.length !== 1) return
  const [job] = jobs(verifierPath, [matches[0].id])
  return { contract: matches[0], job }
}

function toolCalls(frames, sessionId) {
  return frames.flatMap(frame => frame.value?.type === 'event' && frame.value.event?.type === 'tool/call'
    && (!sessionId || frame.value.event.data.sessionId === undefined || frame.value.event.data.sessionId === sessionId) ? [frame.value.event.data] : [])
}

test('real TraeX grows template-render from failure, promotes it, and rolls it back causally', async ({ page, context }, testInfo) => {
  test.setTimeout(900_000)
  const temp = await mkdtemp(join(tmpdir(), 'dsh-real-template-canary-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), modelLog = join(temp, 'model.jsonl'), controlPath = join(temp, 'control.json')
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_WEB_REAL_PROVIDER: process.env.DSH_WEB_REAL_PROVIDER ?? 'traex-agent',
    DSH_WEB_REAL_MODEL: process.env.DSH_WEB_REAL_MODEL ?? 'default', DSH_WEB_REAL_LOG: modelLog, DSH_WEB_REAL_WORKSPACE: workspace,
    DSH_REAL_CANARY_CONTROL_PATH: controlPath, DSH_REAL_CANARY_MAX_CALLS: '48', DSH_REAL_CANARY_DURATION_MS: '600000' }
  if (env.DSH_WEB_REAL_PROVIDER !== 'traex-agent') throw new Error('real template canary requires DSH_WEB_REAL_PROVIDER=traex-agent; Codex fallback is forbidden')
  if (!/^sha256:[a-f0-9]{64}$/u.test(process.env.DSH_HOLDOUT_TEST_IMAGE ?? '')) throw new Error('DSH_HOLDOUT_TEST_IMAGE must pin the installed authority image')
  const executedSourceHashes = await sourceHashes()
  const deliveryPath = join(home, 'assistant-delivery/state.sqlite'), goalsPath = join(home, 'assistant-goals/web.sqlite')
  const verifierPath = join(home, 'assistant-verifier/verification.sqlite'), skillsPath = join(home, 'assistant-skills/skills.sqlite')
  const http = [], frames = [], transport = [], streams = new Map(), contexts = [], approvals = [], rejected = []
  let host, activePage = page, starts = 0, failed = false, activeSession, workspaceId, patch, patchPath, owner, route
  const setControl = async (phase, sessionId, expectedCalls = []) => {
    activeSession = sessionId
    await writeFile(controlPath, JSON.stringify({ phase, sessionId, expectedCalls: expectedCalls.map(call => ({ toolName: call.toolName, arguments: call.arguments })) }), { mode: 0o600 })
  }
  const stop = async () => {
    if (!host) return
    await host.stop()
    await writeFile(testInfo.outputPath(`host-${starts}.log`), host.log(), { mode: 0o600 })
    host = undefined
  }
  const open = async fresh => {
    host = await startHost(env); starts++
    if (fresh) { const next = await context.browser().newContext(); contexts.push(next); activePage = await next.newPage() }
    observePage(activePage, http, transport, streams, frames)
    await activePage.goto(host.url).catch(() => { throw new Error('canary browser authentication failed (URL redacted)') })
    await expect(activePage).toHaveURL(`${new URL(host.url).origin}/`)
    if (starts === 1) await activePage.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
  }
  const createSession = async () => {
    const previous = new Set(query(deliveryPath, 'SELECT session_id FROM conversation_bindings').map(item => item.session_id))
    if (typeof workspaceId !== 'string') throw new Error('initial Web workspace identity is unavailable')
    const rpcId = randomUUID()
    const request = await activePage.evaluate(({ rpcId, workspaceId }) => fetch('/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/create', payload: { args: { request: { workspaceId } } } }) }).then(async response => ({ status: response.status, body: await response.json() })), { rpcId, workspaceId })
    const response = request
    expect(response.status).toBe(200)
    const result = response.body
    expect(result.result.ok).toBe(true)
    const sessionId = result.result.value.sessionId
    expect(previous.has(sessionId)).toBe(false)
    await expect.poll(() => query(deliveryPath, 'SELECT session_id FROM conversation_bindings WHERE session_id = ?', sessionId).length).toBe(1)
    await activePage.evaluate(id => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })), sessionId)
    await activePage.reload()
    await expect(activePage.getByRole('treeitem', { name: 'New Session', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => transport.some(item => item.kind === 'sent' && item.frame?.type === 'open'
      && item.frame.endpoint === 'session/follow' && item.frame.payload?.args?.request?.address?.kind === 'session'
      && item.frame.payload.args.request.address.sessionId === sessionId), { message: `session ${sessionId} selected and followed` }).toBe(true)
    await expect(activePage.getByLabel(/Describe what you want to build|Message or run a task/)).toBeVisible()
    activeSession = sessionId
    return sessionId
  }
  const prompt = async text => {
    if (activeSession === undefined) throw new Error('active canary session is unavailable')
    const rpcId = randomUUID(), requestId = randomUUID()
    const direct = await activePage.evaluate(({ rpcId, requestId, sessionId, text }) => fetch('/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/prompt', payload: { args: { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'UTC' } } } }) }).then(async response => ({ status: response.status, body: await response.json() })), { rpcId, requestId, sessionId: activeSession, text })
    expect(direct.status).toBe(200)
    expect(direct.body.result.ok).toBe(true)
  }
  const approve = async () => {
    const allow = activePage.getByRole('button', { name: 'Allow once', exact: true })
    const reject = activePage.getByRole('button', { name: 'Reject', exact: true })
    if (!await allow.isVisible().catch(() => false) && !await reject.isVisible().catch(() => false)) return false
    const pending = new Map()
    for (const frame of frames) {
      const value = frame.value
      if (value?.type === 'waterfall' && value.event === 'approval/request') pending.set(value.eventId, value)
      if (value?.type === 'cancel') pending.delete(value.eventId)
    }
    const request = [...pending.values()].find(value => !approvals.some(item => item.eventId === value.eventId) && !rejected.some(item => item.eventId === value.eventId))
    if (!request) return false
    await expect.poll(() => {
      if (toolCalls(frames).some(call => call.callId === request.request?.callId)) return true
      const match = /^(.*):skill(-observation)?:([1-9][0-9]*)$/u.exec(request.request?.callId ?? '')
      return !!match && toolCalls(frames).some(call => call.callId === match[1] && call.name === 'skill_run')
    }, { timeout: 5000 }).toBe(true)
    let call = toolCalls(frames).findLast(item => item.callId === request.request.callId)
    if (!call) {
      const match = /^(.*):skill(-observation)?:([1-9][0-9]*)$/u.exec(request.request.callId ?? '')
      const parent = match && toolCalls(frames).findLast(item => item.callId === match[1] && item.name === 'skill_run')
      if (!parent) throw new Error('approval has no matching direct call or skill parent')
      const args = JSON.parse(parent.arguments), runs = parsedRows(skillsPath, 'skill_runs', 'run_json')
      const active = runs.filter(item => item.state === 'running' && item.sessionId === activeSession && item.goalId === args.goal_id
        && item.skillName === args.name && item.version === args.version && item.invocationId === args.invocation_id)
      if (active.length !== 1 || acceptanceDigest(active[0].inputs) !== acceptanceDigest(JSON.parse(args.inputs_json ?? '{}'))) throw new Error('nested approval does not identify one exact run')
      const stored = query(skillsPath, 'SELECT definition_json FROM skill_definitions WHERE name=? AND version=?', args.name, args.version)[0]
      if (!stored) throw new Error('nested approval definition is unavailable')
      const definition = instantiate(JSON.parse(stored.definition_json), active[0].inputs)
      const savedStep = definition.steps[Number(match[3]) - 1]
      const observation = match[2] && savedStep && fileObservationSteps(definition).find(item => item.beforeStepId === savedStep.id)
      const step = match[2] ? observation && { toolName: 'read', arguments: { file_path: observation.filePath, limit: 1 } } : savedStep
      if (!step || step.toolName !== request.request.toolName) throw new Error('nested approval does not match the stored run step')
      call = { callId: request.request.callId, name: step.toolName, arguments: JSON.stringify(step.arguments) }
    }
    if (request.agentId !== activeSession || call.name !== request.request.toolName) throw new Error('approval does not match the controlled session call')
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    if (call.name === 'bash') { rejected.push({ eventId: request.eventId, callId: call.callId, toolName: call.name }); await reject.click(); return true }
    const control = JSON.parse(await readFile(controlPath, 'utf8'))
    const fileAllowed = templateCanaryApproval(call.name, args, workspace) === 'allow'
    const controlAllowed = control.expectedCalls?.some(item => item.toolName === call.name && acceptanceDigest(item.arguments) === acceptanceDigest(args))
    const nativeRunAllowed = call.name === 'skill_run' && ({ 'failure-create': 1, 'repair-create': 1, 'promotion-create': 2, 'negative-create': 2 })[control.phase] === args.version
      && args.name === task.skillName && typeof args.goal_id === 'string' && args.inputs_json !== undefined && typeof args.invocation_id === 'string'
    if (!fileAllowed && !controlAllowed && !nativeRunAllowed) throw new Error(`approval escaped the exact canary control: ${call.name}`)
    approvals.push({ eventId: request.eventId, callId: call.callId, toolName: call.name }); await allow.click(); return true
  }
  const idle = sessionId => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state === 'released'
  const wait = async (predicate, description, sessionId = activeSession) => {
    await expect.poll(async () => {
      const dead = query(deliveryPath, "SELECT failure_code FROM inbox_messages WHERE status = 'dead_letter' ORDER BY received_at DESC LIMIT 1")[0]
      if (dead) throw new Error(`canary owner input failed: ${dead.failure_code}`)
      await approve()
      return await predicate() && idle(sessionId)
    }, { message: description, timeout: 300_000, intervals: [200, 500, 1000] }).toBeTruthy()
  }
  const createGoal = async (phase, sessionId, objective, label, nativeInstruction) => {
    const before = new Set(query(goalsPath, 'SELECT id FROM goal_records').map(item => item.id))
    const args = { objective, max_goal_rounds: 1, start_native_rounds: true }
    await setControl(phase, sessionId, [{ toolName: 'goal_create', arguments: args }])
    await prompt(`CANARY ${label}: Create one finite Goal with objective exactly: '${objective}' Use goal_create with max_goal_rounds 1 and start_native_rounds true. Do not perform the artifact work in this foreground turn. In the subsequent native Goal round: ${nativeInstruction}`)
    await wait(() => query(goalsPath, 'SELECT id FROM goal_records').some(item => !before.has(item.id)), `${label} goal creation`, sessionId)
    return query(goalsPath, 'SELECT id FROM goal_records').find(item => !before.has(item.id)).id
  }
  const waitOutcome = async (goalId, status, label, sessionId = activeSession) => {
    await wait(() => outcome(verifierPath, goalId)?.job?.receipt?.objectiveStatus === status, label, sessionId)
    return outcome(verifierPath, goalId)
  }
  const exactRun = (goalId, expected) => {
    const matches = parsedRows(skillsPath, 'skill_runs', 'run_json').filter(item => item.goalId === goalId)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject(expected)
    expect(matches[0].goalExecutionRunId).toMatch(/^goal-run-[a-f0-9]{64}$/u)
    expect(matches[0].goalDefinitionDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(matches[0].nativeGoalId).toBeTruthy()
    return matches[0]
  }
  const goalEvidence = (goalId, skillRun, expectedStatus, family) => {
    const rows = query(goalsPath, 'SELECT * FROM goal_records WHERE id=?', goalId)
    expect(rows).toHaveLength(1)
    const stored = { ...rows[0], scope: JSON.parse(rows[0].scope_json), definition: JSON.parse(rows[0].definition_json), native: JSON.parse(rows[0].native_json) }
    expect(skillRun).toMatchObject({ goalId, sessionId: stored.native.sessionId, goalDefinitionDigest: stored.definition.digest, nativeGoalId: stored.native.goalId, state: 'succeeded' })
    const executionRows = query(`${goalsPath}.executions`, 'SELECT * FROM goal_execution_runs WHERE run_id=?', skillRun.goalExecutionRunId)
    expect(executionRows).toHaveLength(1)
    const intent = JSON.parse(executionRows[0].intent_json)
    const execution = JSON.parse(executionRows[0].execution_json)
    expect(intent).toMatchObject({ runId: skillRun.goalExecutionRunId, scope: stored.scope, task: { kind: 'goal-step', ref: skillRun.goalExecutionRunId, goal: { id: goalId, definitionVersion: stored.definition.version, definitionDigest: stored.definition.digest, sessionId: stored.native.sessionId, nativeGoalId: stored.native.goalId } } })
    expect(execution).toMatchObject({ status: 'succeeded', quiescent: true })
    const verified = outcome(verifierPath, goalId)
    expect(verified).toBeTruthy()
    expect(verified.job.state).toBe('done')
    const contract = validateTaskAcceptanceContract(verified.contract.contract)
    const receipt = validateTaskVerificationReceipt(contract, verified.job.receipt)
    expect(contract.task).toMatchObject({ kind: 'goal-outcome', goal: { id: goalId, definitionVersion: stored.definition.version, definitionDigest: stored.definition.digest, sessionId: stored.native.sessionId, nativeGoalId: stored.native.goalId } })
    expect(contract.profile).toEqual(family.outcomeProfile)
    expect(receipt).toMatchObject({ contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task, objectiveStatus: expectedStatus })
    expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/u)
    const receiptRows = query(verifierPath, 'SELECT contract_id,payload,digest FROM acceptance_receipts WHERE id=?', receipt.id)
    expect(receiptRows).toHaveLength(1)
    expect(receiptRows[0]).toMatchObject({ contract_id: contract.id, digest: receipt.digest })
    expect(JSON.parse(receiptRows[0].payload)).toEqual(receipt)
    return { stored, intent, execution, contract, receipt }
  }
  const readStatus = async (name, args, instruction) => {
    const start = frames.length
    await setControl('readback', activeSession, [{ toolName: name, arguments: args }])
    await prompt(instruction)
    await wait(() => toolCalls(frames.slice(start), activeSession).some(call => call.name === name
      && acceptanceDigest(typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments) === acceptanceDigest(args)), `${name} readback`, activeSession)
    const calls = toolCalls(frames.slice(start), activeSession).filter(call => call.name === name
      && acceptanceDigest(typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments) === acceptanceDigest(args))
    expect(calls.length).toBeGreaterThan(0)
    return calls.map(call => call.callId)
  }
  const resetArtifact = source => writeFile(join(workspace, task.artifactPath), source, { mode: 0o600 })
  try {
    await mkdir(workspace)
    route = await prepareRealRoute({ env, home, workspace })
    if (route.provider !== 'traex-agent' || route.proof.api !== 'acp') throw new Error('real canary did not select the TraeX ACP route')
    env.DSH_WEB_REAL_PROVIDER = route.provider; env.DSH_WEB_REAL_MODEL = route.model
    const installed = await run('dsh', ['plugin', '--profile', 'web', 'add', ...['personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-skills', 'assistant-isolation', 'assistant-web-owner', 'assistant-verifier', 'assistant-evaluation', ...route.bundles].map(name => resolve(root, 'plugins', name))], env)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace], env)
    owner = query(deliveryPath, "SELECT id,version FROM delivery_principals WHERE role='owner' AND status='active'")[0]
    const { createVerifierAuthorities } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-verifier/lib/index.js')).href)
    const authority = { kind: 'runner', id: 'node', executable: process.execPath, fixedArgs: [], timeoutMs: 5000, maxOutputBytes: 16384 }
    const [runner] = createVerifierAuthorities({ authorities: [authority] })
    const profile = (kind, objective, criteria) => ({ id: `template-${kind}-${acceptanceDigest({ objective }).slice(0, 12)}`, version: 1, scope: { workspace, preset: 'standard' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, taskKind: kind, objective, validityMs: 600000, bounds: { maxDurationMs: 15000, maxEvidenceBytes: 16384 }, criteria: (kind === 'goal-step' ? criteria.slice(0, 1) : criteria).map(entry => ({ id: entry.id, kind: 'process-behavior', authority: { id: runner.id, digest: runner.digest }, artifactPath: task.artifactPath, stdin: entry.stdin, expectedStdout: entry.expectedStdout, expectedExitCode: 0 })) })
    patchPath = join(home, 'profiles/web/cordis.patch.yml'); patch = parseDocument(await readFile(patchPath, 'utf8'))
    setConfig(patch, 'dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', { databasePath: goalsPath, preauthorizedCreateMaxRounds: 3, verifyNativeRounds: true, verifyGoalOutcome: true, stepMaxDurationMs: 120000, executionBudget: { mode: 'calls', modelCalls: 8, toolCalls: 12, durationMs: 300000, maxOutputTokensPerCall: 4096, routes: [{ provider: route.provider, model: route.model }] } })
    setConfig(patch, 'dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', { databasePath: skillsPath, allowedTools: task.authorizedTools, maxDurationMs: 60000 })
    setConfig(patch, 'dsh-enhanced-assistant-isolation', '@dsh-enhanced/assistant-isolation', { stateRoot: join(home, 'assistant-isolation') })
    setConfig(patch, 'dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', { databasePath: verifierPath, tickIntervalMs: 500, requireAcceptance: false, authorities: [authority], profiles: [profile('goal-step', task.legacyObjective, task.legacyCriteria), profile('goal-outcome', task.legacyObjective, task.legacyCriteria), profile('goal-step', task.strictObjective, task.strictCriteria), profile('goal-outcome', task.strictObjective, task.strictCriteria)] })
    setConfig(patch, 'dsh-enhanced-assistant-web-owner', '@dsh-enhanced/assistant-web-owner', { maxExecutionMs: 300000 })
    appendPolicy(patch, [
      { id: 'template-workflow-owner', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['inspect', 'save', 'draft', 'run'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['external'] } },
      ...canaryPolicy(workspace),
    ])
    route.configurePatch(patch, setConfig)
    patch.contents.add(patch.createNode({ id: 'session-title-llm', disabled: true }))
    patch.contents.add(patch.createNode({ insert: [{ id: 'real-template-canary-guard', name: resolve(root, 'scripts/e2e/web-owner-real-canary-guard.mjs') }] }))
    await setControl('readback', undefined, [])
    await writeFile(patchPath, String(patch), { mode: 0o600 }); await open(false)
    await expect.poll(() => http.find(item => new URL(item.url()).pathname === '/api/session/create')).toBeTruthy()
    await expect.poll(() => query(deliveryPath, 'SELECT session_id FROM conversation_bindings ORDER BY created_at LIMIT 1')[0]?.session_id).toBeTruthy()
    const baselineSession = query(deliveryPath, 'SELECT session_id FROM conversation_bindings ORDER BY created_at LIMIT 1')[0].session_id
    const initialCreate = http.find(item => new URL(item.url()).pathname === '/api/session/create')
    workspaceId = initialCreate?.request().postDataJSON()?.payload?.args?.request?.workspaceId
    if (typeof workspaceId !== 'string') throw new Error('initial Web session did not expose its workspace id')
    await setControl('readback', baselineSession, [])
    await prompt('Confirm this session is ready for a later authorized task. Do not use tools.')
    await wait(() => idle(baselineSession), 'baseline session bootstrap', baselineSession)
    const binding = query(deliveryPath, 'SELECT * FROM conversation_bindings WHERE session_id=?', baselineSession)[0]
    await stop()
    setConfig(patch, 'dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery', { ownerRoutes: [{ id: 'capture-owner', conversation: JSON.parse(binding.conversation_json), principal: JSON.parse(binding.principal_json), workspace, agentPreset: 'standard', policyRef: binding.policy_ref, minimumGeneration: binding.generation }] })
    await writeFile(patchPath, String(patch), { mode: 0o600 }); await open(true)
    await selectRestoredSession(activePage, /Confirm this session is ready/u)
    activeSession = baselineSession
    await resetArtifact(task.scaffoldSource)
    const baselineGoal = await createGoal('baseline-create', baselineSession, task.legacyObjective, 'baseline', `Read render.mjs, then edit it once by replacing the entire exact old content ${JSON.stringify(task.scaffoldSource)} with the entire exact new content ${JSON.stringify(task.legacySource)}. Do not call any other tool.`)
    await waitOutcome(baselineGoal, 'achieved', 'legacy baseline acceptance', baselineSession)
    const saveArgs = { goal_id: baselineGoal, name: task.skillName, description: 'Render known template placeholders.', bindings_json: '[]', expected_version: 0 }
    await setControl('baseline-save', baselineSession, [{ toolName: 'skill_save', arguments: saveArgs }])
    await prompt(`Use only skill_save with ${JSON.stringify(saveArgs)}.`)
    await wait(() => query(skillsPath, "SELECT COUNT(*) AS count FROM skill_definitions WHERE name='template-render'")[0]?.count === 1, 'save baseline v1', baselineSession)

    const failureSession = await createSession(); await resetArtifact(task.scaffoldSource)
    const failureGoal = await createGoal('failure-create', failureSession, task.strictObjective, 'strict failure', 'Call skill_run once with the returned business goal_id, name template-render, version 1, inputs_json {}, and invocation_id strict-failure-v1. Do not call any other tool.')
    await waitOutcome(failureGoal, 'not-achieved', 'strict v1 failure', failureSession)
    const failureRun = parsedRows(skillsPath, 'skill_runs', 'run_json').find(item => item.goalId === failureGoal)
    expect(failureRun).toMatchObject({ state: 'succeeded', skillName: task.skillName, version: 1 })

    const repairSession = await createSession()
    await resetArtifact(task.scaffoldSource)
    const repairFrameStart = frames.length
    const repairGoal = await createGoal('repair-create', repairSession, task.strictObjective, 'strict repair', `First call skill_run once with the returned business goal_id, name template-render, version 1, inputs_json {}, and invocation_id repair-baseline-v1. Then read render.mjs and edit it once by replacing the entire exact old content ${JSON.stringify(task.legacySource)} with the entire exact new content ${JSON.stringify(task.repairedSource)}. Do not call any other tool.`)
    await waitOutcome(repairGoal, 'achieved', 'strict repair acceptance', repairSession)
    const repairRows = query(goalsPath, 'SELECT * FROM goal_records WHERE id = ?', repairGoal)
    expect(repairRows).toHaveLength(1)
    const repairEdits = toolCalls(frames.slice(repairFrameStart)).filter(call => call.name === 'edit' && !call.callId.includes(':skill:') && !call.callId.includes(':skill-observation:'))
    expect(repairEdits).toHaveLength(1)
    const repairEdit = repairEdits[0]
    expect(repairEdit?.callId).toBeTruthy()

    const controlSession = await createSession()
    const failureArgs = templateFailureCandidatePayload({ ownerRouteId: 'capture-owner', triggerGoalId: failureGoal, triggerSessionId: failureSession, repairGoalId: repairGoal, repairSessionId: repairSession, repairStepId: repairEdit.callId })
    await setControl('candidate', controlSession, [{ toolName: 'skill_failure_candidate', arguments: failureArgs }])
    await prompt(`Use only skill_failure_candidate with these exact arguments: ${JSON.stringify(failureArgs)}.`)
    await wait(() => query(skillsPath, 'SELECT candidate_json FROM skill_candidates').length === 1, 'failure candidate', controlSession)
    const persistedCandidate = query(skillsPath, 'SELECT candidate_json FROM skill_candidates')[0]
    const candidate = JSON.parse(persistedCandidate.candidate_json)
    expect(candidate).toMatchObject({ state: 'pending', parentVersion: 1 })

    await stop()
    const persistedParent = query(skillsPath, "SELECT definition_json FROM skill_definitions WHERE name='template-render' AND version=1")[0]
    const persistedGoal = query(goalsPath, 'SELECT id,definition_json,native_json FROM goal_records WHERE id=?', repairGoal)[0]
    const repairContract = contracts(verifierPath, 'goal-outcome').find(item => item.contract.task.goal?.id === repairGoal)
    const admission = runtimeCanaryAdmission({ skillName: task.skillName, parent: persistedParent, candidate: persistedCandidate, strictGoal: persistedGoal, outcomeContract: repairContract })
    const materialized = templateCanaryMaterializedSources({ parent: persistedParent, candidate: persistedCandidate })
    expect(materialized.candidateSource).toBe(task.repairedSource)
    const holdout = await createProspectiveCanaryAuthority({ root: temp, home, workspace, task })
    const canaryProfile = holdout.profile(owner, { canaryAdmission: admission, parent: persistedParent, candidate: persistedCandidate })
    expect(canaryProfile.authority.generatorDigest).toBe(prospectiveGeneratorDigest(task.generator))
    setConfig(patch, 'dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', { databasePath: skillsPath, allowedTools: task.authorizedTools, maxDurationMs: 60000, externalHoldouts: [canaryProfile] })
    await writeFile(patchPath, String(patch), { mode: 0o600 }); await setControl('discover', controlSession, [{ toolName: 'skill_comparison_status', arguments: {} }]); await open(true)
    await selectRestoredSession(activePage, /Use only skill_failure_candidate/u)
    activeSession = controlSession
    const discoverBefore = query(deliveryPath, "SELECT COUNT(*) AS count FROM inbox_messages WHERE status='processed'")[0].count
    await prompt('Use only skill_comparison_status with no arguments and report the configured canary profile.')
    await wait(() => query(deliveryPath, "SELECT COUNT(*) AS count FROM inbox_messages WHERE status='processed'")[0].count > discoverBefore, 'canary profile discovery', controlSession)
    const canaryArgs = { candidate_id: candidate.id, profile_id: canaryProfile.id, invocation_id: 'template-render-canary-1', owner_route_id: 'capture-owner', expires_at: canaryProfile.execution.expiresAt - 1000, max_runs: 2, canary_runs: 1 }
    await setControl('canary', controlSession, [{ toolName: 'skill_canary', arguments: canaryArgs }])
    await prompt(`Use only skill_canary with these exact arguments: ${JSON.stringify(canaryArgs)}.`)
    await wait(() => parsedRows(skillsPath, 'skill_deployments', 'deployment_json')[0]?.state === 'canary', 'prospective qualification and canary', controlSession)
    const comparison = parsedRows(skillsPath, 'skill_comparisons', 'comparison_json')[0]
    expect(comparison).toMatchObject({ state: 'complete', candidateId: candidate.id, invocationId: canaryArgs.invocation_id,
      result: { promotionAuthorized: false, execution: 'native-file-tools-and-isolated-artifact', prospectiveHoldout: 'authority-attested-after-freeze', admissionDigest: acceptanceDigest(admission) } })
    expect(comparison.result.quality).toMatchObject({ candidateChecksPassed: true, evaluationGainObserved: true, criticalRegressionsPassed: true })
    expect(comparison.result.receipt).toMatchObject({ complete: true, datasetDigest: comparison.result.receipt.prospective.datasetDigest,
      admissionDigest: acceptanceDigest(admission), prospective: { generatorDigest: canaryProfile.authority.generatorDigest, profileVersion: task.generator, profileDigest: canaryProfile.authority.generatorDigest } })
    expect(comparison.result.receipt.planDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(comparison.result.receipt.datasetDigest).toMatch(/^[a-f0-9]{64}$/u)
    let deployment = parsedRows(skillsPath, 'skill_deployments', 'deployment_json')[0]
    expect(deployment).toMatchObject({ state: 'canary', candidateId: candidate.id, comparisonId: comparison.id, skillName: task.skillName, version: 2, parentVersion: 1, maxRuns: 2, canaryRuns: 1, taskFamily: admission.taskFamily })
    expect(deployment.qualificationDigest).toBe(acceptanceDigest(comparison.result))
    expect(deployment.admissionDigest).toBe(acceptanceDigest(admission))
    expect(deployment.candidateDefinitionDigest).toBe(acceptanceDigest(candidate.definition))

    const promotionSession = await createSession(); await resetArtifact(task.scaffoldSource)
    const promotionGoal = await createGoal('promotion-create', promotionSession, task.strictObjective, 'promotion', 'Call skill_run once with the returned business goal_id, name template-render, version 2, inputs_json {}, and invocation_id promotion-v2. Do not call any other tool.')
    await waitOutcome(promotionGoal, 'achieved', 'promotion acceptance', promotionSession)
    await expect.poll(() => parsedRows(skillsPath, 'skill_deployments', 'deployment_json')[0]?.state, { timeout: 30000 }).toBe('promoted')
    const promotionRun = exactRun(promotionGoal, { sessionId: promotionSession, invocationId: 'promotion-v2', skillName: task.skillName, version: 2, inputs: {}, state: 'succeeded' })
    const promotionEvidence = goalEvidence(promotionGoal, promotionRun, 'achieved', admission.taskFamily)
    const promotedDeployment = parsedRows(skillsPath, 'skill_deployments', 'deployment_json')[0]
    const promotedWatch = parsedRows(skillsPath, 'skill_watches', 'watch_json')[0]
    const taskFamilyDigest = acceptanceDigest(admission.taskFamily)
    expect(promotedDeployment).toMatchObject({ state: 'promoted', watchId: promotedWatch.id, taskFamily: admission.taskFamily, runIds: [promotionRun.id] })
    expect(promotedWatch).toMatchObject({ state: 'watching', proofVersion: 'sole-skill-run/v1', taskFamily: admission.taskFamily, runIds: [promotionRun.id] })
    expect(promotedWatch.observations).toEqual([expect.objectContaining({ runId: promotionRun.id, receiptDigest: promotionEvidence.receipt.digest, objectiveStatus: 'achieved', taskFamilyDigest })])

    const negativeSession = await createSession(); await resetArtifact(task.scaffoldSource)
    const negativeInputs = task.negativeInputs
    const negativeGoal = await createGoal('negative-create', negativeSession, task.strictObjective, 'negative control', `Call skill_run once with the returned business goal_id, name template-render, version 2, inputs_json ${JSON.stringify(JSON.stringify(negativeInputs))}, and invocation_id negative-control-v2. Do not call any other tool.`)
    await waitOutcome(negativeGoal, 'not-achieved', 'negative-control acceptance', negativeSession)
    await expect.poll(() => parsedRows(skillsPath, 'skill_deployments', 'deployment_json')[0]?.state, { timeout: 30000 }).toBe('rolled-back')
    const negativeRun = exactRun(negativeGoal, { sessionId: negativeSession, invocationId: 'negative-control-v2', skillName: task.skillName, version: 2, inputs: negativeInputs, state: 'succeeded' })
    const negativeEvidence = goalEvidence(negativeGoal, negativeRun, 'not-achieved', admission.taskFamily)
    deployment = parsedRows(skillsPath, 'skill_deployments', 'deployment_json')[0]
    const watch = parsedRows(skillsPath, 'skill_watches', 'watch_json')[0]
    expect(deployment).toMatchObject({ state: 'rolled-back', watchId: watch.id, taskFamily: admission.taskFamily, runIds: [promotionRun.id, negativeRun.id] })
    expect(watch).toMatchObject({ state: 'rolled-back', rollbackVersion: 3, failureThreshold: 1, proofVersion: 'sole-skill-run/v1', taskFamily: admission.taskFamily, runIds: [promotionRun.id, negativeRun.id] })
    expect(watch.observations).toEqual([
      expect.objectContaining({ runId: promotionRun.id, receiptDigest: promotionEvidence.receipt.digest, objectiveStatus: 'achieved', taskFamilyDigest }),
      expect.objectContaining({ runId: negativeRun.id, receiptDigest: negativeEvidence.receipt.digest, objectiveStatus: 'not-achieved', taskFamilyDigest }),
    ])
    const definitions = query(skillsPath, "SELECT definition_json FROM skill_definitions WHERE name='template-render' ORDER BY version").map(item => JSON.parse(item.definition_json))
    expect(definitions).toHaveLength(3)
    const [version1, version2, latest] = definitions
    expect(latest).toMatchObject({ version: 3, parentVersion: 2, restoredFromVersion: 1 })
    expect(acceptanceDigest(version1)).toBe(watch.fallbackDigest)
    expect(acceptanceDigest(version2)).toBe(watch.definitionDigest)
    expect(acceptanceDigest(version2)).toBe(deployment.definitionDigest)
    expect(candidate).toMatchObject({ state: 'pending', failureProvenance: { rollbackTarget: { name: task.skillName, version: 1, digest: watch.fallbackDigest } } })
    const activatedCandidate = JSON.parse(query(skillsPath, 'SELECT candidate_json FROM skill_candidates WHERE id=?', candidate.id)[0].candidate_json)
    expect(activatedCandidate).toMatchObject({ state: 'activated', activatedVersion: 2, activationComparisonId: comparison.id, deploymentId: deployment.id })
    const businessDefinition = value => Object.fromEntries(['protocol', 'name', 'description', 'source', 'inputs', 'steps', 'preconditions', 'compensation', 'fileObservations', 'runExpansions'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
    expect(businessDefinition(latest)).toEqual(businessDefinition(version1))

    const comparisonStatusArgs = { comparison_id: comparison.id }
    const deploymentStatusArgs = { deployment_id: deployment.id }
    const comparisonCallIds = await readStatus('skill_comparison_status', comparisonStatusArgs, `Use only skill_comparison_status with ${JSON.stringify(comparisonStatusArgs)}.`)
    const deploymentCallIds = await readStatus('skill_deployment_status', deploymentStatusArgs, `Use only skill_deployment_status with ${JSON.stringify(deploymentStatusArgs)}.`)
    const watchesCallIds = await readStatus('skill_watches', {}, 'Use only skill_watches with no arguments.')

    const snapshot = async () => ({
      skills: databaseSnapshot(skillsPath), goals: databaseSnapshot(goalsPath), goalExecutions: databaseSnapshot(`${goalsPath}.executions`),
      goalOutcomes: databaseSnapshot(`${goalsPath}.outcomes`), goalBudgets: databaseSnapshot(`${goalsPath}.budgets`),
      verifier: databaseSnapshot(verifierPath), delivery: databaseSnapshot(deliveryPath), holdoutAuthority: databaseSnapshot(holdout.state),
      modelDispatches: existsSync(modelLog) ? (await readFile(modelLog, 'utf8')).trim().split('\n').filter(line => JSON.parse(line).event === 'dispatch').length : 0,
    })
    expect(query(skillsPath, 'SELECT * FROM skill_captures')).toEqual([])
    expect(query(deliveryPath, "SELECT DISTINCT state FROM delivery_session_leases WHERE state <> 'released'")).toEqual([])
    expect(query(deliveryPath, "SELECT id,status FROM inbox_messages WHERE status <> 'processed'")).toEqual([])
    expect(query(deliveryPath, "SELECT id,status,next_attempt_at FROM outbox_messages WHERE status IN ('pending','attempting','retry_wait','unknown_after_send')")).toEqual([])
    expect(query(`${goalsPath}.budgets`, "SELECT id,state FROM goal_budget_reservations WHERE state='held'")).toEqual([])
    expect(query(verifierPath, "SELECT contract_id,state FROM acceptance_jobs WHERE state <> 'done'")).toEqual([])
    expect(query(verifierPath, 'SELECT receipt_id,acknowledged FROM acceptance_outbox WHERE acknowledged <> 1')).toEqual([])
    expect(deployment.routeReceipt).toEqual(watch.routeReceipt)
    const currentBinding = query(deliveryPath, "SELECT * FROM conversation_bindings WHERE status='active' AND session_id=?", baselineSession)[0]
    expect(deployment.routeReceipt).toMatchObject({ receiptVersion: 2, authorityId: 'capture-owner', principalId: 'web/web/local/operator', principalRecordId: owner.id, principalVersion: owner.version, workspace, agentPreset: 'standard', bindingVersion: currentBinding.version, generation: currentBinding.generation })
    expect(deployment.routeReceipt.authorityHash).toMatch(/^[a-f0-9]{64}$/u)
    const authorityRow = query(holdout.state, 'SELECT * FROM authority WHERE id=1')[0]
    expect(authorityRow.lease_until).toBe(0)
    const prospective = JSON.parse(authorityRow.prospective)
    expect(prospective).toMatchObject({ phase: 'complete', generator: task.generator, certificate: { generatorDigest: canaryProfile.authority.generatorDigest, profileVersion: task.generator, profileDigest: canaryProfile.authority.generatorDigest, datasetDigest: comparison.result.receipt.datasetDigest } })
    const beforeRestart = await snapshot(); await stop()
    const controlEvents = await sessionEvents(home, workspace, negativeSession)
    const comparisonResults = comparisonCallIds.map(callId => assertPublicCanaryStatus(toolResult(controlEvents, callId, 'skill_comparison_status', comparisonStatusArgs)))
    const deploymentResults = deploymentCallIds.map(callId => assertPublicCanaryStatus(toolResult(controlEvents, callId, 'skill_deployment_status', deploymentStatusArgs)))
    const watchesResults = watchesCallIds.map(callId => assertPublicCanaryStatus(toolResult(controlEvents, callId, 'skill_watches', {})))
    expect(comparisonResults.every(value => isDeepStrictEqual(value, comparisonResults[0]))).toBe(true)
    expect(deploymentResults.every(value => isDeepStrictEqual(value, deploymentResults[0]))).toBe(true)
    expect(watchesResults.every(value => isDeepStrictEqual(value, watchesResults[0]))).toBe(true)
    const publicComparison = comparisonResults[0], publicDeployment = deploymentResults[0], publicWatches = watchesResults[0]
    exactKeys(publicComparison, ['id', 'sessionId', 'candidateId', 'parentDigest', 'profileId', 'profileDigest', 'invocationId', 'state', 'createdAt', 'updatedAt', 'quality', 'planDigest', 'datasetDigest', 'admissionDigest', 'generatorDigest'])
    exactKeys(publicComparison.quality, ['candidateChecksPassed', 'evaluationGain', 'evaluationGainObserved', 'criticalRegressionsPassed', 'heldoutIndependence'])
    exactKeys(publicDeployment, ['id', 'candidateId', 'comparisonId', 'qualificationDigest', 'admissionDigest', 'candidateDefinitionDigest', 'skillName', 'version', 'definitionDigest', 'parentVersion', 'watchId', 'taskFamilyDigest', 'expiresAt', 'maxRuns', 'canaryRuns', 'runCount', 'state', 'createdAt', 'updatedAt'])
    expect(Array.isArray(publicWatches)).toBe(true)
    for (const item of publicWatches) exactKeys(item, ['id', 'skillName', 'version', 'definitionDigest', 'fallbackVersion', 'fallbackDigest', 'expiresAt', 'maxRuns', 'failureThreshold', 'state', 'observedRuns', 'achieved', 'notAchieved', 'createdAt', 'updatedAt'], ['rollbackVersion', 'taskFamilyDigest'])
    expect(publicComparison).toMatchObject({ id: comparison.id, candidateId: candidate.id, state: 'complete', quality: comparison.result.quality, planDigest: comparison.result.receipt.planDigest, datasetDigest: comparison.result.receipt.datasetDigest, generatorDigest: canaryProfile.authority.generatorDigest, admissionDigest: acceptanceDigest(admission) })
    expect(publicDeployment).toMatchObject({ id: deployment.id, candidateId: candidate.id, comparisonId: comparison.id, watchId: watch.id, skillName: task.skillName, version: 2, parentVersion: 1, maxRuns: 2, canaryRuns: 1, runCount: 2, state: 'rolled-back', taskFamilyDigest })
    expect(publicWatches).toEqual([expect.objectContaining({ id: watch.id, skillName: task.skillName, version: 2, fallbackVersion: 1, maxRuns: 2, failureThreshold: 1, observedRuns: 2, achieved: 1, notAchieved: 1, state: 'rolled-back', rollbackVersion: 3, taskFamilyDigest })])
    const promotionEvents = await sessionEvents(home, workspace, promotionSession), negativeEvents = await sessionEvents(home, workspace, negativeSession)
    const sessionIds = { baseline: baselineSession, failure: failureSession, repair: repairSession, control: controlSession, promotion: promotionSession, negative: negativeSession }
    const sessionDigests = Object.fromEntries(await Promise.all(Object.entries(sessionIds).map(async ([name, id]) => [name, acceptanceDigest(await sessionEvents(home, workspace, id))])))
    const promotionTraceDigest = runTraceDigest(promotionEvents, promotionEvidence.stored.scope, promotionEvidence.stored, promotionRun, promotionEvidence.intent, admission.taskFamily.outcomeProfile)
    const negativeTraceDigest = runTraceDigest(negativeEvents, negativeEvidence.stored.scope, negativeEvidence.stored, negativeRun, negativeEvidence.intent, admission.taskFamily.outcomeProfile)
    expect(watch.observations.map(item => item.executionTraceDigest)).toEqual([promotionTraceDigest, negativeTraceDigest])
    await setControl('readback', negativeSession, [])
    host = await startHost(env); starts++
    let stableSamples = 0
    await expect.poll(async () => { stableSamples = isDeepStrictEqual(await snapshot(), beforeRestart) ? stableSamples + 1 : 0; return stableSamples },
      { message: 'all canary ledgers remain stable after restart', timeout: 30000, intervals: [1000, 1000, 1000, 1000, 1000, 1000] }).toBeGreaterThanOrEqual(6)
    expect(await sourceHashes()).toEqual(executedSourceHashes)
    expect(Object.fromEntries(await Promise.all(Object.entries(sessionIds).map(async ([name, id]) => [name, acceptanceDigest(await sessionEvents(home, workspace, id))])))).toEqual(sessionDigests)
    expect([baselineSession, failureSession, repairSession, controlSession, promotionSession, negativeSession].every((id, index, ids) => ids.indexOf(id) === index)).toBe(true)
    expect(approvals.every(item => item.toolName !== 'bash')).toBe(true)
    const modelEvents = existsSync(modelLog) ? (await readFile(modelLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const dispatches = modelEvents.filter(item => item.event === 'dispatch'), settlements = modelEvents.filter(item => item.event === 'settled')
    expect(dispatches.length).toBeGreaterThan(0)
    expect(settlements).toHaveLength(dispatches.length)
    expect(dispatches.every(item => item.provider === route.provider && item.model === route.model)).toBe(true)
    expect(modelEvents.filter(item => item.event === 'request-tools').every(item => !item.toolNames.includes('bash') && !item.toolNames.includes('skill_activate') && !item.toolNames.includes('skill_activate_watched'))).toBe(true)
    expect(modelEvents.some(item => item.event === 'tool-execute' && item.name === 'bash')).toBe(false)
    expect(modelEvents.some(item => item.event === 'tool-execute' && item.name === 'skill_activate')).toBe(false)
    expect(modelEvents.some(item => item.event === 'tool-execute' && item.name === 'skill_activate_watched')).toBe(false)
    const exposedTools = [...new Set(modelEvents.filter(item => item.event === 'request-tools').flatMap(item => item.toolNames))].sort()
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ capability: 'real-traex-template-render-failure-canary', sourceHashes: executedSourceHashes, route: route.proof, model: { dispatches: dispatches.length, settlements: settlements.length, providers: [...new Set(dispatches.map(item => item.provider))], models: [...new Set(dispatches.map(item => item.model))], exposedTools }, sessions: { baselineSession, failureSession, repairSession, controlSession, promotionSession, negativeSession, digests: sessionDigests }, goals: { baselineGoal, failureGoal, repairGoal, promotionGoal, negativeGoal }, candidateId: candidate.id, admission, prospectiveHoldout: comparison.result.prospectiveHoldout, generatorDigest: canaryProfile.authority.generatorDigest, datasetDigest: comparison.result.receipt.datasetDigest, comparison: publicComparison, deployment: publicDeployment, watches: publicWatches, statusReadback: { sessionId: negativeSession, comparisonCallIds, deploymentCallIds, watchesCallIds }, causal: { taskFamilyDigest, promotion: { runId: promotionRun.id, receiptDigest: promotionEvidence.receipt.digest, executionTraceDigest: promotionTraceDigest }, rollback: { runId: negativeRun.id, receiptDigest: negativeEvidence.receipt.digest, executionTraceDigest: negativeTraceDigest } }, authorityStateDigest: acceptanceDigest(beforeRestart.holdoutAuthority), holdoutImage: process.env.DSH_HOLDOUT_TEST_IMAGE, bash: { exposedToModel: false, requested: rejected.some(item => item.toolName === 'bash'), executed: false }, manualActivationCount: modelEvents.filter(item => item.event === 'tool-execute' && ['skill_activate', 'skill_activate_watched'].includes(item.name)).length, restartNoReplay: true, restartStableSamples: stableSamples }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    if (failed && !new URL(activePage.url()).searchParams.has('token')) {
      await activePage.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }).catch(() => {})
      await writeFile(testInfo.outputPath('failure-dom.txt'), await activePage.locator('body').innerText().catch(() => ''), { mode: 0o600 }).catch(() => {})
    }
    await stop().catch(() => {})
    if (existsSync(modelLog)) await copyFile(modelLog, testInfo.outputPath('model.jsonl')).catch(() => {})
    await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport), { mode: 0o600 }).catch(() => {})
    await Promise.all(contexts.map(item => item.close().catch(() => {})))
    if (failed && process.env.DSH_CAPTURE_RETAIN_FAILURE === '1') await writeFile(testInfo.outputPath('retained-environment.json'), JSON.stringify({ temp, sessionId: activeSession }), { mode: 0o600 })
    else await rm(temp, { recursive: true, force: true })
  }
})
