import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

test('fresh autonomy installer executes a finite offline grant through native Web tools without per-call approval', async ({ page }, testInfo) => {
  const image = process.env.DSH_ISOLATION_TEST_IMAGE
  if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('DSH_ISOLATION_TEST_IMAGE must select an existing immutable local Docker image')
  const temp = await mkdtemp(join(tmpdir(), 'dsh-autonomy-e2e-'))
  const home = join(temp, 'home'); const workspace = join(temp, 'workspace'); const modelLog = join(temp, 'model.jsonl')
  const port = await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(address.port)) })
  })
  const env = { ...process.env, DSH_ENHANCED_WEB_PORT: String(port), CI: 'true', DSH_HOME: home, DSH_WEB_E2E_MODEL_LOG: modelLog }
  const http = []; const transport = []; const streams = new Map(); const frames = []
  observePage(page, http, transport, streams, frames)
  let host; let authenticated = false; let failed = false
  try {
    await mkdir(workspace)
    const installed = await run('/bin/bash', ['scripts/install/install-local.sh', '--scenario', 'autonomy', '--profile', 'web',
      '--isolation-image', image, '--workspace', workspace, '--yes', '--no-service', '--model', 'skip', '--model-route', 'skip', '--dsh-version', '0.1.2-rc.1'], env, 180_000)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    const patchPath = join(home, 'profiles/web/cordis.patch.yml')
    const before = await readFile(patchPath, 'utf8')
    // Rerun the shipped setup, including its real probe. Grant expiry must not slide.
    await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace, '--isolation-image', image], env)
    expect(await readFile(patchPath, 'utf8')).toBe(before)
    const patch = parseDocument(before)
    patch.add({ id: 'agent-default-model', config: { provider: 'browser-e2e', model: 'isolation-proof' } })
    patch.add({ id: 'session-title-llm', disabled: true })
    patch.add({ insert: [{ id: 'autonomy-e2e-model', name: resolve(root, 'scripts/e2e/autonomy-model.mjs') }] })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    host = await startHost(env)
    const origin = new URL(host.url).origin
    try { await page.goto(host.url) } catch { throw new Error('Browser launch authentication failed (URL redacted)') }
    await expect(page).toHaveURL(`${origin}/`); authenticated = true
    await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => http.find(response => new URL(response.url()).pathname === '/api/session/create')).toBeTruthy()
    const created = await http.find(response => new URL(response.url()).pathname === '/api/session/create').json()
    expect(created.result.ok).toBe(true)
    const sessionId = created.result.value.sessionId
    const ledger = join(home, 'assistant-isolation/web/ledger.sqlite')
    const delivery = join(home, 'assistant-delivery/state.sqlite')
    for (const [prompt, reply] of [['Compute the answer in the authorized offline environment.', 'Autonomy reply 2'], ['Retrieve the same execution with its original idempotency key.', 'Autonomy reply 4']]) {
      await page.getByLabel(/Describe what you want to build|Message or run a task/).fill(prompt)
      const sent = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      expect((await (await sent).json()).result.ok).toBe(true)
      await expect(page.getByText(reply, { exact: true })).toBeVisible()
      await expect.poll(() => query(delivery, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
      const jobs = query(ledger, 'SELECT * FROM isolation_jobs')
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({ status: 'succeeded', session_id: sessionId, dispatch_attempted: 1, reserved_duration_ms: 20_000 })
      expect(JSON.parse(jobs[0].result_json)).toMatchObject({ status: 'succeeded', quiescent: true, stdout: '42', artifacts: [{ path: 'answer.txt', content: '42' }] })
    }
    const grant = query(ledger, 'SELECT * FROM isolation_grants')[0]
    const binding = query(delivery, 'SELECT * FROM conversation_bindings WHERE session_id = ?', sessionId)[0]
    expect(grant).toMatchObject({ id: 'autonomy-web', principal_record_id: binding.principal_id, workspace, agent_preset: 'standard', max_runs: 20, max_total_duration_ms: 600_000 })
    const calls = (await readFile(modelLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toHaveLength(4)
    expect(calls[0].hasActionTool).toBe(true)
    expect(calls[0].hasGoalTool).toBe(true)
    expect(calls.filter(call => call.type === 'isolation-tool').every(call => call.hasIsolationTool)).toBe(true)
    expect(await page.getByRole('button', { name: 'Allow once', exact: true }).count()).toBe(0)
    // Inspect native streamed events, including asks that might no longer be visible.
    expect(JSON.stringify(frames)).not.toContain('approval/asked')
    expect(JSON.stringify(frames)).not.toContain('policy/ask')
    const doctorArgs = ['scripts/install/doctor.sh', '--profile', 'web', '--require-isolation']
    const originalPatch = await readFile(patchPath, 'utf8')
    const originalJobs = query(ledger, 'SELECT * FROM isolation_jobs')
    const controller = query(ledger, 'SELECT owner_id, fence FROM isolation_controller')
    const checked = await run('/bin/bash', doctorArgs, env)
    const diagnostic = JSON.parse(checked.split('\n').find(line => line.startsWith('{"scope":"finite-isolation"')))
    expect(diagnostic).toMatchObject({ owner: { status: 'matched' }, grant: { status: 'available', runsUsed: 1, durationReservedMs: 20_000, remainingRuns: 19, remainingDurationMs: 580_000 }, modelAndGoals: 'not-checked' })
    expect(checked).toContain('temporary runtime probe passed')
    expect(query(ledger, 'SELECT * FROM isolation_grants')[0]).toEqual(grant)
    expect(query(ledger, 'SELECT * FROM isolation_jobs')).toEqual(originalJobs)
    expect(query(ledger, 'SELECT owner_id, fence FROM isolation_controller')).toEqual(controller)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    expect((await readFile(modelLog, 'utf8')).trim().split('\n')).toHaveLength(4)
    await writeFile(testInfo.outputPath('doctor.log'), sanitize(checked), { mode: 0o600 })
    // Seed an operator revocation in the disposable profile after stopping its Host.
    // This checks diagnosis of durable revocation, not an external-stop integration.
    await host.stop()
    const db = new DatabaseSync(ledger)
    try { db.prepare("UPDATE isolation_grants SET revoked=1, revoke_reason='doctor regression fixture' WHERE id='autonomy-web'").run() } finally { db.close() }
    let rejected = ''
    try { await run('/bin/bash', doctorArgs, env); throw new Error('revoked grant unexpectedly passed doctor') }
    catch (error) { rejected = String(error) }
    expect(rejected).toContain('exited 1')
    expect(rejected).toContain('grant-revoked')
    expect(rejected).not.toContain('temporary runtime probe passed')
    expect(query(ledger, 'SELECT * FROM isolation_jobs')).toEqual(originalJobs)
    expect(query(ledger, 'SELECT revoked, expires_at FROM isolation_grants')[0]).toEqual({ revoked: 1, expires_at: grant.expires_at })
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await writeFile(testInfo.outputPath('doctor-revoked.log'), sanitize(rejected), { mode: 0o600 })
    await writeFile(testInfo.outputPath('doctor-proof.json'), JSON.stringify({ diagnostic, liveHostControllerPreserved: true, jobsAndGrantPreserved: true,
      modelCallsBeforeAndAfter: 4, patchPreserved: true, runtimeProbePassed: true, seededRevocation: { rejected: true, exitCode: 1, persisted: true, expiryPreserved: true } }, null, 2), { mode: 0o600 })
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({
      installer: 'actual local installer and repeated shipped setup', image, sessionId,
      nativeTool: 'isolation_run', approvals: 0, jobs: 1, prompts: 2, reservedDurationMs: 20_000,
      result: { status: 'succeeded', quiescent: true, stdout: '42', artifact: 'answer.txt:42' },
      grantExpiryPreserved: true, calls,
      model: 'deterministic fixture; no real-model intelligence or full autonomy claim',
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
