import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { Document, Scalar, isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { extractCredentialKeyNames } from './diagnose.ts'
import { inspectBoundHostRuntime, type BoundHostInspection } from './install-host.ts'
import { listProfilePlugins, listProfiles, profilesDirectory } from './paths.ts'
import { defaultDetailedRunner, defaultRunner, findRunningProfiles, type CommandRunner, type DetailedCommandRunner } from './run.ts'
import { controlManagedService, inspectManagedServiceForDshHome } from './services.ts'

export const PROVIDER_EXIT_USAGE = 2
export const PROVIDER_EXIT_RUNTIME = 1
export const PROVIDER_EXIT_VERIFY = 4

export const DEFAULT_KEY_INPUT_ENV = 'DSH_RAY_MODEL_API_KEY'
const DEFAULT_HOST_PACKAGE = '@deepseek-ai/dsh'
const DEFAULT_BASE_PACKAGE = '@deepseek-ai/dsh-base'
const DEFAULT_PI_AI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const DEFAULT_DEEPSEEK_LLM_PACKAGE = '@deepseek-ai/dsh-llm-deepseek'
const DEFAULT_CREDENTIALS_LOCAL_PACKAGE = '@deepseek-ai/dsh-credentials-local'
const DEFAULT_PI_AI_PLUGIN_NAME = '@deepseek-ai/dsh-llm-pi-ai'
const DEFAULT_AGENT_DEFAULT_MODEL_PLUGIN_NAME = '@deepseek-ai/dsh-agent-default-model'
const DEFAULT_ACP_PACKAGE = '@dsh-ray/traex-acp-provider'
const DEFAULT_ACP_ROW_ID = 'dsh-ray-traex-acp-provider'

const POPULAR_THIRD_PARTY_PROVIDERS = [
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'moonshotai-cn',
  'kimi-coding',
  'minimax-cn',
  'zai-coding-cn',
  'deepseek',
  'xai',
  'groq',
] as const

const PATCH_CUSTOM_TAGS = [
  { tag: '!js', resolve: (value: string) => value },
  { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value },
]

export class ProviderCommandError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = PROVIDER_EXIT_RUNTIME) {
    super(message)
    this.name = 'ProviderCommandError'
    this.exitCode = exitCode
  }
}

export interface DshNativeAuthInfo {
  env: readonly string[]
  oauth: boolean
}

export interface DshConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  declared?: boolean
  defaultBaseURL?: string
  baseURLEnv?: readonly string[]
  nativeAuth?: DshNativeAuthInfo
  error?: string
}

export interface DshDiscoveredModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
}

export interface DshModelDiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}

export interface DshProviderRuntime {
  hostVersion?: string
  dshPath?: string
  dshPackageJsonPath?: string
  protocols: readonly string[]
  catalogProviders: readonly DshConfigurableProvider[]
  deepseekModels: readonly DshDiscoveredModel[]
  discoverModels(request: DshModelDiscoveryRequest, signal?: AbortSignal): Promise<DshDiscoveredModel[]>
  validateProvidersConfig?: (providers: Record<string, unknown>) => void
  validateCredentialsDocument?: (source: string, filename: string) => void
}

export interface DumpConfigRowSummary {
  id: string
  name: string
  disabled?: boolean
  config?: Record<string, unknown>
}

export interface ParsedDumpConfig {
  schemaVersion?: number
  profile?: string
  rows: DumpConfigRowSummary[]
  rawYaml?: string
}

export interface ProviderPrompter {
  ask(question: string): Promise<string>
  askSecret(question: string): Promise<string>
}

export type ProviderAction = 'setup' | 'list' | 'remove' | 'help'

export interface ParsedProviderArgs {
  action: ProviderAction
  dshHome?: string
  profile?: string
  provider?: string
  custom: boolean
  model?: string
  reasoningEffort?: string
  baseURL?: string
  api?: string
  displayName?: string
  apiKeyEnv?: string
  storeKey: boolean
  keyEnvVar?: string
  promptKey: boolean
  nativeAuth: boolean
  discover: boolean
  setDefault: boolean
  keepKey: boolean
  restart: boolean
  dryRun: boolean
  json: boolean
  yes: boolean
}

export interface ConfiguredPiAiProvider {
  provider: string
  apiKeyEnv?: string
  baseURL?: string
  api?: string
  displayName?: string
  models: readonly string[]
}

export interface ProfileProviderState {
  profile: string
  patchPath: string
  dshVersion?: string
  dshPath?: string
  defaultProvider?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  configuredProviders: readonly ConfiguredPiAiProvider[]
  rawProviders?: Record<string, Record<string, unknown>>
  availablePlugins: readonly string[]
  credentialRefs: readonly string[]
  credentialsInsecureMode?: number
  acpInstalled?: boolean
  acpEnabled?: boolean
  acpAgyEnabled?: boolean
  homeOverrideDefaultModel?: boolean
  homeOverrideProviders?: readonly string[]
}

export interface ProviderCommandOutcome {
  ok: boolean
  action: Exclude<ProviderAction, 'help'>
  profile: string
  dryRun: boolean
  provider?: string
  kind?: 'catalog' | 'custom' | 'deepseek-official' | 'local-agent'
  model?: string
  reasoningEffort?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  storedCredentialRef?: string
  removedCredentialRef?: string
  setAsDefault?: boolean
  discoveredModels?: readonly DshDiscoveredModel[]
  restartedService?: boolean
  restartWarning?: string
  warnings: string[]
  patchPath: string
  credentialsPath: string
}

export interface ProviderRuntimeDependencies {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  runner?: CommandRunner
  detailedRunner?: DetailedCommandRunner
  stdout?: { write: (chunk: string) => void }
  stderr?: { write: (chunk: string) => void }
  isTTY?: boolean
  prompter?: ProviderPrompter
  loadRuntime?: (input: {
    dshHome: string
    env: NodeJS.ProcessEnv
    runner: CommandRunner
    readHostRuntime?: Parameters<typeof inspectBoundHostRuntime>[1] extends infer P
      ? P extends { read?: infer R } ? R : never
      : never
  }) => Promise<DshProviderRuntime>
  readHostRuntime?: Parameters<typeof inspectBoundHostRuntime>[1] extends infer P
    ? P extends { read?: infer R } ? R : never
    : never
  dumpProfileConfig?: (input: {
    dshPath: string
    dshHome: string
    profile: string
    env: NodeJS.ProcessEnv
  }) => Promise<ParsedDumpConfig>
}

export const PROVIDER_HELP = `dsh-ray provider — 引导配置或管理三方模型 Provider（直接复用 DSH Host 自身 Provider 能力）

用法：
  dsh-ray [--dsh-home <dir>] provider [setup] [选项]
  dsh-ray [--dsh-home <dir>] provider list [--profile <name>] [--json]
  dsh-ray [--dsh-home <dir>] provider remove <providerId> [选项]

子命令：
  setup（默认）           交互式引导配置三方/自定义模型 Provider；传入 --provider 时也可非交互执行
  list                   列出当前 profile 已配置模型路由与 DSH Host 内置支持的全部三方 Provider
  remove <providerId>    从当前 profile 移除已配置的 llm-pi-ai Provider 路由，并清理对应凭据引用
  help                   显示本帮助

setup 常用选项：
  --dsh-home <dir>       指定 DSH_HOME 目录（也可置于 provider 子命令前）
  --profile <name>       目标 profile（单 profile 自动选中；多 profile 时优先 web 或交互选择）
  --provider <id>        Provider 路由 ID：DSH 内置 ID（如 openai/anthropic/openrouter/google/moonshotai-cn/kimi-coding/minimax-cn/zai-coding-cn/xai/groq/deepseek）、deepseek-official、traex-agent/agy-agent，或配合 --custom 的自定义路由 ID
  --custom               将未知 --provider 显式声明为自定义三方兼容 API 路由
  --model <id>           默认模型 ID（未传 --no-default 时同步写入 agent-default-model）
  --reasoning-effort <v> 可选推理强度（写入 agent-default-model.reasoningEffort）
  --base-url <url>       端点 URL（内置 provider 可选覆盖；自定义 provider 新建时必填）
  --api <protocol>       Wire 协议（复用 DSH supportedProtocols，如 openai-completions / openai-responses / anthropic-messages / google-generative-ai）
  --display-name <name>  显示名称
  --api-key-env <VAR>    指定 llm-pi-ai 使用的凭据引用名（默认按 DSH 规则生成 <PROVIDER>_API_KEY）
  --store-key            非交互从环境变量读取 API Key 并安全写入 $DSH_HOME/.credentials.yaml (0600)
  --key-env-var <VAR>    配合 --store-key 读取源环境变量名（默认先检查 ${DEFAULT_KEY_INPUT_ENV}，再回退引用名/nativeAuth.env）
  --prompt-key           传了 --provider 后仍以隐藏输入提示符输入 API Key
  --native-auth          内置 provider 不写 apiKeyEnv，改用 DSH 原生环境变量或 OAuth 登录态
  --discover             调用 DSH 自身 discoverModels 探测端点 / 拉取模型列表
  --no-default           只添加/更新 llm-pi-ai Provider 配置，不修改当前默认模型
  --no-restart           配置完成后不自动重启运行中的受管常驻服务
  --dry-run              仅校验并预览计划修改，不落盘不重启
  --json                 以 JSON 输出结果（严格脱敏，绝不输出任何 API Key 原文）

remove 常用选项：
  --dsh-home <dir>       指定 DSH_HOME 目录
  --profile <name>       目标 profile
  --keep-key             只删除 llm-pi-ai Provider 路由，保留 .credentials.yaml 中的凭据引用
  --yes                  即使该 provider 当前为默认模型也确认继续（只改写 llm-pi-ai，需另设默认模型）
  --no-restart           不重启运行中的受管服务
  --dry-run              仅预览
  --json                 以 JSON 输出结果`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidProfileName(profile: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)
}

export function deriveKeyRef(providerId: string): string {
  const trimmed = providerId.trim()
  if (trimmed === 'deepseek-official') return 'DEEPSEEK_API_KEY'
  const normalized = trimmed
    .replaceAll(/[^A-Za-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .toUpperCase()
  return `${normalized || 'PROVIDER'}_API_KEY`
}

export function validateApiKeyValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new ProviderCommandError('API Key 不能为空。', PROVIDER_EXIT_USAGE)
  }
  if (/^bearer\s+/iu.test(trimmed)) {
    throw new ProviderCommandError('API Key 不应包含 "Bearer " 前缀，请只输入 Key 本身。', PROVIDER_EXIT_USAGE)
  }
  if (!/^[\x21-\x7E]+$/u.test(trimmed)) {
    throw new ProviderCommandError(
      'API Key 包含空白字符、换行或非 ASCII 可打印字符，请检查后重试。',
      PROVIDER_EXIT_USAGE,
    )
  }
  return trimmed
}

function validateEnvVarName(name: string, flagName: string): string {
  const trimmed = name.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) {
    throw new ProviderCommandError(`${flagName} 必须是合法环境变量名（收到：${name}）`, PROVIDER_EXIT_USAGE)
  }
  return trimmed
}

function validateProviderId(providerId: string): string {
  const trimmed = providerId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(trimmed)) {
    throw new ProviderCommandError(
      `Provider ID 格式无效：${providerId}（仅允许字母、数字、点、下划线和连字符，且以字母或数字开头）`,
      PROVIDER_EXIT_USAGE,
    )
  }
  return trimmed
}

function validateBaseURL(url: string): string {
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ProviderCommandError(`baseURL 不是合法 URL：${url}`, PROVIDER_EXIT_USAGE)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderCommandError(`baseURL 协议必须为 http:// 或 https://（收到：${url}）`, PROVIDER_EXIT_USAGE)
  }
  return trimmed.replace(/\/+$/u, '')
}

function readNextOption(args: readonly string[], index: number, flag: string): [string, number] {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new ProviderCommandError(`${flag} 需要一个参数值`, PROVIDER_EXIT_USAGE)
  }
  return [value, index + 1]
}

export function parseProviderArgs(argv: readonly string[]): ParsedProviderArgs {
  const tokens = [...argv]
  let action: ProviderAction = 'setup'
  let actionExplicit = false

  const parsed: ParsedProviderArgs = {
    action,
    custom: false,
    storeKey: false,
    promptKey: false,
    nativeAuth: false,
    discover: false,
    setDefault: true,
    keepKey: false,
    restart: true,
    dryRun: false,
    json: false,
    yes: false,
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    switch (token) {
      case '--help':
      case '-h':
        return { ...parsed, action: 'help' }
      case '--dsh-home': {
        const [value, nextIndex] = readNextOption(tokens, index, '--dsh-home')
        parsed.dshHome = resolve(value)
        index = nextIndex
        break
      }
      case '--profile': {
        const [value, nextIndex] = readNextOption(tokens, index, '--profile')
        parsed.profile = value
        index = nextIndex
        break
      }
      case '--provider': {
        const [value, nextIndex] = readNextOption(tokens, index, '--provider')
        parsed.provider = value
        index = nextIndex
        break
      }
      case '--custom':
        parsed.custom = true
        break
      case '--model': {
        const [value, nextIndex] = readNextOption(tokens, index, '--model')
        parsed.model = value
        index = nextIndex
        break
      }
      case '--reasoning-effort': {
        const [value, nextIndex] = readNextOption(tokens, index, '--reasoning-effort')
        parsed.reasoningEffort = value
        index = nextIndex
        break
      }
      case '--base-url': {
        const [value, nextIndex] = readNextOption(tokens, index, '--base-url')
        parsed.baseURL = value
        index = nextIndex
        break
      }
      case '--api': {
        const [value, nextIndex] = readNextOption(tokens, index, '--api')
        parsed.api = value
        index = nextIndex
        break
      }
      case '--display-name': {
        const [value, nextIndex] = readNextOption(tokens, index, '--display-name')
        parsed.displayName = value
        index = nextIndex
        break
      }
      case '--api-key-env': {
        const [value, nextIndex] = readNextOption(tokens, index, '--api-key-env')
        parsed.apiKeyEnv = validateEnvVarName(value, '--api-key-env')
        index = nextIndex
        break
      }
      case '--store-key':
        parsed.storeKey = true
        break
      case '--key-env-var': {
        const [value, nextIndex] = readNextOption(tokens, index, '--key-env-var')
        parsed.keyEnvVar = validateEnvVarName(value, '--key-env-var')
        index = nextIndex
        break
      }
      case '--prompt-key':
        parsed.promptKey = true
        break
      case '--native-auth':
        parsed.nativeAuth = true
        break
      case '--discover':
        parsed.discover = true
        break
      case '--no-default':
        parsed.setDefault = false
        break
      case '--keep-key':
        parsed.keepKey = true
        break
      case '--no-restart':
        parsed.restart = false
        break
      case '--dry-run':
        parsed.dryRun = true
        break
      case '--json':
        parsed.json = true
        break
      case '--yes':
      case '-y':
        parsed.yes = true
        break
      default:
        if (token.startsWith('--dsh-home=')) {
          const val = token.slice('--dsh-home='.length)
          if (!val) throw new ProviderCommandError('--dsh-home 需要非空值', PROVIDER_EXIT_USAGE)
          parsed.dshHome = resolve(val)
        } else if (token.startsWith('--profile=')) {
          parsed.profile = token.slice('--profile='.length)
          if (!parsed.profile) throw new ProviderCommandError('--profile 需要非空值', PROVIDER_EXIT_USAGE)
        } else if (token.startsWith('--provider=')) {
          parsed.provider = token.slice('--provider='.length)
          if (!parsed.provider) throw new ProviderCommandError('--provider 需要非空值', PROVIDER_EXIT_USAGE)
        } else if (token.startsWith('--model=')) {
          parsed.model = token.slice('--model='.length)
          if (!parsed.model) throw new ProviderCommandError('--model 需要非空值', PROVIDER_EXIT_USAGE)
        } else if (token.startsWith('--reasoning-effort=')) {
          parsed.reasoningEffort = token.slice('--reasoning-effort='.length)
          if (!parsed.reasoningEffort) throw new ProviderCommandError('--reasoning-effort 需要非空值', PROVIDER_EXIT_USAGE)
        } else if (token.startsWith('--base-url=')) {
          parsed.baseURL = token.slice('--base-url='.length)
          if (!parsed.baseURL) throw new ProviderCommandError('--base-url 需要非空值', PROVIDER_EXIT_USAGE)
        } else if (token.startsWith('--api=')) {
          parsed.api = token.slice('--api='.length)
          if (!parsed.api) throw new ProviderCommandError('--api 需要非空值', PROVIDER_EXIT_USAGE)
        } else if (token.startsWith('--display-name=')) {
          parsed.displayName = token.slice('--display-name='.length)
          if (!parsed.displayName) throw new ProviderCommandError('--display-name 需要非空值', PROVIDER_EXIT_USAGE)
        } else if (token.startsWith('--api-key-env=')) {
          parsed.apiKeyEnv = validateEnvVarName(token.slice('--api-key-env='.length), '--api-key-env')
        } else if (token.startsWith('--key-env-var=')) {
          parsed.keyEnvVar = validateEnvVarName(token.slice('--key-env-var='.length), '--key-env-var')
        } else if (token.startsWith('-')) {
          throw new ProviderCommandError(`未知 provider 选项：${token}。运行 "dsh-ray provider help" 查看用法。`, PROVIDER_EXIT_USAGE)
        } else if (!actionExplicit && (token === 'help' || token === 'setup' || token === 'add' || token === 'configure' || token === 'list' || token === 'remove' || token === 'rm' || token === 'delete')) {
          actionExplicit = true
          if (token === 'help') {
            parsed.action = 'help'
          } else if (token === 'list') {
            parsed.action = 'list'
          } else if (token === 'remove' || token === 'rm' || token === 'delete') {
            parsed.action = 'remove'
          } else {
            parsed.action = 'setup'
          }
        } else if (parsed.action === 'remove' && parsed.provider === undefined) {
          parsed.provider = token
        } else {
          throw new ProviderCommandError(`多余的参数：${token}。运行 "dsh-ray provider help" 查看用法。`, PROVIDER_EXIT_USAGE)
        }
    }
  }

  if (parsed.nativeAuth && parsed.apiKeyEnv !== undefined) {
    throw new ProviderCommandError('--native-auth 与 --api-key-env 不能同时使用。', PROVIDER_EXIT_USAGE)
  }
  if (parsed.nativeAuth && parsed.storeKey) {
    throw new ProviderCommandError('--native-auth 与 --store-key 不能同时使用。', PROVIDER_EXIT_USAGE)
  }
  if (parsed.nativeAuth && parsed.promptKey) {
    throw new ProviderCommandError('--native-auth 与 --prompt-key 不能同时使用。', PROVIDER_EXIT_USAGE)
  }

  return parsed
}

function findExecutableInPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const pathEnv = env.PATH ?? ''
  if (!pathEnv) return undefined
  const candidates = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate)
      try {
        const stats = statSync(fullPath)
        if (!stats.isFile()) continue
        if (platform !== 'win32') {
          if ((stats.mode & 0o111) === 0) continue
        }
        return fullPath
      } catch {
        // continue searching PATH
      }
    }
  }
  return undefined
}

function findPackageRootWalkingUp(startDir: string, packageName: string): string | undefined {
  let current = startDir
  while (true) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }
        if (parsed.name === packageName) return candidate
      } catch {
        // ignore unreadable package.json
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function resolveDshPackageJson(input: {
  dshHome: string
  dshPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  boundHost?: BoundHostInspection
}): string | undefined {
  const env = input.env ?? process.env
  if (env.DSH_PACKAGE_ROOT) {
    const candidate = isAbsolute(env.DSH_PACKAGE_ROOT)
      ? join(env.DSH_PACKAGE_ROOT, 'package.json')
      : resolve(env.DSH_PACKAGE_ROOT, 'package.json')
    if (existsSync(candidate)) return candidate
  }

  const candidateBins = new Set<string>()
  if (input.dshPath) candidateBins.add(input.dshPath)
  if (input.boundHost?.dshPath) candidateBins.add(input.boundHost.dshPath)
  if (env.DSH_BIN) candidateBins.add(env.DSH_BIN)
  const fromPath = findExecutableInPath('dsh', env, input.platform ?? process.platform)
  if (fromPath) candidateBins.add(fromPath)

  for (const binPath of candidateBins) {
    if (!existsSync(binPath)) continue

    let resolvedBin = binPath
    try {
      resolvedBin = realpathSync(binPath)
    } catch {
      resolvedBin = binPath
    }

    const walked = findPackageRootWalkingUp(dirname(resolvedBin), DEFAULT_HOST_PACKAGE)
    if (walked) return walked

    // Wrapper shell scripts (like ~/.dsh/runtime/dsh/current/bin/dsh or npm-global shims)
    const binDirs = [dirname(binPath), dirname(resolvedBin)]
    for (const binDir of binDirs) {
      const siblingRoots = [
        join(binDir, '..', 'node_modules', DEFAULT_HOST_PACKAGE, 'package.json'),
        join(binDir, '..', 'lib', 'node_modules', DEFAULT_HOST_PACKAGE, 'package.json'),
        join(binDir, 'node_modules', DEFAULT_HOST_PACKAGE, 'package.json'),
      ]
      for (const candidate of siblingRoots) {
        if (existsSync(candidate)) return realpathSync(candidate)
      }
    }

    try {
      const stats = lstatSync(resolvedBin)
      if (stats.isFile() && stats.size > 0 && stats.size < 16384) {
        const text = readFileSync(resolvedBin, 'utf8')
        const pkgMatch = /(['"])([^'"\n]*@deepseek-ai\/dsh[^'"\n]*)\1/u.exec(text)
        const target = pkgMatch?.[2]
        if (target) {
          const targetDir = isAbsolute(target) ? target : resolve(dirname(resolvedBin), target)
          const found = findPackageRootWalkingUp(existsSync(targetDir) && statSync(targetDir).isDirectory() ? targetDir : dirname(targetDir), DEFAULT_HOST_PACKAGE)
          if (found) return found
        }
      }
    } catch {
      // ignore non-text executable
    }
  }

  return undefined
}

async function importFromRequire(requireFn: NodeRequire, specifier: string): Promise<Record<string, unknown>> {
  const resolved = requireFn.resolve(specifier)
  try {
    const loaded: unknown = requireFn(resolved)
    if (isRecord(loaded)) return loaded
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'ERR_REQUIRE_ESM') throw error
  }
  const imported: unknown = await import(pathToFileURL(resolved).href)
  if (!isRecord(imported)) {
    throw new ProviderCommandError(`无法加载 DSH 模块 ${specifier}：导出对象无效`)
  }
  return imported
}

function asConfigurableProvider(entry: unknown): DshConfigurableProvider | undefined {
  if (!isRecord(entry)) return undefined
  if (typeof entry.provider !== 'string' || entry.provider.length === 0) return undefined
  if (typeof entry.displayName !== 'string') return undefined
  const nativeAuthRaw = entry.nativeAuth
  const nativeAuth = isRecord(nativeAuthRaw)
    ? {
        env: Array.isArray(nativeAuthRaw.env) ? nativeAuthRaw.env.filter((item): item is string => typeof item === 'string') : [],
        oauth: Boolean(nativeAuthRaw.oauth),
      }
    : undefined
  return {
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: typeof entry.settingsNs === 'string' ? entry.settingsNs : 'llm-pi-ai',
    settingsPath: Array.isArray(entry.settingsPath) ? entry.settingsPath.filter((item): item is string => typeof item === 'string') : ['providers', entry.provider],
    ...(typeof entry.declared === 'boolean' ? { declared: entry.declared } : {}),
    ...(typeof entry.defaultBaseURL === 'string' && entry.defaultBaseURL.length > 0 ? { defaultBaseURL: entry.defaultBaseURL } : {}),
    ...(Array.isArray(entry.baseURLEnv)
      ? { baseURLEnv: entry.baseURLEnv.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(nativeAuth !== undefined ? { nativeAuth } : {}),
    ...(typeof entry.error === 'string' && entry.error.length > 0 ? { error: entry.error } : {}),
  }
}

function asDiscoveredModel(entry: unknown): DshDiscoveredModel | undefined {
  if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) return undefined
  return {
    id: entry.id,
    ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
    ...(typeof entry.description === 'string' && entry.description.length > 0 ? { description: entry.description } : {}),
    ...(typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow) ? { contextWindow: entry.contextWindow } : {}),
    ...(typeof entry.maxTokens === 'number' && Number.isFinite(entry.maxTokens) ? { maxTokens: entry.maxTokens } : {}),
  }
}

export async function loadDshProviderRuntime(input: {
  dshHome: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  readHostRuntime?: ProviderRuntimeDependencies['readHostRuntime']
}): Promise<DshProviderRuntime> {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const boundHost = await inspectBoundHostRuntime(
    input.dshHome,
    input.readHostRuntime ? { read: input.readHostRuntime } : undefined,
  )
  if ((boundHost.status === 'invalid' || boundHost.status === 'unready') && !env.DSH_PACKAGE_ROOT && !env.DSH_BIN) {
    const reason = boundHost.error || boundHost.issues.join('；') || boundHost.status
    throw new ProviderCommandError(
      `当前 DSH Home 的私有 Host 绑定（.dsh-ray-host.json）不可用：${reason}。请先运行 dsh-ray doctor 或 dsh-ray install 修复绑定，或显式设置 DSH_BIN。`,
    )
  }
  const dshPackageJsonPath = resolveDshPackageJson({
    dshHome: input.dshHome,
    env,
    platform,
    boundHost,
  })
  if (!dshPackageJsonPath) {
    throw new ProviderCommandError(
      '未找到已安装的 DSH Host（@deepseek-ai/dsh），无法复用 DSH 的 provider 目录与模型探测能力。'
      + '\n请先运行 dsh-ray install，或确保 dsh 命令在 PATH 中 / 设置 DSH_BIN。',
    )
  }

  let hostVersion = boundHost.version
  try {
    const pkg = JSON.parse(readFileSync(dshPackageJsonPath, 'utf8')) as { version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      hostVersion = pkg.version
    }
  } catch {
    // keep inspected boundHost version
  }

  const dshRequire = createRequire(dshPackageJsonPath)
  const basePackageJsonPath = dshRequire.resolve(`${DEFAULT_BASE_PACKAGE}/package.json`)
  const baseRequire = createRequire(basePackageJsonPath)

  const piAiModule = await importFromRequire(baseRequire, DEFAULT_PI_AI_PACKAGE)
  const applyFn = piAiModule.apply
  const ConfigFn = piAiModule.Config
  const supportedProtocolsFn = piAiModule.supportedProtocols
  if (typeof applyFn !== 'function' || typeof ConfigFn !== 'function') {
    throw new ProviderCommandError(
      `已解析的 ${DEFAULT_PI_AI_PACKAGE} 缺少 apply/Config 导出（${dshPackageJsonPath}）。`,
    )
  }

  const catalogProviders: DshConfigurableProvider[] = []
  let discoverFn: ((request: DshModelDiscoveryRequest, signal?: AbortSignal) => Promise<unknown>) | undefined
  let internalConfigValidator: ((fiber: unknown, next: () => unknown) => unknown) | undefined
  const fakeFiber = { entry: { options: { id: 'llm-pi-ai' } } }

  const fakeContext = {
    fiber: fakeFiber,
    inject: () => undefined,
    on(event: unknown, listener: unknown) {
      if (event === 'internal/config' && typeof listener === 'function') {
        internalConfigValidator = listener as (fiber: unknown, next: () => unknown) => unknown
      }
      return () => undefined
    },
    get: () => undefined,
    effect: () => () => undefined,
    waterfall: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    llm: {
      registerConfigurableProviders(entries: unknown) {
        if (!Array.isArray(entries)) return { replace: () => undefined }
        for (const entry of entries) {
          const parsed = asConfigurableProvider(entry)
          if (parsed) catalogProviders.push(parsed)
        }
        return { replace: () => undefined }
      },
      registerModelDiscovery(_namespace: string, fn: (request: DshModelDiscoveryRequest, signal?: AbortSignal) => Promise<unknown>) {
        discoverFn = fn
        return () => undefined
      },
      registerAdapter: () => ({ replace: () => undefined }),
      registerProvider: () => () => undefined,
    },
  }

  applyFn(fakeContext, ConfigFn({}))

  const rawProtocols = typeof supportedProtocolsFn === 'function' ? supportedProtocolsFn() : undefined
  const protocols = Array.isArray(rawProtocols)
    ? rawProtocols.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']

  const deepseekModels: DshDiscoveredModel[] = []
  try {
    const deepseekModule = await importFromRequire(baseRequire, DEFAULT_DEEPSEEK_LLM_PACKAGE)
    if (typeof deepseekModule.resolveAdapterOptions === 'function') {
      const resolved = deepseekModule.resolveAdapterOptions({}) as unknown
      if (isRecord(resolved) && Array.isArray(resolved.models)) {
        for (const item of resolved.models) {
          const parsed = asDiscoveredModel(item)
          if (parsed) deepseekModels.push(parsed)
        }
      }
    }
    if (deepseekModels.length === 0 && Array.isArray(deepseekModule.DEFAULT_MODELS)) {
      for (const item of deepseekModule.DEFAULT_MODELS) {
        const parsed = asDiscoveredModel(item)
        if (parsed) deepseekModels.push(parsed)
      }
    }
  } catch {
    // Optional if DSH base version changes deepseek module packaging
  }

  let parseCredsFn: ((text: string, filename: string) => unknown) | undefined
  try {
    const credsModule = await importFromRequire(baseRequire, DEFAULT_CREDENTIALS_LOCAL_PACKAGE)
    if (typeof credsModule.parseCredentialsDocument === 'function') {
      parseCredsFn = credsModule.parseCredentialsDocument as (text: string, filename: string) => unknown
    }
  } catch {
    // Optional if DSH base version changes credentials-local packaging
  }

  const dshPath = boundHost.dshPath ?? findExecutableInPath('dsh', env, platform)

  return {
    ...(hostVersion ? { hostVersion } : {}),
    ...(dshPath ? { dshPath } : {}),
    dshPackageJsonPath,
    protocols,
    catalogProviders: catalogProviders.sort((a, b) => a.provider.localeCompare(b.provider)),
    deepseekModels,
    async discoverModels(request: DshModelDiscoveryRequest, signal?: AbortSignal): Promise<DshDiscoveredModel[]> {
      if (!discoverFn) return []
      const result = await discoverFn(request, signal)
      if (!Array.isArray(result)) return []
      const models: DshDiscoveredModel[] = []
      for (const entry of result) {
        const parsed = asDiscoveredModel(entry)
        if (parsed) models.push(parsed)
      }
      return models
    },
    ...(internalConfigValidator
      ? {
          validateProvidersConfig(providers: Record<string, unknown>): void {
            try {
              internalConfigValidator!(fakeFiber, () => ({ providers }))
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              throw new ProviderCommandError(`DSH llm-pi-ai 配置校验失败：${message}`, PROVIDER_EXIT_USAGE)
            }
          },
        }
      : {}),
    ...(parseCredsFn
      ? {
          validateCredentialsDocument(source: string, filename: string): void {
            try {
              parseCredsFn!(source, filename)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              throw new ProviderCommandError(`DSH .credentials.yaml 校验失败：${message}`)
            }
          },
        }
      : {}),
  }
}

export function resolveDshExecutablePath(input: {
  dshHome: string
  boundHost?: BoundHostInspection
  runtimeDshPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): string | undefined {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const candidates = [
    env.DSH_BIN,
    input.boundHost?.dshPath,
    input.runtimeDshPath,
    findExecutableInPath('dsh', env, platform),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

export async function defaultDumpProfileConfig(input: {
  dshPath: string
  dshHome: string
  profile: string
  env: NodeJS.ProcessEnv
  detailedRunner?: DetailedCommandRunner
}): Promise<ParsedDumpConfig> {
  const runner = input.detailedRunner ?? defaultDetailedRunner
  const runEnv: NodeJS.ProcessEnv = { ...input.env, DSH_HOME: input.dshHome }
  const result = runner(input.dshPath, ['--profile', input.profile, '--dump-config'], {
    env: runEnv,
    timeoutMs: 15_000,
  })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit=${result.status}`
    throw new ProviderCommandError(`dsh --profile ${input.profile} --dump-config 校验失败：${detail}`, PROVIDER_EXIT_VERIFY)
  }
  if (/patch:\s*entry\s+"?(?:llm-pi-ai|agent-default-model)"?\s+not found/iu.test(result.stderr)) {
    throw new ProviderCommandError(
      `profile "${input.profile}" 尚未挂载 @deepseek-ai/dsh-base 核心包，无法定位 llm-pi-ai / agent-default-model：${result.stderr.trim()}`,
      PROVIDER_EXIT_VERIFY,
    )
  }

  const trimmed = result.stdout.trim()
  if (trimmed === '') {
    return { profile: input.profile, rows: [] }
  }

  let schemaVersion: number | undefined
  let profile = input.profile
  let rawRows: readonly unknown[]
  let rawYaml: string | undefined

  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ProviderCommandError(`无法解析 --dump-config 输出 JSON：${message}`, PROVIDER_EXIT_VERIFY)
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.rows)) {
      throw new ProviderCommandError('--dump-config 输出缺少 rows 数组。', PROVIDER_EXIT_VERIFY)
    }
    if (typeof parsed.schemaVersion === 'number') schemaVersion = parsed.schemaVersion
    if (typeof parsed.profile === 'string') profile = parsed.profile
    rawRows = parsed.rows
  } else {
    const doc = parseDocument(trimmed, { customTags: PATCH_CUSTOM_TAGS })
    if (doc.errors.length > 0) {
      throw new ProviderCommandError(
        `无法解析 --dump-config 输出 YAML：${doc.errors[0]?.message ?? 'YAML 语法错误'}`,
        PROVIDER_EXIT_VERIFY,
      )
    }
    const yamlRows: unknown = doc.toJS()
    if (!Array.isArray(yamlRows)) {
      throw new ProviderCommandError('--dump-config YAML 输出顶层不是列表。', PROVIDER_EXIT_VERIFY)
    }
    rawRows = yamlRows
    rawYaml = trimmed
  }

  const rows: DumpConfigRowSummary[] = []
  for (const rawRow of rawRows) {
    if (!isRecord(rawRow) || typeof rawRow.id !== 'string' || typeof rawRow.name !== 'string') continue
    rows.push({
      id: rawRow.id,
      name: rawRow.name,
      ...(typeof rawRow.disabled === 'boolean' ? { disabled: rawRow.disabled } : {}),
      ...(isRecord(rawRow.config) ? { config: rawRow.config } : {}),
    })
  }
  return {
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    profile,
    rows,
    ...(rawYaml !== undefined ? { rawYaml } : {}),
  }
}

export function extractConfiguredProviders(config: Record<string, unknown> | undefined): ConfiguredPiAiProvider[] {
  if (!config) return []
  const rawProviders = config.providers
  if (!isRecord(rawProviders)) return []
  const configured: ConfiguredPiAiProvider[] = []
  for (const [provider, rawProfile] of Object.entries(rawProviders)) {
    if (!isRecord(rawProfile)) continue
    const models: string[] = []
    if (Array.isArray(rawProfile.models)) {
      for (const item of rawProfile.models) {
        if (isRecord(item) && typeof item.id === 'string' && item.id.length > 0) {
          models.push(item.id)
        }
      }
    }
    configured.push({
      provider,
      ...(typeof rawProfile.apiKeyEnv === 'string' && rawProfile.apiKeyEnv.length > 0 ? { apiKeyEnv: rawProfile.apiKeyEnv } : {}),
      ...(typeof rawProfile.baseURL === 'string' && rawProfile.baseURL.length > 0 ? { baseURL: rawProfile.baseURL } : {}),
      ...(typeof rawProfile.api === 'string' && rawProfile.api.length > 0 ? { api: rawProfile.api } : {}),
      ...(typeof rawProfile.displayName === 'string' && rawProfile.displayName.length > 0 ? { displayName: rawProfile.displayName } : {}),
      models,
    })
  }
  return configured.sort((a, b) => a.provider.localeCompare(b.provider))
}

function extractRawProvidersRecord(config: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> {
  if (!config || !isRecord(config.providers)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [provider, rawProfile] of Object.entries(config.providers)) {
    if (isRecord(rawProfile)) {
      out[provider] = structuredClone(rawProfile)
    }
  }
  return out
}

function parsePatchDocument(source: string): Document.Parsed {
  const doc = parseDocument(source, { customTags: PATCH_CUSTOM_TAGS })
  if (doc.errors.length > 0) {
    throw new ProviderCommandError(
      `profile 的 cordis.patch.yml 解析失败：${doc.errors[0]?.message ?? 'YAML 语法错误'}`,
    )
  }
  return doc
}

function rowMatchesTarget(row: YAMLMap<unknown, unknown>, targetId: string, targetNames: readonly string[]): boolean {
  const idValue = row.get('id')
  if (idValue === targetId) return true
  const nameValue = row.get('name')
  return typeof nameValue === 'string' && targetNames.includes(nameValue)
}

function collectPatchRowsInOrder(seq: YAMLSeq<unknown>): YAMLMap<unknown, unknown>[] {
  const rows: YAMLMap<unknown, unknown>[] = []
  for (const item of seq.items) {
    if (!isMap(item)) continue
    const map = item as YAMLMap<unknown, unknown>
    if (map.has('id') || map.has('name')) rows.push(map)
    const inserted = map.get('insert', true)
    if (isSeq(inserted)) {
      for (const subItem of inserted.items) {
        if (isMap(subItem)) rows.push(subItem as YAMLMap<unknown, unknown>)
      }
    }
  }
  return rows
}

function findLastPatchRow(
  doc: Document.Parsed,
  targetId: string,
  targetNames: readonly string[],
): YAMLMap<unknown, unknown> | undefined {
  if (!isSeq(doc.contents)) return undefined
  let matched: YAMLMap<unknown, unknown> | undefined
  for (const row of collectPatchRowsInOrder(doc.contents as YAMLSeq<unknown>)) {
    if (rowMatchesTarget(row, targetId, targetNames)) {
      matched = row
    }
  }
  return matched
}

function readRowConfigMap(row: YAMLMap<unknown, unknown> | undefined): Record<string, unknown> | undefined {
  if (!row) return undefined
  const configNode = row.get('config', true)
  if (!isMap(configNode)) return undefined
  const js = configNode.toJSON() as unknown
  return isRecord(js) ? js : undefined
}

function findLastDumpRow(
  rows: readonly DumpConfigRowSummary[],
  targetId: string,
  targetNames: readonly string[],
): DumpConfigRowSummary | undefined {
  let matched: DumpConfigRowSummary | undefined
  for (const row of rows) {
    if (row.id === targetId || targetNames.includes(row.name)) {
      matched = row
    }
  }
  return matched
}

function parsePatchSummaryFromSource(source: string): {
  defaultProvider?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  configuredProviders: ConfiguredPiAiProvider[]
  rawProviders: Record<string, Record<string, unknown>>
  acpDisabled?: boolean
  acpEnabled?: boolean
  acpAgyEnabled?: boolean
} {
  const trimmed = source.trim()
  if (!trimmed) {
    return { configuredProviders: [], rawProviders: {} }
  }
  const doc = parsePatchDocument(source)
  const defaultRow = findLastPatchRow(doc, 'agent-default-model', [DEFAULT_AGENT_DEFAULT_MODEL_PLUGIN_NAME, 'agent-default-model'])
  const piAiRow = findLastPatchRow(doc, 'llm-pi-ai', [DEFAULT_PI_AI_PLUGIN_NAME, 'llm-pi-ai'])
  const acpRow = findLastPatchRow(doc, DEFAULT_ACP_ROW_ID, [DEFAULT_ACP_PACKAGE, DEFAULT_ACP_ROW_ID])

  const defaultCfg = readRowConfigMap(defaultRow)
  const piAiCfg = readRowConfigMap(piAiRow)
  const acpCfg = readRowConfigMap(acpRow)
  const acpDisabled = acpRow?.get('disabled')

  return {
    ...(typeof defaultCfg?.provider === 'string' ? { defaultProvider: defaultCfg.provider } : {}),
    ...(typeof defaultCfg?.model === 'string' ? { defaultModel: defaultCfg.model } : {}),
    ...(typeof defaultCfg?.reasoningEffort === 'string' ? { defaultReasoningEffort: defaultCfg.reasoningEffort } : {}),
    configuredProviders: extractConfiguredProviders(piAiCfg),
    rawProviders: extractRawProvidersRecord(piAiCfg),
    ...(typeof acpDisabled === 'boolean' ? { acpDisabled } : {}),
    ...(typeof acpCfg?.enabled === 'boolean' ? { acpEnabled: acpCfg.enabled } : {}),
    ...(typeof acpCfg?.agyEnabled === 'boolean' ? { acpAgyEnabled: acpCfg.agyEnabled } : {}),
  }
}

export async function inspectProfileProviderState(input: {
  dshHome: string
  profile: string
  runtime?: DshProviderRuntime
  dshPath?: string
  env?: NodeJS.ProcessEnv
  dumpProfileConfig?: ProviderRuntimeDependencies['dumpProfileConfig']
}): Promise<ProfileProviderState> {
  const env = input.env ?? process.env
  const patchPath = join(profilesDirectory(input.dshHome), input.profile, 'cordis.patch.yml')
  const homePatchPath = join(input.dshHome, 'cordis.patch.yml')
  const credentialsPath = join(input.dshHome, '.credentials.yaml')

  const [patchSource, homePatchSource, credSource, pluginList] = await Promise.all([
    readFile(patchPath, 'utf8').catch(() => ''),
    readFile(homePatchPath, 'utf8').catch(() => ''),
    readFile(credentialsPath, 'utf8').catch(() => ''),
    listProfilePlugins(input.dshHome, input.profile).then(items => items.map(item => item.name)).catch(() => [] as string[]),
  ])

  let credentialsInsecureMode: number | undefined
  try {
    const meta = statSync(credentialsPath)
    if (meta.isFile() && (meta.mode & 0o077) !== 0) {
      credentialsInsecureMode = meta.mode & 0o777
    }
  } catch {
    // missing .credentials.yaml is normal
  }

  const credentialRefs = credSource ? extractCredentialKeyNames(credSource) : []
  const localSummary = parsePatchSummaryFromSource(patchSource)
  let homeSummary: ReturnType<typeof parsePatchSummaryFromSource> | undefined
  if (homePatchSource.trim().length > 0) {
    try {
      homeSummary = parsePatchSummaryFromSource(homePatchSource)
    } catch {
      // ignore invalid home patch here; dump-config will report it
    }
  }
  const homeOverrideDefaultModel = Boolean(homeSummary?.defaultProvider || homeSummary?.defaultModel)
  const homeOverrideProviders = homeSummary
    ? Object.keys(homeSummary.rawProviders).sort()
    : []

  let effectiveSummary = localSummary
  let dumpedAcpInstalled = false
  if ((input.dshPath || input.dumpProfileConfig) && existsSync(patchPath)) {
    try {
      const dumper = input.dumpProfileConfig ?? (params => defaultDumpProfileConfig(params))
      const dumped = await dumper({
        dshPath: input.dshPath ?? 'dsh',
        dshHome: input.dshHome,
        profile: input.profile,
        env,
      })
      const defaultRow = findLastDumpRow(dumped.rows, 'agent-default-model', [DEFAULT_AGENT_DEFAULT_MODEL_PLUGIN_NAME, 'agent-default-model'])
      const piAiRow = findLastDumpRow(dumped.rows, 'llm-pi-ai', [DEFAULT_PI_AI_PLUGIN_NAME, 'llm-pi-ai'])
      const acpRow = findLastDumpRow(dumped.rows, DEFAULT_ACP_ROW_ID, [DEFAULT_ACP_PACKAGE, DEFAULT_ACP_ROW_ID])
      if (acpRow) dumpedAcpInstalled = true
      const defaultCfg = defaultRow?.config
      const acpCfg = acpRow?.config
      effectiveSummary = {
        ...(typeof defaultCfg?.provider === 'string'
          ? { defaultProvider: defaultCfg.provider }
          : localSummary.defaultProvider ? { defaultProvider: localSummary.defaultProvider } : {}),
        ...(typeof defaultCfg?.model === 'string'
          ? { defaultModel: defaultCfg.model }
          : localSummary.defaultModel ? { defaultModel: localSummary.defaultModel } : {}),
        ...(typeof defaultCfg?.reasoningEffort === 'string'
          ? { defaultReasoningEffort: defaultCfg.reasoningEffort }
          : localSummary.defaultReasoningEffort ? { defaultReasoningEffort: localSummary.defaultReasoningEffort } : {}),
        configuredProviders: piAiRow
          ? extractConfiguredProviders(piAiRow.config)
          : localSummary.configuredProviders,
        rawProviders: piAiRow
          ? extractRawProvidersRecord(piAiRow.config)
          : localSummary.rawProviders,
        ...(acpRow?.disabled !== undefined ? { acpDisabled: acpRow.disabled } : localSummary.acpDisabled !== undefined ? { acpDisabled: localSummary.acpDisabled } : {}),
        ...(typeof acpCfg?.enabled === 'boolean' ? { acpEnabled: acpCfg.enabled } : localSummary.acpEnabled !== undefined ? { acpEnabled: localSummary.acpEnabled } : {}),
        ...(typeof acpCfg?.agyEnabled === 'boolean' ? { acpAgyEnabled: acpCfg.agyEnabled } : localSummary.acpAgyEnabled !== undefined ? { acpAgyEnabled: localSummary.acpAgyEnabled } : {}),
      }
    } catch {
      // Fall back to direct cordis.patch.yml summary if --dump-config fails
    }
  }

  const acpInstalled = dumpedAcpInstalled || pluginList.includes(DEFAULT_ACP_PACKAGE) || pluginList.some(p => p.includes('traex'))

  return {
    profile: input.profile,
    patchPath,
    ...(input.runtime?.hostVersion ? { dshVersion: input.runtime.hostVersion } : {}),
    ...(input.dshPath ? { dshPath: input.dshPath } : {}),
    ...(effectiveSummary.defaultProvider ? { defaultProvider: effectiveSummary.defaultProvider } : {}),
    ...(effectiveSummary.defaultModel ? { defaultModel: effectiveSummary.defaultModel } : {}),
    ...(effectiveSummary.defaultReasoningEffort ? { defaultReasoningEffort: effectiveSummary.defaultReasoningEffort } : {}),
    configuredProviders: effectiveSummary.configuredProviders,
    rawProviders: effectiveSummary.rawProviders,
    availablePlugins: pluginList,
    credentialRefs,
    ...(credentialsInsecureMode !== undefined ? { credentialsInsecureMode } : {}),
    acpInstalled,
    ...(effectiveSummary.acpDisabled !== true && effectiveSummary.acpEnabled === true ? { acpEnabled: true } : { acpEnabled: false }),
    ...(effectiveSummary.acpDisabled !== true && effectiveSummary.acpAgyEnabled === true ? { acpAgyEnabled: true } : { acpAgyEnabled: false }),
    ...(homeOverrideDefaultModel ? { homeOverrideDefaultModel: true } : {}),
    ...(homeOverrideProviders.length > 0 ? { homeOverrideProviders } : {}),
  }
}

async function readManagedCoordinatorProfiles(dshHome: string): Promise<Set<string>> {
  const coordinatorProfiles = new Set<string>()
  let entries: string[]
  try {
    entries = await readdir(dshHome)
  } catch {
    return coordinatorProfiles
  }
  for (const name of entries) {
    if (!name.startsWith('.rsi-coordinator-') || !name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dshHome, name), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (
        isRecord(parsed)
        && typeof parsed.coordinatorProfile === 'string'
        && parsed.coordinatorProfile.trim() !== ''
      ) {
        coordinatorProfiles.add(parsed.coordinatorProfile)
      }
    } catch {
      // ignore unreadable/malformed coordinator markers
    }
  }
  return coordinatorProfiles
}

export async function selectTargetProfile(
  dshHome: string,
  explicitProfile?: string,
  prompter?: ProviderPrompter,
  isTTY = false,
): Promise<string> {
  const coordinatorProfiles = await readManagedCoordinatorProfiles(dshHome)

  if (explicitProfile !== undefined) {
    if (!isValidProfileName(explicitProfile)) {
      throw new ProviderCommandError(`非法的 profile 名称：${explicitProfile}`, PROVIDER_EXIT_USAGE)
    }
    if (coordinatorProfiles.has(explicitProfile)) {
      throw new ProviderCommandError(
        `profile "${explicitProfile}" 是受管自迭代协调器内部 profile，不能配置或修改模型 Provider；请针对主 profile（如 web）操作。`,
        PROVIDER_EXIT_USAGE,
      )
    }
    const dir = join(profilesDirectory(dshHome), explicitProfile)
    if (!existsSync(dir)) {
      throw new ProviderCommandError(
        `profile "${explicitProfile}" 不存在（未找到 ${dir}）。请先运行 dsh-ray status 查看可用 profile。`,
        PROVIDER_EXIT_USAGE,
      )
    }
    return explicitProfile
  }

  const profiles = (await listProfiles(dshHome)).filter(profile => !coordinatorProfiles.has(profile))
  if (profiles.length === 0) {
    throw new ProviderCommandError(
      `在 ${dshHome} 下未找到任何可用 profile。请先运行 dsh-ray install 初始化实例。`,
      PROVIDER_EXIT_USAGE,
    )
  }
  if (profiles.length === 1) return profiles[0]!
  if (!isTTY || !prompter) {
    if (profiles.includes('web')) return 'web'
    throw new ProviderCommandError(
      `检测到多个 profile（${profiles.join(', ')}），请传入 --profile <name> 指定目标。`,
      PROVIDER_EXIT_USAGE,
    )
  }

  const defaultCandidate = profiles.includes('web') ? 'web' : profiles[0]!
  const answer = (await prompter.ask(
    `选择目标 profile（可用：${profiles.join(', ')}）[默认 ${defaultCandidate}]：`,
  )).trim()
  if (!answer) return defaultCandidate
  if (!profiles.includes(answer)) {
    throw new ProviderCommandError(`profile "${answer}" 不在可选列表中（${profiles.join(', ')}）。`, PROVIDER_EXIT_USAGE)
  }
  return answer
}

/**
 * Check whether legacy $DSH_HOME/settings.yaml still defines llm-pi-ai / agent-default-model
 * when the target profile does not already manage them in cordis.patch.yml.
 */
async function checkLegacySettingsConflict(dshHome: string): Promise<string | undefined> {
  const legacyPath = join(dshHome, 'settings.yaml')
  if (!existsSync(legacyPath)) return undefined
  try {
    const source = await readFile(legacyPath, 'utf8')
    const doc = parseDocument(source)
    const parsed: unknown = doc.toJS()
    if (!isRecord(parsed)) return undefined
    const conflicts: string[] = []
    if ('agent-default-model' in parsed) conflicts.push('agent-default-model')
    if ('llm-pi-ai' in parsed) conflicts.push('llm-pi-ai')
    if (conflicts.length === 0) return undefined
    return `检测到遗留 ${legacyPath} 仍包含 ${conflicts.join(', ')}；DSH 0.2 启动后才会将其迁移到 profile/cordis.patch.yml。`
  } catch {
    return undefined
  }
}

async function atomicWriteFile(filePath: string, content: string, fileMode: number, dirMode = 0o700): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: dirMode })
  try {
    await chmod(dir, dirMode)
  } catch {
    // best-effort permission hardening on POSIX
  }
  const tempPath = join(dir, `.${filePath.split('/').pop() ?? 'tmp'}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`)
  await writeFile(tempPath, content, { encoding: 'utf8', mode: fileMode })
  try {
    await chmod(tempPath, fileMode)
  } catch {
    // best-effort permission hardening
  }
  try {
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export function renderUpdatedCredentialsYaml(
  existingSource: string | undefined,
  update: { set?: { key: string; value: string }; removeKey?: string },
): { content: string; changed: boolean } {
  const doc = existingSource && existingSource.trim().length > 0
    ? parseDocument(existingSource)
    : new Document({})

  if (doc.errors.length > 0) {
    throw new ProviderCommandError(
      `.credentials.yaml 解析失败，请先修复语法错误后再修改：${doc.errors[0]?.message ?? 'YAML error'}`,
    )
  }

  let root = doc.contents
  if (!isMap(root)) {
    doc.contents = doc.createNode({})
    root = doc.contents
  }

  const rootObj = doc.toJS() as unknown
  const rootRecord = isRecord(rootObj) ? rootObj : {}
  const isV1 = rootRecord.version === 1 || isRecord(rootRecord.refs)

  // Migrate pre-release flat credentials entries into v1 `refs:` so DSH 0.2 continues reading them.
  const migratedFlatEntries: Array<[string, string]> = []
  if (!isV1) {
    for (const [key, value] of Object.entries(rootRecord)) {
      if (key === 'version' || key === 'refs' || key === 'records') continue
      if (typeof value === 'string' && value.length > 0) {
        migratedFlatEntries.push([key, value])
      }
      doc.deleteIn([key])
    }
  }

  const hadVersion = rootRecord.version === 1
  if (!hadVersion) {
    doc.setIn(['version'], 1)
  }

  if (!doc.hasIn(['refs']) || !isMap(doc.getIn(['refs'], true))) {
    doc.setIn(['refs'], new YAMLMap())
  }

  for (const [flatKey, flatValue] of migratedFlatEntries) {
    if (!doc.hasIn(['refs', flatKey])) {
      doc.setIn(['refs', flatKey], flatValue)
    }
  }

  let changed = !hadVersion || migratedFlatEntries.length > 0
  if (update.set) {
    const existingValue = doc.getIn(['refs', update.set.key])
    if (existingValue !== update.set.value) {
      doc.setIn(['refs', update.set.key], update.set.value)
      changed = true
    }
  }
  if (update.removeKey) {
    if (doc.hasIn(['refs', update.removeKey])) {
      doc.deleteIn(['refs', update.removeKey])
      changed = true
    }
  }

  const rendered = doc.toString({ lineWidth: 0 })
  return {
    content: rendered.endsWith('\n') ? rendered : `${rendered}\n`,
    changed,
  }
}

export interface ProviderPatchUpdateInput {
  existingSource: string
  piAiUpdates?: {
    upsertProvider?: {
      id: string
      profile: Record<string, unknown>
      ensureModelIds?: readonly string[]
      clearApiKeyEnv?: boolean
    }
    removeProviderId?: string
    baselineProviders?: Record<string, unknown>
    preferredRowName?: string
  }
  defaultModelUpdate?: {
    provider: string
    model: string
    reasoningEffort?: string
    preserveReasoningEffort?: boolean
    preferredRowName?: string
  }
  acpAgentUpdate?: {
    enableKey: 'enabled' | 'agyEnabled'
    seedConfigAst?: YAMLMap<unknown, unknown>
    insertIfMissing?: boolean
  }
}

function makeJsScalar(expr: string): Scalar {
  const scalar = new Scalar(expr)
  scalar.tag = 'tag:yaml.org,2002:js'
  scalar.type = Scalar.PLAIN
  return scalar
}

function ensureModelsInSeq(doc: Document.Parsed, providerMap: YAMLMap<unknown, unknown>, modelIds: readonly string[]): void {
  if (modelIds.length === 0) return
  let modelsNode: unknown = providerMap.get('models', true)
  if (!isSeq(modelsNode)) {
    const seqNode = new YAMLSeq<unknown>()
    providerMap.set('models', seqNode)
    modelsNode = seqNode
  }
  const modelsSeq = modelsNode as YAMLSeq<unknown>
  const existingIds = new Set<string>()
  for (const item of modelsSeq.items) {
    if (isMap(item)) {
      const id = (item as YAMLMap<unknown, unknown>).get('id')
      if (typeof id === 'string' && id.length > 0) existingIds.add(id)
    }
  }
  for (const id of modelIds) {
    if (!existingIds.has(id)) {
      modelsSeq.add(doc.createNode({ id, name: id }))
      existingIds.add(id)
    }
  }
}

export function renderUpdatedCordisPatchYaml(input: ProviderPatchUpdateInput): { content: string; changed: boolean } {
  const source = input.existingSource.trim().length > 0 ? input.existingSource : '[]\n'
  const doc = parsePatchDocument(source)

  if (!isSeq(doc.contents)) {
    throw new ProviderCommandError('cordis.patch.yml 顶层必须是 YAML 列表（sequence）。')
  }

  const seq = doc.contents as YAMLSeq<unknown>
  if (seq.items.length === 0) {
    seq.flow = false
  }
  let changed = false

  if (input.piAiUpdates) {
    const { upsertProvider, removeProviderId, baselineProviders, preferredRowName } = input.piAiUpdates
    const piAiRow = findLastPatchRow(doc, 'llm-pi-ai', [DEFAULT_PI_AI_PLUGIN_NAME, 'llm-pi-ai'])

    if (upsertProvider) {
      if (!piAiRow) {
        const providersObj: Record<string, unknown> = baselineProviders ? structuredClone(baselineProviders) : {}
        const baseForId = isRecord(providersObj[upsertProvider.id])
          ? structuredClone(providersObj[upsertProvider.id] as Record<string, unknown>)
          : {}
        if (upsertProvider.clearApiKeyEnv) {
          delete baseForId.apiKeyEnv
        }
        for (const [k, v] of Object.entries(upsertProvider.profile)) {
          if (v !== undefined) baseForId[k] = v
        }
        providersObj[upsertProvider.id] = baseForId

        const rowNode = doc.createNode({
          id: 'llm-pi-ai',
          name: preferredRowName ?? DEFAULT_PI_AI_PLUGIN_NAME,
          config: { providers: providersObj },
        }) as unknown as YAMLMap<unknown, unknown>
        if (upsertProvider.ensureModelIds && upsertProvider.ensureModelIds.length > 0) {
          const cfgNode: unknown = rowNode.get('config', true)
          if (isMap(cfgNode)) {
            const providersNode: unknown = cfgNode.get('providers', true)
            if (isMap(providersNode)) {
              const providerMap: unknown = providersNode.get(upsertProvider.id, true)
              if (isMap(providerMap)) {
                ensureModelsInSeq(doc, providerMap as YAMLMap<unknown, unknown>, upsertProvider.ensureModelIds)
              }
            }
          }
        }
        seq.add(rowNode)
        changed = true
      } else {
        if (piAiRow.get('disabled') === true) {
          piAiRow.delete('disabled')
          changed = true
        }
        let rawConfigNode: unknown = piAiRow.get('config', true)
        if (!isMap(rawConfigNode)) {
          rawConfigNode = doc.createNode({ providers: baselineProviders ?? {} })
          piAiRow.set('config', rawConfigNode)
        }
        const configNode = rawConfigNode as YAMLMap<unknown, unknown>
        let rawProvidersNode: unknown = configNode.get('providers', true)
        if (!isMap(rawProvidersNode)) {
          rawProvidersNode = doc.createNode(baselineProviders ?? {})
          configNode.set('providers', rawProvidersNode)
        }
        const providersNode = rawProvidersNode as YAMLMap<unknown, unknown>
        const existingProviderNode = providersNode.get(upsertProvider.id, true)
        if (isMap(existingProviderNode)) {
          const providerMap = existingProviderNode as YAMLMap<unknown, unknown>
          if (upsertProvider.clearApiKeyEnv && providerMap.has('apiKeyEnv')) {
            providerMap.delete('apiKeyEnv')
          }
          for (const [k, v] of Object.entries(upsertProvider.profile)) {
            if (v === undefined) continue
            if (k === 'models' && Array.isArray(v)) {
              const ids = v
                .filter((entry): entry is { id: string } => isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0)
                .map(entry => entry.id)
              ensureModelsInSeq(doc, providerMap, ids)
            } else {
              providerMap.set(k, doc.createNode(v))
            }
          }
          if (upsertProvider.ensureModelIds && upsertProvider.ensureModelIds.length > 0) {
            ensureModelsInSeq(doc, providerMap, upsertProvider.ensureModelIds)
          }
        } else {
          const newProfile = structuredClone(upsertProvider.profile)
          if (upsertProvider.clearApiKeyEnv) {
            delete newProfile.apiKeyEnv
          }
          const createdMap = doc.createNode(newProfile) as YAMLMap<unknown, unknown>
          if (upsertProvider.ensureModelIds && upsertProvider.ensureModelIds.length > 0) {
            ensureModelsInSeq(doc, createdMap, upsertProvider.ensureModelIds)
          }
          providersNode.set(upsertProvider.id, createdMap)
        }
        changed = true
      }
    }

    if (removeProviderId) {
      if (piAiRow) {
        const configNode = piAiRow.get('config', true)
        const providersNode = isMap(configNode) ? (configNode as YAMLMap<unknown, unknown>).get('providers', true) : undefined
        if (isMap(providersNode) && (providersNode as YAMLMap<unknown, unknown>).has(removeProviderId)) {
          ;(providersNode as YAMLMap<unknown, unknown>).delete(removeProviderId)
          changed = true
        }
      } else if (baselineProviders && removeProviderId in baselineProviders) {
        const remaining: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(baselineProviders)) {
          if (key !== removeProviderId) remaining[key] = value
        }
        seq.add(doc.createNode({
          id: 'llm-pi-ai',
          name: preferredRowName ?? DEFAULT_PI_AI_PLUGIN_NAME,
          config: { providers: remaining },
        }))
        changed = true
      }
    }
  }

  if (input.acpAgentUpdate) {
    const { enableKey, seedConfigAst, insertIfMissing } = input.acpAgentUpdate
    const acpRow = findLastPatchRow(doc, DEFAULT_ACP_ROW_ID, [DEFAULT_ACP_PACKAGE, DEFAULT_ACP_ROW_ID])
    if (!acpRow) {
      const configNode = seedConfigAst ? seedConfigAst.clone() : new YAMLMap<unknown, unknown>()
      if (configNode.get('cwd', true) === undefined) {
        configNode.set('cwd', makeJsScalar("dshHomePath('assistant-workspace')"))
      }
      configNode.set(enableKey, true)
      const rowNode = doc.createNode({
        id: DEFAULT_ACP_ROW_ID,
        name: DEFAULT_ACP_PACKAGE,
        disabled: false,
      }) as YAMLMap<unknown, unknown>
      rowNode.set('config', configNode)
      if (insertIfMissing) {
        const insertMap = new YAMLMap<unknown, unknown>()
        const insertSeq = new YAMLSeq<unknown>()
        insertSeq.add(rowNode)
        insertMap.set('insert', insertSeq)
        seq.add(insertMap)
      } else {
        seq.add(rowNode)
      }
      changed = true
    } else {
      if (acpRow.get('disabled') === true) {
        acpRow.set('disabled', false)
        changed = true
      }
      let rawCfg: unknown = acpRow.get('config', true)
      if (!isMap(rawCfg)) {
        rawCfg = seedConfigAst ? seedConfigAst.clone() : new YAMLMap<unknown, unknown>()
        acpRow.set('config', rawCfg)
        changed = true
      }
      const cfgMap = rawCfg as YAMLMap<unknown, unknown>
      if (cfgMap.get('cwd', true) === undefined) {
        cfgMap.set('cwd', makeJsScalar("dshHomePath('assistant-workspace')"))
        changed = true
      }
      if (cfgMap.get(enableKey) !== true) {
        cfgMap.set(enableKey, true)
        changed = true
      }
    }
  }

  if (input.defaultModelUpdate) {
    const { provider, model, reasoningEffort, preserveReasoningEffort, preferredRowName } = input.defaultModelUpdate
    const defaultRow = findLastPatchRow(doc, 'agent-default-model', [DEFAULT_AGENT_DEFAULT_MODEL_PLUGIN_NAME, 'agent-default-model'])

    if (!defaultRow) {
      const newConfig: Record<string, unknown> = {
        provider,
        model,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      }
      seq.add(doc.createNode({
        id: 'agent-default-model',
        name: preferredRowName ?? DEFAULT_AGENT_DEFAULT_MODEL_PLUGIN_NAME,
        config: newConfig,
      }))
      changed = true
    } else {
      if (defaultRow.get('disabled') === true) {
        defaultRow.delete('disabled')
        changed = true
      }
      let rawCfg: unknown = defaultRow.get('config', true)
      if (!isMap(rawCfg)) {
        rawCfg = doc.createNode({})
        defaultRow.set('config', rawCfg)
      }
      const cfgMap = rawCfg as YAMLMap<unknown, unknown>
      const prevProvider = cfgMap.get('provider')
      const prevModel = cfgMap.get('model')
      const sameRoute = prevProvider === provider && prevModel === model
      if (prevProvider !== provider) {
        cfgMap.set('provider', provider)
        changed = true
      }
      if (prevModel !== model) {
        cfgMap.set('model', model)
        changed = true
      }
      if (reasoningEffort !== undefined) {
        if (cfgMap.get('reasoningEffort') !== reasoningEffort) {
          cfgMap.set('reasoningEffort', reasoningEffort)
          changed = true
        }
      } else if (!(preserveReasoningEffort && sameRoute)) {
        if (cfgMap.has('reasoningEffort')) {
          cfgMap.delete('reasoningEffort')
          changed = true
        }
      }
    }
  }

  const rendered = doc.toString({ lineWidth: 0 })
  return {
    content: rendered.endsWith('\n') ? rendered : `${rendered}\n`,
    changed,
  }
}

export interface RawSecretReaderState {
  buffer: string
  escapeState: 'none' | 'esc' | 'csi' | 'ss3'
}

export function consumeRawSecretChunk(
  state: RawSecretReaderState,
  text: string,
): { action: 'continue' | 'submit' | 'cancel' } {
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]!
    const code = ch.charCodeAt(0)

    if (state.escapeState === 'esc') {
      if (ch === '[') {
        state.escapeState = 'csi'
        continue
      }
      if (ch === 'O') {
        state.escapeState = 'ss3'
        continue
      }
      state.escapeState = 'none'
      continue
    }

    if (state.escapeState === 'csi') {
      if (code >= 0x40 && code <= 0x7e) {
        state.escapeState = 'none'
      }
      continue
    }

    if (state.escapeState === 'ss3') {
      state.escapeState = 'none'
      continue
    }

    if (ch === '\u0003') {
      return { action: 'cancel' }
    }
    if (ch === '\r' || ch === '\n' || ch === '\u0004') {
      return { action: 'submit' }
    }
    if (ch === '\u007f' || ch === '\b') {
      if (state.buffer.length > 0) {
        state.buffer = state.buffer.slice(0, -1)
      }
      continue
    }
    if (ch === '\u001b') {
      state.escapeState = 'esc'
      continue
    }
    if (ch >= ' ' && ch !== '\u007f') {
      state.buffer += ch
    }
  }
  return { action: 'continue' }
}

function defaultPrompter(stdout: { write: (chunk: string) => void }): ProviderPrompter {
  return {
    async ask(question: string): Promise<string> {
      const rl = createInterface({
        input: process.stdin,
        output: stdout as NodeJS.WritableStream,
      })
      try {
        return await rl.question(question)
      } catch {
        return ''
      } finally {
        rl.close()
      }
    },
    async askSecret(question: string): Promise<string> {
      const stdin = process.stdin
      if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
        const rl = createInterface({ input: stdin })
        try {
          stdout.write(question)
          return await rl.question('')
        } catch {
          return ''
        } finally {
          rl.close()
          stdout.write('\n')
        }
      }

      stdout.write(question)
      const wasRaw = stdin.isRaw
      stdin.setRawMode(true)
      stdin.resume()
      const readerState: RawSecretReaderState = {
        buffer: '',
        escapeState: 'none',
      }

      return await new Promise<string>((resolvePromise, rejectPromise) => {
        const cleanup = () => {
          stdin.off('data', onData)
          stdin.off('end', onEnd)
          try {
            stdin.setRawMode(wasRaw)
          } catch {
            // ignore restore errors if stdin closed
          }
          stdin.pause()
        }

        const onEnd = () => {
          cleanup()
          stdout.write('\n')
          resolvePromise(readerState.buffer)
        }

        const onData = (chunk: Buffer) => {
          const outcome = consumeRawSecretChunk(readerState, chunk.toString('utf8'))
          if (outcome.action === 'cancel') {
            cleanup()
            stdout.write('\n')
            rejectPromise(new ProviderCommandError('已取消输入。', PROVIDER_EXIT_USAGE))
            return
          }
          if (outcome.action === 'submit') {
            cleanup()
            stdout.write('\n')
            resolvePromise(readerState.buffer)
          }
        }

        stdin.on('data', onData)
        stdin.once('end', onEnd)
      })
    },
  }
}

function findMatchingCatalogProviders(catalog: readonly DshConfigurableProvider[], query: string): DshConfigurableProvider[] {
  const lower = query.trim().toLowerCase()
  const exact = catalog.find(entry => entry.provider.toLowerCase() === lower)
  if (exact) return [exact]
  return catalog.filter(entry =>
    entry.provider.toLowerCase().includes(lower)
    || entry.displayName.toLowerCase().includes(lower))
}

function resolveApiKeySource(input: {
  explicitEnvVar?: string
  apiKeyEnv?: string
  nativeAuth?: DshNativeAuthInfo
  env: NodeJS.ProcessEnv
}): { value?: string; sourceEnvVar?: string } {
  const candidates = [
    input.explicitEnvVar,
    DEFAULT_KEY_INPUT_ENV,
    input.apiKeyEnv,
    ...(input.nativeAuth?.env ?? []),
  ].filter((name): name is string => Boolean(name && name.length > 0))

  for (const name of candidates) {
    const val = input.env[name]
    if (val && val.trim().length > 0) {
      return { value: validateApiKeyValue(val), sourceEnvVar: name }
    }
  }
  return {}
}

function resolveDetectedLocalAgentRoutes(state: ProfileProviderState): string[] {
  const candidates: string[] = []
  if (state.acpInstalled || state.availablePlugins.includes(DEFAULT_ACP_PACKAGE)) {
    candidates.push('traex-agent', 'agy-agent')
  }
  for (const plugin of state.availablePlugins) {
    if (plugin.includes('traex')) candidates.push('traex-agent')
    if (plugin.includes('agy')) candidates.push('agy-agent')
  }
  return [...new Set(candidates)]
}

async function applyUpdatesWithVerificationAndRestart(input: {
  dshHome: string
  profile: string
  patchPath: string
  credentialsPath: string
  existingPatchSource: string
  existingCredentialsSource: string | undefined
  patchUpdate: ProviderPatchUpdateInput
  credentialsUpdate?: { set?: { key: string; value: string }; removeKey?: string }
  validateCredentialsDocument?: (source: string, filename: string) => void
  verifyAfterDump?: (dumped: ParsedDumpConfig) => void
  dryRun: boolean
  restart: boolean
  dshPath?: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  runner: CommandRunner
  dumpProfileConfig?: ProviderRuntimeDependencies['dumpProfileConfig']
  prompter?: ProviderPrompter
  interactiveRestartPrompt?: boolean
}): Promise<{
  restartedService?: boolean
  restartWarning?: string
  warnings: string[]
}> {
  const warnings: string[] = []
  const legacyWarning = await checkLegacySettingsConflict(input.dshHome)
  if (legacyWarning) warnings.push(legacyWarning)

  const patchRendered = renderUpdatedCordisPatchYaml(input.patchUpdate)
  const credRendered = input.credentialsUpdate
    ? renderUpdatedCredentialsYaml(input.existingCredentialsSource, input.credentialsUpdate)
    : undefined

  if (credRendered?.changed && input.validateCredentialsDocument) {
    input.validateCredentialsDocument(credRendered.content, input.credentialsPath)
  }

  if (input.dryRun) {
    return { warnings }
  }

  const hadExistingPatch = existsSync(input.patchPath)
  const hadExistingCreds = existsSync(input.credentialsPath)

  if (credRendered?.changed) {
    await atomicWriteFile(input.credentialsPath, credRendered.content, 0o600)
  }

  if (patchRendered.changed) {
    await atomicWriteFile(input.patchPath, patchRendered.content, 0o644)
  }

  if ((input.dshPath || input.dumpProfileConfig) && (patchRendered.changed || credRendered?.changed || Boolean(input.verifyAfterDump))) {
    const dumper = input.dumpProfileConfig ?? (params => defaultDumpProfileConfig(params))
    try {
      const dumped = await dumper({
        dshPath: input.dshPath ?? 'dsh',
        dshHome: input.dshHome,
        profile: input.profile,
        env: input.env,
      })
      input.verifyAfterDump?.(dumped)
    } catch (error) {
      // Roll back modified files on dump-config verification failure.
      if (patchRendered.changed) {
        if (hadExistingPatch) {
          await atomicWriteFile(input.patchPath, input.existingPatchSource, 0o644).catch(() => undefined)
        } else {
          await rm(input.patchPath, { force: true }).catch(() => undefined)
        }
      }
      if (credRendered?.changed) {
        if (hadExistingCreds && input.existingCredentialsSource !== undefined) {
          await atomicWriteFile(input.credentialsPath, input.existingCredentialsSource, 0o600).catch(() => undefined)
        } else {
          await rm(input.credentialsPath, { force: true }).catch(() => undefined)
        }
      }
      throw error
    }
  }

  let restartedService: boolean | undefined
  let restartWarning: string | undefined

  const running = findRunningProfiles([input.profile], input.runner)
  const managed = await inspectManagedServiceForDshHome(input.platform, input.home, input.profile, input.dshHome, input.runner)
  const isRunning = running.active.length > 0

  if (input.restart && managed.managed && isRunning) {
    let shouldRestart = true
    if (input.interactiveRestartPrompt && input.prompter) {
      const answer = (await input.prompter.ask(
        `检测到受管常驻服务（profile: ${input.profile}）正在运行，是否立即重启以加载新配置？[Y/n]：`,
      )).trim().toLowerCase()
      shouldRestart = answer === '' || answer === 'y' || answer === 'yes'
    }
    if (shouldRestart) {
      const outcome = await controlManagedService(input.platform, input.home, input.profile, 'restart', input.runner, false, input.dshHome)
      if (outcome.errors.length > 0) {
        restartedService = false
        restartWarning = `配置已保存，但重启受管服务失败：${outcome.errors.join('；')}`
        warnings.push(restartWarning)
      } else {
        restartedService = true
      }
    } else {
      warnings.push(`配置已保存，但未重启运行中的服务。可稍后执行 dsh-ray restart --profile ${input.profile}。`)
    }
  } else if (!input.restart && isRunning) {
    warnings.push(`已传 --no-restart，运行中的 ${input.profile} 需要手动重启后生效：dsh-ray restart --profile ${input.profile}`)
  } else if (isRunning && !managed.managed) {
    warnings.push(`检测到 ${input.profile} 正在前台运行（非受管服务），请重启该进程以加载最新 provider 配置。`)
  } else if (managed.managed && !isRunning) {
    warnings.push(`受管服务当前未运行，下次执行 dsh-ray start --profile ${input.profile} 时生效。`)
  }

  return {
    ...(restartedService !== undefined ? { restartedService } : {}),
    ...(restartWarning !== undefined ? { restartWarning } : {}),
    warnings,
  }
}

async function runListSubcommand(input: {
  dshHome: string
  args: ParsedProviderArgs
  runtime: DshProviderRuntime
  state: ProfileProviderState
  stdout: { write: (chunk: string) => void }
}): Promise<number> {
  const catalogList = input.runtime.catalogProviders.filter(entry => entry.declared !== true)
  const localAgents = resolveDetectedLocalAgentRoutes(input.state)
  const warnings: string[] = []
  if (input.state.credentialsInsecureMode !== undefined) {
    warnings.push(
      `.credentials.yaml 权限过宽（0${input.state.credentialsInsecureMode.toString(8)}），建议执行 chmod 600 ${join(input.dshHome, '.credentials.yaml')}。`,
    )
  }
  if (input.state.homeOverrideDefaultModel || (input.state.homeOverrideProviders?.length ?? 0) > 0) {
    warnings.push(
      `检测到顶层 ${join(input.dshHome, 'cordis.patch.yml')} 包含模型/Provider 覆盖配置，其优先级高于 profile "${input.state.profile}"。`,
    )
  }

  if (input.args.json) {
    input.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'list',
      profile: input.state.profile,
      dshVersion: input.state.dshVersion ?? null,
      dshPath: input.state.dshPath ?? null,
      defaultModel: input.state.defaultProvider || input.state.defaultModel
        ? {
            provider: input.state.defaultProvider ?? null,
            model: input.state.defaultModel ?? null,
            ...(input.state.defaultReasoningEffort ? { reasoningEffort: input.state.defaultReasoningEffort } : {}),
          }
        : null,
      configuredProviders: input.state.configuredProviders,
      builtinRoutes: {
        deepseekOfficial: {
          models: input.runtime.deepseekModels.map(item => item.id),
          hasStoredKey: input.state.credentialRefs.includes('DEEPSEEK_API_KEY'),
        },
        localAgents: localAgents.map(id => ({
          provider: id,
          enabled: id === 'traex-agent' ? Boolean(input.state.acpEnabled) : Boolean(input.state.acpAgyEnabled),
        })),
      },
      credentialRefs: input.state.credentialRefs,
      supportedProtocols: input.runtime.protocols,
      builtinCatalogProviders: catalogList.map(entry => ({
        provider: entry.provider,
        displayName: entry.displayName,
        ...(entry.defaultBaseURL ? { defaultBaseURL: entry.defaultBaseURL } : {}),
        ...(entry.baseURLEnv ? { baseURLEnv: entry.baseURLEnv } : {}),
        ...(entry.nativeAuth ? { nativeAuth: entry.nativeAuth } : {}),
      })),
      ...(warnings.length > 0 ? { warnings } : {}),
    }, null, 2)}\n`)
    return 0
  }

  const lines: string[] = []
  lines.push(`DSH Home: ${input.dshHome}`)
  lines.push(`Profile:  ${input.state.profile}`)
  if (input.state.dshVersion) {
    lines.push(`DSH Host: ${input.state.dshVersion}${input.state.dshPath ? ` (${input.state.dshPath})` : ''}`)
  }
  lines.push('')
  if (input.state.defaultProvider && input.state.defaultModel) {
    lines.push(`当前默认模型：${input.state.defaultProvider} / ${input.state.defaultModel}${input.state.defaultReasoningEffort ? ` (reasoning: ${input.state.defaultReasoningEffort})` : ''}`)
  } else {
    lines.push('当前默认模型：未显式配置 agent-default-model')
  }

  lines.push('')
  lines.push('内置直连 / 本地宿主路由：')
  const dsModels = input.runtime.deepseekModels.map(item => item.id)
  lines.push(`  - deepseek-official: models=${dsModels.length > 0 ? dsModels.join(',') : 'deepseek-flash'} · DEEPSEEK_API_KEY ${input.state.credentialRefs.includes('DEEPSEEK_API_KEY') ? '[已在 .credentials.yaml]' : '[环境变量或未写入]'}`)
  for (const agentId of localAgents) {
    const enabled = agentId === 'traex-agent' ? Boolean(input.state.acpEnabled) : Boolean(input.state.acpAgyEnabled)
    lines.push(`  - ${agentId}: ${enabled ? '已启用' : '未启用'}（${DEFAULT_ACP_PACKAGE} · model=default）`)
  }

  lines.push('')
  lines.push(`已配置 llm-pi-ai 三方路由（${input.state.configuredProviders.length}）：`)
  if (input.state.configuredProviders.length === 0) {
    lines.push('  （暂无）')
  } else {
    for (const item of input.state.configuredProviders) {
      const authDesc = item.apiKeyEnv
        ? `apiKeyEnv=${item.apiKeyEnv}${input.state.credentialRefs.includes(item.apiKeyEnv) ? ' [已在 .credentials.yaml]' : ' [待环境/未写入]'}`
        : 'native/ambient auth'
      const details = [
        item.api ? `api=${item.api}` : undefined,
        item.baseURL ? `baseURL=${item.baseURL}` : undefined,
        item.models.length > 0 ? `models=${item.models.join(',')}` : undefined,
        authDesc,
      ].filter(Boolean).join(' · ')
      lines.push(`  - ${item.provider}${item.displayName ? ` (${item.displayName})` : ''}: ${details}`)
    }
  }

  lines.push('')
  lines.push(`支持协议（DSH supportedProtocols）：${input.runtime.protocols.join(', ')}`)
  lines.push(`DSH 内置支持的三方 Provider 目录（共 ${catalogList.length} 个）：`)
  const popular = catalogList.filter(entry => POPULAR_THIRD_PARTY_PROVIDERS.includes(entry.provider as typeof POPULAR_THIRD_PARTY_PROVIDERS[number]))
  const others = catalogList.filter(entry => !POPULAR_THIRD_PARTY_PROVIDERS.includes(entry.provider as typeof POPULAR_THIRD_PARTY_PROVIDERS[number]))
  if (popular.length > 0) {
    lines.push('  常用：')
    for (const entry of popular) {
      lines.push(`    ${entry.provider.padEnd(18)} ${entry.displayName}${entry.defaultBaseURL ? `  (${entry.defaultBaseURL})` : ''}`)
    }
  }
  if (others.length > 0) {
    lines.push(`  其他（${others.length}）：${others.map(entry => entry.provider).join(', ')}`)
  }
  if (warnings.length > 0) {
    lines.push('')
    for (const warning of warnings) {
      lines.push(`! ${warning}`)
    }
  }
  lines.push('')
  lines.push('运行 `dsh-ray provider` 进入交互式引导配置，或使用 `dsh-ray provider --provider <id> ...` 快速配置。')

  input.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

function formatOutcomeHuman(outcome: ProviderCommandOutcome): string {
  const prefix = outcome.dryRun ? '【dry-run】' : ''
  if (outcome.action === 'remove') {
    const lines = [
      `${prefix}已从 profile "${outcome.profile}" 移除三方 Provider "${outcome.provider}"。`,
      ...(outcome.removedCredentialRef ? [`- 已清理凭据引用：refs.${outcome.removedCredentialRef}`] : []),
      `- Patch: ${outcome.patchPath}`,
      ...(outcome.restartedService ? [`- 已重启受管服务（${outcome.profile}）`] : []),
      ...outcome.warnings.map(warning => `! ${warning}`),
    ]
    return `${lines.join('\n')}\n`
  }

  const lines = [
    `${prefix}已完成 profile "${outcome.profile}" 的模型 Provider 配置：`,
    `- Provider: ${outcome.provider}${outcome.kind ? ` (${outcome.kind})` : ''}`,
    ...(outcome.model ? [`- 默认模型：${outcome.setAsDefault ? `${outcome.provider} / ${outcome.model}` : `${outcome.model}（未覆盖当前默认模型）`}`] : []),
    ...(outcome.api ? [`- 协议：${outcome.api}`] : []),
    ...(outcome.baseURL ? [`- Base URL: ${outcome.baseURL}`] : []),
    ...(outcome.apiKeyEnv ? [`- 凭据引用：${outcome.apiKeyEnv}${outcome.storedCredentialRef ? '（已写入 .credentials.yaml refs）' : ''}`] : []),
    `- Patch: ${outcome.patchPath}`,
    ...(outcome.restartedService ? [`- 已重启受管服务（${outcome.profile}）`] : []),
    ...outcome.warnings.map(warning => `! ${warning}`),
  ]
  return `${lines.join('\n')}\n`
}

async function runRemoveSubcommand(input: {
  dshHome: string
  args: ParsedProviderArgs
  runtime: DshProviderRuntime
  state: ProfileProviderState
  dshPath?: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  runner: CommandRunner
  stdout: { write: (chunk: string) => void }
  dumpProfileConfig?: ProviderRuntimeDependencies['dumpProfileConfig']
  prompter?: ProviderPrompter
  isTTY: boolean
}): Promise<number> {
  const rawId = input.args.provider
  if (!rawId) {
    throw new ProviderCommandError('请指定要移除的 provider ID：dsh-ray provider remove <providerId>', PROVIDER_EXIT_USAGE)
  }
  const providerId = validateProviderId(rawId)
  const localAgents = resolveDetectedLocalAgentRoutes(input.state)
  if (
    providerId === 'deepseek-official'
    || localAgents.includes(providerId)
    || providerId === 'traex-agent'
    || providerId === 'agy-agent'
  ) {
    throw new ProviderCommandError(
      `"${providerId}" 是 DSH 内置或本地宿主 Agent 路由，不是可移除的 llm-pi-ai 三方 Provider；如需切换默认模型请运行：dsh-ray provider --provider <other>`,
      PROVIDER_EXIT_USAGE,
    )
  }

  const existing = input.state.configuredProviders.find(item => item.provider === providerId)
  if (!existing) {
    throw new ProviderCommandError(`profile "${input.state.profile}" 中未找到已配置的 llm-pi-ai provider "${providerId}"。`, PROVIDER_EXIT_USAGE)
  }

  const homePatchPath = join(input.dshHome, 'cordis.patch.yml')
  const [existingPatchSource, homePatchSource, existingCredentialsSource] = await Promise.all([
    readFile(input.state.patchPath, 'utf8').catch(() => ''),
    readFile(homePatchPath, 'utf8').catch(() => ''),
    readFile(join(input.dshHome, '.credentials.yaml'), 'utf8').catch(() => undefined),
  ])

  const localSummary = parsePatchSummaryFromSource(existingPatchSource)
  if (
    !localSummary.configuredProviders.some(item => item.provider === providerId)
    && input.state.homeOverrideProviders?.includes(providerId)
  ) {
    throw new ProviderCommandError(
      `provider "${providerId}" 定义在顶层 ${homePatchPath} 中（而非 profile "${input.state.profile}" 的 cordis.patch.yml），请直接检查或编辑 ${homePatchPath}。`,
      PROVIDER_EXIT_USAGE,
    )
  }

  const warnings: string[] = []
  if (input.state.defaultProvider === providerId) {
    if (!input.args.yes && !input.args.dryRun) {
      if (!input.isTTY || !input.prompter) {
        throw new ProviderCommandError(
          `"${providerId}" 当前是 profile "${input.state.profile}" 的默认模型（${input.state.defaultProvider}/${input.state.defaultModel}）。如确认移除请加 --yes。`,
          PROVIDER_EXIT_USAGE,
        )
      }
      const confirm = (await input.prompter.ask(
        `"${providerId}" 当前是默认模型（${input.state.defaultProvider}/${input.state.defaultModel ?? ''}），移除后需重新设置默认模型。确认移除？[y/N]：`,
      )).trim().toLowerCase()
      if (confirm !== 'y' && confirm !== 'yes') {
        throw new ProviderCommandError('已取消移除操作。', PROVIDER_EXIT_USAGE)
      }
    }
    warnings.push(`"${providerId}" 当前仍是 agent-default-model，请尽快通过 dsh-ray provider 切换默认模型。`)
  }

  const derivedRef = deriveKeyRef(providerId)
  let shouldRemoveCred = !input.args.keepKey
    && existing.apiKeyEnv === derivedRef
    && input.state.credentialRefs.includes(derivedRef)

  if (shouldRemoveCred) {
    const referencedElsewhere: string[] = []
    for (const item of input.state.configuredProviders) {
      if (item.provider !== providerId && item.apiKeyEnv === derivedRef) {
        referencedElsewhere.push(`当前 profile 路由 ${item.provider}`)
      }
    }
    if (derivedRef === 'DEEPSEEK_API_KEY' && input.state.defaultProvider === 'deepseek-official') {
      referencedElsewhere.push('当前 profile 默认路由 deepseek-official')
    }

    if (homePatchSource.trim().length > 0) {
      try {
        const homeSummary = parsePatchSummaryFromSource(homePatchSource)
        if (
          homeSummary.configuredProviders.some(item => item.provider !== providerId && item.apiKeyEnv === derivedRef)
          || (derivedRef === 'DEEPSEEK_API_KEY' && homeSummary.defaultProvider === 'deepseek-official')
        ) {
          referencedElsewhere.push(homePatchPath)
        }
      } catch {
        // ignore invalid home patch here; dump-config catches it if active
      }
    }

    const profiles = await listProfiles(input.dshHome)
    for (const siblingProfile of profiles) {
      if (siblingProfile === input.state.profile) continue
      const siblingPatchPath = join(profilesDirectory(input.dshHome), siblingProfile, 'cordis.patch.yml')
      const siblingSource = await readFile(siblingPatchPath, 'utf8').catch(() => '')
      if (!siblingSource.trim()) continue
      try {
        const siblingSummary = parsePatchSummaryFromSource(siblingSource)
        if (
          siblingSummary.configuredProviders.some(item => item.apiKeyEnv === derivedRef)
          || (derivedRef === 'DEEPSEEK_API_KEY' && siblingSummary.defaultProvider === 'deepseek-official')
        ) {
          referencedElsewhere.push(`profile "${siblingProfile}"`)
        }
      } catch {
        // ignore unreadable sibling patch
      }
    }

    if (referencedElsewhere.length > 0) {
      shouldRemoveCred = false
      warnings.push(`保留凭据 refs.${derivedRef}：仍被 ${referencedElsewhere.join('、')} 引用。`)
    }
  }

  let dumpedBefore: ParsedDumpConfig | undefined
  if ((input.dshPath || input.dumpProfileConfig) && existsSync(input.state.patchPath)) {
    const dumper = input.dumpProfileConfig ?? (params => defaultDumpProfileConfig(params))
    dumpedBefore = await dumper({
      dshPath: input.dshPath ?? 'dsh',
      dshHome: input.dshHome,
      profile: input.state.profile,
      env: input.env,
    }).catch(() => undefined)
  }

  const baselineProviders = buildEffectiveBaselineProvidersMap(input.state, dumpedBefore)
  delete baselineProviders[providerId]
  input.runtime.validateProvidersConfig?.(baselineProviders)

  const credentialsPath = join(input.dshHome, '.credentials.yaml')
  const applyResult = await applyUpdatesWithVerificationAndRestart({
    dshHome: input.dshHome,
    profile: input.state.profile,
    patchPath: input.state.patchPath,
    credentialsPath,
    existingPatchSource,
    existingCredentialsSource,
    patchUpdate: {
      existingSource: existingPatchSource,
      piAiUpdates: {
        removeProviderId: providerId,
        baselineProviders,
      },
    },
    ...(shouldRemoveCred ? { credentialsUpdate: { removeKey: derivedRef } } : {}),
    ...(input.runtime.validateCredentialsDocument
      ? { validateCredentialsDocument: input.runtime.validateCredentialsDocument }
      : {}),
    verifyAfterDump: dumpedAfter => {
      const piAiRow = findLastDumpRow(dumpedAfter.rows, 'llm-pi-ai', [DEFAULT_PI_AI_PLUGIN_NAME, 'llm-pi-ai'])
      const providersMap = piAiRow?.config && isRecord(piAiRow.config.providers)
        ? piAiRow.config.providers
        : undefined
      if (providersMap && Object.prototype.hasOwnProperty.call(providersMap, providerId)) {
        const overrideHint = input.state.homeOverrideProviders?.includes(providerId)
          ? `（检测到顶层 ${homePatchPath} 仍定义了 "${providerId}"）`
          : `（请检查 ${homePatchPath} 是否覆盖了 profile 配置）`
        throw new ProviderCommandError(
          `移除 "${providerId}" 后 DSH --dump-config 仍检测到该 Provider${overrideHint}，已回滚修改。`,
          PROVIDER_EXIT_VERIFY,
        )
      }
    },
    dryRun: input.args.dryRun,
    restart: input.args.restart,
    ...(input.dshPath ? { dshPath: input.dshPath } : {}),
    env: input.env,
    platform: input.platform,
    home: input.home,
    runner: input.runner,
    ...(input.dumpProfileConfig ? { dumpProfileConfig: input.dumpProfileConfig } : {}),
  })

  const outcome: ProviderCommandOutcome = {
    ok: true,
    action: 'remove',
    profile: input.state.profile,
    dryRun: input.args.dryRun,
    provider: providerId,
    ...(shouldRemoveCred ? { removedCredentialRef: derivedRef } : {}),
    ...(applyResult.restartedService !== undefined ? { restartedService: applyResult.restartedService } : {}),
    ...(applyResult.restartWarning !== undefined ? { restartWarning: applyResult.restartWarning } : {}),
    warnings: [...warnings, ...applyResult.warnings],
    patchPath: input.state.patchPath,
    credentialsPath,
  }

  if (input.args.json) {
    input.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
  } else {
    input.stdout.write(formatOutcomeHuman(outcome))
  }
  return 0
}

function buildEffectiveBaselineProvidersMap(
  state: ProfileProviderState,
  dumped?: ParsedDumpConfig,
): Record<string, unknown> {
  const row = dumped
    ? findLastDumpRow(dumped.rows, 'llm-pi-ai', [DEFAULT_PI_AI_PLUGIN_NAME, 'llm-pi-ai'])
    : undefined
  if (row?.config && isRecord(row.config.providers)) {
    return structuredClone(row.config.providers)
  }
  if (state.rawProviders && Object.keys(state.rawProviders).length > 0) {
    return structuredClone(state.rawProviders)
  }
  const fallback: Record<string, unknown> = {}
  for (const item of state.configuredProviders) {
    fallback[item.provider] = {
      ...(item.apiKeyEnv ? { apiKeyEnv: item.apiKeyEnv } : {}),
      ...(item.baseURL ? { baseURL: item.baseURL } : {}),
      ...(item.api ? { api: item.api } : {}),
      ...(item.displayName ? { displayName: item.displayName } : {}),
      ...(item.models.length > 0 ? { models: item.models.map(id => ({ id, name: id })) } : {}),
    }
  }
  return fallback
}

function extractAcpSeedConfigAst(dumped?: ParsedDumpConfig): YAMLMap<unknown, unknown> | undefined {
  if (!dumped?.rawYaml) return undefined
  try {
    const doc = parsePatchDocument(dumped.rawYaml)
    const acpRow = findLastPatchRow(doc, DEFAULT_ACP_ROW_ID, [DEFAULT_ACP_PACKAGE, DEFAULT_ACP_ROW_ID])
    const cfg: unknown = acpRow?.get('config', true)
    if (!isMap(cfg)) return undefined
    const cloned = (cfg as YAMLMap<unknown, unknown>).clone() as YAMLMap<unknown, unknown>
    const cwdNode = cloned.get('cwd', true)
    if (!(isScalar(cwdNode) && (cwdNode.tag === '!js' || cwdNode.tag === 'tag:yaml.org,2002:js'))) {
      cloned.delete('cwd')
    }
    return cloned
  } catch {
    return undefined
  }
}

function assertDefaultModelVerified(
  dumped: ParsedDumpConfig,
  expected: {
    provider: string
    model: string
    reasoningEffort?: string
    homePatchPath: string
    homeOverrideDefaultModel?: boolean
  },
): void {
  const defaultRow = findLastDumpRow(
    dumped.rows,
    'agent-default-model',
    [DEFAULT_AGENT_DEFAULT_MODEL_PLUGIN_NAME, 'agent-default-model'],
  )
  const actualProvider = typeof defaultRow?.config?.provider === 'string' ? defaultRow.config.provider : undefined
  const actualModel = typeof defaultRow?.config?.model === 'string' ? defaultRow.config.model : undefined
  const actualReasoning = typeof defaultRow?.config?.reasoningEffort === 'string'
    ? defaultRow.config.reasoningEffort
    : undefined

  if (
    !defaultRow
    || defaultRow.disabled === true
    || actualProvider !== expected.provider
    || actualModel !== expected.model
    || (expected.reasoningEffort !== undefined && actualReasoning !== expected.reasoningEffort)
  ) {
    const overrideHint = expected.homeOverrideDefaultModel
      ? `（检测到顶层 ${expected.homePatchPath} 覆盖了 agent-default-model）`
      : `（请检查 ${expected.homePatchPath} 是否覆盖了默认模型）`
    throw new ProviderCommandError(
      `写入后校验失败：DSH --dump-config 最终默认模型为 ${actualProvider ?? '未设置'}/${actualModel ?? '未设置'}，而非预期的 ${expected.provider}/${expected.model}${overrideHint}，已回滚修改。`,
      PROVIDER_EXIT_VERIFY,
    )
  }
}

async function runSetupSubcommand(input: {
  dshHome: string
  args: ParsedProviderArgs
  runtime: DshProviderRuntime
  state: ProfileProviderState
  dshPath?: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  runner: CommandRunner
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  dumpProfileConfig?: ProviderRuntimeDependencies['dumpProfileConfig']
  prompter: ProviderPrompter
  isTTY: boolean
  interactiveMode: boolean
}): Promise<number> {
  const catalogMap = new Map<string, DshConfigurableProvider>()
  for (const entry of input.runtime.catalogProviders) {
    if (entry.declared !== true) {
      catalogMap.set(entry.provider, entry)
    }
  }

  const args = { ...input.args }
  const interactiveMode = input.interactiveMode

  if (args.provider === undefined) {
    throw new ProviderCommandError(
      '非交互模式下未提供 --provider。请指定 --provider <id>（或先运行 dsh-ray provider list 查看全部支持的三方 Provider）。',
      PROVIDER_EXIT_USAGE,
    )
  }

  const providerId = validateProviderId(args.provider)
  const localAgentRoutes = resolveDetectedLocalAgentRoutes(input.state)

  let kind: ProviderCommandOutcome['kind']
  if (providerId === 'deepseek-official') {
    kind = 'deepseek-official'
  } else if (!args.custom && (localAgentRoutes.includes(providerId) || providerId === 'traex-agent' || providerId === 'agy-agent')) {
    kind = 'local-agent'
  } else if (catalogMap.has(providerId) && !args.custom) {
    kind = 'catalog'
  } else {
    kind = 'custom'
  }

  const existingConfigured = input.state.configuredProviders.find(item => item.provider === providerId)
  const catalogEntry = kind === 'catalog' ? catalogMap.get(providerId) : undefined

  if (args.api !== undefined && !input.runtime.protocols.includes(args.api)) {
    throw new ProviderCommandError(
      `不支持的 Wire 协议：${args.api}。当前 DSH 支持的协议：${input.runtime.protocols.join(', ')}`,
      PROVIDER_EXIT_USAGE,
    )
  }

  const validatedBaseURL = args.baseURL !== undefined ? validateBaseURL(args.baseURL) : undefined
  let resolvedModel = args.model?.trim()
  let discoveredModels: DshDiscoveredModel[] = []

  const existingPatchSource = await readFile(input.state.patchPath, 'utf8').catch(() => '')
  const credentialsPath = join(input.dshHome, '.credentials.yaml')
  const existingCredentialsSource = await readFile(credentialsPath, 'utf8').catch(() => undefined)
  const homePatchPath = join(input.dshHome, 'cordis.patch.yml')

  let patchUpdate: ProviderPatchUpdateInput
  let credentialsUpdate: { set?: { key: string; value: string }; removeKey?: string } | undefined
  let verifyAfterDump: ((dumped: ParsedDumpConfig) => void) | undefined
  let finalApiKeyEnv: string | undefined
  let storedCredentialRef: string | undefined
  let finalBaseURL = validatedBaseURL ?? existingConfigured?.baseURL ?? catalogEntry?.defaultBaseURL
  let finalApi = args.api ?? existingConfigured?.api

  if (kind === 'local-agent') {
    if (
      args.storeKey || args.promptKey || args.apiKeyEnv !== undefined
      || args.baseURL !== undefined || args.api !== undefined
      || args.displayName !== undefined || args.custom || args.discover || args.nativeAuth
    ) {
      throw new ProviderCommandError(
        `${providerId} 是本地宿主 Agent 插件路由，不支持 baseURL/api/API Key/--discover/--custom 参数；如需设为默认模型请去掉这些参数。`,
        PROVIDER_EXIT_USAGE,
      )
    }
    if (!input.state.acpInstalled) {
      throw new ProviderCommandError(
        `profile "${input.state.profile}" 未检测到本地 ACP 插件 ${DEFAULT_ACP_PACKAGE}，无法启用或切换 "${providerId}"。请先安装宿主 ACP 插件。`,
        PROVIDER_EXIT_USAGE,
      )
    }
    if (args.setDefault && !resolvedModel) {
      resolvedModel = providerId === input.state.defaultProvider && input.state.defaultModel
        ? input.state.defaultModel
        : 'default'
    }

    let dumpedBefore: ParsedDumpConfig | undefined
    if ((input.dshPath || input.dumpProfileConfig) && existsSync(input.state.patchPath)) {
      const dumper = input.dumpProfileConfig ?? (params => defaultDumpProfileConfig(params))
      dumpedBefore = await dumper({
        dshPath: input.dshPath ?? 'dsh',
        dshHome: input.dshHome,
        profile: input.state.profile,
        env: input.env,
      }).catch(() => undefined)
    }

    const enableKey: 'enabled' | 'agyEnabled' = providerId === 'agy-agent' ? 'agyEnabled' : 'enabled'
    const seedConfigAst = extractAcpSeedConfigAst(dumpedBefore)
    const alreadyInDumped = Boolean(
      dumpedBefore && findLastDumpRow(dumpedBefore.rows, DEFAULT_ACP_ROW_ID, [DEFAULT_ACP_PACKAGE, DEFAULT_ACP_ROW_ID]),
    )

    patchUpdate = {
      existingSource: existingPatchSource,
      acpAgentUpdate: {
        enableKey,
        ...(seedConfigAst ? { seedConfigAst } : {}),
        ...(dumpedBefore && !alreadyInDumped ? { insertIfMissing: true } : {}),
      },
      ...(args.setDefault && resolvedModel
        ? {
            defaultModelUpdate: {
              provider: providerId,
              model: resolvedModel,
              ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
              preserveReasoningEffort: args.reasoningEffort === undefined,
            },
          }
        : {}),
    }

    verifyAfterDump = dumpedAfter => {
      const acpRow = findLastDumpRow(dumpedAfter.rows, DEFAULT_ACP_ROW_ID, [DEFAULT_ACP_PACKAGE, DEFAULT_ACP_ROW_ID])
      if (!acpRow || acpRow.disabled === true || acpRow.config?.[enableKey] !== true) {
        throw new ProviderCommandError(
          `写入后校验失败：${DEFAULT_ACP_ROW_ID}.config.${enableKey} 在最终配置中未启用（请检查 ${homePatchPath} 是否覆盖了该插件），已回滚修改。`,
          PROVIDER_EXIT_VERIFY,
        )
      }
      if (args.setDefault && resolvedModel) {
        assertDefaultModelVerified(dumpedAfter, {
          provider: providerId,
          model: resolvedModel,
          ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
          homePatchPath,
          ...(input.state.homeOverrideDefaultModel !== undefined
            ? { homeOverrideDefaultModel: input.state.homeOverrideDefaultModel }
            : {}),
        })
      }
    }
  } else if (kind === 'deepseek-official') {
    if (
      args.baseURL !== undefined || args.api !== undefined
      || args.displayName !== undefined || args.custom || args.discover || args.nativeAuth
    ) {
      throw new ProviderCommandError(
        'deepseek-official 使用 DSH 内置 DeepSeek 直连模块，不支持 --base-url / --api / --display-name / --custom / --discover / --native-auth。',
        PROVIDER_EXIT_USAGE,
      )
    }

    const keyRef = args.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    finalApiKeyEnv = keyRef

    if (args.promptKey) {
      const entered = validateApiKeyValue(await input.prompter.askSecret(`请输入 ${keyRef}（输入内容不回显）：`))
      credentialsUpdate = { set: { key: keyRef, value: entered } }
      storedCredentialRef = keyRef
    } else if (args.storeKey) {
      const found = resolveApiKeySource({
        ...(args.keyEnvVar ? { explicitEnvVar: args.keyEnvVar } : {}),
        apiKeyEnv: keyRef,
        env: input.env,
      })
      if (!found.value) {
        throw new ProviderCommandError(
          `启用了 --store-key，但未在环境变量 ${args.keyEnvVar ?? DEFAULT_KEY_INPUT_ENV} 或 ${keyRef} 中找到有效 API Key。`,
          PROVIDER_EXIT_USAGE,
        )
      }
      credentialsUpdate = { set: { key: keyRef, value: found.value } }
      storedCredentialRef = keyRef
    }

    if (args.setDefault && !resolvedModel) {
      resolvedModel = input.state.defaultProvider === 'deepseek-official' && input.state.defaultModel
        ? input.state.defaultModel
        : input.runtime.deepseekModels[0]?.id ?? 'deepseek-flash'
    }

    if (!args.setDefault && !credentialsUpdate) {
      throw new ProviderCommandError(
        '对于 deepseek-official，请至少设置默认模型（移除 --no-default）或存储 API Key（--store-key / --prompt-key）。',
        PROVIDER_EXIT_USAGE,
      )
    }

    patchUpdate = {
      existingSource: existingPatchSource,
      ...(args.setDefault && resolvedModel
        ? {
            defaultModelUpdate: {
              provider: 'deepseek-official',
              model: resolvedModel,
              ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
              preserveReasoningEffort: args.reasoningEffort === undefined,
            },
          }
        : {}),
    }

    if (args.setDefault && resolvedModel) {
      verifyAfterDump = dumpedAfter => {
        assertDefaultModelVerified(dumpedAfter, {
          provider: 'deepseek-official',
          model: resolvedModel!,
          ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
          homePatchPath,
          ...(input.state.homeOverrideDefaultModel !== undefined
            ? { homeOverrideDefaultModel: input.state.homeOverrideDefaultModel }
            : {}),
        })
      }
    }
  } else {
    // catalog or custom via DSH llm-pi-ai
    const defaultRef = deriveKeyRef(providerId)
    let apiKeyToStore: string | undefined

    if (kind === 'custom') {
      finalBaseURL = validatedBaseURL ?? existingConfigured?.baseURL
      if (!finalBaseURL) {
        throw new ProviderCommandError(
          `自定义 Provider "${providerId}" 必须提供 --base-url <url>（如 https://api.example.com/v1）。`,
          PROVIDER_EXIT_USAGE,
        )
      }
      finalApi = args.api ?? existingConfigured?.api ?? 'openai-completions'
    }

    if (args.promptKey) {
      const targetRef = args.apiKeyEnv ?? existingConfigured?.apiKeyEnv ?? defaultRef
      apiKeyToStore = validateApiKeyValue(await input.prompter.askSecret(`请输入 ${providerId} 的 API Key（将写入 refs.${targetRef}，输入内容不回显）：`))
      finalApiKeyEnv = targetRef
      storedCredentialRef = targetRef
    } else if (args.storeKey) {
      const targetRef = args.apiKeyEnv ?? existingConfigured?.apiKeyEnv ?? defaultRef
      const found = resolveApiKeySource({
        ...(args.keyEnvVar ? { explicitEnvVar: args.keyEnvVar } : {}),
        apiKeyEnv: targetRef,
        ...(catalogEntry?.nativeAuth ? { nativeAuth: catalogEntry.nativeAuth } : {}),
        env: input.env,
      })
      if (!found.value) {
        const tried = [args.keyEnvVar, DEFAULT_KEY_INPUT_ENV, targetRef, ...(catalogEntry?.nativeAuth?.env ?? [])]
          .filter(Boolean)
          .join(', ')
        throw new ProviderCommandError(
          `启用了 --store-key，但未在以下环境变量中找到 API Key：${tried}。`,
          PROVIDER_EXIT_USAGE,
        )
      }
      apiKeyToStore = found.value
      finalApiKeyEnv = targetRef
      storedCredentialRef = targetRef
    } else if (!args.nativeAuth) {
      const nativeCredRef = catalogEntry?.nativeAuth?.env.find(envKey => input.state.credentialRefs.includes(envKey))
      const nativeEnvPresent = catalogEntry?.nativeAuth?.env.find(envKey => Boolean(input.env[envKey]?.trim()))
      if (args.apiKeyEnv) {
        finalApiKeyEnv = args.apiKeyEnv
      } else if (existingConfigured?.apiKeyEnv) {
        finalApiKeyEnv = existingConfigured.apiKeyEnv
      } else if (input.state.credentialRefs.includes(defaultRef) || Boolean(input.env[defaultRef]?.trim())) {
        finalApiKeyEnv = defaultRef
      } else if (nativeCredRef) {
        finalApiKeyEnv = nativeCredRef
      } else if (kind === 'catalog' && nativeEnvPresent) {
        finalApiKeyEnv = undefined
      } else if (kind === 'catalog' && !catalogEntry?.nativeAuth?.oauth && !catalogEntry?.nativeAuth?.env.length) {
        finalApiKeyEnv = defaultRef
      }
    }

    // Run DSH's own discoverModels when appropriate
    if (kind === 'catalog') {
      try {
        discoveredModels = await input.runtime.discoverModels({ provider: providerId })
      } catch {
        // Catalog discovery failure shouldn't block explicit configuration
      }
    } else if (args.discover || (!resolvedModel && (existingConfigured?.models.length ?? 0) === 0)) {
      const probeKey = apiKeyToStore
        ?? (finalApiKeyEnv ? input.env[finalApiKeyEnv] : undefined)
      try {
        discoveredModels = await input.runtime.discoverModels({
          ...(finalBaseURL ? { baseURL: finalBaseURL } : {}),
          ...(finalApi ? { api: finalApi } : {}),
          ...(probeKey ? { apiKey: probeKey } : {}),
        })
      } catch (error) {
        if (args.discover) {
          const message = error instanceof Error ? error.message : String(error)
          throw new ProviderCommandError(`调用 DSH discoverModels 探测 ${finalBaseURL} 失败：${message}`)
        }
      }
    }

    if (!resolvedModel) {
      const preservedDefault = args.setDefault && providerId === input.state.defaultProvider
        ? input.state.defaultModel
        : undefined
      if (preservedDefault) {
        resolvedModel = preservedDefault
      } else if (kind === 'catalog') {
        resolvedModel = discoveredModels[0]?.id ?? existingConfigured?.models[0]
      } else {
        resolvedModel = existingConfigured?.models[0] ?? discoveredModels[0]?.id
      }
    }

    if (kind === 'custom' && !resolvedModel) {
      throw new ProviderCommandError(
        `自定义 Provider "${providerId}" 需要至少一个模型 ID（通过 --model <id> 指定，或使用 --discover 自动拉取）。`,
        PROVIDER_EXIT_USAGE,
      )
    }

    if (args.setDefault && !resolvedModel) {
      throw new ProviderCommandError(
        `未解析出 "${providerId}" 的默认模型，请传入 --model <id>（或传 --no-default 仅配置 Provider）。`,
        PROVIDER_EXIT_USAGE,
      )
    }

    // Build llm-pi-ai provider profile adhering strictly to DSH Config schema while
    // preserving existing nested fields (headers, compat, timeoutMs, rich model definitions).
    const profileObj: Record<string, unknown> = {}
    if (finalApiKeyEnv) {
      profileObj.apiKeyEnv = finalApiKeyEnv
    }
    if (kind === 'custom' || validatedBaseURL !== undefined || existingConfigured?.baseURL) {
      if (finalBaseURL) profileObj.baseURL = finalBaseURL
    }
    if (kind === 'custom' || args.api !== undefined || existingConfigured?.api) {
      if (finalApi) profileObj.api = finalApi
    }
    const displayName = args.displayName ?? existingConfigured?.displayName
    if (displayName) {
      profileObj.displayName = displayName
    }

    let ensureModelIds: string[] | undefined
    if (kind === 'custom') {
      const modelIds = new Set(existingConfigured?.models ?? [])
      if (resolvedModel) modelIds.add(resolvedModel)
      if (modelIds.size > 0) {
        ensureModelIds = [...modelIds]
      }
    } else if (resolvedModel) {
      const inCatalog = discoveredModels.some(item => item.id === resolvedModel)
      if (
        (!inCatalog && discoveredModels.length > 0)
        || (discoveredModels.length === 0 && existingConfigured && existingConfigured.models.length > 0)
      ) {
        ensureModelIds = [resolvedModel]
      }
    }

    if (apiKeyToStore !== undefined && finalApiKeyEnv) {
      credentialsUpdate = { set: { key: finalApiKeyEnv, value: apiKeyToStore } }
    }

    let dumpedBefore: ParsedDumpConfig | undefined
    if ((input.dshPath || input.dumpProfileConfig) && existsSync(input.state.patchPath)) {
      const dumper = input.dumpProfileConfig ?? (params => defaultDumpProfileConfig(params))
      dumpedBefore = await dumper({
        dshPath: input.dshPath ?? 'dsh',
        dshHome: input.dshHome,
        profile: input.state.profile,
        env: input.env,
      }).catch(() => undefined)
    }

    const baselineProviders = buildEffectiveBaselineProvidersMap(input.state, dumpedBefore)
    const buildCandidateProviders = (modelIds?: readonly string[]): Record<string, unknown> => {
      const candidate = structuredClone(baselineProviders)
      const prev = isRecord(candidate[providerId])
        ? structuredClone(candidate[providerId] as Record<string, unknown>)
        : {}
      if (args.nativeAuth) {
        delete prev.apiKeyEnv
      }
      for (const [k, v] of Object.entries(profileObj)) {
        if (v !== undefined) prev[k] = v
      }
      if (modelIds && modelIds.length > 0) {
        const prevModels = Array.isArray(prev.models) ? structuredClone(prev.models) : []
        const seen = new Set(
          prevModels
            .map(entry => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined))
            .filter((entry): entry is string => Boolean(entry)),
        )
        for (const id of modelIds) {
          if (!seen.has(id)) {
            prevModels.push({ id, name: id })
            seen.add(id)
          }
        }
        prev.models = prevModels
      }
      candidate[providerId] = prev
      return candidate
    }

    if (input.runtime.validateProvidersConfig) {
      try {
        input.runtime.validateProvidersConfig(buildCandidateProviders(ensureModelIds))
      } catch (error) {
        if (
          kind === 'catalog'
          && resolvedModel
          && (!ensureModelIds || ensureModelIds.length === 0)
          && error instanceof Error
          && /no models/i.test(error.message)
        ) {
          ensureModelIds = [resolvedModel]
          input.runtime.validateProvidersConfig(buildCandidateProviders(ensureModelIds))
        } else {
          throw error
        }
      }
    }

    patchUpdate = {
      existingSource: existingPatchSource,
      piAiUpdates: {
        upsertProvider: {
          id: providerId,
          profile: profileObj,
          ...(ensureModelIds && ensureModelIds.length > 0 ? { ensureModelIds } : {}),
          ...(args.nativeAuth ? { clearApiKeyEnv: true } : {}),
        },
        baselineProviders,
      },
      ...(args.setDefault && resolvedModel
        ? {
            defaultModelUpdate: {
              provider: providerId,
              model: resolvedModel,
              ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
              preserveReasoningEffort: args.reasoningEffort === undefined,
            },
          }
        : {}),
    }

    verifyAfterDump = dumpedAfter => {
      const piAiRow = findLastDumpRow(dumpedAfter.rows, 'llm-pi-ai', [DEFAULT_PI_AI_PLUGIN_NAME, 'llm-pi-ai'])
      const providersMap = piAiRow?.config && isRecord(piAiRow.config.providers)
        ? piAiRow.config.providers
        : undefined
      const dumpedProvider = providersMap && isRecord(providersMap[providerId])
        ? providersMap[providerId]
        : undefined
      const overrideHint = input.state.homeOverrideProviders?.includes(providerId)
        ? `（检测到顶层 ${homePatchPath} 覆盖了 "${providerId}"）`
        : `（请检查 ${homePatchPath} 是否覆盖了配置）`

      if (!piAiRow || piAiRow.disabled === true || !dumpedProvider) {
        throw new ProviderCommandError(
          `写入后校验失败：DSH --dump-config 中未找到激活的 llm-pi-ai provider "${providerId}"${overrideHint}，已回滚修改。`,
          PROVIDER_EXIT_VERIFY,
        )
      }
      if (validatedBaseURL !== undefined && dumpedProvider.baseURL !== validatedBaseURL) {
        throw new ProviderCommandError(
          `写入后校验失败：${providerId}.baseURL 为 ${String(dumpedProvider.baseURL ?? '未设置')}，而非预期的 ${validatedBaseURL}${overrideHint}，已回滚修改。`,
          PROVIDER_EXIT_VERIFY,
        )
      }
      if (args.api !== undefined && dumpedProvider.api !== args.api) {
        throw new ProviderCommandError(
          `写入后校验失败：${providerId}.api 为 ${String(dumpedProvider.api ?? '未设置')}，而非预期的 ${args.api}${overrideHint}，已回滚修改。`,
          PROVIDER_EXIT_VERIFY,
        )
      }
      if (finalApiKeyEnv !== undefined && dumpedProvider.apiKeyEnv !== finalApiKeyEnv) {
        throw new ProviderCommandError(
          `写入后校验失败：${providerId}.apiKeyEnv 为 ${String(dumpedProvider.apiKeyEnv ?? '未设置')}，而非预期的 ${finalApiKeyEnv}${overrideHint}，已回滚修改。`,
          PROVIDER_EXIT_VERIFY,
        )
      }
      if (args.nativeAuth && typeof dumpedProvider.apiKeyEnv === 'string' && dumpedProvider.apiKeyEnv.length > 0) {
        throw new ProviderCommandError(
          `写入后校验失败：已启用 --native-auth，但 ${providerId}.apiKeyEnv 仍为 ${dumpedProvider.apiKeyEnv}${overrideHint}，已回滚修改。`,
          PROVIDER_EXIT_VERIFY,
        )
      }
      if (args.setDefault && resolvedModel) {
        assertDefaultModelVerified(dumpedAfter, {
          provider: providerId,
          model: resolvedModel,
          ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
          homePatchPath,
          ...(input.state.homeOverrideDefaultModel !== undefined
            ? { homeOverrideDefaultModel: input.state.homeOverrideDefaultModel }
            : {}),
        })
      }
    }
  }

  const applyResult = await applyUpdatesWithVerificationAndRestart({
    dshHome: input.dshHome,
    profile: input.state.profile,
    patchPath: input.state.patchPath,
    credentialsPath,
    existingPatchSource,
    existingCredentialsSource,
    patchUpdate,
    ...(credentialsUpdate ? { credentialsUpdate } : {}),
    ...(input.runtime.validateCredentialsDocument
      ? { validateCredentialsDocument: input.runtime.validateCredentialsDocument }
      : {}),
    ...(verifyAfterDump ? { verifyAfterDump } : {}),
    dryRun: args.dryRun,
    restart: args.restart,
    ...(input.dshPath ? { dshPath: input.dshPath } : {}),
    env: input.env,
    platform: input.platform,
    home: input.home,
    runner: input.runner,
    ...(input.dumpProfileConfig ? { dumpProfileConfig: input.dumpProfileConfig } : {}),
    prompter: input.prompter,
    interactiveRestartPrompt: interactiveMode && !args.dryRun && args.restart,
  })

  const extraWarnings: string[] = []
  if (input.state.credentialsInsecureMode !== undefined && !storedCredentialRef) {
    extraWarnings.push(
      `提示：${credentialsPath} 当前权限为 0${input.state.credentialsInsecureMode.toString(8)}，建议执行 chmod 600 ${credentialsPath}。`,
    )
  }
  if (
    finalApiKeyEnv
    && !storedCredentialRef
    && !input.state.credentialRefs.includes(finalApiKeyEnv)
    && !input.env[finalApiKeyEnv]?.trim()
  ) {
    extraWarnings.push(
      `提示：${finalApiKeyEnv} 尚未写入 .credentials.yaml 且当前环境变量未设置；可执行 dsh-ray provider --provider ${providerId} --prompt-key 安全录入（或在环境变量中提供 ${finalApiKeyEnv}）。`,
    )
  }

  const outcome: ProviderCommandOutcome = {
    ok: true,
    action: 'setup',
    profile: input.state.profile,
    dryRun: args.dryRun,
    provider: providerId,
    kind,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(finalApi ? { api: finalApi } : {}),
    ...(finalBaseURL ? { baseURL: finalBaseURL } : {}),
    ...(finalApiKeyEnv ? { apiKeyEnv: finalApiKeyEnv } : {}),
    ...(storedCredentialRef ? { storedCredentialRef } : {}),
    setAsDefault: args.setDefault,
    ...(discoveredModels.length > 0 && args.discover ? { discoveredModels } : {}),
    ...(applyResult.restartedService !== undefined ? { restartedService: applyResult.restartedService } : {}),
    ...(applyResult.restartWarning !== undefined ? { restartWarning: applyResult.restartWarning } : {}),
    warnings: [...extraWarnings, ...applyResult.warnings],
    patchPath: input.state.patchPath,
    credentialsPath,
  }

  if (args.json) {
    input.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
  } else {
    input.stdout.write(formatOutcomeHuman(outcome))
  }
  return 0
}

async function runInteractiveWizard(input: {
  args: ParsedProviderArgs
  runtime: DshProviderRuntime
  state: ProfileProviderState
  catalogMap: ReadonlyMap<string, DshConfigurableProvider>
  prompter: ProviderPrompter
  stdout: { write: (chunk: string) => void }
}): Promise<ParsedProviderArgs> {
  const { stdout, prompter, state, runtime, catalogMap } = input
  const next: ParsedProviderArgs = { ...input.args }

  stdout.write(`\nDSH Ray 模型 Provider 引导配置（profile: ${state.profile}${state.dshVersion ? `, DSH Host ${state.dshVersion}` : ''}）\n`)
  if (state.defaultProvider && state.defaultModel) {
    stdout.write(`当前默认模型：${state.defaultProvider} / ${state.defaultModel}\n`)
  } else {
    stdout.write('当前默认模型：未显式设置\n')
  }
  if (state.configuredProviders.length > 0) {
    stdout.write(`已配置三方路由：${state.configuredProviders.map(item => item.provider).join(', ')}\n`)
  }
  const localAgents = resolveDetectedLocalAgentRoutes(state)
  const quickCandidates: Array<{ provider: string; label: string }> = [
    ...state.configuredProviders.map(item => ({
      provider: item.provider,
      label: item.displayName || item.provider,
    })),
    ...(
      !state.configuredProviders.some(item => item.provider === 'deepseek-official')
      && (
        state.defaultProvider === 'deepseek-official'
        || state.credentialRefs.includes('DEEPSEEK_API_KEY')
        || state.configuredProviders.length > 0
        || localAgents.length > 0
      )
        ? [{ provider: 'deepseek-official', label: 'DeepSeek 官方直连（deepseek-official）' }]
        : []
    ),
    ...localAgents.map(id => ({ provider: id, label: `${id}（本地宿主 Agent）` })),
  ]
  const hasQuickSwitch = quickCandidates.length > 0

  stdout.write('\n请选择配置方式：\n')
  stdout.write(`  1) DSH 内置三方 Provider（已加载 ${catalogMap.size} 个内置 Provider：OpenAI / Anthropic / OpenRouter / Google / 月之暗面 / Kimi / MiniMax / 智谱等）\n`)
  stdout.write('  2) 自定义兼容 API / 自建中转网关（OpenAI / Anthropic / Gemini 协议 + 自定义 baseURL，支持模型探测）\n')
  stdout.write('  3) DeepSeek 官方直连（deepseek-official）\n')
  if (hasQuickSwitch) {
    stdout.write(`  4) 仅切换默认模型（现有/可用路由：${quickCandidates.map(item => item.provider).join(', ')}）\n`)
  }

  const modeAnswer = (await prompter.ask('输入选项编号 [默认 1]：')).trim() || '1'
  const allowedModes = hasQuickSwitch ? ['1', '2', '3', '4'] : ['1', '2', '3']
  if (!allowedModes.includes(modeAnswer)) {
    throw new ProviderCommandError(
      `无效的选项编号 "${modeAnswer}"，请输入 ${allowedModes.join(' / ')}。`,
      PROVIDER_EXIT_USAGE,
    )
  }

  if (modeAnswer === '3') {
    next.provider = 'deepseek-official'
    const models = runtime.deepseekModels.length > 0
      ? runtime.deepseekModels
      : [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]
    const preferredDefault = state.defaultProvider === 'deepseek-official' && state.defaultModel
      ? state.defaultModel
      : models[0]!.id
    if (!next.model) {
      stdout.write('\nDeepSeek 官方可选模型：\n')
      models.slice(0, 10).forEach((item, idx) => {
        stdout.write(`  ${idx + 1}) ${item.id}\n`)
      })
      const modelChoice = (await prompter.ask(`选择模型编号或直接输入模型 ID [默认 ${preferredDefault}]：`)).trim()
      if (!modelChoice) {
        next.model = preferredDefault
      } else {
        const asIndex = Number(modelChoice)
        next.model = Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= models.length
          ? models[asIndex - 1]!.id
          : modelChoice
      }
    }
    const existingHasKey = state.credentialRefs.includes('DEEPSEEK_API_KEY')
    const keyPrompt = existingHasKey
      ? '输入 DEEPSEEK_API_KEY（已存在，直接回车保留现有值，内容不回显）：'
      : '输入 DEEPSEEK_API_KEY（内容不回显，直接回车暂不写入）：'
    const rawKey = await prompter.askSecret(keyPrompt)
    if (rawKey.trim().length > 0) {
      const validated = validateApiKeyValue(rawKey)
      return {
        ...next,
        promptKey: true,
        _wizardSecret: validated,
      } as ParsedProviderArgs
    }
    return next
  }

  if (modeAnswer === '4' && hasQuickSwitch) {
    stdout.write('\n可切换的路由：\n')
    quickCandidates.forEach((item, idx) => {
      stdout.write(`  ${idx + 1}) ${item.provider}  ${item.label}\n`)
    })
    const pick = (await prompter.ask('选择编号或输入 provider ID：')).trim()
    const asIndex = Number(pick)
    const chosen = Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= quickCandidates.length
      ? quickCandidates[asIndex - 1]!.provider
      : pick
    if (!chosen) throw new ProviderCommandError('未选择任何路由。', PROVIDER_EXIT_USAGE)
    const isKnownRoute = quickCandidates.some(item => item.provider === chosen)
      || catalogMap.has(chosen)
      || chosen === 'deepseek-official'
      || localAgents.includes(chosen)
    if (!isKnownRoute) {
      throw new ProviderCommandError(
        `无效路由 "${chosen}"；请选择上述编号或已配置/内置 Provider ID。`,
        PROVIDER_EXIT_USAGE,
      )
    }
    next.provider = chosen
    next.setDefault = true
    if (localAgents.includes(chosen) && !next.model) {
      next.model = chosen === state.defaultProvider && state.defaultModel ? state.defaultModel : 'default'
    } else if (!localAgents.includes(chosen) && !next.model) {
      const configuredItem = state.configuredProviders.find(item => item.provider === chosen)
      let modelHints: readonly DshDiscoveredModel[] = []
      if (chosen === 'deepseek-official') {
        modelHints = runtime.deepseekModels.length > 0
          ? runtime.deepseekModels
          : [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]
      } else if (catalogMap.has(chosen)) {
        modelHints = await runtime.discoverModels({ provider: chosen }).catch(() => [])
      }
      const suggestions = [
        ...(chosen === state.defaultProvider && state.defaultModel ? [{ id: state.defaultModel }] : []),
        ...(configuredItem?.models ?? [])
          .filter(id => !(chosen === state.defaultProvider && id === state.defaultModel))
          .map(id => ({ id })),
        ...modelHints.filter(item =>
          !(configuredItem?.models ?? []).includes(item.id)
          && !(chosen === state.defaultProvider && item.id === state.defaultModel)),
      ]
      if (suggestions.length > 0) {
        stdout.write(`\n${chosen} 推荐/已配模型：\n`)
        suggestions.slice(0, 12).forEach((item, idx) => {
          stdout.write(`  ${idx + 1}) ${item.id}\n`)
        })
      }
      const modelInput = (await prompter.ask(
        `输入默认模型 ID${suggestions[0] ? ` [默认 ${suggestions[0].id}]` : ''}：`,
      )).trim()
      if (!modelInput && suggestions[0]) {
        next.model = suggestions[0].id
      } else {
        const mIdx = Number(modelInput)
        next.model = Number.isInteger(mIdx) && mIdx >= 1 && mIdx <= Math.min(suggestions.length, 12)
          ? suggestions[mIdx - 1]!.id
          : modelInput
      }
    }
    return next
  }

  if (modeAnswer === '2') {
    next.custom = true
    const routeId = (await prompter.ask('输入自定义 Provider ID（例如 my-gateway / litellm / vllm）：')).trim()
    if (!routeId) throw new ProviderCommandError('Provider ID 不能为空。', PROVIDER_EXIT_USAGE)
    next.provider = validateProviderId(routeId)
    const existingCustom = state.configuredProviders.find(item => item.provider === next.provider)

    stdout.write('\n选择 Wire 协议（DSH supportedProtocols）：\n')
    runtime.protocols.forEach((proto, idx) => {
      stdout.write(`  ${idx + 1}) ${proto}\n`)
    })
    const defaultProto = existingCustom?.api ?? runtime.protocols[0] ?? 'openai-completions'
    const protoAnswer = (await prompter.ask(`输入协议编号或名称 [默认 ${defaultProto}]：`)).trim()
    if (!protoAnswer) {
      next.api = defaultProto
    } else {
      const asIndex = Number(protoAnswer)
      next.api = Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= runtime.protocols.length
        ? runtime.protocols[asIndex - 1]!
        : protoAnswer
    }

    const rawUrl = (await prompter.ask(
      `输入端点 baseURL（如 https://api.example.com/v1${existingCustom?.baseURL ? `，直接回车保留 ${existingCustom.baseURL}` : ''}）：`,
    )).trim()
    next.baseURL = rawUrl ? validateBaseURL(rawUrl) : (existingCustom?.baseURL ? validateBaseURL(existingCustom.baseURL) : validateBaseURL(rawUrl))

    const displayName = (await prompter.ask('可选显示名称（直接回车跳过）：')).trim()
    if (displayName) next.displayName = displayName

    const keyRef = existingCustom?.apiKeyEnv ?? deriveKeyRef(next.provider)
    const existingHasRef = state.credentialRefs.includes(keyRef)
    const rawKey = await prompter.askSecret(
      existingHasRef
        ? `输入 API Key（将更新 refs.${keyRef}，直接回车保留现有值，输入不回显）：`
        : `输入 API Key（将写入 refs.${keyRef}，若无鉴权可直接回车跳过，输入不回显）：`,
    )

    let enteredKey: string | undefined
    if (rawKey.trim().length > 0) {
      enteredKey = validateApiKeyValue(rawKey)
      next.apiKeyEnv = keyRef
    } else if (existingHasRef) {
      next.apiKeyEnv = keyRef
    }

    let discovered: DshDiscoveredModel[] = []
    if (!next.model) {
      const probeAns = (await prompter.ask('是否立即调用 DSH discoverModels 探测端点模型列表？[Y/n]：')).trim().toLowerCase()
      if (probeAns === '' || probeAns === 'y' || probeAns === 'yes') {
        try {
          discovered = await runtime.discoverModels({
            baseURL: next.baseURL,
            api: next.api,
            ...(enteredKey ? { apiKey: enteredKey } : {}),
          })
          stdout.write(`探测到 ${discovered.length} 个模型。\n`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          stdout.write(`模型探测未返回结果（可手动输入模型 ID）：${message}\n`)
        }
      }
      if (discovered.length > 0) {
        stdout.write('\n端点返回模型（前 15 个）：\n')
        discovered.slice(0, 15).forEach((item, idx) => {
          stdout.write(`  ${idx + 1}) ${item.id}${item.name && item.name !== item.id ? ` (${item.name})` : ''}\n`)
        })
      }
      const fallbackModel = next.provider === state.defaultProvider && state.defaultModel
        ? state.defaultModel
        : discovered[0]?.id ?? existingCustom?.models[0]
      const modelInput = (await prompter.ask(
        `选择编号或输入模型 ID${fallbackModel ? ` [默认 ${fallbackModel}]` : ''}：`,
      )).trim()
      if (!modelInput && fallbackModel) {
        next.model = fallbackModel
      } else {
        const mIdx = Number(modelInput)
        next.model = Number.isInteger(mIdx) && mIdx >= 1 && mIdx <= Math.min(discovered.length, 15)
          ? discovered[mIdx - 1]!.id
          : modelInput
      }
    }

    const defaultAns = (await prompter.ask('是否将该模型设为当前 profile 的默认模型？[Y/n]：')).trim().toLowerCase()
    next.setDefault = defaultAns === '' || defaultAns === 'y' || defaultAns === 'yes'

    if (enteredKey !== undefined) {
      return { ...next, _wizardSecret: enteredKey } as ParsedProviderArgs
    }
    return next
  }

  // Mode 1: DSH built-in third-party catalog provider
  const catalogList = [...catalogMap.values()]
  const popular = POPULAR_THIRD_PARTY_PROVIDERS
    .map(id => catalogMap.get(id))
    .filter((entry): entry is DshConfigurableProvider => entry !== undefined)

  stdout.write('\n常用 DSH 内置三方 Provider：\n')
  popular.forEach((entry, idx) => {
    const authHint = entry.nativeAuth?.oauth
      ? 'OAuth / API Key'
      : entry.nativeAuth?.env.length
        ? `API Key / ${entry.nativeAuth.env.join(',')}`
        : 'API Key'
    stdout.write(`  ${String(idx + 1).padStart(2)}) ${entry.provider.padEnd(16)} ${entry.displayName}  [${authHint}]\n`)
  })
  stdout.write(`  (共 ${catalogList.length} 个内置 Provider；可输入编号、完整 ID 或关键词如 moonshot / zai / groq 搜索)\n`)

  let chosenEntry: DshConfigurableProvider | undefined
  while (!chosenEntry) {
    const rawPick = (await prompter.ask('选择编号、输入 Provider ID 或关键词：')).trim()
    if (!rawPick) throw new ProviderCommandError('未选择任何 Provider。', PROVIDER_EXIT_USAGE)
    const asIndex = Number(rawPick)
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= popular.length) {
      chosenEntry = popular[asIndex - 1]
      break
    }
    const matches = findMatchingCatalogProviders(catalogList, rawPick)
    if (matches.length === 1) {
      chosenEntry = matches[0]
      break
    }
    if (matches.length === 0) {
      stdout.write(`未找到匹配 "${rawPick}" 的内置 Provider，请重试（或回到方式 2 配置自定义 API）。\n`)
      continue
    }
    stdout.write('匹配到多个内置 Provider：\n')
    matches.slice(0, 15).forEach((entry, idx) => {
      stdout.write(`  ${idx + 1}) ${entry.provider.padEnd(18)} ${entry.displayName}\n`)
    })
    const subPick = (await prompter.ask('请输入精确 ID 或匹配编号：')).trim()
    const subIndex = Number(subPick)
    if (Number.isInteger(subIndex) && subIndex >= 1 && subIndex <= Math.min(matches.length, 15)) {
      chosenEntry = matches[subIndex - 1]
    } else {
      chosenEntry = catalogMap.get(subPick)
    }
    if (!chosenEntry) {
      stdout.write(`未找到 "${subPick}"，请重新输入。\n`)
    }
  }

  if (!chosenEntry) {
    throw new ProviderCommandError('未选择任何 Provider。', PROVIDER_EXIT_USAGE)
  }

  const existingForChosen = state.configuredProviders.find(item => item.provider === chosenEntry.provider)
  next.provider = chosenEntry.provider
  stdout.write(`\n已选择：${chosenEntry.provider} (${chosenEntry.displayName})\n`)
  if (chosenEntry.defaultBaseURL) {
    stdout.write(`默认 Base URL：${chosenEntry.defaultBaseURL}\n`)
  }
  if (chosenEntry.nativeAuth?.env.length || chosenEntry.nativeAuth?.oauth) {
    const hints = [
      ...(chosenEntry.nativeAuth.env.length ? [`环境变量 ${chosenEntry.nativeAuth.env.join(' / ')}`] : []),
      ...(chosenEntry.nativeAuth.oauth ? ['支持 DSH 原生 OAuth 登录'] : []),
    ]
    stdout.write(`原生鉴权方式：${hints.join('，')}\n`)
  }

  const overrideUrl = (await prompter.ask(
    `可选自定义 Base URL（直接回车使用${existingForChosen?.baseURL ? `当前 ${existingForChosen.baseURL}` : ` DSH 默认${chosenEntry.defaultBaseURL ? ` ${chosenEntry.defaultBaseURL}` : ''}`}）：`,
  )).trim()
  if (overrideUrl) {
    next.baseURL = validateBaseURL(overrideUrl)
  }

  const keyRef = existingForChosen?.apiKeyEnv ?? deriveKeyRef(chosenEntry.provider)
  const existingHasRef = state.credentialRefs.includes(keyRef)
  const nativeEnvHint = chosenEntry.nativeAuth?.env.join(', ')
  const secretPrompt = existingHasRef
    ? `输入 API Key（将更新 refs.${keyRef}，直接回车保留现有凭据，输入不回显）：`
    : nativeEnvHint || chosenEntry.nativeAuth?.oauth
      ? `输入 API Key（将写入 refs.${keyRef}，直接回车改用原生鉴权/OAuth，输入不回显）：`
      : `输入 API Key（将写入 refs.${keyRef}，直接回车跳过，输入不回显）：`

  const rawKey = await prompter.askSecret(secretPrompt)
  let enteredKey: string | undefined
  if (rawKey.trim().length > 0) {
    enteredKey = validateApiKeyValue(rawKey)
    next.apiKeyEnv = keyRef
  } else if (existingHasRef || existingForChosen?.apiKeyEnv) {
    next.apiKeyEnv = keyRef
  } else if (chosenEntry.nativeAuth?.oauth || chosenEntry.nativeAuth?.env.length) {
    next.nativeAuth = true
  }

  const defaultAns = (await prompter.ask('是否同时将其设为当前 profile 默认模型？[Y/n]：')).trim().toLowerCase()
  next.setDefault = defaultAns === '' || defaultAns === 'y' || defaultAns === 'yes'

  if (next.setDefault && !next.model) {
    const models = await runtime.discoverModels({ provider: chosenEntry.provider }).catch(() => [])
    const preferredDefault = chosenEntry.provider === state.defaultProvider && state.defaultModel
      ? state.defaultModel
      : models[0]?.id ?? existingForChosen?.models[0]
    let displayModels = models
    if (displayModels.length > 0) {
      stdout.write(`\n${chosenEntry.provider} 内置可选模型（共 ${displayModels.length} 个${displayModels.length > 15 ? '，显示前 15 个；可输入关键词过滤' : ''}）：\n`)
      displayModels.slice(0, 15).forEach((item, idx) => {
        stdout.write(`  ${idx + 1}) ${item.id}${item.name && item.name !== item.id ? ` (${item.name})` : ''}\n`)
      })
    }
    for (let attempt = 0; attempt < 3 && !next.model; attempt++) {
      const modelInput = (await prompter.ask(
        `选择编号${displayModels.length > 15 ? '、输入关键词过滤' : ''}或直接输入模型 ID${preferredDefault ? ` [默认 ${preferredDefault}]` : ''}：`,
      )).trim()
      if (!modelInput && preferredDefault) {
        next.model = preferredDefault
        break
      }
      const mIdx = Number(modelInput)
      if (Number.isInteger(mIdx) && mIdx >= 1 && mIdx <= Math.min(displayModels.length, 15)) {
        next.model = displayModels[mIdx - 1]!.id
        break
      }
      const exactMatch = models.find(item => item.id === modelInput)
      if (exactMatch) {
        next.model = exactMatch.id
        break
      }
      if (displayModels.length > 15 && modelInput.length > 0) {
        const queryLower = modelInput.toLowerCase()
        const filtered = models.filter(
          item => item.id.toLowerCase().includes(queryLower) || (item.name?.toLowerCase().includes(queryLower) ?? false),
        )
        if (filtered.length === 1) {
          next.model = filtered[0]!.id
          stdout.write(`匹配到唯一模型：${next.model}\n`)
          break
        }
        if (filtered.length > 1 && attempt < 2) {
          displayModels = filtered
          stdout.write(`\n匹配 "${modelInput}" 的模型（共 ${filtered.length} 个${filtered.length > 15 ? '，显示前 15 个' : ''}）：\n`)
          filtered.slice(0, 15).forEach((item, idx) => {
            stdout.write(`  ${idx + 1}) ${item.id}${item.name && item.name !== item.id ? ` (${item.name})` : ''}\n`)
          })
          continue
        }
      }
      next.model = modelInput
    }
  }

  if (enteredKey !== undefined) {
    return { ...next, _wizardSecret: enteredKey } as ParsedProviderArgs
  }
  return next
}

export async function runProvider(
  dshHome: string,
  argv: readonly string[],
  deps: ProviderRuntimeDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const home = deps.home ?? env.HOME ?? process.env.HOME ?? ''
  const runner = deps.runner ?? defaultRunner
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const basePrompter = deps.prompter ?? defaultPrompter(stdout)

  const args = parseProviderArgs(argv)
  if (args.action === 'help') {
    stdout.write(`${PROVIDER_HELP}\n`)
    return 0
  }

  if (args.action === 'setup' && args.provider === undefined && args.json) {
    throw new ProviderCommandError(
      '交互式引导不支持 --json 输出；非交互模式请传入 --provider <id>（或先运行 dsh-ray provider list --json）。',
      PROVIDER_EXIT_USAGE,
    )
  }

  const effectiveDshHome = args.dshHome ?? dshHome

  const runtime = await (deps.loadRuntime
    ? deps.loadRuntime({
        dshHome: effectiveDshHome,
        env,
        runner,
        ...(deps.readHostRuntime ? { readHostRuntime: deps.readHostRuntime } : {}),
      })
    : loadDshProviderRuntime({
        dshHome: effectiveDshHome,
        env,
        platform,
        ...(deps.readHostRuntime ? { readHostRuntime: deps.readHostRuntime } : {}),
      }))

  const boundHost = await inspectBoundHostRuntime(
    effectiveDshHome,
    deps.readHostRuntime ? { read: deps.readHostRuntime } : undefined,
  )
  const dshPath = resolveDshExecutablePath({
    dshHome: effectiveDshHome,
    boundHost,
    ...(runtime.dshPath ? { runtimeDshPath: runtime.dshPath } : {}),
    env,
    platform,
  })

  const profile = await selectTargetProfile(
    effectiveDshHome,
    args.profile,
    args.action === 'list' ? undefined : basePrompter,
    isTTY,
  )
  const state = await inspectProfileProviderState({
    dshHome: effectiveDshHome,
    profile,
    runtime,
    ...(dshPath ? { dshPath } : {}),
    env,
    ...(deps.dumpProfileConfig ? { dumpProfileConfig: deps.dumpProfileConfig } : {}),
  })

  if (args.action === 'list') {
    return await runListSubcommand({
      dshHome: effectiveDshHome,
      args,
      runtime,
      state,
      stdout,
    })
  }

  if (args.action === 'remove') {
    return await runRemoveSubcommand({
      dshHome: effectiveDshHome,
      args,
      runtime,
      state,
      ...(dshPath ? { dshPath } : {}),
      env,
      platform,
      home,
      runner,
      stdout,
      ...(deps.dumpProfileConfig ? { dumpProfileConfig: deps.dumpProfileConfig } : {}),
      prompter: basePrompter,
      isTTY,
    })
  }

  // Wrap prompter so interactive wizard passes entered secret cleanly without persisting extra properties
  let capturedWizardSecret: string | undefined
  const wizardPrompter: ProviderPrompter = {
    ask: question => basePrompter.ask(question),
    async askSecret(question: string): Promise<string> {
      if (capturedWizardSecret !== undefined) {
        const value = capturedWizardSecret
        capturedWizardSecret = undefined
        return value
      }
      return await basePrompter.askSecret(question)
    },
  }

  // Intercept wizard secret cleanly if returned via symbol-like private property
  const setupArgs = args.provider === undefined
    ? await (async () => {
        if (!isTTY) {
          throw new ProviderCommandError(
            '非交互模式下未提供 --provider。请指定 --provider <id>（或先运行 dsh-ray provider list 查看全部支持的三方 Provider）。',
            PROVIDER_EXIT_USAGE,
          )
        }
        const catalogMap = new Map<string, DshConfigurableProvider>()
        for (const entry of runtime.catalogProviders) {
          if (entry.declared !== true) catalogMap.set(entry.provider, entry)
        }
        const result = await runInteractiveWizard({
          args,
          runtime,
          state,
          catalogMap,
          prompter: basePrompter,
          stdout,
        }) as ParsedProviderArgs & { _wizardSecret?: string }
        if (result._wizardSecret !== undefined) {
          capturedWizardSecret = result._wizardSecret
          delete result._wizardSecret
          return { ...result, promptKey: true }
        }
        return result
      })()
    : args

  void stderr
  const interactiveMode = args.provider === undefined
  return await runSetupSubcommand({
    dshHome: effectiveDshHome,
    args: setupArgs,
    runtime,
    state,
    ...(dshPath ? { dshPath } : {}),
    env,
    platform,
    home,
    runner,
    stdout,
    stderr,
    ...(deps.dumpProfileConfig ? { dumpProfileConfig: deps.dumpProfileConfig } : {}),
    prompter: wizardPrompter,
    isTTY,
    interactiveMode,
  })
}
