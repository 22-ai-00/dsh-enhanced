import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type Document, isMap, isSeq, type Node, parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml'

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
  enableOnly?: boolean
  defaultIfAbsent?: boolean
  agentCommand?: string
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
  enableOnly?: boolean
  defaultIfAbsent?: boolean
  agentCommand?: string
}

export interface ModelSetupResult {
  settingsPath: string
  settingsUpdated: boolean
  credentialsPath?: string
  profilePatchPath?: string
  routeAction?: 'enabled' | 'already-enabled'
  agentCommandAction?: 'set' | 'preserved'
  profileDefaultAction?: 'set' | 'preserved-settings' | 'preserved-home-patch' | 'preserved-profile-patch'
}

export const DEEPSEEK_OFFICIAL_ROUTE = 'deepseek-official'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_CUSTOM_API: ModelApiProtocol = 'openai-completions'
export const DEFAULT_KEY_ENV_VAR = 'DSH_ENHANCED_MODEL_API_KEY'

// Agent routes are DSH providers backed by a local coding agent (ACP), not by an
// API key. Their bundle row must be enabled separately from default selection.
// The required config mirrors that bundle's non-defaulted fields so a freshly
// enabled row still composes.
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
    if (option === '--enable-only') {
      result.enableOnly = true
      continue
    }
    if (option === '--default-if-absent') {
      result.defaultIfAbsent = true
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
    else if (option === '--agent-command') result.agentCommand = argumentValue(argv, index++, option)
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
  if (args.enableOnly && args.defaultIfAbsent) {
    throw new Error('assistant-policy model setup: --enable-only and --default-if-absent are mutually exclusive')
  }
  if ((args.enableOnly || args.defaultIfAbsent || args.agentCommand !== undefined) && args.enableInProfile === undefined) {
    throw new Error('assistant-policy model setup: --enable-only/--default-if-absent/--agent-command require --enable-in-profile')
  }
  if (args.agentCommand !== undefined && (!isAbsolute(args.agentCommand) || /[\p{Cc}]/u.test(args.agentCommand))) {
    throw new Error('assistant-policy model setup: --agent-command must be an absolute path without control characters')
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
      ...(args.enableOnly ? { enableOnly: true } : {}),
      ...(args.defaultIfAbsent ? { defaultIfAbsent: true } : {}),
      ...(args.agentCommand !== undefined ? { agentCommand: args.agentCommand } : {}),
    }
  }

  if (args.enableInProfile !== undefined || args.enableOnly || args.defaultIfAbsent || args.agentCommand !== undefined) {
    throw new Error('assistant-policy model setup: --enable-in-profile only applies to an agent route; its related options require an agent route too')
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
  // An absent file is parsed from '{}', which yields a flow-style root map that
  // serializes to a single `{ a: { b: c } }` line. Keep newly created settings
  // readable in block style; explicit default detection below uses YAML nodes.
  if (document.contents.flow) {
    document.contents.flow = false
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

async function loadPatchDocument(path: string, description: string): Promise<{ document: Document; source: string; sequence: YAMLSeq }> {
  let source = ''
  try {
    source = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const document: Document = parseDocument(source.length === 0 ? '' : source)
  if (document.errors.length > 0) {
    throw new Error(`assistant-policy model setup: ${description} is invalid YAML: ${document.errors[0]?.message}`)
  }
  if (document.contents === null) {
    document.contents = new YAMLSeq()
  } else if (!isSeq(document.contents)) {
    throw new Error(`assistant-policy model setup: ${description} must be a top-level YAML sequence of loader entries`)
  }
  return { document, source, sequence: document.contents as YAMLSeq }
}

function patchRows(sequence: YAMLSeq): YAMLMap[] {
  const rows: YAMLMap[] = []
  for (const item of sequence.items) {
    if (!isMap(item)) continue
    if (item.has('id')) rows.push(item)
    const inserted = item.get('insert', true)
    if (isSeq(inserted)) for (const row of inserted.items) if (isMap(row)) rows.push(row)
  }
  return rows
}

function containsDefaultModelRow(sequence: YAMLSeq): boolean {
  return patchRows(sequence).some(row => row.get('id') === 'agent-default-model')
}

function homeRouteConfig(sequence: YAMLSeq, rowId: string): YAMLMap {
  let lastConfig: YAMLMap | undefined
  for (const row of patchRows(sequence)) {
    if (row.get('id') !== rowId) continue
    const config = row.get('config', true)
    if (config === undefined) continue
    if (!isMap(config)) throw new Error('assistant-policy model setup: home agent route config must be a YAML mapping')
    lastConfig = config
  }
  return lastConfig === undefined ? new YAMLMap() : lastConfig.clone() as YAMLMap
}

async function existingDefaultSource(resolved: ResolvedModelSetup, homePatch: YAMLSeq, profilePatch: YAMLSeq): Promise<ModelSetupResult['profileDefaultAction'] | undefined> {
  const settings = await loadMappingDocument(join(resolved.dshHome, 'settings.yaml'), 'settings.yaml')
  if ((settings.contents as YAMLMap).has('agent-default-model')) return 'preserved-settings'
  if (containsDefaultModelRow(homePatch)) return 'preserved-home-patch'
  if (containsDefaultModelRow(profilePatch)) return 'preserved-profile-patch'
  return undefined
}

// Flip both the Loader row gate and the provider config gate in the profile patch
// layer, preserving other rows, comments, !!js expressions and existing config.
// Conditional default selection is added to this profile only when no explicit
// user selection exists in settings or the home/profile patch layers.
async function enableAgentRouteInProfile(resolved: ResolvedModelSetup): Promise<{
  path: string
  routeAction: 'enabled' | 'already-enabled'
  commandAction?: 'set' | 'preserved'
  defaultAction?: ModelSetupResult['profileDefaultAction']
}> {
  const agent = resolved.agent!
  const patchPath = join(resolved.dshHome, 'profiles', resolved.enableInProfile!, 'cordis.patch.yml')
  const { document, source, sequence } = await loadPatchDocument(patchPath, 'profile patch')
  const home = await loadPatchDocument(join(resolved.dshHome, 'cordis.patch.yml'), 'home patch')
  const inheritedConfig = homeRouteConfig(home.sequence, agent.rowId)
  let defaultAction: ModelSetupResult['profileDefaultAction'] | undefined
  if (resolved.defaultIfAbsent) {
    defaultAction = await existingDefaultSource(resolved, home.sequence, sequence)
    if (defaultAction === undefined) {
      sequence.add(document.createNode({ id: 'agent-default-model', config: { provider: resolved.provider, model: resolved.model } }))
      defaultAction = 'set'
    }
  }

  const routeRows = patchRows(sequence).filter(row => row.get('id') === agent.rowId)
  const existing = routeRows.at(-1)
  let profileConfig: YAMLMap | undefined
  for (const row of routeRows) {
    const config = row.get('config', true)
    if (config === undefined) continue
    if (!isMap(config)) throw new Error('assistant-policy model setup: agent route config must be a YAML mapping')
    profileConfig = config
  }
  const routeAction = existing?.get('disabled') === false && profileConfig?.get('enabled') === true
    ? 'already-enabled' : 'enabled'
  if (existing === undefined) {
    const created = document.createNode({ id: agent.rowId, disabled: false }) as YAMLMap
    const config = inheritedConfig
    config.set('enabled', true)
    for (const field of agent.requiredConfig) {
      if (config.get(field.key) === undefined) config.set(field.key, field.jsExpression ? jsScalar(field.value) : field.value)
    }
    created.set('config', config)
    sequence.add(created)
  } else {
    existing.set('disabled', false)
    const currentConfig = existing.get('config', true) as Node | undefined
    if (currentConfig !== undefined && !isMap(currentConfig)) {
      throw new Error('assistant-policy model setup: agent route config must be a YAML mapping')
    }
    if (currentConfig === undefined) {
      // A profile config replaces the home config as a whole. If a later row
      // only changes row metadata, carry forward the last profile config;
      // otherwise inherit the last home config before adding enabled:true.
      existing.set('config', profileConfig?.clone() ?? inheritedConfig)
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
  const routeRow = patchRows(sequence).filter(row => row.get('id') === agent.rowId).at(-1)!
  let commandAction: 'set' | 'preserved' | undefined
  if (resolved.agentCommand !== undefined) {
    if (routeRow.getIn(['config', 'command']) === undefined) {
      routeRow.setIn(['config', 'command'], resolved.agentCommand)
      commandAction = 'set'
    } else commandAction = 'preserved'
  }

  await mkdir(join(resolved.dshHome, 'profiles', resolved.enableInProfile!), { recursive: true })
  const serialized = document.toString({ lineWidth: 0 })
  if (serialized !== source) await atomicWriteYaml(patchPath, serialized)
  return { path: patchPath, routeAction,
    ...(commandAction !== undefined ? { commandAction } : {}),
    ...(defaultAction !== undefined ? { defaultAction } : {}) }
}

export async function applyModelSetup(resolved: ResolvedModelSetup): Promise<ModelSetupResult> {
  // Resolve (and fail on) a missing secret before touching any file, so a
  // stored-key request never leaves settings pointing at an unconfigured route.
  let credentialsPath: string | undefined
  if (resolved.storeKey) {
    const secret = resolveSecret(resolved)
    credentialsPath = await writeCredential(resolved.dshHome, resolved.apiKeyEnv, secret)
  }
  const conditional = resolved.kind === 'agent' && (resolved.enableOnly || resolved.defaultIfAbsent)
  const settingsPath = conditional ? join(resolved.dshHome, 'settings.yaml') : await writeSettings(resolved)
  let profilePatchPath: string | undefined
  let routeAction: ModelSetupResult['routeAction'] | undefined
  let agentCommandAction: ModelSetupResult['agentCommandAction'] | undefined
  let profileDefaultAction: ModelSetupResult['profileDefaultAction'] | undefined
  if (resolved.kind === 'agent' && resolved.enableInProfile !== undefined) {
    const profile = await enableAgentRouteInProfile(resolved)
    profilePatchPath = profile.path
    routeAction = profile.routeAction
    agentCommandAction = profile.commandAction
    profileDefaultAction = profile.defaultAction
  }
  return {
    settingsPath,
    settingsUpdated: !conditional,
    ...(credentialsPath !== undefined ? { credentialsPath } : {}),
    ...(profilePatchPath !== undefined ? { profilePatchPath } : {}),
    ...(routeAction !== undefined ? { routeAction } : {}),
    ...(agentCommandAction !== undefined ? { agentCommandAction } : {}),
    ...(profileDefaultAction !== undefined ? { profileDefaultAction } : {}),
  }
}

export function modelSetupUsage(): string {
  return [
    'Usage: dsh-model-setup [--dsh-home <absolute-path>] [--provider <route>] [--model <id>]',
    '                       [--api-key-env <VAR>] [--store-key] [--key-env-var <VAR>]',
    '                       [--base-url <url>] [--api <openai-completions|openai-responses|anthropic-messages>]',
    '                       [--display-name <name>] [--enable-in-profile <profile>]',
    '                       [--enable-only | --default-if-absent] [--agent-command <absolute-path>]',
    '',
    'Writes the deployment default model into DSH settings.yaml (section agent-default-model),',
    'and, for a custom gateway route, its provider profile under section llm-pi-ai.',
    'With --store-key it also persists the API key into $DSH_HOME/.credentials.yaml (0600).',
    '',
    `Agent routes (${Object.keys(AGENT_ROUTES).join(', ')}) carry no API key; they are backed by a local coding`,
    'agent. Pass --enable-in-profile <profile> to enable its bundle row in that profile.',
    '--enable-only leaves settings.yaml untouched and does not select a default.',
    '--default-if-absent selects the route only for the target profile when settings.yaml,',
    'the home patch, and the profile patch contain no explicit default-model selection.',
    '--agent-command fills a missing agent command without replacing command or cwd overrides.',
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
  if (result.settingsUpdated) {
    process.stdout.write(
      `Updated ${result.settingsPath}: agent-default-model provider=${resolved.provider} model=${resolved.model}\n`,
    )
  }
  if (resolved.custom !== undefined) {
    process.stdout.write(
      `Configured llm-pi-ai route ${resolved.provider}: api=${resolved.custom.api} baseURL=${resolved.custom.baseURL} apiKeyEnv=${resolved.apiKeyEnv}\n`,
    )
  }
  if (resolved.kind === 'agent') {
    if (result.profilePatchPath !== undefined) {
      process.stdout.write(`${result.routeAction === 'already-enabled' ? 'Preserved enabled' : 'Enabled'} agent route ${resolved.provider} (${resolved.agent!.rowId}) in ${result.profilePatchPath}\n`)
      if (result.agentCommandAction === 'set') process.stdout.write(`Set agent command ${resolved.agentCommand} in ${result.profilePatchPath}\n`)
      if (result.agentCommandAction === 'preserved') process.stdout.write(`Preserved existing agent command in ${result.profilePatchPath}\n`)
      if (result.profileDefaultAction === 'set') {
        process.stdout.write(`Set profile default model provider=${resolved.provider} model=${resolved.model} in ${result.profilePatchPath}\n`)
      } else if (result.profileDefaultAction !== undefined) {
        const source = result.profileDefaultAction === 'preserved-settings' ? result.settingsPath
          : result.profileDefaultAction === 'preserved-home-patch' ? join(resolved.dshHome, 'cordis.patch.yml')
            : result.profilePatchPath
        process.stdout.write(`Preserved existing default model selection in ${source}\n`)
      }
    } else {
      process.stdout.write(
        `Set agent route ${resolved.provider} as the default model; enable ${resolved.agent!.packageName} in the profile `
        + '(add the bundle and set enabled: true, e.g. via --enable-in-profile) before it can serve requests.\n',
      )
    }
    if (resolved.enableOnly) process.stdout.write(`Left ${result.settingsPath} unchanged (--enable-only).\n`)
    if (resolved.defaultIfAbsent) process.stdout.write(`Left ${result.settingsPath} unchanged (--default-if-absent).\n`)
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
