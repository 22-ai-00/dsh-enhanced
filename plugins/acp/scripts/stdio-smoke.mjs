import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'

const profile = process.env.DSH_ACP_PROFILE ?? 'acp'
const dshCommand = process.env.DSH_COMMAND ?? (process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const dshEntry = process.env.DSH_ENTRY
const expectedVersion = process.env.DSH_ACP_EXPECTED_VERSION
const timeoutMs = 20_000

const child = dshEntry !== undefined
  ? spawn(process.execPath, [dshEntry, '--profile', profile], { stdio: ['pipe', 'pipe', 'pipe'] })
  : process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${dshCommand} --profile ${profile}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  : spawn(dshCommand, ['--profile', profile], { stdio: ['pipe', 'pipe', 'pipe'] })

child.stderr.pipe(process.stderr)

const exit = new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ code, signal }))
})

async function withTimeout(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

try {
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  )
  const client = new ClientSideConnection(() => ({
    sessionUpdate: () => Promise.resolve(),
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
  }), stream)
  const initialized = await withTimeout(
    client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
    'ACP initialize',
  )

  if (initialized.agentInfo?.name !== 'dsh-enhanced-acp') {
    throw new Error(`unexpected ACP agent name: ${initialized.agentInfo?.name ?? '<missing>'}`)
  }
  if (expectedVersion !== undefined && initialized.agentInfo.version !== expectedVersion) {
    throw new Error(`unexpected ACP agent version: ${initialized.agentInfo.version ?? '<missing>'}`)
  }

  child.kill('SIGKILL')
  await withTimeout(exit, 'DSH termination')

  process.stdout.write(`ACP initialize succeeded for ${initialized.agentInfo.name}@${initialized.agentInfo.version}\n`)
} catch (error) {
  child.kill('SIGKILL')
  throw error
}
