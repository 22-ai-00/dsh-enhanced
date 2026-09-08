import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { parseDocument, isMap } from 'yaml'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'
import { configureVerifiedDelivery } from './repo-verified-delivery-fixture.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const image = 'sha256:321f72f637710ad1a69425cd0915a7a8a6101f325080ab5eefc19f244eeaefc8'
const verifiedDelivery = process.env.DSH_REPO_VERIFIED_DELIVERY === 'fixture'
const objective = 'Fix summarize.mjs: read a JSON order array from stdin, ignore orders whose status is "cancelled", sum integer amountCents by currency, and print one JSON object with currency keys in dictionary order followed by a newline.'
const cases = [
  { stdin: '[{"currency":"USD","amountCents":100},{"currency":"EUR","amountCents":250},{"currency":"USD","amountCents":75}]\n', expectedStdout: '{"EUR":250,"USD":175}\n', expectedExitCode: 0 },
  { stdin: '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":-25},{"currency":"EUR","amountCents":5}]\n', expectedStdout: '{"EUR":-20,"USD":100}\n', expectedExitCode: 0 },
  { stdin: '[]\n', expectedStdout: '{}\n', expectedExitCode: 0 },
]
const buggySource = "process.stdin.on('data', value => console.log(JSON.stringify(JSON.parse(value))))"
const verificationCommand = '/bin/busybox cp /workspace/artifact /workspace/program.mjs && node /workspace/program.mjs < /workspace/input'

async function checkVerificationCommand(home, temp) {
  const { IsolatedVerifierRunner } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-isolation/lib/index.js')).href)
  const runner = new IsolatedVerifierRunner({ stateRoot: join(temp, 'fixture-control'), image, dockerPath: '/usr/bin/docker',
    authorityDigest: createHash('sha256').update(verificationCommand).digest('hex'), command: verificationCommand,
    expiresAt: Date.now() + 60_000, maxRuns: 2, maxTotalDurationMs: 10_000, maxDurationMs: 5_000, maxOutputBytes: 4096 })
  try {
    const positive = await runner.run('stdin-control', "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync(0, 'utf8'))", 'fixture input\n', new AbortController().signal)
    expect(positive).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'fixture input\n' })
    const negative = await runner.run('exit-control', 'process.exit(19)', 'fixture input\n', new AbortController().signal)
    expect(negative).toMatchObject({ status: 'failed', quiescent: true, exitCode: 19 })
    return { positive, negative }
  } finally { await runner.close() }
}

function addObserver(source) {
  const patch = parseDocument(source)
  patch.contents.add(patch.createNode({ insert: [{ id: 'repo-autonomy-real-observer', name: resolve(root, 'scripts/e2e/repo-autonomy-observer.mjs') }] }))
  return String(patch)
}

async function waitForCompletion(page, home, sessionId, approvals) {
  const goals = join(home, 'assistant-goals/web.sqlite')
  const delivery = join(home, 'assistant-delivery/state.sqlite')
  const deadline = Date.now() + 300_000
  const currentGoal = () => existsSync(goals)
    ? query(goals, "SELECT * FROM goal_records WHERE json_extract(native_json, '$.sessionId') = ? ORDER BY created_at DESC LIMIT 1", sessionId)[0]
    : undefined
  while (Date.now() < deadline) {
    const record = currentGoal()
    if (record && JSON.parse(record.native_json).phase === 'complete') return record
    // This represents the browser owner acknowledging an actual UI request. It
    // intentionally does not inspect, filter, reorder, or manufacture tools.
    const allow = page.getByRole('button', { name: 'Allow once', exact: true })
    if (await allow.count()) { approvals.push({ at: Date.now() }); await allow.click(); continue }
    const input = query(delivery, `SELECT message.status, message.failure_code FROM inbox_messages AS message
      JOIN conversation_bindings AS binding ON binding.id = message.binding_id
      WHERE binding.session_id = ? ORDER BY message.received_at DESC LIMIT 1`, sessionId)[0]
    if (input?.status === 'dead_letter') throw new Error(`owner input was rejected: ${input.failure_code}`)
    // Delivery marks processed only after the native owner turn and teardown
    // settle. Re-read Goal state after that fence to avoid a cross-DB read race.
    if (input?.status === 'processed' && !currentGoal()) throw new Error('owner turn completed without establishing a Goal')
    if (record && ['paused', 'blocked'].includes(JSON.parse(record.native_json).phase)
      && query(delivery, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state === 'released') {
      throw new Error('native Goal paused or blocked with no active owner execution; inspect independent acceptance and budget evidence')
    }
    await page.waitForTimeout(250)
  }
  throw new Error(`real repository task did not independently complete for Session ${sessionId}`)
}

test('formal autonomy install independently verifies an ordinary isolated repository task', async ({ page, context }, testInfo) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-repo-autonomy-real-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), taskPath = join(temp, 'private-goal.json'), observerLog = join(temp, 'observer.jsonl')
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer(); server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolvePort(address.port)) })
  })
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_ENHANCED_WEB_PORT: String(port), DSH_REPO_AUTONOMY_OBSERVER_LOG: observerLog,
    DSH_REPO_AUTONOMY_MAX_CALLS: '14', DSH_REPO_AUTONOMY_DURATION_MS: '300000' }
  let host; let restarted; let activePage = page; let failed = false
  const http = [], transport = [], streams = new Map(), frames = [], approvals = []
  observePage(page, http, transport, streams, frames)
  try {
    await mkdir(workspace)
    const route = await prepareRealRoute({ env, home, workspace })
    env.DSH_WEB_REAL_PROVIDER = route.provider; env.DSH_WEB_REAL_MODEL = route.model
    const install = await run('bash', [resolve(root, 'scripts/install/install-local.sh'), '--scenario', 'autonomy', '--workspace', workspace,
      '--isolation-image', image, '--isolation-max-runs', '12', '--isolation-lease-minutes', '10', '--isolation-runtime-minutes', '5', '--model', 'skip', '--model-route', 'skip',
      ...(route.provider === 'codex-subscription' ? ['--with', 'coding'] : []), '--no-service', '--yes'], env, 180_000)
    await writeFile(testInfo.outputPath('install.log'), sanitize(install), { mode: 0o600 })
    await writeFile(testInfo.outputPath('verifier-controls.json'), JSON.stringify(await checkVerificationCommand(home, temp), null, 2), { mode: 0o600 })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml')
    let patchSource = await readFile(patchPath, 'utf8')
    const configuredRoute = { provider: route.provider, model: route.model }
    if (route.provider === 'codex-subscription') {
      const patch = parseDocument(patchSource)
      route.configurePatch(patch, (document, id, name, config) => {
        let row = document.contents.items.find(item => isMap(item) && item.get('id') === id)
        if (!row) { row = document.createNode({ id, name }); document.contents.add(row) }
        row.set('config', document.createNode(config))
      })
      patchSource = String(patch)
      configuredRoute.model = 'default'
    }
    await writeFile(patchPath, addObserver(patchSource), { mode: 0o600 })

    // The native Web UI, not the test, creates the first durable Session.
    host = await startHost(env)
    await page.goto(host.url); await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => http.find(response => new URL(response.url()).pathname === '/api/session/create')).toBeTruthy()
    const create = http.find(response => new URL(response.url()).pathname === '/api/session/create')
    const sessionId = (await create.json()).result.value.sessionId
    await host.stop(); await writeFile(testInfo.outputPath('host-initial.log'), host.log(), { mode: 0o600 })

    const admission = { version: 2, objective, route: configuredRoute, maxGoalRounds: 3, stepMaxDurationMs: 120_000,
      executionBudget: { mode: 'calls', modelCalls: 12, toolCalls: 16, durationMs: 300_000, maxOutputTokensPerCall: 1024, routes: [configuredRoute] },
      verification: { artifactPath: 'summarize.mjs', command: verificationCommand, maxRuns: 12, maxTotalDurationMs: 240_000, maxDurationMs: 5_000, maxOutputBytes: 4096, cases },
      ...(verifiedDelivery ? { wake: { maxDelayMs: 60000, runTimeoutMs: 60000, maxRuns: 3 } } : {}) }
    await writeFile(taskPath, JSON.stringify(admission), { mode: 0o600 })
    // Deliberately omit --session-id: this exercises the shipped real binding discovery.
    const setup = await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace, '--goal-admission', taskPath], env)
    await writeFile(testInfo.outputPath('goal-setup.log'), sanitize(setup), { mode: 0o600 })
    expect(setup).toContain(`Session: ${sessionId}`)
    if (verifiedDelivery) await configureVerifiedDelivery(home, patchPath, env)

    host = await startHost(env)
    await activePage.goto(host.url)
    const workspaceRow = activePage.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(workspaceRow).toBeVisible()
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await activePage.getByRole('treeitem').filter({ hasText: 'New conversation' }).first().click().catch(() => {})
    // The owner supplies the failing source as ordinary request content. An
    // isolation job receives only its own inline files, never this Host path.
    const prompt = `Here is the failing starting program:\n\n${buggySource}\n\n${objective} Please work on this as a finite goal. You may investigate and test as needed. The acceptance conditions are the objective above; independent verification is configured separately.${verifiedDelivery ? ' Arrange delivery of the independently accepted repair to the authorized repository branch and open a pull request. Use the available repository authorization and inspect the current branch before preparing delivery.' : ''}`
    await activePage.getByLabel(/Describe what you want to build|Message or run a task/).fill(prompt)
    const sent = activePage.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await activePage.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await sent).status()).toBe(200)
    const goal = await waitForCompletion(activePage, home, sessionId, approvals)
    const native = JSON.parse(goal.native_json), scope = JSON.parse(goal.scope_json)
    expect(goal.original_objective).toBe(objective)
    expect(native.sessionId).toBe(sessionId)

    const verifier = join(home, 'assistant-verifier/verification.sqlite')
    const receipts = query(verifier, 'SELECT payload FROM acceptance_receipts').map(row => JSON.parse(row.payload))
    expect(receipts.some(receipt => receipt.task?.kind === 'goal-step' && receipt.objectiveStatus === 'achieved')).toBe(true)
    expect(receipts.some(receipt => receipt.task?.kind === 'goal-outcome' && receipt.objectiveStatus === 'achieved')).toBe(true)
    const ledger = join(home, 'assistant-isolation/web/ledger.sqlite')
    const sourceJobs = query(ledger, "SELECT id, status, artifact_binding_json FROM isolation_jobs WHERE status = 'succeeded' AND artifact_binding_json IS NOT NULL ORDER BY id")
    expect(sourceJobs.some(job => JSON.parse(job.artifact_binding_json).paths.includes('summarize.mjs'))).toBe(true)
    expect(existsSync(join(workspace, 'summarize.mjs'))).toBe(false)
    const calls = (await readFile(observerLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(calls.filter(item => item.event === 'dispatch').length).toBeLessThanOrEqual(14)
    expect(calls.some(item => item.event === 'settled')).toBe(true)
    let repositoryDelivery
    if (verifiedDelivery) {
      const path = join(home, 'assistant-actions/verified-delivery.sqlite')
      expect(query(path, 'SELECT state FROM deliveries').length, 'completed artifact goal did not register a repository delivery intent').toBeGreaterThan(0)
      await expect.poll(() => query(path, 'SELECT state FROM deliveries')[0]?.state, { timeout: 65000 }).toBe('succeeded')
      const records = (await readFile(env.DSH_REPO_DELIVERY_FIXTURE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(records.map(item => item.kind)).toEqual(['commit', 'pr'])
      const commit = records[0], pr = records[1]
      const digest = createHash('sha256').update(commit.files[0].content).digest('hex')
      expect(commit.files[0].path).toBe('summarize.mjs')
      expect(receipts.every(receipt => receipt.results.some(result => result.artifactDigest === digest))).toBe(true)
      expect(commit.at).toBeGreaterThanOrEqual(Math.max(...receipts.map(receipt => receipt.completedAt)))
      expect(pr.headOid).toBe(commit.commitOid)
      const notices = () => query(join(home, 'assistant-delivery/state.sqlite'), "SELECT id,status,intent_json FROM outbox_messages WHERE json_extract(intent_json, '$.metadata.\"dsh.native-notice.sourceId\"') = 'assistant-actions-verified-delivery/v1'")
      await expect.poll(() => notices().map(row => row.status)).toEqual(['accepted'])
      const noticeText = JSON.parse(notices()[0].intent_json).text
      expect(noticeText).toContain(commit.commitOid)
      expect(noticeText).toContain(String(pr.number))
      await expect(activePage.getByLabel('主动提醒', { exact: true })).toContainText(noticeText)
      repositoryDelivery = { transport: 'explicit-fixture-not-live-github', records, state: query(path, 'SELECT id,state,result FROM deliveries'), notices: notices(), noticeText }
    }
    await expect.poll(() => query(join(home, 'assistant-delivery/state.sqlite'), 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    const response = frames.flatMap(frame => frame.value?.type === 'event' && frame.value.event?.type === 'assistant/message'
      ? [frame.value.event.data] : []).findLast(data => data.turn > 1 && data.message.content.some(block => block.type === 'text' && block.text.trim()))
    const responseText = response?.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(responseText?.trim().length).toBeGreaterThan(0)
    const visibleReply = responseText.split(/\n\s*\n/u)[0].replace(/[`*_#]/gu, '').replace(/\s+/gu, ' ').trim()
    expect(prompt.replace(/\s+/gu, ' ')).not.toContain(visibleReply)
    await expect(activePage.getByText(visibleReply, { exact: true })).toBeVisible()
    const sessionTitle = await activePage.getByRole('navigation', { name: 'Session hierarchy' }).getByRole('button').first().innerText()
    expect(sessionTitle.trim().length).toBeGreaterThan(0)

    await host.stop(); await writeFile(testInfo.outputPath('host-first.log'), host.log(), { mode: 0o600 })
    const sourceDigest = createHash('sha256').update(JSON.stringify(sourceJobs)).digest('hex')
    host = await startHost(env); restarted = await context.browser().newContext(); activePage = await restarted.newPage()
    observePage(activePage, http, transport, streams, frames); await activePage.goto(host.url)
    const restoredWorkspace = activePage.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(restoredWorkspace).toBeVisible()
    if (await restoredWorkspace.getAttribute('aria-expanded') === 'false') await restoredWorkspace.click()
    await activePage.getByRole('treeitem', { name: sessionTitle, exact: false }).click()
    await expect(activePage.getByText(visibleReply, { exact: true })).toBeVisible()
    const restored = query(join(home, 'assistant-goals/web.sqlite'), 'SELECT * FROM goal_records WHERE id = ?', goal.id)[0]
    expect({ native: JSON.parse(restored.native_json), scope: JSON.parse(restored.scope_json) }).toEqual({ native, scope })
    expect(createHash('sha256').update(JSON.stringify(query(ledger, "SELECT id, status, artifact_binding_json FROM isolation_jobs WHERE status = 'succeeded' AND artifact_binding_json IS NOT NULL ORDER BY id"))).digest('hex')).toBe(sourceDigest)
    if (verifiedDelivery) {
      expect(query(join(home, 'assistant-actions/verified-delivery.sqlite'), 'SELECT id,state,result FROM deliveries')).toEqual(repositoryDelivery.state)
      expect((await readFile(env.DSH_REPO_DELIVERY_FIXTURE_LOG, 'utf8')).trim().split('\n')).toHaveLength(2)
      await expect(activePage.getByLabel('主动提醒', { exact: true })).toContainText(repositoryDelivery.noticeText)
      expect(query(join(home, 'assistant-delivery/state.sqlite'), "SELECT id,status,intent_json FROM outbox_messages WHERE json_extract(intent_json, '$.metadata.\"dsh.native-notice.sourceId\"') = 'assistant-actions-verified-delivery/v1'")).toEqual(repositoryDelivery.notices)
    }
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ route: route.proof, sessionId, goalId: goal.id, scope, native,
      calls, approvals: approvals.length, sourceJobs, receipts, ...(repositoryDelivery ? { repositoryDelivery } : {}), resultFeedback: { turn: response.turn, visibleReply }, restart: { sameGoal: true, sameSourceJobEvidence: true, replyVisible: true },
      limitation: 'Real gateway integration evidence only; it does not establish a GitHub PR lifecycle, token/USD hard limits, or long-running autonomy.' }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    try {
      if (existsSync(observerLog)) await copyFile(observerLog, testInfo.outputPath('observer.jsonl'))
      if (env.DSH_REPO_DELIVERY_FIXTURE_LOG && existsSync(env.DSH_REPO_DELIVERY_FIXTURE_LOG)) await copyFile(env.DSH_REPO_DELIVERY_FIXTURE_LOG, testInfo.outputPath('github-fixture.jsonl'))
      await writeFile(testInfo.outputPath('approvals.json'), JSON.stringify(approvals), { mode: 0o600 })
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
      // This fixed, credential-free task can retain its visible tool evidence.
      // Never capture raw LLM request headers or provider authentication state.
      const toolEvents = frames.flatMap(frame => frame.value?.type === 'event' && ['tool/call', 'tool/result'].includes(frame.value.event?.type) ? [frame.value.event] : [])
      await writeFile(testInfo.outputPath('tool-events.json'), sanitize(JSON.stringify(toolEvents, null, 2)), { mode: 0o600 })
      if (failed && !new URL(activePage.url()).searchParams.has('token')) await writeFile(testInfo.outputPath('failure-dom.txt'), sanitize(await activePage.locator('body').innerText().catch(() => '')), { mode: 0o600 })
    } finally { try { if (host) { await host.stop(); await writeFile(testInfo.outputPath('host.log'), host.log(), { mode: 0o600 }) } } finally { if (restarted) await restarted.close(); await rm(temp, { recursive: true, force: true }) } }
  }
})
