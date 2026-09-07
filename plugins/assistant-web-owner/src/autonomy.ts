import { createHash } from 'node:crypto'
import { isAbsolute, join, normalize } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

export interface AutonomySetupOptions { image: string; maxRuns: number; leaseMs: number; maxTotalDurationMs: number }
export interface AutonomyProfileInput { dshHome: string; profile: string; workspace: string; preset: string; isolation: AutonomySetupOptions }

const bundles = ['assistant-isolation', 'assistant-actions', 'credentials-keychain'] as const
const profileKey = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const presetKey = /^[a-z0-9][a-z0-9-]*$/u
const imagePattern = /^sha256:[0-9a-f]{64}$/u
function fail(message: string): never { throw new Error(`assistant-web-owner autonomy: ${message}`) }
function map(value: unknown, label: string): YAMLMap { if (!isMap(value)) fail(`${label} must be a mapping`); return value }
function parse(source: string, label: string): { document: Document; rows: YAMLSeq } {
  const document = parseDocument(source.trim() === '' ? '[]' : source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length !== 0 || !isSeq(document.contents)) fail(`${label} must be a YAML sequence`)
  return { document, rows: document.contents }
}
function row(rows: YAMLSeq, bundle: typeof bundles[number], required: boolean): YAMLMap | undefined {
  const id = `dsh-enhanced-${bundle}`; const name = `@dsh-enhanced/${bundle}`
  const matches = rows.items.filter(item => isMap(item) && (item.get('id') === id || item.get('name') === name)) as YAMLMap[]
  if (matches.length > 1) fail(`duplicate or shadowed ${id}`)
  const found = matches[0]
  if (!found) { if (required) fail(`install ${name} before autonomy setup`); return undefined }
  if (found.get('id') !== id || (found.has('name') && found.get('name') !== name) || (found.has('disabled') && found.get('disabled') !== false)) fail(`invalid or disabled ${id}`)
  return found
}
function merge(base: YAMLMap, overlay: YAMLMap): YAMLMap {
  const result = map(base.clone(), 'config')
  for (const pair of overlay.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail('config keys must be strings')
    const inherited = result.get(pair.key.value, true); const value = pair.value as Node | null
    result.set(pair.key.value, isMap(inherited) && isMap(value) ? merge(inherited, value) : value?.clone() ?? null)
  }
  return result
}
function path(value: unknown, label: string): string {
  if (!isScalar(value) || typeof value.value !== 'string' || value.tag !== undefined && value.tag !== 'tag:yaml.org,2002:str') fail(`${label} must be a literal absolute path`)
  if (!isAbsolute(value.value) || value.value.includes('\0') || normalize(value.value) !== value.value) fail(`${label} must be a canonical absolute path`)
  return value.value
}
function sequence(value: unknown, label: string): YAMLSeq { if (!isSeq(value)) fail(`${label} must be a sequence`); return value }
function scalar(value: unknown, label: string): string { if (!isScalar(value) || typeof value.value !== 'string') fail(`${label} must be a string`); return value.value }
function publishedCredentialDefault(value: unknown): boolean {
  return isScalar(value) && value.tag === 'tag:yaml.org,2002:js' && value.value === "dshHomePath('credentials-keychain/ledger.sqlite')"
}
function options(input: AutonomyProfileInput): void {
  if (!profileKey.test(input.profile) || !presetKey.test(input.preset)) fail('invalid profile or preset')
  for (const value of [input.dshHome, input.workspace]) if (!isAbsolute(value) || value.includes('\0') || normalize(value) !== value) fail('home and workspace must be canonical absolute paths')
  validateAutonomyOptions(input.isolation)
}

export function validateAutonomyOptions(value: AutonomySetupOptions): void {
  if (value === null || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'image,leaseMs,maxRuns,maxTotalDurationMs') fail('invalid autonomy options')
  if (!imagePattern.test(value.image)) fail('image must be an immutable sha256 digest')
  const positive = (number: number, maximum: number, label: string, minimum = 1) => { if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(`invalid ${label}`) }
  positive(value.maxRuns, 10_000, 'maxRuns'); positive(value.leaseMs, 7 * 24 * 60 * 60 * 1000, 'leaseMs'); positive(value.maxTotalDurationMs, 24 * 60 * 60 * 1000, 'maxTotalDurationMs', 60_000)
}

/** Read the exact literal Docker executable from a materialized autonomy profile. */
export function autonomyDockerPath(source: string): string {
  const { rows } = parse(source, 'autonomy profile')
  const config = map(row(rows, 'assistant-isolation', true)!.get('config', true), 'Isolation config')
  return config.has('dockerPath') ? path(config.get('dockerPath', true), 'Isolation dockerPath') : '/usr/bin/docker'
}

/** Pure YAML materialization; it neither creates credentials nor grants external repository authority. */
export function prepareAutonomyProfile(input: AutonomyProfileInput, source: string, effectiveSource: string, owner?: { id: string; version: number }, now = Date.now()): string {
  options(input)
  if (owner !== undefined && (typeof owner.id !== 'string' || owner.id.length === 0 || !Number.isSafeInteger(owner.version) || owner.version < 1)) fail('invalid owner')
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - input.isolation.leaseMs) fail('invalid clock')
  const target = parse(source, 'profile patch'); const effective = parse(effectiveSource, 'effective profile')
  const configs = new Map<typeof bundles[number], YAMLMap>()
  const explicit = new Map<typeof bundles[number], ReadonlySet<string>>()
  for (const bundle of bundles) {
    const inherited = row(effective.rows, bundle, true)!; const existing = row(target.rows, bundle, false)
    const base = inherited.has('config') ? map(inherited.get('config', true), bundle) : target.document.createNode({}) as YAMLMap
    const config = existing?.has('config') ? merge(base, map(existing.get('config', true), bundle)) : map(base.clone(), bundle)
    explicit.set(bundle, existing?.has('config') ? new Set(map(existing.get('config', true), bundle).items.map(pair => scalar(pair.key, 'config key'))) : new Set())
    const destination = existing ?? target.document.createNode({ id: `dsh-enhanced-${bundle}`, name: `@dsh-enhanced/${bundle}` }) as YAMLMap
    destination.set('config', config); if (!existing) target.rows.add(destination); configs.set(bundle, config)
  }
  const isolation = configs.get('assistant-isolation')!; const actions = configs.get('assistant-actions')!; const credentials = configs.get('credentials-keychain')!
  const roots = { isolation: join(input.dshHome, 'assistant-isolation', input.profile), actions: join(input.dshHome, 'assistant-actions', input.profile), credentials: join(input.dshHome, 'credentials-keychain', `${input.profile}.sqlite`) }
  for (const [config, field, fallback, label] of [[isolation, 'stateRoot', roots.isolation, 'Isolation stateRoot'], [actions, 'stateRoot', roots.actions, 'Actions stateRoot']] as const) {
    if (config.has(field)) path(config.get(field, true), label)
    else config.set(field, target.document.createNode(fallback))
  }
  const credentialPath = credentials.get('databasePath', true)
  if (credentialPath === undefined || (!explicit.get('credentials-keychain')!.has('databasePath') && publishedCredentialDefault(credentialPath))) credentials.set('databasePath', target.document.createNode(roots.credentials))
  else path(credentialPath, 'Credential databasePath')
  if (isolation.has('dockerPath')) path(isolation.get('dockerPath', true), 'Isolation dockerPath')
  const image = isolation.has('image') ? scalar(isolation.get('image', true), 'Isolation image') : undefined
  if (image !== undefined && image !== input.isolation.image) fail('existing isolation image differs; explicit migration is required')
  isolation.set('image', target.document.createNode(input.isolation.image))
  if (!actions.has('grants')) actions.set('grants', target.document.createNode([]))
  else sequence(actions.get('grants', true), 'Actions grants')
  let grants: YAMLSeq
  if (!isolation.has('grants')) { grants = target.document.createNode([]) as YAMLSeq; isolation.set('grants', grants) } else grants = sequence(isolation.get('grants', true), 'Isolation grants')
  const id = `autonomy-${input.profile}`; const principalDigest = createHash('sha256').update(`web/${input.profile}/local/operator`).digest('hex')
  const baseGrant = { id, revision: 1, principalDigest, workspace: input.workspace, agentPreset: input.preset, maxRuns: input.isolation.maxRuns, maxTotalDurationMs: input.isolation.maxTotalDurationMs }
  const validateManaged = (current: YAMLMap, checkOwner: boolean): void => {
    for (const [field, value] of Object.entries(baseGrant)) if (current.get(field) !== value) fail('managed isolation grant differs; explicit migration is required')
    if (typeof current.get('principalRecordId') !== 'string' || !Number.isSafeInteger(current.get('principalVersion')) || (current.get('principalVersion') as number) < 1) fail('managed isolation grant has invalid owner lineage')
    if (checkOwner && (current.get('principalRecordId') !== owner!.id || current.get('principalVersion') !== owner!.version)) fail('managed isolation grant differs; explicit migration is required')
    const expiresAt = current.get('expiresAt'); if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) fail('managed isolation grant has invalid expiry')
  }
  if (grants.items.length !== 0) {
    if (grants.items.length !== 1 || !isMap(grants.items[0])) fail('existing isolation grants require explicit migration')
    validateManaged(grants.items[0] as YAMLMap, owner !== undefined)
  } else if (owner !== undefined) grants.add(target.document.createNode({ ...baseGrant, principalRecordId: owner.id, principalVersion: owner.version, expiresAt: now + input.isolation.leaseMs }))
  return target.document.toString({ lineWidth: 0 })
}
