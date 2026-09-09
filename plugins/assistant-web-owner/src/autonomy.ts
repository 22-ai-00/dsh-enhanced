import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

export interface AutonomySetupOptions { image: string; maxRuns: number; leaseMs: number; maxTotalDurationMs: number }
export interface AutonomyProfileInput { dshHome: string; profile: string; workspace: string; preset: string; isolation: AutonomySetupOptions }

const requiredBundles = ['assistant-isolation', 'assistant-actions', 'credentials-keychain'] as const
const stateBundles = ['assistant-skills', 'assistant-proactive'] as const
const bundles = [...requiredBundles, ...stateBundles] as const
type Bundle = typeof bundles[number]
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
function row(rows: YAMLSeq, bundle: Bundle, required: boolean): YAMLMap | undefined {
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
function canonicalPath(value: string, label: string, rejectLeafSymlink = false): string {
  let cursor = value; const suffix: string[] = []
  for (;;) {
    let stat
    try { stat = lstatSync(cursor) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(`${label} has an inaccessible filesystem ancestor`)
      const parent = dirname(cursor)
      if (parent === cursor) fail(`${label} has no existing filesystem ancestor`)
      suffix.unshift(basename(cursor)); cursor = parent
      continue
    }
    if (rejectLeafSymlink && suffix.length === 0 && stat.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
    try { return resolve(realpathSync(cursor), ...suffix) } catch { fail(`${label} has an unresolved filesystem ancestor`) }
  }
}
function dshStatePath(value: unknown, label: string, dshHome: string): string {
  const resolved = path(value, label)
  const canonical = canonicalPath(resolved, label, true)
  const within = relative(canonicalPath(dshHome, 'DSH_HOME'), canonical)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) fail(`${label} must be within DSH_HOME`)
  // Setup cannot hold filesystem descriptors until every runtime opens its state.
  // Each state-owning runtime must retain its private/no-follow checks for TOCTOU defense.
  return canonical
}
function sequence(value: unknown, label: string): YAMLSeq { if (!isSeq(value)) fail(`${label} must be a sequence`); return value }
function scalar(value: unknown, label: string): string { if (!isScalar(value) || typeof value.value !== 'string') fail(`${label} must be a string`); return value.value }
function publishedCredentialDefault(value: unknown): boolean {
  return isScalar(value) && value.tag === 'tag:yaml.org,2002:js' && value.value === "dshHomePath('credentials-keychain/ledger.sqlite')"
}
function publishedDatabaseDefault(value: unknown, expected: string): boolean {
  return isScalar(value) && (value.tag === undefined || value.tag === 'tag:yaml.org,2002:str') && value.value === expected
}
function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    fail(`cannot inspect inherited database state at ${path}`)
  }
}
function sqliteStateExists(databasePath: string, companion = false): boolean {
  const databases = companion ? [databasePath, `${databasePath}.preparations`] : [databasePath]
  return databases.some(value => [value, `${value}-journal`, `${value}-wal`, `${value}-shm`].some(exists))
}
function canonicalizeNestedStateRoots(document: Document, node: Node | null, dshHome: string, label: string): void {
  if (isAlias(node)) fail(`${label} config must not use YAML aliases`)
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined
      if (key === 'stateRoot') pair.value = document.createNode(dshStatePath(pair.value, `${label} stateRoot`, dshHome))
      else canonicalizeNestedStateRoots(document, pair.value as Node | null, dshHome, label)
    }
  } else if (isSeq(node)) for (const item of node.items) canonicalizeNestedStateRoots(document, item as Node | null, dshHome, label)
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
  const configs = new Map<Bundle, YAMLMap>()
  const explicit = new Map<Bundle, ReadonlySet<string>>()
  for (const bundle of bundles) {
    const required = (requiredBundles as readonly Bundle[]).includes(bundle)
    const inherited = row(effective.rows, bundle, required); const existing = row(target.rows, bundle, false)
    if (!inherited) {
      if (existing) fail(`effective profile is missing @dsh-enhanced/${bundle}`)
      continue
    }
    const base = inherited.has('config') ? map(inherited.get('config', true), bundle) : target.document.createNode({}) as YAMLMap
    const config = existing?.has('config') ? merge(base, map(existing.get('config', true), bundle)) : map(base.clone(), bundle)
    explicit.set(bundle, existing?.has('config') ? new Set(map(existing.get('config', true), bundle).items.map(pair => scalar(pair.key, 'config key'))) : new Set())
    const destination = existing ?? target.document.createNode({ id: `dsh-enhanced-${bundle}`, name: `@dsh-enhanced/${bundle}` }) as YAMLMap
    destination.set('config', config); if (!existing) target.rows.add(destination); configs.set(bundle, config)
  }
  const isolation = configs.get('assistant-isolation')!; const actions = configs.get('assistant-actions')!; const credentials = configs.get('credentials-keychain')!
  const canonicalHome = canonicalPath(input.dshHome, 'DSH_HOME')
  const roots = {
    isolation: join(canonicalHome, 'assistant-isolation', input.profile),
    actions: join(canonicalHome, 'assistant-actions', input.profile),
    credentials: join(canonicalHome, 'credentials-keychain', `${input.profile}.sqlite`),
    skills: join(canonicalHome, 'assistant-skills', 'skills.sqlite'),
    proactive: join(canonicalHome, 'assistant-proactive', 'proactive.sqlite'),
  }
  for (const [config, field, fallback, label] of [[isolation, 'stateRoot', roots.isolation, 'Isolation stateRoot'], [actions, 'stateRoot', roots.actions, 'Actions stateRoot']] as const) {
    if (!config.has(field)) config.set(field, target.document.createNode(fallback))
    config.set(field, target.document.createNode(dshStatePath(config.get(field, true), label, canonicalHome)))
  }
  const credentialPath = credentials.get('databasePath', true)
  if (credentialPath === undefined || (!explicit.get('credentials-keychain')!.has('databasePath') && publishedCredentialDefault(credentialPath))) credentials.set('databasePath', target.document.createNode(roots.credentials))
  credentials.set('databasePath', target.document.createNode(dshStatePath(credentials.get('databasePath', true), 'Credential databasePath', canonicalHome)))
  for (const [bundle, fallback, published, label] of [
    ['assistant-skills', roots.skills, join(homedir(), '.dsh', 'assistant-skills.sqlite'), 'Skills databasePath'],
    ['assistant-proactive', roots.proactive, join(homedir(), '.dsh', 'assistant-proactive.sqlite'), 'Proactive databasePath'],
  ] as const) {
    const config = configs.get(bundle)
    if (!config) continue
    const current = config.get('databasePath', true)
    const inheritedDefault = !explicit.get(bundle)!.has('databasePath') && (current === undefined || publishedDatabaseDefault(current, published))
    if (inheritedDefault && sqliteStateExists(published, bundle === 'assistant-proactive')) fail(`${label} published default contains existing state; perform an offline migration to ${fallback} before setup`)
    if (inheritedDefault) config.set('databasePath', target.document.createNode(fallback))
    config.set('databasePath', target.document.createNode(dshStatePath(config.get('databasePath', true), label, canonicalHome)))
  }
  const skills = configs.get('assistant-skills')
  if (skills) canonicalizeNestedStateRoots(target.document, skills, canonicalHome, 'Skills')
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
