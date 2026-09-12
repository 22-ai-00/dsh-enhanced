import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, realpath } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { parseDocument, isMap } from 'yaml'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'
import { selectRestoredSession } from './repo-session-navigation.mjs'
import { prepareRepositoryFixture } from './repo-verified-delivery-fixture.mjs'
import { prepareExternalRepositoryFixture } from './repo-external-delivery-fixture.mjs'
import { loadLiveRepositoryInput, mergeLiveCredentialHandles } from './repo-live-input.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const image = 'sha256:321f72f637710ad1a69425cd0915a7a8a6101f325080ab5eefc19f244eeaefc8'
const verifiedDelivery = process.env.DSH_REPO_VERIFIED_DELIVERY === 'fixture'
const externalBrokerFixture = process.env.DSH_REPO_EXTERNAL_BROKER === 'fixture'
const setupOnly = process.env.DSH_REPO_SETUP_ONLY === '1'
const liveInputPath = process.env.DSH_REPO_LIVE_INPUT
const liveRepositoryEnabled = process.env.DSH_REPO_LIVE_GITHUB === '1' || typeof liveInputPath === 'string'
if (liveRepositoryEnabled && (typeof liveInputPath !== 'string' || liveInputPath.length === 0)) throw new Error('live repository E2E requires DSH_REPO_LIVE_INPUT')
if (liveRepositoryEnabled && (verifiedDelivery || process.env.DSH_REPO_EVENT_SOURCE !== undefined)) throw new Error('live repository E2E cannot use fixture transports')
if (externalBrokerFixture && (!verifiedDelivery || process.env.DSH_REPO_EVENT_SOURCE !== undefined || liveRepositoryEnabled)) throw new Error('external broker fixture requires fixture verified delivery, no events, and no live repository')
if (liveRepositoryEnabled && setupOnly) throw new Error('setup-only probe does not validate live repository access')
const repositoryEvents = (verifiedDelivery && process.env.DSH_REPO_EVENT_SOURCE === 'fixture') || liveRepositoryEnabled
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

function patchRow(document, id) {
  const visit = node => {
    if (isMap(node)) {
      if (node.get('id') === id && isMap(node.get('config', true))) return node
      for (const item of node.items) { const found = visit(item.value); if (found) return found }
    }
    if (Array.isArray(node?.items)) for (const item of node.items) { const found = visit(item); if (found) return found }
  }
  const row = visit(document.contents)
  if (!row || !isMap(row)) throw new Error(`missing profile row ${id}`)
  return row
}

function installLiveCredentialReference(source, live) {
  const patch = parseDocument(source)
  const keychain = patchRow(patch, 'dsh-enhanced-credentials-keychain')
  const config = keychain.get('config', true)
  const handles = config.get('handles', true)
  const current = handles?.toJSON?.() ?? []
  config.set('handles', patch.createNode(mergeLiveCredentialHandles(current, live)))
  return String(patch)
}

function parseJson(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : undefined } catch { return undefined }
}

async function preparePinnedDshCli(temp, env) {
  // The repository declares the pinned DSH ABI; do not silently exercise a
  // developer's globally installed CLI with a different session runtime.
  const cliRoot = join(temp, 'pinned-dsh-cli')
  await mkdir(cliRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(cliRoot, 'package.json'), JSON.stringify({ private: true }), { mode: 0o600 })
  const bin = join(cliRoot, 'node_modules/.bin')
  await run('pnpm', ['add', '--ignore-workspace', '--dir', cliRoot,
    '--allow-build=@deepseek-ai/dsh-subprocess-local', '--allow-build=@google/genai', '--allow-build=koffi', '--allow-build=node-pty', '--allow-build=protobufjs',
    '@deepseek-ai/dsh@0.1.2-rc.1'], env, 120_000)
  if (!existsSync(join(bin, 'dsh'))) throw new Error('pinned DSH CLI installation did not provide dsh')
  if ((await run(join(bin, 'dsh'), ['--version'], env)).trim() !== '0.1.2-rc.1') throw new Error('pinned DSH CLI resolved an unexpected version')
  env.PATH = `${bin}:${env.PATH ?? ''}`
  const dshRoot = join(cliRoot, 'node_modules/@deepseek-ai/dsh')
  const resolvedDshRoot = await realpath(dshRoot)
  // pnpm's non-hoisted CLI dependencies live in the resolved CLI package's
  // virtual dependency directory, which is also the directory its loader
  // resolves from at runtime.
  const require = createRequire(join(dirname(dirname(resolvedDshRoot)), '.dsh-cli-runtime.cjs'))
  const packagePathFor = entry => {
    for (let current = dirname(entry); current !== dirname(current); current = dirname(current)) {
      const candidate = join(current, 'package.json')
      if (existsSync(candidate)) return candidate
    }
    throw new Error(`could not locate package metadata for ${entry}`)
  }
  const basePackagePath = packagePathFor(require.resolve('@deepseek-ai/dsh-base'))
  const baseRequire = createRequire(basePackagePath)
  const jsonlPackagePath = packagePathFor(baseRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
  const jsonlRequire = createRequire(jsonlPackagePath)
  const packagePaths = {
    '@deepseek-ai/dsh': join(dshRoot, 'package.json'),
    '@deepseek-ai/dsh-session-persistence': packagePathFor(jsonlRequire.resolve('@deepseek-ai/dsh-session-persistence')),
    '@deepseek-ai/dsh-session-persistence-jsonl': jsonlPackagePath,
    '@deepseek-ai/cordis': packagePathFor(require.resolve('@deepseek-ai/cordis')),
  }
  const runtime = Object.fromEntries(await Promise.all(Object.entries(packagePaths).map(async ([name, packagePath]) => {
    const { version } = JSON.parse(await readFile(packagePath, 'utf8'))
    return [name, { version, packagePath }]
  })))
  return { cliRoot, runtime }
}

function goalExecutionRuns(goalsPath, goalId) {
  const executionsPath = `${goalsPath}.executions`
  if (!goalId || !existsSync(executionsPath)) return []
  try {
    return query(executionsPath, `SELECT run_id, goal_id, issued_at, dispatched_at, intent_json, execution_json
      FROM goal_execution_runs WHERE goal_id = ? ORDER BY issued_at, run_id`, goalId)
  } catch { return [] }
}

function fixtureHasPullRequest(path) {
  if (typeof path !== 'string' || !existsSync(path)) return false
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .some(line => parseJson(line)?.kind === 'pr')
  } catch { return false }
}

function unknownExecutionWithoutPullRequest(goalsPath, goalId, fixturePath) {
  if (fixtureHasPullRequest(fixturePath)) return undefined
  return goalExecutionRuns(goalsPath, goalId).find(row => {
    const execution = parseJson(row.execution_json)
    return execution?.status === 'unknown' && execution.quiescent === false
  })
}

function effectiveDeliveryContinuationTimeout(home) {
  try {
    const patch = parseDocument(readFileSync(join(home, 'profiles/web/cordis.patch.yml'), 'utf8'))
    const row = patchRow(patch, 'dsh-enhanced-assistant-delivery')
    const configured = row.get('config', true).toJSON()?.agentGoalContinuationTimeoutMs
    // This is the Delivery schema's runtime default when the effective profile
    // does not explicitly set the field.
    return Number.isSafeInteger(configured) ? configured : 0
  } catch { return null }
}

async function runtimeDiagnostics(home, sessionId, observerLog) {
  const goalsPath = join(home, 'assistant-goals/web.sqlite')
  let goal
  if (existsSync(goalsPath) && sessionId) {
    try { goal = query(goalsPath, "SELECT id, created_at, updated_at, native_json FROM goal_records WHERE json_extract(native_json, '$.sessionId') = ? ORDER BY created_at DESC LIMIT 1", sessionId)[0] } catch {}
  }
  const native = parseJson(goal?.native_json)
  const waitsPath = `${goalsPath}.event-waits`
  let waits = []
  if (goal?.id && existsSync(waitsPath)) {
    try {
      waits = query(waitsPath, `SELECT id, goal_id, state, reason, sequence, native_revision, source_cursor, intent_json
        FROM goal_event_waits WHERE goal_id = ? ORDER BY rowid`, goal.id).map(wait => {
        const intent = parseJson(wait.intent_json)
        return { id: wait.id, goalId: wait.goal_id, state: wait.state, reason: wait.reason,
          sequence: wait.sequence, nativeRevision: wait.native_revision, sourceCursor: wait.source_cursor,
          createdAt: intent?.createdAt ?? null, expiresAt: intent?.expiresAt ?? null }
      })
    } catch {}
  }
  let turns = []
  if (sessionId && existsSync(observerLog)) {
    try {
      turns = readFileSync(observerLog, 'utf8').split('\n').filter(Boolean).map(parseJson)
        .filter(entry => entry?.event === 'turn-end' && entry.sessionId === sessionId)
        .map(entry => ({ turn: entry.turn, reason: entry.reason, causeKind: entry.causeKind, cause: entry.cause,
          deliveryContinuationTimeoutMs: entry.deliveryContinuationTimeoutMs }))
    } catch {}
  }
  return {
    sessionTurnEnds: turns,
    goal: goal ? { id: goal.id, createdAt: goal.created_at, updatedAt: goal.updated_at,
      phase: native?.phase ?? null, revision: native?.revision ?? null } : null,
    executionRuns: goalExecutionRuns(goalsPath, goal?.id).map(run => {
      const execution = parseJson(run.execution_json), intent = parseJson(run.intent_json)
      return { round: intent?.admission?.round, runId: run.run_id, goalId: run.goal_id, admissionAt: run.issued_at,
        dispatchedAt: run.dispatched_at, status: execution?.status ?? null,
        quiescent: execution?.quiescent ?? null, completedAt: execution?.completedAt ?? null }
    }),
    acceptance: existsSync(join(home, 'assistant-verifier/verification.sqlite')) ? query(join(home, 'assistant-verifier/verification.sqlite'), 'SELECT payload FROM acceptance_receipts').map(row => { const receipt = JSON.parse(row.payload); return { task: receipt.task, objectiveStatus: receipt.objectiveStatus, completedAt: receipt.completedAt, results: receipt.results } }) : [],
    sourceRuns: existsSync(join(home, 'assistant-automations/state.sqlite')) ? query(join(home, 'assistant-automations/state.sqlite'), "SELECT id,automation_id,status,diagnostic_json FROM automation_runs WHERE automation_id LIKE '%repository-events-source'") : [],
    waits,
    wakes: existsSync(`${goalsPath}.wakes`) && goal?.id
      ? query(`${goalsPath}.wakes`, 'SELECT id,state,dispatched_at,completed_at FROM goal_wakes WHERE goal_id = ?', goal.id) : [],
    deliveryContinuationTimeoutMs: effectiveDeliveryContinuationTimeout(home),
  }
}

async function waitForCompletion(getPage, home, sessionId, approvals, options = {}) {
  const goals = join(home, 'assistant-goals/web.sqlite')
  const delivery = join(home, 'assistant-delivery/state.sqlite')
  const deadline = Date.now() + 300_000
  const currentGoal = () => existsSync(goals)
    ? query(goals, "SELECT * FROM goal_records WHERE json_extract(native_json, '$.sessionId') = ? ORDER BY created_at DESC LIMIT 1", sessionId)[0]
    : undefined
  let waitingHandled = false
  while (Date.now() < deadline) {
    const record = currentGoal()
    if (record && JSON.parse(record.native_json).phase === 'complete') return record
    // This represents the browser owner acknowledging an actual UI request. It
    // intentionally does not inspect, filter, reorder, or manufacture tools.
    const page = getPage()
    const allow = page.getByRole('button', { name: 'Allow once', exact: true })
    if (await allow.count()) { approvals.push({ at: Date.now() }); await allow.click(); continue }
    const input = query(delivery, `SELECT message.status, message.failure_code FROM inbox_messages AS message
      JOIN conversation_bindings AS binding ON binding.id = message.binding_id
      WHERE binding.session_id = ? ORDER BY message.received_at DESC LIMIT 1`, sessionId)[0]
    if (input?.status === 'dead_letter') throw new Error(`owner input was rejected: ${input.failure_code}`)
    // Delivery marks processed only after the native owner turn and teardown
    // settle. Re-read Goal state after that fence to avoid a cross-DB read race.
    if (input?.status === 'processed' && !currentGoal()) throw new Error('owner turn completed without establishing a Goal')
    const native = record && JSON.parse(record.native_json)
    const waiting = options.waitsPath && existsSync(options.waitsPath)
      ? query(options.waitsPath, 'SELECT * FROM goal_event_waits WHERE session_id = ? ORDER BY rowid DESC LIMIT 1', sessionId)[0]
      : undefined
    if (!waitingHandled && record && waiting?.state === 'waiting' && native?.phase === 'paused') {
      const ready = options.readyForRestart === undefined || await options.readyForRestart({ goal: record, native, wait: waiting })
      if (ready) {
        waitingHandled = true
        await options.onWaiting?.({ goal: record, native, wait: waiting })
        continue
      }
    }
    if (record && ['paused', 'blocked'].includes(native.phase)
      && query(delivery, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state === 'released') {
      if (!options.waitsPath) throw new Error('native Goal paused or blocked with no active owner execution; inspect independent acceptance and budget evidence')
      const unknownRun = unknownExecutionWithoutPullRequest(goals, record.id, options.repositoryFixtureLog)
      if (unknownRun) throw new Error(`Goal execution ${unknownRun.run_id} is unknown before repository delivery created a pull request; inspect runtime-diagnostics.json`)
      const waitExpiresAt = waiting && JSON.parse(waiting.intent_json).expiresAt
      if (['waiting', 'matched', 'materialized'].includes(waiting?.state) && Number.isSafeInteger(waitExpiresAt) && Date.now() < waitExpiresAt) {
        await page.waitForTimeout(250)
        continue
      }
      if (waiting?.state === 'terminal' && ['expired', 'source-changed', 'denied', 'invalid-current'].includes(waiting.reason)) throw new Error(`durable event wait terminated: ${waiting.reason}`)
      if (waiting?.state === 'terminal' && waiting.reason === 'settled') {
        const wakeId = parseJson(waiting.wake_json)?.id
        const wake = wakeId && existsSync(`${goals}.wakes`) ? query(`${goals}.wakes`, 'SELECT state FROM goal_wakes WHERE id = ?', wakeId)[0] : undefined
        if (wake && ['unknown', 'denied'].includes(wake.state)) throw new Error(`event wake ended ${wake.state}; inspect runtime-diagnostics.json and observer turn-end`)
        await page.waitForTimeout(250); continue
      }
      throw new Error('native Goal paused or blocked without a current durable event wait; inspect independent acceptance and budget evidence')
    }
    await page.waitForTimeout(250)
  }
  throw new Error(`real repository task did not independently complete for Session ${sessionId}`)
}

test(setupOnly ? 'formal autonomy install discovers an idle owner session without model requests' : 'formal autonomy install independently verifies an ordinary isolated repository task', async ({ page, context }, testInfo) => {
  // Reject invalid external authorization before install, model work, patch
  // writes, or any possible remote operation.
  const liveRepository = liveRepositoryEnabled ? await loadLiveRepositoryInput(liveInputPath) : undefined
  const temp = await mkdtemp(join(tmpdir(), 'dsh-repo-autonomy-real-'))
  const home = join(temp, 'home'), workspace = join(temp, 'workspace'), taskPath = join(temp, 'private-goal.json'), observerLog = join(temp, 'observer.jsonl')
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer(); server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolvePort(address.port)) })
  })
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_ENHANCED_WEB_PORT: String(port), DSH_REPO_AUTONOMY_OBSERVER_LOG: observerLog,
    DSH_REPO_AUTONOMY_NO_MODEL: setupOnly ? '1' : '0',
    DSH_REPO_AUTONOMY_MAX_CALLS: repositoryEvents ? '26' : '14', DSH_REPO_AUTONOMY_DURATION_MS: '300000' }
  let host; let restarted; let externalBroker; let activePage = page; let failed = false; let sessionId
  const http = [], transport = [], streams = new Map(), frames = [], approvals = []
  observePage(page, http, transport, streams, frames)
  try {
    await mkdir(workspace)
    // Keep this disposable profile independent of a developer's published
    // Skills/Proactive defaults before the formal installer reads them.
    await mkdir(join(home, 'profiles', 'web'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), `- id: dsh-enhanced-assistant-skills
  name: '@dsh-enhanced/assistant-skills'
  config:
    databasePath: ${join(home, 'assistant-skills/skills.sqlite')}
- id: dsh-enhanced-assistant-proactive
  name: '@dsh-enhanced/assistant-proactive'
  config:
    databasePath: ${join(home, 'assistant-proactive/proactive.sqlite')}
`, { mode: 0o600 })
    const pinnedCli = await preparePinnedDshCli(temp, env)
    await writeFile(testInfo.outputPath('pinned-cli-runtime.json'), JSON.stringify(pinnedCli.runtime, null, 2), { mode: 0o600 })
    const route = await prepareRealRoute({ env, home, workspace })
    env.DSH_WEB_REAL_PROVIDER = route.provider; env.DSH_WEB_REAL_MODEL = route.model
    const addOns = route.bundles.flatMap(bundle => {
      if (bundle === 'coding-subscription-provider') return ['--with', 'coding']
      if (bundle === 'traex-acp-provider') return ['--with', 'traex']
      throw new Error(`unsupported real-route bundle ${bundle}`)
    })
    const install = await run('bash', [resolve(root, 'scripts/install/install-local.sh'), '--scenario', 'autonomy', '--workspace', workspace,
      '--isolation-image', image, '--isolation-max-runs', '12', '--isolation-lease-minutes', '10', '--isolation-runtime-minutes', '5', '--model', 'skip', '--model-route', 'skip',
      ...addOns, '--no-service', '--yes'], env, 180_000)
    await writeFile(testInfo.outputPath('install.log'), sanitize(install), { mode: 0o600 })
    await writeFile(testInfo.outputPath('verifier-controls.json'), JSON.stringify(await checkVerificationCommand(home, temp), null, 2), { mode: 0o600 })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml')
    let patchSource = await readFile(patchPath, 'utf8')
    const configuredRoute = { provider: route.provider, model: route.model }
    const patch = parseDocument(patchSource)
    route.configurePatch(patch, (document, id, name, config) => {
      let row = document.contents.items.find(item => isMap(item) && item.get('id') === id)
      if (!row) { row = document.createNode({ id, name }); document.contents.add(row) }
      row.set('config', document.createNode(config))
    })
    patchSource = String(patch)
    if (route.provider === 'codex-subscription') configuredRoute.model = 'default'
    if (liveRepository) patchSource = installLiveCredentialReference(patchSource, liveRepository)
    await writeFile(patchPath, addObserver(patchSource), { mode: 0o600 })

    // The native Web UI, not the test, creates the first durable Session.
    host = await startHost(env)
    await page.goto(host.url); await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => http.find(response => new URL(response.url()).pathname === '/api/session/create')).toBeTruthy()
    const create = http.find(response => new URL(response.url()).pathname === '/api/session/create')
    sessionId = (await create.json()).result.value.sessionId
    await host.stop(); await writeFile(testInfo.outputPath('host-initial.log'), host.log(), { mode: 0o600 })

    let repository
    if (externalBrokerFixture) {
      const external = await prepareExternalRepositoryFixture(home, patchPath, env, { sessionId, workspace, objective, source: buggySource })
      externalBroker = external.close
      const { close: _close, ...delivery } = external
      repository = delivery
    } else repository = verifiedDelivery ? await prepareRepositoryFixture(home, patchPath, env) : liveRepository?.repositoryDelivery
    const admission = { version: 2, objective, route: configuredRoute, maxGoalRounds: repositoryEvents ? 6 : 3, stepMaxDurationMs: 120_000,
      executionBudget: { mode: 'calls', modelCalls: repositoryEvents ? 24 : 12, toolCalls: repositoryEvents ? 40 : 16, durationMs: 300_000, maxOutputTokensPerCall: 1024, routes: [configuredRoute] },
      verification: { artifactPath: 'summarize.mjs', command: verificationCommand, maxRuns: 12, maxTotalDurationMs: 240_000, maxDurationMs: 5_000, maxOutputBytes: 4096, cases },
      ...(repository ? { repositoryDelivery: repository } : {}) }
    await writeFile(taskPath, JSON.stringify(admission), { mode: 0o600 })
    // Deliberately omit --session-id: this exercises the shipped real binding discovery.
    const setup = await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace, '--goal-admission', taskPath], env)
    await writeFile(testInfo.outputPath('goal-setup.log'), sanitize(setup), { mode: 0o600 })
    expect(setup).toContain(`Session: ${sessionId}`)
    if (setupOnly) {
      const events = existsSync(observerLog) ? (await readFile(observerLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
      expect(events.some(event => event.event === 'startup-session-index'), 'setup probe requires its installed observer').toBe(true)
      expect(events.filter(event => ['dispatch', 'model-blocked'].includes(event.event))).toEqual([])
      await writeFile(testInfo.outputPath('setup-proof.json'), JSON.stringify({ scope: 'installation-and-idle-session-discovery-only', sessionId, modelCalls: 0, taskExecuted: false }), { mode: 0o600 })
      return
    }
    if (verifiedDelivery) expect(setup).toContain('Repository: fixture/orders; branch: automation/fix')
    if (liveRepository) expect(setup).toContain(`Repository: ${repository.repository}; branch: ${repository.branch}`)
    if (verifiedDelivery && repositoryEvents) {
      // Admission writes the production config.  Only the HTTPS/DNS edge is
      // replaced here; EventTriggers, Keychain, Policy, observer and durable
      // source store remain the installed components.
      const patch = parseDocument(await readFile(patchPath, 'utf8'))
      const source = patchRow(patch, 'dsh-enhanced-event-triggers')
      source.set('disabled', true)
      const replacement = patch.createNode({ id: 'repo-event-transport-fixture', name: resolve(root, 'scripts/e2e/repo-event-transport-fixture.mjs') })
      replacement.set('config', source.get('config', true).clone())
      // DSH patch layers do not replace an existing row's module via `name`.
      patch.contents.add(patch.createNode({ insert: [replacement] }))
      await writeFile(patchPath, String(patch), { mode: 0o600 })
    }

    host = await startHost(env)
    if (repositoryEvents) {
      // This is the live credential and repository/branch preflight. The
      // installed observer obtains the handle through its configured consumer
      // and purpose, then reads the exact repository source before any model
      // request or mutation is allowed.
      await expect.poll(() => {
        const state = query(join(home, 'event-triggers/state.sqlite'), "SELECT trigger_id,last_observed_at FROM trigger_state WHERE trigger_id LIKE '%repository-events'")
        const health = query(join(home, 'event-triggers/state.sqlite'), "SELECT trigger_id,consecutive_failures,last_error,last_success_at FROM trigger_health WHERE trigger_id LIKE '%repository-events'")
        return { sources: state.length, observed: state[0]?.last_observed_at, health }
      }, { message: 'installed GitHub source must complete an authenticated, error-free repository/branch baseline observation', timeout: 30_000 }).toMatchObject({
        sources: 1, observed: expect.any(Number), health: [{ consecutive_failures: 0, last_error: null, last_success_at: expect.any(Number) }],
      })
    }
    await activePage.goto(host.url)
    const workspaceRow = activePage.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(workspaceRow).toBeVisible()
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await activePage.getByRole('treeitem').filter({ hasText: 'New conversation' }).first().click().catch(() => {})
    // The owner supplies the failing source as ordinary request content. An
    // isolation job receives only its own inline files, never this Host path.
    const deliveryInstruction = liveRepository
      ? ` Deliver the independently accepted repair to the authorized repository ${repository.repository}, branch ${repository.branch}, changing only ${repository.paths.join(', ')} and opening its authorized pull request. Inspect the current authorized branch before delivery.`
      : verifiedDelivery ? ' Arrange delivery of the independently accepted repair to the authorized repository branch and open a pull request. Use the available repository authorization and inspect the current branch before preparing delivery.' : ''
    const prompt = `Here is the failing starting program:\n\n${buggySource}\n\n${objective} Please work on this as a finite goal. You may investigate and test as needed. The acceptance conditions are the objective above; independent verification is configured separately.${deliveryInstruction}${repositoryEvents ? ' The authorized repository delivery can remain pending while external CI and review finish. Continue the original goal when its configured event source reports a change, and independently inspect the current repository state before deciding whether the result is complete.' : ''}`
    await activePage.getByLabel(/Describe what you want to build|Message or run a task/).fill(prompt)
    const sent = activePage.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await activePage.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await sent).status()).toBe(200)
    const readJsonLines = async path => {
      if (typeof path !== 'string' || !existsSync(path)) return []
      try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
    }
    const fixtureRecords = () => readJsonLines(env.DSH_REPO_DELIVERY_FIXTURE_LOG)
    const sourceObservations = () => readJsonLines(env.DSH_REPO_EVENT_SOURCE_LOG)
    const readyForRestart = async ({ goal: currentGoal, native: currentNative, wait }) => {
      if (wait.goal_id !== currentGoal.id || currentNative.phase !== 'paused') return false
      const intent = JSON.parse(wait.intent_json)
      if (intent.wake?.goalId !== currentGoal.id || intent.source?.kind !== 'github-repository') return false
      // A saved wait can precede the source round's async flush/verification.
      // Restart only after its exact execution and owner lane have settled.
      const runs = query(`${join(home, 'assistant-goals/web.sqlite')}.executions`, 'SELECT intent_json,execution_json FROM goal_execution_runs WHERE goal_id = ?', currentGoal.id)
      if (!runs.some(run => {
        const admitted = JSON.parse(run.intent_json), execution = parseJson(run.execution_json)
        return admitted.task.goal.nativeRevision + 1 === currentNative.revision
          && admitted.admission.round === currentNative.roundsStarted
          && admitted.task.goal.sessionId === sessionId && execution?.status === 'succeeded' && execution.quiescent === true
      })) return false
      if (query(join(home, 'assistant-delivery/state.sqlite'), 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state !== 'released') return false
      if (query(`${join(home, 'assistant-goals/web.sqlite')}.wakes`, 'SELECT state FROM goal_wakes WHERE goal_id = ?', currentGoal.id).some(wake => wake.state !== 'succeeded')) return false
      if (liveRepository) {
        return query(join(home, 'event-triggers/state.sqlite'), "SELECT trigger_id FROM trigger_state WHERE trigger_id LIKE '%repository-events'").length === 1
      }
      const records = await fixtureRecords(), commit = records.find(item => item.kind === 'commit'), pullRequest = records.find(item => item.kind === 'pr')
      if (!commit || !pullRequest || pullRequest.headOid !== commit.commitOid || intent.wake?.native?.revision !== currentNative.revision) return false
      const eventDb = join(home, 'event-triggers/state.sqlite')
      const state = query(eventDb, "SELECT last_observed_at FROM trigger_state WHERE trigger_id LIKE '%repository-events' LIMIT 1")[0]
      const latest = query(eventDb, "SELECT MAX(sequence) AS sequence FROM event_outbox WHERE trigger_id LIKE '%repository-events'")[0]?.sequence ?? 0
      // Await the completed pending observation, not just its in-flight HTTP
      // response. An unread PR-created edge must wake before this restart.
      if (!(state?.last_observed_at > pullRequest.at) || latest > intent.source.highWaterSequence) return false
      const observations = await sourceObservations()
      return ['check-runs', 'pulls'].every(suffix => observations.some(item => item.at >= pullRequest.at && item.ready === false
        && item.headOid === commit.commitOid && item.pullRequest === 17 && item.path.endsWith(`/${suffix}`)))
    }
    let waitRestart
    const goal = await waitForCompletion(() => activePage, home, sessionId, approvals, repositoryEvents ? {
      waitsPath: `${join(home, 'assistant-goals/web.sqlite')}.event-waits`,
      repositoryFixtureLog: env.DSH_REPO_DELIVERY_FIXTURE_LOG,
      readyForRestart,
      onWaiting: async ({ goal: waitingGoal, native: waitingNative, wait }) => {
        if (liveRepository) {
          expect(JSON.parse(wait.intent_json).source.kind).toBe('github-repository')
          expect(waitingNative).toMatchObject({ phase: 'paused', sessionId })
          const sessionTitle = await activePage.getByRole('navigation', { name: 'Session hierarchy' }).getByRole('button').first().innerText()
          const restartedAt = Date.now()
          await host.stop(); await writeFile(testInfo.outputPath('host-waiting.log'), host.log(), { mode: 0o600 })
          host = await startHost(env); restarted = await context.browser().newContext(); activePage = await restarted.newPage()
          observePage(activePage, http, transport, streams, frames); await activePage.goto(host.url)
          await selectRestoredSession(activePage, sessionTitle)
          const restoredWait = query(`${join(home, 'assistant-goals/web.sqlite')}.event-waits`, 'SELECT * FROM goal_event_waits WHERE id = ?', wait.id)[0]
          expect(restoredWait.state).toBe('waiting')
          waitRestart = { waitId: wait.id, goalId: waitingGoal.id, sessionTitle, sourceStateBefore: wait.state, sourceStateAfterRestart: restoredWait.state,
            restartedAt, sourceSnapshot: JSON.parse(wait.intent_json).source }
          return
        }
        const records = await fixtureRecords()
        expect(records.map(item => item.kind)).toEqual(['commit', 'pr'])
        expect(await readyForRestart({ goal: waitingGoal, native: waitingNative, wait })).toBe(true)
        expect(JSON.parse(wait.intent_json).source.kind).toBe('github-repository')
        expect(waitingNative).toMatchObject({ phase: 'paused', sessionId })
        const priorWakes = query(`${join(home, 'assistant-goals/web.sqlite')}.wakes`, 'SELECT id,state FROM goal_wakes WHERE goal_id = ?', waitingGoal.id)
        expect(priorWakes.every(wake => wake.state === 'succeeded')).toBe(true)
        expect(JSON.parse(await readFile(env.DSH_REPO_EVENT_STATE, 'utf8'))).toEqual({ ready: false })
        const sessionTitle = await activePage.getByRole('navigation', { name: 'Session hierarchy' }).getByRole('button').first().innerText()
        await host.stop(); await writeFile(testInfo.outputPath('host-waiting.log'), host.log(), { mode: 0o600 })
        host = await startHost(env); restarted = await context.browser().newContext(); activePage = await restarted.newPage()
        observePage(activePage, http, transport, streams, frames); await activePage.goto(host.url)
        await selectRestoredSession(activePage, sessionTitle)
        const restoredWait = query(`${join(home, 'assistant-goals/web.sqlite')}.event-waits`, 'SELECT * FROM goal_event_waits WHERE id = ?', wait.id)[0]
        const restoredGoal = query(join(home, 'assistant-goals/web.sqlite'), 'SELECT * FROM goal_records WHERE id = ?', waitingGoal.id)[0]
        expect(restoredWait.state).toBe('waiting')
        expect(JSON.parse(restoredGoal.native_json)).toMatchObject({ phase: 'paused', sessionId })
        const observedAfterRestart = Date.now()
        await expect.poll(() => query(join(home, 'event-triggers/state.sqlite'), "SELECT last_observed_at FROM trigger_state WHERE trigger_id LIKE '%repository-events' LIMIT 1")[0]?.last_observed_at).toBeGreaterThan(observedAfterRestart)
        // Timestamp the state transition before the write so an immediately
        // observed edge cannot predate the test's causal boundary.
        const readyAt = Date.now()
        await writeFile(env.DSH_REPO_EVENT_STATE, '{"ready":true}', { mode: 0o600 })
        waitRestart = { waitId: wait.id, goalId: waitingGoal.id, sessionTitle, sourceStateBefore: wait.state, sourceStateAfterRestart: restoredWait.state, priorWakes, readyAt }
      },
    } : undefined)
    const native = JSON.parse(goal.native_json), scope = JSON.parse(goal.scope_json)
    expect(goal.original_objective).toBe(objective)
    expect(native.sessionId).toBe(sessionId)

    const verifier = join(home, 'assistant-verifier/verification.sqlite')
    const receipts = query(verifier, 'SELECT payload FROM acceptance_receipts').map(row => JSON.parse(row.payload))
    const achievedSteps = receipts.filter(receipt => receipt.task?.kind === 'goal-step' && receipt.objectiveStatus === 'achieved')
    const achievedOutcomes = receipts.filter(receipt => receipt.task?.kind === 'goal-outcome' && receipt.objectiveStatus === 'achieved')
    expect(achievedSteps.length).toBeGreaterThan(0)
    expect(achievedOutcomes.length).toBeGreaterThan(0)
    const ledger = join(home, 'assistant-isolation/web/ledger.sqlite')
    const sourceJobs = query(ledger, "SELECT id, status, artifact_binding_json FROM isolation_jobs WHERE status = 'succeeded' AND artifact_binding_json IS NOT NULL ORDER BY id")
    expect(sourceJobs.some(job => JSON.parse(job.artifact_binding_json).paths.includes('summarize.mjs'))).toBe(true)
    expect(existsSync(join(workspace, 'summarize.mjs'))).toBe(false)
    const calls = (await readFile(observerLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(calls.filter(item => item.event === 'dispatch').length).toBeLessThanOrEqual(repositoryEvents ? 26 : 14)
    expect(calls.some(item => item.event === 'settled')).toBe(true)
    let repositoryDelivery
    if (verifiedDelivery) {
      const path = join(home, 'assistant-actions/web/verified-delivery.sqlite')
      expect(query(path, 'SELECT state FROM deliveries').length, 'completed artifact goal did not register a repository delivery intent').toBeGreaterThan(0)
      await expect.poll(() => query(path, 'SELECT state FROM deliveries')[0]?.state, { timeout: 65000 }).toBe('succeeded')
      const records = (await readFile(env.DSH_REPO_DELIVERY_FIXTURE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(records.map(item => item.kind)).toEqual(['commit', 'pr'])
      if (externalBrokerFixture) {
        const brokerRequests = query(join(home, 'external-repository-broker/state.sqlite'), 'SELECT operation,status FROM requests ORDER BY rowid')
        expect(brokerRequests.filter(row => row.operation === 'commit' || row.operation === 'pull-request')).toEqual([{ operation: 'commit', status: 'succeeded' }, { operation: 'pull-request', status: 'succeeded' }])
        const reads = brokerRequests.filter(row => row.operation === 'inspect')
        expect(reads.length).toBeLessThanOrEqual(6)
        expect(reads.every(row => row.status === 'succeeded')).toBe(true)
      }
      const commit = records[0], pr = records[1]
      const digest = createHash('sha256').update(commit.files[0].content).digest('hex')
      const deliveryIntent = JSON.parse(query(path, 'SELECT intent FROM deliveries')[0].intent)
      const deliveredSteps = achievedSteps.filter(receipt => receipt.task?.goal?.runId === deliveryIntent.security.runId)
      expect(commit.files[0].path).toBe('summarize.mjs')
      if (!repositoryEvents) expect(receipts.every(receipt => receipt.results.some(result => result.artifactDigest === digest))).toBe(true)
      else {
        expect(deliveredSteps.length).toBeGreaterThan(0)
        expect(deliveredSteps.every(receipt => receipt.results.some(result => result.artifactDigest === digest))).toBe(true)
      }
      expect(commit.at).toBeGreaterThanOrEqual(Math.max(...(repositoryEvents ? deliveredSteps : receipts).map(receipt => receipt.completedAt)))
      expect(pr.headOid).toBe(commit.commitOid)
      const notices = () => query(join(home, 'assistant-delivery/state.sqlite'), "SELECT id,status,intent_json FROM outbox_messages WHERE json_extract(intent_json, '$.metadata.\"dsh.native-notice.sourceId\"') = 'assistant-actions-verified-delivery/v1'")
      await expect.poll(() => notices().map(row => row.status)).toEqual(['accepted'])
      const noticeText = JSON.parse(notices()[0].intent_json).text
      expect(noticeText).toContain(commit.commitOid)
      expect(noticeText).toContain(String(pr.number))
      await expect(activePage.getByLabel('主动提醒', { exact: true })).toContainText(noticeText)
      repositoryDelivery = { transport: 'explicit-fixture-not-live-github', records, state: query(path, 'SELECT id,state,result FROM deliveries'), notices: notices(), noticeText }
      if (repositoryEvents) {
        expect(waitRestart).toMatchObject({ goalId: goal.id, sourceStateBefore: 'waiting', sourceStateAfterRestart: 'waiting' })
        expect(JSON.parse(await readFile(env.DSH_REPO_EVENT_STATE, 'utf8'))).toEqual({ ready: true })
        const eventsPath = join(home, 'event-triggers/state.sqlite')
        const sourceSnapshot = JSON.parse(query(`${join(home, 'assistant-goals/web.sqlite')}.event-waits`, 'SELECT intent_json FROM goal_event_waits WHERE id = ?', waitRestart.waitId)[0].intent_json).source
        const sourceEvents = () => query(eventsPath, "SELECT sequence,event_id,occurred_at,status FROM event_outbox WHERE trigger_id LIKE '%repository-events' ORDER BY sequence")
        await expect.poll(() => sourceEvents().filter(row => row.sequence > sourceSnapshot.highWaterSequence && row.occurred_at >= waitRestart.readyAt && row.status === 'delivered').length, { timeout: 30_000 }).toBeGreaterThan(0)
        await expect.poll(() => query(`${join(home, 'assistant-goals/web.sqlite')}.event-waits`, 'SELECT state,reason FROM goal_event_waits WHERE id = ?', waitRestart.waitId)[0]?.state, { timeout: 30_000 }).toBe('terminal')
        expect(query(`${join(home, 'assistant-goals/web.sqlite')}.event-waits`, 'SELECT state,reason FROM goal_event_waits WHERE id = ?', waitRestart.waitId)[0]).toEqual({ state: 'terminal', reason: 'settled' })
        expect(query(`${join(home, 'assistant-goals/web.sqlite')}.wakes`, 'SELECT state FROM goal_wakes WHERE id = ?', `goal-event-wake-${waitRestart.waitId}`)[0]?.state).toBe('succeeded')
        const resumedEvent = sourceEvents().find(row => row.sequence > sourceSnapshot.highWaterSequence && row.occurred_at >= waitRestart.readyAt && row.status === 'delivered')
        if (!resumedEvent) throw new Error('no delivered repository event matched the durable wait snapshot')
        const sourceRuns = () => query(join(home, 'assistant-automations/state.sqlite'), `SELECT run.status FROM automation_runs AS run
          JOIN automation_occurrences AS occurrence ON occurrence.id = run.occurrence_id
          WHERE run.automation_id LIKE '%repository-events-source'
            AND json_extract(occurrence.external_event_json, '$.event.id') = ?
          ORDER BY run.created_at`, resumedEvent.event_id)
        await expect.poll(() => sourceRuns(), { timeout: 30_000 }).toMatchObject([{ status: 'succeeded' }])
        const readbacksPath = `${env.DSH_REPO_DELIVERY_FIXTURE_LOG}.readbacks`
        const readbacks = (await readFile(readbacksPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        const repositoryOutcome = achievedOutcomes.find(receipt => receipt.completedAt >= waitRestart.readyAt
          && receipt.results.some(result => result.status === 'passed' && result.evidence?.some(evidence => evidence.kind === 'repository-readback' && evidence.ref === 'fixture/orders:automation/fix')))
        if (!repositoryOutcome) throw new Error('no achieved fresh repository-readback outcome receipt after the event source resumed the Goal')
        expect(readbacks.some(row => row.ready === true && row.headOid === commit.commitOid && row.at >= waitRestart.readyAt && row.at <= repositoryOutcome.completedAt)).toBe(true)
        const claim = () => query(eventsPath, "SELECT trigger_id,goal_id,session_id,native_goal_id,retired_at FROM goal_source_claims WHERE trigger_id LIKE '%repository-events'")[0]
        await expect.poll(() => claim()?.retired_at, { timeout: 15000 }).toBeGreaterThan(0)
        expect(claim()).toMatchObject({ goal_id: goal.id, session_id: sessionId, native_goal_id: native.goalId })
        await expect.poll(() => query(join(home, 'assistant-automations/state.sqlite'), "SELECT status FROM automation_definitions WHERE id LIKE '%repository-events-source'")).toEqual([{ status: 'paused' }])
        const lastObservedAt = query(eventsPath, "SELECT last_observed_at FROM trigger_state WHERE trigger_id LIKE '%repository-events' LIMIT 1")[0]?.last_observed_at
        expect(lastObservedAt).toBeGreaterThan(0)
        repositoryDelivery.eventSource = { waitRestart, snapshotHighWaterSequence: sourceSnapshot.highWaterSequence, resumedEvent, events: sourceEvents(), wakes: query(`${join(home, 'assistant-goals/web.sqlite')}.wakes`, 'SELECT id,state FROM goal_wakes'), sourceRuns: sourceRuns(), readbacks, repositoryOutcome, retirement: { claim: claim(), lastObservedAt, automationStatus: 'paused' } }
      }
    }
    if (liveRepository) {
      const path = join(home, 'assistant-actions/web/verified-delivery.sqlite')
      expect(query(path, 'SELECT state FROM deliveries').length, 'completed artifact goal did not register a live repository delivery intent').toBeGreaterThan(0)
      await expect.poll(() => query(path, 'SELECT state FROM deliveries')[0]?.state, { timeout: 65_000 }).toBe('succeeded')
      const delivery = query(path, 'SELECT intent,result FROM deliveries')[0]
      const deliveryIntent = parseJson(delivery?.intent), result = parseJson(delivery?.result)
      expect(result?.commit?.commitOid).toMatch(/^[a-f0-9]{40}$/)
      expect(result?.pullRequest?.pullRequestNumber).toEqual(expect.any(Number))
      expect(waitRestart).toMatchObject({ goalId: goal.id, sourceStateBefore: 'waiting', sourceStateAfterRestart: 'waiting' })
      expect(deliveryIntent?.security).toMatchObject({ goalId: goal.id, sessionId, nativeGoalId: native.goalId })
      expect(deliveryIntent?.security?.definitionDigest).toMatch(/^[a-f0-9]{64}$/)
      const eventsPath = join(home, 'event-triggers/state.sqlite')
      const sourceEvents = () => query(eventsPath, "SELECT sequence,event_id,occurred_at,status FROM event_outbox WHERE trigger_id LIKE '%repository-events' ORDER BY sequence")
      await expect.poll(() => sourceEvents().filter(row => row.sequence > waitRestart.sourceSnapshot.highWaterSequence
        && row.occurred_at >= waitRestart.restartedAt && row.status === 'delivered').length, { timeout: 300_000 }).toBeGreaterThan(0)
      await expect.poll(() => query(`${join(home, 'assistant-goals/web.sqlite')}.event-waits`, 'SELECT state,reason FROM goal_event_waits WHERE id = ?', waitRestart.waitId)[0]?.state, { timeout: 30_000 }).toBe('terminal')
      expect(query(`${join(home, 'assistant-goals/web.sqlite')}.event-waits`, 'SELECT state,reason FROM goal_event_waits WHERE id = ?', waitRestart.waitId)[0]).toEqual({ state: 'terminal', reason: 'settled' })
      expect(query(`${join(home, 'assistant-goals/web.sqlite')}.wakes`, 'SELECT state FROM goal_wakes WHERE id = ?', `goal-event-wake-${waitRestart.waitId}`)[0]?.state).toBe('succeeded')
      const resumedEvent = sourceEvents().find(row => row.sequence > waitRestart.sourceSnapshot.highWaterSequence
        && row.occurred_at >= waitRestart.restartedAt && row.status === 'delivered')
      if (!resumedEvent) throw new Error('no live GitHub event matched the durable wait snapshot')
      const sourceRuns = () => query(join(home, 'assistant-automations/state.sqlite'), `SELECT run.status FROM automation_runs AS run
        JOIN automation_occurrences AS occurrence ON occurrence.id = run.occurrence_id
        WHERE run.automation_id LIKE '%repository-events-source'
          AND json_extract(occurrence.external_event_json, '$.event.id') = ?
        ORDER BY run.created_at`, resumedEvent.event_id)
      await expect.poll(() => sourceRuns(), { timeout: 30_000 }).toMatchObject([{ status: 'succeeded' }])
      const receipt = achievedOutcomes.find(item => item.completedAt >= resumedEvent.occurred_at
        && item.results.some(result => result.status === 'passed' && result.evidence?.some(evidence => evidence.kind === 'repository-readback'
          && evidence.ref === `${repository.repository}:${repository.branch}`)))
      if (!receipt) throw new Error('no achieved repository-readback outcome receipt followed the live GitHub event')
      const retirement = query(eventsPath, "SELECT trigger_id,goal_id,session_id,native_goal_id,retired_at FROM goal_source_claims WHERE trigger_id LIKE '%repository-events'")[0]
      expect(retirement).toMatchObject({ goal_id: goal.id, session_id: sessionId, retired_at: expect.any(Number) })
      await expect.poll(() => query(join(home, 'assistant-automations/state.sqlite'), "SELECT status FROM automation_definitions WHERE id LIKE '%repository-events-source'")).toEqual([{ status: 'paused' }])
      const lastObservedAt = query(eventsPath, "SELECT last_observed_at FROM trigger_state WHERE trigger_id LIKE '%repository-events' LIMIT 1")[0]?.last_observed_at
      expect(lastObservedAt).toBeGreaterThan(0)
      repositoryDelivery = { transport: 'live-github', state: query(path, 'SELECT id,state,result FROM deliveries'), eventSource: {
        waitRestart, resumedEvent, events: sourceEvents(), wakes: query(`${join(home, 'assistant-goals/web.sqlite')}.wakes`, 'SELECT id,state FROM goal_wakes'), sourceRuns: sourceRuns(),
        repositoryOutcome: receipt, retirement: { claim: retirement, lastObservedAt, automationStatus: 'paused' },
      } }
    }
    await expect.poll(() => query(join(home, 'assistant-delivery/state.sqlite'), 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    const response = frames.flatMap(frame => frame.value?.type === 'event' && frame.value.event?.type === 'assistant/message'
      ? [frame.value.event.data] : []).findLast(data => data.turn > 1 && data.message.content.some(block => block.type === 'text' && block.text.trim()))
    const responseText = response?.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(responseText?.trim().length).toBeGreaterThan(0)
    const visibleReply = responseText.split(/\n\s*\n/u)[0].replace(/^#{1,6}\s+/u, '').replace(/[`*_]/gu, '').replace(/\s+/gu, ' ').trim()
    expect(prompt.replace(/\s+/gu, ' ')).not.toContain(visibleReply)
    await expect(activePage.getByText(visibleReply, { exact: true })).toBeVisible()
    const sessionTitle = await activePage.getByRole('navigation', { name: 'Session hierarchy' }).getByRole('button').first().innerText()
    expect(sessionTitle.trim().length).toBeGreaterThan(0)

    await host.stop(); await writeFile(testInfo.outputPath('host-first.log'), host.log(), { mode: 0o600 })
    const sourceDigest = createHash('sha256').update(JSON.stringify(sourceJobs)).digest('hex')
    if (restarted) { await restarted.close(); restarted = undefined }
    host = await startHost(env); restarted = await context.browser().newContext(); activePage = await restarted.newPage()
    observePage(activePage, http, transport, streams, frames); await activePage.goto(host.url)
    await selectRestoredSession(activePage, sessionTitle)
    await expect(activePage.getByText(visibleReply, { exact: true })).toBeVisible()
    const restored = query(join(home, 'assistant-goals/web.sqlite'), 'SELECT * FROM goal_records WHERE id = ?', goal.id)[0]
    expect({ native: JSON.parse(restored.native_json), scope: JSON.parse(restored.scope_json) }).toEqual({ native, scope })
    expect(createHash('sha256').update(JSON.stringify(query(ledger, "SELECT id, status, artifact_binding_json FROM isolation_jobs WHERE status = 'succeeded' AND artifact_binding_json IS NOT NULL ORDER BY id"))).digest('hex')).toBe(sourceDigest)
    if (verifiedDelivery) {
      expect(query(join(home, 'assistant-actions/web/verified-delivery.sqlite'), 'SELECT id,state,result FROM deliveries')).toEqual(repositoryDelivery.state)
      expect((await readFile(env.DSH_REPO_DELIVERY_FIXTURE_LOG, 'utf8')).trim().split('\n')).toHaveLength(2)
      await expect(activePage.getByLabel('主动提醒', { exact: true })).toContainText(repositoryDelivery.noticeText)
      expect(query(join(home, 'assistant-delivery/state.sqlite'), "SELECT id,status,intent_json FROM outbox_messages WHERE json_extract(intent_json, '$.metadata.\"dsh.native-notice.sourceId\"') = 'assistant-actions-verified-delivery/v1'")).toEqual(repositoryDelivery.notices)
      if (repositoryEvents) {
        expect(query(join(home, 'event-triggers/state.sqlite'), "SELECT trigger_id,goal_id,session_id,native_goal_id,retired_at FROM goal_source_claims WHERE trigger_id LIKE '%repository-events'")[0]).toEqual(repositoryDelivery.eventSource.retirement.claim)
        await expect.poll(() => query(join(home, 'assistant-automations/state.sqlite'), "SELECT status FROM automation_definitions WHERE id LIKE '%repository-events-source'")).toEqual([{ status: 'paused' }])
        expect(query(join(home, 'event-triggers/state.sqlite'), "SELECT last_observed_at FROM trigger_state WHERE trigger_id LIKE '%repository-events' LIMIT 1")[0]?.last_observed_at).toBe(repositoryDelivery.eventSource.retirement.lastObservedAt)
        expect(query(join(home, 'event-triggers/state.sqlite'), "SELECT sequence,event_id,occurred_at,status FROM event_outbox WHERE trigger_id LIKE '%repository-events' ORDER BY sequence")).toEqual(repositoryDelivery.eventSource.events)
      }
    }
    if (liveRepository) {
      expect(query(join(home, 'assistant-actions/web/verified-delivery.sqlite'), 'SELECT id,state,result FROM deliveries')).toEqual(repositoryDelivery.state)
      expect(query(join(home, 'event-triggers/state.sqlite'), "SELECT trigger_id,goal_id,session_id,native_goal_id,retired_at FROM goal_source_claims WHERE trigger_id LIKE '%repository-events'")[0]).toEqual(repositoryDelivery.eventSource.retirement.claim)
      await expect.poll(() => query(join(home, 'assistant-automations/state.sqlite'), "SELECT status FROM automation_definitions WHERE id LIKE '%repository-events-source'")).toEqual([{ status: 'paused' }])
      expect(query(join(home, 'event-triggers/state.sqlite'), "SELECT last_observed_at FROM trigger_state WHERE trigger_id LIKE '%repository-events' LIMIT 1")[0]?.last_observed_at).toBe(repositoryDelivery.eventSource.retirement.lastObservedAt)
      expect(query(join(home, 'event-triggers/state.sqlite'), "SELECT sequence,event_id,occurred_at,status FROM event_outbox WHERE trigger_id LIKE '%repository-events' ORDER BY sequence")).toEqual(repositoryDelivery.eventSource.events)
    }
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({ route: route.proof, sessionId, goalId: goal.id, scope, native,
      calls, approvals: approvals.length, sourceJobs, receipts, ...(repositoryDelivery ? { repositoryDelivery } : {}), resultFeedback: { turn: response.turn, visibleReply }, restart: { sameGoal: true, sameSourceJobEvidence: true, replyVisible: true, ...(repositoryEvents ? { waitedThenRestarted: true } : {}) },
      limitation: 'Real gateway integration evidence only; it does not establish a GitHub PR lifecycle, token/USD hard limits, or long-running autonomy.' }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    try {
      await writeFile(testInfo.outputPath('runtime-diagnostics.json'), JSON.stringify(await runtimeDiagnostics(home, sessionId, observerLog), null, 2), { mode: 0o600 })
      if (existsSync(observerLog)) await copyFile(observerLog, testInfo.outputPath('observer.jsonl'))
      if (env.DSH_REPO_DELIVERY_FIXTURE_LOG && existsSync(env.DSH_REPO_DELIVERY_FIXTURE_LOG)) await copyFile(env.DSH_REPO_DELIVERY_FIXTURE_LOG, testInfo.outputPath('github-fixture.jsonl'))
      if (env.DSH_REPO_EVENT_SOURCE_LOG && existsSync(env.DSH_REPO_EVENT_SOURCE_LOG)) await copyFile(env.DSH_REPO_EVENT_SOURCE_LOG, testInfo.outputPath('github-source-observations.jsonl'))
      if (repositoryEvents && existsSync(join(home, 'event-triggers/state.sqlite'))) await writeFile(testInfo.outputPath('source-health.json'), JSON.stringify(query(join(home, 'event-triggers/state.sqlite'), 'SELECT * FROM trigger_health')), { mode: 0o600 })
      await writeFile(testInfo.outputPath('approvals.json'), JSON.stringify(approvals), { mode: 0o600 })
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
      // This fixed, credential-free task can retain its visible tool evidence.
      // Never capture raw LLM request headers or provider authentication state.
      const toolEvents = frames.flatMap(frame => frame.value?.type === 'event' && ['tool/call', 'tool/result'].includes(frame.value.event?.type) ? [frame.value.event] : [])
      await writeFile(testInfo.outputPath('tool-events.json'), sanitize(JSON.stringify(toolEvents, null, 2)), { mode: 0o600 })
      if (failed && !new URL(activePage.url()).searchParams.has('token')) await writeFile(testInfo.outputPath('failure-dom.txt'), sanitize(await activePage.locator('body').innerText().catch(() => '')), { mode: 0o600 })
    } finally { try { if (host) { await host.stop(); await writeFile(testInfo.outputPath('host.log'), host.log(), { mode: 0o600 }) } } finally {
      const retain = failed && process.env.DSH_REPO_RETAIN_FAILURE === '1'
      // Persist this before best-effort server/browser shutdown: a shutdown
      // error must never erase the only inspectable failed profile.
      if (retain) await writeFile(testInfo.outputPath('retained-environment.json'), JSON.stringify({ temp, sessionId }), { mode: 0o600 })
      try { if (externalBroker) await externalBroker() } finally {
        try { if (restarted) await restarted.close() } finally {
          if (!retain) await rm(temp, { recursive: true, force: true })
        }
      }
    } }
  }
})
