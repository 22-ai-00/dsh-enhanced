import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { defaultLimits, type MacosIsolationConfig, type WindowsIsolationConfig } from './config.js'
import { canonicalAbsolutePath, isPathWithinOrEqual, isPrivateDirectoryStats, isPrivateFileStats } from './fs-ownership.js'
import { IsolationLedger, IsolationLedgerError, type IsolationControllerAuthority } from './ledger.js'
import { runMacosSeatbeltCommand, verifyMacosSandboxExec, type MacosSeatbeltAdapter } from './macos-command.js'
import { readNativeReceipt, reconcileNativeReceiptJob, writeNativeReceiptSync } from './native-job-recovery.js'
import { verifyNativeMacRuntime, type NativeMacRuntime } from './native-runtime.js'
import { defaultStoragePolicy, plannedStorageBytes } from './storage-policy.js'
import { observeStorage } from './storage.js'
import type { IsolationIdentity, IsolationJob, IsolationLimits, IsolationResult } from './types.js'
import { runWindowsJobProcess, verifyWindowsJobRunner, type WindowsJobAdapter } from './windows-job.js'
import { normalizeRequest } from './workspace.js'

export interface MacosSeatbeltVerifierRunnerConfig {
  backend: 'macos-seatbelt'
  stateRoot: string
  authorityDigest: string
  command: string
  expiresAt: number
  maxRuns: number
  maxTotalDurationMs: number
  maxDurationMs: number
  maxOutputBytes: number
  runtime?: NativeMacRuntime
  readOnlyRoots?: string[]
  sandboxExecPath?: string
  limits?: Partial<IsolationLimits>
  macos?: MacosIsolationConfig
  adapter?: MacosSeatbeltAdapter
}

export interface WindowsJobVerifierRunnerConfig {
  backend: 'windows-job'
  stateRoot: string
  authorityDigest: string
  command: string
  expiresAt: number
  maxRuns: number
  maxTotalDurationMs: number
  maxDurationMs: number
  maxOutputBytes: number
  limits?: Partial<IsolationLimits>
  windows?: WindowsIsolationConfig
  adapter?: WindowsJobAdapter
}

export type NativeCommandVerifierRunnerConfig = MacosSeatbeltVerifierRunnerConfig | WindowsJobVerifierRunnerConfig

const SHA = /^[0-9a-f]{64}$/u
const TTL = 30_000
const STARTUP_TIMEOUT = 31_000
const macosSupervisor = fileURLToPath(new URL('../runtime/native-macos-supervisor.mjs', import.meta.url))
const windowsSupervisor = fileURLToPath(new URL('../runtime/windows-job-supervisor.mjs', import.meta.url))
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unknown = (jobId: string, reason = 'verification-in-progress-no-replay'): IsolationResult => ({
  jobId,
  status: 'unknown',
  quiescent: false,
  stdout: '',
  stderr: '',
  artifacts: [],
  reason,
})

function bindNativeStateRoot(root: string, platform: NodeJS.Platform, uid: number | undefined): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 })
  const info = lstatSync(root)
  if (realpathSync(root) !== root || !isPrivateDirectoryStats(info, platform, uid)) {
    throw new Error('native verifier requires canonical private state root')
  }
  chmodSync(root, 0o700)
  const ledger = join(root, 'ledger.sqlite')
  if (existsSync(ledger)) {
    const dbInfo = lstatSync(ledger)
    if (!isPrivateFileStats(dbInfo, platform, uid)) throw new Error('invalid native verifier ledger')
  }
}

export class NativeCommandVerifierRunner {
  readonly #input: NativeCommandVerifierRunnerConfig
  readonly #limits: IsolationLimits
  readonly #identity: IsolationIdentity
  readonly #ledger: IsolationLedger
  readonly #abort = new AbortController()
  readonly #pending = new Map<string, Promise<IsolationResult>>()
  readonly #calls = new Set<Promise<IsolationResult>>()
  readonly #ready: Promise<void>
  #controller: IsolationControllerAuthority | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #sweep: Promise<void> | undefined
  #recoveryCursor = ''
  #active = true
  #closePromise: Promise<void> | undefined

  constructor(
    input: NativeCommandVerifierRunnerConfig,
    options: { platform?: NodeJS.Platform; uid?: number; allowHostPaths?: boolean } = {},
  ) {
    if (!input || (input.backend !== 'macos-seatbelt' && input.backend !== 'windows-job')) {
      throw new Error('invalid native verifier backend')
    }
    const hasAdapter = input.adapter !== undefined
    const targetPlatform: NodeJS.Platform = input.backend === 'windows-job' ? 'win32' : 'darwin'
    const platform = options.platform ?? (input.backend === 'macos-seatbelt' ? input.adapter?.platform : input.adapter?.platform) ?? process.platform
    const uid = options.uid ?? (input.backend === 'macos-seatbelt' ? input.adapter?.uid : undefined) ?? process.getuid?.()
    if (platform !== targetPlatform) {
      throw new Error(`assistant-isolation: ${input.backend} verifier requires ${targetPlatform}`)
    }
    if (input.backend === 'macos-seatbelt' && (typeof uid !== 'number' || uid === 0)) {
      throw new Error('assistant-isolation: macos-seatbelt verifier requires non-root macOS')
    }
    const pathPlatform = (hasAdapter || options.allowHostPaths) && process.platform !== targetPlatform ? process.platform : targetPlatform
    if (typeof input.stateRoot !== 'string' || !canonicalAbsolutePath(input.stateRoot, pathPlatform)
      || !SHA.test(input.authorityDigest) || typeof input.command !== 'string'
      || input.command.length < 1 || input.command.length > 16_384 || input.command.includes('\0')
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 10_000
      || !Number.isSafeInteger(input.maxTotalDurationMs) || input.maxTotalDurationMs < 1 || input.maxTotalDurationMs > 86_400_000
      || !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1 || input.maxDurationMs > 300_000
      || input.maxDurationMs > input.maxTotalDurationMs
      || !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 1_048_576) {
      throw new Error('invalid native verifier authority')
    }
    if (input.backend === 'macos-seatbelt' && input.runtime) {
      if (input.runtime.roots.some(root => isPathWithinOrEqual(input.stateRoot, root.path, pathPlatform) || isPathWithinOrEqual(root.path, input.stateRoot, pathPlatform))) {
        throw new Error('native verifier state overlaps runtime')
      }
    }

    this.#input = input
    this.#limits = {
      ...defaultLimits,
      ...input.limits,
      maxDurationMs: input.maxDurationMs,
      maxOutputBytes: input.maxOutputBytes,
    }

    bindNativeStateRoot(input.stateRoot, process.platform, process.getuid?.())
    this.#ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'), {
      schemaVersion: input.backend === 'windows-job' ? 10 : 9,
    })
    this.#identity = Object.freeze({
      principalDigest: input.authorityDigest,
      principalRecordId: `verification:${input.authorityDigest}`,
      principalVersion: 1,
      workspace: input.stateRoot,
      agentPreset: 'verification',
    })
    this.#ready = this.#start()
    void this.#ready.catch(() => { this.#active = false; this.#abort.abort() })
  }

  #authority(): IsolationControllerAuthority {
    if (!this.#controller || !this.#ledger.hasController(this.#controller)) {
      throw new Error('native verifier controller unavailable')
    }
    return this.#controller
  }

  #available(signal: AbortSignal): void {
    if (!this.#active || signal.aborted) throw new Error('native verifier unavailable')
    this.#authority()
  }

  async #start(): Promise<void> {
    const ownerId = randomUUID()
    const deadline = Date.now() + STARTUP_TIMEOUT
    for (;;) {
      this.#abort.signal.throwIfAborted()
      try {
        this.#controller = this.#ledger.claimController(ownerId, TTL)
        break
      } catch (error) {
        if (!(error instanceof IsolationLedgerError) || error.code !== 'unauthorized' || Date.now() >= deadline) throw error
        await pause(Math.min(250, deadline - Date.now()), undefined, { signal: this.#abort.signal })
      }
    }
    this.#abort.signal.throwIfAborted()
    this.#ledger.syncGrants([{
      ...this.#identity,
      id: 'verification',
      revision: 1,
      expiresAt: this.#input.expiresAt,
      maxRuns: this.#input.maxRuns,
      maxTotalDurationMs: this.#input.maxTotalDurationMs,
    }], this.#controller)

    this.#timer = setInterval(() => {
      try {
        if (this.#controller && this.#ledger.renewController(this.#controller, TTL)) {
          this.#scheduleRecovery()
          return
        }
      } catch {}
      this.#active = false
      this.#abort.abort()
    }, 5_000)
    this.#timer.unref()
    await this.#recover()
  }

  #scheduleRecovery(): void {
    if (!this.#active || this.#sweep) return
    const sweep = this.#ready.then(() => this.#recover())
    this.#sweep = sweep
    void sweep.catch(() => {}).finally(() => { if (this.#sweep === sweep) this.#sweep = undefined })
  }

  async #recover(): Promise<void> {
    let visited = 0
    while (visited < 16) {
      if (!this.#active) return
      const authority = this.#authority()
      const jobs = this.#ledger.recoverable(this.#recoveryCursor).slice(0, 16 - visited)
      if (jobs.length === 0) { this.#recoveryCursor = ''; return }
      for (const job of jobs) {
        if (!this.#active) return
        visited += 1
        this.#recoveryCursor = job.id
        if (this.#pending.has(job.id)) continue
        const uid = process.getuid?.()
        await reconcileNativeReceiptJob(this.#ledger, authority, job, this.#input.stateRoot, {
          signal: this.#abort.signal,
          maxOutputBytes: this.#input.maxOutputBytes,
          platform: process.platform,
          ...(uid !== undefined ? { uid } : {}),
        })
      }
    }
  }

  run = (key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> => {
    const call = this.#run(key, artifact, stdin, signal)
    this.#calls.add(call)
    void call.then(() => this.#calls.delete(call), () => this.#calls.delete(call))
    return call
  }

  async #run(key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> {
    await this.#ready
    this.#available(signal)
    if (typeof artifact !== 'string' || typeof stdin !== 'string') throw new Error('invalid native verifier input')
    const request = normalizeRequest({
      grantId: 'verification',
      idempotencyKey: key,
      command: this.#input.command,
      files: [{ path: 'artifact', content: artifact }, { path: 'input', content: stdin }],
      artifacts: [],
      timeoutMs: this.#input.maxDurationMs,
    }, this.#limits)

    const requestDigest = hash({
      request,
      backend: this.#input.backend,
      authority: this.#input.authorityDigest,
      ...(this.#input.backend === 'macos-seatbelt'
        ? { readOnlyRoots: this.#input.readOnlyRoots ?? this.#input.macos?.readOnlyRoots ?? [] }
        : { windows: this.#input.windows ?? null }),
    })

    const existing = this.#ledger.findJobByKey(this.#identity, `authority:${this.#input.authorityDigest}`, 'verification', key)
    if (existing) {
      if (existing.requestDigest !== requestDigest || existing.backend !== this.#input.backend) {
        throw new Error('verification idempotency key has a different request or contract')
      }
      const pending = this.#pending.get(existing.id)
      if (pending) return await pending
      const recovered = await readNativeReceipt(this.#input.stateRoot, existing, this.#input.maxOutputBytes, process.platform, process.getuid?.()).catch(() => undefined)
      if (recovered && !existing.result?.quiescent) {
        return this.#ledger.settleNativeReceipt(existing.id, existing.version, {
          requestDigest: existing.requestDigest,
          nonce: existing.nativeNonce!,
          nativeResourceId: existing.nativeResourceId!,
        }, recovered, this.#authority()).result!
      }
      return existing.result ?? unknown(existing.id)
    }

    const observation = await observeStorage(this.#input.stateRoot)
    this.#available(signal)
    const { job, created } = this.#ledger.prepare({
      backend: this.#input.backend,
      identity: this.#identity,
      sessionId: `authority:${this.#input.authorityDigest}`,
      grantId: 'verification',
      idempotencyKey: key,
      requestDigest,
      durationMs: this.#input.maxDurationMs,
      maxActiveJobs: 2,
      authority: this.#authority(),
      ...(this.#input.backend === 'windows-job'
        ? {
            resourceReservation: {
              memoryMiB: this.#limits.memoryMiB + this.#limits.workspaceMiB + 32,
              workspaceInodes: 0,
              maxMemoryMiB: 2048,
              maxWorkspaceInodes: 32_768,
            },
          }
        : {}),
      storageBudget: {
        maxStateBytes: defaultStoragePolicy.maxStateBytes,
        maxJobRecords: defaultStoragePolicy.maxJobRecords,
        reservedBytes: 3 * plannedStorageBytes(this.#limits),
        ...(observation ? { observation } : {}),
      },
    })
    if (!created) {
      if (job.requestDigest !== requestDigest || job.backend !== this.#input.backend) {
        throw new Error('verification idempotency key has a different request or contract')
      }
      return await this.#pending.get(job.id) ?? job.result ?? unknown(job.id)
    }

    const pending = this.#execute(job, artifact, stdin, AbortSignal.any([signal, this.#abort.signal]))
    this.#pending.set(job.id, pending)
    try { return await pending } finally { this.#pending.delete(job.id) }
  }

  async #execute(initial: IsolationJob, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> {
    let job = initial
    let dispatched = false
    const current = () => this.#active && !signal.aborted && this.#ledger.hasController(this.#authority()) && this.#ledger.usable(job.id)
    const workspaceRoot = join(this.#input.stateRoot, 'workspaces', job.id)
    const workspacePath = join(workspaceRoot, 'workspace')
    const tmpPath = join(workspaceRoot, 'tmp')

    try {
      await mkdir(workspacePath, { recursive: true, mode: 0o700 })
      await mkdir(tmpPath, { recursive: true, mode: 0o700 })
      await writeFile(join(workspacePath, 'artifact'), artifact, { flag: 'wx', mode: 0o600 })
      await writeFile(join(workspacePath, 'input'), stdin, { flag: 'wx', mode: 0o600 })

      if (this.#input.backend === 'macos-seatbelt') {
        if (this.#input.runtime && !this.#input.adapter) {
          await verifyNativeMacRuntime(this.#input.runtime)
        }
        const sandboxExecPath = this.#input.adapter?.sandboxExecPath ?? this.#input.sandboxExecPath ?? this.#input.macos?.sandboxExecPath
        if (!await verifyMacosSandboxExec(sandboxExecPath, this.#input.adapter)) {
          throw new Error('sandbox-exec unavailable')
        }
      } else {
        const psPath = this.#input.adapter?.powershellPath ?? this.#input.windows?.powershellPath
        if (!await verifyWindowsJobRunner(psPath, this.#input.adapter)) {
          throw new Error('windows-job runner unavailable')
        }
      }

      if (!current()) throw new Error('native authority changed')
      job = this.#ledger.markDispatched(job.id, job.version, this.#authority())
      dispatched = true

      const receipts = join(this.#input.stateRoot, 'receipts')
      await mkdir(receipts, { recursive: true, mode: 0o700 })
      const receiptInfo = await lstat(receipts)
      if (!isPrivateDirectoryStats(receiptInfo, process.platform, process.getuid?.())) {
        throw new Error('invalid native receipt directory')
      }
      if (!current()) throw new Error('native authority changed before start')

      if (this.#input.adapter) {
        job = this.#ledger.start(job.id, job.version, this.#authority())
        let outcome
        if (this.#input.backend === 'macos-seatbelt') {
          const sandboxExecPath = this.#input.sandboxExecPath ?? this.#input.macos?.sandboxExecPath
          outcome = await runMacosSeatbeltCommand({
            workspacePath,
            tmpPath,
            command: this.#input.command,
            readOnlyRoots: [
              ...(this.#input.readOnlyRoots ?? this.#input.macos?.readOnlyRoots ?? []),
              ...(this.#input.runtime ? this.#input.runtime.roots.map(r => r.path) : []),
            ],
            workspaceWritable: false,
            allowNetwork: false,
            stdin,
            deadline: job.deadline,
            maxOutputBytes: this.#input.maxOutputBytes,
            ...(sandboxExecPath !== undefined ? { sandboxExecPath } : {}),
            signal,
          }, this.#input.adapter)
        } else {
          outcome = await runWindowsJobProcess({
            workspacePath,
            tmpPath,
            command: this.#input.command,
            ...(this.#input.windows?.shell !== undefined ? { shell: this.#input.windows.shell } : {}),
            ...(this.#input.windows?.shellPath !== undefined ? { shellPath: this.#input.windows.shellPath } : {}),
            ...(this.#input.windows?.powershellPath !== undefined ? { powershellPath: this.#input.windows.powershellPath } : {}),
            networkMode: 'none',
            stdin,
            deadline: job.deadline,
            maxOutputBytes: this.#input.maxOutputBytes,
            limits: {
              memoryMiB: this.#limits.memoryMiB,
              pidsLimit: this.#limits.pidsLimit,
              cpus: this.#limits.cpus,
            },
            signal,
          }, this.#input.adapter)
        }

        if (outcome.quiescent) {
          writeNativeReceiptSync(receipts, {
            schemaVersion: 1,
            backend: this.#input.backend,
            jobId: job.id,
            requestDigest: job.requestDigest,
            nonce: job.nativeNonce!,
            nativeResourceId: job.nativeResourceId!,
            closed: true,
            closedAt: Date.now(),
            result: { ...outcome, quiescent: true },
          }, process.platform, process.getuid?.())
        }
      } else {
        const supervisorPath = this.#input.backend === 'macos-seatbelt' ? macosSupervisor : windowsSupervisor
        const supervisorInput = this.#input.backend === 'macos-seatbelt'
          ? {
              workspacePath,
              tmpPath,
              command: this.#input.command,
              readOnlyRoots: [
                ...(this.#input.readOnlyRoots ?? this.#input.macos?.readOnlyRoots ?? []),
                ...(this.#input.runtime ? this.#input.runtime.roots.map(r => r.path) : []),
              ],
              workspaceWritable: false,
              allowNetwork: false,
              stdin,
              deadline: job.deadline,
              maxOutputBytes: this.#input.maxOutputBytes,
              sandboxExecPath: this.#input.sandboxExecPath ?? this.#input.macos?.sandboxExecPath,
            }
          : {
              workspacePath,
              tmpPath,
              command: this.#input.command,
              shell: this.#input.windows?.shell,
              shellPath: this.#input.windows?.shellPath,
              powershellPath: this.#input.windows?.powershellPath,
              networkMode: 'none' as const,
              stdin,
              deadline: job.deadline,
              maxOutputBytes: this.#input.maxOutputBytes,
              limits: {
                memoryMiB: this.#limits.memoryMiB,
                pidsLimit: this.#limits.pidsLimit,
                cpus: this.#limits.cpus,
              },
            }

        const child = fork(supervisorPath, [], {
          detached: true,
          cwd: this.#input.stateRoot,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        })
        try {
          job = this.#ledger.start(job.id, job.version, this.#authority())
        } catch (error) {
          child.disconnect()
          child.unref()
          throw error
        }
        await this.#waitSupervisor(child, job, receipts, supervisorInput, signal)
      }

      const settled = await readNativeReceipt(this.#input.stateRoot, job, this.#input.maxOutputBytes, process.platform, process.getuid?.())
      if (settled) {
        const saved = this.#ledger.settleNativeReceipt(job.id, job.version, {
          requestDigest: job.requestDigest,
          nonce: job.nativeNonce!,
          nativeResourceId: job.nativeResourceId!,
        }, settled, this.#authority()).result!
        await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
        return saved
      }
      throw new Error('native receipt unavailable')
    } catch {
      const result: IsolationResult = dispatched
        ? unknown(job.id, 'native-dispatch-unconfirmed')
        : { jobId: job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'native-preparation-failed' }
      try { this.#ledger.settle(job.id, job.version, result, this.#authority()) } catch {}
      if (!dispatched) await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
      return result
    }
  }

  async #waitSupervisor(
    child: ChildProcess,
    job: IsolationJob,
    receipts: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<'receipt' | 'unconfirmed'> {
    return await new Promise(resolveOutcome => {
      let done = false
      const finish = (value: 'receipt' | 'unconfirmed') => {
        if (done) return
        done = true
        clearTimeout(grace)
        signal.removeEventListener('abort', cancel)
        child.removeAllListeners('message')
        child.removeAllListeners('exit')
        child.removeAllListeners('error')
        if (child.connected) child.disconnect()
        child.unref()
        resolveOutcome(value)
      }
      const cancel = () => { if (child.connected) child.send({ kind: 'cancel' }) }
      const grace = setTimeout(() => finish('unconfirmed'), Math.max(1, job.deadline - Date.now()) + 8_000)
      signal.addEventListener('abort', cancel, { once: true })
      child.on('message', message => {
        if (message && typeof message === 'object' && 'kind' in message && message.kind === 'receipt') finish('receipt')
        else if (message && typeof message === 'object' && 'kind' in message && message.kind === 'unconfirmed') finish('unconfirmed')
      })
      child.on('exit', () => finish('unconfirmed'))
      child.on('error', () => finish('unconfirmed'))
      if (signal.aborted) cancel()
      child.send({
        kind: 'command',
        jobId: job.id,
        requestDigest: job.requestDigest,
        nonce: job.nativeNonce,
        nativeResourceId: job.nativeResourceId,
        receiptRoot: receipts,
        input,
      }, error => {
        if (error) finish('unconfirmed')
      })
    })
  }

  inspectQuiescence = async (key: string): Promise<'quiescent' | 'unknown'> => {
    await this.#ready
    const job = this.#ledger.findNativeVerifierJob(this.#input.authorityDigest, this.#input.stateRoot, key)
    if (!job) return 'unknown'
    return await readNativeReceipt(this.#input.stateRoot, job, this.#input.maxOutputBytes, process.platform, process.getuid?.())
      ? 'quiescent'
      : 'unknown'
  }

  close = async (): Promise<void> => {
    if (this.#closePromise) return await this.#closePromise
    this.#active = false
    this.#abort.abort()
    clearInterval(this.#timer)
    this.#closePromise = (async () => {
      await Promise.allSettled([this.#ready, this.#sweep, ...this.#calls])
      try { if (this.#controller) this.#ledger.releaseController(this.#controller) } finally { this.#ledger.close() }
    })()
    return await this.#closePromise
  }
}
