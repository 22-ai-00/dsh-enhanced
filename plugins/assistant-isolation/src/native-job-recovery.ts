import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isPrivateDirectoryStats, isPrivateFileStats, noFollowFlag } from './fs-ownership.js'
import { IsolationLedgerError, type IsolationControllerAuthority, type IsolationLedger } from './ledger.js'
import type { IsolationFile, IsolationJob, IsolationResult } from './types.js'

export interface NativeCommandReceipt {
  schemaVersion: 1
  backend: 'macos-seatbelt' | 'windows-job'
  jobId: string
  requestDigest: string
  nonce: string
  nativeResourceId: string
  closed: true
  closedAt: number
  result: {
    status: string
    quiescent: true
    stdout: string
    stderr: string
    artifacts?: IsolationFile[]
    exitCode?: number
    reason?: string
    pid?: number
  }
}

export function normalizeNativeReceiptResult(
  jobId: string,
  raw: NativeCommandReceipt['result'],
): IsolationResult {
  const status: IsolationResult['status'] = raw.status === 'output-limit'
    ? 'failed'
    : (raw.status as IsolationResult['status'])
  return {
    jobId,
    status,
    quiescent: true,
    stdout: raw.stdout,
    stderr: raw.stderr,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(item => ({ path: item.path, content: item.content })) : [],
    ...(raw.exitCode === undefined ? {} : { exitCode: raw.exitCode }),
    ...(raw.status === 'output-limit'
      ? { reason: 'output-limit' }
      : raw.reason === undefined ? {} : { reason: raw.reason }),
  }
}

export function writeNativeReceiptSync(
  receiptRoot: string,
  receipt: NativeCommandReceipt,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): void {
  mkdirSync(receiptRoot, { recursive: true, mode: 0o700 })
  const info = lstatSync(receiptRoot)
  if (!isPrivateDirectoryStats(info, platform, uid)) throw new Error('invalid receipt root')
  const bytes = Buffer.from(JSON.stringify(receipt))
  if (bytes.length > 3_000_000) throw new Error('receipt exceeds limit')
  const file = join(receiptRoot, `${receipt.jobId}.json`)
  const temporary = join(receiptRoot, `.${receipt.jobId}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(platform), 0o600)
    if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) throw new Error('invalid receipt temp')
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  renameSync(temporary, file)
  if (platform !== 'win32') {
    const dirFd = openSync(receiptRoot, constants.O_RDONLY)
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  }
}

export async function readNativeReceipt(
  stateRoot: string,
  job: IsolationJob,
  maxOutputBytes = 1_048_576,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): Promise<IsolationResult | undefined> {
  if ((job.backend !== 'macos-seatbelt' && job.backend !== 'windows-job')
    || !job.dispatchAttempted || !job.nativeNonce || !job.nativeResourceId) {
    return undefined
  }
  const path = join(stateRoot, 'receipts', `${job.id}.json`)
  try {
    const info = await lstat(path)
    if (!isPrivateFileStats(info, platform, uid) || info.size > 3_000_000) return undefined
    const receipt = JSON.parse(await readFile(path, 'utf8')) as NativeCommandReceipt
    if (receipt.schemaVersion !== 1 || receipt.backend !== job.backend || receipt.jobId !== job.id
      || receipt.requestDigest !== job.requestDigest || receipt.nonce !== job.nativeNonce
      || receipt.nativeResourceId !== job.nativeResourceId || receipt.closed !== true
      || !Number.isSafeInteger(receipt.closedAt) || receipt.closedAt < job.createdAt
      || !receipt.result || receipt.result.quiescent !== true
      || !['succeeded', 'failed', 'cancelled', 'timed-out', 'output-limit'].includes(receipt.result.status)
      || typeof receipt.result.stdout !== 'string' || typeof receipt.result.stderr !== 'string'
      || Buffer.byteLength(receipt.result.stdout) + Buffer.byteLength(receipt.result.stderr) > maxOutputBytes) {
      return undefined
    }
    return normalizeNativeReceiptResult(job.id, receipt.result)
  } catch {
    return undefined
  }
}

export async function reconcileNativeReceiptJob(
  ledger: IsolationLedger,
  authority: IsolationControllerAuthority,
  initial: IsolationJob,
  stateRoot: string,
  options: {
    signal?: AbortSignal
    maxOutputBytes?: number
    platform?: NodeJS.Platform
    uid?: number
  } = {},
): Promise<boolean> {
  const checkAuthority = (): void => {
    options.signal?.throwIfAborted()
    if (!ledger.hasController(authority)) throw new IsolationLedgerError('unauthorized', 'native recovery controller unavailable')
  }
  checkAuthority()
  if (initial.backend !== 'macos-seatbelt' && initial.backend !== 'windows-job') return false
  const job = ledger.get(initial.id)
  if (!job || (job.backend !== 'macos-seatbelt' && job.backend !== 'windows-job')) return false
  if (job.result?.quiescent) return true

  if (!job.dispatchAttempted) {
    checkAuthority()
    const settled = ledger.settle(job.id, job.version, {
      jobId: job.id,
      status: 'unknown',
      quiescent: true,
      stdout: '',
      stderr: '',
      artifacts: [],
      reason: 'native-recovery-before-dispatch',
    }, authority)
    await rm(join(stateRoot, 'workspaces', job.id), { recursive: true, force: true }).catch(() => {})
    return settled.result?.quiescent === true
  }

  const receipt = await readNativeReceipt(stateRoot, job, options.maxOutputBytes ?? 1_048_576, options.platform, options.uid)
  checkAuthority()
  if (receipt) {
    if (job.result?.quiescent) return true
    const settled = ledger.settleNativeReceipt(job.id, job.version, {
      requestDigest: job.requestDigest,
      nonce: job.nativeNonce!,
      nativeResourceId: job.nativeResourceId!,
    }, receipt, authority)
    await rm(join(stateRoot, 'workspaces', job.id), { recursive: true, force: true }).catch(() => {})
    return settled.result?.quiescent === true
  }

  if (job.status === 'prepared' || job.status === 'running') {
    ledger.settle(job.id, job.version, {
      jobId: job.id,
      status: 'unknown',
      quiescent: false,
      stdout: '',
      stderr: '',
      artifacts: [],
      reason: 'native-recovery-no-receipt',
    }, authority)
  }
  return false
}
