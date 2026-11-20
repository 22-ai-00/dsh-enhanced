import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadOnlyWebToolSurface, sanitizeWebLearningEnv } from './web-fetch.ts'
import {
  executeWebLearningPlan,
  type WebLearningWorkerDeps,
  type WebLearningWorkerInput,
  type WebLearningWorkerOutput,
} from './web-learning-worker.ts'

const DEFAULT_MAX_STDIN_BYTES = 512 * 1024
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_TIMEOUT_BUFFER_MS = 250

export interface WebLearningRunner {
  run(input: WebLearningWorkerInput, signal?: AbortSignal): Promise<WebLearningWorkerOutput>
}

export interface SubprocessWebLearningRunnerOptions {
  readonly workerEntryPath?: string
  readonly tempBaseDir?: string
  readonly maxStdinBytes?: number
  readonly maxStdoutBytes?: number
  readonly killGraceMs?: number
  readonly runnerTimeoutBufferMs?: number
  readonly sourceEnv?: NodeJS.ProcessEnv
  readonly nodeOptions?: readonly string[]
}

export function resolveWebLearningWorkerEntryPath(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    return explicitPath
  }
  const selfPath = fileURLToPath(import.meta.url)
  if (selfPath.endsWith('.ts')) {
    return fileURLToPath(new URL('./web-learning-worker.ts', import.meta.url))
  }
  return fileURLToPath(new URL('./web-learning-worker.js', import.meta.url))
}

export function createInProcessWebLearningRunner(
  deps?: WebLearningWorkerDeps,
): WebLearningRunner {
  return {
    run(input: WebLearningWorkerInput, signal?: AbortSignal): Promise<WebLearningWorkerOutput> {
      const mergedDeps: WebLearningWorkerDeps = {
        ...deps,
        ...(signal === undefined ? {} : { signal }),
      }
      return executeWebLearningPlan(input, mergedDeps)
    },
  }
}

export function createSubprocessWebLearningRunner(
  options?: SubprocessWebLearningRunnerOptions,
): WebLearningRunner {
  const maxStdinBytes = options?.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES
  const maxStdoutBytes = options?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
  const killGraceMs = options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const timeoutBufferMs = options?.runnerTimeoutBufferMs ?? DEFAULT_TIMEOUT_BUFFER_MS
  const workerEntryPath = resolveWebLearningWorkerEntryPath(options?.workerEntryPath)

  return {
    async run(input: WebLearningWorkerInput, signal?: AbortSignal): Promise<WebLearningWorkerOutput> {
      assertReadOnlyWebToolSurface(input.toolSurface ?? [])

      if (signal?.aborted) {
        throw new Error('web-learning-runner: aborted before starting worker subprocess')
      }

      const serializedInput = JSON.stringify(input)
      if (Buffer.byteLength(serializedInput, 'utf8') > maxStdinBytes) {
        throw new Error(`web-learning-runner: worker input exceeds ${maxStdinBytes} bytes`)
      }

      const scratchDir = await mkdtemp(join(options?.tempBaseDir ?? tmpdir(), 'dsh-web-learn-'))
      try {
        await chmod(scratchDir, 0o700)

        if (signal?.aborted) {
          throw new Error('web-learning-runner: aborted before spawning worker subprocess')
        }

        const sanitizedEnv = sanitizeWebLearningEnv(options?.sourceEnv)
        const args = [...(options?.nodeOptions ?? []), workerEntryPath]

        return await new Promise<WebLearningWorkerOutput>((resolveOutput, rejectOutput) => {
          const child = spawn(process.execPath, args, {
            cwd: scratchDir,
            env: sanitizedEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })

          const stdoutChunks: Buffer[] = []
          const stderrChunks: Buffer[] = []
          let stdoutBytes = 0
          let stderrBytes = 0
          let exited = false
          let settled = false
          let terminating = false
          let terminationReason: 'timeout' | 'abort' | 'overflow' | undefined
          let killTimer: ReturnType<typeof setTimeout> | undefined
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined

          const cleanup = () => {
            if (deadlineTimer !== undefined) {
              clearTimeout(deadlineTimer)
              deadlineTimer = undefined
            }
            if (killTimer !== undefined) {
              clearTimeout(killTimer)
              killTimer = undefined
            }
            signal?.removeEventListener('abort', onAbort)
          }

          const finishWithError = (error: Error) => {
            if (settled) return
            settled = true
            cleanup()
            rejectOutput(error)
          }

          const terminateChild = (reason: 'timeout' | 'abort' | 'overflow') => {
            if (exited || terminating) return
            terminating = true
            terminationReason = reason
            try {
              child.kill('SIGTERM')
            } catch {
              // Ignore kill errors if child already exited.
            }
            killTimer = setTimeout(() => {
              if (!exited) {
                try {
                  child.kill('SIGKILL')
                } catch {
                  // Ignore SIGKILL error if child exited in the meantime.
                }
              }
            }, Math.max(1, killGraceMs))
            killTimer.unref?.()
          }

          const onAbort = () => {
            terminateChild('abort')
          }

          signal?.addEventListener('abort', onAbort, { once: true })

          const totalDeadlineMs = Math.max(1, input.budget.maxDurationMs + timeoutBufferMs)
          deadlineTimer = setTimeout(() => {
            terminateChild('timeout')
          }, totalDeadlineMs)
          deadlineTimer.unref?.()

          child.once('error', error => {
            exited = true
            finishWithError(error instanceof Error ? error : new Error(String(error)))
          })

          child.stdout.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (stdoutBytes + buf.byteLength > maxStdoutBytes) {
              terminateChild('overflow')
              return
            }
            stdoutBytes += buf.byteLength
            stdoutChunks.push(buf)
          })

          child.stderr.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            const remaining = DEFAULT_MAX_STDERR_BYTES - stderrBytes
            if (remaining <= 0) return
            const slice = buf.byteLength > remaining ? buf.subarray(0, remaining) : buf
            stderrBytes += slice.byteLength
            stderrChunks.push(slice)
          })

          child.once('close', (code, sig) => {
            exited = true
            const stdoutText = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8')
            const stderrText = Buffer.concat(stderrChunks, stderrBytes).toString('utf8')

            if (terminationReason === 'abort') {
              finishWithError(new Error('web-learning-runner: worker subprocess aborted'))
              return
            }
            if (terminationReason === 'timeout') {
              finishWithError(
                new Error(
                  `web-learning-runner: worker subprocess timed out after ${input.budget.maxDurationMs}ms${sig ? ` (${sig})` : ''}`,
                ),
              )
              return
            }
            if (terminationReason === 'overflow') {
              finishWithError(
                new Error(`web-learning-runner: worker stdout exceeded ${maxStdoutBytes} bytes`),
              )
              return
            }
            if (code !== 0 || sig !== null) {
              finishWithError(
                new Error(
                  `web-learning-runner: worker exited abnormally (code=${String(code)}, signal=${String(sig)})${stderrText ? `: ${stderrText.trim()}` : ''}`,
                ),
              )
              return
            }

            try {
              const parsed = JSON.parse(stdoutText) as WebLearningWorkerOutput
              if (settled) return
              settled = true
              cleanup()
              resolveOutput(parsed)
            } catch (error) {
              finishWithError(
                new Error(
                  `web-learning-runner: worker produced invalid JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
                ),
              )
            }
          })

          child.stdin.on('error', () => {
            // Child may exit or be killed before consuming stdin; close handler reports outcome.
          })
          child.stdin.end(serializedInput, 'utf8')
        })
      } finally {
        await rm(scratchDir, { recursive: true, force: true })
      }
    },
  }
}
