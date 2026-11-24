import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { loadDshRsiCli, loadPluginSetup } from './packages.ts'
import { repoRoot, resolveTmpBase } from './workspace.ts'

export interface CliExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface InProcessSetupResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

let cliIoMutex: Promise<void> = Promise.resolve()

async function withCliIoMutex<T>(task: () => Promise<T>): Promise<T> {
  const previous = cliIoMutex
  let release!: () => void
  cliIoMutex = new Promise<void>(resolvePromise => {
    release = resolvePromise
  })
  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

export async function runDshRsiInProcess(
  args: readonly string[],
  envOverrides: Record<string, string | undefined> = {},
  deps: Record<string, unknown> = {},
): Promise<CliExecResult> {
  return withCliIoMutex(async () => {
    const cli = await loadDshRsiCli()
    const main = cli.main as (
      argv: readonly string[],
      env?: NodeJS.ProcessEnv,
      deps?: Record<string, unknown>,
    ) => Promise<number>
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const origStdoutWrite = process.stdout.write.bind(process.stdout)
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      const tmpBase = await resolveTmpBase()
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TMPDIR: tmpBase,
        ...envOverrides,
      }
      const code = await main(args, env, {
        ...deps,
        stdout: (line: string) => stdoutChunks.push(line.endsWith('\n') ? line : `${line}\n`),
        stderr: (line: string) => stderrChunks.push(line.endsWith('\n') ? line : `${line}\n`),
      })
      return {
        exitCode: Number.isInteger(code) ? code : 0,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      }
    } finally {
      process.stdout.write = origStdoutWrite
      process.stderr.write = origStderrWrite
    }
  })
}

export async function runPluginSetupInProcess(
  args: readonly string[],
  options: {
    dshHome?: string
    readDump?: (dshHome: string, profile: string) => Promise<unknown>
    dryRun?: boolean
  } = {},
): Promise<InProcessSetupResult> {
  const mod = await loadPluginSetup()
  const runPluginSetup = (mod as Record<string, unknown>).runPluginSetup as (
    argv: readonly string[],
    io: {
      write: (text: string) => void
      isTTY: boolean
    },
    setupOptions?: {
      readDump?: (dshHome: string, profile: string) => Promise<unknown>
      dryRun?: boolean
    },
  ) => Promise<void>

  const finalArgs = [...args]
  if (options.dshHome !== undefined && !finalArgs.includes('--dsh-home')) {
    finalArgs.push('--dsh-home', options.dshHome)
  }

  const stdout: string[] = []
  try {
    await runPluginSetup(
      finalArgs,
      {
        write: text => {
          stdout.push(text)
        },
        isTTY: false,
      },
      {
        ...(options.readDump === undefined ? {} : { readDump: options.readDump }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      },
    )
    return {
      exitCode: 0,
      stdout: stdout.join(''),
      stderr: '',
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: stdout.join(''),
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function runCommandProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    stdin?: string
  } = {},
): Promise<CliExecResult> {
  const tmpBase = await resolveTmpBase()
  const timeoutMs = options.timeoutMs ?? 12_000
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: tmpBase,
    ...options.env,
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', chunk => out.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.stderr.on('data', chunk => err.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.on('error', errObj => {
      clearTimeout(timer)
      rejectPromise(errObj)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) {
        rejectPromise(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`))
        return
      }
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

export function runNodeScript(
  scriptRelPath: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    stdin?: string
  } = {},
): Promise<CliExecResult> {
  const fullPath = scriptRelPath.startsWith('/') ? scriptRelPath : join(repoRoot, scriptRelPath)
  return runCommandProcess(process.execPath, [fullPath, ...args], options)
}

export function runBashCommand(
  bashArgs: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {},
): Promise<CliExecResult> {
  return runCommandProcess('/bin/bash', bashArgs, options)
}
