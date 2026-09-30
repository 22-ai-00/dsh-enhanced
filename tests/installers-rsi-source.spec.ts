import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const common = join(repoRoot, 'scripts/install/common.sh')
const localInstaller = join(repoRoot, 'scripts/install/install-local.sh')
const temporaryRoots: string[] = []
const pathWithoutTraex = (process.env.PATH ?? '').split(':').filter(directory => directory !== ''
  && !existsSync(join(directory, 'traex')) && !existsSync(join(directory, 'trae-cli'))).join(':')

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-installer-'))
  temporaryRoots.push(root)
  const home = join(root, 'dsh home')
  const bin = join(home, 'profiles', 'web', 'node_modules', '.bin')
  const log = join(root, 'args.log')
  await mkdir(bin, { recursive: true })
  const setup = join(bin, 'dsh-rsi-setup')
  await writeFile(setup, '#!/bin/bash\nprintf "%s\\n" "$@" > "$RSI_ARGS_LOG"\nexit "${RSI_EXIT_CODE:-0}"\n')
  await chmod(setup, 0o755)
  return { root, home, setup, log }
}

function invokeHelper(home: string, mode: 'local' | 'npm', repository: string, dryRun: boolean, log: string, exitCode = 0) {
  return spawnSync('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_prepare_rsi_source "$@"', 'bash',
    common, 'web', home, mode, repository, dryRun ? '1' : '0'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, RSI_ARGS_LOG: log, RSI_EXIT_CODE: String(exitCode) },
  })
}

describe('supervised RSI source and build preparation', () => {
  it('forwards the canonical local source and uses the installed profile CLI', async () => {
    const { home, log } = await fixture()
    const result = invokeHelper(home, 'local', repoRoot, false, log)
    expect(result.status, result.stderr).toBe(0)
    expect((await readFile(log, 'utf8')).trimEnd().split('\n')).toEqual([
      '--prepare-build', '--optional-build', '--profile', 'web', '--dsh-home', home, '--source-repository', repoRoot,
    ])
    expect(result.stdout).toContain('准备自迭代源码和构建环境')
  })

  it('omits a local repository for npm and propagates preparation failures', async () => {
    const { home, log } = await fixture()
    const result = invokeHelper(home, 'npm', repoRoot, false, log)
    expect(result.status, result.stderr).toBe(0)
    expect((await readFile(log, 'utf8')).trimEnd().split('\n')).toEqual([
      '--prepare-build', '--optional-build', '--profile', 'web', '--dsh-home', home,
    ])
    const failed = invokeHelper(home, 'npm', repoRoot, false, log, 17)
    expect(failed.status).toBe(17)
    expect(failed.stderr).toContain('自迭代源码和构建环境准备失败，安装已停止')
    await rm(join(home, 'profiles', 'web', 'node_modules', '.bin', 'dsh-rsi-setup'))
    const missing = invokeHelper(home, 'npm', repoRoot, false, log)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('找不到安装后的 dsh-rsi-setup')
  })

  it('propagates the owner installer not-ready status instead of reporting success', async () => {
    const {home,log} = await fixture()
    const result = spawnSync('/bin/bash',['-c','source "$1"; shift; dsh_enhanced_install_rsi_owner "$@"','bash',
      common,'web',home,'local',repoRoot,'0'],{cwd:repoRoot,encoding:'utf8',env:{...process.env,RSI_ARGS_LOG:log,RSI_EXIT_CODE:'3'}})
    expect(result.status).toBe(3)
    expect((await readFile(log,'utf8')).trimEnd().split('\n')).toEqual([
      '--install-owner','--profile','web','--dsh-home',home,'--source-repository',repoRoot,
    ])
    expect(result.stdout).not.toContain('安装流程完成')
  })

  it('forwards an explicit existing-automation acknowledgement only to owner setup', async () => {
    const { home, log } = await fixture()
    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_install_rsi_owner "$@"', 'bash',
      common, 'web', home, 'npm', repoRoot, '0', '1'], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, RSI_ARGS_LOG: log },
    })
    expect(result.status, result.stderr).toBe(0)
    expect((await readFile(log, 'utf8')).trimEnd().split('\n')).toEqual([
      '--install-owner', '--profile', 'web', '--dsh-home', home, '--ack-existing-automations',
    ])
  })

  it('prints the new supervised cohort and preparation between install and final setup without writing source', async () => {
    const { home } = await fixture()
    const result = spawnSync('/bin/bash', [localInstaller, '--dry-run', '--scenario', 'supervised',
      '--lark', 'configure', '--yes'], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DSH_HOME: home, PATH: pathWithoutTraex },
    })
    expect(result.status, result.stderr).toBe(0)
    for (const slug of ['assistant-skills', 'assistant-verifier', 'assistant-growth-driver', 'assistant-memory-learning']) {
      expect(result.stdout).toContain(join(repoRoot, 'plugins', slug))
    }
    const install = result.stdout.indexOf('dsh-rsi-setup.js --install-local-cohort')
    const source = result.stdout.indexOf('dsh-rsi-setup --prepare-build --optional-build')
    expect(install).toBeGreaterThanOrEqual(0)
    expect(result.stdout).toContain('--bundle assistant-growth-driver')
    expect(result.stdout).toContain('--bundle assistant-memory-learning')
    expect(result.stdout).not.toContain('--bundle personal-memory')
    expect(result.stdout).not.toContain('dsh plugin --profile web add')
    expect(source).toBeGreaterThan(install)
    expect(result.stdout).not.toContain('dsh-supervised-growth-setup')
    expect(result.stdout).toContain(`--source-repository ${repoRoot}`)
    expect(await readdir(home)).toEqual(['profiles'])

    const ownerInstall = result.stdout.indexOf('dsh-rsi-setup --install-owner')
    expect(ownerInstall).toBeGreaterThan(source)
    expect(ownerInstall).toBeGreaterThan(result.stdout.indexOf('doctor：将验证'))

    const standard = spawnSync('/bin/bash', [localInstaller, '--dry-run', '--scenario', 'lark', '--lark', 'configure'], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DSH_HOME: home, PATH: pathWithoutTraex },
    })
    expect(standard.status, standard.stderr).toBe(0)
    expect(standard.stdout).not.toContain('dsh-rsi-setup --prepare-build')
    expect(standard.stdout).not.toContain('dsh-rsi-setup --install-owner')
  })
})
