import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument, isMap } from 'yaml'
import { createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import { objective } from './autonomy-goal-model.mjs'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const metered = process.env.DSH_AUTONOMY_DEEPSEEK_TEST === '1'
const root = fileURLToPath(new URL('../../', import.meta.url))
function configure(doc, id, values) {
  let row = doc.contents.items.find(item => isMap(item) && item.get('id') === id)
  if (!row) { row = doc.createNode({ id }); doc.contents.add(row) }
  if (!row.has('config')) row.set('config', doc.createNode({}))
  const config = row.get('config', true)
  if (!isMap(config)) throw new Error(`invalid config for ${id}`)
  for (const [key, value] of Object.entries(values)) config.set(key, doc.createNode(value))
}

test('native goals correct an isolated artifact after private independent verification and complete without another prompt', async ({ page }, testInfo) => {
  const image = process.env.DSH_ISOLATION_TEST_IMAGE
  if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('DSH_ISOLATION_TEST_IMAGE must select an existing immutable local Docker image')
  const temp = await mkdtemp(join(tmpdir(), 'dsh-autonomy-e2e-'))
  const home = join(temp, 'home'); const workspace = join(temp, 'workspace'); const modelLog = join(temp, 'model.jsonl')
  const port = await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(address.port)) })
  })
  const env = { ...process.env, DSH_ENHANCED_WEB_PORT: String(port), CI: 'true', DSH_HOME: home, DSH_WEB_E2E_MODEL_LOG: modelLog, ...(metered ? { DEEPSEEK_API_KEY: 'test-only-not-a-credential' } : {}) }
  const http = []; const transport = []; const streams = new Map(); const frames = []
  observePage(page, http, transport, streams, frames)
  let host; let authenticated = false; let failed = false
  try {
    await mkdir(workspace)
    const installed = await run('/bin/bash', ['scripts/install/install-local.sh', '--scenario', 'autonomy', '--profile', 'web',
      '--isolation-image', image, '--workspace', workspace, '--yes', '--no-service', '--model', 'skip', '--model-route', 'skip', '--dsh-version', '0.1.2-rc.1'], env, 180_000)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    if (metered) {
      const added = await run('dsh', ['plugin', '--profile', 'web', 'add', resolve(root, 'plugins/assistant-deepseek-budget')], env, 60000)
      await writeFile(testInfo.outputPath('add-budget-plugin.log'), sanitize(added), { mode: 0o600 })
    }
    const patchPath = join(home, 'profiles/web/cordis.patch.yml')
    const before = await readFile(patchPath, 'utf8')
    await writeFile(testInfo.outputPath('installed-profile.yaml'), before, { mode: 0o600 })
    const patch = parseDocument(before)
    const isolationRow = patch.toJS().find(row => row.id === 'dsh-enhanced-assistant-isolation')
    const grant = isolationRow.config.grants[0]
    const verifierPath = join(temp, 'verifier.sqlite')
    const verificationRoot = join(temp, 'verification')
    await mkdir(verificationRoot, { mode: 0o700 })
    const authority = { kind: 'isolated-runner', id: 'sum-checker', stateRoot: verificationRoot, image,
      dockerPath: '/usr/bin/docker', command: '/bin/sh /workspace/artifact < /workspace/input',
      expiresAt: grant.expiresAt, maxRuns: 12, maxTotalDurationMs: 240000, maxDurationMs: 20000, maxOutputBytes: 4096,
      testSets: [{ id: 'sum-cases', cases: [{ stdin: '19 23', expectedStdout: '42', expectedExitCode: 0 },
        { stdin: '-8 5', expectedStdout: '-3', expectedExitCode: 0 }] }] }
    const [compiled] = createVerifierAuthorities({ authorities: [authority] })
    const profiles = ['goal-step', 'goal-outcome'].map(taskKind => ({ id: taskKind, version: 1,
      scope: { workspace, preset: 'standard' }, owner: { principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion },
      objective, taskKind, validityMs: 240000, bounds: { maxDurationMs: 60000, maxEvidenceBytes: 8192 },
      criteria: [{ id: 'sum-behavior', kind: 'isolated-process-behavior', authority: { id: compiled.id, digest: compiled.digest }, artifactPath: 'answer.sh', testSetId: 'sum-cases' }] }))
    configure(patch, 'dsh-enhanced-assistant-verifier', { databasePath: verifierPath, tickIntervalMs: 0, authorities: [authority], profiles })
    configure(patch, 'dsh-enhanced-assistant-goals', { databasePath: join(home, 'assistant-goals/web.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true, stepMaxDurationMs: 60000,
      preauthorizedCreateMaxRounds: 3, executionBudget: { modelCalls: 6, toolCalls: 3, inputTokens: metered ? 2_100_000 : 200, outputTokens: 6000,
        ...(metered ? {} : { costUsdMicros: 0 }), durationMs: 240000, maxOutputTokensPerCall: 1024 } })
    if (metered) configure(patch, 'dsh-enhanced-assistant-deepseek-budget', { enabled: true, defaultMaxTokens: 1024 })
    patch.add({ id: 'agent-default-model', config: metered ? { provider: 'deepseek-goal-metered', model: 'deepseek-v4-flash' } : { provider: 'browser-e2e', model: 'isolated-goal-proof' } })
    patch.add({ id: 'session-title-llm', disabled: true })
    patch.add({ insert: [{ id: 'autonomy-goal-e2e-model', name: resolve(root, metered ? 'scripts/e2e/autonomy-deepseek-transport.mjs' : 'scripts/e2e/autonomy-goal-model.mjs') }] })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    host = await startHost(metered ? { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(resolve(root, 'scripts/e2e/autonomy-deepseek-transport.mjs')).href}` } : env)
    const origin = new URL(host.url).origin
    try { await page.goto(host.url) } catch { throw new Error('Browser launch authentication failed (URL redacted)') }
    await expect(page).toHaveURL(`${origin}/`); authenticated = true
    await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => http.find(response => new URL(response.url()).pathname === '/api/session/create')).toBeTruthy()
    const created = await http.find(response => new URL(response.url()).pathname === '/api/session/create').json()
    expect(created.result.ok).toBe(true)
    const sessionId = created.result.value.sessionId
    const ledger = join(home, 'assistant-isolation/web/ledger.sqlite')
    await page.getByLabel(/Describe what you want to build|Message or run a task/).fill(objective)
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect((await (await sent).json()).result.ok).toBe(true)
    const goalsPath = join(home, 'assistant-goals/web.sqlite')
    await expect.poll(() => query(goalsPath, 'SELECT native_json FROM goal_records').map(row => JSON.parse(row.native_json).phase), { timeout: 150000 }).toEqual(['complete'])
    const goalRecord = query(goalsPath, 'SELECT * FROM goal_records')[0]
    const native = JSON.parse(goalRecord.native_json)
    expect(native).toMatchObject({ sessionId, phase: 'complete', roundsStarted: 2 })
    expect(JSON.parse(goalRecord.scope_json)).toMatchObject({ principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace, preset: 'standard' })
    const jobs = query(ledger, 'SELECT * FROM isolation_jobs')
    expect(jobs).toHaveLength(2)
    expect(jobs.every(job => job.status === 'succeeded' && job.session_id === sessionId)).toBe(true)
    expect(jobs.every(job => JSON.parse(job.artifact_binding_json).paths.includes('answer.sh'))).toBe(true)
    const receipts = query(verifierPath, 'SELECT payload FROM acceptance_receipts').map(row => JSON.parse(row.payload))
    for (const job of jobs) {
      const admission = JSON.parse(job.artifact_binding_json).admission
      expect(receipts.find(receipt => receipt.contractId === admission.contractId)).toMatchObject({
        contractDigest: admission.contractDigest, task: { kind: 'goal-step', ref: admission.runId } })
    }
    expect(receipts.every(receipt => receipt.protocol === 'task-verification/v4')).toBe(true)
    expect(receipts.filter(receipt => receipt.task.kind === 'goal-step').map(receipt => receipt.objectiveStatus).sort()).toEqual(['achieved', 'not-achieved'])
    expect(receipts.filter(receipt => receipt.task.kind === 'goal-outcome').map(receipt => receipt.objectiveStatus).sort()).toEqual(['achieved', 'not-achieved'])
    const verifierJobs = query(join(verificationRoot, 'ledger.sqlite'), 'SELECT * FROM isolation_jobs')
    expect(verifierJobs).toHaveLength(6)
    expect(verifierJobs.every(job => job.status === 'succeeded' && !jobs.some(source => source.id === job.id))).toBe(true)
    const calls = (await readFile(modelLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls.filter(call => call.tool === 'goal_create')).toHaveLength(1)
    expect(calls.find(call => call.call === 5).feedbackObserved).toBe(true)
    expect(calls.every(call => !call.secretObserved)).toBe(true)
    expect(await page.getByRole('button', { name: 'Allow once', exact: true }).count()).toBe(0)
    expect(JSON.stringify(frames)).not.toContain('approval/asked')
    expect(JSON.stringify(frames)).not.toContain('policy/ask')
    const budgets = query(`${goalsPath}.budgets`, 'SELECT state,input_tokens_reserved,output_tokens_reserved,input_tokens_actual,output_tokens_actual FROM goal_budget_reservations')
    expect(budgets).toHaveLength(4)
    expect(budgets.every(row => row.state === 'settled')).toBe(true)
    if (metered) expect(budgets).toEqual(Array.from({ length: 4 }, () => ({ state: 'settled', input_tokens_reserved: 2_097_152, output_tokens_reserved: 1024, input_tokens_actual: 12, output_tokens_actual: 8 })))
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({
      image, sessionId, nativePhase: 'complete', native, prompts: 1, approvals: 0,
      setup: metered ? 'actual autonomy installer and installed production DeepSeek budget bundle; explicit task profiles and mock provider transport' : 'actual autonomy installer plus explicit test-only Goals/Verifier profiles and model-meter overlay',
      sourceJobs: jobs.map(job => ({ id: job.id, binding: JSON.parse(job.artifact_binding_json) })),
      verificationJobs: verifierJobs.map(job => ({ id: job.id, status: job.status })),
      receipts, calls, budgetReservations: budgets.length, budgets,
      model: metered ? 'production serializer/adapter/meter with deterministic HTTP response fixture; no paid API or intelligence/pricing proof' : 'deterministic fixture with exact fixture metering; not production model intelligence or pricing proof',
      acceptance: 'operator-configured exact task profiles; not generic installer-generated success conditions',
    }, null, 2), { mode: 0o600 })
  } catch (error) { failed = true; throw error } finally {
    try {
      if (failed && authenticated && !new URL(page.url()).searchParams.has('token')) await writeFile(testInfo.outputPath('failure-dom.txt'), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 })
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
    } finally {
      try { if (host) { await writeFile(testInfo.outputPath('model.jsonl'), await readFile(modelLog, 'utf8').catch(() => ''), { mode: 0o600 }); await host.stop(); await writeFile(testInfo.outputPath('host.log'), host.log(), { mode: 0o600 }) } }
      finally { await rm(temp, { recursive: true, force: true }) }
    }
  }
})
