import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument, isMap, isSeq } from 'yaml'
import { objective, criteria, setConfig, contracts, jobs } from './web-owner-real-helpers.mjs'
import { selectRestoredSession } from './repo-session-navigation.mjs'
import { readSessionAudit } from './web-owner-real-audit.mjs'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'
import { fileObservationSteps, instantiate } from '../../plugins/assistant-skills/lib/definition.js'
import { canaryPolicy, createProspectiveCanaryAuthority } from './real-canary-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

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

function sourceNativeTurnAfterCapture(audit, capture) {
  const calls = audit.events.filter(event => event.type === 'tool/call' && event.data.name === 'skill_capture'
    && event.data.arguments.goal_id === capture.goalId)
  const results = audit.events.filter(event => event.type === 'tool/result' && event.data.isError === false)
  const registered = calls.find(call => results.some(result => result.data.callId === call.data.callId))
  expect(registered, 'durable capture must have a successful matching native tool result').toBeDefined()
  const settled = results.find(result => result.data.callId === registered.data.callId)
  for (const start of audit.events.filter(event => event.type === 'turn/start' && event.seq > settled.seq)) {
    const end = audit.events.find(event => event.type === 'turn/end' && event.data.turn === start.data.turn && event.seq > start.seq)
    const source = audit.events.find(event => event.type === 'user/message' && event.seq > start.seq && event.seq < end?.seq
      && event.data.source.goalId === capture.nativeGoalId)
    if (source) return { registered, settled, start, end, source }
  }
  throw new Error('successful capture did not hand off to its exact native goal turn')
}

function assertCaptureHandoff(audit, capture) {
  const handoff = sourceNativeTurnAfterCapture(audit, capture)
  expect(handoff.registered.data.arguments.start_native_rounds, 'the owner authorized immediate execution and capture').toBe(true)
  const interveningBusinessCalls = audit.events.filter(event => event.type === 'tool/call'
    && event.seq > handoff.settled.seq && event.seq < handoff.start.seq)
  expect(interveningBusinessCalls, 'the owner turn must hand off directly; business work belongs to the native goal turn').toEqual([])
  return handoff
}

test('ordinary owner request captures an accepted workflow and reuses it after restart', async ({ page, context }, testInfo) => {
  const prospectiveCanary = testInfo.config.metadata?.prospectiveCanary === true
  const temp = await mkdtemp(join(tmpdir(), 'dsh-real-capture-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), modelLog = join(temp, 'model.jsonl')
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_REPO_AUTONOMY_OBSERVER_LOG: modelLog,
    DSH_REPO_AUTONOMY_MAX_CALLS: prospectiveCanary ? '32' : '24', DSH_REPO_AUTONOMY_DURATION_MS: prospectiveCanary ? '600000' : '360000' }
  const deliveryPath = join(home, 'assistant-delivery/state.sqlite'), goalsPath = join(home, 'assistant-goals/web.sqlite')
  const verifierPath = join(home, 'assistant-verifier/verification.sqlite'), skillsPath = join(home, 'assistant-skills/skills.sqlite')
  const frames = [], approved = new Set(), bootstrapRejected = new Set(), contexts = [], transport = []
  let host, activePage = page, starts = 0, failed = false, sessionId, sourceAudit, sourceArtifact
  const stop = async () => { if (host) { await host.stop(); await writeFile(testInfo.outputPath(`host-${starts}.log`), host.log(), { mode: 0o600 }); await writeFile(join(temp, `host-${starts}.log`), host.log(), { mode: 0o600 }); host = undefined } }
  const open = async () => {
    host = await startHost(env); starts++
    if (starts > 1) { const next = await context.browser().newContext(); contexts.push(next); activePage = await next.newPage() }
    observePage(activePage, [], transport, new Map(), frames)
    await activePage.goto(host.url).catch(() => { throw new Error('capture browser authentication failed (URL redacted)') })
    await expect(activePage).toHaveURL(`${new URL(host.url).origin}/`)
    if (starts === 1) await activePage.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
    else await selectRestoredSession(activePage, /Confirm this session is ready/)
  }
  const prompt = async text => {
    await activePage.getByLabel(/Describe what you want to build|Message or run a task/).fill(text)
    const response = activePage.waitForResponse(item => new URL(item.url()).pathname === '/api/session/prompt')
    await activePage.getByRole('button', { name: 'Send message', exact: true }).click()
    expect((await response).status()).toBe(200)
  }
  const approve = async () => {
    const button = activePage.getByRole('button', { name: 'Allow once', exact: true })
    if (!await button.isVisible()) return
    const pending = new Map()
    for (const frame of frames) {
      const value = frame.value
      if (value?.type === 'waterfall' && value.event === 'approval/request') pending.set(value.eventId, value)
      if (value?.type === 'cancel') pending.delete(value.eventId)
    }
    const request = [...pending.values()].find(value => !approved.has(value.eventId))
    if (!request) return
    if (sessionId === undefined) {
      // The readiness message authorizes no work. Respond to an unsolicited
      // approval as the owner would, without granting a setup-time action.
      const bindings = query(deliveryPath, 'SELECT session_id FROM conversation_bindings WHERE session_id = ?', request.agentId)
      if (bindings.length !== 1 || bootstrapRejected.size >= 1 || request.request?.toolName !== 'goal_create'
        || typeof request.request?.callId !== 'string' || request.request.callId.length === 0) throw new Error('unexpected repeated, foreign or unsupported bootstrap approval')
      bootstrapRejected.add(request.eventId); approved.add(request.eventId)
      transport.push({ kind: 'bootstrap-approval-rejected', toolName: request.request?.toolName })
      await activePage.getByRole('button', { name: 'Reject', exact: true }).click()
      return
    }
    let event = frames.findLast(frame => frame.value?.event?.type === 'tool/call' && frame.value.event.data.callId === request.request?.callId)?.value.event
    let nested
    if (!event) {
      const match = /^(.*):skill(-observation)?:([1-9][0-9]*)$/u.exec(request.request?.callId ?? '')
      const parent = match && frames.findLast(frame => frame.value?.event?.type === 'tool/call' && frame.value.event.data.callId === match[1])?.value.event
      if (!parent || !['skill_trial', 'skill_run'].includes(parent.data.name)) throw new Error('approval has no matching direct call or skill parent')
      const args = JSON.parse(parent.data.arguments)
      const runs = query(skillsPath, 'SELECT run_json FROM skill_runs').map(row => JSON.parse(row.run_json))
      const active = runs.filter(value => value.state === 'running' && value.sessionId === sessionId
        && value.goalId === args.goal_id && value.invocationId === args.invocation_id
        && (parent.data.name === 'skill_trial' ? value.candidateId === args.candidate_id : value.skillName === args.name && value.version === args.version))
      if (active.length !== 1 || JSON.stringify(active[0].inputs) !== JSON.stringify(JSON.parse(args.inputs_json ?? '{}'))) throw new Error('nested approval does not identify one exact running trial')
      const definition = parent.data.name === 'skill_trial'
        ? (() => { const row = query(skillsPath, 'SELECT candidate_json FROM skill_candidates WHERE id = ?', args.candidate_id)[0]; const candidate = row && JSON.parse(row.candidate_json); if (!candidate || candidate.state !== 'pending') throw new Error('nested approval candidate is not current'); return candidate.definition })()
        : (() => { const row = query(skillsPath, 'SELECT definition_json FROM skill_definitions WHERE name = ? AND version = ?', args.name, args.version)[0]; if (!row) throw new Error('nested approval definition is not exact active version'); return JSON.parse(row.definition_json) })()
      if (definition.retired || definition.source.scope.workspace !== workspace || definition.source.scope.preset !== 'standard') throw new Error('nested approval definition is retired or outside the exact owner scope')
      const materialized = instantiate(definition, active[0].inputs)
      const savedStep = materialized.steps[Number(match[3]) - 1]
      const observation = match[2] && savedStep && fileObservationSteps(materialized).find(value => value.beforeStepId === savedStep.id)
      const step = match[2] ? observation && { id: observation.id, toolName: 'read', arguments: { file_path: observation.filePath, limit: 1 } } : savedStep
      if (!step || step.toolName !== request.request.toolName) throw new Error('nested approval does not match its stored skill step')
      event = { data: { name: step.toolName, arguments: JSON.stringify(step.arguments) } }
      nested = { parentCallId: parent.data.callId, runId: active[0].id, stepId: step.id }
    }
    const args = JSON.parse(event.data.arguments)
    const name = event.data.name
    if (name !== request.request?.toolName) throw new Error('approval tool identity mismatch')
    const file = args.file_path
    const safeFile = ['read', 'write', 'edit'].includes(name) && typeof file === 'string' && resolve(workspace, file) === join(workspace, 'summarize.mjs')
    const safeSearch = ['glob', 'grep'].includes(name) && typeof args.path === 'string' && resolve(workspace, args.path) === workspace
    const safeControl = ['get_goal', 'todo_write', 'goal_create', 'goal_context', 'goal_checkpoint', 'skill_capture', 'skill_captures', 'skill_status', 'skill_candidates', 'skill_trial', 'skill_activate', 'skill_canary', 'skill_deployment_status', 'skill_comparison_status', 'skill_watches', 'skill', 'skill_run'].includes(name)
    if ((!safeFile && !safeSearch && !safeControl) || request.agentId !== sessionId) throw new Error(`unexpected capture experiment approval: ${name}`)
    approved.add(request.eventId)
    if (nested) transport.push({ kind: 'verified-nested-approval', callId: request.request.callId, toolName: name, ...nested })
    await button.click()
  }
  const wait = async (predicate, description) => {
    await expect.poll(async () => {
      const dead = query(deliveryPath, "SELECT failure_code FROM inbox_messages WHERE status = 'dead_letter'")[0]
      if (dead) throw new Error(`capture owner input failed: ${dead.failure_code}`)
      await approve()
      const terminal = captured().find(row => !['pending', 'captured'].includes(row.state))
      if (terminal) throw new Error(`automatic capture ${terminal.state}: ${terminal.detail ?? 'no detail'}`)
      const failedRun = query(skillsPath, 'SELECT run_json FROM skill_runs').map(row => JSON.parse(row.run_json)).find(run => ['failed', 'unknown'].includes(run.state))
      if (failedRun) throw new Error(`skill invocation ${failedRun.state}: ${failedRun.steps.at(-1)?.detail ?? 'unsettled execution'}`)
      return await predicate()
    }, { message: description, timeout: 180000, intervals: [200, 500, 1000] }).toBeTruthy()
  }
  const idle = () => {
    const lease = sessionId
      ? query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]
      : query(deliveryPath, 'SELECT state FROM delivery_session_leases ORDER BY rowid DESC LIMIT 1')[0]
    return lease?.state === 'released' && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status NOT IN ('processed', 'dead_letter')").length === 0
  }
  const goalOutcome = goalId => {
    const outcome = contracts(verifierPath, 'goal-outcome').findLast(row => row.contract.task?.goal?.id === goalId)
    return outcome ? jobs(verifierPath, [outcome.id])[0] : undefined
  }
  const captured = () => query(skillsPath, 'SELECT capture_json FROM skill_captures').map(row => JSON.parse(row.capture_json))
  try {
    await mkdir(workspace)
    const route = await prepareRealRoute({ env, home, workspace }); env.DSH_WEB_REAL_PROVIDER = route.provider; env.DSH_WEB_REAL_MODEL = route.model
    const install = await run('dsh', ['plugin', '--profile', 'web', 'add', ...[
      'personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-skills', ...(prospectiveCanary ? ['assistant-isolation'] : []), 'assistant-web-owner', 'assistant-verifier', 'assistant-evaluation', ...route.bundles,
    ].map(name => resolve(root, 'plugins', name))], env)
    await writeFile(testInfo.outputPath('install.log'), sanitize(install), { mode: 0o600 })
    await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace], env)
    const owner = query(deliveryPath, "SELECT id, version FROM delivery_principals WHERE role = 'owner' AND status = 'active'")[0]
    const { createVerifierAuthorities } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-verifier/lib/index.js')).href)
    const authority = { kind: 'runner', id: 'node', executable: process.execPath, fixedArgs: [], timeoutMs: 5000, maxOutputBytes: 16384 }
    const [runner] = createVerifierAuthorities({ authorities: [authority] })
    const profile = taskKind => ({ id: `capture-${taskKind}`, version: 1, scope: { workspace, preset: 'standard' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, taskKind, objective, validityMs: 600000,
      bounds: { maxDurationMs: 15000, maxEvidenceBytes: 16384 }, criteria: (taskKind === 'goal-step' ? criteria.slice(0, 1) : criteria).map(entry => ({ id: entry.id, kind: 'process-behavior', authority: { id: runner.id, digest: runner.digest }, artifactPath: 'summarize.mjs', stdin: entry.stdin, expectedStdout: entry.expectedStdout, expectedExitCode: 0 })) })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml'), patch = parseDocument(await readFile(patchPath, 'utf8'))
    setConfig(patch, 'dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', { databasePath: goalsPath, preauthorizedCreateMaxRounds: 3, verifyNativeRounds: true, verifyGoalOutcome: true, stepMaxDurationMs: 120000, executionBudget: { mode: 'calls', modelCalls: 8, toolCalls: 12, durationMs: 300000, maxOutputTokensPerCall: 4096, routes: [{ provider: route.provider, model: route.provider === 'codex-subscription' ? 'default' : route.model }] } })
    setConfig(patch, 'dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', { databasePath: skillsPath, allowedTools: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'get_goal'], maxDurationMs: 60000 })
    setConfig(patch, 'dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', { databasePath: verifierPath, tickIntervalMs: 500, requireAcceptance: false, authorities: [authority], profiles: [profile('goal-step'), profile('goal-outcome')] })
    if (prospectiveCanary) setConfig(patch, 'dsh-enhanced-assistant-isolation', '@dsh-enhanced/assistant-isolation', { stateRoot: join(home, 'assistant-isolation') })
    setConfig(patch, 'dsh-enhanced-assistant-web-owner', '@dsh-enhanced/assistant-web-owner', { maxExecutionMs: 300000 })
    appendPolicy(patch, [
      { id: 'capture-owner', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['inspect', 'capture', 'trial', 'activate', 'run'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['external'] } },
      { id: 'capture-background', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-skills', workspace, principal: 'web/web/local/operator' }, actions: ['capture'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['background'] } },
    ])
    if (prospectiveCanary) appendPolicy(patch, canaryPolicy(workspace))
    route.configurePatch(patch, setConfig)
    patch.contents.add(patch.createNode({ id: 'session-title-llm', disabled: true }))
    patch.contents.add(patch.createNode({ insert: [{ id: 'capture-observer', name: resolve(root, 'scripts/e2e/repo-autonomy-observer.mjs') }] }))
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    await open()
    await prompt('Confirm this session is ready for a later authorized task. No work is needed yet.')
    await wait(idle, 'bootstrap settlement')
    expect(query(goalsPath, 'SELECT id FROM goal_records'), 'readiness grants no goal work').toHaveLength(0)
    expect(captured(), 'readiness grants no capture').toHaveLength(0)
    const binding = query(deliveryPath, 'SELECT * FROM conversation_bindings ORDER BY created_at DESC LIMIT 1')[0]
    sessionId = binding.session_id
    await stop()
    setConfig(patch, 'dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery', { ownerRoutes: [{ id: 'capture-owner', conversation: JSON.parse(binding.conversation_json), principal: JSON.parse(binding.principal_json), workspace, agentPreset: 'standard', policyRef: binding.policy_ref, minimumGeneration: binding.generation }] })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    await open()
    const sourceBefore = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
    await prompt(`${objective} Complete this as a finite autonomous goal. Before starting the goal work, I authorize automatic capture of its successful workflow as a pending skill candidate named order-summary, using my configured owner route capture-owner, for the next ten minutes. This is a new skill with no parent version. Do not enable the candidate until I request it. Work only on summarize.mjs in this workspace; no shell or external actions are authorized.`)
    await wait(() => {
      if (idle() && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > sourceBefore && !captured().length) throw new Error('Owner turn ended without registering the requested capture')
      return captured().length === 1
    }, 'owner capture registration')
    const initial = captured()[0]
    await wait(() => captured()[0]?.state === 'captured' && idle(), 'automatic candidate after independent acceptance')
    const capture = captured()[0], firstGoal = goalOutcome(capture.goalId)
    expect(firstGoal?.receipt?.objectiveStatus).toBe('achieved')
    expect(query(skillsPath, 'SELECT * FROM skill_definitions')).toHaveLength(0)
    const candidate = JSON.parse(query(skillsPath, 'SELECT candidate_json FROM skill_candidates WHERE id = ?', capture.candidateId)[0].candidate_json)
    expect(candidate).toMatchObject({ id: capture.candidateId, state: 'pending', definition: { source: { goal: { id: capture.goalId, nativeGoalId: capture.nativeGoalId } } } })
    expect(candidate.definition.steps.some(step => ['write', 'edit'].includes(step.toolName)
      && typeof step.arguments?.file_path === 'string' && resolve(workspace, step.arguments.file_path) === join(workspace, 'summarize.mjs')
      && typeof (step.toolName === 'write' ? step.arguments.content : step.arguments.new_string) === 'string'
      && (step.toolName === 'write' ? step.arguments.content : step.arguments.new_string).length > 0), 'captured source must retain the successful summarize.mjs implementation step').toBe(true)
    sourceArtifact = await readFile(join(workspace, 'summarize.mjs'), 'utf8')
    const sourceHash = createHash('sha256').update(sourceArtifact).digest('hex')
    await stop()
    sourceAudit = await readSessionAudit(home, workspace, sessionId)
    const sourceHandoff = assertCaptureHandoff(sourceAudit, capture)
    await rm(join(workspace, 'summarize.mjs')); await open()
    expect(captured()).toHaveLength(1); expect(captured()[0].candidateId).toBe(capture.candidateId)
    await prompt(`${objective} The file was removed for a fresh task. Reuse the pending order-summary candidate to restore it in a new finite goal, and have the result independently verified. Do not recreate the implementation yourself or enable the candidate yet.`)
    await wait(() => query(skillsPath, 'SELECT run_json FROM skill_runs').some(row => JSON.parse(row.run_json).state === 'succeeded') && idle(), 'candidate reuse in a new goal')
    const trial = JSON.parse(query(skillsPath, 'SELECT run_json FROM skill_runs ORDER BY rowid DESC LIMIT 1')[0].run_json)
    await wait(() => goalOutcome(trial.goalId)?.receipt?.objectiveStatus === 'achieved', 'fresh independent reuse acceptance')
    expect(trial.goalId).not.toBe(capture.goalId)
    expect(trial.candidateId).toBe(capture.candidateId)
    expect(createHash('sha256').update(await readFile(join(workspace, 'summarize.mjs'))).digest('hex')).toBe(sourceHash)
    const activationBefore = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
    await prompt('The trial succeeded. Enable the independently verified order-summary candidate for future reuse.')
    await wait(() => {
      const enabled = query(skillsPath, 'SELECT * FROM skill_definitions').length === 1
      if (!enabled && idle() && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > activationBefore) throw new Error('owner activation request settled without enabling the independently accepted candidate')
      return enabled && idle()
    }, 'owner activation after independent trial')
    const activeBaseline = query(skillsPath, 'SELECT definition_json FROM skill_definitions')[0].definition_json
    let canary
    if (prospectiveCanary) {
      const beforeImprove = new Set(captured().map(value => value.id))
      const newCaptures = () => captured().filter(value => !beforeImprove.has(value.id))
      await prompt(`${objective} Start one finite review goal for the same order-summary task. I authorize automatic capture of one pending candidate named order-summary with parent version 1 using owner route capture-owner for ten minutes. Make only a real improvement if one is warranted; preserve the same schema and accepted task, and do not activate it manually.`)
      await wait(() => newCaptures().length === 1 && newCaptures()[0]?.state === 'captured' && idle(), 'independently accepted improvement capture')
      const improvement = newCaptures()[0], candidate2 = JSON.parse(query(skillsPath, 'SELECT candidate_json FROM skill_candidates WHERE id = ?', improvement.candidateId)[0].candidate_json)
      expect(candidate2).toMatchObject({ state: 'pending', parentVersion: 1 })
      await stop()
      const canaryAuthority = await createProspectiveCanaryAuthority({ root: temp, home, workspace })
      const canaryProfile = canaryAuthority.profile(owner, sourceArtifact)
      setConfig(patch, 'dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', { databasePath: skillsPath, allowedTools: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'get_goal'], maxDurationMs: 60000, externalHoldouts: [canaryProfile] })
      await writeFile(patchPath, String(patch), { mode: 0o600 }); await open()
      const beforeCanary = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
      await prompt(`For pending candidate ${candidate2.id}, I authorize one configured prospective v2 comparison and, only if all gates show a real improvement, a finite canary with at most two uses and one initial canary use. Use owner route capture-owner and an absolute expiry before ${new Date(canaryProfile.execution.expiresAt - 1000).toISOString()}. Do not manually activate it; report the deployment status.`)
      await wait(() => {
        const comparison = query(skillsPath, 'SELECT comparison_json FROM skill_comparisons').map(row => JSON.parse(row.comparison_json)).find(value => value.candidateId === candidate2.id)
        const deployment = query(skillsPath, 'SELECT deployment_json FROM skill_deployments').map(row => JSON.parse(row.deployment_json)).find(value => value.candidateId === candidate2.id)
        if (comparison?.state === 'unknown') throw new Error('canary qualification became unknown and must not be replayed')
        if (comparison?.state === 'complete') { canary = { candidate: candidate2, comparison, deployment }; return idle() }
        if (idle() && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > beforeCanary) throw new Error('ordinary canary request settled without one completed comparison')
        return false
      }, 'one prospective canary comparison')
      expect(canary.comparison.result?.prospectiveHoldout).toBe('authority-attested-after-freeze')
      const quality = canary.comparison.result?.quality
      const eligible = quality?.candidateChecksPassed === true && quality?.evaluationGainObserved === true && quality?.criticalRegressionsPassed === true
      if (!eligible) {
        expect(canary.comparison).toMatchObject({ state: 'complete', candidateId: candidate2.id, parentDigest: candidate2.parentDigest })
        expect(canary.comparison.result?.receipt?.complete).toBe(true)
        expect(canary.comparison.result?.receipt?.cellVerdicts.every(value => value.verdict !== 'unknown')).toBe(true)
        expect(canary.deployment).toBeUndefined()
        expect(query(skillsPath, 'SELECT definition_json FROM skill_definitions')).toEqual([{ definition_json: activeBaseline }])
      } else {
        expect(canary.deployment).toMatchObject({ state: 'canary', maxRuns: 2, canaryRuns: 1 })
        await rm(join(workspace, 'summarize.mjs'))
        await prompt(`${objective} The artifact was removed. Reuse active order-summary version ${canary.deployment.version} once in a fresh goal, do not recreate it, and wait for independent acceptance.`)
        await wait(() => {
          const run = query(skillsPath, 'SELECT run_json FROM skill_runs').map(row => JSON.parse(row.run_json)).find(value => value.skillName === 'order-summary' && value.version === canary.deployment.version && value.state === 'succeeded')
          return !!run && goalOutcome(run.goalId)?.receipt?.objectiveStatus === 'achieved' && idle()
        }, 'fresh canary native run and independent goal acceptance')
        await wait(() => query(skillsPath, 'SELECT deployment_json FROM skill_deployments WHERE id = ?', canary.deployment.id).map(row => JSON.parse(row.deployment_json))[0]?.state === 'promoted', 'automatic promotion after the fresh canary observation')
        canary.deployment = JSON.parse(query(skillsPath, 'SELECT deployment_json FROM skill_deployments WHERE id = ?', canary.deployment.id)[0].deployment_json)
      }
    }
    const persistedWork = () => ({
      captures: captured().map(value => ({ id: value.id, candidateId: value.candidateId, state: value.state })),
      runs: query(skillsPath, 'SELECT run_json FROM skill_runs ORDER BY id'),
      definitions: query(skillsPath, 'SELECT definition_json FROM skill_definitions ORDER BY name,version'),
      comparisons: query(skillsPath, 'SELECT comparison_json FROM skill_comparisons ORDER BY id'),
      deploymentRuns: query(skillsPath, 'SELECT deployment_json FROM skill_deployments ORDER BY id').map(row => { const value = JSON.parse(row.deployment_json); return { id: value.id, runIds: value.runIds, version: value.version } }),
      goals: query(goalsPath, 'SELECT id FROM goal_records ORDER BY id'),
    })
    const beforeRestart = persistedWork()
    await stop(); await open()
    expect(persistedWork(), 'restart must not replay any captured or compared work').toEqual(beforeRestart)
    expect(captured()).toHaveLength(prospectiveCanary ? 2 : 1)
    if (!prospectiveCanary) expect(query(skillsPath, 'SELECT * FROM skill_runs')).toHaveLength(1)
    const before = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
    await prompt('Show the stored order-summary skill capture and candidate status without executing anything.')
    await wait(() => query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > before && idle(), 'owner readback')
    await expect(activePage.getByText('order-summary', { exact: false }).last()).toBeVisible()
    expect(persistedWork(), 'readback must not perform new work').toEqual(beforeRestart)
    expect(captured()).toHaveLength(prospectiveCanary ? 2 : 1)
    if (!prospectiveCanary) { expect(query(skillsPath, 'SELECT * FROM skill_definitions')).toHaveLength(1); expect(query(goalsPath, 'SELECT id FROM goal_records')).toHaveLength(2) }
    else expect(query(skillsPath, 'SELECT * FROM skill_definitions').length).toBe(canary?.deployment ? 2 : 1)
    await stop()
    const audit = await readSessionAudit(home, workspace, sessionId)
    const calls = audit.events.filter(event => event.type === 'tool/call')
    expect(captured()).toHaveLength(prospectiveCanary ? 2 : 1)
    expect(captured().find(value => value.id === capture.id)).toMatchObject({ id: capture.id, state: 'captured', candidateId: capture.candidateId })
    expect(query(skillsPath, 'SELECT candidate_json FROM skill_candidates WHERE id = ?', capture.candidateId)).toHaveLength(1)
    const finalHandoff = assertCaptureHandoff(audit, capture)
    expect(calls.filter(event => ['skill_save', 'skill_candidate'].includes(event.data.name))).toHaveLength(0)
    await writeFile(testInfo.outputPath('session-audit.json'), JSON.stringify(audit), { mode: 0o600 })
    const canaryCalls = calls.filter(event => event.data.name === 'skill_canary')
    if (prospectiveCanary) expect(canaryCalls).toHaveLength(1)
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ capability: prospectiveCanary ? 'real-prospective-canary' : 'automatic-capture-and-verified-candidate-reuse', route: route.proof, hostStarts: starts, initial, capture, trial, sourceReceipt: firstGoal.receipt, replayReceipt: goalOutcome(trial.goalId).receipt, sourceHash, activation: 'explicit-owner-after-independent-trial', improvement: canary?.comparison.result?.quality ?? 'unmeasured', restartNoReplay: true, canary, canaryToolCalls: canaryCalls.map(event => event.data.callId), ordinaryRequests: true, forcedToolOrder: false, ownerReadback: true, captureHandoff: { successfulCallId: sourceHandoff.registered.data.callId, sourceNativeTurn: sourceHandoff.start.data.turn, finalNativeTurn: finalHandoff.start.data.turn } }), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    await stop().catch(() => {})
    if (!sourceAudit && sessionId) sourceAudit = await readSessionAudit(home, workspace, sessionId).catch(() => undefined)
    if (existsSync(modelLog)) await copyFile(modelLog, testInfo.outputPath('model.jsonl'))
    if (sourceAudit) await writeFile(testInfo.outputPath('source-audit.json'), JSON.stringify(sourceAudit), { mode: 0o600 })
    await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport), { mode: 0o600 })
    await Promise.all(contexts.map(item => item.close().catch(() => {})))
    if (failed && process.env.DSH_CAPTURE_RETAIN_FAILURE === '1') await writeFile(testInfo.outputPath('retained-environment.json'), JSON.stringify({ temp, sessionId }), { mode: 0o600 })
    else await rm(temp, { recursive: true, force: true })
  }
})
