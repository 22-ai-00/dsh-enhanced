import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument, isMap } from 'yaml'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const objective = 'Create a shell program that reads two integers and prints their sum'
const port = async () => await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolvePort(address.port)) })
})
function row(document, id) {
  const value = document.contents.items.find(item => isMap(item) && item.get('id') === id)
  if (!value || !isMap(value)) throw new Error(`missing profile row ${id}`)
  return value
}
const modelCalls = async path => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

for (const strategy of [false, true]) {
test(`installed Web owner CLI admits one private verified Goal after a stopped prepared session (strategy=${strategy})`, async ({ page, context }, testInfo) => {
  const image = process.env.DSH_ISOLATION_TEST_IMAGE
  if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('DSH_ISOLATION_TEST_IMAGE must select an existing immutable local Docker image')
  const temp = await mkdtemp(join(tmpdir(), 'dsh-goal-setup-e2e-'))
  const home = join(temp, 'home'); const workspace = join(temp, 'workspace'); const taskPath = join(temp, 'private-goal-admission.json')
  const modelLog = join(temp, 'model.jsonl'); const runtimePort = await port()
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_ENHANCED_WEB_PORT: String(runtimePort), DSH_WEB_E2E_MODEL_LOG: modelLog,
    DSH_AUTONOMY_GOAL_SETUP_TEST: '1', DSH_AUTONOMY_GOAL_SETUP_STRATEGY: strategy ? '1' : '0', DEEPSEEK_API_KEY: 'test-only-not-a-credential' }
  const http = []; const transport = []; const streams = new Map(); const frames = []; let host; let hostCount = 0; let authenticated = false; let failed = false; let currentPage = page
  const stop = async () => { if (host) { await host.stop(); await writeFile(testInfo.outputPath(`host-${hostCount}.log`), host.log(), { mode: 0o600 }); host = undefined } }
  const open = async activePage => {
    currentPage = activePage
    hostCount++
    host = await startHost({ ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(resolve(root, 'scripts/e2e/autonomy-goal-setup-transport.mjs')).href}` })
    observePage(activePage, http, transport, streams, frames)
    try { await activePage.goto(host.url) } catch { throw new Error('Web authentication failed (URL redacted)') }
    await expect(activePage).toHaveURL(`${new URL(host.url).origin}/`); authenticated = true
  }
  const prompt = async (activePage, value) => {
    await activePage.getByLabel(/Describe what you want to build|Message or run a task/).fill(value)
    const sent = activePage.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await activePage.getByRole('button', { name: 'Send message', exact: true }).click()
    expect((await (await sent).json()).result.ok).toBe(true)
  }
  try {
    await mkdir(workspace)
    const installed = await run('/bin/bash', ['scripts/install/install-local.sh', '--scenario', 'autonomy', '--profile', 'web', '--isolation-image', image,
      '--workspace', workspace, '--yes', '--no-service', '--model', 'skip', '--model-route', 'skip', '--dsh-version', '0.1.2-rc.1'], env, 180000)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml'); const installedPatch = await readFile(patchPath, 'utf8')
    const prepared = parseDocument(installedPatch)
    // Preparation-only fixture route for the one foreground message that creates the
    // durable session. The CLI below owns every Goal/Verifier/Budget/owner entry.
    prepared.add({ id: 'agent-default-model', config: { provider: 'goal-setup-preparation', model: 'prepare' } })
    prepared.add({ id: 'session-title-llm', disabled: true })
    prepared.add({ insert: [{ id: 'goal-setup-e2e-transport', name: resolve(root, 'scripts/e2e/autonomy-goal-setup-transport.mjs') }] })
    await writeFile(patchPath, String(prepared), { mode: 0o600 })
    await open(page)
    await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
    await prompt(page, 'Prepare this session for the private goal admission.')
    await expect(page.getByText('Goal setup reply 1', { exact: true })).toBeVisible()
    const deliveryPath = join(home, 'assistant-delivery/state.sqlite'); const binding = query(deliveryPath, 'SELECT * FROM conversation_bindings')[0]
    const sessionId = binding.session_id
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id=?', sessionId)[0]?.state).toBe('released')
    await stop()

    const task = { version: 1, objective, model: 'deepseek-v4-flash', maxGoalRounds: 3, stepMaxDurationMs: 60000,
      executionBudget: { modelCalls: strategy ? 8 : 6, toolCalls: 3, inputTokens: 2_100_000, outputTokens: 6000, durationMs: 240000, maxOutputTokensPerCall: 1024 },
      verification: { artifactPath: 'answer.sh', command: '/bin/sh /workspace/artifact < /workspace/input', maxRuns: 12, maxTotalDurationMs: 240000,
        maxDurationMs: 20000, maxOutputBytes: 4096, cases: [{ stdin: '19 23', expectedStdout: '42', expectedExitCode: 0 }, { stdin: '-8 5', expectedStdout: '-3', expectedExitCode: 0 }] },
      wake: { maxDelayMs: 60000, runTimeoutMs: 90000, maxRuns: 3 }, ...(strategy ? { strategy: { maxRunsPerGoal: 4 } } : {}) }
    await writeFile(taskPath, JSON.stringify(task), { mode: 0o600 })
    expect((await stat(taskPath)).mode & 0o077).toBe(0)
    const setup = join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup')
    const args = ['--profile', 'web', '--dsh-home', home, '--workspace', workspace, '--goal-admission', taskPath, '--session-id', sessionId]
    const first = await run(setup, args, env, 90000); const configured = await readFile(patchPath, 'utf8')
    const second = await run(setup, args, env, 90000)
    expect(await readFile(patchPath, 'utf8')).toBe(configured)
    await writeFile(testInfo.outputPath('goal-setup-first.log'), sanitize(first), { mode: 0o600 })
    await writeFile(testInfo.outputPath('goal-setup-second.log'), sanitize(second), { mode: 0o600 })
    await writeFile(testInfo.outputPath('installed-profile.yaml'), configured, { mode: 0o600 })
    const finalProfile = parseDocument(configured)
    const goals = row(finalProfile, 'dsh-enhanced-assistant-goals').get('config', true).toJSON()
    const verifier = row(finalProfile, 'dsh-enhanced-assistant-verifier').get('config', true).toJSON()
    const delivery = row(finalProfile, 'dsh-enhanced-assistant-delivery').get('config', true).toJSON()
    expect(goals).toMatchObject({ verifyNativeRounds: true, verifyGoalOutcome: true, preauthorizedCreateMaxRounds: 3, preauthorizedSchedule: true, executionBudget: task.executionBudget, ...(strategy ? { strategy: task.strategy } : {}) })
    expect(verifier.profiles.some(profile => profile.objective === objective && profile.taskKind === 'goal-step')).toBe(true)
    expect(delivery.ownerRoutes).toEqual(expect.arrayContaining([expect.objectContaining({ conversation: JSON.parse(binding.conversation_json), workspace, minimumGeneration: binding.generation })]))

    const fresh = await context.browser().newContext(); const resumed = await fresh.newPage()
    await open(resumed)
    const workspaceRow = resumed.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(workspaceRow).toBeVisible(); if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await resumed.getByRole('treeitem', { name: /Prepare this session for the/ }).click()
    await expect(resumed.getByText('Goal setup reply 1', { exact: true })).toBeVisible()
    // Native DSH preserves the prepared Session's model. Follow the documented
    // product UI to select the admitted route instead of rewriting Session state.
    const modelTrigger = resumed.getByRole('button', { name: /^Select model(?:, current .+)?$/ })
    await modelTrigger.click()
    const modelMenu = resumed.getByRole('menu', { name: 'Model and reasoning effort' })
    await modelMenu.getByRole('menuitem', { name: /^Model\s/ }).click()
    await modelMenu.getByRole('menuitemradio', { name: 'deepseek-v4-flash', exact: true }).click()
    await expect(modelTrigger).toHaveAccessibleName(/Select model, current deepseek-v4-flash/)
    await prompt(resumed, objective)
    await expect(resumed.getByText('Goal setup reply 4', { exact: true })).toBeVisible()
    const goalsPath = join(home, 'assistant-goals/web.sqlite'); const verifierPath = join(home, 'assistant-verifier/verification.sqlite')
    await expect.poll(() => query(`${goalsPath}.wakes`, 'SELECT state FROM goal_wakes').map(value => value.state)).toEqual(['scheduled'])
    await stop()
    await open(resumed)
    await expect.poll(() => query(goalsPath, 'SELECT native_json FROM goal_records').map(value => JSON.parse(value.native_json).phase), { timeout: 150000 }).toEqual(['complete'])
    const native = JSON.parse(query(goalsPath, 'SELECT native_json FROM goal_records')[0].native_json)
    expect(native).toMatchObject({ sessionId, phase: 'complete', roundsStarted: 2 })
    const sourceJobs = query(join(home, 'assistant-isolation/web/ledger.sqlite'), 'SELECT * FROM isolation_jobs')
    expect(sourceJobs).toHaveLength(2); expect(sourceJobs.every(job => job.status === 'succeeded' && job.session_id === sessionId)).toBe(true)
    const receipts = query(verifierPath, 'SELECT payload FROM acceptance_receipts').map(value => JSON.parse(value.payload))
    expect(receipts.filter(value => value.task.kind === 'goal-step').map(value => value.objectiveStatus).sort()).toEqual(['achieved', 'not-achieved'])
    expect(receipts.filter(value => value.task.kind === 'goal-outcome').map(value => value.objectiveStatus).sort()).toEqual(['achieved', 'not-achieved'])
    const budgets = query(`${goalsPath}.budgets`, 'SELECT state,input_tokens_reserved,output_tokens_reserved,input_tokens_actual,output_tokens_actual,run_id FROM goal_budget_reservations')
    expect(budgets).toHaveLength(strategy ? 7 : 4)
    expect(budgets.every(({ run_id: _runId, ...row }) => JSON.stringify(row) === JSON.stringify({ state: 'settled', input_tokens_reserved: 2_097_152, output_tokens_reserved: 1024, input_tokens_actual: 12, output_tokens_actual: 8 }))).toBe(true)
    expect(budgets.filter(row => String(row.run_id).startsWith('strategy-'))).toHaveLength(strategy ? 2 : 0)
    if (strategy) {
      const rows = query(`${goalsPath}.strategies`, 'SELECT state,outcome,children_json,output_digest FROM goal_strategy_records')
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ state: 'settled', outcome: 'advice' })
      expect(JSON.parse(rows[0].children_json)).toHaveLength(2); expect(rows[0].output_digest).toMatch(/^[a-f0-9]{64}$/)
    }
    const calls = await modelCalls(modelLog)
    expect(calls).toHaveLength(strategy ? 11 : 8); expect(calls[strategy ? 9 : 6].feedbackObserved).toBe(true); expect(calls.every(call => !call.secretObserved)).toBe(true)
    expect(calls.filter(call => call.strategyChild)).toHaveLength(strategy ? 2 : 0)
    if (strategy) {
      const assessment = calls[9].strategyAssessments.find(value => value.parentStep?.status === 'not-achieved')
      const failed = receipts.find(receipt => receipt.task.kind === 'goal-step' && receipt.objectiveStatus === 'not-achieved')
      const passed = receipts.find(receipt => receipt.task.kind === 'goal-step' && receipt.objectiveStatus === 'achieved')
      expect(assessment).toMatchObject({ outcome: 'advice', attribution: 'same-parent-step-only', nextAction: 'revise-solution', definitionCurrent: true,
        parentRunId: failed.task.goal.runId, parentSessionId: sessionId, parentStep: { runId: failed.task.goal.runId, status: 'not-achieved', verification: { receiptId: failed.id } } })
      expect(assessment.parentRunId).not.toBe(passed.task.goal.runId)
    }
    expect(await resumed.getByRole('button', { name: 'Allow once', exact: true }).count()).toBe(0)
    expect(JSON.stringify(frames)).not.toContain('approval/asked'); expect(JSON.stringify(frames)).not.toContain('policy/ask')
    await expect.poll(() => query(`${goalsPath}.wakes`, 'SELECT state FROM goal_wakes').map(value => value.state)).toEqual(['succeeded'])
    expect(new Set(calls.filter(call => call.pid).map(call => call.pid)).size).toBe(2)
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ sessionId, native, hostProcesses: hostCount, wake: 'succeeded after actual Host restart', approvals: 0, taskFile: { privateOutsideWorkspace: true, mode: '0600' },
      setup: { product: 'installed dsh-web-owner-setup wrote Goal, verifier, budget, wake and exact persisted-session owner configuration', idempotentByteEqual: true },
      transport: 'paid DeepSeek HTTP response fixture only; production adapter/meter/Goal/verifier/isolation ran locally; no paid API or model-quality claim',
      sourceJobs: sourceJobs.map(job => ({ id: job.id, status: job.status, sessionId: job.session_id })), receipts, budgets, calls }, null, 2), { mode: 0o600 })
    await fresh.close()
  } catch (error) { failed = true; throw error } finally {
    try {
      if (failed && authenticated && !new URL(currentPage.url()).searchParams.has('token')) await writeFile(testInfo.outputPath('failure-dom.txt'), await currentPage.locator('body').innerText().catch(() => ''), { mode: 0o600 })
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
    } finally {
      try { if (host) { await writeFile(testInfo.outputPath('model.jsonl'), await readFile(modelLog, 'utf8').catch(() => ''), { mode: 0o600 }); await stop() } }
      finally { await rm(temp, { recursive: true, force: true }) }
    }
  }
})
}
