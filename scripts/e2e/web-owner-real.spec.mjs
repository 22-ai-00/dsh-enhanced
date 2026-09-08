import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { objective, criteria, setConfig, contracts, jobs, waitForVerifiedGoal } from './web-owner-real-helpers.mjs'
import { readSessionAudit } from './web-owner-real-audit.mjs'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
test('real configured route completes a browser-owned verified native goal across Host restart', async ({ page, context }, testInfo) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-web-owner-real-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), modelLog = join(temp, 'model.jsonl')
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_WEB_REAL_LOG: modelLog, DSH_WEB_REAL_WORKSPACE: workspace }
  let host; let restartedContext; let activePage = page; let authenticated = false; let failed = false
  const approved = []
  const http = [], transport = [], streams = new Map(), frames = []
  observePage(page, http, transport, streams, frames)
  try {
    await mkdir(workspace)
    const route = await prepareRealRoute({ env, home, workspace })
    env.DSH_WEB_REAL_PROVIDER = route.provider
    env.DSH_WEB_REAL_MODEL = route.model
    await run('zstd', ['--version'], env)
    const installed = await run('dsh', ['plugin', '--profile', 'web', 'add', ...['personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner', 'assistant-verifier', 'assistant-evaluation', ...route.bundles].map(name => resolve(root, 'plugins', name))], env)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace], env)
    const deliveryPath = join(home, 'assistant-delivery/state.sqlite'), goalsPath = join(home, 'assistant-goals/web.sqlite'), verifierPath = join(home, 'assistant-verifier/verification.sqlite')
    const owner = query(deliveryPath, "SELECT id, version, principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active'")[0]
    if (!owner) throw new Error('setup did not create the Web owner principal')
    expect(JSON.parse(owner.principal_json)).toEqual({ channel: 'web', account: 'web', tenant: 'local', user: 'operator' })
    const { createVerifierAuthorities } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-verifier/lib/index.js')).href)
    const authority = { kind: 'runner', id: 'node', executable: process.execPath, fixedArgs: [], timeoutMs: 5_000, maxOutputBytes: 16_384 }
    const [runner] = createVerifierAuthorities({ authorities: [authority] })
    const profile = taskKind => ({ id: `real-${taskKind}`, version: 1, scope: { workspace, preset: 'standard' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, taskKind, objective, validityMs: 600_000, bounds: { maxDurationMs: 15_000, maxEvidenceBytes: 16_384 }, criteria: (taskKind === 'goal-step' ? criteria.slice(0, 1) : criteria).map(entry => ({ id: entry.id, kind: 'process-behavior', authority: { id: runner.id, digest: runner.digest }, artifactPath: 'summarize.mjs', stdin: entry.stdin, expectedStdout: entry.expectedStdout, expectedExitCode: 0 })) })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml'), patch = parseDocument(await readFile(patchPath, 'utf8'))
    setConfig(patch, 'dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', { databasePath: goalsPath, verifyNativeRounds: true, verifyGoalOutcome: true, stepMaxDurationMs: 120_000 })
    setConfig(patch, 'dsh-enhanced-assistant-web-owner', '@dsh-enhanced/assistant-web-owner', { maxExecutionMs: 300_000 })
    setConfig(patch, 'dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', { databasePath: verifierPath, tickIntervalMs: 500, requireAcceptance: false, authorities: [authority], profiles: [profile('goal-step'), profile('goal-outcome')] })
    route.configurePatch(patch, setConfig)
    patch.contents.add(patch.createNode({ id: 'session-title-llm', disabled: true }))
    patch.contents.add(patch.createNode({ insert: [{ id: 'web-owner-real-guard', name: resolve(root, 'scripts/e2e/web-owner-real-guard.mjs') }] }))
    expect(String(patch)).not.toContain('web-owner-model')
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    host = await startHost(env)
    const origin = new URL(host.url).origin
    try { await page.goto(host.url) } catch { throw new Error('Browser launch authentication failed (URL redacted)') }
    await expect(page).toHaveURL(`${origin}/`); authenticated = true
    await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => http.find(response => new URL(response.url()).pathname === '/api/session/create')).toBeTruthy()
    const created = http.find(response => new URL(response.url()).pathname === '/api/session/create'); expect(created.status()).toBe(200)
    const sessionId = (await created.json()).result.value.sessionId
    const composer = page.getByLabel(/Describe what you want to build|Message or run a task/)
    const submittedPrompt = `Create a goal with objective exactly: '${objective}' amountCents is an integer; combine entries by currency, ignore orders whose status is 'cancelled', and output currency keys in dictionary order. Use goal_create with max_goal_rounds 2 and start_native_rounds true to hand off this turn to the native goal driver. Do not implement code in this turn. For the subsequent goal round: the workspace is empty; use the write tool to create summarize.mjs directly. Shell, other files and permission escalation are outside this experiment. Skip todo/plan and inspection tools. End the round after writing the artifact: the configured independent verifier will validate and complete the goal. After writing, reply with plain text (no Markdown), describing the result. Keep the entire experiment within ten model calls.`
    await composer.fill(submittedPrompt)
    const prompt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await prompt).status()).toBe(200)
    await waitForVerifiedGoal(page, goalsPath, verifierPath, deliveryPath, approved, frames, sessionId, workspace)
    const goal = query(goalsPath, 'SELECT * FROM goal_records')[0], native = JSON.parse(goal.native_json), scope = JSON.parse(goal.scope_json)
    const stepContracts = contracts(verifierPath, 'goal-step'), outcomeContracts = contracts(verifierPath, 'goal-outcome')
    const stepJobs = jobs(verifierPath, stepContracts.map(row => row.id)), outcomeJobs = jobs(verifierPath, outcomeContracts.map(row => row.id))
    expect(goal.original_objective).toBe(objective); expect(scope).toMatchObject({ workspace, preset: 'standard', principalRecordId: owner.id, principalVersion: owner.version })
    expect(stepContracts[0].contract).toMatchObject({ protocol: 'task-acceptance/v2', scope: { workspace, preset: 'standard' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, task: { kind: 'goal-step', goal: { sessionId, nativeGoalId: native.goalId } } })
    expect(stepJobs.some((row, index) => stepContracts[index].contract.task.goal.nativeGoalId === native.goalId && stepContracts[index].contract.task.goal.sessionId === sessionId && row.state === 'done' && row.execution?.status === 'succeeded' && row.receipt?.objectiveStatus === 'achieved')).toBe(true)
    expect(outcomeContracts.at(-1).contract).toMatchObject({ protocol: 'task-acceptance/v3', scope: { workspace, preset: 'standard' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, task: { kind: 'goal-outcome', goal: { sessionId, nativeGoalId: native.goalId } } })
    expect(outcomeJobs.at(-1)).toMatchObject({ state: 'done', execution: { status: 'succeeded' }, receipt: { objectiveStatus: 'achieved' } })
    expect(native.phase).toBe('complete')
    const modelCalls = (await readFile(modelLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(modelCalls.filter(entry => entry.event === 'dispatch')).not.toHaveLength(0)
    expect(modelCalls.filter(entry => entry.event === 'dispatch').length).toBeLessThanOrEqual(10)
    expect(modelCalls.some(entry => entry.event === 'settled' && entry.usage !== null)).toBe(true)
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    const response = frames.flatMap(frame => frame.value?.type === 'event' && frame.value.event?.type === 'assistant/message'
      ? [frame.value.event.data] : []).findLast(data => data.message.content.some(block => block.type === 'text' && block.text.trim()))
    const responseText = response?.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(responseText?.trim().length).toBeGreaterThan(0)
    // Match actual model output, rather than the user prompt containing the filename.
    // Check the actual reply's prose paragraph; Markdown list markers below
    // it are intentionally absent from rendered browser text.
    const visibleReply = responseText.split(/\n\s*\n/u)[0].replace(/[`*_]/gu, '').replace(/\s+/gu, ' ').trim()
    expect(visibleReply.length).toBeGreaterThan(20)
    expect(submittedPrompt.replace(/\s+/gu, ' ')).not.toContain(visibleReply)
    await expect(page.getByText(visibleReply, { exact: true })).toBeVisible()
    await host.stop()
    await writeFile(testInfo.outputPath('host-first.log'), host.log(), { mode: 0o600 })
    const beforeRestart = { id: goal.id, native, scope, sourceDigest: createHash('sha256').update(await readFile(join(workspace, 'summarize.mjs'))).digest('hex') }
    const restartFrameStart = frames.length
    host = await startHost(env)
    restartedContext = await context.browser().newContext()
    activePage = await restartedContext.newPage()
    observePage(activePage, http, transport, streams, frames)
    try { await activePage.goto(host.url) } catch { throw new Error('Restarted browser authentication failed (URL redacted)') }
    await expect(activePage).toHaveURL(`${new URL(host.url).origin}/`)
    const workspaceRow = activePage.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(workspaceRow).toBeVisible()
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await activePage.getByRole('treeitem', { name: /Create a goal with objective/ }).click()
    // Reading the persisted completed Session must not rerun its model or artifact.
    await expect(activePage.getByText(visibleReply, { exact: true })).toBeVisible()
    await expect.poll(() => frames.slice(restartFrameStart)
      .flatMap(frame => frame.value?.type === 'snapshot' ? frame.value.records : frame.value?.type === 'event' ? [frame.value] : [])
      .some(record => record.type === 'event' && record.event?.type === 'assistant/message'
        && record.event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') === responseText)).toBe(true)
    const restored = query(goalsPath, 'SELECT * FROM goal_records')[0]
    expect({ id: restored.id, native: JSON.parse(restored.native_json), scope: JSON.parse(restored.scope_json),
      sourceDigest: createHash('sha256').update(await readFile(join(workspace, 'summarize.mjs'))).digest('hex') }).toEqual(beforeRestart)
    expect((await readFile(modelLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual(modelCalls)
    await host.stop()
    const audit = await readSessionAudit(home, workspace, sessionId)
    expect(audit.reviewer).toBe('user')
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'permission/preset', data: { preset: 'workspace-write' } }),
      expect.objectContaining({ type: 'sandbox/mode', data: { mode: 'workspace-write' } }),
      expect.objectContaining({ type: 'approval/policy', data: { policy: 'ask' } }),
    ]))
    const goalCall = audit.events.find(event => event.type === 'tool/call' && event.data.name === 'goal_create')
    expect(goalCall?.data.arguments).toEqual({ objective, max_goal_rounds: 2, start_native_rounds: true })
    const writes = audit.events.filter(event => event.type === 'tool/call' && ['write', 'edit'].includes(event.data.name))
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      const start = audit.events.findLast(event => event.type === 'turn/start' && event.seq < write.seq)
      expect(start?.data.turn).toBe(write.data.turn)
      expect(audit.events.some(event => event.seq > start.seq && event.seq < write.seq
        && event.type === 'user/message' && event.data.source?.kind === 'goal' && event.data.source.round > 0)).toBe(true)
    }
    const asked = audit.events.find(event => event.type === 'approval/asked' && event.data.callId === goalCall?.data.callId)
    expect(asked?.data.toolName).toBe('goal_create')
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'approval/decided', data: expect.objectContaining({ id: asked.data.id, outcome: 'allowed-once' }) }))
    expect(approved).toContainEqual(expect.objectContaining({ toolName: 'goal_create', callId: goalCall.data.callId, agentId: sessionId }))
    for (const granted of approved) {
      const linkedCall = audit.events.find(event => event.type === 'tool/call' && event.data.callId === granted.callId)
      expect(linkedCall?.data.name).toBe(granted.toolName)
      const linkedAsk = audit.events.find(event => event.type === 'approval/asked' && event.data.callId === granted.callId)
      expect(linkedAsk?.data.toolName).toBe(granted.toolName)
      expect(audit.events).toContainEqual(expect.objectContaining({ type: 'approval/decided', data: expect.objectContaining({ id: linkedAsk.data.id, outcome: 'allowed-once' }) }))
    }
    await writeFile(testInfo.outputPath('session-audit.json'), JSON.stringify(audit, null, 2), { mode: 0o600 })
    await copyFile(join(workspace, 'summarize.mjs'), testInfo.outputPath('summarize.mjs'))
    await writeFile(testInfo.outputPath('source.sha256'), createHash('sha256').update(await readFile(join(workspace, 'summarize.mjs'))).digest('hex') + '  summarize.mjs\n', { mode: 0o600 })
    await copyFile(modelLog, testInfo.outputPath('model.jsonl'))
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ objective, sourceArtifact: 'summarize.mjs', noFixture: true, ...route.proof, restart: { hostStarts: 2, sameCompletedGoal: true, artifactUnchanged: true, noExtraModelDispatch: true, exactReplyRestored: true, visibleReplyAbsentFromUserPrompt: true }, dispatchLimit: 10, approvalReviewer: audit.reviewer, finalLease: 'released', sessionId, goalId: goal.id, scope, native, runner: { id: runner.id, digest: runner.digest }, approved, modelCalls, stepContracts: stepContracts.map(({ id, contract }) => ({ id, protocol: contract.protocol, task: contract.task, criteria: contract.criteria })), stepJobs, outcomeContracts: outcomeContracts.map(({ id, contract }) => ({ id, protocol: contract.protocol, task: contract.task, criteria: contract.criteria })), outcomeJobs, streams: [...streams.values()] }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    try {
      await writeFile(testInfo.outputPath('approvals.json'), JSON.stringify(approved, null, 2), { mode: 0o600 })
      if (existsSync(modelLog)) await copyFile(modelLog, testInfo.outputPath('model.jsonl'))
      if (existsSync(join(workspace, 'summarize.mjs'))) await copyFile(join(workspace, 'summarize.mjs'), testInfo.outputPath('summarize.mjs'))
      if (authenticated && failed && !new URL(activePage.url()).searchParams.has('token')) { await activePage.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {}); await writeFile(testInfo.outputPath('failure-dom.txt'), sanitize(await activePage.locator('body').innerText().catch(() => '')), { mode: 0o600 }) }; await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 }) } finally { try { if (host) { await host.stop(); await writeFile(testInfo.outputPath('host.log'), host.log(), { mode: 0o600 }) } } finally { if (restartedContext) await restartedContext.close(); await rm(temp, { recursive: true, force: true }) } }
  }
})
