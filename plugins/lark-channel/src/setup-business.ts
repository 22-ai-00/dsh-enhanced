import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { installLarkBusinessSkill, reconcileLarkBusinessSkill } from './business-skill.js'
import { LARK_BUSINESS_CLEARED_ENV } from './business-environment.js'

export interface LarkBusinessSetupInput {
  dshHome: string
  profile: string
  account: string
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  ownerUserId: string
  cli: { command: string; version: string }
  timeoutMs: number
  onAuthorization: (url: string) => void | Promise<void>
}

export interface BusinessCliRequest {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  input?: string
  timeoutMs: number
}

export interface BusinessCliResult { code: number | null; stdout: string; stderr?: string }
export interface LarkBusinessSetupRuntime {
  run?: (request: BusinessCliRequest) => Promise<BusinessCliResult>
  installSkill?: typeof installLarkBusinessSkill
}

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const revisionPattern = /^[a-f0-9-]{36}$/u
const cliProfile = 'dsh-owner'

/** Each process uses the same private config and Linux credential directories. */
export function larkBusinessEnvironment(configDir: string, dataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of LARK_BUSINESS_CLEARED_ENV) delete env[key]
  env.LARKSUITE_CLI_CONFIG_DIR = configDir
  env.LARKSUITE_CLI_DATA_DIR = dataDir
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
  return env
}

/** Never echo CLI output from a credential-bearing command into an error. */
export async function runBusinessCli(request: BusinessCliRequest): Promise<BusinessCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      env: request.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let failed = false
    const stop = (): void => {
      failed = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(stop, request.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) stop()
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) stop()
      else errors.push(chunk)
    })
    child.stdin.on('error', () => { /* Process exit is reported by close. */ })
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('lark business setup: CLI could not start'))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (failed || signal !== null) reject(new Error('lark business setup: CLI timed out or exceeded its output limit'))
      else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') })
    })
    child.stdin.end(request.input)
  })
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function isVerifiedLarkBusinessOwner(value: unknown, appId: string, ownerUserId: string): boolean {
  const status = object(value)
  const user = object(object(status?.identities)?.user)
  return status?.appId === appId && status.identity === 'user' && status.verified === true
    && user?.openId === ownerUserId && user.available === true && user.verified === true
    && (user.status === 'ready' || user.status === 'needs_refresh')
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('lark business setup: managed directory is not a real directory')
  await chmod(path, 0o700)
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { throw new Error('lark business setup: CLI returned invalid JSON') }
}

interface ActiveBinding {
  schema: 1
  revision: string
  appId: string
  ownerUserId: string
  domain: 'feishu' | 'lark'
  cliVersion: string
  requestedDomains: 'all'
}

/** Completes user authorization after channel owner binding; publishes a skill only after readback. */
export async function setupLarkBusinessTools(input: LarkBusinessSetupInput, runtime: LarkBusinessSetupRuntime = {}): Promise<{
  skillPath: string
  reusedAuthorization: boolean
}> {
  if (!isAbsolute(input.dshHome) || !isAbsolute(input.cli.command)
    || !keyPattern.test(input.profile) || !keyPattern.test(input.account)
    || !/^cli_[0-9a-f]{16}$/iu.test(input.appId) || !/^ou_[A-Za-z0-9_-]+$/u.test(input.ownerUserId)
    || !['feishu', 'lark'].includes(input.domain)
    || !input.appSecret || ['\r', '\n', '\0'].some(character => input.appSecret.includes(character))
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 30_000 || input.timeoutMs > 900_000) {
    throw new Error('lark business setup: invalid binding inputs')
  }
  await reconcileLarkBusinessSkill({ ...input, enabled: true })
  const root = join(input.dshHome, 'lark-business')
  await privateDirectory(root)
  const id = createHash('sha256').update(JSON.stringify([input.profile, input.account])).digest('hex').slice(0,24)
  const directory = join(root, id)
  await privateDirectory(directory)
  const activePath = join(directory, 'active.json')
  const run = runtime.run ?? runBusinessCli
  const publishSkill = runtime.installSkill ?? installLarkBusinessSkill
  const paths = (revision: string) => ({ configDir: join(directory, revision, 'config'), dataDir: join(directory, revision, 'data') })
  const invoke = async (revision: string, args: string[], secret?: string, timeoutMs = 30_000): Promise<BusinessCliResult> => {
    const { configDir, dataDir } = paths(revision)
    return run({ command: input.cli.command, args: ['--profile', cliProfile, ...args],
      env: larkBusinessEnvironment(configDir, dataDir), timeoutMs,
      ...(secret === undefined ? {} : { input: secret }) })
  }
  const verified = async (revision: string): Promise<boolean> => {
    const result = await invoke(revision, ['auth', 'status', '--json', '--verify'])
    if (result.code !== 0 || !isVerifiedLarkBusinessOwner(parseJson(result.stdout), input.appId, input.ownerUserId)) return false
    // `auth status` labels the user with the local profile openId. Independently
    // compare the server's current user_info response with the paired owner.
    const readback = await invoke(revision, ['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user'])
    if (readback.code !== 0) return false
    const identity = object(parseJson(readback.stdout))
    return identity?.ok === true && identity.identity === 'user'
      && object(identity.data)?.open_id === input.ownerUserId
  }
  const configure = async (revision: string): Promise<void> => {
    const result = await invoke(revision, ['config', 'init', '--name', cliProfile, '--app-id', input.appId,
      '--app-secret-stdin', '--brand', input.domain], `${input.appSecret}\n`)
    if (result.code !== 0) throw new Error('lark business setup: CLI app configuration failed; channel binding is retained')
  }
  const skill = async (revision: string): Promise<string> => {
    const { configDir, dataDir } = paths(revision)
    return (await publishSkill({ dshHome: input.dshHome, profile: input.profile, account: input.account,
      appId: input.appId, ownerUserId: input.ownerUserId, cliCommand: input.cli.command,
      cliConfigDir: configDir, cliDataDir: dataDir, cliProfile })).path
  }
  let existing: Record<string, unknown> | undefined
  try {
    const info = await lstat(activePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('lark business setup: invalid active binding file')
    existing = object(parseJson(await readFile(activePath, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing?.schema === 1 && typeof existing.revision === 'string' && revisionPattern.test(existing.revision)
    && existing.appId === input.appId && existing.ownerUserId === input.ownerUserId
    && existing.domain === input.domain && existing.cliVersion === input.cli.version && existing.requestedDomains === 'all') {
    const current = paths(existing.revision)
    for (const path of [join(directory, existing.revision), current.configDir, current.dataDir]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('lark business setup: active CLI directory changed')
    }
    // Application secrets may have rotated since the previous setup. Updating
    // this same named profile retains its user session without another login.
    await configure(existing.revision)
    if (await verified(existing.revision)) {
      return { skillPath: await skill(existing.revision), reusedAuthorization: true }
    }
  }

  const revision = randomUUID()
  const { configDir, dataDir } = paths(revision)
  await privateDirectory(join(directory, revision))
  await privateDirectory(configDir)
  await privateDirectory(dataDir)
  await configure(revision)
  const started = await invoke(revision, ['auth', 'login', '--domain', 'all', '--no-wait', '--json'])
  if (started.code !== 0) throw new Error('lark business setup: user authorization could not start; check application permissions')
  if (/failed to (?:cache requested|load cached requested) scopes/iu.test(started.stderr ?? '')) {
    throw new Error('lark business setup: requested scope evidence could not be saved')
  }
  const authorization = object(parseJson(started.stdout))
  if (typeof authorization?.verification_url !== 'string' || typeof authorization.device_code !== 'string'
    || !authorization.device_code || authorization.device_code.length > 4096) {
    throw new Error('lark business setup: invalid device authorization response')
  }
  let url: URL
  try { url = new URL(authorization.verification_url) } catch { throw new Error('lark business setup: invalid authorization URL') }
  const verificationUrl = authorization.verification_url
  if (url.protocol !== 'https:' || url.username || url.password || ['\r', '\n', '\0'].some(character => verificationUrl.includes(character))) {
    throw new Error('lark business setup: invalid authorization URL')
  }
  await input.onAuthorization(authorization.verification_url)
  const authorized = await invoke(revision, ['auth', 'login', '--device-code', authorization.device_code, '--json'], undefined, input.timeoutMs)
  if (authorized.code !== 0) throw new Error('lark business setup: user authorization is incomplete; business skill was not activated')
  if (/failed to (?:cache requested|load cached requested) scopes/iu.test(authorized.stderr ?? '')) {
    throw new Error('lark business setup: requested scope evidence could not be read; business skill was not activated')
  }
  if (!await verified(revision)) throw new Error('lark business setup: authorized user does not match the bound owner; business skill was not activated')

  const binding: ActiveBinding = { schema: 1, revision, appId: input.appId, ownerUserId: input.ownerUserId,
    domain: input.domain, cliVersion: input.cli.version, requestedDomains: 'all' }
  const temporary = join(directory, `active.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: 'wx' })
  // Retain old configuration files while publishing. macOS/Windows native
  // keychains can share app/user entries; only Linux data paths are isolated.
  // Setup sends no business writes, only authentication and identity readback.
  const skillPath = await skill(revision)
  await rename(temporary, activePath)
  return { skillPath, reusedAuthorization: false }
}
