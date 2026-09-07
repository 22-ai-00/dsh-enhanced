import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runIsolatedProcess } from '../src/runner.ts'

// These tests intentionally require an already-present immutable image. They
// never pull an image and are skipped in ordinary unit-test and CI runs.
const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const dockerTests = /^sha256:[0-9a-f]{64}$/.test(image) ? describe.sequential : describe.skip
const workspaces: string[] = []

afterEach(async () => { await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const limits = {
  maxDurationMs: 30_000,
  maxInputBytes: 1024,
  maxOutputBytes: 4096,
  maxArtifactBytes: 1024,
  maxFiles: 8,
  memoryMiB: 64,
  pidsLimit: 32,
  cpus: 0.5,
}

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-isolation-test-'))
  await chmod(path, 0o700)
  workspaces.push(path)
  return path
}

async function run(command: string, options: { deadlineMs?: number, signal?: AbortSignal, outputBytes?: number } = {}) {
  const path = await workspace()
  await writeFile(join(path, 'input'), 'only-the-workspace-is-mounted', { mode: 0o600 })
  const controller = options.signal === undefined ? new AbortController() : undefined
  return await runIsolatedProcess({
    jobId: randomUUID(),
    containerName: `dsh-isolation-${randomUUID()}`,
    image,
    dockerPath,
    workspacePath: path,
    command,
    deadline: Date.now() + (options.deadlineMs ?? 30_000),
    limits: { ...limits, ...(options.outputBytes === undefined ? {} : { maxOutputBytes: options.outputBytes }) },
    signal: options.signal ?? controller!.signal,
    authorizeStart: vi.fn(() => true),
  })
}

dockerTests('Linux Docker isolation runner (opt in)', () => {
  test('runs only in the workspace with no Docker socket or external network', async () => {
    const result = await run('set -e; test -f /workspace/input && test ! -S /var/run/docker.sock && test ! -e /sys/class/net/eth0; printf ok; printf err >&2')
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0 })
    expect(result.stdout).toContain('ok')
    expect(result.stderr).toContain('err')
  }, 30_000)

  test('kills a process at the trusted absolute deadline', async () => {
    const result = await run('sleep 30', { deadlineMs: 1_000 })
    expect(result).toMatchObject({ status: 'timed-out', quiescent: true })
  }, 30_000)

  test('cancels a setsid descendant with its container', async () => {
    const controller = new AbortController()
    const pending = run("setsid sh -c 'sleep 30' & sleep 30", { signal: controller.signal })
    setTimeout(() => controller.abort(), 750).unref()
    const result = await pending
    expect(result).toMatchObject({ status: 'cancelled', quiescent: true })
  }, 30_000)

  test('stops and fails when combined attached output reaches its bound', async () => {
    const result = await run('i=0; while [ "$i" -lt 200 ]; do printf 0123456789; i=$((i + 1)); done', { outputBytes: 128 })
    expect(result).toMatchObject({ status: 'failed', quiescent: true, reason: 'output-limit-exceeded' })
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128)
  }, 30_000)
  test('does not expand malformed UTF-8 beyond the output byte limit', async () => {
    const result = await run("printf '\\377'", { outputBytes: 1 })
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0 })
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1)
  }, 30_000)

})
