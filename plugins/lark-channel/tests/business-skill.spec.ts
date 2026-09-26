import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  installLarkBusinessSkill, reconcileLarkBusinessSkill, renderLarkBusinessSkill,
  type LarkBusinessSkillInput,
} from '../src/business-skill.ts'

const temporaryHomes: string[] = []

async function input(): Promise<LarkBusinessSkillInput> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-business-'))
  temporaryHomes.push(root)
  return {
    dshHome: join(root, 'dsh'),
    profile: 'owner',
    account: 'primary',
    cliCommand: join(root, 'bin', 'lark-cli'),
    cliProfile: 'owner',
    cliConfigDir: join(root, 'cli-config'),
    cliDataDir: join(root, 'cli-data'),
    ownerUserId: 'ou_owner123',
    appId: 'cli_0123456789abcdef',
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryHomes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('native Lark business skill installation', () => {
  test('writes valid frontmatter, dynamic official-skill guidance, and remains byte-for-byte idempotent', async () => {
    const setup = await input()
    const first = await installLarkBusinessSkill(setup)
    const before = await readFile(first.path, 'utf8')
    const statBefore = await lstat(first.path)
    const second = await installLarkBusinessSkill(setup)
    const statAfter = await lstat(first.path)
    expect(second).toEqual(first)
    expect(await readFile(first.path, 'utf8')).toBe(before)
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
    expect(first.path).toBe(join(setup.dshHome, 'skills', first.name, 'SKILL.md'))
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(before)
    expect(match).not.toBeNull()
    const metadata = parse(match?.[1] ?? '')
    expect(metadata.name).toBe(first.name)
    expect(metadata.description).toMatch(/documents.*sheets.*Base.*calendar.*tasks.*mail.*meetings.*contacts.*approvals/u)
    expect(metadata.description).toContain(`profile ${setup.profile}, Lark account ${setup.account}, app ${setup.appId}, and owner ${setup.ownerUserId}`)
    expect(metadata.metadata).toEqual({ appId: setup.appId, ownerUserId: setup.ownerUserId,
      profile: setup.profile, account: setup.account })
    expect(before).toContain('skills list')
    expect(before).toContain('skills read lark-shared')
    expect(before).toContain('skills read <relevant-skill>')
    expect(before).toContain('schema <service.resource.method>')
    expect(before).toContain('code 10')
    expect(before).toContain('already authorized')
    expect(before).toContain('Use it only when the current DSH profile, channel account, application, and owner all match this binding.')
    expect(before).toContain('--as user')
    expect(before).toContain('--as bot')
    for (const line of before.split('\n').filter(line => line.startsWith('    env '))) {
      expect(line).toContain(`LARKSUITE_CLI_CONFIG_DIR='${setup.cliConfigDir}'`)
      expect(line).toContain(`LARKSUITE_CLI_DATA_DIR='${setup.cliDataDir}'`)
      expect(line).toContain(`'${setup.cliCommand}' --profile '${setup.cliProfile}'`)
      for (const name of [
        'OPENCLAW_HOME', 'HERMES_HOME', 'LARK_CHANNEL', 'LARKSUITE_CLI_APP_ID',
        'LARKSUITE_CLI_APP_SECRET', 'LARKSUITE_CLI_BRAND', 'LARKSUITE_CLI_USER_ACCESS_TOKEN',
        'LARKSUITE_CLI_TENANT_ACCESS_TOKEN', 'LARKSUITE_CLI_TENANT_ACCESS_TOKEN_SOURCE',
        'LARKSUITE_CLI_DEFAULT_AS', 'LARKSUITE_CLI_PROFILE', 'LARKSUITE_CLI_STRICT_MODE',
        'LARKSUITE_CLI_AUTH_PROXY', 'LARKSUITE_CLI_PROXY_KEY',
      ]) expect(line).toContain(`-u ${name}`)
    }
    expect(before).toContain('Linux uses the private data directory')
    expect(before).toContain('macOS and Windows the CLI may use a system keychain')
  })

  test('properly shell-quotes adversarial absolute CLI and data paths', async () => {
    const setup = await input()
    const root = setup.dshHome.slice(0, -4)
    const command = join(root, 'bin', "lark'$(touch injected)'cli")
    setup.cliCommand = command
    setup.cliConfigDir = join(root, "cfg'$(touch injected)'dir")
    setup.cliDataDir = join(root, "data'$(touch injected)'dir")
    await mkdir(join(root, 'bin'))
    await writeFile(command, '#!/bin/sh\nprintf "%s\\n" "$*" "$LARKSUITE_CLI_CONFIG_DIR" "$LARKSUITE_CLI_DATA_DIR" "${LARKSUITE_CLI_APP_SECRET-unset}"\n')
    await chmod(command, 0o700)
    const { content } = renderLarkBusinessSkill(setup)
    const invocation = content.split('\n').find(line => line.startsWith('    env '))?.trim()
    expect(invocation).toBeDefined()
    const output = execFileSync('sh', ['-c', invocation!], {
      cwd: root, encoding: 'utf8', env: { ...process.env, LARKSUITE_CLI_APP_SECRET: 'must-not-leak' },
    }).trimEnd().split('\n')
    expect(output).toEqual([`--profile ${setup.cliProfile} skills list`, setup.cliConfigDir, setup.cliDataDir, 'unset'])
    await expect(lstat(join(root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('renders PowerShell commands with per-invocation cleanup and literal Windows paths', async () => {
    const setup = await input()
    const windows = {
      ...setup,
      platform: 'win32' as const,
      dshHome: 'C:\\Users\\Owner\\DSH Home',
      cliCommand: "C:\\Program Files\\Lark's $bin`v1\\lark-cli.exe",
      cliConfigDir: "C:\\Users\\Owner\\cfg's $value`literal",
      cliDataDir: "C:\\Users\\Owner\\data's $value`literal",
    }
    const { content } = renderLarkBusinessSkill(windows)
    const commands = content.split('\n').filter(line => line.startsWith('    Remove-Item Env:'))
    expect(commands).toHaveLength(3)
    for (const command of commands) {
      expect(command).not.toContain('env -u')
      expect(command).toContain('Remove-Item Env:OPENCLAW_HOME -ErrorAction SilentlyContinue;')
      expect(command).toContain('Remove-Item Env:LARKSUITE_CLI_APP_SECRET -ErrorAction SilentlyContinue;')
      expect(command).toContain("$env:LARKSUITE_CLI_CONFIG_DIR='C:\\Users\\Owner\\cfg''s $value`literal';")
      expect(command).toContain("$env:LARKSUITE_CLI_DATA_DIR='C:\\Users\\Owner\\data''s $value`literal';")
      expect(command).toContain("& 'C:\\Program Files\\Lark''s $bin`v1\\lark-cli.exe' --profile 'owner'")
    }
    expect(content).toContain('native skill and shell tools for this task (PowerShell on Windows)')
    expect(content).not.toContain('native skill and bash tools')
    expect(() => renderLarkBusinessSkill({ ...windows, cliCommand: 'relative\\lark-cli.exe' })).toThrow('absolute path')
  })

  test('preserves foreign content and refuses symlink escape', async () => {
    const setup = await input()
    const { name } = renderLarkBusinessSkill(setup)
    const skillDir = join(setup.dshHome, 'skills', name)
    await mkdir(skillDir, { recursive: true })
    const skillPath = join(skillDir, 'SKILL.md')
    await writeFile(skillPath, '---\nname: foreign\n---\nkeep me\n')
    await expect(installLarkBusinessSkill(setup)).rejects.toThrow('not managed')
    expect(await readFile(skillPath, 'utf8')).toBe('---\nname: foreign\n---\nkeep me\n')
    const other = await input()
    const { name: otherName } = renderLarkBusinessSkill(other)
    const outside = join(other.dshHome, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(join(other.dshHome, 'skills'), { recursive: true })
    await symlink(outside, join(other.dshHome, 'skills', otherName))
    await expect(installLarkBusinessSkill(other)).rejects.toThrow('symlink')
    await expect(lstat(join(outside, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects invalid identities, relative paths, and control characters before writing', async () => {
    const setup = await input()
    const invalid = [
      { ...setup, dshHome: 'relative/home' },
      { ...setup, cliCommand: 'lark-cli' },
      { ...setup, cliConfigDir: '../config' },
      { ...setup, cliDataDir: 'data' },
      { ...setup, cliCommand: '/tmp/lark\nmalicious' },
      { ...setup, profile: 'evil\n---' },
      { ...setup, cliProfile: 'evil; whoami' },
      { ...setup, ownerUserId: 'ou_owner`bad`' },
      { ...setup, appId: 'cli_invalid' },
    ]
    for (const value of invalid) await expect(installLarkBusinessSkill(value)).rejects.toThrow()
    await expect(lstat(setup.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('reconcile does not create directories and keeps the exact same binding unchanged', async () => {
    const setup = await input()
    const binding = { dshHome: setup.dshHome, profile: setup.profile, account: setup.account,
      appId: setup.appId, ownerUserId: setup.ownerUserId, enabled: true }
    await reconcileLarkBusinessSkill(binding)
    await reconcileLarkBusinessSkill({ ...binding, enabled: false })
    await expect(lstat(setup.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
    const installed = await installLarkBusinessSkill(setup)
    const before = await readFile(installed.path, 'utf8')
    const mtime = (await lstat(installed.path)).mtimeMs
    await reconcileLarkBusinessSkill(binding)
    expect(await readFile(installed.path, 'utf8')).toBe(before)
    expect((await lstat(installed.path)).mtimeMs).toBe(mtime)
  })

  test.each([
    ['owner rotation', { ownerUserId: 'ou_new_owner' }],
    ['application rotation', { appId: 'cli_ffffffffffffffff' }],
    ['business opt-out', { enabled: false }],
  ] as const)('%s removes only the managed skill and allows reinstallation', async (_label, change) => {
    const setup = await input()
    const installed = await installLarkBusinessSkill(setup)
    const sidecar = join(setup.dshHome, 'skills', installed.name, 'keep.txt')
    await writeFile(sidecar, 'keep me')
    const binding = { dshHome: setup.dshHome, profile: setup.profile, account: setup.account,
      appId: setup.appId, ownerUserId: setup.ownerUserId, enabled: true, ...change }
    await reconcileLarkBusinessSkill(binding)
    await expect(lstat(installed.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(sidecar, 'utf8')).toBe('keep me')
    // A different binding can be installed into the retained empty skill directory.
    await unlink(sidecar)
    await installLarkBusinessSkill({ ...setup, appId: binding.appId, ownerUserId: binding.ownerUserId })
  })

  test('removes a legacy managed skill with missing binding metadata', async () => {
    const setup = await input()
    const installed = await installLarkBusinessSkill(setup)
    const content = await readFile(installed.path, 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(content)
    expect(match).not.toBeNull()
    const frontmatter = parse(match?.[1] ?? '') as Record<string, unknown>
    delete frontmatter.metadata
    await writeFile(installed.path, content.replace(match?.[0] ?? '', `---\n${stringify(frontmatter).trimEnd()}\n---\n`))
    await reconcileLarkBusinessSkill({ dshHome: setup.dshHome, profile: setup.profile,
      account: setup.account, appId: setup.appId, ownerUserId: setup.ownerUserId, enabled: true })
    await expect(lstat(installed.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('account rotation removes only the previous managed hash and keeps the current binding', async () => {
    const setup = await input()
    const previous = await installLarkBusinessSkill(setup)
    const currentSetup = { ...setup, account: 'secondary' }
    const current = await installLarkBusinessSkill(currentSetup)
    const currentBytes = await readFile(current.path, 'utf8')
    const another = await installLarkBusinessSkill({ ...setup, account: 'unrelated' })
    await reconcileLarkBusinessSkill({ dshHome: setup.dshHome, profile: setup.profile,
      account: 'secondary', previousAccount: setup.account, appId: setup.appId,
      ownerUserId: setup.ownerUserId, enabled: true })
    await expect(lstat(previous.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(current.path, 'utf8')).toBe(currentBytes)
    expect(await readFile(another.path, 'utf8')).toContain('account **unrelated**')
  })

  test('reconcile refuses nonmanaged content and symlinked target without deleting either', async () => {
    const setup = await input()
    const binding = { dshHome: setup.dshHome, profile: setup.profile, account: setup.account,
      appId: setup.appId, ownerUserId: setup.ownerUserId, enabled: false }
    const { name } = renderLarkBusinessSkill(setup)
    const path = join(setup.dshHome, 'skills', name, 'SKILL.md')
    await mkdir(join(setup.dshHome, 'skills', name), { recursive: true })
    const foreign = '---\nname: foreign\n---\nkeep me\n'
    await writeFile(path, foreign)
    await expect(reconcileLarkBusinessSkill(binding)).rejects.toThrow('not managed')
    expect(await readFile(path, 'utf8')).toBe(foreign)
    const other = await input()
    const otherBinding = { ...binding, dshHome: other.dshHome }
    const otherName = renderLarkBusinessSkill(other).name
    const outside = join(other.dshHome, 'outside.md')
    await mkdir(join(other.dshHome, 'skills', otherName), { recursive: true })
    await writeFile(outside, foreign)
    await symlink(outside, join(other.dshHome, 'skills', otherName, 'SKILL.md'))
    await expect(reconcileLarkBusinessSkill(otherBinding)).rejects.toThrow('symlink')
    expect(await readFile(outside, 'utf8')).toBe(foreign)
  })
})
