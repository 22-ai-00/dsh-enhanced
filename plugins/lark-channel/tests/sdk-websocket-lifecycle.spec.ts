import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/lark-sdk-websocket-lifecycle.mjs', import.meta.url))

function runFixture(mode: 'timeout' | 'early-close' | 'card'): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fixture, mode], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

describe('locked official Lark SDK WebSocket lifecycle', () => {
  test.each(['timeout', 'early-close'] as const)('%s handles a real hanging Upgrade and exits', async mode => {
    const result = await runFixture(mode)
    expect(result, `${mode}: ${result.stdout}\n${result.stderr}`).toMatchObject({
      code: 0, signal: null, stderr: '', timedOut: false,
    })
    expect(result.stdout).toContain(`handshake=${mode} connect=false`)
    expect(result.stdout).toContain('async_abort_error=handled')
    expect(result.stdout).toContain('fixture_resources=closed')
  }, 20_000)

  test('keeps the CardKit callback bridge and native event ACK working', async () => {
    const result = await runFixture('card')
    expect(result, `${result.stdout}\n${result.stderr}`).toMatchObject({
      code: 0, signal: null, stderr: '', timedOut: false,
    })
    expect(result.stdout).toContain('native_card=discarded bridge_card=invoke_once_ack_200 event=invoke_once_ack_200')
    expect(result.stdout).toContain('fixture_resources=closed')
  }, 20_000)
})
