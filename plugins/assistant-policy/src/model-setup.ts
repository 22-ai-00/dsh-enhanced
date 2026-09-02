import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type Document, isMap, isSeq, type Node, parseDocument, Scalar, type YAMLMap, YAMLSeq } from 'yaml'

export type ModelApiProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface ModelSetupArgs {
  dshHome: string
  provider: string
  model: string
  apiKeyEnv: string
  baseURL?: string
  api?: ModelApiProtocol
  displayName?: string
  storeKey: boolean
  keyEnvVar: string
  enableInProfile?: string
  help: boolean
}

export interface ResolvedModelSetup {
  dshHome: string
  provider: string
  model: string
  apiKeyEnv: string
  kind: 'deepseek' | 'gateway' | 'agent'
  custom?: {
    baseURL: string
    api: ModelApiProtocol
    displayName?: string
  }
  agent?: {
    rowId: string
    packageName: string
    requiredConfig: { key: string; value: string; jsExpression: boolean }[]
  }
  storeKey: boolean
  keyEnvVar: string
  enableInProfile?: string
}

export interface ModelSetupResult {
  settingsPath: string
  credentialsPath?: string
  profilePatchPath?: string
}

export const DEEPSEEK_OFFICIAL_ROUTE = 'deepseek-official'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_CUSTOM_API: ModelApiProtocol = 'openai-completions'
export const DEFAULT_KEY_ENV_VAR = 'DSH_ENHANCED_MODEL_API_KEY'

// Agent routes are DSH providers backed by a local coding agent (ACP), not by an
// API key.  Selecting one only writes the default-model selection; the route is
// activated by enabling its own bundle row.  The required config mirrors that
// bundle's non-defaulted fields so a freshly enabled row still composes.
export interface AgentRouteDefinition {
  model: string
  rowId: string
  packageName: string
  requiredConfig: { key: string; value: string; jsExpression: boolean }[]
}

export const AGENT_ROUTES: Readonly<Record<string, AgentRouteDefinition>> = Object.freeze({
  'traex-agent': {
    model: 'default',
    rowId: 'dsh-enhanced-traex-acp-provider',
    packageName: '@dsh-enhanced/traex-acp-provider',
    requiredConfig: [{ key: 'cwd', value: "dshHomePath('assistant-workspace')", jsExpression: true }],
  },
})

const allowedApis = new Set<ModelApiProtocol>(['openai-completions', 'openai-responses', 'anthropic-messages'])
// A provider route is a config key; keep it a conservative kebab/snake token.
const routePattern = /^[A-Za-z][A-Za-z0-9._-]*$/u
// A credential reference and the source env var must be POSIX shell identifiers,
// matching what dsh-credentials-local accepts as a stored key.
const posixIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u
// A DSH profile name, matching the installer's own profile validation.
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

function argumentValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`assistant-policy model setup: ${option} requires a value`)
  return value
}

export function deriveApiKeyEnv(provider: string): string {
  if (provider === DEEPSEEK_OFFICIAL_ROUTE) return 'DEEPSEEK_API_KEY'
  let identifier = provider.toUpperCase().replace(/[^A-Z0-9]/gu, '_')
  if (!/^[A-Z_]/u.test(identifier)) identifier = `_${identifier}`
  return identifier.endsWith('_API_KEY') ? identifier : `${identifier}_API_KEY`
}

export function parseModelSetupArgs(argv: readonly string[]): ModelSetupArgs {
  const result: ModelSetupArgs = {
    dshHome: process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
    provider: DEEPSEEK_OFFICIAL_ROUTE,
    model: '',
    apiKeyEnv: '',
    storeKey: false,
    keyEnvVar: DEFAULT_KEY_ENV_VAR,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!
    if (option === '--help' || option === '-h') {
      result.help = true
      continue
    }
    if (option === '--store-key') {
      result.storeKey = true
      continue
    }
    if (option === '--dsh-home') result.dshHome = argumentValue(argv, index++, option)
    else if (option === '--provider') result.provider = argumentValue(argv, index++, option)
    else if (option === '--model') result.model = argumentValue(argv, index++, option)
    else if (option === '--api-key-env') result.apiKeyEnv = argumentValue(argv, index++, option)
    else if (option === '--base-url') result.baseURL = argumentValue(argv, index++, option)
    else if (option === '--api') result.api = argumentValue(argv, index++, option) as ModelApiProtocol
    else if (option === '--display-name') result.displayName = argumentValue(argv, index++, option)
    else if (option === '--key-env-var') result.keyEnvVar = argumentValue(argv, index++, option)
    else if (option === '--enable-in-profile') result.enableInProfile = argumentValue(argv, index++, option)
    else throw new Error(`assistant-policy model setup: unknown option: ${option}`)
  }
  return result
}

export function resolveModelSetup(args: ModelSetupArgs): ResolvedModelSetup {
  if (!isAbsolute(args.dshHome)) throw new Error('assistant-policy model setup: DSH home must be an absolute path')
  if (!routePattern.test(args.provider)) {
    throw new Error('assistant-policy model setup: provider route must start with a letter and use letters, digits, dot, dash, or underscore')
  }
  if (args.api !== undefined && !allowedApis.has(args.api)) {
    throw new Error('assistant-policy model setup: api must be openai-completions, openai-responses, or anthropic-messages')
  }
  if (args.enableInProfile !== undefined && !profileNamePattern.test(args.enableInProfile)) {
    throw new Error('assistant-policy model setup: --enable-in-profile must be a valid profile name')
  }
  const apiKeyEnv = args.apiKeyEnv.length > 0 ? args.apiKeyEnv : deriveApiKeyEnv(args.provider)
  if (!posixIdentifierPattern.test(apiKeyEnv)) {
    throw new Error('assistant-policy model setup: --api-key-env must be a POSIX shell identifier')
  }
  if (!posixIdentifierPattern.test(args.keyEnvVar)) {
    throw new Error('assistant-policy model setup: --key-env-var must be a POSIX shell identifier')
  }

  const agentRoute = AGENT_ROUTES[args.provider]
  if (agentRoute !== undefined) {
    // An agent route carries no API key and no gateway transport: it is a local
    // ACP provider whose credentials and endpoint belong to the coding agent.
    if (args.baseURL !== undefined || args.api !== undefined || args.displayName !== undefined) {
      throw new Error(`assistant-policy model setup: --base-url/--api/--display-name do not apply to the agent route ${args.provider}`)
    }
    if (args.storeKey) {
      throw new Error(`assistant-policy model setup: --store-key does not apply to the agent route ${args.provider}; its credentials belong to the local agent`)
    }
    return {
      dshHome: args.dshHome,
      provider: args.provider,
      model: args.model.length > 0 ? args.model : agentRoute.model,
      apiKeyEnv,
      kind: 'agent',
      agent: { rowId: agentRoute.rowId, packageName: agentRoute.packageName, requiredConfig: agentRoute.requiredConfig },
      storeKey: false,
      keyEnvVar: args.keyEnvVar,
      ...(args.enableInProfile !== undefined ? { enableInProfile: args.enableInProfile } : {}),
    }
  }

  if (args.enableInProfile !== undefined) {
    throw new Error('assistant-policy model setup: --enable-in-profile only applies to an agent route')
  }

  const base: Omit<ResolvedModelSetup, 'kind' | 'model' | 'custom'> = {
    dshHome: args.dshHome,
    provider: args.provider,
    apiKeyEnv,
    storeKey: args.storeKey,
    keyEnvVar: args.keyEnvVar,
  }

  if (args.provider === DEEPSEEK_OFFICIAL_ROUTE) {
    // The built-in deepseek-official route is served by dsh-llm-deepseek, not by
    // the pi-ai gateway, so transport fields have no place here.  Reject them
    // instead of writing a provider block that the route would never read.
    if (args.baseURL !== undefined || args.api !== undefined || args.displayName !== undefined) {
      throw new Error('assistant-policy model setup: --base-url/--api/--display-name only apply to a custom gateway route, not deepseek-official')
    }
    return { ...base, kind: 'deepseek', model: args.model.length > 0 ? args.model : DEFAULT_DEEPSEEK_MODEL }
  }

  if (args.model.length === 0) {
    throw new Error('assistant-policy model setup: a custom gateway route requires --model')
  }
  if (args.baseURL === undefined || !/^https?:\/\//u.test(args.baseURL)) {
    throw new Error('assistant-policy model setup: a custom gateway route requires --base-url starting with http:// or https://')
  }
  return {
    ...base,
    kind: 'gateway',
    model: args.model,
    custom: {
      baseURL: args.baseURL,
      api: args.api ?? DEFAULT_CUSTOM_API,
      ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
    },
  }
}

function resolveSecret(resolved: ResolvedModelSetup): string {
  const candidate = process.env[resolved.keyEnvVar] ?? process.env[resolved.apiKeyEnv]
  if (candidate === undefined || candidate.trim().length === 0) {
    throw new Error(
      `assistant-policy model setup: no API key found; export ${resolved.keyEnvVar} `
      + `(or ${resolved.apiKeyEnv}) before requesting key storage. The key is never passed as an argument.`,
    )
  }
  return candidate
}

async function atomicWriteYaml(path: string, serialized: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
}

async function loadMappingDocument(path: string, description: string): Promise<ReturnType<typeof parseDocument>> {
  let source = ''
  try {
    source = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const document = parseDocument(source.length === 0 ? '{}' : source)
  if (document.errors.length > 0) {
    throw new Error(`assistant-policy model setup: ${description} is invalid YAML: ${document.errors[0]?.message}`)
  }
  if (!isMap(document.contents)) {
    throw new Error(`assistant-policy model setup: ${description} must contain a YAML mapping`)
  }
  return document
}

function jsScalar(value: string): Scalar {
  const scalar = new Scalar(value)
  scalar.tag = '!!js'
  scalar.type = Scalar.PLAIN
  return scalar
}

async function writeCredential(dshHome: string, apiKeyEnv: string, secret: string): Promise<string> {
  const credentialsPath = join(dshHome, '.credentials.yaml')
  const document = await loadMappingDocument(credentialsPath, '.credentials.yaml')
  document.set(apiKeyEnv, secret)
  await mkdir(dshHome, { recursive: true })
  await atomicWriteYaml(credentialsPath, document.toString({ lineWidth: 0 }))
  return credentialsPath
}

async function writeSettings(resolved: ResolvedModelSetup): Promise<string> {
  const settingsPath = join(resolved.dshHome, 'settings.yaml')
  const document = await loadMappingDocument(settingsPath, 'settings.yaml')

  const agentDefault = document.get('agent-default-model', true)
  if (agentDefault !== undefined && !isMap(agentDefault)) {
    throw new Error('assistant-policy model setup: settings.agent-default-model must be a YAML mapping')
  }
  document.setIn(['agent-default-model', 'provider'], resolved.provider)
  document.setIn(['agent-default-model', 'model'], resolved.model)

  if (resolved.custom !== undefined) {
    const piAi = document.get('llm-pi-ai', true)
    if (piAi !== undefined && !isMap(piAi)) {
      throw new Error('assistant-policy model setup: settings.llm-pi-ai must be a YAML mapping')
    }
    const base = ['llm-pi-ai', 'providers', resolved.provider] as const
    if (resolved.custom.displayName !== undefined) {
      document.setIn([...base, 'displayName'], resolved.custom.displayName)
    }
    document.setIn([...base, 'apiKeyEnv'], resolved.apiKeyEnv)
    document.setIn([...base, 'api'], resolved.custom.api)
    document.setIn([...base, 'baseURL'], resolved.custom.baseURL)
    document.setIn([...base, 'models'], [{ id: resolved.model, name: resolved.model }])
  }

  await mkdir(resolved.dshHome, { recursive: true })
  await atomicWriteYaml(settingsPath, document.toString({ lineWidth: 0 }))
  return settingsPath
}

// Flip an agent route's bundle row to enabled:true in the profile's user patch
// layer, preserving every other row, comment, and !!js expression.  The patch
// layer is a top-level YAML sequence; a fresh profile may be comment-only (null
// contents), which we upgrade to an empty sequence.  Any other shape fails
// closed rather than clobbering an unrecognised document.
async function enableAgentRouteInProfile(resolved: ResolvedModelSetup): Promise<string> {
  const agent = resolved.agent!
  const patchPath = join(resolved.dshHome, 'profiles', resolved.enableInProfile!, 'cordis.patch.yml')
  let source = ''
  try {
    source = await readFile(patchPath, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const document: Document = parseDocument(source.length === 0 ? '' : source)
  if (document.errors.length > 0) {
    throw new Error(`assistant-policy model setup: profile patch is invalid YAML: ${document.errors[0]?.message}`)
  }
  if (document.contents === null) {
    document.contents = new YAMLSeq()
  } else if (!isSeq(document.contents)) {
    throw new Error('assistant-policy model setup: profile patch must be a top-level YAML sequence of loader entries')
  }

  const sequence = document.contents as YAMLSeq
  const existing = sequence.items.find(item => isMap(item) && item.get('id') === agent.rowId) as YAMLMap | undefined
  if (existing === undefined) {
    const created = document.createNode({ id: agent.rowId }) as YAMLMap
    const config = document.createNode({ enabled: true }) as YAMLMap
    for (const field of agent.requiredConfig) {
      config.set(field.key, field.jsExpression ? jsScalar(field.value) : field.value)
    }
    created.set('config', config)
    sequence.add(created)
  } else {
    const currentConfig = existing.get('config', true) as Node | undefined
    if (currentConfig === undefined || !isMap(currentConfig)) {
      existing.set('config', document.createNode({}))
    }
    existing.setIn(['config', 'enabled'], true)
    // Re-add required non-defaulted config only when the row is missing it, so
    // we never overwrite an operator's explicit override.
    for (const field of agent.requiredConfig) {
      if (existing.getIn(['config', field.key]) === undefined) {
        existing.setIn(['config', field.key], field.jsExpression ? jsScalar(field.value) : field.value)
      }
    }
  }

  await mkdir(join(resolved.dshHome, 'profiles', resolved.enableInProfile!), { recursive: true })
  await atomicWriteYaml(patchPath, document.toString({ lineWidth: 0 }))
  return patchPath
}

export async function applyModelSetup(resolved: ResolvedModelSetup): Promise<ModelSetupResult> {
  // Resolve (and fail on) a missing secret before touching any file, so a
  // stored-key request never leaves settings pointing at an unconfigured route.
  let credentialsPath: string | undefined
  if (resolved.storeKey) {
    const secret = resolveSecret(resolved)
    credentialsPath = await writeCredential(resolved.dshHome, resolved.apiKeyEnv, secret)
  }
  const settingsPath = await writeSettings(resolved)
  let profilePatchPath: string | undefined
  if (resolved.kind === 'agent' && resolved.enableInProfile !== undefined) {
    profilePatchPath = await enableAgentRouteInProfile(resolved)
  }
  return {
    settingsPath,
    ...(credentialsPath !== undefined ? { credentialsPath } : {}),
    ...(profilePatchPath !== undefined ? { profilePatchPath } : {}),
  }
}

export function modelSetupUsage(): string {
  return [
    'Usage: dsh-model-setup [--dsh-home <absolute-path>] [--provider <route>] [--model <id>]',
    '                       [--api-key-env <VAR>] [--store-key] [--key-env-var <VAR>]',
    '                       [--base-url <url>] [--api <openai-completions|openai-responses|anthropic-messages>]',
    '                       [--display-name <name>] [--enable-in-profile <profile>]',
    '',
    'Writes the deployment default model into DSH settings.yaml (section agent-default-model),',
    'and, for a custom gateway route, its provider profile under section llm-pi-ai.',
    'With --store-key it also persists the API key into $DSH_HOME/.credentials.yaml (0600).',
    '',
    `Agent routes (${Object.keys(AGENT_ROUTES).join(', ')}) carry no API key; they are backed by a local coding`,
    'agent.  Pass --enable-in-profile <profile> to flip the route bundle row to enabled:true in that',
    "profile's patch layer.",
    '',
    `The key value is read only from the environment variable named by --key-env-var (default ${DEFAULT_KEY_ENV_VAR})`,
    'or the credential reference; it is never accepted as a command-line argument.',
    '',
    `Default provider is ${DEEPSEEK_OFFICIAL_ROUTE} with model ${DEFAULT_DEEPSEEK_MODEL}; a custom route requires --model and --base-url.`,
  ].join('\n')
}

export async function runModelSetup(argv = process.argv.slice(2)): Promise<void> {
  const args = parseModelSetupArgs(argv)
  if (args.help) {
    process.stdout.write(`${modelSetupUsage()}\n`)
    return
  }
  const resolved = resolveModelSetup(args)
  const result = await applyModelSetup(resolved)
  process.stdout.write(
    `Updated ${result.settingsPath}: agent-default-model provider=${resolved.provider} model=${resolved.model}\n`,
  )
  if (resolved.custom !== undefined) {
    process.stdout.write(
      `Configured llm-pi-ai route ${resolved.provider}: api=${resolved.custom.api} baseURL=${resolved.custom.baseURL} apiKeyEnv=${resolved.apiKeyEnv}\n`,
    )
  }
  if (resolved.kind === 'agent') {
    if (result.profilePatchPath !== undefined) {
      process.stdout.write(`Enabled agent route ${resolved.provider} (${resolved.agent!.rowId}) in ${result.profilePatchPath}\n`)
    } else {
      process.stdout.write(
        `Set agent route ${resolved.provider} as the default model; enable ${resolved.agent!.packageName} in the profile `
        + '(add the bundle and set enabled: true, e.g. via --enable-in-profile) before it can serve requests.\n',
      )
    }
    return
  }
  if (result.credentialsPath !== undefined) {
    process.stdout.write(`Stored API key ${resolved.apiKeyEnv} in ${result.credentialsPath} (value not shown)\n`)
  } else {
    process.stdout.write(
      `API key not stored; ensure the credential reference ${resolved.apiKeyEnv} resolves at runtime (environment or .credentials.yaml).\n`,
    )
  }
}
