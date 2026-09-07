import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { observePage, query, run, sanitize, startHost } from './web-owner-helpers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const objective = 'Browser owner end-to-end goal'

test('fresh Web owner authenticates, streams a business goal, and resumes its session', async ({ page, context, playwright }, testInfo) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-web-owner-e2e-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const modelLog = join(temp, 'model.jsonl')
  const env = { ...process.env, CI: 'true', DSH_HOME: home, DSH_WEB_E2E_MODEL_LOG: modelLog }
  let host
  let restartedContext
  let activePage = page
  let authenticated = false
  let failed = false
  const http = []
  const transport = []
  const streams = new Map()
  const frames = []
  observePage(page, http, transport, streams, frames)
  try {
    await mkdir(workspace)
    // Exercise the actual bundle installer and shipped setup CLI in an empty home.
    const installed = await run('dsh', ['plugin', '--profile', 'web', 'add', ...[
      'personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner',
    ].map(name => resolve(root, 'plugins', name))], env)
    await writeFile(testInfo.outputPath('install.log'), sanitize(installed), { mode: 0o600 })
    await run(join(home, 'profiles/web/node_modules/.bin/dsh-web-owner-setup'), ['--profile', 'web', '--workspace', workspace], env)
    const patchPath = join(home, 'profiles/web/cordis.patch.yml')
    const patch = parseDocument(await readFile(patchPath, 'utf8'))
    patch.add({ id: 'agent-default-model', config: { provider: 'browser-e2e', model: 'goal-proof' } })
    // Exclude the independent title generator from the six-call goal fixture.
    patch.add({ id: 'session-title-llm', disabled: true })
    patch.add({ insert: [{ id: 'web-owner-e2e-model', name: resolve(root, 'scripts/e2e/web-owner-model.mjs') }] })
    await writeFile(patchPath, String(patch), { mode: 0o600 })
    host = await startHost(env)
    const origin = new URL(host.url).origin
    const api = await playwright.request.newContext()
    try {
      const response = await api.post(`${origin}/api/session/create`, { headers: { Origin: origin }, data: {} })
      expect(response.status()).toBe(401)
    } finally { await api.dispose() }

    // Do not allow Playwright's navigation error to print the credential-bearing URL.
    try { await page.goto(host.url) } catch { throw new Error('Browser launch authentication failed (URL redacted)') }
    await expect(page).toHaveURL(`${origin}/`)
    authenticated = true
    const cookies = await context.cookies()
    expect(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/')).toBe(true)
    const wrongOrigin = await context.request.post(`${origin}/api/session/create`, { headers: { Origin: 'https://untrusted.invalid' }, data: {} })
    expect(wrongOrigin.status()).toBe(403)

    await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click()

    const newSession = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
    await expect(newSession).toBeVisible()
    // Native workspace navigation automatically opens the sole registered workspace.
    await expect.poll(() => http.find(response => new URL(response.url()).pathname === '/api/session/create')).toBeTruthy()
    const created = http.find(response => new URL(response.url()).pathname === '/api/session/create')
    expect(created.status()).toBe(200)
    const createResult = (await created.json()).result
    expect(createResult).toMatchObject({ ok: true })
    const sessionId = createResult.value.sessionId
    const composer = page.getByLabel(/Describe what you want to build|Message or run a task/)
    await composer.fill(`Create a goal: ${objective}`)
    const promptPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const promptResponse = await promptPromise
    expect((await promptResponse.json()).result.ok).toBe(true)
    expect(promptResponse.request().postDataJSON().payload.args.request.sessionId).toBe(sessionId)
    await page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect(page.getByText('Browser owner reply 2', { exact: true })).toBeVisible()

    const deliveryPath = join(home, 'assistant-delivery/state.sqlite')
    const goalsPath = join(home, 'assistant-goals/web.sqlite')
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    const bindings = query(deliveryPath, 'SELECT * FROM conversation_bindings WHERE session_id = ?', sessionId)
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({ workspace, agent_preset: 'standard', status: 'active' })
    expect(JSON.parse(bindings[0].principal_json)).toEqual({ channel: 'web', account: 'web', tenant: 'local', user: 'operator' })
    expect(query(deliveryPath, 'SELECT status FROM inbox_messages WHERE binding_id = ?', bindings[0].id)).toEqual([{ status: 'processed' }])
    expect(existsSync(goalsPath)).toBe(true)
    const goals = query(goalsPath, 'SELECT * FROM goal_records')
    expect(goals).toHaveLength(1)
    expect(goals[0].original_objective).toBe(objective)
    const scope = JSON.parse(goals[0].scope_json)
    expect(scope).toMatchObject({ workspace, preset: 'standard', principalId: 'web/web/local/operator', principalRecordId: bindings[0].principal_id })
    expect(scope.principalVersion).toBe(query(deliveryPath, 'SELECT version FROM delivery_principals WHERE id = ?', bindings[0].principal_id)[0]?.version)
    expect(JSON.parse(goals[0].native_json).sessionId).toBe(sessionId)
    expect([...streams.values()]).toContain('session/follow')
    expect(frames.some(frame => frame.type === 'item' && streams.get(frame.streamId) === 'session/follow')).toBe(true)

    const callsBeforeRestart = (await readFile(modelLog, 'utf8')).trim().split('\n').length
    await host.stop()
    await writeFile(testInfo.outputPath('host-first.log'), host.log(), { mode: 0o600 })
    host = await startHost(env)
    const restartedOrigin = new URL(host.url).origin
    const browser = context.browser()
    if (browser === null) throw new Error('Playwright browser is unavailable for fresh restart context')
    restartedContext = await browser.newContext()
    const resumedPage = await restartedContext.newPage()
    activePage = resumedPage
    observePage(resumedPage, http, transport, streams, frames)
    try { await resumedPage.goto(host.url) } catch { throw new Error('Restarted browser authentication failed (URL redacted)') }
    await expect(resumedPage).toHaveURL(`${restartedOrigin}/`)
    expect((await restartedContext.cookies()).some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/')).toBe(true)
    const workspaceRow = resumedPage.getByRole('treeitem', { name: 'workspace', exact: true })
    await expect(workspaceRow).toBeVisible()
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await resumedPage.getByRole('treeitem', { name: /Create a goal: Browser owner/ }).click()
    await expect(resumedPage.getByText('Browser owner reply 2', { exact: true })).toBeVisible()
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    const callsBeforePrompt = (await readFile(modelLog, 'utf8')).trim().split('\n').length
    const resumedComposer = resumedPage.getByLabel(/Describe what you want to build|Message or run a task/)
    await resumedComposer.fill('Continue this same session with a short acknowledgement.')
    const resumedPrompt = resumedPage.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt')
    await resumedPage.getByRole('button', { name: 'Send message', exact: true }).click()
    const resumed = await resumedPrompt
    expect((await resumed.json()).result.ok).toBe(true)
    expect(resumed.request().postDataJSON().payload.args.request.sessionId).toBe(sessionId)
    await expect(resumedPage.getByText(`Browser owner reply ${callsBeforePrompt + 1}`, { exact: true })).toBeVisible()
    await expect.poll(() => query(deliveryPath, "SELECT count(*) AS n FROM inbox_messages WHERE binding_id = ? AND status = 'processed'", bindings[0].id)[0]?.n).toBe(2)
    await expect.poll(() => query(deliveryPath, 'SELECT state FROM delivery_session_leases WHERE session_id = ?', sessionId)[0]?.state).toBe('released')
    expect(query(goalsPath, 'SELECT id, original_objective, scope_json FROM goal_records')).toEqual([{
      id: goals[0].id, original_objective: objective, scope_json: goals[0].scope_json,
    }])
    const { roundsStarted: roundsBeforeRestart, ...nativeBeforeRestart } = JSON.parse(goals[0].native_json)
    const { roundsStarted: roundsAfterRestart, ...nativeAfterRestart } = JSON.parse(query(goalsPath, 'SELECT native_json FROM goal_records')[0].native_json)
    expect(nativeAfterRestart).toEqual(nativeBeforeRestart)
    expect(roundsAfterRestart).toBeGreaterThanOrEqual(roundsBeforeRestart)
    expect(roundsAfterRestart).toBeLessThanOrEqual(1)
    expect(query(deliveryPath, 'SELECT * FROM conversation_bindings WHERE session_id = ?', sessionId)).toEqual(bindings)
    const calls = (await readFile(modelLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls[0]).toEqual({ call: 1, type: 'goal-tool', hasGoalTool: true })
    expect(calls.filter(call => call.type === 'goal-tool')).toEqual([{ call: 1, type: 'goal-tool', hasGoalTool: true }])
    expect(calls.length).toBeLessThanOrEqual(6)
    expect(calls.length).toBe(callsBeforePrompt + 1)
    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({
      authentication: { launchRedirect: true, unauthenticatedStatus: 401, untrustedOriginStatus: 403 },
      sessionId, bindingId: bindings[0].id, goalId: goals[0].id, objective,
      streams: [...streams.values()], processedPrompts: 2, finalLease: 'released', hostRestart: true, freshBrowserContext: true,
      goalScope: scope, approvedTool: 'goal_create',
      model: 'deterministic browser-e2e/goal-proof; not a real-model autonomy benchmark',
      calls, callsBeforeRestart, roundsBeforeRestart, roundsAfterRestart,
    }, null, 2), { mode: 0o600 })
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      if (authenticated && failed && !new URL(activePage.url()).searchParams.has('token')) {
        await activePage.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {})
        await writeFile(testInfo.outputPath('failure-dom.txt'), await activePage.locator('body').innerText().catch(() => ''), { mode: 0o600 })
      }
      await writeFile(testInfo.outputPath('transport.json'), JSON.stringify(transport, null, 2), { mode: 0o600 })
      await writeFile(testInfo.outputPath('http.json'), JSON.stringify(await Promise.all(http.map(async response => ({
        path: new URL(response.url()).pathname, status: response.status(),
        request: response.request().postDataJSON(), result: await response.json().catch(() => null),
      }))), null, 2), { mode: 0o600 })
    } finally {
      try {
        if (host) {
          await host.stop()
          await writeFile(testInfo.outputPath('host.log'), host.log(), { mode: 0o600 })
        }
      } finally {
        if (restartedContext) await restartedContext.close().catch(() => {})
        await rm(temp, { recursive: true, force: true })
      }
    }
  }
})
