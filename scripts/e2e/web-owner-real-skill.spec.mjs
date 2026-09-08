import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseDocument, isMap, isSeq } from 'yaml'
import { objective, criteria, setConfig, contracts, jobs } from './web-owner-real-helpers.mjs'
import { allowedSkillExperimentTool } from './web-owner-real-skill-guard.mjs'
import { readSessionAudit } from './web-owner-real-audit.mjs'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)
const candidateMode = process.env.DSH_WEB_REAL_SKILL_CANDIDATE === '1'

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

function eventsFor(audit, name) { return audit.events.filter(event => event.type === 'tool/call' && event.data.name === name) }
function modelCalls(path) { return readFile(path, 'utf8').catch(() => '').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) }
async function sessionEvents(home, workspace, sessionId) {
  const project = `--${workspace.slice(1).replaceAll('/', '-')}--`
  const { stdout } = await exec('zstd', ['-q', '-dc', join(home, 'sessions', project, sessionId, 'session.jsonl.zstd')], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 })
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function selectOriginalSession(page) {
  const workspace = page.getByRole('treeitem', { name: 'workspace', exact: true })
  await expect(workspace).toBeVisible()
  if (await workspace.getAttribute('aria-expanded') === 'false') await workspace.click()
  const session = page.getByRole('treeitem', { name: /Create a goal with objective/ }).first()
  await expect(session).toBeVisible()
  await session.click()
}

async function approveExpected(page, frames, approved, workspace) {
  const allow = page.getByRole('button', { name: 'Allow once', exact: true })
  if (!await allow.count()) return false
  await expect.poll(() => frames.flatMap(frame => frame.value?.type === 'event' && frame.value.event?.type === 'tool/call' ? [frame.value.event.data] : []).length).toBeGreaterThan(0)
  const call = frames.flatMap(frame => frame.value?.type === 'event' && frame.value.event?.type === 'tool/call' ? [frame.value.event.data] : []).at(-1)
  let args; try { args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments } catch {}
  if (!call || !allowedSkillExperimentTool(call.name, args, workspace, ['write', 'skill_run'].includes(call.name) ? 'source' : 'source-create')) {
    approved.push({ toolName: call?.name ?? 'unknown', callId: call?.callId, outcome: 'rejected' })
    await page.getByRole('button', { name: 'Reject', exact: true }).click()
    return true
  }
  approved.push({ toolName: call.name, callId: call.callId }); await allow.click()
  return true
}

async function waitFor({ predicate, page, frames, approved, workspace, description }) {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    if (predicate()) return
    if (!await approveExpected(page, frames, approved, workspace)) await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {})
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function waitForGoal({ page, goalsPath, verifierPath, deliveryPath, goalId, frames, approved, workspace }) {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const dead = query(deliveryPath, "SELECT failure_code FROM inbox_messages WHERE status = 'dead_letter'")[0]
    if (dead) throw new Error(`real skill owner input failed: ${dead.failure_code}`)
    const goal = query(goalsPath, 'SELECT * FROM goal_records WHERE id = ?', goalId)[0]
    const outcome = contracts(verifierPath, 'goal-outcome').findLast(row => row.contract.task?.goal?.id === goalId)
    const job = outcome ? jobs(verifierPath, [outcome.id])[0] : undefined
    if (goal && JSON.parse(goal.native_json).phase === 'complete' && job?.receipt?.objectiveStatus === 'achieved') return { goal, outcome, job }
    // A native round-limit transition can precede the asynchronous independent
    // outcome receipt that turns the Goal complete. Fail only after that exact
    // outcome job has reached a non-achieved terminal state.
    if (goal && ['blocked', 'failed', 'cancelled'].includes(JSON.parse(goal.native_json).phase)
      && job && ['done', 'failed', 'needs-attention'].includes(job.state) && job.receipt?.objectiveStatus !== 'achieved') {
      throw new Error(`goal ${goalId} reached terminal native state without an achieved independent receipt`)
    }
    if (!await approveExpected(page, frames, approved, workspace)) await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {})
  }
  throw new Error(`independent verification did not complete for ${goalId}`)
}

test(candidateMode ? 'real browser trials activates and rolls back a skill candidate after Host restart' : 'real browser persists and reuses an independently verified skill after Host restart', async ({ page, context }, testInfo) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-web-owner-real-skill-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), modelLog = join(temp, 'model.jsonl')
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_WEB_REAL_LOG: modelLog, DSH_WEB_REAL_WORKSPACE: workspace }
  const approved = [], http = [], transport = [], frames = [], streams = new Map(), contexts = []
  let host; let activePage = page; let authenticated = false; let failed = false; let starts = 0
  const stop = async () => { if (host) { await host.stop(); await writeFile(testInfo.outputPath(`host-${starts}.log`), host.log(), { mode: 0o600 }); host = undefined } }
  const open = async (fresh = false) => {
    host = await startHost(env); starts += 1
    if (fresh) { const next = await context.browser().newContext(); contexts.push(next); activePage = await next.newPage() }
    observePage(activePage, http, transport, streams, frames)
    await activePage.goto(host.url).catch(() => { throw new Error('browser authentication failed (URL redacted)') })
    await expect(activePage).toHaveURL(`${new URL(host.url).origin}/`); authenticated = true
    if (starts === 1) await activePage.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
  }
  const prompt = async text => {
    const composer = activePage.getByLabel(/Describe what you want to build|Message or run a task/)
    await composer.fill(text)
    const response = activePage.waitForResponse(item => new URL(item.url()).pathname === '/api/session/prompt')
    await activePage.getByRole('button', { name: 'Send message', exact: true }).click()
    expect((await response).status()).toBe(200)
  }
  try {
    await mkdir(workspace)
    const route = await prepareRealRoute({ env, home, workspace }); env.DSH_WEB_REAL_PROVIDER = route.provider; env.DSH_WEB_REAL_MODEL = route.model
    await run('zstd', ['--version'], env)
    const installed = await run('dsh', ['plugin', '--profile', 'web', 'add', ...[
      'personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-skills', 'assistant-web-owner', 'assistant-verifier', 'assistant-evaluation', ...route.bundles,
    ].map(name => resolve(root, 'plugins', name))], env)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace], env)
    const deliveryPath = join(home, 'assistant-delivery/state.sqlite'), goalsPath = join(home, 'assistant-goals/web.sqlite'), verifierPath = join(home, 'assistant-verifier/verification.sqlite'), skillsPath = join(home, 'assistant-skills/skills.sqlite')
    const owner = query(deliveryPath, "SELECT id, version, principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active'")[0]
    if (!owner) throw new Error('setup did not create a Web owner')
    const { createVerifierAuthorities } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-verifier/lib/index.js')).href)
    const authority = { kind: 'runner', id: 'node', executable: process.execPath, fixedArgs: [], timeoutMs: 5_000, maxOutputBytes: 16_384 }
    const [runner] = createVerifierAuthorities({ authorities: [authority] })
    const profile = taskKind => ({ id: `real-skill-${taskKind}`, version: 1, scope: { workspace, preset: 'standard' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, taskKind, objective, validityMs: 600_000, bounds: { maxDurationMs: 15_000, maxEvidenceBytes: 16_384 }, criteria: (taskKind === 'goal-step' ? criteria.slice(0, 1) : criteria).map(entry => ({ id: entry.id, kind: 'process-behavior', authority: { id: runner.id, digest: runner.digest }, artifactPath: 'summarize.mjs', stdin: entry.stdin, expectedStdout: entry.expectedStdout, expectedExitCode: 0 })) })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml'), patch = parseDocument(await readFile(patchPath, 'utf8'))
    setConfig(patch, 'dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', { databasePath: goalsPath, verifyNativeRounds: true, verifyGoalOutcome: true, stepMaxDurationMs: 120_000 })
    setConfig(patch, 'dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', { databasePath: skillsPath, allowedTools: ['write'], maxDurationMs: 60_000 })
    setConfig(patch, 'dsh-enhanced-assistant-web-owner', '@dsh-enhanced/assistant-web-owner', { maxExecutionMs: 300_000 })
    setConfig(patch, 'dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', { databasePath: verifierPath, tickIntervalMs: 500, requireAcceptance: false, authorities: [authority], profiles: [profile('goal-step'), profile('goal-outcome')] })
    appendPolicy(patch, [{ id: 'real-skill-evolution', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }, actions: ['inspect', 'save', 'run', 'retire', 'draft', 'trial', 'activate', 'rollback'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['external'] } }])
    route.configurePatch(patch, setConfig)
    patch.contents.add(patch.createNode({ id: 'session-title-llm', disabled: true }))
    patch.contents.add(patch.createNode({ insert: [{ id: 'web-owner-real-skill-guard', name: resolve(root, 'scripts/e2e/web-owner-real-skill-guard.mjs') }] }))
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    await open()
    await prompt(`Create a goal with objective exactly: '${objective}' Use goal_create with max_goal_rounds 2 and start_native_rounds true. Do not create files in this foreground turn. In the subsequent native goal round, call write with exactly file_path summarize.mjs and content; do not use path or file argument names.`)
    await waitFor({ predicate: () => query(goalsPath, 'SELECT id FROM goal_records').length === 1, page: activePage, frames, approved, workspace, description: 'source goal creation' })
    const firstId = query(goalsPath, 'SELECT id FROM goal_records')[0].id
    const first = await waitForGoal({ page: activePage, goalsPath, verifierPath, deliveryPath, goalId: firstId, frames, approved, workspace })
    const sourceHash = createHash('sha256').update(await readFile(join(workspace, 'summarize.mjs'))).digest('hex')
    const processedBeforeSave = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
    await prompt(`Use skill_save with goal_id ${firstId}, name verified-summary, description exactly 'Replay the independently verified order-summary artifact.', bindings_json [], and expected_version 0. Do not use other tools.`)
    await waitFor({ predicate: () => existsSync(skillsPath) && query(skillsPath, 'SELECT COUNT(*) AS count FROM skill_definitions')[0]?.count === 1 && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > processedBeforeSave, page: activePage, frames, approved, workspace, description: 'skill save' })
    let candidateId
    if (candidateMode) {
      const before = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
      await prompt(`Use only skill_candidate with goal_id ${firstId}, name verified-summary, description exactly 'Trial candidate of the independently verified order-summary artifact.', bindings_json [], parent_version 1, reason exactly 'Verify candidate lifecycle', trigger exactly 'owner-request'.`)
      await waitFor({ predicate: () => query(skillsPath, 'SELECT id FROM skill_candidates').length === 1 && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > before, page: activePage, frames, approved, workspace, description: 'candidate staging' })
      candidateId = query(skillsPath, 'SELECT id FROM skill_candidates')[0].id
      expect(query(skillsPath, 'SELECT version FROM skill_definitions').map(row => row.version)).toEqual([1])
    }
    await stop()
    await rm(join(workspace, 'summarize.mjs'))
    expect(existsSync(join(workspace, 'summarize.mjs'))).toBe(false)
    await open(true)
    const firstSession = query(deliveryPath, 'SELECT session_id FROM conversation_bindings ORDER BY created_at ASC LIMIT 1')[0]?.session_id
    if (!firstSession) throw new Error('missing original browser session binding')
    await selectOriginalSession(activePage)
    const processedBeforeLoad = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
    await prompt('Load the native skill named verified-summary with the skill tool. Do not create a goal or execute the workflow in this turn.')
    await waitFor({ predicate: () => query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > processedBeforeLoad, page: activePage, frames, approved, workspace, description: 'native skill load' })
    const replayInstruction = candidateMode ? `skill_trial with candidate_id ${candidateId}, inputs_json {}, and invocation_id trial-1` : 'skill_run with name verified-summary, version 1, inputs_json {}, and invocation_id reuse-1'
    await prompt(`Create a new goal with objective exactly: '${objective}' Use goal_create with max_goal_rounds 2 and start_native_rounds true. Do not use a write tool yourself. In the next native goal round, use the returned business goal id in exactly ${replayInstruction}. Do not use any other tool.`)
    await waitFor({ predicate: () => query(goalsPath, 'SELECT id FROM goal_records').length === 2, page: activePage, frames, approved, workspace, description: 'replay goal creation' })
    const secondId = query(goalsPath, 'SELECT id FROM goal_records ORDER BY rowid DESC LIMIT 1')[0].id
    const second = await waitForGoal({ page: activePage, goalsPath, verifierPath, deliveryPath, goalId: secondId, frames, approved, workspace })
    expect(JSON.parse(first.goal.native_json).sessionId).toBe(firstSession)
    expect(JSON.parse(second.goal.native_json).sessionId).toBe(firstSession)
    // Reopen the persisted original conversation and inspect the real tool
    // receipt through its native details UI. This proves owner readback, not
    // an unsolicited live notification of independent acceptance.
    await activePage.reload()
    await selectOriginalSession(activePage)
    const bottom = activePage.getByRole('button', { name: 'Back to bottom', exact: true })
    if (await bottom.isVisible()) await bottom.click()
    for (const group of await activePage.getByRole('button', { name: /^\d+ tool calls?$/ }).all()) await group.click()
    await activePage.getByRole('button', { name: candidateMode ? /^Tool call skill_trial/ : /^Tool call skill_run/ }).last().click()
    await expect(activePage.getByText('requires-fresh-goal-verification', { exact: false }).last()).toBeVisible()
    const replayHash = createHash('sha256').update(await readFile(join(workspace, 'summarize.mjs'))).digest('hex')
    expect(replayHash).toBe(sourceHash)
    let lifecycle
    if (candidateMode) {
      const trial = JSON.parse(query(skillsPath, 'SELECT run_json FROM skill_runs')[0].run_json)
      expect(trial.candidateId).toBe(candidateId)
      expect(query(skillsPath, 'SELECT version FROM skill_definitions').map(row => row.version)).toEqual([1])
      let before = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
      await prompt(`Use only skill_activate with candidate_id ${candidateId} and trial_run_id ${trial.id}.`)
      await waitFor({ predicate: () => query(skillsPath, 'SELECT version FROM skill_definitions').length === 2 && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > before, page: activePage, frames, approved, workspace, description: 'independently accepted activation' })
      const activated = JSON.parse(query(skillsPath, 'SELECT candidate_json FROM skill_candidates')[0].candidate_json)
      expect(activated).toMatchObject({ state: 'activated', activatedVersion: 2, trialRunId: trial.id })
      expect(activated.acceptanceDigest).toBeTruthy()
      before = query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length
      await prompt('Use only skill_rollback with name verified-summary, expected_version 2, target_version 1.')
      await waitFor({ predicate: () => query(skillsPath, 'SELECT version FROM skill_definitions').length === 3 && query(deliveryPath, "SELECT id FROM inbox_messages WHERE status = 'processed'").length > before, page: activePage, frames, approved, workspace, description: 'immutable rollback' })
      const versions = query(skillsPath, 'SELECT definition_json FROM skill_definitions ORDER BY version').map(row => JSON.parse(row.definition_json))
      expect(versions[2]).toMatchObject({ version: 3, parentVersion: 2, restoredFromVersion: 1, description: versions[0].description, steps: versions[0].steps })
      await activePage.reload(); await selectOriginalSession(activePage)
      const bottom = activePage.getByRole('button', { name: 'Back to bottom', exact: true }); if (await bottom.isVisible()) await bottom.click()
      for (const group of await activePage.getByRole('button', { name: /^\d+ tool calls?$/ }).all()) await group.click()
      await activePage.getByRole('button', { name: /^Tool call skill_rollback/ }).last().click()
      await expect(activePage.getByText('restoredFromVersion', { exact: false }).last()).toBeVisible()
      lifecycle = { candidate: activated, trial, versions, ownerRollbackReadback: true, improvement: 'unmeasured', activation: 'owner-request-after-independent-trial' }
    }
    await stop()
    const audit = await readSessionAudit(home, workspace, firstSession)
    const sourceOutcome = first.outcome.contract, replayOutcome = second.outcome.contract
    const sourceReceiptDigest = createHash('sha256').update(JSON.stringify(first.job.receipt)).digest('hex')
    const replayReceiptDigest = createHash('sha256').update(JSON.stringify(second.job.receipt)).digest('hex')
    const saves = eventsFor(audit, 'skill_save'), loads = eventsFor(audit, 'skill'), runs = eventsFor(audit, candidateMode ? 'skill_trial' : 'skill_run'), writes = eventsFor(audit, 'write')
    const storedRun = query(skillsPath, 'SELECT run_json FROM skill_runs')[0]
    const rawEvents = await sessionEvents(home, workspace, firstSession)
    const loadResult = rawEvents.find(event => event.type === 'tool/result' && event.data?.message?.source?.callId === loads[0]?.data.callId)
    expect(saves).toHaveLength(1); expect(loads).toHaveLength(1); expect(runs).toHaveLength(1); expect(writes).toHaveLength(1)
    expect(loadResult?.data?.message?.content?.[0]?.isError).not.toBe(true)
    expect(JSON.stringify(loadResult?.data?.message?.content)).toContain('verified-summary')
    expect(sourceOutcome.task.goal.id).toBe(firstId); expect(replayOutcome.task.goal.id).toBe(secondId)
    expect(sourceReceiptDigest).not.toBe(replayReceiptDigest)
    expect(JSON.parse(storedRun.run_json)).toMatchObject({ goalId: secondId, skillName: 'verified-summary', version: candidateMode ? 2 : 1, invocationId: candidateMode ? 'trial-1' : 'reuse-1', inputs: {}, state: 'succeeded', steps: [{ state: 'succeeded' }] })
    const assemblies = (await modelCalls(modelLog)).filter(row => row.event === 'assembly')
    const guardedExecutions = (await modelCalls(modelLog)).filter(row => row.event === 'tool-execute')
    expect(assemblies.some(row => row.phase === 'native-load' && row.availableToolNames.includes('skill'))).toBe(true)
    expect(assemblies.some(row => row.phase === (candidateMode ? 'trial' : 'replay') && row.availableToolNames.includes(candidateMode ? 'skill_trial' : 'skill_run'))).toBe(true)
    await copyFile(join(workspace, 'summarize.mjs'), testInfo.outputPath('summarize.mjs'))
    await writeFile(testInfo.outputPath('session-audit.json'), JSON.stringify(audit, null, 2), { mode: 0o600 })
    await copyFile(modelLog, testInfo.outputPath('model.jsonl'))
    expect(guardedExecutions.filter(row => row.phase === 'source' && row.name === 'write')).toHaveLength(1)
    expect(guardedExecutions.filter(row => row.phase === (candidateMode ? 'trial' : 'replay') && row.name === 'write')).toHaveLength(1)
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ capability: candidateMode ? 'verified-skill-candidate-lifecycle' : 'verified-skill-reuse', lifecycle, ...route.proof, hostStarts: starts, sourceGoal: { id: firstId, receipt: first.job.receipt, receiptDigest: sourceReceiptDigest }, replayGoal: { id: secondId, receipt: second.job.receipt, receiptDigest: replayReceiptDigest }, sourceReceiptDiffersFromReplay: sourceReceiptDigest !== replayReceiptDigest, artifact: { path: 'summarize.mjs', sourceHash, replayHash, restoredAfterRemoval: true }, ownerReadbackAfterReload: true, nativeCatalogLoadedAfterRestart: assemblies.some(row => row.phase === 'native-load' && row.availableToolNames.includes('skill')), toolCalls: { saved: saves, loaded: loads, replayed: runs, sourceSessionWrite: writes.length, nestedReplayWrite: guardedExecutions.filter(row => row.phase === (candidateMode ? 'trial' : 'replay') && row.name === 'write').length }, modelCalls: await modelCalls(modelLog), approved }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    try { if (existsSync(modelLog)) await copyFile(modelLog, testInfo.outputPath('model.jsonl')) } catch {}
    try { if (authenticated && failed && !new URL(activePage.url()).searchParams.has('token')) await activePage.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {}) } finally {
      await stop().catch(() => {})
      await Promise.all(contexts.map(item => item.close().catch(() => {})))
      await rm(temp, { recursive: true, force: true })
    }
  }
})
