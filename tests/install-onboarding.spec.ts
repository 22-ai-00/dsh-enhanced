import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installerLibrary = join(repoRoot, 'scripts', 'install', 'common.sh')
const localInstaller = join(repoRoot, 'scripts', 'install', 'install-local.sh')
// Same rule as installers.spec.ts: never inherit a developer machine's TraeX,
// which would switch the model step to the agent route.
const pathWithoutTraex = (process.env.PATH ?? '').split(':').filter(directory => directory !== ''
  && !existsSync(join(directory, 'traex')) && !existsSync(join(directory, 'trae-cli'))).join(':')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-onboarding-'))
  temporaryRoots.push(root)
  return join(root, 'home')
}

function library(script: string, env: Record<string, string> = {}, input = '') {
  return spawnSync('/bin/bash', ['-c', `source ${JSON.stringify(installerLibrary)}; ${script}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    env: { PATH: pathWithoutTraex, ...env },
  })
}

function installer(args: readonly string[], dshHome: string, env: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [localInstaller, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: '',
    env: { PATH: pathWithoutTraex, DSH_HOME: dshHome, ...env },
  })
}

describe('guided onboarding helpers', () => {
  test('stored credential detection matches only a non-empty key line', async () => {
    const home = await temporaryHome()
    await mkdir(home, { recursive: true })
    const check = () => library(`dsh_enhanced_model_credential_stored ${JSON.stringify(home)} deepseek-official`).status
    expect(check()).toBe(1)
    await writeFile(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: \n', { mode: 0o600 })
    expect(check()).toBe(1)
    await writeFile(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-stored\n', { mode: 0o600 })
    expect(check()).toBe(0)
    expect(library(`dsh_enhanced_model_credential_stored ${JSON.stringify(home)} traex-agent`).status).toBe(0)
  })

  test('model plan keeps user routes and stored keys, configures only with a key source', async () => {
    const home = await temporaryHome()
    await mkdir(home, { recursive: true })
    const plan = (provider: string, interactive: string, env: Record<string, string> = {}) =>
      library(`dsh_enhanced_guided_model_plan ${JSON.stringify(home)} ${JSON.stringify(provider)} ${interactive}`, env).stdout
    expect(plan('openai-compatible', '1', { DEEPSEEK_API_KEY: 'sk-x' })).toBe('keep')
    expect(plan('unresolved', '1')).toBe('keep')
    expect(plan('deepseek-official', '0')).toBe('keep')
    expect(plan('deepseek-official', '1')).toBe('configure')
    expect(plan('', '0', { DEEPSEEK_API_KEY: 'sk-x' })).toBe('configure')
    expect(plan('deepseek-official', '0', { DSH_ENHANCED_MODEL_API_KEY: 'sk-x' })).toBe('configure')
    await writeFile(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-stored\n', { mode: 0o600 })
    expect(plan('deepseek-official', '1', { DEEPSEEK_API_KEY: 'sk-x' })).toBe('keep')
  })

  test('provider resolution never overwrites an unreadable existing profile', async () => {
    const home = await temporaryHome()
    const emptyPath = join(dirname(home), 'empty-bin')
    await mkdir(emptyPath, { recursive: true })
    const resolveProvider = () => library(
      `dsh_enhanced_guided_model_provider ${JSON.stringify(home)} web`,
      { PATH: `${emptyPath}:/usr/bin:/bin` },
    ).stdout
    expect(resolveProvider()).toBe('deepseek-official')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    expect(resolveProvider()).toBe('unresolved')
  })

  test('single onboarding question defaults to guided', () => {
    const choose = (input: string) => library('dsh_enhanced_choose_onboarding_mode', {}, input)
    expect(choose('\n').stdout).toBe('guided')
    expect(choose('1\n').stdout).toBe('guided')
    expect(choose('2\n').stdout).toBe('custom')
    expect(choose('x\n').status).toBe(2)
  })
})

describe('guided onboarding installer dry-run', () => {
  test('--yes stores an environment API key without echoing it', async () => {
    const home = await temporaryHome()
    const secret = 'sk-onboarding-secret-value'
    const result = installer(['--dry-run', '--yes', '--lark', 'skip'], home, { DEEPSEEK_API_KEY: secret })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('--provider deepseek-official --model deepseek-v4-flash --store-key')
    expect(result.stdout).toContain('.credentials.yaml（0600）')
    expect(result.stdout + result.stderr).not.toContain(secret)
  })

  test('--yes without a key source leaves the model step untouched', async () => {
    const home = await temporaryHome()
    const result = installer(['--dry-run', '--yes', '--lark', 'skip'], home)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('--store-key')
  })

  test('supervised install waits for the first owner DM unless disabled', async () => {
    const home = await temporaryHome()
    const waited = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure'], home)
    expect(waited.status, waited.stderr).toBe(0)
    expect(waited.stdout).toMatch(/dsh-rsi-setup --wait-owner-dm --profile web --dsh-home \S+ --timeout-seconds 600/)
    expect(waited.stdout).toContain('只有已绑定的 owner 可以操作和授权')
    expect(waited.stdout.indexOf('--wait-owner-dm')).toBeLessThan(waited.stdout.indexOf('install-owner'))

    const disabled = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure', '--owner-wait-seconds', '0'], home)
    expect(disabled.status, disabled.stderr).toBe(0)
    expect(disabled.stdout).not.toContain('--wait-owner-dm')
  })

  test('plugin preset is opt-in outside the guided prompt and runs before the final self-check', async () => {
    const home = await temporaryHome()
    const defaults = installer(['--dry-run', '--yes', '--lark', 'skip'], home)
    expect(defaults.status, defaults.stderr).toBe(0)
    expect(defaults.stdout).not.toContain('dsh-plugin-setup preset')
    expect(defaults.stdout).toContain('调整插件：')

    const applied = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure', '--plugin-preset', 'recommended'], home)
    expect(applied.status, applied.stderr).toBe(0)
    expect(applied.stdout).toMatch(/dsh-plugin-setup preset recommended --yes --dsh-home \S+ --profile web/)
    expect(applied.stdout).toContain('常驻服务：将重启以加载插件预设。')
    expect(applied.stdout.indexOf('dsh-plugin-setup preset')).toBeLessThan(applied.stdout.indexOf('最终 profile 自检'))

    const skipped = installer(['--dry-run', '--yes', '--lark', 'skip', '--plugin-preset', 'skip'], home)
    expect(skipped.status, skipped.stderr).toBe(0)
    expect(skipped.stdout).not.toContain('dsh-plugin-setup preset')

    const invalid = installer(['--dry-run', '--plugin-preset', 'Bad!'], home)
    expect(invalid.status).toBe(2)
    expect(invalid.stderr).toContain('--plugin-preset 只能是预设名')
  })

  test('plugin preset confirmation declines without a terminal', () => {
    expect(library('dsh_enhanced_confirm_plugin_preset', {}, '\n').status).toBe(1)
  })

  test('rejects an out-of-range owner wait', async () => {
    const home = await temporaryHome()
    for (const value of ['9999', '-1', 'abc', '01']) {
      const result = installer(['--dry-run', '--owner-wait-seconds', value], home)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--owner-wait-seconds 只能是 0 到 3600 的整数。')
    }
  })
})
