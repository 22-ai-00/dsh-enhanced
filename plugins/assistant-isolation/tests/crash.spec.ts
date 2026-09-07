import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const enabled = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0 && /^sha256:[0-9a-f]{64}$/u.test(image)
const dockerTests = enabled ? describe.sequential : describe.skip
const roots: string[] = []
const environment = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
const limits = { maxDurationMs: 45_000, maxInputBytes: 1024, maxOutputBytes: 4096, maxArtifactBytes: 1024, maxFiles: 8, memoryMiB: 64, pidsLimit: 32, cpus: 0.5 }

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const wait = async (predicate: () => Promise<boolean>, message: string, timeout = 10_000): Promise<void> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(message)
}

async function docker(config: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return await new Promise(resolve => {
    const child = spawn(dockerPath, ['--config', config, '-H', 'unix:///var/run/docker.sock', ...args], { shell: false, env: environment, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; let settled = false; let timer: NodeJS.Timeout | undefined
    const finish = (code: number | null, value: string): void => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); resolve({ code, stderr: value }) }
    child.stderr.on('data', chunk => { if (Buffer.byteLength(stderr) < 4096) stderr += Buffer.from(chunk).subarray(0, 4096 - Buffer.byteLength(stderr)).toString('utf8') })
    child.once('error', error => finish(null, `spawn:${error.message}`))
    child.once('exit', code => finish(code, stderr))
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(null, 'inspect-timeout') }, 2_000)
    timer.unref()
  })
}

dockerTests('runner supervisor Host-crash cleanup (opt in)', () => {
  it('survives a killed controller process group and removes its setsid container descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolation-crash-')); roots.push(root); await chmod(root, 0o700)
    const workspace = join(root, 'workspace'); const inspectConfig = await mkdtemp(join(root, 'docker-')); await chmod(inspectConfig, 0o700)
    await mkdir(workspace, { mode: 0o700 })
    const started = join(workspace, 'started'); const heartbeat = join(workspace, 'heartbeat')
    const name = `dsh-isolation-${randomUUID()}`
    const runner = new URL('../lib/runner.js', import.meta.url).href
    const script = `
      const [runner, image, dockerPath, workspace, started, heartbeat, name] = process.argv.slice(1)
      const { runIsolatedProcess } = await import(runner)
      const controller = new AbortController()
      await runIsolatedProcess({ jobId: '${randomUUID()}', containerName: name, image, dockerPath, workspacePath: workspace,
        command: "setsid sh -c 'echo started > /workspace/started; while :; do printf x >> /workspace/heartbeat; sleep 0.1; done' & wait",
        deadline: Date.now() + 45_000, limits: ${JSON.stringify(limits)}, signal: controller.signal, authorizeStart: () => true })
    `
    const controller = spawn(process.execPath, ['--input-type=module', '-e', script, runner, image, dockerPath, workspace, started, heartbeat, name], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment })
    let spawnError = ''
    controller.once('error', error => { spawnError = error.message })
    controller.stdout?.resume(); controller.stderr?.resume()
    try {
      await wait(async () => { try { return (await stat(started)).isFile() && (await stat(heartbeat)).isFile() } catch { return false } }, `controller did not start isolated workload${spawnError ? `: ${spawnError}` : ''}`)
      const before = await readFile(heartbeat, 'utf8')
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(await readFile(heartbeat, 'utf8')).not.toBe(before)
      expect(controller.pid).toBeGreaterThan(0)
      process.kill(-controller.pid!, 'SIGKILL')
      await wait(async () => { const result = await docker(inspectConfig, ['inspect', '--type', 'container', name]); return result.code !== 0 && /no such (object|container)/iu.test(result.stderr) }, `supervisor did not prove removal of ${name}`)
      const stopped = await readFile(heartbeat, 'utf8')
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(await readFile(heartbeat, 'utf8')).toBe(stopped)
    } finally {
      if (controller.pid !== undefined) { try { process.kill(-controller.pid, 'SIGKILL') } catch {} }
      await docker(inspectConfig, ['rm', '-f', name]).catch(() => undefined)
      await rm(inspectConfig, { recursive: true, force: true })
    }
  }, 60_000)
})
