import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { isMap, parseDocument, stringify } from 'yaml'

const CODEX_PROVIDER = 'codex-subscription'
const CODEX_MODEL = 'gpt-5.6-terra'
const TRAEX_PROVIDER = 'traex-agent'
const TRAEX_MODEL = 'default'
const PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u
const ROUTE_FIELDS = new Set([
  'apiKeyEnv', 'displayName', 'api', 'baseURL', 'models', 'defaultContextWindow', 'defaultMaxTokens',
  'defaultInput', 'reasoning', 'thinkingBudgets', 'cacheRetention', 'transport', 'timeoutMs',
  'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget',
  'requestImageMaxBytes', 'retryPolicy', 'compat',
])
const MODEL_FIELDS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])

function fail(message) {
  throw new Error(`web-owner real route: ${message}`)
}

function plain(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]))
  }
  fail('source route is not plain YAML data')
}

function sourceError() {
  // Do not surface parser fragments: settings may be adjacent to credentials.
  fail('could not read a valid selected gateway route')
}

async function readYaml(path) {
  let text
  try { text = await readFile(path, 'utf8') } catch { sourceError() }
  let document
  try { document = parseDocument(text) } catch { sourceError() }
  if (document.errors.length || !isMap(document.contents)) sourceError()
  try { return plain(document.toJS()) } catch { sourceError() }
}

function routeFromSettings(settings, provider) {
  const route = settings?.['llm-pi-ai']?.providers?.[provider]
  if (route === null || typeof route !== 'object' || Array.isArray(route)) sourceError()
  return plain(route)
}

function validateRoute(provider, route) {
  if (!ROUTE_ID.test(provider)) fail('invalid provider route')
  if (Object.keys(route).some(field => !ROUTE_FIELDS.has(field))) fail('gateway route contains unsupported or sensitive fields')
  if (typeof route.apiKeyEnv !== 'string' || !ENV_NAME.test(route.apiKeyEnv)) fail('invalid apiKeyEnv reference')
  if (typeof route.api !== 'string' || !PROTOCOLS.has(route.api)) fail('unsupported gateway api')
  if (typeof route.baseURL !== 'string') fail('invalid gateway baseURL')
  let url
  try { url = new URL(route.baseURL) } catch { fail('invalid gateway baseURL') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail('gateway baseURL must not contain credentials')
  }
  if (!Array.isArray(route.models) || route.models.length === 0) fail('gateway route has no explicit models')
  const ids = new Set()
  for (const model of route.models) {
    if (model === null || typeof model !== 'object' || Array.isArray(model)
      || Object.keys(model).some(field => !MODEL_FIELDS.has(field))
      || typeof model.id !== 'string' || model.id.length === 0 || model.id.length > 512 || ids.has(model.id)) {
      fail('invalid gateway model catalog')
    }
    ids.add(model.id)
  }
}

async function canonicalHome(path) {
  try { return await realpath(path) } catch {
    try { return resolve(await realpath(dirname(path)), basename(path)) } catch { fail('could not resolve DSH home') }
  }
}

function selectModel(route, requested) {
  if (requested !== undefined && requested !== '') {
    if (typeof requested !== 'string' || !route.models.some(model => model.id === requested)) fail('requested model is not configured for the gateway route')
    return requested
  }
  if (route.models.length === 1 && typeof route.models[0].id === 'string') return route.models[0].id
  fail('DSH_WEB_REAL_MODEL is required when the gateway route has more than one model')
}

async function credentialFrom(sourceHome, envName) {
  const credentialsPath = resolve(sourceHome, '.credentials.yaml')
  let text
  try { text = await readFile(credentialsPath, 'utf8') } catch { return undefined }
  let document
  try { document = parseDocument(text) } catch { sourceError() }
  if (document.errors.length || !isMap(document.contents)) sourceError()
  // Current DSH credentials store references below `refs`; accept the older
  // top-level shape too, but never enumerate or copy either collection.
  const refs = document.get('refs', true)
  const value = isMap(refs) ? refs.get(envName) : document.get(envName)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) fail('credential reference is not a non-empty scalar')
  return value
}

function appendDefaultModel(patch, provider, model) {
  if (!patch?.contents?.add || !patch?.createNode) fail('profile patch is not writable YAML')
  patch.contents.add(patch.createNode({ id: 'agent-default-model', config: { provider, model } }))
}

export async function prepareRealRoute({ env = { ...process.env }, home, workspace } = {}) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) fail('env must be an object')
  if (typeof home !== 'string' || home.length === 0) fail('home is required')
  if (typeof workspace !== 'string' || workspace.length === 0) fail('workspace is required')
  const provider = env.DSH_WEB_REAL_PROVIDER || CODEX_PROVIDER
  const requestedModel = env.DSH_WEB_REAL_MODEL
  if (provider === CODEX_PROVIDER) {
    const model = requestedModel || CODEX_MODEL
    return {
      provider,
      model,
      bundles: ['coding-subscription-provider'],
      configurePatch(patch, setConfig) {
        if (typeof setConfig !== 'function') fail('setConfig must be a function')
        setConfig(patch, 'dsh-enhanced-coding-subscription-provider', '@dsh-enhanced/coding-subscription-provider', {
          cwd: workspace, timeoutMs: 120_000,
          codex: { enabled: true, transport: 'direct-responses', directModel: model },
          claude: { enabled: false }, cursor: { enabled: false }, grok: { enabled: false },
        })
        appendDefaultModel(patch, provider, 'default')
      },
      proof: { provider, model, api: 'direct-responses' },
    }
  }

  if (provider === TRAEX_PROVIDER) {
    const model = requestedModel || TRAEX_MODEL
    if (typeof model !== 'string' || !/\S/u.test(model)) fail('invalid TraeX model')
    const cwd = resolve(workspace)
    return {
      provider,
      model,
      bundles: ['traex-acp-provider'],
      configurePatch(patch, setConfig) {
        if (typeof setConfig !== 'function') fail('setConfig must be a function')
        setConfig(patch, 'dsh-enhanced-traex-acp-provider', '@dsh-enhanced/traex-acp-provider', {
          enabled: true, cwd, models: [model],
        })
        appendDefaultModel(patch, provider, model)
      },
      proof: { provider, model, api: 'acp', command: 'traex', cwd },
    }
  }

  if (!ROUTE_ID.test(provider)) fail('invalid provider route')
  const sourceHome = resolve(env.DSH_WEB_REAL_SOURCE_HOME || process.env.DSH_HOME || homedir(), env.DSH_WEB_REAL_SOURCE_HOME || process.env.DSH_HOME ? '' : '.dsh')
  const targetHome = resolve(home)
  const [canonicalSource, canonicalTarget] = await Promise.all([canonicalHome(sourceHome), canonicalHome(targetHome)])
  if (canonicalSource === canonicalTarget) fail('source and target DSH homes must differ')
  const settings = await readYaml(resolve(sourceHome, 'settings.yaml'))
  const route = routeFromSettings(settings, provider)
  validateRoute(provider, route)
  const model = selectModel(route, requestedModel)
  if (env[route.apiKeyEnv] === undefined) {
    const credential = await credentialFrom(sourceHome, route.apiKeyEnv)
    if (credential !== undefined) env[route.apiKeyEnv] = credential
  }
  if (typeof env[route.apiKeyEnv] !== 'string' || env[route.apiKeyEnv].length === 0) fail('selected gateway credential is unavailable')
  await mkdir(dirname(resolve(targetHome, 'settings.yaml')), { recursive: true, mode: 0o700 })
  // This intentionally serializes only the selected public route configuration.
  try {
    await writeFile(resolve(targetHome, 'settings.yaml'), stringify({
      'agent-default-model': { provider, model },
      'llm-pi-ai': { providers: { [provider]: route } },
    }), { mode: 0o600, flag: 'wx' })
  } catch { fail('target settings.yaml already exists or could not be created') }
  return {
    provider,
    model,
    bundles: [],
    configurePatch(patch) { appendDefaultModel(patch, provider, model) },
    proof: { provider, model, api: route.api },
  }
}
