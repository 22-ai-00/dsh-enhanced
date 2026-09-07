import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parseDocument, isMap, isSeq } from 'yaml'
import { createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import { objective, preparation } from './autonomy-wake-model.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
function config(doc, id) {
  let row = doc.contents.items.find(item => isMap(item) && item.get('id') === id)
  if (!row) { row = doc.createNode({ id }); doc.contents.add(row) }
  if (!row.has('config')) row.set('config', doc.createNode({}))
  const value = row.get('config', true)
  if (!isMap(value)) throw new Error(`invalid config for ${id}`)
  return value
}
function set(doc, map, values) { for (const [key, value] of Object.entries(values)) map.set(key, doc.createNode(value)) }
function append(doc, map, key, values) {
  if (!map.has(key)) map.set(key, doc.createNode([]))
  const list = map.get(key, true)
  if (!isSeq(list)) throw new Error(`invalid list ${key}`)
  for (const value of values) list.add(doc.createNode(value))
}
const callsAt = async path => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

for (const mode of ['resume', 'revoked', 'interrupt']) test(`installed scheduled goal survives process boundaries: ${mode}`, async ({ page, context }, testInfo) => {
  const image = process.env.DSH_ISOLATION_TEST_IMAGE
  if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('DSH_ISOLATION_TEST_IMAGE must be an existing immutable local image')
  const temp = await mkdtemp(join(tmpdir(), 'dsh-wake-e2e-')); const home = join(temp, 'home'); const workspace = join(temp, 'workspace')
  const modelLog = join(temp, 'model.jsonl'); const goalsPath = join(home, 'assistant-goals/web.sqlite')
  const deliveryPath = join(home, 'assistant-delivery/state.sqlite'); const isolationPath = join(home, 'assistant-isolation/web/ledger.sqlite')
  const verificationRoot = join(temp, 'verification'); const verifierPath = join(temp, 'verifier.sqlite'); const automationsPath = join(temp, 'automations.sqlite')
  const port = await new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolvePort(address.port)) }) })
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_ENHANCED_WEB_PORT: String(port), DSH_WEB_E2E_MODEL_LOG: modelLog, DSH_WAKE_TEST_MODE: mode }
  const http = []; const transport = []; const streams = new Map(); const frames = []; const contexts = []
  let host; let activePage = page; let authenticated = false; let failed = false; let errorForEvidence; let hostNumber = 0
  const stop = async () => { if (host) { await host.stop(); await writeFile(testInfo.outputPath(`host-${hostNumber}.log`), host.log(), { mode: 0o600 }); host = undefined } }
  const open = async (fresh = false) => {
    host = await startHost(env); hostNumber++
    if (fresh) { const next = await context.browser().newContext(); contexts.push(next); activePage = await next.newPage() }
    observePage(activePage, http, transport, streams, frames)
    try { await activePage.goto(host.url) } catch { throw new Error('Web authentication failed (URL redacted)') }
    await expect(activePage).toHaveURL(`${new URL(host.url).origin}/`); authenticated = true
    const notice = activePage.getByRole('dialog', { name: 'Internal Testing Notice' })
    if (hostNumber === 1) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  const select = async () => {
    const workspaceRow = activePage.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(workspaceRow).toBeVisible()
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await activePage.getByRole('treeitem', { name: /Prepare this session for a/ }).click()
    await expect(activePage.getByText('Scheduled goal reply 1', { exact: true })).toBeVisible()
  }
  const prompt = async text => {
    await activePage.getByLabel(/Describe what you want to build|Message or run a task/).fill(text)
    const sent = activePage.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await activePage.getByRole('button', { name: 'Send message', exact: true }).click()
    expect((await (await sent).json()).result.ok).toBe(true)
  }
  try {
    await mkdir(workspace); await mkdir(verificationRoot, { mode: 0o700 })
    const installed = await run('/bin/bash', ['scripts/install/install-local.sh', '--scenario', 'autonomy', '--profile', 'web', '--isolation-image', image,
      '--workspace', workspace, '--yes', '--no-service', '--model', 'skip', '--model-route', 'skip', '--dsh-version', '0.1.2-rc.1'], env, 180000)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml'); const installedPatch = await readFile(patchPath, 'utf8')
    await writeFile(testInfo.outputPath('installed-profile.yaml'), installedPatch, { mode: 0o600 })
    const patch = parseDocument(installedPatch)
    const grant = config(patch, 'dsh-enhanced-assistant-isolation').get('grants').toJSON()[0]
    const authority = { kind: 'isolated-runner', id: 'scheduled-sum-checker', stateRoot: verificationRoot, image, dockerPath: '/usr/bin/docker',
      command: '/bin/sh /workspace/artifact < /workspace/input', expiresAt: grant.expiresAt, maxRuns: 12, maxTotalDurationMs: 240000, maxDurationMs: 20000, maxOutputBytes: 4096,
      testSets: [{ id: 'sum-cases', cases: [{ stdin: '19 23', expectedStdout: '42', expectedExitCode: 0 }, { stdin: '-8 5', expectedStdout: '-3', expectedExitCode: 0 }] }] }
    const [compiled] = createVerifierAuthorities({ authorities: [authority] })
    const profiles = ['goal-step', 'goal-outcome'].map(taskKind => ({ id: taskKind, version: 1, taskKind, objective, scope: { workspace, preset: 'standard' },
      owner: { principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion }, validityMs: 240000, bounds: { maxDurationMs: 60000, maxEvidenceBytes: 8192 },
      criteria: [{ id: 'sum-behavior', kind: 'isolated-process-behavior', authority: { id: compiled.id, digest: compiled.digest }, artifactPath: 'answer.sh', testSetId: 'sum-cases' }] }))
    set(patch, config(patch, 'dsh-enhanced-assistant-verifier'), { databasePath: verifierPath, tickIntervalMs: 0, authorities: [authority], profiles })
    set(patch, config(patch, 'dsh-enhanced-assistant-goals'), { databasePath: goalsPath, verifyNativeRounds: true, verifyGoalOutcome: true, stepMaxDurationMs: 60000,
      preauthorizedCreateMaxRounds: 1, preauthorizedSchedule: true, executionBudget: { modelCalls: 6, toolCalls: 3, inputTokens: 200, outputTokens: 6000, costUsdMicros: 0, durationMs: 240000, maxOutputTokensPerCall: 1024 },
      backgroundWake: { ownerRouteId: 'scheduled-web-owner', budgetId: 'scheduled-goal-runs', maxDelayMs: 60000, runTimeoutMs: 90000 } })
    set(patch, config(patch, 'dsh-enhanced-assistant-delivery'), { agentProvider: 'browser-e2e', agentModel: 'scheduled-goal-proof', agentMaxOutputTokens: 1024 })
    const personal = config(patch, 'dsh-enhanced-personal-assistant'); const automation = personal.get('assistantAutomations', true); const policy = personal.get('assistantPolicy', true)
    if (!isMap(automation) || !isMap(policy)) throw new Error('installed personal assistant configuration missing')
    set(patch, automation, { databasePath: automationsPath, runsPath: join(temp, 'automation-runs'), schedulerEnabled: true, tickIntervalMs: 1000, reconcileIntervalMs: 0 })
    append(patch, policy, 'budgets', [{ id: 'scheduled-goal-runs', metric: 'automation-runs', limit: 3, periodMs: Number.MAX_SAFE_INTEGER, scope: 'global' }])
    const principalId = 'web/web/local/operator'
    append(patch, policy, 'rules', [
      { id: 'scheduled-goal-agent', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace, principal: principalId }, actions: ['observe', 'inspect', 'snapshot', 'execute', 'reply'], resource: { kind: '*', id: '*' }, context: { initiators: ['background'] } },
      { id: 'scheduled-goal-automation', effect: 'allow', subject: { kind: 'background', id: '*', workspace, principal: principalId }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: 'goal-wake-*' }, context: { initiators: ['background'] } },
      { id: 'scheduled-goal-resume', effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace, principal: principalId }, actions: ['wake'], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['background'] } },
    ])
    patch.add({ id: 'agent-default-model', config: { provider: 'browser-e2e', model: 'scheduled-goal-proof' } })
    patch.add({ id: 'session-title-llm', disabled: true })
    patch.add({ insert: [{ id: 'autonomy-wake-e2e-model', name: resolve(root, 'scripts/e2e/autonomy-wake-model.mjs') }] })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    await open()
    await prompt(preparation)
    await expect(activePage.getByText('Scheduled goal reply 1', { exact: true })).toBeVisible()
    const binding = query(deliveryPath, 'SELECT * FROM conversation_bindings')[0]; const sessionId = binding.session_id
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id=?', sessionId)[0]?.state).toBe('released')
    await stop()
    // Explicit operator-only setup for the exact persisted conversation. No wildcard route.
    set(patch, config(patch, 'dsh-enhanced-assistant-delivery'), { ownerRoutes: [{ id: 'scheduled-web-owner', conversation: JSON.parse(binding.conversation_json), principal: JSON.parse(binding.principal_json), workspace, agentPreset: 'standard', policyRef: binding.policy_ref, minimumGeneration: binding.generation }] })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    await open(true); await select(); await prompt(objective)
    await expect(activePage.getByText('Scheduled goal reply 4', { exact: true })).toBeVisible()
    await expect.poll(() => query(`${goalsPath}.wakes`, 'SELECT state FROM goal_wakes').map(row => row.state)).toEqual(['scheduled'])
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id=?', sessionId)[0]?.state).toBe('released')
    const scheduled = query(`${goalsPath}.wakes`, 'SELECT * FROM goal_wakes')[0]
    const intent = JSON.parse(scheduled.intent_json); const business = query(goalsPath, 'SELECT * FROM goal_records')[0]
    const owner = query(deliveryPath, 'SELECT id,version,status FROM delivery_principals WHERE id=?', binding.principal_id)[0]
    const scheduledLease = query(deliveryPath, 'SELECT * FROM delivery_session_leases WHERE session_id=?', sessionId)[0]
    expect(intent.attestation).toEqual({ scope: { workspace, preset: 'standard' }, principalId,
      principalLineage: { principalRecordId: owner.id, principalVersion: owner.version }, bindingId: binding.id,
      bindingVersion: binding.version, bindingGeneration: binding.generation, sessionId })
    expect(scheduledLease).toMatchObject({ state: 'released', principal_record_id: owner.id, principal_version: owner.version })
    expect(intent.native).toMatchObject({ sessionId, phase: 'paused', roundsStarted: 0, maxGoalRounds: 1 })
    expect(await callsAt(modelLog)).toHaveLength(4)
    expect(query(isolationPath, 'SELECT * FROM isolation_jobs')).toHaveLength(0)
    await writeFile(testInfo.outputPath('scheduled.json'), JSON.stringify({ scheduled, business, binding, owner, scheduledLease }, null, 2), { mode: 0o600 })
    await stop()
    if (mode === 'revoked') {
      // Seed owner revocation only in this disposable stopped profile.
      const db = new DatabaseSync(deliveryPath)
      try { db.prepare("UPDATE delivery_principals SET status='revoked', version=version+1 WHERE id=?").run(binding.principal_id) } finally { db.close() }
      // The fixed-owner Web controller correctly refuses a revoked owner at startup.
      // Disable just that UI for this negative test; background services must also deny.
      patch.add({ id: 'dsh-enhanced-assistant-web-owner', disabled: true })
      await writeFile(patchPath, String(patch), { mode: 0o600 })
      host = await startHost(env); hostNumber++
    } else await open(true)
    const wake = () => query(`${goalsPath}.wakes`, 'SELECT * FROM goal_wakes')[0]
    if (mode === 'interrupt') {
      await expect.poll(() => wake().state, { timeout: 60000 }).toBe('dispatched')
      await expect.poll(() => query(isolationPath, 'SELECT status FROM isolation_jobs').map(row => row.status), { timeout: 30000 }).toEqual(['running'])
      await stop()
      const interruptedState = wake().state
      expect(['dispatched', 'unknown']).toContain(interruptedState)
      const callsBeforeRestart = await callsAt(modelLog)
      const duty = query(automationsPath, 'SELECT * FROM duty_lease')[0]
      host = await startHost(env); hostNumber++
      await expect.poll(() => query(automationsPath, 'SELECT fencing_token FROM duty_lease')[0]?.fencing_token).toBeGreaterThan(duty.fencing_token)
      // A second fresh process sees the same terminal wake, never a new dispatch.
      expect(wake().state).toBe(interruptedState)
      await stop()
      expect(await callsAt(modelLog)).toEqual(callsBeforeRestart)
      expect(query(isolationPath, 'SELECT id FROM isolation_jobs')).toHaveLength(1)
    } else if (mode === 'revoked') {
      await expect.poll(() => wake().state, { timeout: 60000 }).toBe('denied')
      expect(await callsAt(modelLog)).toHaveLength(4)
      expect(query(isolationPath, 'SELECT * FROM isolation_jobs')).toHaveLength(0)
      expect(wake().dispatched_at).toBeNull()
    } else {
      await expect.poll(() => wake().state, { timeout: 120000 }).toBe('succeeded')
      const restored = JSON.parse(query(goalsPath, 'SELECT native_json FROM goal_records')[0].native_json)
      expect(restored).toMatchObject({ sessionId, goalId: intent.native.goalId, phase: 'complete', roundsStarted: 1, revision: intent.native.revision + 3 })
      const history = query(goalsPath, "SELECT payload_json FROM goal_history WHERE kind='native' ORDER BY sequence").map(row => JSON.parse(row.payload_json))
      expect(history.slice(-2).map(value => ({ phase: value.phase, revision: value.revision }))).toEqual([
        { phase: 'blocked', revision: intent.native.revision + 2 }, { phase: 'complete', revision: intent.native.revision + 3 },
      ])
      const stepExecutions = query(`${goalsPath}.executions`, 'SELECT execution_json FROM goal_execution_runs').map(row => JSON.parse(row.execution_json))
      expect(stepExecutions).toEqual([expect.objectContaining({ status: 'succeeded', quiescent: true })])
      const calls = await callsAt(modelLog)
      expect(calls).toHaveLength(6); expect(calls[4].pid).not.toBe(calls[3].pid)
      expect(calls.slice(4).every(call => !call.human && call.sessionId === sessionId)).toBe(true)
      const receipts = query(verifierPath, 'SELECT payload FROM acceptance_receipts').map(row => JSON.parse(row.payload))
      expect(receipts).toHaveLength(2); expect(receipts.every(receipt => receipt.objectiveStatus === 'achieved')).toBe(true)
      const sourceJobs = query(isolationPath, 'SELECT id,session_id,status FROM isolation_jobs')
      expect(sourceJobs).toHaveLength(1); expect(sourceJobs[0]).toMatchObject({ session_id: sessionId, status: 'succeeded' })
      const verificationJobs = query(join(verificationRoot, 'ledger.sqlite'), 'SELECT id,status FROM isolation_jobs')
      expect(verificationJobs).toHaveLength(4); expect(verificationJobs.every(job => job.id !== sourceJobs[0].id && job.status === 'succeeded')).toBe(true)
      expect(query(`${goalsPath}.budgets`, 'SELECT state FROM goal_budget_reservations')).toEqual([{ state: 'settled' }, { state: 'settled' }])
      await select()
      await expect(activePage.getByText('Scheduled goal reply 6', { exact: true })).toBeVisible()
      await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id=?', sessionId)[0]?.state).toBe('released')
      const resumedLease = query(deliveryPath, 'SELECT * FROM delivery_session_leases WHERE session_id=?', sessionId)[0]
      expect(resumedLease).toMatchObject({ state: 'released', principal_record_id: owner.id, principal_version: owner.version })
      expect(resumedLease.fencing_token).toBeGreaterThan(scheduledLease.fencing_token)
      await stop()
      const duty = query(automationsPath, 'SELECT * FROM duty_lease')[0]
      host = await startHost(env); hostNumber++
      await expect.poll(() => query(automationsPath, 'SELECT fencing_token FROM duty_lease')[0]?.fencing_token).toBeGreaterThan(duty.fencing_token)
      await stop()
      expect(await callsAt(modelLog)).toEqual(calls)
      expect(query(isolationPath, 'SELECT id FROM isolation_jobs')).toHaveLength(1)
      await writeFile(testInfo.outputPath('acceptance.json'), JSON.stringify({ restored, history, stepExecutions, receipts, sourceJobs, verificationJobs, resumedLease }, null, 2), { mode: 0o600 })
    }
    const finalWake = wake()
    const automationTasks = query(automationsPath, 'SELECT * FROM automation_tasks')
    const automationRuns = query(automationsPath, 'SELECT * FROM automation_runs')
    expect(automationTasks).toHaveLength(1); expect(automationRuns).toHaveLength(1)
    const finalDuty = query(automationsPath, 'SELECT * FROM duty_lease')[0]
    expect(finalWake.id).toBe(scheduled.id)
    expect(finalWake.intent_json).toBe(scheduled.intent_json)
    expect(JSON.stringify(frames)).not.toContain('approval/asked'); expect(JSON.stringify(frames)).not.toContain('policy/ask')
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ mode, sessionId, processesStarted: hostNumber, wakeBefore: scheduled, wakeAfter: finalWake,
      automationTasks, automationRuns, finalDuty, calls: await callsAt(modelLog), approvals: 0, nativeGoalId: intent.native.goalId, prompts: 2,
      setup: 'actual installer plus explicit test-only verifier/meter/background Policy and exact persisted-conversation owner route',
      limits: 'deterministic model; stopped-profile owner revocation seed; SIGINT stop request after real dispatch with a 10s forced-stop fallback; no production metering or multi-day benefit claim' }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; errorForEvidence = error; throw error } finally {
    try {
      if (failed) {
        if (authenticated) await writeFile(testInfo.outputPath('failure-aria.yaml'), await activePage.locator('body').ariaSnapshot().catch(() => 'unavailable'), { mode: 0o600 })
        await writeFile(testInfo.outputPath('failure-error.txt'), sanitize(String(errorForEvidence)), { mode: 0o600 })
        const replies = await Promise.all(http.filter(response => response.headers()['content-type']?.includes('application/json')).map(async response => ({ path: new URL(response.url()).pathname, body: await response.json().catch(() => ({ unavailable: true })) })))
        await writeFile(testInfo.outputPath('failure-http.json'), JSON.stringify(replies, null, 2), { mode: 0o600 })
        const diagnostics = {}
        for (const [name, path] of Object.entries({ goals: goalsPath, wakes: `${goalsPath}.wakes`, executions: `${goalsPath}.executions`, outcomes: `${goalsPath}.outcomes`, budgets: `${goalsPath}.budgets`, verifier: verifierPath, isolation: isolationPath, automations: automationsPath })) {
          try {
            diagnostics[name] = Object.fromEntries(query(path, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(({ name }) => [name, query(path, `SELECT * FROM "${name.replaceAll('"', '""')}"`)]))
          } catch (error) { diagnostics[name] = { unavailable: String(error) } }
        }
        await writeFile(testInfo.outputPath('failure-state.json'), JSON.stringify(diagnostics, null, 2), { mode: 0o600 })
      }
      if (failed && authenticated && !new URL(activePage.url()).searchParams.has('token')) await writeFile(testInfo.outputPath('failure-dom.txt'), await activePage.locator('body').innerText().catch(() => ''), { mode: 0o600 })
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
      await writeFile(testInfo.outputPath('model.jsonl'), await readFile(modelLog, 'utf8').catch(() => ''), { mode: 0o600 })
    } finally { await stop(); for (const item of contexts) await item.close(); await rm(temp, { recursive: true, force: true }) }
  }
})
