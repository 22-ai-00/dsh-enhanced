import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(root, 'scripts', 'install', 'install-local.sh')
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function home(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'dsh-autonomy-')); homes.push(value); return value }
function run(args: string[], dshHome: string) { return spawnSync('/bin/bash', [installer, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome } }) }
const image = `sha256:${'a'.repeat(64)}`

describe('autonomy installer scenario', () => {
  it('plans the isolated closure and setup before dump or activation', async () => {
    const dshHome = await home(); const workspace = join(dshHome, 'workspace')
    const result = run(['--dry-run', '--scenario', 'autonomy', '--workspace', workspace, '--isolation-image', image, '--isolation-max-runs', '7', '--isolation-lease-minutes', '30', '--isolation-runtime-minutes', '5', '--yes'], dshHome)
    expect(result.status, result.stderr).toBe(0)
    for (const slug of ['personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner', 'assistant-isolation', 'assistant-actions', 'credentials-keychain', 'assistant-evaluation', 'assistant-verifier']) expect(result.stdout).toContain(join(root, 'plugins', slug))
    const setup = `dsh-web-owner-setup --dsh-home ${dshHome} --profile web --workspace ${workspace} --preset standard --isolation-image ${image} --isolation-max-runs 7 --isolation-lease-ms 1800000 --isolation-runtime-ms 300000`
    expect(result.stdout).toContain(setup)
    expect(result.stdout.indexOf(setup)).toBeLessThan(result.stdout.indexOf('dsh --profile web --dump-config'))
    expect(result.stdout).toContain('凭据、外部目标验证与完整自治仍需单独配置')
    expect(result.stdout).not.toContain('dsh-lark-setup')
    const doctor = `dsh-autonomy-doctor --dsh-home ${dshHome} --profile web`
    expect(result.stdout).toContain(doctor)
    expect(result.stdout.indexOf(doctor)).toBeGreaterThan(result.stdout.indexOf('dsh --profile web --dump-config'))
  })

  it('rejects autonomy-only parameters, unsafe limits, lark, and agent tool changes', async () => {
    const dshHome = await home()
    expect(run(['--dry-run', '--scenario', 'web', '--isolation-max-runs', '20'], dshHome).status).toBe(2)
    expect(run(['--dry-run', '--scenario', 'autonomy'], dshHome).status).toBe(2)
    expect(run(['--dry-run', '--scenario', 'core', '--isolation-image', image], dshHome).status).toBe(2)
    expect(run(['--dry-run', '--scenario', 'autonomy', '--isolation-image', 'latest'], dshHome).status).toBe(2)
    expect(run(['--dry-run', '--scenario', 'autonomy', '--isolation-image', image, '--isolation-max-runs', '999999999999'], dshHome).status).toBe(2)
    expect(run(['--dry-run', '--scenario', 'autonomy', '--isolation-image', image, '--lark', 'configure'], dshHome).status).toBe(2)
    expect(run(['--dry-run', '--scenario', 'autonomy', '--isolation-image', image, '--agent-tools', 'allow'], dshHome).status).toBe(2)
  })

  it('runs installed isolation diagnostics without a second Host and propagates failed checks', async () => {
    const dshHome = await home(); const bin = join(dshHome, 'profiles/web/node_modules/.bin'); await mkdir(bin, { recursive: true })
    const executable = join(bin, 'dsh-autonomy-doctor'); const log = join(dshHome, 'calls')
    await writeFile(executable, '#!/bin/bash\nprintf "%s\\n" "$*" > "$DSH_HOME/calls"\nexit 7\n'); await chmod(executable, 0o755)
    const doctor = join(root, 'scripts/install/doctor.sh')
    const result = spawnSync('/bin/bash', [doctor, '--profile', 'web', '--require-isolation'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome } })
    expect(result.status).toBe(7)
    expect(await readFile(log, 'utf8')).toBe(`--dsh-home ${dshHome} --profile web\n`)
    for (const option of ['--preflight', '--require-service']) {
      expect(spawnSync('/bin/bash', [doctor, '--require-isolation', option], { env: { ...process.env, DSH_HOME: dshHome } }).status).toBe(2)
    }
    await rm(executable)
    const missing = spawnSync('/bin/bash', [doctor, '--require-isolation'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome } })
    expect(missing.status).toBe(1); expect(missing.stderr).toContain('不会重建或续期授权')
  })
})
