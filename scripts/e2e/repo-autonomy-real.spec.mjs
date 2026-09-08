import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { parseDocument, isMap } from 'yaml'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const image = 'sha256:321f72f637710ad1a69425cd0915a7a8a6101f325080ab5eefc19f244eeaefc8'
const objective = 'Fix summarize.mjs: read a JSON order array from stdin, ignore cancelled orders, sum integer amountCents by currency, and print one JSON object with currency keys in dictionary order followed by a newline.'
const cases = [
  { stdin: '[{"currency":"USD","amountCents":100},{"currency":"EUR","amountCents":250},{"currency":"USD","amountCents":75}]\n', expectedStdout: '{"EUR":250,"USD":175}\n', expectedExitCode: 0 },
  { stdin: '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":-25},{"currency":"EUR","amountCents":5}]\n', expectedStdout: '{"EUR":-20,"USD":100}\n', expectedExitCode: 0 },
  { stdin: '[]\n', expectedStdout: '{}\n', expectedExitCode: 0 },
]
const buggySource = "process.stdin.on('data', value => console.log(JSON.stringify(JSON.parse(value))))"

function addObserver(source) {
  const patch = parseDocument(source)
  patch.contents.add(patch.createNode({ insert: [{ id: 'repo-autonomy-real-observer', name: resolve(root, 'scripts/e2e/repo-autonomy-observer.mjs') }] }))
  return String(patch)
}

async function waitForCompletion(page, home, sessionId, approvals) {
  const goals = join(home, 'assistant-goals/web.sqlite')
  const delivery = join(home, 'assistant-delivery/state.sqlite')
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    if (existsSync(goals)) {
      const record = query(goals, 'SELECT * FROM goal_records ORDER BY created_at DESC LIMIT 1')[0]
      if (record && JSON.parse(record.native_json).phase === 'complete') return record
    }
    // This represents the browser owner acknowledging an actual UI request. It
    // intentionally does not inspect, filter, reorder, or manufacture tools.
    const allow = page.getByRole('button', { name: 'Allow once', exact: true })
    if (await allow.count()) { approvals.push({ at: Date.now() }); await allow.click(); continue }
    const dead = query(delivery, "SELECT failure_code FROM inbox_messages WHERE status = 'dead_letter' ORDER BY received_at DESC LIMIT 1")[0]
    if (dead) throw new Error(`owner input was rejected: ${dead.failure_code}`)
    await page.waitForTimeout(250)
  }
  throw new Error(`real repository task did not independently complete for Session ${sessionId}`)
}

test('formal autonomy install admits a configured gateway route and independently verifies an isolated repository fix', async ({ page, context }, testInfo) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-repo-autonomy-real-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), taskPath = join(temp, 'private-goal.json'), observerLog = join(temp, 'observer.jsonl')
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer(); server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolvePort(address.port)) })
  })
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_ENHANCED_WEB_PORT: String(port), DSH_REPO_AUTONOMY_OBSERVER_LOG: observerLog,
    DSH_REPO_AUTONOMY_MAX_CALLS: '8', DSH_REPO_AUTONOMY_DURATION_MS: '300000' }
  let host; let restarted; let activePage = page; let failed = false
  const http = [], transport = [], streams = new Map(), frames = [], approvals = []
  observePage(page, http, transport, streams, frames)
  try {
    await mkdir(workspace)
    const route = await prepareRealRoute({ env, home, workspace })
    env.DSH_WEB_REAL_PROVIDER = route.provider; env.DSH_WEB_REAL_MODEL = route.model
    const install = await run('bash', [resolve(root, 'scripts/install/install-local.sh'), '--scenario', 'autonomy', '--workspace', workspace,
      '--isolation-image', image, '--isolation-max-runs', '12', '--isolation-lease-minutes', '10', '--isolation-runtime-minutes', '5', '--model', 'skip', '--model-route', 'skip', '--no-service', '--yes'], env, 180_000)
    await writeFile(testInfo.outputPath('install.log'), sanitize(install), { mode: 0o600 })
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

    const admission = { version: 2, objective, route: configuredRoute, maxGoalRounds: 3, stepMaxDurationMs: 60_000,
      executionBudget: { mode: 'calls', modelCalls: 6, toolCalls: 8, durationMs: 300_000, maxOutputTokensPerCall: 1024, routes: [configuredRoute] },
      verification: { artifactPath: 'summarize.mjs', command: 'node /workspace/artifact', maxRuns: 12, maxTotalDurationMs: 240_000, maxDurationMs: 5_000, maxOutputBytes: 4096, cases } }
    await writeFile(taskPath, JSON.stringify(admission), { mode: 0o600 })
    // Deliberately omit --session-id: this exercises the shipped real binding discovery.
    const setup = await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace, '--goal-admission', taskPath], env)
    await writeFile(testInfo.outputPath('goal-setup.log'), sanitize(setup), { mode: 0o600 })
    expect(setup).toContain(`Session: ${sessionId}`)

    host = await startHost(env)
    await activePage.goto(host.url)
    const workspaceRow = activePage.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(workspaceRow).toBeVisible()
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await activePage.getByRole('treeitem').filter({ hasText: 'New conversation' }).first().click().catch(() => {})
    // The owner supplies the failing source as ordinary request content. An
    // isolation job receives only its own inline files, never this Host path.
    const prompt = `Here is the failing starting program:\n\n${buggySource}\n\n${objective} Please work on this as a finite goal. You may investigate and test as needed. The acceptance conditions are the objective above; independent verification is configured separately.`
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
    expect(calls.filter(item => item.event === 'dispatch').length).toBeLessThanOrEqual(8)
    expect(calls.some(item => item.event === 'settled')).toBe(true)

    await host.stop(); await writeFile(testInfo.outputPath('host-first.log'), host.log(), { mode: 0o600 })
    const sourceDigest = createHash('sha256').update(JSON.stringify(sourceJobs)).digest('hex')
    host = await startHost(env); restarted = await context.browser().newContext(); activePage = await restarted.newPage()
    observePage(activePage, http, transport, streams, frames); await activePage.goto(host.url)
    await expect(activePage.getByRole('treeitem', { name: 'workspace', exact: true })).toBeVisible()
    const restored = query(join(home, 'assistant-goals/web.sqlite'), 'SELECT * FROM goal_records WHERE id = ?', goal.id)[0]
    expect({ native: JSON.parse(restored.native_json), scope: JSON.parse(restored.scope_json) }).toEqual({ native, scope })
    expect(createHash('sha256').update(JSON.stringify(query(ledger, "SELECT id, status, artifact_binding_json FROM isolation_jobs WHERE status = 'succeeded' AND artifact_binding_json IS NOT NULL ORDER BY id"))).digest('hex')).toBe(sourceDigest)
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ route: route.proof, sessionId, goalId: goal.id, scope, native,
      calls, approvals: approvals.length, sourceJobs, receipts, restart: { sameGoal: true, sameSourceJobEvidence: true },
      limitation: 'Real gateway integration evidence only; it does not establish a GitHub PR lifecycle, token/USD hard limits, or long-running autonomy.' }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    try {
      if (existsSync(observerLog)) await copyFile(observerLog, testInfo.outputPath('observer.jsonl'))
      await writeFile(testInfo.outputPath('approvals.json'), JSON.stringify(approvals), { mode: 0o600 })
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
      if (failed && !new URL(activePage.url()).searchParams.has('token')) await writeFile(testInfo.outputPath('failure-dom.txt'), sanitize(await activePage.locator('body').innerText().catch(() => '')), { mode: 0o600 })
    } finally { try { if (host) { await host.stop(); await writeFile(testInfo.outputPath('host.log'), host.log(), { mode: 0o600 }) } } finally { if (restarted) await restarted.close(); await rm(temp, { recursive: true, force: true }) } }
  }
})
