import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, realpathSync, renameSync, closeSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Document, isAlias, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import {
  boundedConfig, findEntry, hasControlChars,
  type AgentDefaultModelService, type LoaderService, type LlmRuntimeService,
  type PluginManagerService, type SettingsDescriptor, type SettingsService,
} from './settings.js'
import {
  AUTONOMY_TIER_DEFAULTS,
  AutonomyBudgetLimitsSchema,
  type AutonomyBudgetLimits, type AutonomyBudgetTier,
  type AutonomySetupAction, type AutonomySetupStatus, type OwnerConsoleWriteResult,
} from './typert.js'

const DAY_MS = 86_400_000
const PROVIDER_TOKEN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const DSH_HOME_CALL = /^dshHomePath\(\s*(['"])([A-Za-z0-9._/-]+)\1\s*\)$/u
const CUSTOM_JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string) => value,
}

export const AUTONOMY_TIER_PRESETS = AUTONOMY_TIER_DEFAULTS

export interface AutonomyHostContext {
  get(name: string): unknown
}

export interface ConfigureAutonomySetupInput {
  readonly action: AutonomySetupAction
  readonly tier: AutonomyBudgetTier
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly enableMemoryLearning: boolean
  readonly enableDreaming: boolean
  readonly enableGrowth: boolean
  readonly workItemExperiences: boolean
  readonly customBudget: AutonomyBudgetLimits
  readonly now?: number
  readonly env?: NodeJS.ProcessEnv
  readonly reloadEntry?: (entryId: string) => Promise<string>
}

export interface ProfilePaths {
  readonly dshHome: string | null
  readonly canonicalHome: string | null
  readonly profileName: string
  readonly profileDir: string | null
  readonly patchPath: string | null
  readonly patchExists: boolean
  readonly writable: boolean
}

interface ResolvedOwnerRouteInfo {
  readonly configured: boolean
  readonly active: boolean
  readonly channel: 'web' | 'lark' | 'other' | 'absent'
  readonly authorityId: string | null
  readonly principalId: string | null
  readonly principalRecordId: string | null
  readonly principalVersion: number | null
  readonly authorityHash: string | null
  readonly workspace: string
  readonly preset: string
  readonly webGrantReady: boolean
  readonly missingReason: string | null
  readonly routeObject?: Readonly<Record<string, unknown>>
}

function failResult(entry: string, note: string): OwnerConsoleWriteResult {
  return Object.freeze({ applied: false, entry, note })
}

export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && !hasControlChars(value.trim()) ? value.trim() : null
}

export function asPlainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value as Record<string, unknown> }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in canonical JSON')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`
  }
  throw new Error(`unsupported value type in canonical JSON: ${typeof value}`)
}

/** Match sorted-key canonical SHA-256 digests (`assistant-verifier`, `personal-memory`). */
export function canonicalObjectDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** Match `@dsh-ray/assistant-delivery` `ownerRouteAuthorityHash` insertion-order SHA-256 digest. */
export function ownerRouteAuthorityHashLocal(route: Readonly<Record<string, unknown>>, defaults?: Readonly<{ workspace: string; agentPreset: string }>): string | null {
  const id = strOrNull(route['id'])
  if (id === null) return null
  const rawConv = asPlainRecord(route['conversation'])
  const kind = rawConv['kind']
  const canonicalConv = (kind === 'dm' || kind === 'group')
    && typeof rawConv['channel'] === 'string'
    && typeof rawConv['account'] === 'string'
    && typeof rawConv['tenant'] === 'string'
    && typeof rawConv['chat'] === 'string'
    ? {
        channel: rawConv['channel'],
        account: rawConv['account'],
        tenant: rawConv['tenant'],
        kind,
        chat: rawConv['chat'],
        ...(rawConv['thread'] !== undefined ? { thread: rawConv['thread'] } : {}),
      }
    : route['conversation']
  const rawPrincipal = asPlainRecord(route['principal'])
  const canonicalPrincipal = typeof rawPrincipal['channel'] === 'string'
    && typeof rawPrincipal['account'] === 'string'
    && typeof rawPrincipal['tenant'] === 'string'
    && typeof rawPrincipal['user'] === 'string'
    ? {
        channel: rawPrincipal['channel'],
        account: rawPrincipal['account'],
        tenant: rawPrincipal['tenant'],
        user: rawPrincipal['user'],
      }
    : route['principal']
  const canonicalAuthority = {
    id,
    conversation: canonicalConv,
    principal: canonicalPrincipal,
    workspace: typeof route['workspace'] === 'string' ? route['workspace'] : (defaults?.workspace ?? ''),
    agentPreset: strOrNull(route['agentPreset']) ?? (defaults?.agentPreset ?? ''),
    policyRef: route['policyRef'],
    minimumGeneration: typeof route['minimumGeneration'] === 'number' ? route['minimumGeneration'] : 1,
  }
  return createHash('sha256').update(JSON.stringify(canonicalAuthority), 'utf8').digest('hex')
}

export function externalPrincipalId(principal: Readonly<Record<string, unknown>>): string | null {
  const channel = strOrNull(principal['channel'])
  const account = strOrNull(principal['account'])
  const tenant = strOrNull(principal['tenant'])
  const user = strOrNull(principal['user'])
  if (channel === null || account === null || tenant === null || user === null) return null
  return [channel, account, tenant, user].map(encodeURIComponent).join('/')
}

function safeRealpath(targetPath: string): string | null {
  try {
    return realpathSync(resolve(targetPath))
  } catch {
    return null
  }
}

function canonicalPathAllowMissingLeaf(targetPath: string): string | null {
  const resolved = resolve(targetPath)
  const existing = safeRealpath(resolved)
  if (existing !== null) return existing
  const parent = dirname(resolved)
  if (parent === resolved) return null
  const canonicalParent = canonicalPathAllowMissingLeaf(parent)
  if (canonicalParent === null) return null
  return join(canonicalParent, basename(resolved))
}

export function insideDirectory(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function checkScopedDbPath(
  rawNode: unknown,
  canonicalHome: string | null,
): Readonly<{ display: string | null; resolved: string | null; scoped: boolean }> {
  if (isScalar(rawNode) && rawNode.tag === 'tag:yaml.org,2002:js' && typeof rawNode.value === 'string') {
    const match = DSH_HOME_CALL.exec(rawNode.value.trim())
    if (match === null) {
      return { display: `!!js ${rawNode.value}`, resolved: null, scoped: false }
    }
    const rel = match[2]!
    if (rel.startsWith('/') || rel.split('/').some(part => part === '' || part === '..' || part === '.')) {
      return { display: `!!js ${rawNode.value}`, resolved: null, scoped: false }
    }
    const resolved = canonicalHome === null ? null : join(canonicalHome, rel)
    return { display: `!!js ${rawNode.value}`, resolved, scoped: true }
  }

  const rawString = isScalar(rawNode) ? strOrNull(rawNode.value) : strOrNull(rawNode)
  if (rawString === null) return { display: null, resolved: null, scoped: false }
  if (rawString.startsWith('~')) {
    return { display: rawString, resolved: null, scoped: false }
  }
  if (!isAbsolute(rawString) || canonicalHome === null) {
    return { display: rawString, resolved: null, scoped: false }
  }
  const canonicalCandidate = canonicalPathAllowMissingLeaf(rawString)
  if (canonicalCandidate === null) {
    return { display: rawString, resolved: null, scoped: false }
  }
  const globalDsh = resolve(homedir(), '.dsh')
  const canonicalGlobalDsh = safeRealpath(globalDsh) ?? globalDsh
  if (canonicalHome !== canonicalGlobalDsh && (canonicalCandidate === canonicalGlobalDsh || insideDirectory(canonicalGlobalDsh, canonicalCandidate))) {
    return { display: rawString, resolved: canonicalCandidate, scoped: false }
  }
  return {
    display: rawString,
    resolved: canonicalCandidate,
    scoped: insideDirectory(canonicalHome, canonicalCandidate),
  }
}

export function resolveProfilePaths(host: AutonomyHostContext, env: NodeJS.ProcessEnv): ProfilePaths {
  const profileContext = host.get('profileContext') as Readonly<{ dir?: unknown; home?: unknown; name?: unknown }> | undefined
  const settings = host.get('settings') as (SettingsService & { documentPath?: unknown }) | undefined
  const docPath = typeof settings?.documentPath === 'string' && settings.documentPath.trim() !== ''
    ? settings.documentPath.trim() : null

  const profileDir = strOrNull(profileContext?.dir)
    ?? (docPath !== null ? dirname(docPath) : null)
  let dshHome = strOrNull(profileContext?.home)
  if (dshHome === null && profileDir !== null && basename(dirname(profileDir)) === 'profiles') {
    dshHome = dirname(dirname(profileDir))
  }
  if (dshHome === null) dshHome = strOrNull(env['DSH_HOME'])

  const canonicalHome = dshHome === null ? null : canonicalPathAllowMissingLeaf(dshHome)
  const profileName = strOrNull(profileContext?.name)
    ?? (profileDir !== null ? basename(profileDir) : 'default')
  const patchPath = profileDir !== null
    ? join(profileDir, 'cordis.patch.yml')
    : dshHome !== null
      ? join(dshHome, 'profiles', profileName, 'cordis.patch.yml')
      : null

  let patchExists = false
  let writable = false
  if (patchPath !== null) {
    try {
      const st = lstatSync(patchPath)
      if (st.isSymbolicLink()) {
        writable = false
        patchExists = true
      } else {
        patchExists = st.isFile()
        const canonicalPatch = canonicalPathAllowMissingLeaf(patchPath)
        writable = canonicalHome !== null && canonicalPatch !== null && insideDirectory(canonicalHome, canonicalPatch)
      }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const canonicalPatch = canonicalPathAllowMissingLeaf(patchPath)
        writable = canonicalHome !== null && canonicalPatch !== null && insideDirectory(canonicalHome, canonicalPatch)
      }
    }
  }

  return { dshHome, canonicalHome, profileName, profileDir, patchPath, patchExists, writable }
}

const DOC_BY_SEQ = new WeakMap<YAMLSeq, Document>()

export function createPlainNode(doc: Document, value: unknown) {
  return doc.createNode(value, { aliasDuplicateObjects: false })
}

export function yamlNodeToJs(node: unknown, doc?: Document): unknown {
  if (isMap(node) || isSeq(node) || isAlias(node)) {
    if (doc !== undefined) return node.toJS(doc)
    return isAlias(node) ? undefined : node.toJSON()
  }
  if (isScalar(node)) return node.value
  return node
}

export function jsDshHomeScalar(relPath: string): Scalar {
  const node = new Scalar(`dshHomePath('${relPath}')`)
  node.tag = 'tag:yaml.org,2002:js'
  return node
}

export function resolveScopedWorkspacePath(
  rawNode: unknown,
  runtimeValue: unknown,
  canonicalHome: string | null,
): string {
  const tryJsExpr = (raw: string): string | null => {
    const match = DSH_HOME_CALL.exec(raw.trim())
    if (match === null || canonicalHome === null) return null
    const rel = match[2]!
    if (rel.startsWith('/') || rel.split('/').some(part => part === '' || part === '.' || part === '..')) return null
    return join(canonicalHome, rel)
  }
  if (isScalar(rawNode) && rawNode.tag === 'tag:yaml.org,2002:js' && typeof rawNode.value === 'string') {
    const resolved = tryJsExpr(rawNode.value)
    if (resolved !== null) return resolved
  }
  const patchStr = isScalar(rawNode) ? strOrNull(rawNode.value) : strOrNull(rawNode)
  if (patchStr !== null) {
    const resolved = tryJsExpr(patchStr)
    if (resolved !== null) return resolved
    if (isAbsolute(patchStr)) return patchStr
  }
  const runtimeStr = strOrNull(runtimeValue)
  if (runtimeStr !== null && isAbsolute(runtimeStr)) return runtimeStr
  return ''
}

export function ensureVerifierDefaults(
  doc: Document,
  verifierCfgNode: YAMLMap,
  runtimeVerifierCfg?: Readonly<Record<string, unknown>>,
): void {
  const existingDb: unknown = verifierCfgNode.get('databasePath', true)
  const existingDbInvalid = existingDb === undefined
    || !isScalar(existingDb)
    || (existingDb.tag !== 'tag:yaml.org,2002:js' && strOrNull(existingDb.value) === null)
  if (existingDbInvalid) {
    const runtimeDb = strOrNull(runtimeVerifierCfg?.['databasePath'])
    if (runtimeDb !== null && isAbsolute(runtimeDb)) {
      verifierCfgNode.set('databasePath', createPlainNode(doc, runtimeDb))
    } else {
      verifierCfgNode.set('databasePath', jsDshHomeScalar('assistant-verifier/verification.sqlite'))
    }
  }
  const survivingOptionalKeys = [
    'sourceReviews',
    'creationReviews',
    'revisionReviews',
    'revisionRegressions',
  ] as const
  for (const key of survivingOptionalKeys) {
    if (!verifierCfgNode.has(key) && runtimeVerifierCfg?.[key] !== undefined) {
      verifierCfgNode.set(key, createPlainNode(doc, runtimeVerifierCfg[key]))
    }
  }
  if (!verifierCfgNode.has('tickIntervalMs')) {
    const tick = typeof runtimeVerifierCfg?.['tickIntervalMs'] === 'number'
      ? runtimeVerifierCfg['tickIntervalMs']
      : 5_000
    verifierCfgNode.set('tickIntervalMs', createPlainNode(doc, tick))
  }
  if (!verifierCfgNode.has('authorities')) {
    const authorities = Array.isArray(runtimeVerifierCfg?.['authorities']) ? runtimeVerifierCfg['authorities'] : []
    verifierCfgNode.set('authorities', createPlainNode(doc, authorities))
  }
  if (!verifierCfgNode.has('profiles')) {
    const profiles = Array.isArray(runtimeVerifierCfg?.['profiles']) ? runtimeVerifierCfg['profiles'] : []
    verifierCfgNode.set('profiles', createPlainNode(doc, profiles))
  }
  if (!verifierCfgNode.has('requireAcceptance')) {
    const req = typeof runtimeVerifierCfg?.['requireAcceptance'] === 'boolean'
      ? runtimeVerifierCfg['requireAcceptance']
      : true
    verifierCfgNode.set('requireAcceptance', createPlainNode(doc, req))
  }
}

export function readPatchDocument(patchPath: string | null): Document {
  if (patchPath === null || !existsSync(patchPath)) {
    const doc = parseDocument('[]', { customTags: [CUSTOM_JS_TAG] })
    if (isSeq(doc.contents)) {
      doc.contents.flow = false
      DOC_BY_SEQ.set(doc.contents, doc)
    }
    return doc
  }
  const st = lstatSync(patchPath)
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error('cordis.patch.yml 必须是普通文件，拒绝写入符号链接')
  }
  const source = readFileSync(patchPath, 'utf8')
  const doc = parseDocument(source.trim() === '' ? '[]' : source, { customTags: [CUSTOM_JS_TAG] })
  if (doc.errors.length > 0) {
    throw new Error(`cordis.patch.yml YAML 语法错误：${doc.errors[0]?.message ?? 'unknown'}`)
  }
  if (!isSeq(doc.contents)) {
    throw new Error('cordis.patch.yml 顶层必须是 YAML 列表（sequence）')
  }
  if (doc.contents.flow) doc.contents.flow = false
  DOC_BY_SEQ.set(doc.contents, doc)
  return doc
}

export function findPatchRow(seq: YAMLSeq, rowId: string): YAMLMap | undefined {
  for (const item of seq.items) {
    if (isMap(item) && item.get('id') === rowId) return item
    if (isMap(item)) {
      const inserted = item.get('insert', true)
      if (isSeq(inserted)) {
        for (const sub of inserted.items) {
          if (isMap(sub) && sub.get('id') === rowId) return sub
        }
      }
    }
  }
  return undefined
}

export function readConfigMap(parent: YAMLMap, key: string): YAMLMap | undefined {
  const value: unknown = parent.get(key, true)
  return isMap(value) ? value : undefined
}

export function ensureConfigMap(doc: Document, parent: YAMLMap, key: string): YAMLMap {
  const existing = readConfigMap(parent, key)
  if (existing !== undefined) return existing
  const created = doc.createNode({}) as unknown as YAMLMap
  parent.set(key, created)
  return created
}

export function ensurePatchRow(doc: Document, seq: YAMLSeq, rowId: string, packageName: string): YAMLMap {
  const existing = findPatchRow(seq, rowId)
  if (existing !== undefined) return existing
  const created = doc.createNode({ id: rowId, name: packageName, config: {} }) as unknown as YAMLMap
  seq.add(created)
  return created
}

export function getPatchRowConfig(seq: YAMLSeq, rowId: string, doc?: Document): Record<string, unknown> {
  const row = findPatchRow(seq, rowId)
  if (row === undefined) return {}
  const cfg = readConfigMap(row, 'config')
  return cfg !== undefined ? asPlainRecord(yamlNodeToJs(cfg, doc ?? DOC_BY_SEQ.get(seq))) : {}
}

export function getPatchRowConfigNode(seq: YAMLSeq, rowId: string): YAMLMap | undefined {
  const row = findPatchRow(seq, rowId)
  if (row === undefined) return undefined
  return readConfigMap(row, 'config')
}

export function mergeDescriptorConfig(descriptors: readonly SettingsDescriptor[], ns: string, patchConfig: Record<string, unknown>): Record<string, unknown> {
  const desc = findEntry(descriptors, candidate => candidate === ns)
  const runtimeCfg = desc ? boundedConfig(desc.value) : {}
  return { ...runtimeCfg, ...patchConfig }
}

export function queryActiveOwnerFromSqlite(
  dbPath: string,
  expectedPrincipal: Record<string, unknown> | undefined,
): Readonly<{ principalRecordId: string; principalVersion: number; principal: Record<string, unknown>; workspace?: string; preset?: string; hasConversation: boolean }> | null {
  if (!existsSync(dbPath)) return null
  const st = lstatSync(dbPath)
  if (st.isSymbolicLink() || !st.isFile()) return null
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare(
      `SELECT id, version, principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active' ORDER BY version DESC LIMIT 32`,
    ).all() as ReadonlyArray<{ id?: unknown; version?: unknown; principal_json?: unknown }>

    let matched: { id: string; version: number; principal: Record<string, unknown> } | null = null
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.version !== 'number' || typeof row.principal_json !== 'string') continue
      let parsed: Record<string, unknown>
      try {
        parsed = asPlainRecord(JSON.parse(row.principal_json))
      } catch {
        continue
      }
      if (expectedPrincipal !== undefined) {
        if (parsed['channel'] === expectedPrincipal['channel']
          && parsed['account'] === expectedPrincipal['account']
          && parsed['tenant'] === expectedPrincipal['tenant']
          && parsed['user'] === expectedPrincipal['user']) {
          matched = { id: row.id, version: row.version, principal: parsed }
          break
        }
      } else if (parsed['channel'] === 'web') {
        matched = { id: row.id, version: row.version, principal: parsed }
        break
      } else if (matched === null) {
        matched = { id: row.id, version: row.version, principal: parsed }
      }
    }
    if (matched === null) return null

    let workspace: string | undefined
    let preset: string | undefined
    let hasConversation = false
    try {
      const principalKey = externalPrincipalId(matched.principal)
      const binding = db.prepare(
        `SELECT conversation_json, workspace, agent_preset FROM conversation_bindings WHERE (principal_id = ? OR principal_id = ?) AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
      ).get(matched.id, principalKey ?? matched.id) as { conversation_json?: unknown; workspace?: unknown; agent_preset?: unknown } | undefined
      if (typeof binding?.conversation_json === 'string') {
        try {
          const parsedConv = asPlainRecord(JSON.parse(binding.conversation_json))
          if (typeof parsedConv['channel'] === 'string' && typeof parsedConv['chat'] === 'string') {
            hasConversation = true
          }
        } catch {
          // Ignore malformed conversation JSON.
        }
      }
      if (typeof binding?.workspace === 'string') workspace = binding.workspace
      if (typeof binding?.agent_preset === 'string') preset = binding.agent_preset
    } catch {
      // Optional binding hint.
    }
    return {
      principalRecordId: matched.id,
      principalVersion: matched.version,
      principal: matched.principal,
      hasConversation,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(preset !== undefined ? { preset } : {}),
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* noop */ }
  }
}

export function inspectOwnerRoute(
  host: AutonomyHostContext,
  paths: ProfilePaths,
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
): ResolvedOwnerRouteInfo {
  const patchDelivery = seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-delivery') : {}
  const deliveryCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-assistant-delivery', patchDelivery)
  const rawRoutes = Array.isArray(deliveryCfg['ownerRoutes']) ? deliveryCfg['ownerRoutes'] : []
  const validRoutes = rawRoutes
    .map(r => asPlainRecord(r))
    .filter(r => typeof r['id'] === 'string' && r['id'].trim() !== '' && typeof r['workspace'] === 'string' && typeof r['agentPreset'] === 'string')

  const preferredRoute = validRoutes.find(r => asPlainRecord(r['principal'])['channel'] === 'web') ?? validRoutes[0]
  const deliveryNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-delivery') : undefined
  const fallbackWorkspace = paths.canonicalHome !== null ? join(paths.canonicalHome, 'assistant-workspace') : ''
  const defaultWorkspace = resolveScopedWorkspacePath(
    deliveryNode?.get('defaultWorkspace', true),
    deliveryCfg['defaultWorkspace'],
    paths.canonicalHome,
  ) || fallbackWorkspace
  const defaultPreset = strOrNull(deliveryCfg['defaultAgentPreset']) ?? 'standard'

  const dbPathNode = deliveryNode?.get('databasePath', true) ?? deliveryCfg['databasePath']
  const scopedDeliveryDb = checkScopedDbPath(
    dbPathNode,
    paths.canonicalHome,
  )
  const defaultDeliveryDb = paths.canonicalHome !== null ? join(paths.canonicalHome, 'assistant-delivery', 'state.sqlite') : null
  const deliveryDbPath = scopedDeliveryDb.resolved ?? defaultDeliveryDb

  const expectedPrincipal = preferredRoute ? asPlainRecord(preferredRoute['principal']) : undefined
  const sqliteOwner = deliveryDbPath !== null ? queryActiveOwnerFromSqlite(deliveryDbPath, expectedPrincipal) : null

  const deliveryService = host.get('assistantDelivery') as Readonly<{
    inspectOwnerRouteState?: (input: {
      authorityId: string
      principalId: string
      workspace: string
      agentPreset: string
    }) => {
      status?: string
      receipt?: {
        authorityHash?: string
        principalRecordId?: string
        principalVersion?: number
      }
      owner?: { id?: string; version?: number }
    }
  }> | undefined

  let principalRecordId = sqliteOwner?.principalRecordId ?? null
  let principalVersion = sqliteOwner?.principalVersion ?? null
  let routeActiveFromService = false
  let serviceAuthorityHash: string | null = null

  if (preferredRoute !== undefined) {
    const principalObj = asPlainRecord(preferredRoute['principal'])
    const rawChannel = strOrNull(principalObj['channel'])
    const channel: 'web' | 'lark' | 'other' = rawChannel === 'web' ? 'web' : rawChannel === 'lark' ? 'lark' : 'other'
    const authorityId = strOrNull(preferredRoute['id'])
    const workspace = resolveScopedWorkspacePath(preferredRoute['workspace'], undefined, paths.canonicalHome) || defaultWorkspace
    const preset = strOrNull(preferredRoute['agentPreset']) ?? defaultPreset
    const principalId = externalPrincipalId(principalObj)

    if (authorityId !== null && principalId !== null && typeof deliveryService?.inspectOwnerRouteState === 'function') {
      try {
        const inspected = deliveryService.inspectOwnerRouteState({
          authorityId,
          principalId,
          workspace,
          agentPreset: preset,
        })
        if (inspected?.status === 'active') {
          routeActiveFromService = true
          if (typeof inspected.receipt?.principalRecordId === 'string') principalRecordId = inspected.receipt.principalRecordId
          else if (typeof inspected.owner?.id === 'string') principalRecordId = inspected.owner.id
          if (typeof inspected.receipt?.principalVersion === 'number') principalVersion = inspected.receipt.principalVersion
          else if (typeof inspected.owner?.version === 'number') principalVersion = inspected.owner.version
          if (typeof inspected.receipt?.authorityHash === 'string' && /^[0-9a-f]{64}$/u.test(inspected.receipt.authorityHash)) {
            serviceAuthorityHash = inspected.receipt.authorityHash
          }
        }
      } catch {
        // Fall back cleanly to SQLite inspection.
      }
    }

    const authorityHash = serviceAuthorityHash ?? ownerRouteAuthorityHashLocal(preferredRoute, { workspace, agentPreset: preset })
    const active = (routeActiveFromService || (principalRecordId !== null && principalVersion !== null)) && authorityHash !== null && principalId !== null
    let missingReason: string | null = null
    if (!active) {
      const otherActiveOwner = deliveryDbPath !== null ? queryActiveOwnerFromSqlite(deliveryDbPath, undefined) : null
      const otherPrincipalId = otherActiveOwner !== null ? externalPrincipalId(otherActiveOwner.principal) : null
      if (otherActiveOwner !== null && otherPrincipalId !== null && otherPrincipalId !== principalId) {
        const otherChannel = strOrNull(otherActiveOwner.principal['channel'])
        missingReason = otherActiveOwner.hasConversation || otherChannel === 'web'
          ? `主主人已切换为 ${otherPrincipalId}，但 ownerRoutes 仍指向旧主主人（${principalId ?? authorityId ?? 'unknown'}）；请点击「一键初始化/修复前置项」同步主主人路由后即可继续`
          : `主主人已切换为 ${otherPrincipalId}，请先重启 profile 并在飞书给机器人发送一条私聊消息建立会话，再点击「一键初始化/修复前置项」同步主主人路由`
      } else {
        missingReason = 'owner 路由已写入配置，但 Delivery 尚未记录已认领的激活 owner 主体（请先在 Web 对话或飞书发送首条 owner 消息，或运行 dsh-web-owner-setup）'
      }
    }
    return {
      configured: true,
      active,
      channel,
      authorityId,
      principalId,
      principalRecordId,
      principalVersion,
      authorityHash,
      workspace,
      preset,
      webGrantReady: channel === 'web' && active,
      missingReason,
      routeObject: preferredRoute,
    }
  }

  if (sqliteOwner !== null && sqliteOwner.principal['channel'] === 'web') {
    const principalId = externalPrincipalId(sqliteOwner.principal)
    const workspace = sqliteOwner.workspace !== undefined && isAbsolute(sqliteOwner.workspace)
      ? sqliteOwner.workspace
      : defaultWorkspace
    const preset = sqliteOwner.preset ?? defaultPreset
    return {
      configured: false,
      active: false,
      channel: 'web',
      authorityId: null,
      principalId,
      principalRecordId: sqliteOwner.principalRecordId,
      principalVersion: sqliteOwner.principalVersion,
      authorityHash: null,
      workspace,
      preset,
      webGrantReady: false,
      missingReason: '已检测到 Web owner 主体，但 assistant-delivery.ownerRoutes 尚未配置主路由（请先完成 Web owner 初始化或 dsh-web-owner-setup）',
    }
  }

  return {
    configured: false,
    active: false,
    channel: 'absent',
    authorityId: null,
    principalId: null,
    principalRecordId: null,
    principalVersion: null,
    authorityHash: null,
    workspace: defaultWorkspace,
    preset: defaultPreset,
    webGrantReady: false,
    missingReason: '尚未配置并激活任何 owner 路由（请先完成 Web owner 初始化或飞书 owner 绑定）',
  }
}

function inspectModelRoute(
  host: AutonomyHostContext,
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
  installedPackages: ReadonlySet<string> | null,
): AutonomySetupStatus['modelRoute'] {
  const traexPatch = seq ? getPatchRowConfig(seq, 'dsh-ray-traex-acp-provider') : {}
  const traexDesc = findEntry(descriptors, ns => ns.endsWith('traex-acp-provider'))
  const traexCfg = { ...(traexDesc ? boundedConfig(traexDesc.value) : {}), ...traexPatch }
  const traexInstalled = installedPackages === null
    ? (traexDesc !== undefined || (seq !== undefined && findPatchRow(seq, 'dsh-ray-traex-acp-provider') !== undefined))
    : installedPackages.has('@dsh-ray/traex-acp-provider')
  const traexEnabled = traexCfg['enabled'] === true
  const agyEnabled = traexCfg['agyEnabled'] === true

  const defaultModelSvc = host.get('agentDefaultModel') as AgentDefaultModelService | undefined
  let selection: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined
  try { selection = defaultModelSvc?.currentSelection?.() } catch { selection = undefined }
  const defaultDesc = findEntry(descriptors, ns => ns.endsWith('agent-default-model'))
  const defaultCfg = defaultDesc ? boundedConfig(defaultDesc.value) : {}
  const provider = strOrNull(selection?.provider) ?? strOrNull(defaultCfg['provider'])
  const model = strOrNull(selection?.model) ?? strOrNull(defaultCfg['model'])
  const reasoningEffort = strOrNull(selection?.reasoningEffort) ?? strOrNull(defaultCfg['reasoningEffort'])

  const llmSvc = host.get('llm') as LlmRuntimeService | undefined
  const apiProviders: Array<{ id: string; name: string }> = []
  try {
    for (const row of llmSvc?.listProviders?.() ?? []) {
      const id = strOrNull(row?.id)
      if (id !== null && id !== 'traex-agent' && id !== 'agy-agent') {
        apiProviders.push({ id, name: strOrNull(row?.name) ?? id })
      }
    }
  } catch { /* ignore */ }

  let routeKind: 'traex-agent' | 'agy-agent' | 'api' | 'unconfigured' = 'unconfigured'
  let ready = false
  let missingReason: string | null = null

  if (provider === 'traex-agent') {
    routeKind = 'traex-agent'
    ready = traexInstalled && traexEnabled
    if (!traexInstalled) missingReason = '@dsh-ray/traex-acp-provider 未安装'
    else if (!traexEnabled) missingReason = 'traex-agent 路由未启用（点击授权可自动同步启用或切至 API）'
  } else if (provider === 'agy-agent') {
    routeKind = 'agy-agent'
    ready = traexInstalled && agyEnabled
    if (!traexInstalled) missingReason = '@dsh-ray/traex-acp-provider 未安装'
    else if (!agyEnabled) missingReason = 'agy-agent 路由未启用（点击授权可自动同步启用）'
  } else if (provider !== null && model !== null) {
    routeKind = 'api'
    ready = true
  } else {
    missingReason = '尚未选择默认模型 / 编程工具路由（traex-agent / agy-agent / API）'
  }

  return Object.freeze({
    provider,
    model,
    reasoningEffort,
    routeKind,
    traexInstalled,
    traexEnabled,
    agyEnabled,
    apiProviders,
    ready,
    missingReason,
  })
}

export function getPersonalAndPolicyConfigs(
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
): Readonly<{
  layout: 'personal-assistant' | 'split'
  policyCfg: Record<string, unknown>
  automationsCfg: Record<string, unknown>
  personalMemoryCfg: Record<string, unknown>
  policyRow?: YAMLMap | undefined
}> {
  const hasSplitRow = seq !== undefined
    && (findPatchRow(seq, 'dsh-ray-assistant-policy') !== undefined
      || findPatchRow(seq, 'dsh-ray-personal-memory') !== undefined)
  const paPatch = seq ? getPatchRowConfig(seq, 'dsh-ray-personal-assistant') : {}
  const descPa = findEntry(descriptors, candidate => candidate === 'dsh-ray-personal-assistant')
  const runtimePaCfg = descPa ? boundedConfig(descPa.value) : {}

  if (hasSplitRow && findPatchRow(seq!, 'dsh-ray-personal-assistant') === undefined) {
    const policyCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-assistant-policy', getPatchRowConfig(seq!, 'dsh-ray-assistant-policy'))
    const automationsCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-assistant-automations', getPatchRowConfig(seq!, 'dsh-ray-assistant-automations'))
    const personalMemoryCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-personal-memory', getPatchRowConfig(seq!, 'dsh-ray-personal-memory'))
    return {
      layout: 'split',
      policyCfg,
      automationsCfg,
      personalMemoryCfg,
      policyRow: findPatchRow(seq!, 'dsh-ray-assistant-policy'),
    }
  }

  return {
    layout: 'personal-assistant',
    policyCfg: { ...asPlainRecord(runtimePaCfg['assistantPolicy']), ...asPlainRecord(paPatch['assistantPolicy']) },
    automationsCfg: { ...asPlainRecord(runtimePaCfg['assistantAutomations']), ...asPlainRecord(paPatch['assistantAutomations']) },
    personalMemoryCfg: { ...asPlainRecord(runtimePaCfg['personalMemory']), ...asPlainRecord(paPatch['personalMemory']) },
    policyRow: seq ? findPatchRow(seq, 'dsh-ray-personal-assistant') : undefined,
  }
}

function isRowDisabled(seq: YAMLSeq | undefined, rowId: string): boolean {
  const row = seq ? findPatchRow(seq, rowId) : undefined
  return row?.get('disabled') === true
}

function hasInstalledBundle(installedPackages: ReadonlySet<string> | null, pkgName: string, rowPresent: boolean, descPresent: boolean): boolean {
  return installedPackages !== null ? installedPackages.has(pkgName) : (rowPresent || descPresent)
}

function detectTierFromBudgets(
  policyCfg: Record<string, unknown>,
  dreamingCfg: Record<string, unknown>,
  learningCfg: Record<string, unknown>,
  growthCfg: Record<string, unknown>,
): Readonly<{ activeTier: AutonomyBudgetTier; activeBudgets: AutonomyBudgetLimits }> {
  const budgets = Array.isArray(policyCfg['budgets']) ? policyCfg['budgets'].map(asPlainRecord) : []
  const byId = (id: unknown) => budgets.find(b => typeof id === 'string' && b['id'] === id)

  const memB = byId(learningCfg['budgetId'])
  const memScanB = byId(learningCfg['scanBudgetId'])
  const dreamB = byId(dreamingCfg['budgetId'])
  const growthB = byId(growthCfg['budgetId'])
  const growthScanB = byId(asPlainRecord(growthCfg['usageLearning'])['scanBudgetId'])

  const raw: AutonomyBudgetLimits = {
    dailyMemoryExtractions: typeof memB?.['limit'] === 'number' && memB['limit'] >= 1 ? Math.min(10_000, Math.trunc(memB['limit'])) : AUTONOMY_TIER_PRESETS.conservative.dailyMemoryExtractions,
    dailyMemoryScans: typeof memScanB?.['limit'] === 'number' && memScanB['limit'] >= 1 ? Math.min(10_000, Math.trunc(memScanB['limit'])) : AUTONOMY_TIER_PRESETS.conservative.dailyMemoryScans,
    dailyDreams: typeof dreamB?.['limit'] === 'number' && dreamB['limit'] >= 1 ? Math.min(24, Math.trunc(dreamB['limit'])) : typeof dreamingCfg['maxDreamsPerDay'] === 'number' ? Math.min(24, Math.max(1, Math.trunc(dreamingCfg['maxDreamsPerDay']))) : AUTONOMY_TIER_PRESETS.conservative.dailyDreams,
    dailyGrowthReviews: typeof growthB?.['limit'] === 'number' && growthB['limit'] >= 1 ? Math.min(1_000, Math.trunc(growthB['limit'])) : AUTONOMY_TIER_PRESETS.conservative.dailyGrowthReviews,
    dailyGrowthDiscoveryScans: typeof growthScanB?.['limit'] === 'number' && growthScanB['limit'] >= 1 ? Math.min(10_000, Math.trunc(growthScanB['limit'])) : AUTONOMY_TIER_PRESETS.conservative.dailyGrowthDiscoveryScans,
    maxIdeasPerWake: typeof dreamingCfg['maxIdeasPerWake'] === 'number' && dreamingCfg['maxIdeasPerWake'] >= 1 ? Math.min(5, Math.trunc(dreamingCfg['maxIdeasPerWake'])) : AUTONOMY_TIER_PRESETS.conservative.maxIdeasPerWake,
    grantLeaseDays: AUTONOMY_TIER_PRESETS.conservative.grantLeaseDays,
  }

  for (const tierName of ['conservative', 'balanced'] as const) {
    const preset = AUTONOMY_TIER_PRESETS[tierName]
    if (raw.dailyMemoryExtractions === preset.dailyMemoryExtractions
      && raw.dailyDreams === preset.dailyDreams
      && raw.dailyGrowthReviews === preset.dailyGrowthReviews) {
      return { activeTier: tierName, activeBudgets: raw }
    }
  }
  return { activeTier: 'custom', activeBudgets: raw }
}

/** Inspect owner route, active coding/API model route, $DSH_HOME scoping, and all autonomy grants. */
export async function inspectAutonomyWizardStatus(
  host: AutonomyHostContext,
  options: Readonly<{ now?: number; env?: NodeJS.ProcessEnv }> = {},
): Promise<AutonomySetupStatus> {
  const now = options.now ?? Date.now()
  const env = options.env ?? process.env
  const paths = resolveProfilePaths(host, env)
  const settings = host.get('settings') as SettingsService | undefined
  const descriptors = settings?.describe({ redactSecrets: true }) ?? []
  const manager = host.get('pluginManager') as PluginManagerService | undefined

  let installedPackages: ReadonlySet<string> | null = null
  if (typeof manager?.listBundles === 'function') {
    try {
      const bundles = await manager.listBundles()
      installedPackages = new Set(bundles.filter(b => b.installed).map(b => b.name))
    } catch {
      installedPackages = null
    }
  }

  let doc: Document | undefined
  let patchError: string | null = null
  try {
    doc = readPatchDocument(paths.patchPath)
  } catch (error: unknown) {
    patchError = error instanceof Error ? error.message : String(error)
  }
  const seq = doc && isSeq(doc.contents) ? doc.contents : undefined

  const unscopedDbPaths: string[] = []
  const checkDbNode = (label: string, rawNode: unknown): string | null => {
    if (rawNode === undefined) return null
    const checked = checkScopedDbPath(rawNode, paths.canonicalHome)
    if (checked.display !== null && !checked.scoped && unscopedDbPaths.length < 16) {
      unscopedDbPaths.push(`${label}: ${checked.display}`)
    }
    return checked.display
  }

  const ownerRoute = inspectOwnerRoute(host, paths, seq, descriptors)
  const modelRoute = inspectModelRoute(host, seq, descriptors, installedPackages)
  const pp = getPersonalAndPolicyConfigs(seq, descriptors)

  const memNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-memory-learning') : undefined
  const memCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-assistant-memory-learning', seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-memory-learning') : {})
  const verifierCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-assistant-verifier', seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-verifier') : {})
  const reviewCfg = asPlainRecord(verifierCfg['memoryReviews'])
  const adoptCfg = asPlainRecord(pp.personalMemoryCfg['automaticLearning'])

  const memDb = checkDbNode('assistant-memory-learning', memNode?.get('databasePath', true) ?? memCfg['databasePath'])
  const extractAuth = strOrNull(memCfg['authorityId'])
  const reviewAuth = strOrNull(reviewCfg['authorityId'])
  const adoptAuth = strOrNull(adoptCfg['authorityId'])
  const ownerAuth = strOrNull(asPlainRecord(memCfg['owner'])['authorityId'])
  const distinctAuths = [extractAuth, reviewAuth, adoptAuth].filter((x): x is string => x !== null)
  const threeAuthoritiesIndependent = distinctAuths.length === 3
    && new Set(distinctAuths).size === 3
    && (ownerAuth === null || !distinctAuths.includes(ownerAuth))
  const memExpiresAt = typeof memCfg['expiresAt'] === 'number' && Number.isFinite(memCfg['expiresAt'])
    ? Math.trunc(memCfg['expiresAt']) : null
  const memExpired = memExpiresAt !== null && memExpiresAt <= now
  const memConfigured = extractAuth !== null && reviewAuth !== null && adoptAuth !== null
  const memEnabled = memConfigured && !isRowDisabled(seq, 'dsh-ray-assistant-memory-learning') && !memExpired

  const dreamNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-dreaming') : undefined
  const dreamCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-assistant-dreaming', seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-dreaming') : {})
  const dreamDb = checkDbNode('assistant-dreaming', dreamNode?.get('databasePath', true) ?? dreamCfg['databasePath'])
  const dreamScope = asPlainRecord(dreamCfg['scope'])
  const dreamConfigured = strOrNull(dreamScope['ownerRouteId']) !== null && strOrNull(dreamCfg['budgetId']) !== null
  const dreamRetired = dreamCfg['retired'] === true
  const dreamEnabled = dreamCfg['enabled'] === true && !dreamRetired && !isRowDisabled(seq, 'dsh-ray-assistant-dreaming')

  const growthNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-growth-driver') : undefined
  const growthCfg = mergeDescriptorConfig(descriptors, 'dsh-ray-assistant-growth-driver', seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-growth-driver') : {})
  const usageCfg = asPlainRecord(growthCfg['usageLearning'])
  const usageNode = growthNode?.get('usageLearning', true)
  const growthDb = checkDbNode(
    'assistant-growth-driver.usageLearning',
    isMap(usageNode) ? usageNode.get('databasePath', true) : usageCfg['databasePath'],
  )
  const growthScope = asPlainRecord(growthCfg['scope'])
  const growthConfigured = strOrNull(growthScope['ownerRouteId']) !== null && strOrNull(growthCfg['budgetId']) !== null
  const growthEnabled = growthCfg['enabled'] === true && !isRowDisabled(seq, 'dsh-ray-assistant-growth-driver')

  // Also flag unscoped core delivery/policy/personalMemory DB paths.
  const deliveryNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-delivery') : undefined
  checkDbNode('assistant-delivery', deliveryNode?.get('databasePath', true))
  if (pp.policyRow !== undefined) {
    const pCfgNode = pp.policyRow.get('config', true)
    if (isMap(pCfgNode)) {
      const subPolicy = pCfgNode.get('assistantPolicy', true)
      const subMemory = pCfgNode.get('personalMemory', true)
      checkDbNode('assistantPolicy', isMap(subPolicy) ? subPolicy.get('databasePath', true) : pCfgNode.get('databasePath', true))
      checkDbNode('personalMemory', isMap(subMemory) ? subMemory.get('databasePath', true) : undefined)
    }
  }

  const rulesArr = Array.isArray(pp.policyCfg['rules']) ? pp.policyCfg['rules'] : []
  const budgetsArr = Array.isArray(pp.policyCfg['budgets']) ? pp.policyCfg['budgets'] : []
  const schedulerEnabled = pp.automationsCfg['schedulerEnabled'] === true
  const allowUnbudgetedExecution = pp.automationsCfg['allowUnbudgetedExecution'] === true
  const policyReady = schedulerEnabled && !allowUnbudgetedExecution && budgetsArr.length > 0 && rulesArr.length > 0

  const { activeTier, activeBudgets } = detectTierFromBudgets(pp.policyCfg, dreamCfg, memCfg, growthCfg)

  const blockingReasons: string[] = []
  if (patchError !== null) blockingReasons.push(patchError)
  if (!paths.writable) blockingReasons.push('未检测到可写的 $DSH_HOME profile cordis.patch.yml 路径')
  if (unscopedDbPaths.length > 0) blockingReasons.push(`以下数据库路径未严格限定在 $DSH_HOME 内：${unscopedDbPaths.join('；')}`)
  if (ownerRoute.missingReason !== null) blockingReasons.push(ownerRoute.missingReason)
  if (modelRoute.missingReason !== null) blockingReasons.push(modelRoute.missingReason)
  if (allowUnbudgetedExecution) blockingReasons.push('检测到 allowUnbudgetedExecution=true，违反有限预算门禁')

  const overallReady = patchError === null
    && paths.writable
    && unscopedDbPaths.length === 0
    && ownerRoute.active
    && modelRoute.ready
    && policyReady
    && (memEnabled || dreamEnabled || growthEnabled)

  const restartCommand = paths.dshHome !== null
    ? `DSH_HOME=${JSON.stringify(paths.dshHome)} dsh --profile ${paths.profileName}`
    : `dsh --profile ${paths.profileName}`

  return Object.freeze({
    profile: Object.freeze({
      dshHome: paths.dshHome,
      profileName: paths.profileName,
      patchPath: paths.patchPath,
      patchExists: paths.patchExists,
      writable: paths.writable,
      dbPathsScoped: unscopedDbPaths.length === 0,
      unscopedDbPaths,
      restartCommand,
    }),
    ownerRoute: Object.freeze({
      configured: ownerRoute.configured,
      active: ownerRoute.active,
      channel: ownerRoute.channel,
      authorityId: ownerRoute.authorityId,
      principalId: ownerRoute.principalId,
      workspace: ownerRoute.workspace,
      preset: ownerRoute.preset,
      webGrantReady: ownerRoute.webGrantReady,
      missingReason: ownerRoute.missingReason,
    }),
    modelRoute,
    grants: Object.freeze({
      memoryLearning: Object.freeze({
        installed: hasInstalledBundle(installedPackages, '@dsh-ray/assistant-memory-learning',
          seq !== undefined && findPatchRow(seq, 'dsh-ray-assistant-memory-learning') !== undefined,
          findEntry(descriptors, ns => ns.endsWith('assistant-memory-learning')) !== undefined),
        configured: memConfigured,
        enabled: memEnabled,
        threeAuthoritiesIndependent,
        expiresAt: memExpiresAt,
        expired: memExpired,
        workItemExperiences: memCfg['workItemExperiences'] === true
          && reviewCfg['workItemExperiences'] === true
          && adoptCfg['workItemExperiences'] === true,
        databasePath: memDb,
      }),
      dreaming: Object.freeze({
        installed: hasInstalledBundle(installedPackages, '@dsh-ray/assistant-dreaming',
          seq !== undefined && findPatchRow(seq, 'dsh-ray-assistant-dreaming') !== undefined,
          findEntry(descriptors, ns => ns.endsWith('assistant-dreaming')) !== undefined),
        configured: dreamConfigured,
        enabled: dreamEnabled,
        retired: dreamRetired,
        maxDreamsPerDay: typeof dreamCfg['maxDreamsPerDay'] === 'number' ? Math.trunc(dreamCfg['maxDreamsPerDay']) : null,
        maxIdeasPerWake: typeof dreamCfg['maxIdeasPerWake'] === 'number' ? Math.trunc(dreamCfg['maxIdeasPerWake']) : null,
        databasePath: dreamDb,
      }),
      growthDriver: Object.freeze({
        installed: hasInstalledBundle(installedPackages, '@dsh-ray/assistant-growth-driver',
          seq !== undefined && findPatchRow(seq, 'dsh-ray-assistant-growth-driver') !== undefined,
          findEntry(descriptors, ns => ns.endsWith('assistant-growth-driver')) !== undefined),
        configured: growthConfigured,
        enabled: growthEnabled,
        usageEnabled: usageCfg['enabled'] === true,
        dreamingIdeasEnabled: asPlainRecord(growthCfg['dreamingIdeas'])['enabled'] === true,
        databasePath: growthDb,
      }),
      assistantPolicy: Object.freeze({
        installed: hasInstalledBundle(installedPackages, '@dsh-ray/personal-assistant',
          pp.policyRow !== undefined, descriptors.some(d => /personal-assistant|assistant-policy$/u.test(d.ns))),
        schedulerEnabled,
        allowUnbudgetedExecution,
        rulesCount: rulesArr.length,
        budgetsCount: budgetsArr.length,
        ready: policyReady,
      }),
    }),
    activeTier,
    activeBudgets,
    overallReady,
    blockingReasons: blockingReasons.slice(0, 32),
  })
}

export function upsertById(existing: unknown, items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const list = Array.isArray(existing) ? existing.map(asPlainRecord) : []
  const byId = new Map<string, number>()
  list.forEach((item, index) => {
    if (typeof item['id'] === 'string') byId.set(item['id'], index)
  })
  for (const nextItem of items) {
    const id = nextItem['id']
    if (typeof id !== 'string') continue
    const idx = byId.get(id)
    if (idx !== undefined) list[idx] = nextItem
    else {
      byId.set(id, list.length)
      list.push(nextItem)
    }
  }
  return list
}

function findReusableWorkspaceOrGlobalBudgetId(
  existingBudgets: readonly Record<string, unknown>[],
  scope: 'workspace' | 'global',
  preferredId: string,
): string {
  const existing = existingBudgets.find(b =>
    b['metric'] === 'automation-runs'
    && b['periodMs'] === DAY_MS
    && b['scope'] === scope
    && typeof b['id'] === 'string')
  return typeof existing?.['id'] === 'string' && existing['id'] !== '' ? existing['id'] : preferredId
}

export function resolveScopedDbTarget(
  canonicalHome: string,
  subdir: string,
  filename: string,
  existingNode: unknown,
): string {
  const existing = checkScopedDbPath(existingNode, canonicalHome)
  if (existing.scoped && existing.resolved !== null) {
    return existing.resolved
  }
  const target = join(canonicalHome, subdir, filename)
  if (!insideDirectory(canonicalHome, target)) {
    throw new Error(`目标数据库路径越出 $DSH_HOME：${target}`)
  }
  return target
}

const GRANT_GENERATION_SUFFIX = /-g([0-9]+)$/u

const LEARNING_CONFIG_DIGEST_KEYS = [
  'databasePath',
  'authorityId',
  'owner',
  'expiresAt',
  'maxExtractions',
  'maxPending',
  'lookbackMs',
  'policy',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'budgetId',
  'budgetAmount',
  'scanBudgetId',
  'scanBudgetAmount',
  'reviewAuthorityId',
  'reviewAuthorityDigest',
  'adoptionAuthorityId',
  'adoptionGrantDigest',
] as const

export function normalizeProfileSlug(profileName: string): string {
  return profileName.replace(/[^A-Za-z0-9._-]/gu, '-') || 'default'
}

/** Mirror exact normalization applied by personal-memory / assistant-verifier
 * before hashing (`workItemExperiences !== true` is omitted, and `databasePath` is resolved to absolute). */
export function normalizeMemoryGrantForDigest(
  cfg: Readonly<Record<string, unknown>>,
  resolvedDatabasePath?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg }
  if (out['workItemExperiences'] !== true) delete out['workItemExperiences']
  if (resolvedDatabasePath !== undefined) out['databasePath'] = resolvedDatabasePath
  return out
}

/** Mirror exact normalization applied by assistant-memory-learning `validateLearningConfig`
 * before hashing (`enabled` is deleted, explicit `false` is preserved, omitted defaults to `true`,
 * and `databasePath` is resolved to absolute). */
export function normalizeLearningConfigForDigest(
  cfg: Readonly<Record<string, unknown>>,
  resolvedDatabasePath?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg }
  delete out['enabled']
  if (typeof out['workItemExperiences'] !== 'boolean') {
    out['workItemExperiences'] = true
  }
  if (resolvedDatabasePath !== undefined) out['databasePath'] = resolvedDatabasePath
  return out
}

function hasCompleteLearningDigestFields(cfg: Readonly<Record<string, unknown>>): boolean {
  return LEARNING_CONFIG_DIGEST_KEYS.every(key => cfg[key] !== undefined)
}

export function stripGrantGenerationSuffix(id: string): string {
  return id.replace(GRANT_GENERATION_SUFFIX, '')
}

export function parseGrantGeneration(id: string | null | undefined): number {
  if (typeof id !== 'string') return 1
  const match = GRANT_GENERATION_SUFFIX.exec(id)
  if (match === null) return 1
  const parsed = Number.parseInt(match[1] ?? '1', 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1
}

export function formatGrantIdWithGeneration(baseId: string, generation: number): string {
  const clean = stripGrantGenerationSuffix(baseId)
  return generation <= 1 ? clean : `${clean}-g${generation}`
}

function readPersonalMemoryGrants(dbPath: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  let db: DatabaseSync | undefined
  try {
    if (!existsSync(dbPath)) return out
    const st = lstatSync(dbPath)
    if (st.isSymbolicLink() || !st.isFile()) return out
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare(
      `SELECT authority_id, grant_digest FROM memory_learning_adoptions WHERE row_kind = 'grant'`,
    ).all() as Array<{ authority_id?: unknown; grant_digest?: unknown }>
    for (const row of rows) {
      if (typeof row.authority_id === 'string' && typeof row.grant_digest === 'string') {
        out.set(row.authority_id, row.grant_digest)
      }
    }
  } catch {
    // Missing table or unreadability falls back to empty map.
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
  return out
}

function readVerifierReviewGrants(
  verifierDbPath: string,
): ReadonlyMap<string, Readonly<{ digest: string; max: number }>> {
  const out = new Map<string, Readonly<{ digest: string; max: number }>>()
  const ledgerPath = `${verifierDbPath}.memory-reviews`
  let db: DatabaseSync | undefined
  try {
    if (!existsSync(ledgerPath)) return out
    const st = lstatSync(ledgerPath)
    if (st.isSymbolicLink() || !st.isFile()) return out
    db = new DatabaseSync(ledgerPath, { readOnly: true })
    const rows = db.prepare(`SELECT authority, digest, max FROM grants`).all() as Array<{
      authority?: unknown
      digest?: unknown
      max?: unknown
    }>
    for (const row of rows) {
      if (typeof row.authority === 'string' && typeof row.digest === 'string' && typeof row.max === 'number') {
        out.set(row.authority, Object.freeze({ digest: row.digest, max: row.max }))
      }
    }
  } catch {
    // Missing table or unreadability falls back to empty map.
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
  return out
}

function readMemoryLearningStoreGrant(
  dbPath: string,
): Readonly<{ authorityId: string; configDigest: string; maxExtractions: number }> | 'unreadable' | null {
  if (!existsSync(dbPath)) return null
  let db: DatabaseSync | undefined
  try {
    const st = lstatSync(dbPath)
    if (st.isSymbolicLink() || !st.isFile()) return 'unreadable'
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare(
      `SELECT authority_id, config_digest, max_extractions FROM grant_record`,
    ).all() as Array<{ authority_id?: unknown; config_digest?: unknown; max_extractions?: unknown }>
    if (rows.length === 0) return null
    if (rows.length !== 1) return 'unreadable'
    const row = rows[0]!
    if (typeof row.authority_id !== 'string' || typeof row.config_digest !== 'string' || typeof row.max_extractions !== 'number') {
      return 'unreadable'
    }
    return Object.freeze({
      authorityId: row.authority_id,
      configDigest: row.config_digest,
      maxExtractions: row.max_extractions,
    })
  } catch {
    return 'unreadable'
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

function maxSqliteFileGeneration(canonicalHome: string, profileSlug: string): number {
  const dir = join(canonicalHome, 'assistant-memory-learning')
  let maxGen = 1
  try {
    if (!existsSync(dir)) return maxGen
    const re = new RegExp(`^${profileSlug.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-g([0-9]+)\\.sqlite$`, 'u')
    for (const entry of readdirSync(dir)) {
      const m = re.exec(entry)
      if (m !== null) {
        const parsed = Number.parseInt(m[1] ?? '1', 10)
        if (Number.isSafeInteger(parsed) && parsed > maxGen) maxGen = parsed
      }
    }
  } catch {
    // Directory absent or unreadable.
  }
  return maxGen
}

function resolveMemoryLearningDbPaths(
  canonicalHome: string,
  profileSlug: string,
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
  pp: ReturnType<typeof getPersonalAndPolicyConfigs>,
): Readonly<{ personalMemoryDbPath: string; verifierDbPath: string; memoryLearningDbPath: string }> {
  const pmRow = seq
    ? (pp.layout === 'split'
      ? findPatchRow(seq, 'dsh-ray-personal-memory')
      : findPatchRow(seq, 'dsh-ray-personal-assistant'))
    : undefined
  const pmCfgNode = pmRow ? readConfigMap(pmRow, 'config') : undefined
  const pmRaw: unknown = pmCfgNode?.get('personalMemory', true)
  const pmSectionNode = pp.layout === 'split'
    ? pmCfgNode
    : (isMap(pmRaw) ? pmRaw : undefined)
  const personalMemoryDbPath = resolveScopedDbTarget(
    canonicalHome,
    'personal-memory',
    'memory.sqlite',
    pmSectionNode?.get('databasePath', true) ?? pp.personalMemoryCfg['databasePath'],
  )

  const verifierNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-verifier') : undefined
  const verifierCfg = mergeDescriptorConfig(
    descriptors,
    'dsh-ray-assistant-verifier',
    seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-verifier') : {},
  )
  const verifierDbPath = resolveScopedDbTarget(
    canonicalHome,
    'assistant-verifier',
    'verification.sqlite',
    verifierNode?.get('databasePath', true) ?? verifierCfg['databasePath'],
  )

  const memNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-memory-learning') : undefined
  const memCfg = mergeDescriptorConfig(
    descriptors,
    'dsh-ray-assistant-memory-learning',
    seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-memory-learning') : {},
  )
  const memoryLearningDbPath = resolveScopedDbTarget(
    canonicalHome,
    'assistant-memory-learning',
    `${profileSlug}.sqlite`,
    memNode?.get('databasePath', true) ?? memCfg['databasePath'],
  )
  return Object.freeze({ personalMemoryDbPath, verifierDbPath, memoryLearningDbPath })
}

export interface MemoryGrantConflictReport {
  readonly hasConflict: boolean
  readonly reasons: readonly string[]
  readonly adoptConflict: boolean
  readonly reviewConflict: boolean
  readonly learningStoreConflict: boolean
  readonly digestMismatch: boolean
  readonly adoptId: string | null
  readonly reviewId: string | null
  readonly extractId: string | null
  readonly nextGeneration: number
  readonly storedAdoptGrants: ReadonlyMap<string, string>
  readonly storedReviewGrants: ReadonlyMap<string, Readonly<{ digest: string; max: number }>>
  readonly memoryLearningDbPath: string | null
}

/** Detect frozen-grant idempotency conflicts between cordis.patch.yml and local SQLite ledgers
 * that cause personal-memory / personal-assistant / assistant-memory-learning to crash at startup. */
export function inspectMemoryLearningGrantConflicts(
  paths: ProfilePaths,
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
): MemoryGrantConflictReport {
  const emptyGrants = new Map<string, string>()
  const emptyReviews = new Map<string, Readonly<{ digest: string; max: number }>>()
  const pp = getPersonalAndPolicyConfigs(seq, descriptors)
  const adoptCfg = asPlainRecord(pp.personalMemoryCfg['automaticLearning'])
  const verifierCfg = mergeDescriptorConfig(
    descriptors,
    'dsh-ray-assistant-verifier',
    seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-verifier') : {},
  )
  const reviewCfg = asPlainRecord(verifierCfg['memoryReviews'])
  const memCfg = mergeDescriptorConfig(
    descriptors,
    'dsh-ray-assistant-memory-learning',
    seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-memory-learning') : {},
  )
  const adoptId = strOrNull(adoptCfg['authorityId'])
  const reviewId = strOrNull(reviewCfg['authorityId'])
  const extractId = strOrNull(memCfg['authorityId'])
  if (adoptId === null && reviewId === null && extractId === null) {
    return Object.freeze({
      hasConflict: false,
      reasons: [],
      adoptConflict: false,
      reviewConflict: false,
      learningStoreConflict: false,
      digestMismatch: false,
      adoptId: null,
      reviewId: null,
      extractId: null,
      nextGeneration: 2,
      storedAdoptGrants: emptyGrants,
      storedReviewGrants: emptyReviews,
      memoryLearningDbPath: null,
    })
  }

  const profileSlug = normalizeProfileSlug(paths.profileName)
  const dbPaths = paths.canonicalHome !== null
    ? resolveMemoryLearningDbPaths(paths.canonicalHome, profileSlug, seq, descriptors, pp)
    : null
  const storedAdoptGrants = dbPaths !== null ? readPersonalMemoryGrants(dbPaths.personalMemoryDbPath) : emptyGrants
  const storedReviewGrants = dbPaths !== null ? readVerifierReviewGrants(dbPaths.verifierDbPath) : emptyReviews
  const storedLearningGrant = dbPaths !== null ? readMemoryLearningStoreGrant(dbPaths.memoryLearningDbPath) : null

  const reasons: string[] = []
  let adoptConflict = false
  let reviewConflict = false
  let learningStoreConflict = false
  let digestMismatch = false

  const normalizedAdoptCfg = normalizeMemoryGrantForDigest(adoptCfg)
  const normalizedReviewCfg = normalizeMemoryGrantForDigest(reviewCfg)
  const normalizedMemCfg = normalizeLearningConfigForDigest(memCfg, dbPaths?.memoryLearningDbPath)
  const adoptDigest = adoptId !== null ? canonicalObjectDigest(normalizedAdoptCfg) : null
  const reviewDigest = reviewId !== null ? canonicalObjectDigest(normalizedReviewCfg) : null

  if (adoptId !== null && adoptDigest !== null) {
    const storedDigest = storedAdoptGrants.get(adoptId)
    if (storedDigest !== undefined && storedDigest !== adoptDigest) {
      adoptConflict = true
      reasons.push(`personal-memory 账本中已冻结的 ${adoptId} 与当前 cordis.patch.yml 摘要不一致`)
    }
  }
  if (reviewId !== null && reviewDigest !== null) {
    const storedReview = storedReviewGrants.get(reviewId)
    const maxReviews = typeof reviewCfg['maxReviews'] === 'number' ? reviewCfg['maxReviews'] : null
    if (storedReview !== undefined && (storedReview.digest !== reviewDigest || (maxReviews !== null && storedReview.max !== maxReviews))) {
      reviewConflict = true
      reasons.push(`assistant-verifier 评审账本中已冻结的 ${reviewId} 与当前配置不一致`)
    }
  }
  const memDisabled = isRowDisabled(seq, 'dsh-ray-assistant-memory-learning')
  if (extractId !== null && !memDisabled && dbPaths !== null && storedLearningGrant !== null) {
    const maxExtractions = typeof memCfg['maxExtractions'] === 'number' ? memCfg['maxExtractions'] : null
    const expectedConfigDigest = hasCompleteLearningDigestFields(normalizedMemCfg)
      ? canonicalObjectDigest(normalizedMemCfg)
      : null
    if (storedLearningGrant === 'unreadable'
      || storedLearningGrant.authorityId !== extractId
      || (maxExtractions !== null && storedLearningGrant.maxExtractions !== maxExtractions)
      || (expectedConfigDigest !== null && storedLearningGrant.configDigest !== expectedConfigDigest)) {
      learningStoreConflict = true
      reasons.push(`assistant-memory-learning 数据库中已冻结的提取授权与当前 ${extractId} 配置不一致`)
    }
  }
  if (adoptId !== null && reviewId !== null && reviewDigest !== null) {
    if (strOrNull(adoptCfg['reviewAuthorityId']) !== reviewId
      || strOrNull(adoptCfg['reviewAuthorityDigest']) !== reviewDigest) {
      digestMismatch = true
      reasons.push('personal-memory 的 reviewAuthorityId/reviewAuthorityDigest 与 assistant-verifier 不一致')
    }
  }
  if (extractId !== null && !memDisabled) {
    if (reviewId !== null && reviewDigest !== null && (
      strOrNull(memCfg['reviewAuthorityId']) !== reviewId
      || strOrNull(memCfg['reviewAuthorityDigest']) !== reviewDigest
    )) {
      digestMismatch = true
      reasons.push('assistant-memory-learning 的 reviewAuthorityId/reviewAuthorityDigest 与 assistant-verifier 不一致')
    }
    if (adoptId !== null && adoptDigest !== null && (
      strOrNull(memCfg['adoptionAuthorityId']) !== adoptId
      || strOrNull(memCfg['adoptionGrantDigest']) !== adoptDigest
    )) {
      digestMismatch = true
      reasons.push('assistant-memory-learning 的 adoptionAuthorityId/adoptionGrantDigest 与 personal-memory 不一致')
    }
  }

  let maxGen = Math.max(
    parseGrantGeneration(adoptId),
    parseGrantGeneration(reviewId),
    parseGrantGeneration(extractId),
    paths.canonicalHome !== null ? maxSqliteFileGeneration(paths.canonicalHome, profileSlug) : 1,
  )
  for (const key of storedAdoptGrants.keys()) maxGen = Math.max(maxGen, parseGrantGeneration(key))
  for (const key of storedReviewGrants.keys()) maxGen = Math.max(maxGen, parseGrantGeneration(key))

  return Object.freeze({
    hasConflict: adoptConflict || reviewConflict || learningStoreConflict || digestMismatch,
    reasons,
    adoptConflict,
    reviewConflict,
    learningStoreConflict,
    digestMismatch,
    adoptId,
    reviewId,
    extractId,
    nextGeneration: Math.max(2, maxGen + 1),
    storedAdoptGrants,
    storedReviewGrants,
    memoryLearningDbPath: dbPaths?.memoryLearningDbPath ?? null,
  })
}

export function atomicWritePatchWithBackup(patchPath: string, serialized: string, now: number): Readonly<{ backupPath: string | null }> {
  const dir = dirname(patchPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let backupPath: string | null = null
  if (existsSync(patchPath)) {
    const st = lstatSync(patchPath)
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('cordis.patch.yml 是符号链接，拒绝覆写')
    }
    backupPath = `${patchPath}.bak.${now}`
    const original = readFileSync(patchPath, 'utf8')
    const bakTemp = `${backupPath}.${randomUUID()}.tmp`
    writeFileSync(bakTemp, original, { encoding: 'utf8', mode: 0o600 })
    chmodSync(bakTemp, 0o600)
    renameSync(bakTemp, backupPath)
  }

  // Re-parse serialized YAML before atomic swap to ensure !!js tags and structure are valid.
  const verifyDoc = parseDocument(serialized, { customTags: [CUSTOM_JS_TAG] })
  if (verifyDoc.errors.length > 0 || !isSeq(verifyDoc.contents)) {
    throw new Error(`生成的 cordis.patch.yml 校验失败：${verifyDoc.errors[0]?.message ?? 'not a YAML sequence'}`)
  }

  const tmpPath = `${patchPath}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmpPath, 0o600)
  try {
    renameSync(tmpPath, patchPath)
  } catch (error: unknown) {
    if (backupPath !== null && existsSync(backupPath)) {
      try {
        const prev = readFileSync(backupPath, 'utf8')
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
          | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
        const fd = openSync(patchPath, flags, 0o600)
        try { writeFileSync(fd, prev, 'utf8') } finally { closeSync(fd) }
      } catch { /* best-effort rollback */ }
    }
    throw error
  }
  return { backupPath }
}

function applyPatchTraexRoute(doc: Document, seq: YAMLSeq, targetProvider: string): void {
  if (targetProvider !== 'traex-agent' && targetProvider !== 'agy-agent') return
  const traexRow = findPatchRow(seq, 'dsh-ray-traex-acp-provider')
  if (traexRow !== undefined) {
    const key = targetProvider === 'traex-agent' ? 'enabled' : 'agyEnabled'
    const cfg = ensureConfigMap(doc, traexRow, 'config')
    cfg.set(key, true)
  }
}

export async function applyLiveModelRouteSettings(
  host: AutonomyHostContext,
  settings: SettingsService | undefined,
  descriptors: readonly SettingsDescriptor[],
  targetProvider: string,
  targetModel: string,
  targetEffort: string,
  reloadEntry?: (entryId: string) => Promise<string>,
): Promise<string> {
  if (settings === undefined) return ''
  let traexNote = ''
  if (targetProvider === 'traex-agent' || targetProvider === 'agy-agent') {
    const traex = findEntry(descriptors, ns => ns.endsWith('traex-acp-provider'))
    if (traex !== undefined) {
      const key = targetProvider === 'traex-agent' ? 'enabled' : 'agyEnabled'
      if (boundedConfig(traex.value)[key] !== true) {
        await settings.mutate(traex.ns, [{ op: 'set', path: [key], value: true }], traex.revision)
        if (reloadEntry !== undefined) traexNote = await reloadEntry(traex.ns)
      }
    }
  }
  const defaultEntry = findEntry(descriptors, ns => ns.endsWith('agent-default-model'))
  if (defaultEntry !== undefined) {
    await settings.mutate(defaultEntry.ns, [
      { op: 'set', path: ['provider'], value: targetProvider },
      { op: 'set', path: ['model'], value: targetModel },
      targetEffort === ''
        ? { op: 'unset', path: ['reasoningEffort'] }
        : { op: 'set', path: ['reasoningEffort'], value: targetEffort },
    ], defaultEntry.revision)
  } else {
    const svc = host.get('agentDefaultModel') as AgentDefaultModelService | undefined
    if (typeof svc?.saveSelection === 'function') {
      await svc.saveSelection({
        provider: targetProvider,
        model: targetModel,
        ...(targetEffort === '' ? {} : { reasoningEffort: targetEffort }),
      })
    }
  }
  return traexNote
}

/** Validate prerequisites and apply autonomy authorization / safe pause / disable atomically. */
export async function applyAutonomyWizardSetup(
  host: AutonomyHostContext,
  input: ConfigureAutonomySetupInput,
): Promise<OwnerConsoleWriteResult> {
  const now = input.now ?? Date.now()
  const env = input.env ?? process.env
  const paths = resolveProfilePaths(host, env)
  if (paths.canonicalHome === null || paths.patchPath === null || !paths.writable) {
    return failResult('cordis.patch.yml', '缺少可写的 $DSH_HOME profile 路径或检测到符号链接，拒绝写入')
  }

  let doc: Document
  try {
    doc = readPatchDocument(paths.patchPath)
  } catch (error: unknown) {
    return failResult('cordis.patch.yml', error instanceof Error ? error.message : String(error))
  }
  const seq = doc.contents as YAMLSeq

  if (input.action === 'pause' || input.action === 'disable') {
    const affected: string[] = []
    if (input.enableMemoryLearning) {
      const row = findPatchRow(seq, 'dsh-ray-assistant-memory-learning')
      if (row !== undefined) {
        row.set('disabled', true)
        affected.push('记忆自学习')
      }
    }
    if (input.enableDreaming) {
      const row = findPatchRow(seq, 'dsh-ray-assistant-dreaming')
      if (row !== undefined) {
        const cfg = readConfigMap(row, 'config')
        if (input.action === 'pause') {
          if (cfg !== undefined) {
            cfg.set('enabled', true)
            cfg.set('retired', true)
          }
          affected.push('做梦（已安全暂停）')
        } else {
          if (cfg !== undefined) {
            cfg.delete('retired')
            cfg.set('enabled', false)
          }
          row.set('disabled', true)
          affected.push('做梦（已停用）')
        }
      }
    }
    if (input.enableGrowth) {
      const row = findPatchRow(seq, 'dsh-ray-assistant-growth-driver')
      if (row !== undefined) {
        const cfg = readConfigMap(row, 'config')
        if (cfg !== undefined) {
          cfg.set('enabled', false)
          for (const subKey of ['workflowOwnerAnchored', 'dreamingIdeas', 'usageLearning', 'pluginSourceProposals'] as const) {
            const subMap = readConfigMap(cfg, subKey)
            if (subMap !== undefined) subMap.set('enabled', false)
          }
        }
        if (input.action === 'disable') row.set('disabled', true)
        affected.push('技能演化')
      }
    }
    if (affected.length === 0) {
      return failResult('cordis.patch.yml', '未选择需要暂停或停用的已配置自主模块')
    }
    try {
      const { backupPath } = atomicWritePatchWithBackup(paths.patchPath, doc.toString({ lineWidth: 0 }), now)
      const backupNote = backupPath !== null ? `（已备份 ${basename(backupPath)}）` : ''
      return Object.freeze({
        applied: true,
        entry: 'cordis.patch.yml',
        note: `已保留既有账本与有限预算，更新：${affected.join('、')}${backupNote}；非易失配置请重启 profile 后生效（DSH_HOME=${paths.dshHome} dsh --profile ${paths.profileName}）`,
      })
    } catch (error: unknown) {
      return failResult('cordis.patch.yml', error instanceof Error ? error.message : String(error))
    }
  }

  // `action === 'enable'`
  if (!input.enableMemoryLearning && !input.enableDreaming && !input.enableGrowth) {
    return failResult('cordis.patch.yml', '请至少勾选一项要开启的自主能力（记忆自学习 / 做梦 / 技能演化）')
  }

  let budgets: AutonomyBudgetLimits
  if (input.tier === 'custom') {
    const parsed = AutonomyBudgetLimitsSchema.safeParse(input.customBudget)
    if (!parsed.success) {
      return failResult('assistantPolicy', `自定义有限预算超出安全范围：${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }
    budgets = parsed.data
  } else {
    budgets = AUTONOMY_TIER_PRESETS[input.tier]
  }

  const preflight = await inspectAutonomyWizardStatus(host, { now, env })
  if (!preflight.profile.dbPathsScoped) {
    return failResult('cordis.patch.yml', `检测到越权或全局 ~/.dsh 数据库路径，拒绝写入：${preflight.profile.unscopedDbPaths.join('；')}`)
  }
  if (!preflight.ownerRoute.active) {
    return failResult('assistant-delivery', preflight.ownerRoute.missingReason ?? '未检测到激活的 owner 路由')
  }

  const settings = host.get('settings') as SettingsService | undefined
  const descriptors = settings?.describe({ redactSecrets: true }) ?? []
  const owner = inspectOwnerRoute(host, paths, seq, descriptors)
  if (!owner.active || owner.authorityId === null || owner.authorityHash === null || owner.principalId === null
    || owner.principalRecordId === null || owner.principalVersion === null) {
    return failResult('assistant-delivery', owner.missingReason ?? 'owner 主体 lineage 不完整，拒绝签发自主授权')
  }

  // Validate requested model route.
  const reqProvider = input.provider.trim() !== '' ? input.provider.trim() : (preflight.modelRoute.provider ?? '')
  const reqModelRaw = input.model.trim() !== '' ? input.model.trim() : (preflight.modelRoute.model ?? '')
  const reqEffort = input.reasoningEffort.trim()
  if (!PROVIDER_TOKEN.test(reqProvider)) {
    return failResult('agent-default-model', '请先选择有效的默认模型或编程工具路由（traex-agent / agy-agent / API）')
  }
  const reqModel = (reqProvider === 'traex-agent' || reqProvider === 'agy-agent')
    ? (reqModelRaw === '' ? 'default' : reqModelRaw)
    : reqModelRaw
  if (reqModel === '' || reqModel.length > 256 || hasControlChars(reqModel)) {
    return failResult('agent-default-model', 'API 路由必须指定有效的 model 名称')
  }
  if (reqEffort !== '' && (reqEffort.length > 128 || hasControlChars(reqEffort))) {
    return failResult('agent-default-model', 'reasoningEffort 格式无效')
  }
  if ((reqProvider === 'traex-agent' || reqProvider === 'agy-agent') && !preflight.modelRoute.traexInstalled) {
    return failResult('dsh-ray-traex-acp-provider', '@dsh-ray/traex-acp-provider 未安装，无法使用 ACP 编程工具路由')
  }

  // Validate installed bundle presence if pluginManager is active.
  if (input.enableMemoryLearning && !preflight.grants.memoryLearning.installed && preflight.grants.assistantPolicy.installed) {
    return failResult('dsh-ray-assistant-memory-learning', '@dsh-ray/assistant-memory-learning 未安装，请先在插件页安装')
  }
  if (input.enableDreaming && !preflight.grants.dreaming.installed && preflight.grants.assistantPolicy.installed) {
    return failResult('dsh-ray-assistant-dreaming', '@dsh-ray/assistant-dreaming 未安装，请先在插件页安装')
  }
  if (input.enableGrowth && !preflight.grants.growthDriver.installed && preflight.grants.assistantPolicy.installed) {
    return failResult('dsh-ray-assistant-growth-driver', '@dsh-ray/assistant-growth-driver 未安装，请先在插件页安装')
  }

  const profileSlug = normalizeProfileSlug(paths.profileName)
  const prefix = owner.channel === 'lark' ? 'lark' : 'web'
  const expiresAt = now + budgets.grantLeaseDays * DAY_MS
  const learningOwner = {
    authorityId: owner.authorityId,
    authorityHash: owner.authorityHash,
    principalId: owner.principalId,
    principalRecordId: owner.principalRecordId,
    principalVersion: owner.principalVersion,
    workspace: owner.workspace,
    agentPreset: owner.preset,
  }
  const dreamGrowthScope = {
    workspace: owner.workspace,
    preset: owner.preset,
    principalId: owner.principalId,
    ownerRouteId: owner.authorityId,
  }
  const modelRef = {
    provider: reqProvider,
    model: reqModel,
    ...(reqEffort !== '' ? { reasoningEffort: reqEffort } : {}),
  }

  const pp = getPersonalAndPolicyConfigs(seq, descriptors)
  const existingBudgets = Array.isArray(pp.policyCfg['budgets']) ? pp.policyCfg['budgets'].map(asPlainRecord) : []
  const newBudgets: Record<string, unknown>[] = []
  const newRules: Record<string, unknown>[] = []
  const enabledNames: string[] = []

  // 1) Memory self-learning + Verifier + PersonalMemory adoption (3 independent authorities)
  if (input.enableMemoryLearning) {
    const baseExtractAuthId = `${prefix}-memory-extract-${profileSlug}`
    const baseReviewAuthId = `${prefix}-memory-review-${profileSlug}`
    const baseAdoptAuthId = `${prefix}-memory-adopt-${profileSlug}`
    const existingMemNode = getPatchRowConfigNode(seq, 'dsh-ray-assistant-memory-learning')
    const existingMemCfg = getPatchRowConfig(seq, 'dsh-ray-assistant-memory-learning')
    const existingVerifierCfg = getPatchRowConfig(seq, 'dsh-ray-assistant-verifier')
    const existingReviewCfg = asPlainRecord(existingVerifierCfg['memoryReviews'])
    const existingAdoptCfg = asPlainRecord(pp.personalMemoryCfg['automaticLearning'])
    const dbPaths = resolveMemoryLearningDbPaths(paths.canonicalHome, profileSlug, seq, descriptors, pp)
    const baseMemoryDbPath = resolveScopedDbTarget(
      paths.canonicalHome,
      'assistant-memory-learning',
      `${profileSlug}.sqlite`,
      existingMemNode?.get('databasePath', true) ?? existingMemCfg['databasePath'],
    )
    const storedAdoptGrants = readPersonalMemoryGrants(dbPaths.personalMemoryDbPath)
    const storedReviewGrants = readVerifierReviewGrants(dbPaths.verifierDbPath)
    const memoryBudgetId = findReusableWorkspaceOrGlobalBudgetId(existingBudgets, 'workspace', `${prefix}-memory-learning-${profileSlug}`)
    const memoryScanBudgetId = `${prefix}-memory-scan-${profileSlug}`

    let maxSeenGen = Math.max(
      parseGrantGeneration(strOrNull(existingAdoptCfg['authorityId'])),
      parseGrantGeneration(strOrNull(existingReviewCfg['authorityId'])),
      parseGrantGeneration(strOrNull(existingMemCfg['authorityId'])),
      maxSqliteFileGeneration(paths.canonicalHome, profileSlug),
    )
    for (const key of storedAdoptGrants.keys()) maxSeenGen = Math.max(maxSeenGen, parseGrantGeneration(key))
    for (const key of storedReviewGrants.keys()) maxSeenGen = Math.max(maxSeenGen, parseGrantGeneration(key))

    const buildMemoryGrantBundle = (gen: number) => {
      const candidateExtractId = formatGrantIdWithGeneration(baseExtractAuthId, gen)
      const candidateReviewId = formatGrantIdWithGeneration(baseReviewAuthId, gen)
      const candidateAdoptId = formatGrantIdWithGeneration(baseAdoptAuthId, gen)
      const candidateDbPath = gen <= 1
        ? baseMemoryDbPath
        : resolveScopedDbTarget(paths.canonicalHome!, 'assistant-memory-learning', `${profileSlug}-g${gen}.sqlite`, undefined)
      const workItemExperiences = typeof input.workItemExperiences === 'boolean' ? input.workItemExperiences : true
      const candidateReviewConfig = {
        authorityId: candidateReviewId,
        owner: learningOwner,
        expiresAt,
        maxReviews: Math.min(10_000, Math.max(100, budgets.dailyMemoryExtractions * budgets.grantLeaseDays)),
        policy: 'Independently verify exact owner statements for facts and preferences and trusted owner objectives with canonical outcomes for experiences.',
        maxInputBytes: 65_536,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
        model: modelRef,
        ...(workItemExperiences ? { workItemExperiences: true } : {}),
      }
      const candidateReviewDigest = canonicalObjectDigest(candidateReviewConfig)
      const candidateAdoptionConfig = {
        authorityId: candidateAdoptId,
        owner: learningOwner,
        reviewAuthorityId: candidateReviewId,
        reviewAuthorityDigest: candidateReviewDigest,
        expiresAt,
        maxMutations: Math.min(1_000, Math.max(50, budgets.dailyMemoryExtractions * budgets.grantLeaseDays)),
        maxTotalContentBytes: 1_048_576,
        maxRecordTtlMs: 90 * DAY_MS,
        kinds: ['fact', 'experience'],
        operations: ['add', 'replace', 'remove'],
        ...(workItemExperiences ? { workItemExperiences: true } : {}),
      }
      const candidateAdoptionDigest = canonicalObjectDigest(candidateAdoptionConfig)
      const candidateLearningConfig = {
        databasePath: candidateDbPath,
        authorityId: candidateExtractId,
        owner: learningOwner,
        expiresAt,
        maxExtractions: Math.min(10_000, Math.max(20, budgets.dailyMemoryExtractions * budgets.grantLeaseDays)),
        maxPending: 64,
        lookbackMs: 7 * DAY_MS,
        policy: 'Extract only explicit owner facts, preferences or grounded work-item experiences. Prefer noop when evidence is insufficient.',
        maxInputBytes: 65_536,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
        budgetId: memoryBudgetId,
        budgetAmount: 1,
        scanBudgetId: memoryScanBudgetId,
        scanBudgetAmount: 1,
        reviewAuthorityId: candidateReviewId,
        reviewAuthorityDigest: candidateReviewDigest,
        adoptionAuthorityId: candidateAdoptId,
        adoptionGrantDigest: candidateAdoptionDigest,
        model: modelRef,
        workItemExperiences,
      }
      return {
        extractAuthId: candidateExtractId,
        reviewAuthId: candidateReviewId,
        adoptAuthId: candidateAdoptId,
        memoryDbPath: candidateDbPath,
        reviewConfig: candidateReviewConfig,
        reviewAuthorityDigest: candidateReviewDigest,
        adoptionConfig: candidateAdoptionConfig,
        adoptionGrantDigest: candidateAdoptionDigest,
        learningConfig: candidateLearningConfig,
      }
    }

    const normalizedExistingAdopt = normalizeMemoryGrantForDigest(existingAdoptCfg)
    const normalizedExistingReview = normalizeMemoryGrantForDigest(existingReviewCfg)
    const normalizedExistingMem = normalizeLearningConfigForDigest(existingMemCfg, baseMemoryDbPath)

    const hasGenerationCollision = (bundle: ReturnType<typeof buildMemoryGrantBundle>, gen: number): boolean => {
      const storedAdopt = storedAdoptGrants.get(bundle.adoptAuthId)
      if (storedAdopt !== undefined && storedAdopt !== bundle.adoptionGrantDigest) return true
      const storedReview = storedReviewGrants.get(bundle.reviewAuthId)
      if (storedReview !== undefined
        && (storedReview.digest !== bundle.reviewAuthorityDigest || storedReview.max !== bundle.reviewConfig.maxReviews)) {
        return true
      }
      if (strOrNull(existingAdoptCfg['authorityId']) === bundle.adoptAuthId
        && canonicalObjectDigest(normalizedExistingAdopt) !== bundle.adoptionGrantDigest) {
        return true
      }
      if (strOrNull(existingReviewCfg['authorityId']) === bundle.reviewAuthId
        && canonicalObjectDigest(normalizedExistingReview) !== bundle.reviewAuthorityDigest) {
        return true
      }
      const bundleLearningDigest = canonicalObjectDigest(bundle.learningConfig)
      const learningDigestChanged = strOrNull(existingMemCfg['authorityId']) === bundle.extractAuthId
        && canonicalObjectDigest(normalizedExistingMem) !== bundleLearningDigest
      if (learningDigestChanged) return true
      if (existsSync(bundle.memoryDbPath)) {
        if (gen > maxSeenGen) return true
        const storedLearning = readMemoryLearningStoreGrant(bundle.memoryDbPath)
        if (storedLearning === 'unreadable') return true
        if (storedLearning !== null && (
          storedLearning.authorityId !== bundle.extractAuthId
          || storedLearning.maxExtractions !== bundle.learningConfig.maxExtractions
          || storedLearning.configDigest !== bundleLearningDigest
        )) {
          return true
        }
      }
      return false
    }

    let selectedGen = maxSeenGen
    let bundle = buildMemoryGrantBundle(selectedGen)
    if (hasGenerationCollision(bundle, selectedGen)) {
      selectedGen = Math.max(2, maxSeenGen + 1)
      let attempts = 0
      while (attempts < 1024) {
        bundle = buildMemoryGrantBundle(selectedGen)
        if (!hasGenerationCollision(bundle, selectedGen)) break
        selectedGen += 1
        attempts += 1
      }
      if (hasGenerationCollision(bundle, selectedGen)) {
        return failResult('assistant-memory-learning', '无法分配未冲突的记忆自学习授权代数，请清理旧账本后重试')
      }
    }

    const {
      extractAuthId,
      reviewAuthId,
      adoptAuthId,
      reviewConfig,
      adoptionConfig,
      learningConfig,
    } = bundle
    if (new Set([extractAuthId, reviewAuthId, adoptAuthId, owner.authorityId]).size !== 4) {
      return failResult('assistant-memory-learning', '三权分立 authorityId 发生碰撞，拒绝签发')
    }

    const verifierRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-verifier', '@dsh-ray/assistant-verifier')
    verifierRow.delete('disabled')
    const verifierCfgNode = ensureConfigMap(doc, verifierRow, 'config')
    const runtimeVerifierDesc = findEntry(descriptors, candidate => candidate === 'dsh-ray-assistant-verifier')
    ensureVerifierDefaults(doc, verifierCfgNode, runtimeVerifierDesc ? boundedConfig(runtimeVerifierDesc.value) : undefined)
    verifierCfgNode.set('memoryReviews', createPlainNode(doc, reviewConfig))

    const learnerRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-memory-learning', '@dsh-ray/assistant-memory-learning')
    learnerRow.set('disabled', false)
    learnerRow.set('config', createPlainNode(doc, learningConfig))

    if (pp.layout === 'split') {
      const pmRow = ensurePatchRow(doc, seq, 'dsh-ray-personal-memory', '@dsh-ray/personal-memory')
      const pmCfgNode = ensureConfigMap(doc, pmRow, 'config')
      if (!pmCfgNode.has('databasePath')) {
        const runtimePmDb = strOrNull(pp.personalMemoryCfg['databasePath'])
        pmCfgNode.set('databasePath', runtimePmDb !== null && isAbsolute(runtimePmDb)
          ? createPlainNode(doc, runtimePmDb)
          : jsDshHomeScalar('personal-memory/memory.sqlite'))
      }
      pmCfgNode.set('automaticLearning', createPlainNode(doc, adoptionConfig))
    } else {
      const paRow = ensurePatchRow(doc, seq, 'dsh-ray-personal-assistant', '@dsh-ray/personal-assistant')
      const paCfgNode = ensureConfigMap(doc, paRow, 'config')
      const pmNode = ensureConfigMap(doc, paCfgNode, 'personalMemory')
      if (!pmNode.has('databasePath')) pmNode.set('databasePath', jsDshHomeScalar('personal-memory/memory.sqlite'))
      pmNode.set('automaticLearning', createPlainNode(doc, adoptionConfig))
    }

    newBudgets.push(
      { id: memoryBudgetId, metric: 'automation-runs', limit: budgets.dailyMemoryExtractions, periodMs: DAY_MS, scope: 'workspace' },
      { id: memoryScanBudgetId, metric: 'automation-runs', limit: budgets.dailyMemoryScans, periodMs: DAY_MS, scope: 'subject' },
    )
    const makeMemSubject = () => ({ kind: 'background', id: 'assistant-memory-learning', workspace: owner.workspace, principal: owner.principalId })
    const makeMemCtx = () => ({ initiators: ['background'] })
    newRules.push(
      { id: `wizard-${prefix}-mem-extract-${profileSlug}`, effect: 'allow', subject: makeMemSubject(), actions: ['extract'], resource: { kind: 'memory', id: `learning:${extractAuthId}` }, context: makeMemCtx() },
      { id: `wizard-${prefix}-mem-review-${profileSlug}`, effect: 'allow', subject: makeMemSubject(), actions: ['review'], resource: { kind: 'memory', id: `learning:${reviewAuthId}` }, context: makeMemCtx() },
      { id: `wizard-${prefix}-mem-adopt-${profileSlug}`, effect: 'allow', subject: makeMemSubject(), actions: ['adopt'], resource: { kind: 'memory', id: `learning:${adoptAuthId}` }, context: makeMemCtx() },
      { id: `wizard-${prefix}-mem-scan-reconcile-${profileSlug}`, effect: 'allow', subject: makeMemSubject(), actions: ['reconcile'], resource: { kind: 'automation', id: 'memory-scan-*' }, context: makeMemCtx() },
      { id: `wizard-${prefix}-mem-scan-exec-${profileSlug}`, effect: 'allow', subject: { kind: 'background', id: 'memory-scan-*', workspace: owner.workspace, principal: owner.principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'memory-scan-*' }, context: makeMemCtx() },
      { id: `wizard-${prefix}-mem-job-reconcile-${profileSlug}`, effect: 'allow', subject: makeMemSubject(), actions: ['reconcile'], resource: { kind: 'automation', id: 'memory-learning:*' }, context: makeMemCtx() },
      { id: `wizard-${prefix}-mem-job-exec-${profileSlug}`, effect: 'allow', subject: { kind: 'background', id: 'memory-learning:*', workspace: owner.workspace, principal: owner.principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'memory-learning:*' }, context: makeMemCtx() },
    )
    enabledNames.push('记忆自学习')
  }

  // 2) Dreaming
  if (input.enableDreaming) {
    const existingDreamNode = getPatchRowConfigNode(seq, 'dsh-ray-assistant-dreaming')
    const existingDreamCfg = getPatchRowConfig(seq, 'dsh-ray-assistant-dreaming')
    const dreamingDbPath = resolveScopedDbTarget(
      paths.canonicalHome,
      'assistant-dreaming',
      `${profileSlug}.sqlite`,
      existingDreamNode?.get('databasePath', true) ?? existingDreamCfg['databasePath'],
    )
    const dreamingBudgetId = `${prefix}-dreaming-${profileSlug}`
    const prevNotify = typeof existingDreamCfg['maxNotificationsPerDay'] === 'number'
      ? Math.min(Math.trunc(existingDreamCfg['maxNotificationsPerDay']), budgets.dailyDreams, 3)
      : Math.min(1, budgets.dailyDreams)
    const dreamConfig = {
      ...existingDreamCfg,
      enabled: true,
      retired: false,
      scope: { ...dreamGrowthScope },
      databasePath: dreamingDbPath,
      provider: reqProvider,
      model: reqModel,
      ...(reqEffort !== '' ? { reasoningEffort: reqEffort } : {}),
      budgetId: dreamingBudgetId,
      budgetAmount: 1,
      maxDreamsPerDay: budgets.dailyDreams,
      maxNotificationsPerDay: Math.max(0, prevNotify),
      maxIdeasPerWake: budgets.maxIdeasPerWake,
    }
    if (reqEffort === '') delete (dreamConfig as Record<string, unknown>)['reasoningEffort']

    const dreamRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-dreaming', '@dsh-ray/assistant-dreaming')
    dreamRow.delete('disabled')
    dreamRow.set('config', createPlainNode(doc, dreamConfig))

    newBudgets.push({ id: dreamingBudgetId, metric: 'automation-runs', limit: budgets.dailyDreams, periodMs: DAY_MS, scope: 'subject' })
    newRules.push(
      { id: `wizard-${prefix}-dream-reconcile-${profileSlug}`, effect: 'allow', subject: { kind: 'background', id: 'assistant-dreaming', workspace: owner.workspace, principal: owner.principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: 'dsh-ray-assistant-dreaming:*' }, context: { initiators: ['background'] } },
      { id: `wizard-${prefix}-dream-exec-${profileSlug}`, effect: 'allow', subject: { kind: 'background', id: 'dsh-ray-assistant-dreaming:*', workspace: owner.workspace, principal: owner.principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'dsh-ray-assistant-dreaming:*' }, context: { initiators: ['background'] } },
      { id: `wizard-${prefix}-dream-owner-${profileSlug}`, effect: 'allow', subject: { kind: 'external', id: owner.principalId, workspace: owner.workspace, principal: owner.principalId }, actions: ['dream.acknowledge', 'dream.validate', 'dream.reject', 'dream.retire'], resource: { kind: 'evolution', id: 'assistant-dreaming:idea:*' }, context: { initiators: ['foreground'] } },
    )
    enabledNames.push('做梦灵感')
  }

  // 3) Growth driver (workflow + usage learning + dreaming idea intake)
  if (input.enableGrowth) {
    const existingGrowthNode = getPatchRowConfigNode(seq, 'dsh-ray-assistant-growth-driver')
    const existingGrowthCfg = getPatchRowConfig(seq, 'dsh-ray-assistant-growth-driver')
    const existingUsageNode = existingGrowthNode?.get('usageLearning', true)
    const existingUsageCfg = asPlainRecord(existingGrowthCfg['usageLearning'])
    const growthUsageDbPath = resolveScopedDbTarget(
      paths.canonicalHome,
      'assistant-growth-driver',
      `${profileSlug}-usage.sqlite`,
      isMap(existingUsageNode) ? existingUsageNode.get('databasePath', true) : existingUsageCfg['databasePath'],
    )
    const growthBudgetId = findReusableWorkspaceOrGlobalBudgetId(existingBudgets, 'global', `${prefix}-growth-reviews-${profileSlug}`)
    const growthScanBudgetId = `${prefix}-growth-scan-${profileSlug}`

    const growthConfig = {
      ...existingGrowthCfg,
      enabled: true,
      intervalMs: typeof existingGrowthCfg['intervalMs'] === 'number' ? existingGrowthCfg['intervalMs'] : 0,
      scope: { ...dreamGrowthScope },
      provider: reqProvider,
      model: reqModel,
      ...(reqEffort !== '' ? { reasoningEffort: reqEffort } : {}),
      budgetId: growthBudgetId,
      budgetAmount: 1,
      dreamingIdeas: {
        ...asPlainRecord(existingGrowthCfg['dreamingIdeas']),
        enabled: true,
        maxIdeasPerWake: budgets.maxIdeasPerWake,
      },
      workflowOwnerAnchored: {
        ...asPlainRecord(existingGrowthCfg['workflowOwnerAnchored']),
        enabled: true,
      },
      usageLearning: {
        ...existingUsageCfg,
        enabled: true,
        databasePath: growthUsageDbPath,
        maxPending: typeof existingUsageCfg['maxPending'] === 'number' ? existingUsageCfg['maxPending'] : 64,
        lookbackMs: typeof existingUsageCfg['lookbackMs'] === 'number' ? existingUsageCfg['lookbackMs'] : 7 * DAY_MS,
        scanBudgetId: growthScanBudgetId,
        scanBudgetAmount: 1,
      },
    }
    if (reqEffort === '') delete (growthConfig as Record<string, unknown>)['reasoningEffort']

    const growthRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-growth-driver', '@dsh-ray/assistant-growth-driver')
    growthRow.delete('disabled')
    growthRow.set('config', createPlainNode(doc, growthConfig))

    newBudgets.push(
      { id: growthBudgetId, metric: 'automation-runs', limit: budgets.dailyGrowthReviews, periodMs: DAY_MS, scope: 'global' },
      { id: growthScanBudgetId, metric: 'automation-runs', limit: budgets.dailyGrowthDiscoveryScans, periodMs: DAY_MS, scope: 'subject' },
    )
    const makeAgentSubject = () => ({ kind: 'agent', id: owner.preset, workspace: owner.workspace, principal: owner.principalId })
    const makeBgCtx = () => ({ initiators: ['background'] })
    newRules.push(
      { id: `wizard-${prefix}-usage-reconcile-${profileSlug}`, effect: 'allow', subject: { kind: 'background', id: 'assistant-growth-usage', workspace: owner.workspace, principal: owner.principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: 'usage-*' }, context: makeBgCtx() },
      { id: `wizard-${prefix}-usage-exec-${profileSlug}`, effect: 'allow', subject: { kind: 'background', id: 'usage-*', workspace: owner.workspace, principal: owner.principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'usage-*' }, context: makeBgCtx() },
      { id: `wizard-${prefix}-growth-tools-${profileSlug}`, effect: 'allow', subject: makeAgentSubject(), actions: ['execute'], resource: { kind: 'tool', id: 'growth_*' }, context: makeBgCtx() },
      { id: `wizard-${prefix}-verified-workflows-${profileSlug}`, effect: 'allow', subject: makeAgentSubject(), actions: ['draft'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: makeBgCtx() },
    )
    enabledNames.push('技能演化')
  }

  // Merge finite assistantPolicy budgets & rules without removing existing rules or relaxing budget gate.
  const mergedBudgets = upsertById(existingBudgets, newBudgets)
  const mergedRules = upsertById(pp.policyCfg['rules'], newRules)
  if (pp.layout === 'split') {
    const policyRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-policy', '@dsh-ray/assistant-policy')
    const pCfg = ensureConfigMap(doc, policyRow, 'config')
    if (!pCfg.has('databasePath')) pCfg.set('databasePath', jsDshHomeScalar('assistant-policy/policy.sqlite'))
    for (const key of ['proposalMaintenanceIntervalMs', 'toolDefaultEffect', 'autoReview'] as const) {
      if (!pCfg.has(key) && pp.policyCfg[key] !== undefined) pCfg.set(key, createPlainNode(doc, pp.policyCfg[key]))
    }
    pCfg.set('budgets', createPlainNode(doc, mergedBudgets))
    pCfg.set('rules', createPlainNode(doc, mergedRules))

    const autoRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-automations', '@dsh-ray/assistant-automations')
    const aCfg = ensureConfigMap(doc, autoRow, 'config')
    if (!aCfg.has('databasePath')) aCfg.set('databasePath', jsDshHomeScalar('assistant-automations/state.sqlite'))
    if (!aCfg.has('runsPath')) aCfg.set('runsPath', jsDshHomeScalar('assistant-automations/runs'))
    aCfg.set('schedulerEnabled', true)
    aCfg.set('allowUnbudgetedExecution', false)
  } else {
    const paRow = ensurePatchRow(doc, seq, 'dsh-ray-personal-assistant', '@dsh-ray/personal-assistant')
    const paCfg = ensureConfigMap(doc, paRow, 'config')
    const polNode = ensureConfigMap(doc, paCfg, 'assistantPolicy')
    if (!polNode.has('databasePath')) polNode.set('databasePath', jsDshHomeScalar('assistant-policy/policy.sqlite'))
    polNode.set('budgets', createPlainNode(doc, mergedBudgets))
    polNode.set('rules', createPlainNode(doc, mergedRules))

    const pmNode = ensureConfigMap(doc, paCfg, 'personalMemory')
    if (!pmNode.has('databasePath')) pmNode.set('databasePath', jsDshHomeScalar('personal-memory/memory.sqlite'))

    const wikiNode = ensureConfigMap(doc, paCfg, 'personalWiki')
    if (!wikiNode.has('vaultRoot')) wikiNode.set('vaultRoot', jsDshHomeScalar('personal-wiki/vault'))
    if (!wikiNode.has('databasePath')) wikiNode.set('databasePath', jsDshHomeScalar('personal-wiki/state.sqlite'))

    const autoNode = ensureConfigMap(doc, paCfg, 'assistantAutomations')
    if (!autoNode.has('databasePath')) autoNode.set('databasePath', jsDshHomeScalar('assistant-automations/state.sqlite'))
    if (!autoNode.has('runsPath')) autoNode.set('runsPath', jsDshHomeScalar('assistant-automations/runs'))
    autoNode.set('schedulerEnabled', true)
    autoNode.set('allowUnbudgetedExecution', false)
  }

  applyPatchTraexRoute(doc, seq, reqProvider)

  let backupPath: string | null = null
  try {
    const written = atomicWritePatchWithBackup(paths.patchPath, doc.toString({ lineWidth: 0 }), now)
    backupPath = written.backupPath
  } catch (error: unknown) {
    return failResult('cordis.patch.yml', error instanceof Error ? error.message : String(error))
  }

  let traexNote = ''
  try {
    traexNote = await applyLiveModelRouteSettings(
      host,
      settings,
      descriptors,
      reqProvider,
      reqModel,
      reqEffort,
      input.reloadEntry,
    )
  } catch (error: unknown) {
    return Object.freeze({
      applied: true,
      entry: 'cordis.patch.yml',
      note: `cordis.patch.yml 已保存并备份，但同步实时模型路由失败（${error instanceof Error ? error.message : String(error)}）；请重启 profile：${preflight.profile.restartCommand ?? `dsh --profile ${paths.profileName}`}`,
    })
  }

  const loader = host.get('loader') as LoaderService | undefined
  const reloadHint = loader !== undefined
    ? `非易失配置与三权分立授权已写入 cordis.patch.yml${traexNote}；由于插件非易失配置与动态模块代码不自动热重建，请重启 profile：${preflight.profile.restartCommand ?? `dsh --profile ${paths.profileName}`}`
    : `非易失配置与三权分立授权已写入 cordis.patch.yml${traexNote}；请重启 profile 后加载生效`
  const backupHint = backupPath !== null ? `（已备份 ${basename(backupPath)}）` : ''
  return Object.freeze({
    applied: true,
    entry: 'cordis.patch.yml',
    note: `已授权开启 ${enabledNames.join('、')}（档位：${input.tier}，路由：${reqProvider}/${reqModel}）${backupHint}；${reloadHint}`,
  })
}
