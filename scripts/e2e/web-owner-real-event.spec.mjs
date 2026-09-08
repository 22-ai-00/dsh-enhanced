import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument, isMap, isSeq } from 'yaml'
import { objective, criteria, setConfig, contracts, jobs, waitForVerifiedGoal } from './web-owner-real-helpers.mjs'
import { isEventExperimentToolAllowed } from './web-owner-real-guard.mjs'
import { readSessionAudit } from './web-owner-real-audit.mjs'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sourceAutomationId = 'web-owner-real-event-source'
const reminderMode = process.env.DSH_WEB_REAL_OPPORTUNITY === 'remind'
const opportunityProfile = ['1', 'remind'].includes(process.env.DSH_WEB_REAL_OPPORTUNITY) ? 'real-event-opportunity' : undefined

function row(doc, id) {
  const value = doc.contents.items.find(item => isMap(item) && item.get('id') === id)
  if (!value || !isMap(value)) throw new Error(`missing profile row ${id}`)
  return value
}

function nestedConfig(doc, id, name) {
  const config = row(doc, id).get('config', true)
  if (!isMap(config)) throw new Error(`invalid profile config ${id}`)
  const nested = config.get(name, true)
  if (!isMap(nested)) throw new Error(`invalid profile nested config ${id}.${name}`)
  return nested
}

function setNestedConfig(doc, id, name, values) {
  const config = nestedConfig(doc, id, name)
  for (const [key, value] of Object.entries(values)) config.set(key, doc.createNode(value))
}

function appendNestedConfig(doc, id, name, key, values) {
  const config = nestedConfig(doc, id, name)
  let list = config.get(key, true)
  if (list === undefined) { list = doc.createNode([]); config.set(key, list) }
  if (!isSeq(list)) throw new Error(`invalid profile config list ${id}.${key}`)
  for (const value of values) list.add(doc.createNode(value))
}

function readEvents(path) {
  return query(path, 'SELECT * FROM event_outbox ORDER BY sequence ASC')
}

function modelCalls(path) {
  return readFile(path, 'utf8').catch(() => '').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
}

async function selectOwnerSession(page) {
  const workspaceRow = page.getByRole('treeitem', { name: 'workspace', exact: true })
  await expect(workspaceRow).toBeVisible()
  const session = page.getByRole('treeitem', { name: /Reply with a short confirmation/ })
  // Restored catalog children arrive asynchronously; the chevron appears on hover.
  if (!await session.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
    await workspaceRow.hover()
    if (!await session.isVisible()) await workspaceRow.locator('span[class*="chevron"]').click()
  }
  await session.click()
}

test('real configured route wakes one browser-owned verified goal from a durable file event', async ({ page, context }, testInfo) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-web-owner-real-event-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), watched = join(temp, 'watched.json')
  const modelLog = join(temp, 'model.jsonl'), goalsPath = join(home, 'assistant-goals/web.sqlite')
  const deliveryPath = join(home, 'assistant-delivery/state.sqlite'), verifierPath = join(home, 'assistant-verifier/verification.sqlite')
  const eventsPath = join(home, 'event-triggers/state.sqlite'), waitsPath = `${goalsPath}.event-waits`
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_WEB_REAL_LOG: modelLog, DSH_WEB_REAL_WORKSPACE: workspace,
    DSH_WEB_REAL_EVENT: '1', DSH_WEB_REAL_BOOTSTRAP: '1' }
  const approved = [], rejected = [], http = [], transport = [], streams = new Map(), frames = [], contexts = []
  let host, activePage = page, authenticated = false, failed = false, hostStarts = 0
  const stop = async () => {
    if (!host) return
    await host.stop()
    await writeFile(testInfo.outputPath(`host-${hostStarts}.log`), host.log(), { mode: 0o600 })
    host = undefined
  }
  const open = async (fresh = false) => {
    host = await startHost(env); hostStarts += 1
    if (fresh) { const next = await context.browser().newContext(); contexts.push(next); activePage = await next.newPage() }
    observePage(activePage, http, transport, streams, frames)
    try { await activePage.goto(host.url) } catch { throw new Error('Browser launch authentication failed (URL redacted)') }
    await expect(activePage).toHaveURL(`${new URL(host.url).origin}/`)
    authenticated = true
    if (hostStarts === 1) await activePage.getByRole('dialog', { name: 'Internal Testing Notice' })
      .getByRole('button', { name: 'Continue', exact: true }).click()
  }
  const prompt = async value => {
    const composer = activePage.getByLabel(/Describe what you want to build|Message or run a task/)
    await composer.fill(value)
    const response = activePage.waitForResponse(item => new URL(item.url()).pathname === '/api/session/prompt')
    await activePage.getByRole('button', { name: 'Send message', exact: true }).click()
    expect((await response).status()).toBe(200)
  }
  try {
    await mkdir(workspace); await writeFile(watched, '{"revision":0}\n', { mode: 0o600 })
    const route = await prepareRealRoute({ env, home, workspace })
    env.DSH_WEB_REAL_PROVIDER = route.provider; env.DSH_WEB_REAL_MODEL = route.model
    await run('zstd', ['--version'], env)
    const installed = await run('dsh', ['plugin', '--profile', 'web', 'add', ...[
      'personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner',
      'assistant-verifier', 'assistant-evaluation', 'event-triggers', ...(opportunityProfile ? ['assistant-proactive'] : []), ...route.bundles,
    ].map(name => resolve(root, 'plugins', name))], env)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace], env)
    const patchPath = join(home, 'profiles/web/cordis.patch.yml'), patch = parseDocument(await readFile(patchPath, 'utf8'))
    const owner = query(deliveryPath, "SELECT id, version, principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active'")[0]
    if (!owner) throw new Error('setup did not create Web owner')
    const principal = JSON.parse(owner.principal_json)
    expect(principal).toEqual({ channel: 'web', account: 'web', tenant: 'local', user: 'operator' })
    const { createVerifierAuthorities } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-verifier/lib/index.js')).href)
    const authority = { kind: 'runner', id: 'node', executable: process.execPath, fixedArgs: [], timeoutMs: 5_000, maxOutputBytes: 16_384 }
    const [runner] = createVerifierAuthorities({ authorities: [authority] })
    const profile = taskKind => ({ id: `real-event-${taskKind}`, version: 1, scope: { workspace, preset: 'standard' },
      owner: { principalRecordId: owner.id, principalVersion: owner.version }, taskKind, objective, validityMs: 600_000,
      bounds: { maxDurationMs: 15_000, maxEvidenceBytes: 16_384 },
      criteria: (taskKind === 'goal-step' ? criteria.slice(0, 1) : criteria).map(entry => ({ id: entry.id,
        kind: 'process-behavior', authority: { id: runner.id, digest: runner.digest }, artifactPath: 'summarize.mjs',
        stdin: entry.stdin, expectedStdout: entry.expectedStdout, expectedExitCode: 0 })),
    })
    const expiresAt = Date.now() + 540_000
    // Approval must bind the event wait to the exact durable business Goal and
    // native revision observed immediately before the browser clicks Allow once.
    // The generic guard intentionally cannot know this runtime-generated ID.
    const allowedEventApproval = (name, args, allowedWorkspace) => {
      if (!isEventExperimentToolAllowed(name, args, allowedWorkspace, opportunityProfile)) return false
      if (name !== 'goal_wait_event') return true
      const current = query(goalsPath, 'SELECT id, native_json FROM goal_records')[0]
      if (!current) return false
      const currentNative = JSON.parse(current.native_json)
      return args.goal_id === current.id && args.expected_revision === currentNative.revision
        && args.expires_at === expiresAt
    }
    setConfig(patch, 'dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', {
      databasePath: goalsPath, eventWaits: true, verifyNativeRounds: true, verifyGoalOutcome: true,
      stepMaxDurationMs: 120_000, preauthorizedCreateMaxRounds: 2, preauthorizedSchedule: true,
      executionBudget: { mode: 'calls', modelCalls: 6, toolCalls: 6, durationMs: 600_000, maxOutputTokensPerCall: 2048,
        routes: [{ provider: route.provider, model: route.model }] },
      backgroundWake: { ownerRouteId: 'real-event-owner', budgetId: 'real-event-goal-runs', maxDelayMs: 600_000, runTimeoutMs: 120_000 },
    })
    if (opportunityProfile) setConfig(patch, 'dsh-enhanced-assistant-proactive', '@dsh-enhanced/assistant-proactive', {
      databasePath: join(home, 'assistant-proactive/opportunities.sqlite'),
      profiles: [{ id: opportunityProfile, mode: reminderMode ? 'remind' : 'execute', expectedBenefit: 100, successPpm: 900_000, executionCost: 10, interruptionCost: 5, possibleLoss: 5, minimumUtility: 1, mergeWindowMs: 2000, cooldownMs: 1000, rejectionCooldownMs: 60_000, maxDecisionsPerGoal: 4, maxExecutionsPerGoal: reminderMode ? 0 : 1, maxRemindersPerGoal: reminderMode ? 1 : 0 }],
    })
    setConfig(patch, 'dsh-enhanced-assistant-web-owner', '@dsh-enhanced/assistant-web-owner', { maxExecutionMs: 300_000 })
    setConfig(patch, 'dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', {
      databasePath: verifierPath, tickIntervalMs: 500, requireAcceptance: false, authorities: [authority],
      profiles: [profile('goal-step'), profile('goal-outcome')],
    })
    setNestedConfig(patch, 'dsh-enhanced-personal-assistant', 'assistantAutomations', {
      databasePath: join(home, 'assistant-automations/events.sqlite'), runsPath: join(temp, 'automation-runs'),
      schedulerEnabled: true, tickIntervalMs: 1_000, reconcileIntervalMs: 0,
    })
    setConfig(patch, 'dsh-enhanced-event-triggers', '@dsh-enhanced/event-triggers', {
      databasePath: eventsPath, allowedFileRoots: [temp], pollerEnabled: true, pollIntervalMs: 1_000,
      triggers: [{ id: 'file', automationId: sourceAutomationId, kind: 'file', path: watched, fireWhen: 'changed', mode: 'content-hash', debounceMs: 0, maxFires: 10 }],
    })
    appendNestedConfig(patch, 'dsh-enhanced-personal-assistant', 'assistantPolicy', 'budgets', [{ id: 'real-event-source-runs', metric: 'automation-runs', limit: 2, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' }, { id: 'real-event-goal-runs', metric: 'automation-runs', limit: 3, periodMs: Number.MAX_SAFE_INTEGER, scope: 'global' }])
    appendNestedConfig(patch, 'dsh-enhanced-personal-assistant', 'assistantPolicy', 'rules', [
      { id: 'real-event-opportunity-reminder', effect: 'allow', subject: { kind: 'background', id: 'assistant-proactive/v1', workspace, principal: 'web/web/local/operator' }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
      { id: 'real-event-owner-wait', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['wait-for-event'], resource: { kind: 'automation', id: sourceAutomationId }, context: { initiators: ['external'] } },
      { id: 'real-event-background-wait', effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace, principal: 'web/web/local/operator' }, actions: ['wait-for-event'], resource: { kind: 'automation', id: sourceAutomationId }, context: { initiators: ['background'] } },
      { id: 'real-event-background-goal', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['observe', 'inspect', 'snapshot', 'execute', 'reply'], resource: { kind: '*', id: '*' }, context: { initiators: ['background'] } },
      { id: 'real-event-source-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file' }, actions: ['observe'], resource: { kind: 'filesystem', id: watched }, context: { initiators: ['background'] } },
      { id: 'real-event-source-ingest', effect: 'allow', subject: { kind: 'external', id: 'event-triggers:file', workspace }, actions: ['ingest'], resource: { kind: 'automation', id: sourceAutomationId }, context: { initiators: ['external'] } },
      { id: 'real-event-source-reconcile', effect: 'allow', subject: { kind: 'background', id: 'web-owner-real-event-source/v1', workspace, principal: 'web/web/local/operator' }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: sourceAutomationId }, context: { initiators: ['background'] } },
      { id: 'real-event-source-execute', effect: 'allow', subject: { kind: 'background', id: sourceAutomationId, workspace, principal: 'web/web/local/operator' }, actions: ['execute'], resource: { kind: 'automation', id: sourceAutomationId }, context: { initiators: ['background'] } },
      { id: 'real-event-goal-automation', effect: 'allow', subject: { kind: 'background', id: '*', workspace, principal: 'web/web/local/operator' }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: 'goal-event-wake-*' }, context: { initiators: ['background'] } },
      { id: 'real-event-goal-resume', effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace, principal: 'web/web/local/operator' }, actions: ['wake'], resource: { kind: 'goal', id: '*' }, context: { initiators: ['background'] } },
      { id: 'real-event-goal-send', effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace, principal: 'web/web/local/operator' }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    ])
    route.configurePatch(patch, setConfig)
    patch.contents.add(patch.createNode({ id: 'session-title-llm', disabled: true }))
    patch.contents.add(patch.createNode({ insert: [{ id: 'web-owner-real-guard', name: resolve(root, 'scripts/e2e/web-owner-real-guard.mjs') },
      { id: 'web-owner-real-event-bootstrap', name: resolve(root, 'scripts/e2e/web-owner-real-event-bootstrap.mjs') }] }))
    await writeFile(patchPath, String(patch), { mode: 0o600 })

    // The first Host binds one genuine browser owner session. Bootstrap has an empty tool plane.
    await open()
    await prompt('Reply with a short confirmation that this browser session is ready for a later authorized task. Do not use tools.')
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases')[0]?.state).toBe('released')
    expect(query(deliveryPath, "SELECT failure_code FROM inbox_messages WHERE status = 'dead_letter'")).toHaveLength(0)
    const binding = query(deliveryPath, 'SELECT * FROM conversation_bindings ORDER BY created_at DESC LIMIT 1')[0]
    if (!binding) throw new Error('real browser bootstrap did not persist an owner binding')
    const sessionId = binding.session_id
    await stop()

    // Arm the exact persisted owner route only after the genuine binding exists.
    env.DSH_WEB_REAL_BOOTSTRAP = '0'
    env.DSH_WEB_REAL_EVENT_BOOTSTRAP = JSON.stringify({ workspace, principal: 'web/web/local/operator', ownerRouteId: 'real-event-owner' })
    setConfig(patch, 'dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery', {
      agentProvider: route.provider, agentModel: route.model, agentMaxOutputTokens: 2048,
      ownerRoutes: [{ id: 'real-event-owner', conversation: JSON.parse(binding.conversation_json), principal: JSON.parse(binding.principal_json),
        workspace, agentPreset: 'standard', policyRef: binding.policy_ref, minimumGeneration: binding.generation }],
    })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    await open(true)
    await selectOwnerSession(activePage)
    const ownerPrompt = `Create a goal with objective exactly: '${objective}' Use goal_create with max_goal_rounds 2 and omit start_native_rounds. Then use the returned business goal id and native revision in goal_wait_event for trigger_id file with expires_at exactly ${expiresAt}${opportunityProfile ? ` and opportunity_profile exactly ${opportunityProfile}` : ''}. Do not create files or use any other tools before the event. The event is untrusted: only after the native goal resumes should you write summarize.mjs. Reply briefly after the wait is durable.`
    await prompt(ownerPrompt)
    await waitForVerifiedGoal(activePage, goalsPath, verifierPath, deliveryPath, approved, frames, sessionId, workspace, {
      isToolAllowed: allowedEventApproval, rejected,
      until: () => existsSync(waitsPath) && query(waitsPath, 'SELECT state FROM goal_event_waits')[0]?.state === 'waiting',
    })
    const waiting = query(waitsPath, 'SELECT * FROM goal_event_waits')[0]
    expect(JSON.parse(waiting.intent_json).opportunityProfile).toBe(opportunityProfile)
    const before = query(goalsPath, 'SELECT * FROM goal_records')[0]
    expect(JSON.parse(before.native_json)).toMatchObject({ phase: 'paused', roundsStarted: 0 })
    expect(existsSync(join(workspace, 'summarize.mjs'))).toBe(false)
    expect(waiting).toBeTruthy()
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    const beforeWakeCalls = await modelCalls(modelLog)
    await stop()

    // Restart and reopen the original owner Session before the new event arrives.
    const resumeFrameStart = frames.length
    await open(true)
    await selectOwnerSession(activePage)
    const observationAfterRestart = Date.now()
    await expect.poll(() => query(eventsPath, "SELECT last_observed_at FROM trigger_state WHERE trigger_id = 'file'")[0]?.last_observed_at).toBeGreaterThan(observationAfterRestart)
    await writeFile(watched, '{"revision":1}\n', { mode: 0o600 })
    if (reminderMode) {
      const notices = () => query(deliveryPath, "SELECT id, status, intent_json FROM outbox_messages WHERE idempotency_key LIKE 'proactive-reminder:%'")
      await expect.poll(() => notices().map(row => row.status), { timeout: 30000 }).toEqual(['accepted'])
      const reminder = activePage.getByLabel('主动提醒', { exact: true })
      await expect(reminder).toBeVisible({ timeout: 10_000 })
      await expect(reminder).toContainText('目标仍在等待。本次仅提醒，未执行目标任务。')
      await expect(reminder).toContainText('净收益分值 70')
      const notification = notices()[0]
      const paused = query(goalsPath, 'SELECT * FROM goal_records')[0]
      expect(JSON.parse(paused.native_json)).toMatchObject({ phase: 'paused', roundsStarted: 0, sessionId })
      expect(existsSync(join(workspace, 'summarize.mjs'))).toBe(false)
      expect(query(`${goalsPath}.wakes`, 'SELECT * FROM goal_wakes')).toHaveLength(0)
      expect((await modelCalls(modelLog)).filter(row => row.event === 'dispatch')).toEqual(beforeWakeCalls.filter(row => row.event === 'dispatch'))
      const reminderText = JSON.parse(notification.intent_json).text
      await stop(); await open(true); await selectOwnerSession(activePage)
      await expect(activePage.getByLabel('主动提醒', { exact: true })).toContainText(reminderText)
      const observedAfterRestore = Date.now()
      await expect.poll(() => query(eventsPath, "SELECT last_observed_at FROM trigger_state WHERE trigger_id = 'file'")[0]?.last_observed_at).toBeGreaterThan(observedAfterRestore)
      await writeFile(watched, '{"revision":2}\n', { mode: 0o600 })
      await expect.poll(() => readEvents(eventsPath).length, { timeout: 30000 }).toBeGreaterThanOrEqual(2)
      await expect.poll(() => query(join(home, 'assistant-automations/events.sqlite'), "SELECT status FROM automation_runs WHERE automation_id = ?", sourceAutomationId).filter(row => row.status === 'succeeded').length, { timeout: 30000 }).toBeGreaterThanOrEqual(2)
      expect(notices()).toHaveLength(1)
      expect((await modelCalls(modelLog)).filter(row => row.event === 'dispatch')).toEqual(beforeWakeCalls.filter(row => row.event === 'dispatch'))
      await stop()
      const audit = await readSessionAudit(home, workspace, sessionId)
      expect(audit.events.filter(row => row.type === 'tool/call' && ['write', 'edit'].includes(row.data.name))).toHaveLength(0)
      const decisions = query(join(home, 'assistant-proactive/opportunities.sqlite'), 'SELECT payload_json FROM proactive_decisions').map(row => JSON.parse(row.payload_json))
      expect(decisions).toMatchObject([{ mode: 'remind', state: 'decided', utility: 70 }])
      await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ capability: 'durable-owner-web-reminder', ...route.proof, hostStarts, sessionId, goalId: paused.id, native: JSON.parse(paused.native_json), decisions, notices: notices(), modelCalls: await modelCalls(modelLog), approved, rejected, noModelCallsForReminder: true, noGoalExecution: true, visibleBeforeAndAfterRestart: true, duplicateDidNotCreateNotice: true, sourceEvents: readEvents(eventsPath) }, null, 2), { mode: 0o600 })
      await writeFile(testInfo.outputPath('session-audit.json'), JSON.stringify(audit, null, 2), { mode: 0o600 })
      await copyFile(modelLog, testInfo.outputPath('model.jsonl'))
      return
    }
    await waitForVerifiedGoal(activePage, goalsPath, verifierPath, deliveryPath, approved, frames, sessionId, workspace, { isToolAllowed: allowedEventApproval, rejected,
      failure: () => query(`${goalsPath}.wakes`, 'SELECT state FROM goal_wakes').some(row => ['unknown', 'denied'].includes(row.state))
        ? 'Event goal wake terminated without confirmed execution' : undefined,
    })
    const goal = query(goalsPath, 'SELECT * FROM goal_records')[0], native = JSON.parse(goal.native_json), scope = JSON.parse(goal.scope_json)
    const pausedNative = JSON.parse(before.native_json)
    const stepContracts = contracts(verifierPath, 'goal-step'), outcomeContracts = contracts(verifierPath, 'goal-outcome')
    const stepJobs = jobs(verifierPath, stepContracts.map(item => item.id)), outcomeJobs = jobs(verifierPath, outcomeContracts.map(item => item.id))
    expect(native).toMatchObject({ phase: 'complete', roundsStarted: 1 })
    expect({ businessGoalId: goal.id, nativeGoalId: native.goalId, sessionId: native.sessionId }).toEqual({
      businessGoalId: before.id, nativeGoalId: pausedNative.goalId, sessionId,
    })
    expect(scope).toMatchObject({ workspace, preset: 'standard', principalRecordId: owner.id, principalVersion: owner.version })
    expect(stepJobs.some((item, index) => stepContracts[index].contract.task.goal.sessionId === sessionId && item.receipt?.objectiveStatus === 'achieved')).toBe(true)
    expect(outcomeJobs.at(-1)).toMatchObject({ state: 'done', execution: { status: 'succeeded' }, receipt: { objectiveStatus: 'achieved' } })
    await expect.poll(() => query(`${goalsPath}.wakes`, 'SELECT state FROM goal_wakes').map(row => row.state), { timeout: 20_000 }).toEqual(['succeeded'])
    // Web already displays this native Session reply; another outbox would duplicate it.
    expect(query(deliveryPath, "SELECT id FROM outbox_messages WHERE idempotency_key LIKE 'goal-wake-result:%'")).toHaveLength(0)
    const restoredEvents = frames.slice(resumeFrameStart).flatMap(frame => frame.value?.type === 'snapshot' ? frame.value.records
      : frame.value?.type === 'event' ? [frame.value] : []).filter(row => row.type === 'event').map(row => row.event)
    // A blocked driver turn can follow acceptance without a model request.
    // Bind the reply to the actual resumed Goal input, not that empty turn.
    const resumedInput = restoredEvents.findLast(event => event.type === 'user/message'
      && event.data.source?.kind === 'goal' && event.data.source.round === 1)
    const finalTurn = restoredEvents.findLast(event => event.type === 'turn/start' && event.seq < resumedInput?.seq)?.data.turn
    expect(finalTurn).toBeDefined()
    const response = restoredEvents.filter(event => event.type === 'assistant/message' && event.data.turn === finalTurn).map(event => event.data)
      .findLast(data => data.message.content.some(block => block.type === 'text' && block.text.trim()))
    const responseText = response?.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(responseText?.trim().length).toBeGreaterThan(0)
    const visibleReply = responseText.split(/\n\s*\n/u)[0].replace(/[`*_]/gu, '').replace(/\s+/gu, ' ').trim()
    expect(ownerPrompt.replace(/\s+/gu, ' ')).not.toContain(visibleReply)
    await expect(activePage.getByText(visibleReply, { exact: true })).toBeVisible()
    const afterWakeCalls = await modelCalls(modelLog)
    expect(afterWakeCalls.filter(item => item.event === 'dispatch').length).toBeLessThanOrEqual(10)
    expect(afterWakeCalls.filter(item => item.event === 'dispatch').length).toBeGreaterThan(beforeWakeCalls.filter(item => item.event === 'dispatch').length)
    expect(afterWakeCalls.filter(item => item.event === 'dispatch').every(item => item.provider === route.provider && item.model === route.model)).toBe(true)

    // Polling the same bytes, then another real observation, cannot replay the settled wait.
    const eventCount = readEvents(eventsPath).length
    await writeFile(watched, '{"revision":1}\n', { mode: 0o600 })
    const sameBytesAt = Date.now()
    await expect.poll(() => query(eventsPath, "SELECT last_observed_at FROM trigger_state WHERE trigger_id = 'file'")[0]?.last_observed_at, { timeout: 10_000 }).toBeGreaterThan(sameBytesAt)
    expect(readEvents(eventsPath)).toHaveLength(eventCount)
    await writeFile(watched, '{"revision":2}\n', { mode: 0o600 })
    await expect.poll(() => readEvents(eventsPath).length, { timeout: 30_000 }).toBeGreaterThan(eventCount)
    await expect.poll(() => query(join(home, 'assistant-automations/events.sqlite'), "SELECT status FROM automation_runs WHERE automation_id = ? ORDER BY created_at ASC", sourceAutomationId).filter(item => item.status === 'succeeded').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    expect(query(waitsPath, 'SELECT * FROM goal_event_waits')).toHaveLength(1)
    expect(query(`${goalsPath}.wakes`, 'SELECT * FROM goal_wakes')).toHaveLength(1)
    expect((await modelCalls(modelLog)).filter(item => item.event === 'dispatch')).toEqual(afterWakeCalls.filter(item => item.event === 'dispatch'))
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    await stop()

    const audit = await readSessionAudit(home, workspace, sessionId)
    expect(audit.assistantReplies).toContainEqual(expect.objectContaining({ turn: finalTurn, text: responseText }))
    const create = audit.events.find(item => item.type === 'tool/call' && item.data.name === 'goal_create')
    const wait = audit.events.find(item => item.type === 'tool/call' && item.data.name === 'goal_wait_event')
    expect(create?.data.arguments).toMatchObject({ objective, max_goal_rounds: 2 })
    expect([undefined, false]).toContain(create?.data.arguments.start_native_rounds)
    expect(wait?.data.arguments).toMatchObject({ trigger_id: 'file', expires_at: expiresAt })
    const writes = audit.events.filter(item => item.type === 'tool/call' && ['write', 'edit'].includes(item.data.name))
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      const start = audit.events.findLast(item => item.type === 'turn/start' && item.seq < write.seq)
      expect(audit.events.some(item => item.seq > start.seq && item.seq < write.seq && item.type === 'user/message'
        && item.data.source?.kind === 'goal' && item.data.source.round > 0)).toBe(true)
    }
    await writeFile(testInfo.outputPath('session-audit.json'), JSON.stringify(audit, null, 2), { mode: 0o600 })
    await copyFile(join(workspace, 'summarize.mjs'), testInfo.outputPath('summarize.mjs'))
    await copyFile(modelLog, testInfo.outputPath('model.jsonl'))
    const opportunities = opportunityProfile ? query(join(home, 'assistant-proactive/opportunities.sqlite'), 'SELECT payload_json FROM proactive_decisions').map(row => JSON.parse(row.payload_json)) : []
    if (opportunityProfile) {
      expect(opportunities).toHaveLength(1)
      expect(opportunities[0]).toMatchObject({ mode: 'execute', state: 'decided', reason: 'execution', utility: 70, goalId: goal.id, sessionId, profileId: opportunityProfile })
      expect(opportunities[0].updatedAt - opportunities[0].firstObservedAt).toBeGreaterThanOrEqual(2000)
    }
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ objective, noModelFixture: true,
      ordinarySourceAutomation: 'test-noop-host-executor', resultDelivery: 'durable-native-session', ...route.proof,
      hostStarts, opportunities, sessionId, goalId: goal.id, native, scope, expiresAt, approved, rejected, sourceEvents: readEvents(eventsPath),
      wait: query(waitsPath, 'SELECT * FROM goal_event_waits')[0], goalWakes: query(`${goalsPath}.wakes`, 'SELECT * FROM goal_wakes'),
      outbox: query(deliveryPath, "SELECT idempotency_key, status FROM outbox_messages WHERE idempotency_key LIKE 'goal-wake-result:%'"),
      modelCalls: await modelCalls(modelLog), stepContracts, stepJobs, outcomeContracts, outcomeJobs,
      artifactSha256: createHash('sha256').update(await readFile(join(workspace, 'summarize.mjs'))).digest('hex'),
    }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    try {
      await writeFile(testInfo.outputPath('approvals.json'), JSON.stringify(approved, null, 2), { mode: 0o600 })
      if (existsSync(modelLog)) await copyFile(modelLog, testInfo.outputPath('model.jsonl'))
      if (existsSync(join(workspace, 'summarize.mjs'))) await copyFile(join(workspace, 'summarize.mjs'), testInfo.outputPath('summarize.mjs'))
      if (failed && authenticated && !new URL(activePage.url()).searchParams.has('token')) {
        await activePage.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {})
        await writeFile(testInfo.outputPath('failure-dom.txt'), sanitize(await activePage.locator('body').innerText().catch(() => '')), { mode: 0o600 })
      }
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
    } finally {
      await stop()
      if (failed) {
        await writeFile(testInfo.outputPath('failure-frames.json'), JSON.stringify(frames, null, 2), { mode: 0o600 })
        for (const directory of ['sessions', 'assistant-goals', 'assistant-delivery', 'assistant-automations', 'event-triggers']) {
          if (existsSync(join(home, directory))) await cp(join(home, directory), testInfo.outputPath(`state-${directory}`), { recursive: true })
        }
      }
      for (const item of contexts) await item.close()
      await rm(temp, { recursive: true, force: true })
    }
  }
})
