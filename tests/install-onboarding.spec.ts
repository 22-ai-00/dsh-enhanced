import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

  test('fresh supervised install auto-applies the learning assembly after owner setup', async () => {
    const home = await temporaryHome()
    const result = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure'], home)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('自治学习装配')
    const preset = result.stdout.indexOf('dsh-plugin-setup preset recommended --yes')
    const ownerInstall = result.stdout.indexOf('dsh-rsi-setup --install-owner')
    expect(ownerInstall).toBeGreaterThanOrEqual(0)
    expect(preset).toBeGreaterThan(ownerInstall)
    expect(result.stdout).toContain('--enable-ordinary-use-learning')
    expect(result.stdout).toContain('常驻服务：将重启以加载自治学习装配')

    const skipped = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure', '--plugin-preset', 'skip'], home)
    expect(skipped.status, skipped.stderr).toBe(0)
    expect(skipped.stdout).not.toContain('dsh-plugin-setup preset')
    expect(skipped.stdout).not.toContain('自治学习装配')

    // An existing profile keeps its explicit plugin configuration: the implicit
    // pass never rewrites an owner's decisions.
    const existing = await temporaryHome()
    await mkdir(join(existing, 'profiles', 'web'), { recursive: true })
    await writeFile(join(existing, 'profiles', 'web', 'package.json'), '{"name":"dsh-profile-web","type":"module","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
    const kept = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure'], existing)
    expect(kept.status, kept.stderr).toBe(0)
    expect(kept.stdout).toContain('现有 profile 保留显式插件配置')
    expect(kept.stdout).not.toContain('dsh-plugin-setup preset recommended --yes')
    expect(kept.stdout).not.toContain('--enable-ordinary-use-learning')
  })

  test('supervised learning assembly helper honors explicit, declined, dry-run and existing decisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-assembly-'))
    temporaryRoots.push(root)
    const home = join(root, 'home')
    const bin = join(home, 'profiles', 'web', 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    const log = join(root, 'calls.log')
    await writeFile(log, '')
    await writeFile(join(bin, 'dsh-plugin-setup'), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$ASSEMBLY_LOG"\n', { mode: 0o755 })
    // No real dsh on PATH: the helper's native Host branch is not under test here,
    // only which decisions it forwards to dsh-plugin-setup.
    const assembly = (args: string) => library(
      `ASSEMBLY_LOG=${JSON.stringify(log)} dsh_enhanced_apply_supervised_learning_assembly ${args}`,
      { PATH: '/usr/bin:/bin' },
    )
    const calls = async () => (await readFile(log, 'utf8')).trim()

    const fresh = assembly(`web ${JSON.stringify(home)} 0 auto 0 1`)
    expect(fresh.status, fresh.stderr).toBe(0)
    expect(await calls()).toBe(`preset recommended --yes --dsh-home ${home} --profile web`)
    expect(fresh.stdout).toContain('自治学习装配')

    await writeFile(log, '')
    const existing = assembly(`web ${JSON.stringify(home)} 0 auto 0 0`)
    expect(existing.status).toBe(2)
    expect(await calls()).toBe('')
    expect(existing.stdout).toContain('现有 profile 保留显式插件配置')

    for (const [requested, declined] of [['skip', '0'], ['recommended', '1']] as const) {
      const refused = assembly(`web ${JSON.stringify(home)} 0 ${requested} ${declined} 1`)
      expect(refused.status, `${requested}/${declined}`).toBe(2)
      expect(await calls()).toBe('')
    }

    await writeFile(log, '')
    const explicit = assembly(`web ${JSON.stringify(home)} 0 recommended 0 0`)
    expect(explicit.status, explicit.stderr).toBe(0)
    expect(await calls()).toBe(`preset recommended --yes --dsh-home ${home} --profile web`)

    await writeFile(log, '')
    const dryRun = assembly(`web ${JSON.stringify(home)} 1 auto 0 1`)
    expect(dryRun.status, dryRun.stderr).toBe(0)
    expect(await calls()).toBe('')
    expect(dryRun.stdout).toContain(`dsh-plugin-setup preset recommended --yes --dsh-home ${home} --profile web`)
  })

  test('plugin preset confirmation declines without a terminal', () => {
    expect(library('dsh_enhanced_confirm_plugin_preset', {}, '\n').status).toBe(1)
  })

  test('learning decision defaults stay explicit and deterministic', () => {
    const resolve = (...args: string[]) => library('dsh_enhanced_resolve_learning_decision ' + args.join(' '))
    expect(resolve('auto', 'supervised', '1', '0', '1').stdout).toBe('authorize')
    expect(resolve('auto', 'supervised', '0', '0', '1').stdout).toBe('preserve')
    expect(resolve('auto', 'lark', '1', '0', '1').stdout).toBe('skip')
    expect(resolve('auto', 'core', '1', '0', '0').stdout).toBe('skip')
    expect(resolve('skip', 'supervised', '1', '0', '0').stdout).toBe('skip')
    expect(resolve('authorize', 'supervised', '1', '0', '0').stdout).toBe('authorize')
    expect(resolve('bogus', 'supervised', '1', '0', '0').status).toBe(2)
    // No terminal: the guided question declines; callers fall back to the stated default.
    expect(library('dsh_enhanced_confirm_ordinary_use_learning', {}, '\n').status).toBe(1)
  })

  test('install intent is private, schema-checked and reusable', async () => {
    // A missing parent Home is created 0700; mkdir -p alone would leave the
    // caller umask (typically 0755) on the Home the marker lives in.
    const home = join(await temporaryHome(), 'nested', 'home')
    const written = library('dsh_enhanced_write_install_intent ' + JSON.stringify(home) + ' supervised skip auto-skip')
    expect(written.status, written.stderr).toBe(0)
    const intentPath = join(home, '.dsh-enhanced', 'install-intent.json')
    const intent = JSON.parse(await readFile(intentPath, 'utf8')) as Record<string, unknown>
    expect(intent).toMatchObject({ schemaVersion: 1, scenario: 'supervised', learning: 'skip', pluginPreset: 'auto-skip' })
    expect(Number.isSafeInteger(intent.at)).toBe(true)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    expect((await stat(join(home, '.dsh-enhanced'))).mode & 0o777).toBe(0o700)
    expect((await stat(intentPath)).mode & 0o777).toBe(0o600)
    const read = library('dsh_enhanced_read_install_intent ' + JSON.stringify(home))
    expect(read.status).toBe(0)
    expect(read.stdout.trim().split(' ')).toEqual(['supervised', 'skip', 'auto-skip', String(intent.at)])
    // Invalid markers are rejected instead of being treated as the recorded decision.
    await writeFile(intentPath, 'not-json\n')
    expect(library('dsh_enhanced_read_install_intent ' + JSON.stringify(home)).status).toBe(2)
    const missing = await temporaryHome()
    expect(library('dsh_enhanced_read_install_intent ' + JSON.stringify(missing)).status).toBe(1)
    // An existing Home keeps the permissions it already has.
    const existing = await temporaryHome()
    await mkdir(existing, { recursive: true })
    await chmod(existing, 0o755)
    expect(library('dsh_enhanced_write_install_intent ' + JSON.stringify(existing) + ' supervised authorize recommended').status).toBe(0)
    expect((await stat(existing)).mode & 0o777).toBe(0o755)
  })

  test('learning authorization is explicit on the owner setup and skip forwards its own flag', async () => {
    const authorized = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure'], await temporaryHome())
    expect(authorized.status, authorized.stderr).toBe(0)
    expect(authorized.stdout).toContain('学习授权：已授权普通使用与记忆学习')
    expect(authorized.stdout).toContain('--enable-ordinary-use-learning')
    expect(authorized.stdout).not.toContain('--skip-memory-learning')

    const skippedHome = await temporaryHome()
    const skipped = installer(['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure', '--learning', 'skip'], skippedHome)
    expect(skipped.status, skipped.stderr).toBe(0)
    expect(skipped.stdout).toContain('学习授权：已跳过')
    expect(skipped.stdout).toContain('--skip-memory-learning')
    // The declined owner setup is never invoked with the learning authorization.
    expect(skipped.stdout).not.toContain('--enable-ordinary-use-learning')
    // Dry-run plans the decision but must not persist the marker.
    expect(existsSync(join(skippedHome, '.dsh-enhanced'))).toBe(false)

    const invalid = installer(['--dry-run', '--yes', '--lark', 'skip', '--learning', 'bogus'], await temporaryHome())
    expect(invalid.status).toBe(2)
    expect(invalid.stderr).toContain('--learning 只能是 authorize 或 skip')
    for (const decision of ['authorize', 'skip']) {
      const nonSupervised = installer(['--dry-run', '--yes', '--scenario', 'lark', '--lark', 'configure', '--learning', decision], await temporaryHome())
      expect(nonSupervised.status, decision).toBe(2)
      expect(nonSupervised.stderr).toContain('仅适用于 supervised 安装')
    }
  })

  test('persisted install intent is replayed by retries instead of the profile directory', async () => {
    const profileManifest = '{"name":"dsh-profile-web","type":"module","dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n'
    const seed = async (learning: 'authorize' | 'skip' | null, withProfile: boolean, preset = 'auto') => {
      const home = await temporaryHome()
      if (withProfile) {
        await mkdir(join(home, 'profiles', 'web'), { recursive: true })
        await writeFile(join(home, 'profiles', 'web', 'package.json'), profileManifest)
      }
      if (learning !== null) {
        await mkdir(join(home, '.dsh-enhanced'), { recursive: true, mode: 0o700 })
        await writeFile(join(home, '.dsh-enhanced', 'install-intent.json'),
          '{"schemaVersion":1,"scenario":"supervised","learning":"' + learning + '","pluginPreset":"' + preset + '","at":1794400000}\n', { mode: 0o600 })
      }
      return home
    }
    const run = (home: string, extra: string[] = []) => installer(
      ['--dry-run', '--yes', '--scenario', 'supervised', '--lark', 'configure', ...extra], home)

    // A recorded skip survives a profile that already exists: the marker, not
    // package.json freshness, owns the learning decision.
    const skipHome = await seed('skip', true)
    const skipRetry = run(skipHome)
    expect(skipRetry.status, skipRetry.stderr).toBe(0)
    expect(skipRetry.stdout).toContain('沿用已记录的学习决策（skip）')
    expect(skipRetry.stdout).toContain('--skip-memory-learning')
    expect(skipRetry.stdout).not.toContain('--enable-ordinary-use-learning')

    // A recorded authorize is replayed for a partial install even though the
    // profile directory already exists, so the grant is issued exactly once.
    const authorizeRetry = run(await seed('authorize', true))
    expect(authorizeRetry.status, authorizeRetry.stderr).toBe(0)
    expect(authorizeRetry.stdout).toContain('沿用已记录的学习决策（authorize）')
    expect(authorizeRetry.stdout).toContain('--enable-ordinary-use-learning')
    expect(authorizeRetry.stdout).not.toContain('--skip-memory-learning')

    // An explicit decision cannot rewrite the recorded one (skip never becomes
    // authorize) and the conflict fails before any mutation.
    const conflict = run(skipHome, ['--learning', 'authorize'])
    expect(conflict.status).toBe(2)
    expect(conflict.stderr).toContain('与已记录的安装决策（skip）冲突')

    // An existing profile without a marker keeps its stored decision untouched.
    const preserve = run(await seed(null, true))
    expect(preserve.status, preserve.stderr).toBe(0)
    expect(preserve.stdout).toContain('保留已记录的学习授权状态')
    expect(preserve.stdout).not.toContain('--enable-ordinary-use-learning')
    expect(preserve.stdout).not.toContain('--skip-memory-learning')

    // An existing installation without a marker rejects any new explicit
    // decision instead of silently ignoring it: authorize cannot expand, and a
    // skip that cannot drop existing grants must not record a lying marker or
    // forward a flag that would issue the opposite grant on an old profile.
    for (const decision of ['authorize', 'skip']) {
      const home = await seed(null, true)
      const rejected = run(home, ['--learning', decision])
      expect(rejected.status, decision).toBe(2)
      expect(rejected.stderr).toContain('既有安装不接受新的学习决策')
      expect(rejected.stdout).not.toContain('dsh-rsi-setup --install-owner')
      expect(existsSync(join(home, '.dsh-enhanced'))).toBe(false)
    }

    // The resolved guided/explicit preset decision is persisted, so a retry may
    // pass the same explicit preset without a spurious conflict.
    const guidedPresetRetry = run(await seed('authorize', false, 'recommended'), ['--plugin-preset', 'recommended'])
    expect(guidedPresetRetry.status, guidedPresetRetry.stderr).toBe(0)
    expect(guidedPresetRetry.stdout).toContain('dsh-plugin-setup preset recommended')
    expect(guidedPresetRetry.stdout).toContain('--enable-ordinary-use-learning')
    // An implicit marker can be replaced by an explicit retry decision.
    const implicitOverride = run(await seed('skip', false, 'auto-skip'), ['--plugin-preset', 'recommended'])
    expect(implicitOverride.status, implicitOverride.stderr).toBe(0)
    expect(implicitOverride.stdout).toContain('dsh-plugin-setup preset recommended')
    expect(implicitOverride.stdout).toContain('--skip-memory-learning')

    // A corrupt marker fails closed instead of guessing a fresh decision (which
    // could silently authorize learning).
    for (const withProfile of [false, true]) {
      const corrupt = await seed(null, withProfile)
      await mkdir(join(corrupt, '.dsh-enhanced'), { recursive: true, mode: 0o700 })
      await writeFile(join(corrupt, '.dsh-enhanced', 'install-intent.json'), '{}\n', { mode: 0o600 })
      const rejectedMarker = run(corrupt)
      expect(rejectedMarker.status, String(withProfile)).toBe(2)
      expect(rejectedMarker.stderr).toContain('无法通过校验')
      expect(rejectedMarker.stdout).not.toContain('--enable-ordinary-use-learning')
    }
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
