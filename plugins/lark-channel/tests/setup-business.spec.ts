import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { renderLarkBusinessSkill } from '../src/business-skill.ts'
import {
  setupLarkBusinessTools,
  type BusinessCliRequest,
  type BusinessCliResult,
  type LarkBusinessSetupInput,
} from '../src/setup-business.ts'

const temporaryHomes: string[] = []
const authorizationUrl = 'https://accounts.feishu.cn/device/authorize'
const deviceCode = 'test-device-code'

async function setupInput(): Promise<{ input: LarkBusinessSetupInput; callbacks: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-business-setup-'))
  temporaryHomes.push(root)
  const callbacks: string[] = []
  return {
    input: {
      dshHome: join(root, 'dsh'), profile: 'owner', account: 'primary',
      appId: 'cli_0123456789abcdef', appSecret: 'unique-secret-never-in-argv-or-env',
      domain: 'feishu', ownerUserId: 'ou_owner123',
      cli: { command: join(root, 'bin', 'lark-cli'), version: '1.0.96' },
      timeoutMs: 60_000,
      onAuthorization: url => { callbacks.push(url) },
    },
    callbacks,
  }
}

interface FakeResponses {
  startCode?: number
  pollCode?: number
  startStderr?: string
  pollStderr?: string
  statusAppId?: string
  statusOpenId?: string
  serverOpenId?: string
  rejectRevision?: string
}

function fakeCli(input: LarkBusinessSetupInput) {
  const requests: BusinessCliRequest[] = []
  const events: string[] = []
  const responses: FakeResponses = {}
  const run = async (request: BusinessCliRequest): Promise<BusinessCliResult> => {
    requests.push(request)
    const args = request.args.slice(2)
    const revision = dirname(request.env.LARKSUITE_CLI_CONFIG_DIR ?? '').split('/').at(-1)
    if (args[0] === 'config' && args[1] === 'init') {
      events.push('config')
      return { code: 0, stdout: '' }
    }
    if (args[0] === 'auth' && args[1] === 'login' && args.includes('--no-wait')) {
      events.push('login-start')
      return { code: responses.startCode ?? 0,
        stdout: JSON.stringify({ verification_url: authorizationUrl, device_code: deviceCode }),
        ...(responses.startStderr === undefined ? {} : { stderr: responses.startStderr }) }
    }
    if (args[0] === 'auth' && args[1] === 'login' && args.includes('--device-code')) {
      events.push('login-poll')
      return { code: responses.pollCode ?? 0, stdout: responses.pollCode
        ? JSON.stringify({ ok: false, missing_domains: ['docs'] }) : '{}',
        ...(responses.pollStderr === undefined ? {} : { stderr: responses.pollStderr }) }
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      events.push('status')
      const badOld = revision === responses.rejectRevision
      return { code: 0, stdout: JSON.stringify({
        appId: badOld ? 'cli_ffffffffffffffff' : (responses.statusAppId ?? input.appId),
        identity: 'user', verified: true,
        identities: { user: {
          openId: responses.statusOpenId ?? input.ownerUserId,
          available: true, verified: true, status: 'ready',
        } },
      }) }
    }
    if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/authen/v1/user_info') {
      events.push('server-userinfo')
      return { code: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data: {
        open_id: responses.serverOpenId ?? input.ownerUserId,
      } }) }
    }
    throw new Error(`unexpected fake CLI invocation: ${args.join(' ')}`)
  }
  return { run, requests, events, responses }
}

async function activePath(input: LarkBusinessSetupInput): Promise<string> {
  const businessRoot = join(input.dshHome, 'lark-business')
  const ids = await readdir(businessRoot)
  expect(ids).toHaveLength(1)
  return join(businessRoot, ids[0]!, 'active.json')
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Lark business tools owner authorization', () => {
  test('only publishes native skill and active binding after all-domain login and server owner readback', async () => {
    const { input, callbacks } = await setupInput()
    const cli = fakeCli(input)
    input.onAuthorization = url => { callbacks.push(url); cli.events.push('authorization-callback') }
    const inherited = {
      OPENCLAW_HOME: process.env.OPENCLAW_HOME,
      OPENCLAW_CLI: process.env.OPENCLAW_CLI,
      HERMES_HOME: process.env.HERMES_HOME,
      LARK_CHANNEL: process.env.LARK_CHANNEL,
      LARKSUITE_CLI_APP_SECRET: process.env.LARKSUITE_CLI_APP_SECRET,
      LARKSUITE_CLI_USER_ACCESS_TOKEN: process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,
      LARKSUITE_CLI_PROFILE: process.env.LARKSUITE_CLI_PROFILE,
      LARKSUITE_CLI_CONTENT_SAFETY_MODE: process.env.LARKSUITE_CLI_CONTENT_SAFETY_MODE,
    }
    for (const name of Object.keys(inherited)) process.env[name] = 'inherited-override-must-be-cleared'
    let result: Awaited<ReturnType<typeof setupLarkBusinessTools>>
    try { result = await setupLarkBusinessTools(input, { run: cli.run }) }
    finally {
      for (const [name, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    expect(result.reusedAuthorization).toBe(false)
    expect(callbacks).toEqual([authorizationUrl])
    expect(cli.events).toEqual(['config', 'login-start', 'authorization-callback', 'login-poll', 'status', 'server-userinfo'])
    expect(cli.requests.find(request => request.args.includes('--no-wait'))?.args)
      .toEqual(['--profile', 'dsh-owner', 'auth', 'login', '--domain', 'all', '--no-wait', '--json'])
    expect(cli.requests.find(request => request.args.includes('--device-code'))?.args)
      .toEqual(['--profile', 'dsh-owner', 'auth', 'login', '--device-code', deviceCode, '--json'])
    expect(cli.requests.at(-1)?.args).toEqual([
      '--profile', 'dsh-owner', 'api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user',
    ])
    expect(cli.requests.find(request => request.args.includes('--device-code'))?.timeoutMs).toBe(input.timeoutMs)
    const configDirs = new Set(cli.requests.map(request => request.env.LARKSUITE_CLI_CONFIG_DIR))
    const dataDirs = new Set(cli.requests.map(request => request.env.LARKSUITE_CLI_DATA_DIR))
    expect(configDirs.size).toBe(1)
    expect(dataDirs.size).toBe(1)
    const configDir = [...configDirs][0]!
    const dataDir = [...dataDirs][0]!
    expect(configDir).toMatch(/^.*\/lark-business\/[^/]+\/[^/]+\/config$/u)
    expect(dataDir).toBe(join(dirname(configDir), 'data'))
    for (const request of cli.requests) {
      expect(request.command).toBe(input.cli.command)
      expect(request.args.slice(0, 2)).toEqual(['--profile', 'dsh-owner'])
      expect(request.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER).toBe('1')
      expect(request.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER).toBe('1')
      for (const name of Object.keys(inherited)) {
        expect(request.env[name]).toBeUndefined()
      }
      expect(JSON.stringify(request.args)).not.toContain(input.appSecret)
      expect(JSON.stringify(request.env)).not.toContain(input.appSecret)
    }
    expect(cli.requests.filter(request => request.input !== undefined)).toHaveLength(1)
    expect(cli.requests[0]?.input).toBe(`${input.appSecret}\n`)
    const active = JSON.parse(await readFile(await activePath(input), 'utf8')) as Record<string, unknown>
    expect(active).toMatchObject({ schema: 1, appId: input.appId, ownerUserId: input.ownerUserId,
      domain: 'feishu', requestedDomains: 'all', cliVersion: input.cli.version })
    expect(configDir).toContain(String(active.revision))
    const skill = await readFile(result.skillPath, 'utf8')
    expect(skill).toContain(configDir)
    expect(skill).toContain(dataDir)
    expect(skill).toContain(input.ownerUserId)
    expect(skill).not.toContain(input.appSecret)
  })

  test('refreshes the current SDK secret only through stdin, then rechecks owner and reuses without login', async () => {
    const { input, callbacks } = await setupInput()
    const cli = fakeCli(input)
    const first = await setupLarkBusinessTools(input, { run: cli.run })
    const beforeSkill = await readFile(first.skillPath, 'utf8')
    const beforeActive = await readFile(await activePath(input), 'utf8')
    cli.requests.length = 0
    cli.events.length = 0
    input.appSecret = 'new-sdk-secret-never-in-argv-or-env'
    const second = await setupLarkBusinessTools(input, { run: cli.run })
    expect(second).toEqual({ skillPath: first.skillPath, reusedAuthorization: true })
    expect(cli.events).toEqual(['config', 'status', 'server-userinfo'])
    expect(cli.requests[0]?.input).toBe(`${input.appSecret}\n`)
    expect(cli.requests.slice(1).every(request => request.input === undefined)).toBe(true)
    for (const request of cli.requests) {
      expect(JSON.stringify(request.args)).not.toContain(input.appSecret)
      expect(JSON.stringify(request.env)).not.toContain(input.appSecret)
    }
    expect(callbacks).toEqual([authorizationUrl])
    expect(await readFile(first.skillPath, 'utf8')).toBe(beforeSkill)
    expect(await readFile(await activePath(input), 'utf8')).toBe(beforeActive)
  })

  test.each([
    ['incomplete login', { pollCode: 1 }, 'incomplete'],
    ['wrong status application', { statusAppId: 'cli_ffffffffffffffff' }, 'bound owner'],
    ['wrong local owner', { statusOpenId: 'ou_someone_else' }, 'bound owner'],
    ['wrong server owner', { serverOpenId: 'ou_someone_else' }, 'bound owner'],
  ] as const)('%s cannot publish a fresh skill or active binding', async (_label, overrides, error) => {
    const { input } = await setupInput()
    const cli = fakeCli(input)
    Object.assign(cli.responses, overrides)
    await expect(setupLarkBusinessTools(input, { run: cli.run })).rejects.toThrow(error)
    await absent(await activePath(input))
    await absent(join(input.dshHome, 'skills'))
    if ('statusAppId' in overrides || 'statusOpenId' in overrides) expect(cli.events).not.toContain('server-userinfo')
    if ('serverOpenId' in overrides) expect(cli.events).toContain('server-userinfo')
  })

  test.each([
    ['start', { startStderr: 'warning: failed to cache requested scopes' }],
    ['poll', { pollStderr: 'warning: failed to load cached requested scopes' }],
  ] as const)('refuses exit-zero %s scope-cache warning without claiming all domains', async (_stage, overrides) => {
    const { input } = await setupInput()
    const cli = fakeCli(input)
    Object.assign(cli.responses, overrides)
    await expect(setupLarkBusinessTools(input, { run: cli.run })).rejects.toThrow()
    await absent(await activePath(input))
    await absent(join(input.dshHome, 'skills'))
    expect(cli.events).not.toContain('server-userinfo')
  })

  test.each([
    ['login failure', { pollCode: 1 }],
    ['application status mismatch', { statusAppId: 'cli_ffffffffffffffff' }],
    ['local status mismatch', { statusOpenId: 'ou_someone_else' }],
    ['server owner mismatch', { serverOpenId: 'ou_someone_else' }],
  ] as const)('%s after a prior success retains the old skill and active binding', async (_label, overrides) => {
    const { input } = await setupInput()
    const cli = fakeCli(input)
    const first = await setupLarkBusinessTools(input, { run: cli.run })
    const oldSkill = await readFile(first.skillPath, 'utf8')
    const bindingPath = await activePath(input)
    const oldBinding = await readFile(bindingPath, 'utf8')
    const revision = (JSON.parse(oldBinding) as { revision: string }).revision
    cli.responses.rejectRevision = revision
    Object.assign(cli.responses, overrides)
    await expect(setupLarkBusinessTools(input, { run: cli.run })).rejects.toThrow()
    expect(await readFile(first.skillPath, 'utf8')).toBe(oldSkill)
    expect(await readFile(bindingPath, 'utf8')).toBe(oldBinding)
  })

  test.each([
    ['owner', { ownerUserId: 'ou_new_owner' }],
    ['application', { appId: 'cli_ffffffffffffffff' }],
  ] as const)('%s rotation withdraws the old skill before failed authorization', async (_label, change) => {
    const { input } = await setupInput()
    const cli = fakeCli(input)
    const first = await setupLarkBusinessTools(input, { run: cli.run })
    const bindingPath = await activePath(input)
    const oldBinding = await readFile(bindingPath, 'utf8')
    Object.assign(input, change)
    cli.responses.pollCode = 1
    await expect(setupLarkBusinessTools(input, { run: cli.run })).rejects.toThrow('incomplete')
    await absent(first.skillPath)
    expect(await readFile(bindingPath, 'utf8')).toBe(oldBinding)
  })

  test.each(['foreign marker', 'symlink'] as const)('refuses %s at the native skill destination', async kind => {
    const { input } = await setupInput()
    const cli = fakeCli(input)
    const name = renderLarkBusinessSkill({
      dshHome: input.dshHome, profile: input.profile, account: input.account,
      cliCommand: input.cli.command, cliProfile: 'dsh-owner',
      cliConfigDir: join(input.dshHome, 'placeholder-config'),
      cliDataDir: join(input.dshHome, 'placeholder-data'),
      ownerUserId: input.ownerUserId, appId: input.appId,
    }).name
    const target = join(input.dshHome, 'skills', name, 'SKILL.md')
    await mkdir(dirname(target), { recursive: true })
    const foreign = '---\nname: foreign\n---\n<!-- managed-by:someone-else -->\n'
    if (kind === 'foreign marker') await writeFile(target, foreign)
    else {
      const outside = join(dirname(input.dshHome), 'outside.md')
      await writeFile(outside, foreign)
      await symlink(outside, target)
    }
    await expect(setupLarkBusinessTools(input, { run: cli.run })).rejects.toThrow()
    await absent(join(input.dshHome, 'lark-business'))
    expect(cli.requests).toHaveLength(0)
    if (kind === 'foreign marker') expect(await readFile(target, 'utf8')).toBe(foreign)
    else {
      expect((await lstat(target)).isSymbolicLink()).toBe(true)
      expect(await readFile(target, 'utf8')).toBe(foreign)
    }
  })
})
