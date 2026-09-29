import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
const bindingSizeLimit = 256 * 1024

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
  authorization?: BusinessAuthorization
}

interface BusinessAuthorization {
  permissionCompletion: 'complete' | 'partial'
  requestedScopes: string[]
  grantedScopes: string[]
  missingScopes: string[]
}

export interface LarkBusinessSetupResult {
  skillPath: string
  reusedAuthorization: boolean
  /** Legacy receipts have no scope evidence; never infer grants from a request. */
  permissionCompletion: 'complete' | 'partial' | 'unknown'
  requestedScopes: string[]
  grantedScopes: string[]
  missingScopes: string[]
}

function scopeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 4096
    || value.some(scope => typeof scope !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(scope))
    || new Set(value).size !== value.length) return undefined
  return value as string[]
}

function scopeString(value: unknown): string[] | undefined {
  return typeof value === 'string' ? scopeList(value.trim().split(/\s+/u).filter(Boolean)) : undefined
}

function authorizationEvidence(value: unknown): BusinessAuthorization | undefined {
  const evidence = object(value)
  const requestedScopes = scopeList(evidence?.requestedScopes)
  const grantedScopes = scopeList(evidence?.grantedScopes)
  const missingScopes = scopeList(evidence?.missingScopes)
  if (!requestedScopes?.length || !grantedScopes || !missingScopes) return undefined
  const granted = new Set(grantedScopes)
  const expectedMissing = requestedScopes.filter(scope => !granted.has(scope))
  if (expectedMissing.length !== missingScopes.length
    || expectedMissing.some(scope => !missingScopes.includes(scope))) return undefined
  const permissionCompletion = missingScopes.length ? 'partial' : 'complete'
  if (evidence?.permissionCompletion !== permissionCompletion) return undefined
  return { permissionCompletion, requestedScopes, grantedScopes, missingScopes }
}

/** v1.0.85's ExitAuth (3) also reports a saved login with missing scopes. */
function completedAuthorization(result: BusinessCliResult, ownerUserId: string): BusinessAuthorization {
  const payload = object(parseJson(result.stdout))
  const evidence = authorizationEvidence({ permissionCompletion: Array.isArray(payload?.missing) && payload.missing.length ? 'partial' : 'complete',
    requestedScopes: payload?.requested, grantedScopes: payload?.granted, missingScopes: payload?.missing })
  const warning = object(payload?.warning)
  const newly = scopeList(payload?.newly_granted)
  const already = scopeList(payload?.already_granted)
  const classified = newly && already ? [...newly, ...already] : undefined
  const requestedGranted = evidence?.requestedScopes.filter(scope => evidence.grantedScopes.includes(scope))
  const scope = scopeString(payload?.scope)
  if (payload?.event !== 'authorization_complete' || payload.user_open_id !== ownerUserId || !evidence
    || !classified || new Set(classified).size !== classified.length
    || classified.length !== requestedGranted?.length || classified.some(scope => !requestedGranted.includes(scope))
    || !scope || scope.length !== evidence.grantedScopes.length || scope.some(item => !evidence.grantedScopes.includes(item))
    || (evidence.permissionCompletion === 'partial'
      ? result.code !== 3 || warning?.type !== 'missing_scope'
      : result.code !== 0 || payload.warning !== undefined)) {
    throw new Error('lark business setup: user authorization is incomplete; business skill was not activated')
  }
  return evidence
}

/** Completes user authorization after channel owner binding; publishes a skill only after readback. */
export async function setupLarkBusinessTools(input: LarkBusinessSetupInput, runtime: LarkBusinessSetupRuntime = {}): Promise<LarkBusinessSetupResult> {
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
  const pendingPath = join(directory, 'pending.json')
  const run = runtime.run ?? runBusinessCli
  const publishSkill = runtime.installSkill ?? installLarkBusinessSkill
  const paths = (revision: string) => ({ configDir: join(directory, revision, 'config'), dataDir: join(directory, revision, 'data') })
  const invoke = async (revision: string, args: string[], secret?: string, timeoutMs = 30_000): Promise<BusinessCliResult> => {
    const { configDir, dataDir } = paths(revision)
    return run({ command: input.cli.command, args: ['--profile', cliProfile, ...args],
      env: larkBusinessEnvironment(configDir, dataDir), timeoutMs,
      ...(secret === undefined ? {} : { input: secret }) })
  }
  const verified = async (revision: string): Promise<false | { scopes: string[] | undefined }> => {
    const result = await invoke(revision, ['auth', 'status', '--json', '--verify'])
    if (result.code !== 0) return false
    let status = parseJson(result.stdout)
    if (!isVerifiedLarkBusinessOwner(status, input.appId, input.ownerUserId)) return false
    // `auth status` labels the user with the local profile openId. Independently
    // compare the server's current user_info response with the paired owner.
    const readback = await invoke(revision, ['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user'])
    if (readback.code !== 0) return false
    const identity = object(parseJson(readback.stdout))
    if (identity?.ok !== true || identity.identity !== 'user' || object(identity.data)?.open_id !== input.ownerUserId) return false
    // The first status can report scope fields collected before token refresh.
    // Read the current token scope list after verified user_info has used it.
    const refreshed = await invoke(revision, ['auth', 'status', '--json', '--verify'])
    if (refreshed.code !== 0) return false
    status = parseJson(refreshed.stdout)
    if (!isVerifiedLarkBusinessOwner(status, input.appId, input.ownerUserId)) return false
    return { scopes: scopeString(object(object(object(status)?.identities)?.user)?.scope) }
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
  const readBinding = async (path: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > bindingSizeLimit) throw new Error('lark business setup: invalid binding file')
      return object(parseJson(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }
  const matches = (binding: Record<string, unknown> | undefined): binding is Record<string, unknown> & { revision: string } =>
    binding?.schema === 1 && typeof binding.revision === 'string' && revisionPattern.test(binding.revision)
    && binding.appId === input.appId && binding.ownerUserId === input.ownerUserId
    && binding.domain === input.domain && binding.cliVersion === input.cli.version && binding.requestedDomains === 'all'
  const validatePaths = async (revision: string): Promise<void> => {
    const current = paths(revision)
    for (const path of [join(directory, revision), current.configDir, current.dataDir]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('lark business setup: active CLI directory changed')
    }
  }
  const writeBinding = async (path: string, binding: ActiveBinding): Promise<void> => {
    const temporary = join(directory, `binding.${randomUUID()}.tmp`)
    const content = `${JSON.stringify(binding)}\n`
    if (Buffer.byteLength(content) > bindingSizeLimit) throw new Error('lark business setup: authorization evidence exceeded its limit')
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  }
  const result = (skillPath: string, reusedAuthorization: boolean, evidence?: BusinessAuthorization): LarkBusinessSetupResult => ({
    skillPath, reusedAuthorization, permissionCompletion: evidence?.permissionCompletion ?? 'unknown',
    requestedScopes: evidence?.requestedScopes ?? [], grantedScopes: evidence?.grantedScopes ?? [], missingScopes: evidence?.missingScopes ?? [],
  })
  const currentEvidence = (evidence: BusinessAuthorization | undefined, scopes: string[] | undefined): BusinessAuthorization | undefined => {
    // The receipt records a login snapshot. Subsequent tokens can lose scopes;
    // current result claims use the verified CLI identity's token scope list.
    if (!evidence || !scopes) return undefined
    const missingScopes = evidence.requestedScopes.filter(scope => !scopes.includes(scope))
    return { permissionCompletion: missingScopes.length ? 'partial' : 'complete', requestedScopes: evidence.requestedScopes,
      grantedScopes: scopes, missingScopes }
  }
  const existing = await readBinding(activePath)
  if (matches(existing)) {
    await validatePaths(existing.revision)
    const evidence = authorizationEvidence(existing.authorization)
    if (existing.authorization !== undefined && !evidence) throw new Error('lark business setup: invalid authorization evidence')
    // Application secrets may have rotated since the previous setup. Updating
    // this same named profile retains its user session without another login.
    await configure(existing.revision)
    const identity = await verified(existing.revision)
    if (identity) {
      return result(await skill(existing.revision), true, currentEvidence(evidence, identity.scopes))
    }
  }

  // Only a captured completion can recover publication after interrupted owner
  // readback/skill installation. Tokens or an all-domain request alone do not
  // prove which scopes were granted, including for older orphan revisions.
  const pending = await readBinding(pendingPath)
  if (matches(pending)) {
    const evidence = authorizationEvidence(pending.authorization)
    if (pending.authorization !== undefined && !evidence) throw new Error('lark business setup: invalid pending authorization evidence')
    if (evidence) {
      await validatePaths(pending.revision)
      await configure(pending.revision)
      const identity = await verified(pending.revision)
      if (!identity) throw new Error('lark business setup: authorized user does not match the bound owner; business skill was not activated')
      const skillPath = await skill(pending.revision)
      await writeBinding(activePath, { schema: 1, revision: pending.revision, appId: input.appId, ownerUserId: input.ownerUserId,
        domain: input.domain, cliVersion: input.cli.version, requestedDomains: 'all', authorization: evidence })
      await unlink(pendingPath)
      return result(skillPath, true, currentEvidence(evidence, identity.scopes))
    }
  }

  const revision = randomUUID()
  const { configDir, dataDir } = paths(revision)
  await privateDirectory(join(directory, revision))
  await privateDirectory(configDir)
  await privateDirectory(dataDir)
  await configure(revision)
  const binding: ActiveBinding = { schema: 1, revision, appId: input.appId, ownerUserId: input.ownerUserId,
    domain: input.domain, cliVersion: input.cli.version, requestedDomains: 'all' }
  await writeBinding(pendingPath, binding)
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
  if (/failed to (?:cache requested|load cached requested) scopes/iu.test(authorized.stderr ?? '')) {
    throw new Error('lark business setup: requested scope evidence could not be read; business skill was not activated')
  }
  const evidence = completedAuthorization(authorized, input.ownerUserId)
  binding.authorization = evidence
  await writeBinding(pendingPath, binding)
  const identity = await verified(revision)
  if (!identity) throw new Error('lark business setup: authorized user does not match the bound owner; business skill was not activated')
  // Retain old configuration files while publishing. macOS/Windows native
  // keychains can share app/user entries; only Linux data paths are isolated.
  // Setup sends no business writes, only authentication and identity readback.
  const skillPath = await skill(revision)
  await writeBinding(activePath, binding)
  await unlink(pendingPath)
  return result(skillPath, false, currentEvidence(evidence, identity.scopes))
}
