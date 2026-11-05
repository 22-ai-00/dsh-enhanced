import { expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { parseDocument } from 'yaml'

const root = fileURLToPath(new URL('../../', import.meta.url))
// First-run notice title differs by pinned DSH Host: 'Preview Notice' (0.2.x) and 'Internal Testing Notice' (older).
export const firstRunNoticeName = /^(Preview Notice|Internal Testing Notice)$/
/**
 * Accept the first-run notice in a browser context. The first context must show
 * it; DSH 0.2.x keeps the acknowledgement per browser context, so a fresh
 * context after a Host restart shows it again while older Hosts may not.
 */
export async function acceptFirstRunNotice(page, { required = true } = {}) {
  const notice = page.getByRole('dialog', { name: firstRunNoticeName })
  if (!required && !await notice.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) return
  await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(notice).toBeHidden()
}
/**
 * Read the Web profile patch. DSH 0.2.x moves $DSH_HOME/settings.yaml (the
 * real model route) into this patch on the first Host start, so a document
 * parsed before a Host ran is stale: writing it back would drop the route.
 * Re-read after every Host stop before editing the patch again.
 */
export async function readProfilePatch(path) {
  return parseDocument(await readFile(path, 'utf8'))
}
/**
 * Reveal a persisted tool row in the transcript and return its locator.
 * DSH 0.2.x folds settled turns behind a turn-process disclosure
 * ("Completed in Xs") and tool rows behind step-process groups
 * ("Called tools"); older Hosts used "N tool calls" groups. Only collapsed
 * disclosures are opened, so retries never close one already open.
 */
export async function revealToolCall(page, name) {
  const target = page.getByRole('button', { name }).last()
  const collapsed = page.locator('button[data-turn-process][aria-expanded="false"]:not([disabled]), button[data-process-activity][aria-expanded="false"]')
    .or(page.getByRole('button', { name: /^\d+ tool calls?$/, expanded: false }))
  await expect(async () => {
    const bottom = page.getByRole('button', { name: 'Back to bottom', exact: true })
    if (await bottom.isVisible()) await bottom.click()
    // A click re-renders the transcript, so a later index can go stale or
    // disabled; bound each click and let toPass re-query instead of hanging.
    for (const disclosure of await collapsed.all()) await disclosure.click({ timeout: 2_000 }).catch(() => {})
    await expect(target).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  return target
}
/**
 * Fill the composer and wait until Send is enabled and stays enabled. A late
 * settings/session re-render can clear a draft typed right after session
 * creation, so refill until the draft survives a short settle window.
 */
export async function fillComposer(page, composer, text) {
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await expect(async () => {
    await composer.fill(text)
    await expect(send).toBeEnabled({ timeout: 2_000 })
    await page.waitForTimeout(500)
    await expect(send).toBeEnabled({ timeout: 100 })
  }).toPass({ timeout: 30_000 })
}
export const sanitize = text => stripVTControlCharacters(String(text)).replace(/([?&]token=)[^\s"<>]+/g, '$1[redacted]')

export async function run(command, args, env, timeout = 90_000) {
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error } }, timeout)
  try {
    const [code] = await once(child, 'close')
    if (code !== 0) throw new Error(`${command} exited ${code}: ${sanitize(output).slice(-6000)}`)
    return output
  } finally { clearTimeout(timer) }
}

export function query(path, sql, ...args) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all(...args) } finally { db.close() }
}

export async function startHost(env) {
  const child = spawn('dsh', ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; let settled = false; let termination
  const closed = once(child, 'close').then(([code, signal]) => { settled = true; return { code, signal } }); closed.catch(() => {})
  const url = await new Promise((resolve, reject) => {
    // Isolation may still be waiting out the previous Host's 30-second
    // controller lease after a crash. Readiness must include that startup.
    const timer = setTimeout(() => reject(new Error('DSH Web did not announce readiness')), 45_000)
    const receive = chunk => { output += chunk; const match = stripVTControlCharacters(output).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/); if (match) { clearTimeout(timer); resolve(match[0]) } }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); reject(new Error(`DSH stopped before readiness (${code}): ${sanitize(output).slice(-6000)}`)) })
  }).catch(async error => { if (child.pid && !settled) { try { process.kill(-child.pid, 'SIGKILL') } catch (killError) { if (killError?.code !== 'ESRCH') throw killError } }; await closed.catch(() => {}); throw error })
  return {
    url,
    pid: child.pid,
    log: () => sanitize(output),
    async terminate() {
      if (termination) return termination
      termination = (async () => {
        const evidence = { pid: child.pid, processGroup: child.pid, signal: 'SIGKILL', alreadyClosed: settled, sent: false }
        if (!settled && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); evidence.sent = true } catch (error) {
            if (error?.code === 'ESRCH') evidence.missing = true
            else throw error
          }
        }
        const result = await closed
        return { ...evidence, closed: true, code: result.code, closeSignal: result.signal }
      })()
      return termination
    },
    async stop() { if (settled) return; try { process.kill(-child.pid, 'SIGINT') } catch (error) { if (error?.code !== 'ESRCH') throw error }; const timer = setTimeout(() => { if (!settled) try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error } }, 10_000); try { await closed } finally { clearTimeout(timer) } },
  }
}

export function observePage(page, http, transport, streams, frames) {
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) transport.push({ kind: message.type(), message: sanitize(message.text()) }) })
  page.on('pageerror', error => transport.push({ kind: 'page-error', message: sanitize(String(error)) }))
  page.on('websocket', socket => { transport.push({ kind: 'socket', path: new URL(socket.url()).pathname }); socket.on('socketerror', error => transport.push({ kind: 'socket-error', message: sanitize(String(error)) })); socket.on('framesent', ({ payload }) => { try { const frame = JSON.parse(String(payload)); transport.push({ kind: 'sent', frame }); if (frame.type === 'open') streams.set(frame.streamId, frame.endpoint) } catch { transport.push({ kind: 'sent-non-json' }) } }); socket.on('framereceived', ({ payload }) => { try { const frame = JSON.parse(String(payload)); frames.push(frame); transport.push({ kind: 'received', frame: frame.type === 'item' ? { type: frame.type, streamId: frame.streamId, valueType: frame.value?.type, event: typeof frame.value?.event === 'string' ? frame.value.event : frame.value?.event?.type } : frame }) } catch { transport.push({ kind: 'received-non-json' }) } }) })
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/session/')) http.push(response) })
}
