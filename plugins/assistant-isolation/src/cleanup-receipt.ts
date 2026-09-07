import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = /^dsh-isolation-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const OUTPUT_LIMIT = 4096
const COMMAND_TIMEOUT_MS = 10_000

export interface CleanupResourceReceipt {
  kind: 'container' | 'volume'
  name: string
  removalExitCode: number | null
  inspectionConfirmedAbsent: true
}

export interface CleanupReceiptData {
  dockerPath: string
  socketPath: string
  containerName: string
  checkedAt: number
  resources: readonly CleanupResourceReceipt[]
}

/** Nominal, capability-like receipt. Only this module can mint one. */
export type IsolationCleanupReceipt = object
const receipts = new WeakMap<object, CleanupReceiptData>()

function validSocket(path: string): boolean {
  return path.startsWith('/') && !/[\p{Cc}]/u.test(path)
}

function environment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
}

interface CommandResult { code: number | null; stderr: string; timedOut: boolean; aborted: boolean }

async function command(dockerPath: string, configDirectory: string, socketPath: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  return await new Promise(resolve => {
    let child: ReturnType<typeof spawn> | undefined
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (code: number | null, timedOut: boolean, aborted: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({ code, stderr, timedOut, aborted })
    }
    const abort = (): void => { child?.kill('SIGKILL'); finish(null, false, true) }
    if (signal?.aborted) { finish(null, false, true); return }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      child = spawn(dockerPath, ['--config', configDirectory, '-H', `unix://${socketPath}`, ...args], {
        shell: false, env: environment(), stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch { finish(null, false, false); return }
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = OUTPUT_LIMIT - Buffer.byteLength(stderr)
      if (remaining <= 0) { child?.kill('SIGKILL'); finish(null, false, false); return }
      const value = Buffer.from(chunk)
      if (value.length > remaining) { stderr += value.subarray(0, remaining).toString('utf8'); child?.kill('SIGKILL'); finish(null, false, false); return }
      stderr += value.toString('utf8')
    })
    child.once('error', () => finish(null, false, false))
    child.once('close', (code, signalName) => finish(signalName === null ? code : null, false, false))
    timer = setTimeout(() => { child?.kill('SIGKILL'); finish(null, true, false) }, COMMAND_TIMEOUT_MS)
    timer.unref()
  })
}

function absent(result: CommandResult): boolean {
  return !result.timedOut && !result.aborted && result.code !== null
    && result.code !== 0 && /no such (object|container|volume)/i.test(result.stderr)
}

async function removeOne(dockerPath: string, configDirectory: string, socketPath: string, kind: 'container' | 'volume', name: string, signal?: AbortSignal): Promise<CleanupResourceReceipt | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const removal = await command(dockerPath, configDirectory, socketPath, kind === 'volume' ? ['volume', 'rm', name] : ['rm', '-f', name], signal)
    // A failed or ambiguous remove invalidates this cleanup pass even if a later
    // inspect happens to find the resource absent.
    if (removal.timedOut || removal.aborted || removal.code === null) return undefined
    const inspection = await command(dockerPath, configDirectory, socketPath, ['inspect', '--type', kind, name], signal)
    if (absent(inspection)) return Object.freeze({ kind, name, removalExitCode: removal.code, inspectionConfirmedAbsent: true })
    if (inspection.timedOut || inspection.aborted || inspection.code === null) return undefined
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100))
  }
  return undefined
}

/**
 * Deletes and then independently inspects all three deterministic resources.
 * The returned opaque receipt is evidence of this exact cleanup pass only.
 */
export async function cleanupIsolationResources(dockerPath: string, name: string, options: { socketPath?: string; signal?: AbortSignal } = {}): Promise<IsolationCleanupReceipt | undefined> {
  const socketPath = options.socketPath ?? '/var/run/docker.sock'
  if (!NAME.test(name) || !dockerPath.startsWith('/') || !validSocket(socketPath) || options.signal?.aborted) return undefined
  let configDirectory: string | undefined
  try {
    configDirectory = await mkdtemp(join(tmpdir(), 'dsh-isolation-docker-'))
    await chmod(configDirectory, 0o700)
  } catch { return undefined }
  try {
    const targets: Array<readonly ['container' | 'volume', string]> = [
      ['container', name], ['container', `${name}-keeper`], ['volume', `${name}-workspace`],
    ]
    const resources: CleanupResourceReceipt[] = []
    let complete = true
    for (const [kind, target] of targets) {
      const receipt = await removeOne(dockerPath, configDirectory, socketPath, kind, target, options.signal)
      if (receipt === undefined) complete = false
      else resources.push(receipt)
    }
    if (!complete || options.signal?.aborted) return undefined
    const receipt = Object.freeze({})
    receipts.set(receipt, Object.freeze({ dockerPath, socketPath, containerName: name, checkedAt: Date.now(), resources: Object.freeze(resources) }))
    return receipt
  } finally {
    await rm(configDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Returns immutable receipt data only for receipts minted by this module. */
export function receiptData(receipt: unknown): CleanupReceiptData | undefined {
  return typeof receipt === 'object' && receipt !== null ? receipts.get(receipt) : undefined
}
