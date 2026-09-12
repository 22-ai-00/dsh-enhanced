import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { isMap, isSeq, parseDocument } from 'yaml'
import { acceptanceDigest, validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '../../packages/task-acceptance-contract/lib/index.js'
import { fileObservationSteps, instantiate } from '../../plugins/assistant-skills/lib/definition.js'
import { repairPolicy, createProspectiveCanaryAuthority, templateRenderCanaryTask } from './real-canary-helpers.mjs'
import { contracts, jobs, setConfig } from './web-owner-real-helpers.mjs'
import { selectRestoredSession } from './repo-session-navigation.mjs'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const task = Object.freeze({
  ...templateRenderCanaryTask,
  legacyObjective: 'Implement render.mjs: read a JSON object from stdin whose template field is a string and whose values field is an object mapping keys to strings. For legacy compatibility, recursively replace known {{ascii_key}} placeholders for values-count plus one passes, preserve unknown placeholders, then print the rendered text and a newline.',
  strictObjective: 'Implement render.mjs: read a JSON object from stdin whose template field is a string and whose values field is an object mapping keys to strings. Replace known {{ascii_key}} placeholders literally in one non-recursive pass, preserve unknown placeholders, and print the rendered text followed by a newline.',
  legacyCriteria: [...templateRenderCanaryTask.legacyCriteria, {
    id: 'legacy-recursive-compatibility',
    stdin: '{"template":"release={{release}};literal={{literal}}","values":{"release":"r1","literal":"{{release}}-candidate"}}\n',
    expectedStdout: 'release=r1;literal=r1-candidate\n',
  }],
})
const nextTask = Object.freeze({
  ...task, id: 'template-render-jsonl-v1', generator: 'template-render-jsonl/v1',
  strictObjective: 'Implement render.mjs: read one or more newline-separated JSON objects from stdin, each with a template string field and a values object field mapping keys to strings. Replace every known {{ascii_key}} occurrence in the original template once with its literal value, without scanning substituted values for placeholders; preserve unknown placeholders and print one rendered line per input object. Accept a single JSON object without a trailing newline and preserve Unicode values.',
  strictCriteria: [...task.strictCriteria, {
    id: 'jsonl-literal-unicode',
    stdin: '{"template":"{{x}} {{missing}}","values":{"x":"café {{x}}"}}\n{"template":"city={{city}}","values":{"city":"東京"}}\n',
    expectedStdout: 'café {{x}} {{missing}}\ncity=東京\n',
  }],
})
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
  const path = join(home, 'sessions', projectKey(workspace), sessionId, 'session.jsonl.zstd')
  const info = await lstat(path)
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('canary Session artifact is not a bounded regular file')
  const { stdout } = await exec('zstd', ['-q', '-dc', '--', path], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
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

test('real TraeX autonomously improves one workflow twice and delivers the bounded result', async ({ page, context }, testInfo) => {
  test.setTimeout(1_500_000)
  const temp = await mkdtemp(join(tmpdir(), 'dsh-real-owner-repair-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), modelLog = join(temp, 'model.jsonl'), controlPath = join(temp, 'control.json')
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_WEB_REAL_PROVIDER: process.env.DSH_WEB_REAL_PROVIDER ?? 'traex-agent',
    DSH_WEB_REAL_MODEL: process.env.DSH_WEB_REAL_MODEL ?? 'gpt-5.6-terra', DSH_WEB_REAL_LOG: modelLog, DSH_WEB_REAL_WORKSPACE: workspace,
  }
  if (env.DSH_WEB_REAL_PROVIDER !== 'traex-agent') throw new Error('real template canary requires DSH_WEB_REAL_PROVIDER=traex-agent; Codex fallback is forbidden')
  if (!/^sha256:[a-f0-9]{64}$/u.test(process.env.DSH_HOLDOUT_TEST_IMAGE ?? '')) throw new Error('DSH_HOLDOUT_TEST_IMAGE must pin the installed authority image')
  const deliveryPath = join(home, 'assistant-delivery/state.sqlite'), goalsPath = join(home, 'assistant-goals/web.sqlite')
  const verifierPath = join(home, 'assistant-verifier/verification.sqlite'), skillsPath = join(home, 'assistant-skills/skills.sqlite')
  const http = [], frames = [], transport = [], streams = new Map(), contexts = [], approvals = [], rejected = []
  let authorizedRepairSessions = []
  let host, activePage = page, starts = 0, failed = false, activeSession, workspaceId, patch, patchPath, owner, route
  const setControl = async (phase, sessionId, expectedCalls = []) => {
    activeSession = sessionId
    const tools = phase === 'baseline-create' ? ['goal_create', 'read', 'write']
      : ['failure-create', 'promotion-create'].includes(phase) ? ['goal_create', 'skill_run']
        : expectedCalls.map(call => call.toolName)
    await writeFile(controlPath, JSON.stringify({ phase: 'bootstrap', ownerSessionId: sessionId ?? 'bootstrap-pending',
      allowedOwnerTools: tools, repairSessionIds: authorizedRepairSessions, artifactPath: task.artifactPath, maxModelCalls: 32, maxToolCalls: 64 }), { mode: 0o600 })
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
  const restoreSession = async (sessionId, title) => {
    const transportStart = transport.length
    await selectRestoredSession(activePage, title)
    await expect(activePage.getByRole('treeitem', { name: title, exact: false })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => transport.slice(transportStart).some(item => item.kind === 'sent' && item.frame?.type === 'open'
      && item.frame.endpoint === 'session/follow' && item.frame.payload?.args?.request?.address?.sessionId === sessionId)).toBe(true)
    await expect(activePage.getByLabel(/Describe what you want to build|Message or run a task/)).toBeVisible()
    activeSession = sessionId
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
    const fileAllowed = ['read', 'write', 'edit'].includes(call.name) && typeof args.file_path === 'string'
      && resolve(workspace, args.file_path) === join(workspace, task.artifactPath)
    const controlAllowed = control.allowedOwnerTools?.includes(call.name)
      || call.name === control.ownerArm?.name && acceptanceDigest(args) === acceptanceDigest(control.ownerArm.arguments)
    if (!fileAllowed && !controlAllowed) throw new Error(`approval escaped repair control: ${call.name}`)
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
    const processedBefore = query(deliveryPath, "SELECT COUNT(*) AS count FROM inbox_messages WHERE status='processed'")[0].count
    const args = { objective, max_goal_rounds: 1, start_native_rounds: true }
    await setControl(phase, sessionId, [{ toolName: 'goal_create', arguments: args }])
    await prompt(`CANARY ${label}: Create one finite Goal with objective exactly: '${objective}' Use goal_create with max_goal_rounds 1 and start_native_rounds true. Do not perform the artifact work in this foreground turn. In the subsequent native Goal round: ${nativeInstruction}`)
    await wait(() => {
      const created = query(goalsPath, 'SELECT id FROM goal_records').some(item => !before.has(item.id))
      const processed = query(deliveryPath, "SELECT COUNT(*) AS count FROM inbox_messages WHERE status='processed'")[0].count
      if (!created && processed > processedBefore && idle(sessionId)) throw new Error(`${label}: owner turn completed without creating its requested Goal`)
      return created
    }, `${label} goal creation`, sessionId)
    return query(goalsPath, 'SELECT id FROM goal_records').find(item => !before.has(item.id)).id
  }
  const waitOutcome = async (goalId, status, label, sessionId = activeSession) => {
    await wait(() => {
      const result = outcome(verifierPath, goalId)
      const actual = result?.job?.receipt?.objectiveStatus
      if (result?.job?.state === 'done' && actual !== status) throw new Error(`${label}: independently ${actual}, expected ${status}`)
      return actual === status
    }, label, sessionId)
    return outcome(verifierPath, goalId)
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
    const { createVerifierAuthorities, compileAcceptanceProfiles } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-verifier/lib/index.js')).href)
    const authority = { kind: 'runner', id: 'node', executable: process.execPath, fixedArgs: [], timeoutMs: 5000, maxOutputBytes: 16384 }
    const [runner] = createVerifierAuthorities({ authorities: [authority] })
    const profile = (kind, objective, criteria) => ({ id: `template-${kind}-${acceptanceDigest({ objective }).slice(0, 12)}`, version: 1, scope: { workspace, preset: 'standard' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, taskKind: kind, objective, validityMs: 600000, bounds: { maxDurationMs: 15000, maxEvidenceBytes: 16384 }, criteria: (kind === 'goal-step' ? criteria.slice(0, 1) : criteria).map(entry => ({ id: entry.id, kind: 'process-behavior', authority: { id: runner.id, digest: runner.digest }, artifactPath: task.artifactPath, stdin: entry.stdin, expectedStdout: entry.expectedStdout, expectedExitCode: 0 })) })
    const futureProfile = profile('goal-outcome', nextTask.strictObjective, nextTask.strictCriteria)
    const compiledFuture = compileAcceptanceProfiles({ databasePath: verifierPath, authorities: [authority], profiles: [futureProfile] }).profiles[0]
    patchPath = join(home, 'profiles/web/cordis.patch.yml'); patch = parseDocument(await readFile(patchPath, 'utf8'))
    setConfig(patch, 'dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', { databasePath: goalsPath, preauthorizedCreateMaxRounds: 3, verifyNativeRounds: true, verifyGoalOutcome: true, stepMaxDurationMs: 300000, executionBudget: { mode: 'calls', modelCalls: 16, toolCalls: 64, durationMs: 300000, maxOutputTokensPerCall: 4096, routes: [{ provider: route.provider, model: route.model }] } })
    setConfig(patch, 'dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', { databasePath: skillsPath, allowedTools: ['read', 'write', 'edit'], maxDurationMs: 60000 })
    setConfig(patch, 'dsh-enhanced-assistant-isolation', '@dsh-enhanced/assistant-isolation', { stateRoot: join(home, 'assistant-isolation') })
    setConfig(patch, 'dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', { databasePath: verifierPath, tickIntervalMs: 500, requireAcceptance: false, authorities: [authority], profiles: [profile('goal-step', task.legacyObjective, task.legacyCriteria), profile('goal-outcome', task.legacyObjective, task.legacyCriteria), profile('goal-step', task.strictObjective, task.strictCriteria), profile('goal-outcome', task.strictObjective, task.strictCriteria), profile('goal-step', nextTask.strictObjective, nextTask.strictCriteria), futureProfile] })
    setConfig(patch, 'dsh-enhanced-assistant-web-owner', '@dsh-enhanced/assistant-web-owner', { maxExecutionMs: 300000 })
    appendPolicy(patch, [
      { id: 'template-workflow-owner', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['inspect', 'save', 'draft', 'run'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['external'] } },
      ...['skill_save', 'skill_repair_arm'].map(name => ({ id: `repair-owner-setup-${name}`, effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['execute'], resource: { kind: 'tool', id: name }, context: { initiators: ['external'] } })),
      ...repairPolicy(workspace),
      { id: 'repair-owner-feedback', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-skills', workspace, principal: 'web/web/local/operator' }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
      { id: 'repair-background-goal', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['create', 'observe', 'execute'], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['background'] } },
      ...['read', 'write', 'edit'].map(name => ({ id: `repair-background-${name}`, effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['execute'], resource: { kind: 'tool', id: name }, context: { initiators: ['background'] } })),
    ])
    route.configurePatch(patch, setConfig)
    patch.contents.add(patch.createNode({ id: 'session-title-llm', disabled: true }))
    patch.contents.add(patch.createNode({ insert: [{ id: 'real-owner-repair-guard', name: resolve(root, 'scripts/e2e/web-owner-real-repair-guard.mjs'), config: { controlPath, logPath: modelLog, workspace, provider: route.provider, model: route.model } }] }))
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
    const baselineGoal = await createGoal('baseline-create', baselineSession, task.legacyObjective, 'baseline', 'Implement the requested recursive compatibility behavior using the authorized file tools. End the native round for independent verification.')
    await waitOutcome(baselineGoal, 'achieved', 'legacy baseline acceptance', baselineSession)
    const saveArgs = { goal_id: baselineGoal, name: task.skillName, description: 'Render known template placeholders.', bindings_json: '[]', expected_version: 0 }
    await setControl('baseline-save', baselineSession, [{ toolName: 'skill_save', arguments: saveArgs }])
    await prompt(`Call skill_save exactly once with ${JSON.stringify(saveArgs)}. After its successful response, end the turn immediately. Do not repeat the save.`)
    await wait(() => query(skillsPath, "SELECT COUNT(*) AS count FROM skill_definitions WHERE name='template-render'")[0]?.count === 1, 'save baseline v1', baselineSession)

    const failureSession = await createSession(); await resetArtifact(task.scaffoldSource)
    const failureGoal = await createGoal('failure-create', failureSession, task.strictObjective, 'strict failure', 'Call skill_run once with the returned business goal_id, name template-render, version 1, inputs_json as the JSON string "{}" (not an object), and invocation_id strict-failure-v1. Do not call any other tool.')
    await waitOutcome(failureGoal, 'not-achieved', 'strict v1 failure', failureSession)
    const failureRun = parsedRows(skillsPath, 'skill_runs', 'run_json').find(item => item.goalId === failureGoal)
    expect(failureRun).toMatchObject({ state: 'succeeded', skillName: task.skillName, version: 1 })

    await stop()
    const failedRecord = query(goalsPath, 'SELECT definition_json,native_json FROM goal_records WHERE id=?', failureGoal)[0]
    const failedOutcome = outcome(verifierPath, failureGoal)
    const failedContract = validateTaskAcceptanceContract(failedOutcome.contract.contract)
    const failedReceipt = validateTaskVerificationReceipt(failedContract, failedOutcome.job.receipt)
    expect(failedReceipt.objectiveStatus).toBe('not-achieved')
    const scope = { principalId: 'web/web/local/operator', principalRecordId: owner.id, principalVersion: owner.version, workspace, preset: 'standard' }
    const admissionTemplate = { protocol: 'assistant-skills/canary-admission-template/v1', skillName: task.skillName,
      taskFamily: { goalDefinitionDigest: JSON.parse(failedRecord.definition_json).digest, outcomeProfile: failedContract.profile } }
    const holdout = await createProspectiveCanaryAuthority({ root: temp, home, workspace, task })
    const holdoutProfile = holdout.repairProfile(owner, { canaryAdmissionTemplate: admissionTemplate })
    const nextAdmissionTemplate = { protocol: 'assistant-skills/canary-admission-template/v1', skillName: task.skillName, taskFamily: { goalDefinitionDigest: acceptanceDigest({ objective: nextTask.strictObjective }), outcomeProfile: { id: futureProfile.id, version: futureProfile.version, digest: compiledFuture.digest } } }
    const nextHoldout = await createProspectiveCanaryAuthority({ root: join(temp, 'round2'), home, workspace, task: nextTask })
    const nextHoldoutProfile = nextHoldout.repairProfile(owner, { canaryAdmissionTemplate: nextAdmissionTemplate })
    holdoutProfile.execution.expiresAt = nextHoldoutProfile.execution.expiresAt = Date.now() + 1_200_000
    const repairProfile = { id: 'real-template-repair', scope, skillName: task.skillName, taskFamilyId: task.id,
      description: 'Produce a reusable workflow implementing literal non-recursive template rendering.',
      externalHoldoutProfileId: holdoutProfile.id, provider: route.provider, model: route.model,
      allowedTools: ['read', 'write'], maxGoalRounds: 3, maxModelCalls: 16, maxToolCalls: 16,
      maxIterations: 2, followupProfileIds: ['real-template-jsonl-repair'],
      maxOutputTokens: 4096, maxDurationMs: 300000, canaryRuns: 1, maxCanaryRuns: 2 }
    const nextRepairProfile = { ...repairProfile, id: 'real-template-jsonl-repair', taskFamilyId: nextTask.id, description: 'Extend literal template rendering to independent JSON Lines records and Unicode values.', externalHoldoutProfileId: nextHoldoutProfile.id, maxIterations: 1, followupProfileIds: [] }
    setConfig(patch, 'dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', {
      databasePath: skillsPath, allowedTools: ['read', 'write', 'edit'], maxDurationMs: 60000,
    })
    const repairAdmissionPath = join(temp, 'repair-admission.json')
    await writeFile(repairAdmissionPath, JSON.stringify({ ownerRouteId: 'capture-owner',
      externalHoldouts: [holdoutProfile, nextHoldoutProfile], repairProfiles: [repairProfile, nextRepairProfile] }), { mode: 0o600 })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    const setupCommand = join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup')
    const setupArgs = ['--profile', 'web', '--workspace', workspace, '--repair-admission', repairAdmissionPath]
    const repairInstall = await run(setupCommand, setupArgs, env)
    await writeFile(testInfo.outputPath('repair-install.log'), sanitize(repairInstall), { mode: 0o600 })
    const installedRepairPatch = await readFile(patchPath, 'utf8')
    await run(setupCommand, setupArgs, env)
    expect(await readFile(patchPath, 'utf8')).toBe(installedRepairPatch)
    patch = parseDocument(installedRepairPatch)
    const invocationId = 'autonomous-repair-v1'
    const continuationId = `skill-repair-${acceptanceDigest([scope, 'capture-owner', invocationId])}`
    authorizedRepairSessions = [1, 2].map(iteration => `owner-repair-${createHash('sha256').update(`${continuationId}:${iteration}`).digest('hex').slice(0, 40)}`)
    const [repairSession, nextRepairSession] = authorizedRepairSessions
    const armArgs = { goal_id: failureGoal, source_session_id: failureSession, profile_id: repairProfile.id,
      owner_route_id: 'capture-owner', invocation_id: invocationId, notify: true, expires_at: holdoutProfile.execution.expiresAt - 1000 }
    // Both frozen workflows will replay from this same unfinished artifact. No
    // repaired implementation, tool sequence or hidden cases are supplied.
    await resetArtifact(task.scaffoldSource)
    await writeFile(controlPath, JSON.stringify({ phase: 'repair', ownerSessionId: baselineSession, repairSessionIds: authorizedRepairSessions,
      ownerArm: { name: 'skill_repair_arm', arguments: armArgs }, artifactPath: task.artifactPath,
      maxModelCalls: 32, maxToolCalls: 64 }), { mode: 0o600 })
    await writeFile(patchPath, String(patch), { mode: 0o600 }); await open(true)
    await restoreSession(baselineSession, /Confirm this session is ready/u)
    activeSession = baselineSession
    await prompt(`Authorize the configured autonomous repair once using skill_repair_arm with ${JSON.stringify(armArgs)}. Then end your turn. The Host owns subsequent repair, independent verification and canary qualification.`)
    const continuation = () => parsedRows(skillsPath, 'skill_repair_continuations', 'continuation_json').find(item => item.id === continuationId)
    await expect.poll(async () => {
      await approve()
      const record = continuation()
      if (record && ['rejected', 'revoked', 'expired', 'unknown'].includes(record.state)) throw new Error(`repair stopped: ${JSON.stringify(record.checkpoint)}`)
      return record?.state
    }, { message: 'autonomous native repair and prospective canary', timeout: 360000, intervals: [500, 1000] }).toBe('watching')
    const record = continuation()
    expect(record.checkpoint.repair.sessionId).toBe(repairSession)
    const repairGoal = record.checkpoint.repair.goalId
    expect(repairGoal).not.toBe(failureGoal)
    const repairOutcome = outcome(verifierPath, repairGoal)
    const repairContract = validateTaskAcceptanceContract(repairOutcome.contract.contract)
    const repairReceipt = validateTaskVerificationReceipt(repairContract, repairOutcome.job.receipt)
    expect(repairReceipt.objectiveStatus).toBe('achieved')
    expect(repairContract.profile).toEqual(failedContract.profile)
    expect(repairContract.task.goal).toMatchObject({ id: repairGoal, sessionId: repairSession, definitionDigest: admissionTemplate.taskFamily.goalDefinitionDigest })
    const candidate = parsedRows(skillsPath, 'skill_candidates', 'candidate_json')[0]
    const comparison = parsedRows(skillsPath, 'skill_comparisons', 'comparison_json')[0]
    const deployment = parsedRows(skillsPath, 'skill_deployments', 'deployment_json')[0]
    expect(candidate).toMatchObject({ state: 'activated', parentVersion: 1, activatedVersion: 2,
      failureProvenance: { repair: { goal: { id: repairGoal, sessionId: repairSession } }, parent: { name: task.skillName, version: 1 } } })
    expect(candidate.failureProvenance.trigger.failures).toEqual(expect.arrayContaining([expect.objectContaining({ goal: expect.objectContaining({ id: failureGoal, sessionId: failureSession }) })]))
    expect(comparison).toMatchObject({ state: 'complete', candidateId: candidate.id, result: {
      prospectiveHoldout: 'authority-attested-after-freeze', execution: 'native-file-tools-and-isolated-artifact',
      quality: { candidateChecksPassed: true, evaluationGainObserved: true, criticalRegressionsPassed: true },
    } })
    expect(comparison.result.receipt).toMatchObject({ complete: true, prospective: { generatorDigest: holdoutProfile.authority.generatorDigest } })
    expect(comparison.result.receipt.datasetDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(deployment).toMatchObject({ state: 'canary', candidateId: candidate.id, comparisonId: comparison.id, version: 2, maxRuns: 2, canaryRuns: 1 })
    const rounds = [{ iteration: 1, sourceSession: failureSession, sourceGoal: failureGoal, repairSession, repairGoal,
      candidate, comparison, deployment, failureReceiptDigest: failedReceipt.digest, repairReceiptDigest: repairReceipt.digest }]
    const deploymentById = id => parsedRows(skillsPath, 'skill_deployments', 'deployment_json').find(item => item.id === id)
    const waitRepair = async iteration => {
      await expect.poll(async () => {
        await approve()
        const current = continuation()
        if (current && ['rejected', 'revoked', 'expired', 'unknown'].includes(current.state)) throw new Error(`repair round ${iteration} stopped: ${JSON.stringify(current.checkpoint)}`)
        return current?.iteration === iteration && current.state === 'watching'
      }, { message: `autonomous repair round ${iteration}`, timeout: 360000, intervals: [500, 1000] }).toBe(true)
      return continuation()
    }
    const promote = async (round, currentTask) => {
      const sessionId = await createSession(); await resetArtifact(task.scaffoldSource)
      const goalId = await createGoal('promotion-create', sessionId, currentTask.strictObjective, `promotion v${round.deployment.version}`,
        `Call skill_run exactly once with the returned business goal_id, name template-render, version ${round.deployment.version}, inputs_json as the JSON string "{}" (not an object), and invocation_id promote-v${round.deployment.version}. Then end the native round. Do not call any other tool.`)
      await waitOutcome(goalId, 'achieved', `independent future task v${round.deployment.version}`, sessionId)
      await expect.poll(() => deploymentById(round.deployment.id)?.state, { timeout: 30000 }).toBe('promoted')
      round.deployment = deploymentById(round.deployment.id)
      expect(round.deployment.promotedAt).toBeGreaterThanOrEqual(round.deployment.createdAt)
      round.promotion = { sessionId, goalId, promotedAt: round.deployment.promotedAt }
    }
    await promote(rounds[0], task)
    // The next failure is a real task created after v2 promotion. It is not an
    // injected failure receipt, a second arm, or a pre-promotion queued run.
    const nextFailureSession = await createSession(); await resetArtifact(task.scaffoldSource)
    const nextFailureGoal = await createGoal('failure-create', nextFailureSession, nextTask.strictObjective, 'JSON Lines failure',
      'Call skill_run exactly once with the returned business goal_id, name template-render, version 2, inputs_json as the JSON string "{}" (not an object), and invocation_id jsonl-failure-v2. Then end the native round. Do not call any other tool.')
    const nextFailedOutcome = await waitOutcome(nextFailureGoal, 'not-achieved', 'independent JSON Lines v2 failure', nextFailureSession)
    const nextFailureRun = parsedRows(skillsPath, 'skill_runs', 'run_json').find(item => item.goalId === nextFailureGoal)
    expect(nextFailureRun).toMatchObject({ state: 'succeeded', version: 2 })
    expect(nextFailureRun.createdAt).toBeGreaterThan(rounds[0].promotion.promotedAt)
    const second = await waitRepair(2)
    expect(second.checkpoint.repair.sessionId).toBe(nextRepairSession)
    const nextRepairGoal = second.checkpoint.repair.goalId
    expect(new Set([failureGoal, repairGoal, nextFailureGoal, nextRepairGoal]).size).toBe(4)
    const nextResult = outcome(verifierPath, nextRepairGoal)
    const nextContract = validateTaskAcceptanceContract(nextResult.contract.contract)
    const nextReceipt = validateTaskVerificationReceipt(nextContract, nextResult.job.receipt)
    expect(nextReceipt.objectiveStatus).toBe('achieved')
    expect(nextContract.profile).toEqual(nextAdmissionTemplate.taskFamily.outcomeProfile)
    expect(nextContract.task.goal).toMatchObject({ id: nextRepairGoal, sessionId: nextRepairSession, definitionDigest: nextAdmissionTemplate.taskFamily.goalDefinitionDigest })
    const nextCandidate = parsedRows(skillsPath, 'skill_candidates', 'candidate_json').find(item => item.parentVersion === 2)
    const nextComparison = parsedRows(skillsPath, 'skill_comparisons', 'comparison_json').find(item => item.candidateId === nextCandidate?.id)
    const nextDeployment = parsedRows(skillsPath, 'skill_deployments', 'deployment_json').find(item => item.candidateId === nextCandidate?.id)
    expect(nextCandidate).toMatchObject({ state: 'activated', parentVersion: 2, activatedVersion: 3,
      failureProvenance: { repair: { goal: { id: nextRepairGoal, sessionId: nextRepairSession } } } })
    expect(nextCandidate.failureProvenance.trigger.failures).toEqual(expect.arrayContaining([expect.objectContaining({ goal: expect.objectContaining({ id: nextFailureGoal, sessionId: nextFailureSession }) })]))
    expect(nextComparison).toMatchObject({ state: 'complete', result: { prospectiveHoldout: 'authority-attested-after-freeze',
      quality: { candidateChecksPassed: true, evaluationGainObserved: true, criticalRegressionsPassed: true } } })
    expect(nextComparison.result.receipt).toMatchObject({ complete: true, prospective: { generatorDigest: nextHoldoutProfile.authority.generatorDigest } })
    expect(nextDeployment).toMatchObject({ state: 'canary', version: 3, maxRuns: 2, canaryRuns: 1 })
    rounds.push({ iteration: 2, sourceSession: nextFailureSession, sourceGoal: nextFailureGoal, repairSession: nextRepairSession,
      repairGoal: nextRepairGoal, candidate: nextCandidate, comparison: nextComparison, deployment: nextDeployment,
      failureReceiptDigest: nextFailedOutcome.job.receipt.digest, repairReceiptDigest: nextReceipt.digest })
    await promote(rounds[1], nextTask)
    await expect.poll(() => continuation()?.state, { timeout: 30000 }).toBe('complete')
    expect(continuation()).toMatchObject({ iteration: 2, authorization: { maxIterations: 2 } })
    const noticeRows = () => query(deliveryPath, 'SELECT idempotency_key,status,attempt_count,binding_id FROM outbox_messages WHERE idempotency_key LIKE ?', `repair-feedback:${continuationId}:%`)
    const requiredNotices = ['1:iteration-success', '2:iteration-success', '2:final-success'].map(suffix => `repair-feedback:${continuationId}:${suffix}`)
    await expect.poll(() => requiredNotices.every(key => noticeRows().some(item => item.idempotency_key === key && item.status === 'accepted')), { message: 'both iterations and final result delivered to original owner session', timeout: 30000 }).toBe(true)
    for (const notice of noticeRows()) expect(notice).toMatchObject({ binding_id: binding.id, status: 'accepted', attempt_count: 1 })
    const generatedArtifactDigest = createHash('sha256').update(await readFile(join(workspace, task.artifactPath))).digest('hex')
    const usage = () => query(skillsPath, 'SELECT model_calls,tool_calls FROM skill_repair_usage WHERE id=?', continuationId)[0]
    const finalUsage = usage()
    expect(finalUsage.model_calls).toBeLessThanOrEqual(repairProfile.maxModelCalls)
    expect(finalUsage.tool_calls).toBeLessThanOrEqual(repairProfile.maxToolCalls)
    await stop()
    for (const round of rounds) {
      const events = await sessionEvents(home, workspace, round.repairSession)
      // DSH also persists system-prompt snapshots and the skill catalog as
      // user/message events. Those are context assembly, not task requests.
      const nativeSources = events.filter(event => event.type === 'user/message'
        && !['plugin', 'skill-catalog'].includes(event.data?.source?.kind))
      expect(nativeSources.length).toBeGreaterThan(0)
      expect(nativeSources.every(event => event.data?.source?.kind === 'goal')).toBe(true)
      expect(nativeSources.every(event => event.data.source.round > 0)).toBe(true)
      const calls = events.filter(event => event.type === 'tool/call')
      expect(calls.some(event => event.data.name === 'write')).toBe(true)
      expect(calls.every(event => repairProfile.allowedTools.includes(event.data.name))).toBe(true)
      round.toolNames = calls.map(event => event.data.name)
    }
    const readModelEvents = async () => (await readFile(modelLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const beforeRestart = await readModelEvents()
    const dispatches = beforeRestart.filter(item => item.event === 'dispatch')
    expect(dispatches.every(item => item.provider === route.provider && item.model === route.model)).toBe(true)
    expect(beforeRestart.filter(item => item.event === 'tool-execute' && item.name === 'skill_repair_arm')).toHaveLength(1)
    expect(dispatches.filter(item => authorizedRepairSessions.includes(item.sessionId))).toHaveLength(finalUsage.model_calls)
    const stable = acceptanceDigest({ record: continuation(), usage: usage(), notices: noticeRows() })
    await setControl('readback', baselineSession, [])
    await open(true)
    await restoreSession(baselineSession, /Confirm this session is ready/u)
    await expect(activePage.getByText(/The finite repair sequence ended with an independently accepted successor/u).first()).toBeVisible()
    // Observe several runtime ticks after a real process restart: complete work
    // and accepted notices must not dispatch another model call or spend again.
    for (let tick = 0; tick < 5; tick++) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      expect(acceptanceDigest({ record: continuation(), usage: usage(), notices: noticeRows() })).toBe(stable)
    }
    await stop()
    expect((await readModelEvents()).filter(item => item.event === 'dispatch')).toHaveLength(dispatches.length)
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ capability: 'real-traex-two-round-bounded-rsi',
      route: route.proof, scope, baseline: { sessionId: baselineSession, goalId: baselineGoal, version: 1 },
      continuationId, state: continuation().state, iterations: continuation().iteration, rounds: rounds.map(round => ({
        iteration: round.iteration, sourceSession: round.sourceSession, sourceGoal: round.sourceGoal,
        repairSession: round.repairSession, repairGoal: round.repairGoal, candidateId: round.candidate.id,
        comparisonId: round.comparison.id, deploymentId: round.deployment.id, version: round.deployment.version,
        failureReceiptDigest: round.failureReceiptDigest, repairReceiptDigest: round.repairReceiptDigest,
        candidateDefinitionDigest: acceptanceDigest(round.candidate.definition), quality: round.comparison.result.quality,
        datasetDigest: round.comparison.result.receipt.datasetDigest, promotion: round.promotion, toolNames: round.toolNames,
      })), usage: finalUsage, feedback: noticeRows(), generatedArtifactDigest, completedRestartNoReplay: true,
      initialArtifact: 'shared unfinished scaffold', suppliedRepairedSource: false, installedRepairAdmissionIdempotent: true,
      limitations: ['bounded two-profile workflow improvement', 'no mid-repair restart proof', 'delivery accepted does not mean user read'],
    }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    await stop().catch(() => {})
    if (existsSync(modelLog)) await copyFile(modelLog, testInfo.outputPath('model.jsonl')).catch(() => {})
    if (failed) await writeFile(testInfo.outputPath('failure-dom.txt'), await activePage.locator('body').innerText().catch(() => ''), { mode: 0o600 }).catch(() => {})
    await Promise.all(contexts.map(item => item.close().catch(() => {})))
    if (failed && process.env.DSH_CAPTURE_RETAIN_FAILURE === '1') await writeFile(testInfo.outputPath('retained-environment.json'), JSON.stringify({ temp, sessionId: activeSession }), { mode: 0o600 })
    else await rm(temp, { recursive: true, force: true })
  }
})
