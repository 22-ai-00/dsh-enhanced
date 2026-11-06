import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { type Document, isMap, isScalar, isSeq, parseDocument, Scalar, stringify, YAMLMap, YAMLSeq } from 'yaml'
import { type EffectiveProfileDumpReader, findRow, readEffectiveProfileDump } from './profile-setup.js'

/**
 * `dsh-plugin-setup`: list, enable, disable and configure installed
 * `@dsh-enhanced/*` plugins of one DSH profile without hand-editing YAML.
 *
 * Every write goes to `$DSH_HOME/profiles/<profile>/cordis.patch.yml` only.
 * A profile row `config` replaces the inherited config as a whole, so the
 * first edit of a row clones the native effective config (from
 * `dsh --profile <p> --dump-config`, preserving `!!js` expressions) and then
 * changes just the requested key. After writing, the profile is dumped again;
 * if the dump fails or the requested values did not take effect the previous
 * patch is restored.
 *
 * Boundaries: never writes secret values, never edits the Policy or plugin
 * control-plane rows, never disables Policy, and never enables Lark before its
 * own credential onboarding (`dsh-lark-setup`).
 */

const tag = 'assistant-policy plugin setup'
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const keySegmentPattern = /^[A-Za-z0-9_-]{1,64}$/u
const rowPrefix = 'dsh-enhanced-'
const packageScope = '@dsh-enhanced/'

/** Rows whose config/authorization surface this CLI refuses to edit. */
const protectedRows: ReadonlyMap<string, string> = new Map([
  ['dsh-enhanced-assistant-policy', 'Policy rules, default-deny and auto-review are access controls; edit them deliberately in the profile patch'],
  ['dsh-enhanced-plugin-control-plane', 'sealed-plugin trust and approval state is managed by dsh-plugin-control'],
])

/** Rows whose config keys this CLI refuses to edit (authorization-bearing keys). */
const protectedKeys: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['dsh-enhanced-assistant-delivery', new Set(['ownerRoutes', 'policyRef'])],
])

type KnownType = 'boolean' | 'number' | 'string' | readonly string[]

/**
 * Documented optional keys that are absent from bundle defaults. `set` accepts
 * them without `--force` and validates their type.
 */
const knownOptionalKeys: ReadonlyMap<string, ReadonlyMap<string, KnownType>> = new Map([
  ['dsh-enhanced-assistant-work-items', new Map<string, KnownType>([
    ['mode', ['observe', 'active']],
    ['intakeLedger.enabled', 'boolean'],
    ['ownerReplyContinuation', 'boolean'],
    ['ownerReportFeedback', 'boolean'],
    ['follows.eventTriggers.enabled', 'boolean'],
    ['ownerReportRouting.prefer', ['origin', 'recent']],
  ])],
  ['dsh-enhanced-assistant-delivery', new Map<string, KnownType>([['attentionAttachOverCap', 'boolean']])],
  ['dsh-enhanced-assistant-evaluation', new Map<string, KnownType>([
    ['notificationOutcomesEnabled', 'boolean'],
    ['notificationSyncIntervalMs', 'number'],
  ])],
  ['dsh-enhanced-event-triggers', new Map<string, KnownType>([['pollerEnabled', 'boolean']])],
])

export interface PluginSetupTarget {
  dshHome: string
  /** Omit to use `DSH_PROFILE` or the only profile under `$DSH_HOME/profiles`. */
  profile?: string
}

export interface PluginSetupOptions {
  /** Test seam; defaults to the approved Host `--dump-config`. */
  readDump?: EffectiveProfileDumpReader
  /** Compute and report the change without writing. */
  dryRun?: boolean
}

export interface ProfilePluginSummary {
  id: string
  slug: string
  packageName: string
  /** Loader row gate (`disabled: true` means the plugin is not loaded). */
  loaded: boolean
  /** Top-level `enabled` config gate when the plugin has one. */
  enabled?: boolean
  /** Feature flags: top-level `*Enabled` booleans and one-level `<key>.enabled`. */
  flags: Record<string, boolean>
  /** True when the profile patch already overrides this row. */
  overridden: boolean
}

export interface PluginChange {
  id: string
  key: string
  from: unknown
  to: unknown
}

export interface PluginSkip {
  id: string
  reason: string
}

export interface PluginWriteResult {
  profile: string
  patchPath: string
  changed: boolean
  dryRun: boolean
  changes: PluginChange[]
  skipped: PluginSkip[]
}

class PluginSetupError extends Error {}

function fail(message: string): never {
  throw new PluginSetupError(`${tag}: ${message}`)
}

// ---------------------------------------------------------------------------
// Profile + dump helpers

export async function resolvePluginProfile(target: PluginSetupTarget): Promise<string> {
  if (!isAbsolute(target.dshHome)) fail('DSH home must be an absolute path')
  const explicit = target.profile ?? process.env.DSH_PROFILE
  if (explicit !== undefined && explicit !== '') {
    if (!profileNamePattern.test(explicit)) fail('--profile must be a valid profile name')
    return explicit
  }
  let names: string[] = []
  try {
    const entries = await readdir(join(target.dshHome, 'profiles'), { withFileTypes: true })
    names = entries
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && profileNamePattern.test(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  if (names.length === 1) return names[0]!
  if (names.length === 0) fail(`no profile found under ${join(target.dshHome, 'profiles')}; pass --profile`)
  return fail(`several profiles found (${names.join(', ')}); pass --profile <name>`)
}

function collectPluginRows(sequence: YAMLSeq, into: YAMLMap[] = []): YAMLMap[] {
  for (const entry of sequence.items) {
    if (!isMap(entry)) continue
    const id = entry.get('id')
    if (typeof id === 'string' && id.startsWith(rowPrefix)) into.push(entry)
    for (const key of ['config', 'insert']) {
      const children = entry.get(key, true)
      if (isSeq(children)) collectPluginRows(children, into)
    }
  }
  return into
}

function rowConfig(row: YAMLMap | undefined): YAMLMap {
  const config = row?.get('config', true)
  if (config === undefined) return new YAMLMap()
  if (!isMap(config)) fail(`${String(row?.get('id'))} config must be a YAML mapping`)
  return config
}

function isJsScalar(node: unknown): boolean {
  return isScalar(node) && (node.tag === '!!js' || node.tag === 'tag:yaml.org,2002:js')
}

function nodeValue(node: unknown): unknown {
  if (node === undefined) return undefined
  if (isScalar(node)) return isJsScalar(node) ? `!!js ${String(node.value)}` : node.value
  if (isMap(node) || isSeq(node)) return node.toJSON()
  return node
}

function splitKey(key: string): string[] {
  const segments = key.split('.')
  if (segments.length > 8 || segments.some(segment => !keySegmentPattern.test(segment))) {
    fail(`invalid config key ${JSON.stringify(key)}; use dotted names such as intakeLedger.enabled`)
  }
  return segments
}

function camelWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').split(/[\s_-]+/u).map(word => word.toLowerCase()).filter(Boolean)
}

/** Secret-bearing key names; handles/env names/paths/ttls are not secrets. */
export function isSecretConfigKey(name: string): boolean {
  const words = camelWords(name)
  const last = words.at(-1) ?? ''
  if (['handle', 'env', 'ref', 'path', 'file', 'id', 'ttl', 'ms', 'name', 'url'].includes(last)) return false
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (['secret', 'password', 'passwd', 'token', 'cookie', 'apikey'].includes(word)) return true
    if ((word === 'api' || word === 'private' || word === 'access') && words[index + 1] === 'key') return true
  }
  return false
}

function redact(node: unknown): unknown {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
      if (isSecretConfigKey(key) && pair.value !== null && !(isScalar(pair.value) && (pair.value.value === null || pair.value.value === ''))) {
        pair.value = new Scalar('[redacted]')
      } else {
        redact(pair.value)
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items) redact(item)
  }
  return node
}

interface InstalledPlugins {
  profile: string
  dump: YAMLSeq
  rows: Map<string, YAMLMap>
}

async function readInstalled(target: PluginSetupTarget, readDump: EffectiveProfileDumpReader): Promise<InstalledPlugins> {
  const profile = await resolvePluginProfile(target)
  const dump = await readDump(target.dshHome, profile)
  const rows = new Map<string, YAMLMap>()
  for (const row of collectPluginRows(dump)) rows.set(String(row.get('id')), row)
  return { profile, dump, rows }
}

/** Map `work-items`, `assistant-work-items`, `@dsh-enhanced/assistant-work-items` or the row id to an installed row id. */
export function resolvePluginId(name: string, installed: Iterable<string>): string | undefined {
  const ids = new Set(installed)
  const trimmed = name.trim()
  const base = trimmed.startsWith(packageScope) ? trimmed.slice(packageScope.length) : trimmed
  for (const candidate of [base, `${rowPrefix}${base}`, `${rowPrefix}assistant-${base}`]) {
    if (ids.has(candidate)) return candidate
  }
  return undefined
}

function requireInstalled(name: string, installed: InstalledPlugins): string {
  const id = resolvePluginId(name, installed.rows.keys())
  if (id !== undefined) return id
  const base = name.startsWith(packageScope) ? name.slice(packageScope.length) : name.replace(/^dsh-enhanced-/u, '')
  return fail(`plugin ${JSON.stringify(name)} is not installed in profile ${installed.profile}; `
    + `add it first: dsh plugin --profile ${installed.profile} add ${packageScope}${base}`)
}

function summarize(id: string, row: YAMLMap, overridden: boolean): ProfilePluginSummary {
  const config = rowConfig(row)
  const flags: Record<string, boolean> = {}
  let enabled: boolean | undefined
  for (const pair of config.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
    const value = pair.value
    if (isScalar(value) && typeof value.value === 'boolean') {
      if (key === 'enabled') enabled = value.value
      else if (key.endsWith('Enabled') || key === 'attentionAttachOverCap') flags[key] = value.value
    } else if (isMap(value)) {
      const nested = value.get('enabled')
      if (typeof nested === 'boolean') flags[`${key}.enabled`] = nested
    }
  }
  const slug = id.slice(rowPrefix.length)
  return {
    id,
    slug,
    packageName: `${packageScope}${slug}`,
    loaded: row.get('disabled') !== true,
    ...(enabled !== undefined ? { enabled } : {}),
    flags,
    overridden,
  }
}

// ---------------------------------------------------------------------------
// Patch editing

interface LoadedPatch {
  path: string
  existed: boolean
  source: string
  document: Document
  sequence: YAMLSeq
}

async function loadProfilePatch(dshHome: string, profile: string): Promise<LoadedPatch> {
  const path = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  let source = ''
  let existed = true
  try {
    source = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    existed = false
  }
  const document: Document = parseDocument(source)
  if (document.errors.length > 0) fail(`${path} is invalid YAML: ${document.errors[0]?.message}`)
  if (document.contents === null) document.contents = new YAMLSeq()
  if (!isSeq(document.contents)) fail(`${path} must be a top-level YAML sequence of loader entries`)
  return { path, existed, source, document, sequence: document.contents }
}

function profileRows(sequence: YAMLSeq, id: string): YAMLMap[] {
  const rows: YAMLMap[] = []
  for (const entry of sequence.items) {
    if (!isMap(entry)) continue
    if (entry.get('id') === id) rows.push(entry)
    const inserted = entry.get('insert', true)
    if (isSeq(inserted)) for (const row of inserted.items) if (isMap(row) && row.get('id') === id) rows.push(row)
  }
  return rows
}

/**
 * Profile row for `id`. A newly created row always carries a clone of the whole
 * native effective config, because a profile row config replaces inherited config.
 */
function profileRow(patch: LoadedPatch, id: string, effective: YAMLMap): YAMLMap {
  let row = profileRows(patch.sequence, id).at(-1)
  if (row === undefined) {
    row = patch.document.createNode({ id }) as YAMLMap
    patch.sequence.add(row)
  }
  const current = row.get('config', true)
  if (current === undefined) {
    row.set('config', effective.clone())
  } else if (!isMap(current)) {
    fail(`${id} config in ${patch.path} must be a YAML mapping`)
  }
  return row
}

function profileRowConfig(patch: LoadedPatch, id: string, effective: YAMLMap): YAMLMap {
  return profileRow(patch, id, effective).get('config', true) as unknown as YAMLMap
}

function parseBoolean(raw: string, key: string): boolean {
  const normalized = raw.trim().toLowerCase()
  if (['true', 'on', 'yes', '1'].includes(normalized)) return true
  if (['false', 'off', 'no', '0'].includes(normalized)) return false
  return fail(`${key} expects a boolean (true/false), got ${JSON.stringify(raw)}`)
}

function parseNumber(raw: string, key: string): number {
  const value = Number(raw.trim())
  if (raw.trim() === '' || !Number.isFinite(value)) fail(`${key} expects a number, got ${JSON.stringify(raw)}`)
  return value
}

function parseJson(raw: string, key: string, kind: 'object' | 'array'): unknown {
  let value: unknown
  try { value = JSON.parse(raw) } catch { fail(`${key} expects a JSON ${kind}, got ${JSON.stringify(raw)}`) }
  const ok = kind === 'array' ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!ok) fail(`${key} expects a JSON ${kind}`)
  return value
}

function coerceKnown(raw: string, key: string, type: KnownType): unknown {
  if (type === 'boolean') return parseBoolean(raw, key)
  if (type === 'number') return parseNumber(raw, key)
  if (type === 'string') return raw
  if (!type.includes(raw)) fail(`${key} must be one of ${type.join(', ')}`)
  return raw
}

/**
 * Convert a CLI string to the type of the current effective value. Unknown keys
 * need `force`; documented optional keys are typed from a small table.
 */
export function coerceConfigValue(id: string, key: string, raw: string, current: unknown, force = false): unknown {
  const known = knownOptionalKeys.get(id)?.get(key)
  if (current === undefined) {
    if (known !== undefined) return coerceKnown(raw, key, known)
    if (!force) fail(`${id} has no effective key ${key}; check the plugin README for its name, or pass --force to add it`)
    try { return JSON.parse(raw) as unknown } catch { return raw }
  }
  if (isJsScalar(current) && !force) {
    fail(`${key} is a !!js expression (${String((current as Scalar).value)}); pass --force to replace it with a literal`)
  }
  if (isMap(current)) return parseJson(raw, key, 'object')
  if (isSeq(current)) return parseJson(raw, key, 'array')
  const value = isScalar(current) ? current.value : current
  if (known !== undefined) return coerceKnown(raw, key, known)
  if (typeof value === 'boolean') return parseBoolean(raw, key)
  if (typeof value === 'number') return parseNumber(raw, key)
  if (typeof value === 'string') return raw
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

function assertEditable(id: string, segments: readonly string[]): void {
  const reason = protectedRows.get(id)
  if (reason !== undefined) fail(`${id} is not editable with plugin setup: ${reason}`)
  if (protectedKeys.get(id)?.has(segments[0]!)) fail(`${id}.${segments[0]} is an authorization setting; edit it deliberately in the profile patch`)
  if (segments.some(isSecretConfigKey)) {
    fail(`${segments.join('.')} looks like a secret; plugin setup never writes secret values into cordis.patch.yml. `
      + 'Use the plugin\'s credential onboarding (for example dsh-lark-setup, or dsh-model-setup --store-key) instead')
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function larkPlaceholder(effective: YAMLMap): boolean {
  const tenant = effective.get('tenant')
  const appId = effective.get('appId')
  return tenant === 'replace-with-tenant-key' || appId === 'cli_0000000000000000'
}

interface PendingEdit {
  id: string
  segments: string[]
  value: unknown
  verifyKey?: boolean
}

/** Shared write path: edit, atomically write, re-dump to verify, roll back on failure. */
async function commit(
  target: PluginSetupTarget,
  installed: InstalledPlugins,
  patch: LoadedPatch,
  changes: PluginChange[],
  skipped: PluginSkip[],
  verify: PendingEdit[],
  rowGates: Array<{ id: string; loaded: boolean }>,
  options: PluginSetupOptions,
): Promise<PluginWriteResult> {
  const serialized = patch.document.toString({ lineWidth: 0 })
  const changed = serialized !== patch.source && changes.length > 0
  const result: PluginWriteResult = {
    profile: installed.profile, patchPath: patch.path, changed, dryRun: options.dryRun === true, changes, skipped,
  }
  if (!changed || options.dryRun === true) return result
  await mkdir(join(target.dshHome, 'profiles', installed.profile), { recursive: true })
  const temporaryPath = `${patch.path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, patch.path)
  try {
    const after = await (options.readDump ?? readEffectiveProfileDump)(target.dshHome, installed.profile)
    for (const gate of rowGates) {
      const row = findRow(after, gate.id)
      if (row === undefined || (row.get('disabled') !== true) !== gate.loaded) fail(`${gate.id} loader state did not take effect`)
    }
    for (const edit of verify) {
      const row = findRow(after, edit.id)
      const actual = nodeValue(rowConfig(row).getIn(edit.segments, true))
      if (!sameValue(actual, edit.value)) fail(`${edit.id}.${edit.segments.join('.')} did not take effect in the profile dump`)
    }
  } catch (error: unknown) {
    if (patch.existed) {
      const restorePath = `${patch.path}.${randomUUID()}.tmp`
      await writeFile(restorePath, patch.source, { encoding: 'utf8', mode: 0o600 })
      await chmod(restorePath, 0o600)
      await rename(restorePath, patch.path)
    } else {
      await rm(patch.path, { force: true })
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new PluginSetupError(`${tag}: verification failed, restored ${patch.path}: ${message}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Public API

export async function listProfilePlugins(target: PluginSetupTarget, options: PluginSetupOptions = {}): Promise<{ profile: string; patchPath: string; plugins: ProfilePluginSummary[] }> {
  const installed = await readInstalled(target, options.readDump ?? readEffectiveProfileDump)
  const patch = await loadProfilePatch(target.dshHome, installed.profile)
  const plugins = [...installed.rows.entries()]
    .map(([id, row]) => summarize(id, row, profileRows(patch.sequence, id).length > 0))
    .sort((left, right) => left.id.localeCompare(right.id))
  return { profile: installed.profile, patchPath: patch.path, plugins }
}

/** Effective config of one plugin with secret-like values redacted. */
export async function showProfilePlugin(target: PluginSetupTarget & { plugin: string }, options: PluginSetupOptions = {}): Promise<{ profile: string; summary: ProfilePluginSummary; config: string }> {
  const installed = await readInstalled(target, options.readDump ?? readEffectiveProfileDump)
  const id = requireInstalled(target.plugin, installed)
  const row = installed.rows.get(id)!
  const patch = await loadProfilePatch(target.dshHome, installed.profile)
  const config = redact(rowConfig(row).clone()) as YAMLMap
  return {
    profile: installed.profile,
    summary: summarize(id, row, profileRows(patch.sequence, id).length > 0),
    config: config.items.length === 0 ? '{}\n' : stringify(config, { lineWidth: 0 }),
  }
}

/**
 * Enable or disable one plugin: flips the loader row gate and, when the plugin
 * has a top-level `enabled` config gate, that gate too.
 */
export async function setPluginEnabled(
  target: PluginSetupTarget & { plugin: string; enabled: boolean },
  options: PluginSetupOptions = {},
): Promise<PluginWriteResult> {
  const installed = await readInstalled(target, options.readDump ?? readEffectiveProfileDump)
  const id = requireInstalled(target.plugin, installed)
  if (!target.enabled && id === 'dsh-enhanced-assistant-policy') {
    fail('refusing to disable assistant-policy: it is the access-control layer other plugins inject; remove the plugin explicitly if that is really intended')
  }
  const effectiveRow = installed.rows.get(id)!
  const effective = rowConfig(effectiveRow)
  if (target.enabled && id === 'dsh-enhanced-lark-channel' && larkPlaceholder(effective)) {
    fail('lark-channel still has placeholder credentials; run dsh-lark-setup for this profile first (it enables the channel after onboarding)')
  }
  const patch = await loadProfilePatch(target.dshHome, installed.profile)
  const changes: PluginChange[] = []
  const verify: PendingEdit[] = []
  const wasLoaded = effectiveRow.get('disabled') !== true
  if (wasLoaded !== target.enabled) {
    profileRow(patch, id, effective).set('disabled', !target.enabled)
    changes.push({ id, key: 'disabled', from: !wasLoaded, to: !target.enabled })
  }
  const gate = effective.get('enabled')
  if (typeof gate === 'boolean' && gate !== target.enabled && !protectedRows.has(id)) {
    if (target.enabled && id === 'dsh-enhanced-assistant-work-items' && effective.get('mode') === 'active'
      && (effective.get('workerAutomationId') === undefined || effective.get('scope') === undefined)) {
      fail('assistant-work-items mode: active needs workerAutomationId and scope; set mode observe first or complete the active config')
    }
    profileRowConfig(patch, id, effective).set('enabled', target.enabled)
    changes.push({ id, key: 'enabled', from: gate, to: target.enabled })
    verify.push({ id, segments: ['enabled'], value: target.enabled })
  }
  return commit(target, installed, patch, changes, [], verify, [{ id, loaded: target.enabled }], options)
}

/** Set one config key (dotted path) after validating it against the effective value type. */
export async function setPluginConfigValue(
  target: PluginSetupTarget & { plugin: string; key: string; value: string; force?: boolean },
  options: PluginSetupOptions = {},
): Promise<PluginWriteResult> {
  const installed = await readInstalled(target, options.readDump ?? readEffectiveProfileDump)
  const id = requireInstalled(target.plugin, installed)
  const segments = splitKey(target.key)
  assertEditable(id, segments)
  const effective = rowConfig(installed.rows.get(id))
  const current = effective.getIn(segments, true)
  const parent = segments.length > 1 ? effective.getIn(segments.slice(0, -1), true) : effective
  if (parent !== undefined && !isMap(parent)) fail(`${segments.slice(0, -1).join('.')} is not a mapping`)
  const value = coerceConfigValue(id, target.key, target.value, current, target.force === true)
  const from = nodeValue(current)
  const patch = await loadProfilePatch(target.dshHome, installed.profile)
  const changes: PluginChange[] = []
  const verify: PendingEdit[] = []
  if (!sameValue(from, value)) {
    profileRowConfig(patch, id, effective).setIn(segments, patch.document.createNode(value))
    changes.push({ id, key: target.key, from, to: value })
    verify.push({ id, segments, value })
  }
  return commit(target, installed, patch, changes, [], verify, [], options)
}

/** Remove one config key from the profile override so the plugin default applies. */
export async function unsetPluginConfigValue(
  target: PluginSetupTarget & { plugin: string; key: string },
  options: PluginSetupOptions = {},
): Promise<PluginWriteResult> {
  const installed = await readInstalled(target, options.readDump ?? readEffectiveProfileDump)
  const id = requireInstalled(target.plugin, installed)
  const segments = splitKey(target.key)
  assertEditable(id, segments)
  const effective = rowConfig(installed.rows.get(id))
  const current = effective.getIn(segments, true)
  const patch = await loadProfilePatch(target.dshHome, installed.profile)
  const changes: PluginChange[] = []
  if (current !== undefined) {
    profileRowConfig(patch, id, effective).deleteIn(segments)
    changes.push({ id, key: target.key, from: nodeValue(current), to: undefined })
  }
  return commit(target, installed, patch, changes, [], [], [], options)
}

export interface PresetItem {
  id: string
  purpose: string
  set: ReadonlyArray<readonly [key: string, value: boolean | string]>
}

/**
 * The `recommended` preset deliberately turns on opt-in features that stay off
 * by default. It edits only plugins that are installed and loaded, never loads
 * a disabled plugin, never touches credentials, Policy, owner routes or sealed
 * plugin state, and leaves the automations scheduler to the RSI/supervised setup.
 */
export const recommendedPluginPreset: readonly PresetItem[] = Object.freeze([
  {
    id: 'dsh-enhanced-assistant-work-items',
    purpose: 'work-item ledger in observe mode plus the deterministic intake ledger (WP20); no admission, worker wake, Delivery or model calls',
    set: [['enabled', true], ['intakeLedger.enabled', true]],
  },
  {
    id: 'dsh-enhanced-assistant-delivery',
    purpose: 'over-cap background notices become a short body plus one text attachment (WP19 stage 2b)',
    set: [['attentionAttachOverCap', true]],
  },
  {
    id: 'dsh-enhanced-assistant-evaluation',
    purpose: 'sync Delivery notification outcome facts into the evaluation ledger (WP22)',
    set: [['notificationOutcomesEnabled', true]],
  },
  {
    id: 'dsh-enhanced-event-triggers',
    purpose: 'run the trigger poller so configured triggers fire without a second switch (allowlists stay empty until configured)',
    set: [['pollerEnabled', true]],
  },
])

export const pluginPresets: ReadonlyMap<string, readonly PresetItem[]> = new Map([['recommended', recommendedPluginPreset]])

/**
 * Apply a named plugin preset (default `recommended`) to one profile in a
 * single verified write. Intended for onboarding flows:
 *
 * ```ts
 * import { applyRecommendedPluginPreset } from '@dsh-enhanced/assistant-policy/plugin-setup'
 * const result = await applyRecommendedPluginPreset({ dshHome, profile: 'web' })
 * ```
 *
 * Idempotent: re-running reports no changes.
 */
export async function applyPluginPreset(
  target: PluginSetupTarget & { preset?: string },
  options: PluginSetupOptions = {},
): Promise<PluginWriteResult> {
  const presetName = target.preset ?? 'recommended'
  const preset = pluginPresets.get(presetName)
  if (preset === undefined) fail(`unknown preset ${JSON.stringify(presetName)}; available: ${[...pluginPresets.keys()].join(', ')}`)
  const installed = await readInstalled(target, options.readDump ?? readEffectiveProfileDump)
  const patch = await loadProfilePatch(target.dshHome, installed.profile)
  const changes: PluginChange[] = []
  const skipped: PluginSkip[] = []
  const verify: PendingEdit[] = []
  for (const item of preset) {
    const row = installed.rows.get(item.id)
    if (row === undefined) { skipped.push({ id: item.id, reason: 'not installed' }); continue }
    if (row.get('disabled') === true) { skipped.push({ id: item.id, reason: 'plugin is disabled in this profile; enable it first' }); continue }
    const effective = rowConfig(row)
    if (item.id === 'dsh-enhanced-assistant-work-items' && effective.get('mode') === 'active' && effective.get('enabled') !== true) {
      skipped.push({ id: item.id, reason: 'mode is active but not enabled; complete the active config deliberately' })
      continue
    }
    for (const [key, value] of item.set) {
      const segments = splitKey(key)
      const parent = segments.length > 1 ? effective.getIn(segments.slice(0, -1), true) : effective
      if (parent !== undefined && !isMap(parent)) { skipped.push({ id: item.id, reason: `${key} parent is not a mapping` }); continue }
      const from = nodeValue(effective.getIn(segments, true))
      if (sameValue(from, value)) continue
      profileRowConfig(patch, item.id, effective).setIn(segments, value)
      changes.push({ id: item.id, key, from, to: value })
      verify.push({ id: item.id, segments, value })
    }
  }
  return commit(target, installed, patch, changes, skipped, verify, [], options)
}

/** Onboarding entry point: apply the `recommended` plugin preset. */
export function applyRecommendedPluginPreset(target: PluginSetupTarget, options: PluginSetupOptions = {}): Promise<PluginWriteResult> {
  return applyPluginPreset({ ...target, preset: 'recommended' }, options)
}
// ---------------------------------------------------------------------------
// CLI

export type PluginSetupCommand = 'list' | 'show' | 'enable' | 'disable' | 'set' | 'unset' | 'preset' | 'guided'

export interface PluginSetupArgs {
  command: PluginSetupCommand
  positionals: string[]
  dshHome: string
  profile?: string
  force: boolean
  dryRun: boolean
  yes: boolean
  json: boolean
  help: boolean
}

const commands = new Set<PluginSetupCommand>(['list', 'show', 'enable', 'disable', 'set', 'unset', 'preset'])
const arity: Record<Exclude<PluginSetupCommand, 'guided'>, readonly [min: number, max: number]> = {
  list: [0, 0], show: [1, 1], enable: [1, 1], disable: [1, 1], set: [2, 3], unset: [2, 2], preset: [0, 1],
}

export function parsePluginSetupArgs(argv: readonly string[]): PluginSetupArgs {
  const result: PluginSetupArgs = {
    command: 'guided',
    positionals: [],
    dshHome: process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
    force: false,
    dryRun: false,
    yes: false,
    json: false,
    help: false,
  }
  let command: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '--help' || token === '-h') result.help = true
    else if (token === '--force') result.force = true
    else if (token === '--dry-run') result.dryRun = true
    else if (token === '--yes' || token === '-y') result.yes = true
    else if (token === '--json') result.json = true
    else if (token === '--dsh-home' || token === '--profile') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${token} requires a value`)
      index += 1
      if (token === '--dsh-home') result.dshHome = value
      else result.profile = value
    } else if (token.startsWith('--')) fail(`unknown option: ${token}`)
    else if (command === undefined) command = token
    else result.positionals.push(token)
  }
  if (!isAbsolute(result.dshHome)) fail('DSH home must be an absolute path')
  if (result.profile !== undefined && !profileNamePattern.test(result.profile)) fail('--profile must be a valid profile name')
  if (command !== undefined) {
    if (!commands.has(command as PluginSetupCommand)) fail(`unknown command: ${command} (see --help)`)
    result.command = command as PluginSetupCommand
    const [min, max] = arity[result.command as Exclude<PluginSetupCommand, 'guided'>]
    if (result.positionals.length > max || result.positionals.length < min) {
      fail(`${command} expects ${min === max ? min : `${min}-${max}`} argument(s); see --help`)
    }
  }
  return result
}

export function pluginSetupUsage(): string {
  return [
    'Usage: dsh-plugin-setup [command] [args] [--profile <name>] [--dsh-home <absolute-path>]',
    '',
    'Commands:',
    '  (none)                         guided menu on a terminal; plain list otherwise',
    '  list                           installed @dsh-enhanced plugins, loader state and feature flags',
    '  show <plugin>                  effective config (secret-like values redacted)',
    '  enable <plugin>                load the plugin and turn on its `enabled` gate if it has one',
    '  disable <plugin>               stop loading the plugin',
    '  set <plugin> <key> [<value>]   set one config key (dotted, e.g. intakeLedger.enabled);',
    '                                 the value is checked against the current type; prompts if omitted',
    '  unset <plugin> <key>           drop one key from the profile override (plugin default applies)',
    '  preset [recommended]           turn on the recommended opt-in features of installed plugins',
    '',
    'Options:',
    '  --profile <name>   target profile (default: $DSH_PROFILE, or the only profile in the home)',
    '  --dry-run          show the change without writing',
    '  --force            allow keys absent from the effective config, or replace a !!js expression',
    '  --yes              apply a preset without the confirmation prompt',
    '  --json             machine-readable output',
    '',
    '<plugin> accepts work-items, assistant-work-items, @dsh-enhanced/assistant-work-items or the row id.',
    'Writes only $DSH_HOME/profiles/<profile>/cordis.patch.yml, verifies with dsh --dump-config and restores',
    'the previous file if verification fails. Restart the profile afterwards (dsh-rsi restart --profile <name>).',
    'Never writes secrets and never edits Policy, owner routes or sealed plugin state.',
  ].join('\n')
}

export interface PluginSetupIo {
  write(text: string): void
  isTTY: boolean
  /** Ask one question; resolves to the trimmed answer. */
  ask?(question: string): Promise<string>
}

function defaultIo(): PluginSetupIo {
  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true
  return {
    write: text => { process.stdout.write(text) },
    isTTY,
    ask: async question => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try { return (await rl.question(question)).trim() } finally { rl.close() }
    },
  }
}

function formatValue(value: unknown): string {
  return value === undefined ? '(unset)' : JSON.stringify(value)
}

function formatList(profile: string, patchPath: string, plugins: readonly ProfilePluginSummary[]): string {
  const lines = [`Profile ${profile} (${patchPath})`]
  if (plugins.length === 0) lines.push('  no @dsh-enhanced plugins installed; add one with dsh plugin --profile <name> add @dsh-enhanced/<plugin>')
  const width = Math.max(10, ...plugins.map(plugin => plugin.slug.length))
  plugins.forEach((plugin, index) => {
    const state = !plugin.loaded ? 'off' : plugin.enabled === false ? 'idle' : 'on'
    const flags = Object.entries(plugin.flags).map(([key, value]) => `${key}=${value}`)
    if (plugin.enabled !== undefined) flags.unshift(`enabled=${plugin.enabled}`)
    lines.push(`  ${String(index + 1).padStart(2)}. ${plugin.slug.padEnd(width)}  ${state.padEnd(4)}  ${flags.join(' ')}${plugin.overridden ? '  [profile override]' : ''}`)
  })
  lines.push('', 'on = loaded; idle = loaded with config enabled=false; off = disabled loader row')
  return `${lines.join('\n')}\n`
}

function formatWrite(result: PluginWriteResult): string {
  const lines: string[] = []
  for (const change of result.changes) lines.push(`  ${change.id}.${change.key}: ${formatValue(change.from)} -> ${formatValue(change.to)}`)
  for (const skip of result.skipped) lines.push(`  skipped ${skip.id}: ${skip.reason}`)
  if (result.changes.length === 0) lines.unshift(`No change for profile ${result.profile}.`)
  else if (result.dryRun) lines.unshift(`Dry run, would update ${result.patchPath}:`)
  else lines.unshift(`Updated ${result.patchPath}:`)
  if (result.changed && !result.dryRun) lines.push(`Restart the profile to apply: dsh-rsi restart --profile ${result.profile}`)
  return `${lines.join('\n')}\n`
}

async function guided(args: PluginSetupArgs, io: PluginSetupIo, options: PluginSetupOptions): Promise<void> {
  const ask = io.ask!
  const target = { dshHome: args.dshHome, ...(args.profile !== undefined ? { profile: args.profile } : {}) }
  for (;;) {
    const listed = await listProfilePlugins(target, options)
    io.write(formatList(listed.profile, listed.patchPath, listed.plugins))
    const choice = await ask('Plugin number or name (p = recommended preset, q = quit): ')
    if (choice === '' || choice === 'q') return
    if (choice === 'p') {
      const plan = await applyPluginPreset({ ...target, profile: listed.profile }, { ...options, dryRun: true })
      io.write(formatWrite(plan))
      if (plan.changes.length > 0 && /^y(es)?$/iu.test(await ask('Apply? [y/N] '))) {
        io.write(formatWrite(await applyPluginPreset({ ...target, profile: listed.profile }, options)))
      }
      continue
    }
    const numeric = Number(choice)
    const plugin = Number.isInteger(numeric) && numeric >= 1 && numeric <= listed.plugins.length
      ? listed.plugins[numeric - 1]!.id
      : choice
    try {
      const shown = await showProfilePlugin({ ...target, profile: listed.profile, plugin }, options)
      io.write(`\n${shown.summary.id}:\n${shown.config.replace(/^/gmu, '  ')}\n`)
      const action = (await ask('[e]nable, [d]isable, [s]et key, [u]nset key, [b]ack: ')).toLowerCase()
      let result: PluginWriteResult | undefined
      if (action === 'e' || action === 'd') {
        result = await setPluginEnabled({ ...target, profile: listed.profile, plugin, enabled: action === 'e' }, options)
      } else if (action === 's') {
        const key = await ask('Key (dotted): ')
        const value = await ask(`Value for ${key}: `)
        result = await setPluginConfigValue({ ...target, profile: listed.profile, plugin, key, value, force: args.force }, options)
      } else if (action === 'u') {
        result = await unsetPluginConfigValue({ ...target, profile: listed.profile, plugin, key: await ask('Key (dotted): ') }, options)
      }
      if (result !== undefined) io.write(formatWrite(result))
    } catch (error: unknown) {
      if (!(error instanceof PluginSetupError)) throw error
      io.write(`${error.message}\n`)
    }
  }
}

export async function runPluginSetup(argv = process.argv.slice(2), io: PluginSetupIo = defaultIo(), options: Omit<PluginSetupOptions, 'dryRun'> = {}): Promise<void> {
  const args = parsePluginSetupArgs(argv)
  if (args.help) { io.write(`${pluginSetupUsage()}\n`); return }
  const shared: PluginSetupOptions = { ...options, dryRun: args.dryRun }
  const target = { dshHome: args.dshHome, ...(args.profile !== undefined ? { profile: args.profile } : {}) }
  const emit = (value: unknown, text: string) => io.write(args.json ? `${JSON.stringify(value, null, 2)}\n` : text)
  const [first, second, third] = args.positionals
  switch (args.command) {
    case 'guided':
    case 'list': {
      if (args.command === 'guided' && io.isTTY && io.ask !== undefined && !args.json) return guided(args, io, shared)
      const listed = await listProfilePlugins(target, shared)
      return emit(listed, formatList(listed.profile, listed.patchPath, listed.plugins))
    }
    case 'show': {
      const shown = await showProfilePlugin({ ...target, plugin: first! }, shared)
      return emit(shown, `${shown.summary.id} (profile ${shown.profile}, ${shown.summary.loaded ? 'loaded' : 'disabled'}):\n${shown.config}`)
    }
    case 'enable':
    case 'disable': {
      const result = await setPluginEnabled({ ...target, plugin: first!, enabled: args.command === 'enable' }, shared)
      return emit(result, formatWrite(result))
    }
    case 'set': {
      let value = third
      if (value === undefined) {
        if (!io.isTTY || io.ask === undefined) fail('set needs a value when not running on a terminal')
        value = await io.ask(`Value for ${second}: `)
      }
      const result = await setPluginConfigValue({ ...target, plugin: first!, key: second!, value, force: args.force }, shared)
      return emit(result, formatWrite(result))
    }
    case 'unset': {
      const result = await unsetPluginConfigValue({ ...target, plugin: first!, key: second! }, shared)
      return emit(result, formatWrite(result))
    }
    case 'preset': {
      const preset = first ?? 'recommended'
      if (!args.dryRun && !args.yes && io.isTTY && io.ask !== undefined && !args.json) {
        const plan = await applyPluginPreset({ ...target, preset }, { ...shared, dryRun: true })
        io.write(formatWrite(plan))
        if (plan.changes.length === 0) return
        if (!/^y(es)?$/iu.test(await io.ask('Apply? [y/N] '))) { io.write('Not applied.\n'); return }
      }
      const result = await applyPluginPreset({ ...target, preset }, shared)
      return emit(result, formatWrite(result))
    }
  }
}
